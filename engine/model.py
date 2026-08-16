"""Transparent expected-points (EV) model.

Design goal (see plan): unlike FFH's black-box AI, every number produced here
is a simple, documented function of public FPL data, and every player carries
an uncertainty band plus a plain-English breakdown of what drove the score.
This is deliberately a heuristic v1, not a trained ML model — accuracy.py
will track its real-world error each gameweek so it can be tuned over the
season instead of trusted blindly.

Scoring constants are read from bootstrap `game_config.scoring` rather than
hardcoded, so a mid-season FPL rule tweak doesn't silently break the model.
"""
from __future__ import annotations

from dataclasses import dataclass, field

POSITION_NAMES = {1: "GKP", 2: "DEF", 3: "MID", 4: "FWD"}

# Fixture Difficulty Rating (1=easiest, 5=hardest) -> heuristic multipliers.
# These are deliberately simple, named lookup tables (not fitted coefficients)
# so the model stays auditable. Tuning them using accuracy.py's logged error
# is expected to happen as the season progresses.
FDR_ATTACK_MULT = {1: 1.25, 2: 1.10, 3: 1.00, 4: 0.85, 5: 0.70}
FDR_CLEAN_SHEET_PROB = {1: 0.45, 2: 0.38, 3: 0.30, 4: 0.22, 5: 0.15}
FDR_EXPECTED_CONCEDED = {1: 0.85, 2: 1.05, 3: 1.30, 4: 1.65, 5: 2.10}
HOME_CS_BONUS = 0.03

# A full historical season is 38 games; used to turn last-season total minutes
# into a "how nailed-on were they" share ahead of GW1, before any per-gameweek
# data exists for the new season.
FULL_SEASON_MINUTES = 38 * 90

FORECAST_GAMEWEEKS = 6


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


def _expected_minutes_ratio(element: dict) -> tuple[float, str]:
    """Probability-weighted fraction of a full match a player is expected to
    play, plus the human-readable reason. Blends the season-long minutes
    share (nailed-on-ness prior) with any explicit availability signal FPL
    itself publishes (status flag / chance_of_playing_next_round).
    """
    minutes_share = min(element["minutes"] / FULL_SEASON_MINUTES, 1.0)
    if minutes_share >= 0.70:
        prior, prior_label = 0.92, "a regular starter last season"
    elif minutes_share >= 0.40:
        prior, prior_label = 0.65, "a rotation risk based on last season's minutes"
    elif minutes_share >= 0.10:
        prior, prior_label = 0.30, "a fringe player based on last season's minutes"
    else:
        prior, prior_label = 0.15, "unproven / very little senior game time"

    status = element["status"]
    cop = element["chance_of_playing_next_round"]
    if status == "a" and cop is None:
        return prior, f"Expected to start ({prior_label})"
    if cop is not None:
        availability = cop / 100.0
        ratio = min(prior, availability) if availability < 1.0 else prior
        reason = element["news"] or f"{int(availability * 100)}% chance of playing"
        return ratio, f"Availability flagged: {reason}"
    if status in ("i", "s", "u"):
        return 0.02, element["news"] or "Currently unavailable"
    return prior, f"Expected to start ({prior_label})"


def _dc_probability(element: dict, position_id: int) -> float:
    """Rough probability of hitting the defensive-contribution points
    threshold in a given match, from the player's per-90 CBIT/CBIRT rate.
    """
    threshold = 10.0 if position_id == 2 else 12.0
    rate = element.get("defensive_contribution_per_90") or 0.0
    return max(0.0, min(rate / threshold, 1.0)) * 0.85  # damp overconfidence


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


def build_player_ev(
    bootstrap: dict,
    fixtures: list[dict],
    forecast_gws: int = FORECAST_GAMEWEEKS,
) -> list[PlayerEV]:
    teams_by_id = {t["id"]: t for t in bootstrap["teams"]}
    scoring = bootstrap["game_config"]["scoring"]
    events = bootstrap["events"]
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

        xmins_ratio, minutes_reason = _expected_minutes_ratio(e)
        xg90 = e.get("expected_goals_per_90") or 0.0
        xa90 = e.get("expected_assists_per_90") or 0.0
        xgi90 = e.get("expected_goal_involvements_per_90") or (xg90 + xa90)
        saves90 = e.get("saves_per_90") or 0.0
        dc_prob = _dc_probability(e, position_id)
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

            attack_mult = FDR_ATTACK_MULT[fdr]
            cs_prob = FDR_CLEAN_SHEET_PROB[fdr] + (HOME_CS_BONUS if is_home else 0.0)
            expected_conceded = FDR_EXPECTED_CONCEDED[fdr]

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
