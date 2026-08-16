"""Transparent expected-points (EV) model.

Design goal (see plan): unlike FFH's black-box AI, every number produced here
is a simple, documented function of public FPL data, and every player carries
an uncertainty band plus a plain-English breakdown of what drove the score.
This is deliberately a heuristic v1, not a trained ML model — accuracy.py
will track its real-world error each gameweek so it can be tuned over the
season instead of trusted blindly.

Scoring constants are read from bootstrap `game_config.scoring` rather than
hardcoded, so a mid-season FPL rule tweak doesn't silently break the model.

Two optional inputs make the model adaptive rather than static:
- `priors` (engine.priors.PlayerPrior, from data/player_priors.json): each
  player's own recency-weighted multi-season baseline, used pre-season and
  blended with in-season data once real gameweeks start.
- `coefficients` (engine/calibration/coefficients.json): the FDR_* tables and
  DC damping factor below are the *fallback* defaults; when a calibration fit
  exists it's used instead, unless a position's fit had too little real
  signal to trust (see engine/calibration/fit_coefficients.py's R2-based
  shrinkage back toward these same defaults).

Known limitation: the current-season rate blended in via `engine.stabilize`
is NOT adjusted for the difficulty of opponents already faced this season
(only the calibrated FDR tables applied to *upcoming* fixtures are) - doing
so properly needs per-gameweek fixture history per player, which would add
587 more calls to what's otherwise a deliberately cheap, 2-call hot loop.
Flagged as a fast-follow, not silently ignored.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from engine import stabilize
from engine.priors import PlayerPrior

POSITION_NAMES = {1: "GKP", 2: "DEF", 3: "MID", 4: "FWD"}

# Fixture Difficulty Rating (1=easiest, 5=hardest) -> heuristic multipliers.
# These are the fallback defaults, used when engine/calibration/coefficients.json
# is absent or a position's fit wasn't trusted (see module docstring). Tuning
# them using accuracy.py's logged error is expected to happen as the season
# progresses even without a full calibration refit.
FDR_ATTACK_MULT = {1: 1.25, 2: 1.10, 3: 1.00, 4: 0.85, 5: 0.70}
FDR_CLEAN_SHEET_PROB = {1: 0.45, 2: 0.38, 3: 0.30, 4: 0.22, 5: 0.15}
FDR_EXPECTED_CONCEDED = {1: 0.85, 2: 1.05, 3: 1.30, 4: 1.65, 5: 2.10}
DC_DAMPING_DEFAULT = 0.85
HOME_CS_BONUS = 0.03

# A full historical season is 38 games; used to turn total minutes into a
# "how nailed-on were they" share, whether that's this-season-so-far minutes
# once real gameweeks exist, or the multi-season prior's blended share before
# they do.
FULL_SEASON_MINUTES = 38 * 90

FORECAST_GAMEWEEKS = 6

# stabilize.py stat name -> (bootstrap current-season per-90 field, priors.py per90 key)
RATE_FIELD_MAP = {
    "expected_goals": ("expected_goals_per_90", "expected_goals"),
    "expected_assists": ("expected_assists_per_90", "expected_assists"),
    "defensive_contribution": ("defensive_contribution_per_90", "defensive_contribution"),
    "saves": ("saves_per_90", "saves"),
}


@dataclass
class FixtureEV:
    event: int
    opponent_short: str
    is_home: bool
    fdr: int
    points: float


@dataclass
class PlayerEV:
    id: int
    web_name: str
    team_short: str
    position: str
    now_cost: int
    selected_by_percent: float
    status: str
    news: str
    expected_minutes_ratio: float
    total_ev: float
    uncertainty: float
    why: list[str] = field(default_factory=list)
    fixtures: list[FixtureEV] = field(default_factory=list)


def season_started(bootstrap: dict) -> bool:
    """True once real 2026/27 fixtures have been played."""
    return any(t["played"] > 0 for t in bootstrap["teams"])


def _blended_rate(stat: str, element: dict, prior: PlayerPrior | None, season_started: bool) -> float:
    """Adaptive blend of this-season-so-far and multi-season-prior per-90
    rates for one stat (see engine.stabilize). Pre-season, current_minutes
    is forced to 0 - bootstrap's per-90 fields are last season's completed
    totals until GW1 actually happens, not "this season" data - so the blend
    correctly returns exactly the multi-season prior. Once real gameweeks
    exist, bootstrap's fields *are* this season's rolling totals, so no extra
    API calls are needed to feed the "current" side of the blend.
    """
    bootstrap_key, prior_key = RATE_FIELD_MAP[stat]
    current_rate = element.get(bootstrap_key) or 0.0
    current_minutes = (element.get("minutes") or 0) if season_started else 0
    prior_rate = prior.per90.get(prior_key, 0.0) if prior else current_rate
    return stabilize.blend_rate(stat, current_rate, current_minutes, prior_rate)


def _expected_minutes_ratio(
    element: dict, prior: PlayerPrior | None, season_started: bool
) -> tuple[float, str]:
    """Probability-weighted fraction of a full match a player is expected to
    play, plus the human-readable reason. The tier thresholds/probabilities
    below are unchanged from v1; what's new is that they're now applied to
    an adaptively blended minutes share (this-season-so-far vs. multi-season
    prior, see `_blended_rate`) instead of a single prior season, and any
    explicit availability signal FPL itself publishes (status flag /
    chance_of_playing_next_round) is still applied on top as before.
    """
    current_minutes = (element.get("minutes") or 0) if season_started else 0
    current_share = min(current_minutes / FULL_SEASON_MINUTES, 1.0)
    prior_share = prior.weighted_minutes_share if prior else current_share
    minutes_share = stabilize.blend_rate("start_rate", current_share, current_minutes, prior_share)

    using_prior = prior is not None and (not season_started or current_minutes == 0)
    basis = "recent form" if season_started and current_minutes > 0 else (
        "multi-season history" if using_prior else "last season"
    )

    if minutes_share >= 0.70:
        prob, label = 0.92, f"a regular starter based on {basis}"
    elif minutes_share >= 0.40:
        prob, label = 0.65, f"a rotation risk based on {basis}"
    elif minutes_share >= 0.10:
        prob, label = 0.30, f"a fringe player based on {basis}"
    else:
        prob, label = 0.15, "unproven / very little senior game time"

    status = element["status"]
    cop = element["chance_of_playing_next_round"]
    if status == "a" and cop is None:
        return prob, f"Expected to start ({label})"
    if cop is not None:
        availability = cop / 100.0
        ratio = min(prob, availability) if availability < 1.0 else prob
        reason = element["news"] or f"{int(availability * 100)}% chance of playing"
        return ratio, f"Availability flagged: {reason}"
    if status in ("i", "s", "u"):
        return 0.02, element["news"] or "Currently unavailable"
    return prob, f"Expected to start ({label})"


def _dc_probability(rate: float, position_id: int, damping: float) -> float:
    """Rough probability of hitting the defensive-contribution points
    threshold in a given match, from the player's (already blended) per-90
    CBIT/CBIRT rate. `damping` defaults to a hand-picked 0.85 but is replaced
    by a per-position, empirically fitted value when a calibration exists
    (see engine/calibration/fit_coefficients.py's fit_dc_damping) - the first
    fit found the naive rate/threshold estimate overstates the real per-match
    hit rate considerably (fitted damping ~0.3-0.4, not 0.85).
    """
    threshold = 10.0 if position_id == 2 else 12.0
    return max(0.0, min(rate / threshold, 1.0)) * damping


def _bonus_estimate(element: dict, position_counts: dict[int, int]) -> float:
    """Small heuristic addition for likely bonus points, from a player's rank
    within their position by ICT index (a proxy FPL itself uses for bonus).
    """
    rank = element.get("ict_index_rank_type")
    count = position_counts.get(element["element_type"], 1)
    if not rank or not count:
        return 0.1
    percentile = rank / count
    if percentile <= 0.05:
        return 0.5
    if percentile <= 0.15:
        return 0.25
    return 0.08


def build_fixture_ticker(
    bootstrap: dict,
    fixtures: list[dict],
    forecast_gws: int = FORECAST_GAMEWEEKS,
) -> list[dict]:
    """Per-team FDR ticker for the Planner tab: one row per club with its next
    `forecast_gws` fixtures, independent of any individual player.
    """
    teams_by_id = {t["id"]: t for t in bootstrap["teams"]}
    events = bootstrap["events"]
    upcoming_set = set(sorted(e["id"] for e in events if not e["finished"])[:forecast_gws])

    fixtures_by_team: dict[int, list[dict]] = {}
    for fx in fixtures:
        if fx["event"] not in upcoming_set:
            continue
        fixtures_by_team.setdefault(fx["team_h"], []).append(fx)
        fixtures_by_team.setdefault(fx["team_a"], []).append(fx)

    ticker = []
    for team_id, team in teams_by_id.items():
        team_fixtures = sorted(fixtures_by_team.get(team_id, []), key=lambda f: f["event"])
        rows = []
        for fx in team_fixtures:
            is_home = fx["team_h"] == team_id
            fdr = fx["team_h_difficulty"] if is_home else fx["team_a_difficulty"]
            opp_id = fx["team_a"] if is_home else fx["team_h"]
            rows.append(
                {
                    "event": fx["event"],
                    "opponent_short": teams_by_id[opp_id]["short_name"],
                    "is_home": is_home,
                    "fdr": fdr,
                }
            )
        avg_fdr = sum(r["fdr"] for r in rows) / len(rows) if rows else None
        ticker.append(
            {
                "team_short": team["short_name"],
                "team_name": team["name"],
                "fixtures": rows,
                "avg_fdr": round(avg_fdr, 2) if avg_fdr is not None else None,
            }
        )
    ticker.sort(key=lambda t: (t["avg_fdr"] is None, t["avg_fdr"] if t["avg_fdr"] is not None else 0))
    return ticker


def _fdr_tables_for(position: str, coefficients: dict | None) -> tuple[dict, dict, dict, float]:
    """Returns (fdr_attack_mult, fdr_clean_sheet_prob, fdr_expected_conceded,
    dc_damping) for a position - calibrated values when available and
    trusted, falling back to the hand-picked module defaults otherwise.
    """
    if not coefficients:
        return FDR_ATTACK_MULT, FDR_CLEAN_SHEET_PROB, FDR_EXPECTED_CONCEDED, DC_DAMPING_DEFAULT

    pos_fit = coefficients.get("positions", {}).get(position, {})
    attack_mult = {int(k): v for k, v in pos_fit["fdr_attack_mult"].items()} if pos_fit.get("fdr_attack_mult") else FDR_ATTACK_MULT
    cs_prob = {int(k): v for k, v in pos_fit["fdr_clean_sheet_prob"].items()} if pos_fit.get("fdr_clean_sheet_prob") else FDR_CLEAN_SHEET_PROB
    expected_conceded = {int(k): v for k, v in pos_fit["fdr_expected_conceded"].items()} if pos_fit.get("fdr_expected_conceded") else FDR_EXPECTED_CONCEDED
    damping = coefficients.get("dc_damping_by_position", {}).get(position, DC_DAMPING_DEFAULT)
    return attack_mult, cs_prob, expected_conceded, damping


def build_player_ev(
    bootstrap: dict,
    fixtures: list[dict],
    forecast_gws: int = FORECAST_GAMEWEEKS,
    priors: dict[int, PlayerPrior] | None = None,
    coefficients: dict | None = None,
) -> list[PlayerEV]:
    teams_by_id = {t["id"]: t for t in bootstrap["teams"]}
    scoring = bootstrap["game_config"]["scoring"]
    events = bootstrap["events"]
    season_started_flag = season_started(bootstrap)
    upcoming_events = sorted(
        e["id"] for e in events if not e["finished"]
    )[:forecast_gws]
    upcoming_set = set(upcoming_events)

    fixtures_by_team: dict[int, list[dict]] = {}
    for fx in fixtures:
        if fx["event"] not in upcoming_set:
            continue
        fixtures_by_team.setdefault(fx["team_h"], []).append(fx)
        fixtures_by_team.setdefault(fx["team_a"], []).append(fx)

    position_counts: dict[int, int] = {}
    for e in bootstrap["elements"]:
        position_counts[e["element_type"]] = position_counts.get(e["element_type"], 0) + 1

    results: list[PlayerEV] = []
    for e in bootstrap["elements"]:
        if e.get("removed"):
            continue
        position_id = e["element_type"]
        position = POSITION_NAMES[position_id]
        team = teams_by_id[e["team"]]

        prior = priors.get(e["id"]) if priors else None
        attack_mult_table, cs_prob_table, expected_conceded_table, dc_damping = _fdr_tables_for(
            position, coefficients
        )

        xmins_ratio, minutes_reason = _expected_minutes_ratio(e, prior, season_started_flag)
        xg90 = _blended_rate("expected_goals", e, prior, season_started_flag)
        xa90 = _blended_rate("expected_assists", e, prior, season_started_flag)
        xgi90 = xg90 + xa90
        dc90 = _blended_rate("defensive_contribution", e, prior, season_started_flag)
        saves90 = _blended_rate("saves", e, prior, season_started_flag)
        dc_prob = _dc_probability(dc90, position_id, dc_damping)
        bonus_est = _bonus_estimate(e, position_counts)

        goal_pts = scoring["goals_scored"][position]
        assist_pts = scoring["assists"]
        cs_pts = scoring["clean_sheets"][position]
        conceded_pts_per_goal = scoring["goals_conceded"][position] / 2.0
        save_pts_per_save = scoring["saves"] / 3.0
        dc_pts = scoring["defensive_contribution"][position]
        long_play, short_play = scoring["long_play"], scoring["short_play"]

        team_fixtures = fixtures_by_team.get(team["id"], [])
        fixture_evs: list[FixtureEV] = []
        for fx in sorted(team_fixtures, key=lambda f: f["event"]):
            is_home = fx["team_h"] == team["id"]
            fdr = fx["team_h_difficulty"] if is_home else fx["team_a_difficulty"]
            opp_id = fx["team_a"] if is_home else fx["team_h"]
            opponent = teams_by_id[opp_id]

            attack_mult = attack_mult_table[fdr]
            cs_prob = cs_prob_table[fdr] + (HOME_CS_BONUS if is_home else 0.0)
            expected_conceded = expected_conceded_table[fdr]

            appearance_pts = xmins_ratio * long_play + (1 - xmins_ratio) * 0.3 * short_play
            attacking_pts = (goal_pts * xg90 + assist_pts * xa90) * attack_mult * xmins_ratio
            defensive_pts = dc_prob * dc_pts * xmins_ratio
            clean_sheet_pts = cs_prob * cs_pts * xmins_ratio
            conceded_penalty = expected_conceded * conceded_pts_per_goal * xmins_ratio
            save_pts = saves90 * save_pts_per_save * xmins_ratio
            bonus_pts = bonus_est * xmins_ratio

            fixture_total = (
                appearance_pts
                + attacking_pts
                + defensive_pts
                + clean_sheet_pts
                + conceded_penalty
                + save_pts
                + bonus_pts
            )
            fixture_evs.append(
                FixtureEV(
                    event=fx["event"],
                    opponent_short=opponent["short_name"],
                    is_home=is_home,
                    fdr=fdr,
                    points=round(fixture_total, 2),
                )
            )

        total_ev = sum(f.points for f in fixture_evs)
        avg_fdr = (
            sum(f.fdr for f in fixture_evs) / len(fixture_evs) if fixture_evs else 3.0
        )

        # Uncertainty widens for low-minutes-confidence and blank-fixture players.
        confidence_gap = 1 - xmins_ratio
        uncertainty = round(total_ev * (0.15 + 0.35 * confidence_gap) + 0.3, 2)

        why: list[str] = [minutes_reason]
        if xgi90 > 0:
            why.append(f"Underlying output: {xgi90:.2f} combined xG+xA per 90 minutes")
        if fixture_evs:
            fixture_desc = "favourable" if avg_fdr <= 2.4 else "tough" if avg_fdr >= 3.6 else "average"
            why.append(
                f"{fixture_desc.capitalize()} run of fixtures "
                f"(avg FDR {avg_fdr:.1f} over next {len(fixture_evs)} GWs)"
            )
        else:
            why.append("No fixtures in the forecast window (blank gameweeks)")
        if position_id in (2, 3, 4) and dc_prob > 0.3:
            why.append("Good chance of a defensive-contribution bonus (2pts)")

        results.append(
            PlayerEV(
                id=e["id"],
                web_name=e["web_name"],
                team_short=team["short_name"],
                position=position,
                now_cost=e["now_cost"],
                selected_by_percent=float(e["selected_by_percent"]),
                status=e["status"],
                news=e["news"],
                expected_minutes_ratio=round(xmins_ratio, 2),
                total_ev=round(total_ev, 2),
                uncertainty=uncertainty,
                why=why[:3],
                fixtures=fixture_evs,
            )
        )

    return results
