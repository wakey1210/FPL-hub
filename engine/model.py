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

# "Form is temporary, class is permanent": a hand-picked neutral pivot for
# prior.consistency (coefficient of variation of season-level xGI/90 across
# up to 3 seasons - see engine/priors.py) - below it, output has been stable
# across seasons and uncertainty tightens; above it, output was driven by
# one standout season/hot streak and uncertainty widens. The +-0.15 clamp
# keeps this smaller in magnitude than the promoted-opponent bump below,
# since consistency is corroborating evidence, not a hard fixture fact.
CONSISTENCY_NEUTRAL_CV = 0.35
CONSISTENCY_ADJ_SCALE = 0.5
CONSISTENCY_ADJ_CLAMP = 0.15

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
    expected_minutes_ratio: float  # == p_appearance; kept for compatibility with existing consumers
    p_appearance: float
    p_60_plus: float
    expected_minutes_if_appears: float
    total_ev: float
    uncertainty: float
    why: list[str] = field(default_factory=list)
    fixtures: list[FixtureEV] = field(default_factory=list)


def season_started(bootstrap: dict) -> bool:
    """True once real 2026/27 fixtures have been played."""
    return any(t["played"] > 0 for t in bootstrap["teams"])


UNDERSTAT_PENS_SHARE_THRESHOLD = 0.15  # below this, not worth correcting for


def _blended_rate(
    stat: str,
    element: dict,
    prior: PlayerPrior | None,
    season_started: bool,
    attack_mult_table: dict[int, float] | None = None,
    understat_split: dict | None = None,
) -> float:
    """Adaptive blend of this-season-so-far and multi-season-prior per-90
    rates for one stat (see engine.stabilize). Pre-season, current_minutes
    is forced to 0 - bootstrap's per-90 fields are last season's completed
    totals until GW1 actually happens, not "this season" data - so the blend
    correctly returns exactly the multi-season prior. Once real gameweeks
    exist, bootstrap's fields *are* this season's rolling totals, so no extra
    API calls are needed to feed the "current" side of the blend.

    When `attack_mult_table` is given (only for the attacking stats -
    expected_goals/expected_assists), the current-season rate is first
    rebased to an FDR-3-equivalent using `prior.current_season_avg_fdr` (the
    average difficulty already faced this season, computed weekly in
    engine/priors.py from element-summary's per-gameweek `history`) - this is
    what stops a hot streak against soft fixtures from being over-trusted.
    The calibrated FDR multipliers are applied a second time, separately, to
    the *upcoming* fixtures being forecast (see the fixture loop below) - so
    opponent strength is accounted for once on the way in, once on the way
    out, never both for the same fixture.

    When `understat_split` is given (only for "expected_goals", and only
    when the player currently has no penalty/backup-penalty order - i.e. they
    don't hold the role right now), it strips out the share of *last
    season's* xG (engine.understat's `pens_share_of_xg`, from Understat's own
    xG/npxG season aggregates) that came from penalties before it enters the
    prior side of the blend - `prior.per90` is a multi-season baseline
    weighted mostly toward last season, so it can otherwise still carry
    penalty output the player has no current claim to reproduce. Never
    applied to `current_rate`: FPL's own current-season xG already reflects
    the player's actual current role directly once real gameweeks
    accumulate, so this only ever corrects the *prior* component.
    """
    bootstrap_key, prior_key = RATE_FIELD_MAP[stat]
    current_rate = element.get(bootstrap_key) or 0.0
    current_minutes = (element.get("minutes") or 0) if season_started else 0

    if attack_mult_table and prior and prior.current_season_avg_fdr and current_minutes > 0:
        nearest_fdr = min(5, max(1, round(prior.current_season_avg_fdr)))
        current_rate = current_rate / attack_mult_table[nearest_fdr]

    prior_rate = prior.per90.get(prior_key, 0.0) if prior else current_rate

    if (
        stat == "expected_goals"
        and understat_split
        and element.get("penalties_order") not in (1, 2)
        and understat_split.get("pens_share_of_xg", 0.0) >= UNDERSTAT_PENS_SHARE_THRESHOLD
    ):
        prior_rate *= 1 - understat_split["pens_share_of_xg"]

    return stabilize.blend_rate(stat, current_rate, current_minutes, prior_rate)


# P(still on the pitch at 60') given they started - covers early substitution,
# injury, and red-card risk. Not position/player-specific in v1; a fast-follow
# could fit this from real data the way engine/calibration does for other constants.
FINISH_RATE = 0.85
DEFAULT_MINUTES_IF_APPEARS = 75.0  # used only when no prior/current data exists at all


@dataclass
class MinutesProfile:
    p_appearance: float  # chance of any minutes this match
    p_60_plus: float  # chance of reaching the long-play/clean-sheet/DC threshold
    expected_minutes_if_appears: float  # ~90 for a nailed starter, ~15-25 for an impact sub
    label: str
    reason: str


def _expected_minutes_profile(
    element: dict, prior: PlayerPrior | None, team_played: int, season_started: bool
) -> MinutesProfile:
    """Splits "expected minutes" into two separate probabilities instead of
    one flat ratio, because total minutes played is not the same signal as
    "genuinely first-choice": a player who starts 5 of 7 matches and plays to
    ~75 minutes each time has a completely different point ceiling from one
    who racks up similar total minutes via repeated 15-20 minute sub cameos,
    even if their per-90 attacking rate looks identical. `p_appearance` feeds
    anything available to a substitute (attacking returns, saves, bonus);
    `p_60_plus` gates anything that needs a genuine long appearance (defensive
    contribution, clean sheets, the long-play portion of appearance points) -
    see `build_player_ev` for exactly how these are applied.
    """
    current_minutes = (element.get("minutes") or 0) if season_started else 0
    current_starts = (element.get("starts") or 0) if season_started else 0

    current_minutes_share = min(current_minutes / FULL_SEASON_MINUTES, 1.0)
    prior_minutes_share = prior.weighted_minutes_share if prior else current_minutes_share
    minutes_share = stabilize.blend_rate(
        "minutes_share", current_minutes_share, current_minutes, prior_minutes_share
    )

    current_starts_share = min(current_starts / team_played, 1.0) if team_played else 0.0
    prior_starts_share = prior.weighted_starts_share if prior else current_starts_share
    starts_share = stabilize.blend_rate("starts", current_starts_share, current_minutes, prior_starts_share)

    if prior and prior.avg_minutes_per_start:
        # Capped at 95: extra-time cup/playoff matches in a small starts sample
        # (e.g. 5 starts including one 120-minute replay) can otherwise skew
        # this well above what's realistic for a normal league match.
        expected_minutes_if_appears = min(prior.avg_minutes_per_start, 95.0)
    else:
        expected_minutes_if_appears = DEFAULT_MINUTES_IF_APPEARS

    using_prior = prior is not None and (not season_started or current_minutes == 0)
    basis = "recent form" if season_started and current_minutes > 0 else (
        "multi-season history" if using_prior else "last season"
    )

    if minutes_share >= 0.70:
        p_appearance_base, label = 0.92, f"a regular starter based on {basis}"
    elif minutes_share >= 0.40:
        p_appearance_base, label = 0.65, f"a rotation risk based on {basis}"
    elif minutes_share >= 0.10:
        p_appearance_base, label = 0.30, f"a fringe player based on {basis}"
    else:
        p_appearance_base, label = 0.15, "unproven / very little senior game time"

    p_60_plus_base = min(starts_share * FINISH_RATE, p_appearance_base)

    status = element["status"]
    cop = element["chance_of_playing_next_round"]
    if cop is not None:
        availability = cop / 100.0
        scale = min(1.0, availability / p_appearance_base) if p_appearance_base > 0 else 0.0
        p_appearance = min(p_appearance_base, availability)
        p_60_plus = p_60_plus_base * scale
        reason = element["news"] or f"{int(availability * 100)}% chance of playing"
        return MinutesProfile(
            p_appearance, p_60_plus, expected_minutes_if_appears, label, f"Availability flagged: {reason}"
        )
    if status in ("i", "s", "u"):
        return MinutesProfile(
            0.02, 0.01, expected_minutes_if_appears, "unavailable", element["news"] or "Currently unavailable"
        )
    return MinutesProfile(
        p_appearance_base, p_60_plus_base, expected_minutes_if_appears, label, f"Expected to start ({label})"
    )


SET_PIECE_PENALTY_XG_BOOST = 0.08  # hand-picked: ~0.76 conversion x ~0.1 penalties/game
SET_PIECE_BACKUP_PENALTY_XG_BOOST = 0.02
SET_PIECE_FREEKICK_XG_BOOST = 0.02
SET_PIECE_CORNER_XA_BOOST = 0.02


def _set_piece_boost(element: dict) -> tuple[float, float]:
    """Small additive (not multiplicative) xG90/xA90 corrections for
    designated set-piece duty (`penalties_order`/`direct_freekicks_order`/
    `corners_and_indirect_freekicks_order` - 1=primary taker, 2=backup, None=
    not on the list). Additive, not a multiplier, because these correct for a
    role the volume-weighted blended rate may not yet fully reflect (a new
    signing or a teammate's injury/transfer handing over set-piece duty mid-
    season) rather than re-scaling an already-correct rate. Hand-picked
    defaults, same status as FINISH_RATE/HOME_CS_BONUS above - a candidate for
    later tuning against engine/accuracy.py's logged error, not a calibrated
    fit (there's no historical "recently inherited duty" label to fit against).
    """
    xg_boost = xa_boost = 0.0
    pens = element.get("penalties_order")
    fks = element.get("direct_freekicks_order")
    corners = element.get("corners_and_indirect_freekicks_order")
    if pens == 1:
        xg_boost += SET_PIECE_PENALTY_XG_BOOST
    elif pens == 2:
        xg_boost += SET_PIECE_BACKUP_PENALTY_XG_BOOST
    if fks == 1:
        xg_boost += SET_PIECE_FREEKICK_XG_BOOST
    if corners == 1:
        xa_boost += SET_PIECE_CORNER_XA_BOOST
    return xg_boost, xa_boost


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
    team_strength: dict | None = None,
    odds: dict | None = None,
    understat: dict | None = None,
) -> list[PlayerEV]:
    teams_by_id = {t["id"]: t for t in bootstrap["teams"]}
    # Only used to override FPL's own FDR for newly-promoted opponents (see
    # the fixture loop below) - established teams keep FPL's FDR untouched,
    # since engine/calibration/fit_coefficients.py's FDR_* tables were
    # calibrated against FPL's own raw FDR values, not this alternative scale.
    team_strength_by_id = (
        {t["id"]: team_strength["teams"].get(t["name"]) for t in bootstrap["teams"]} if team_strength else {}
    )
    # Per-fixture betting-odds-derived numbers (engine/odds.py), keyed by FPL
    # fixture id as a string (JSON object keys). Only present for fixtures a
    # market has actually priced - absent for blank/postponed fixtures, a
    # missing API key, or when engine/odds.py hasn't run yet.
    odds_by_fixture = odds.get("fixtures", {}) if odds else {}
    # Per-player last-completed-season penalty/xG split (engine/understat.py),
    # keyed by FPL id as a string (JSON object keys) - only present for
    # confidently name+team-matched players with enough matches last season
    # to trust the split (see MIN_MATCHES_FOR_SPLIT in engine/understat.py).
    understat_by_id = understat.get("players", {}) if understat else {}
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

        mp = _expected_minutes_profile(e, prior, team["played"], season_started_flag)
        understat_split = understat_by_id.get(str(e["id"]))
        xg90 = _blended_rate(
            "expected_goals", e, prior, season_started_flag, attack_mult_table, understat_split
        )
        xa90 = _blended_rate("expected_assists", e, prior, season_started_flag, attack_mult_table)
        set_piece_xg_boost, set_piece_xa_boost = _set_piece_boost(e)
        xg90 += set_piece_xg_boost
        xa90 += set_piece_xa_boost
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
        faces_promoted_team = False
        for fx in sorted(team_fixtures, key=lambda f: f["event"]):
            is_home = fx["team_h"] == team["id"]
            fdr = fx["team_h_difficulty"] if is_home else fx["team_a_difficulty"]
            opp_id = fx["team_a"] if is_home else fx["team_h"]
            opponent = teams_by_id[opp_id]

            opp_strength = team_strength_by_id.get(opp_id)
            if opp_strength and opp_strength["confidence"] == "promoted_fallback":
                # FPL's own FDR is least trustworthy exactly here (little/no
                # current-season info on a newly-promoted side) - swap in our
                # own historically-derived equivalent for this fixture only,
                # a single-value replacement of which FDR source is trusted,
                # not a second multiplier stacked on top of the original.
                fdr = opp_strength["fdr_equivalent"]
                faces_promoted_team = True

            attack_mult = attack_mult_table[fdr]
            cs_prob = cs_prob_table[fdr] + (HOME_CS_BONUS if is_home else 0.0)
            expected_conceded = expected_conceded_table[fdr]

            # Betting odds are the most responsive opponent-strength signal
            # available (move daily with team news/injuries, unlike FPL's
            # fixed 1-5 FDR or our own pre-season team-strength number) - when
            # a market has priced this fixture, its derived numbers replace
            # the FDR-table lookups above entirely for this fixture; anything
            # without a priced market (no key configured, API down, blank/
            # postponed fixture, beyond the bookmaker's posting horizon) falls
            # straight through to the FDR-table values, unchanged.
            odds_row = odds_by_fixture.get(str(fx["id"]))
            if odds_row:
                side = "home" if is_home else "away"
                attack_mult = odds_row[f"attack_mult_{side}"]
                cs_prob = odds_row[f"clean_sheet_prob_{side}"] + (HOME_CS_BONUS if is_home else 0.0)
                expected_conceded = odds_row[f"expected_conceded_{side}"]

            # Anything reachable off the bench scales on p_appearance; anything
            # needing a genuine long appearance (defensive contribution, clean
            # sheets, the long-play portion of appearance points) scales on the
            # stricter p_60_plus - this is what stops a great per-90 rate from a
            # cameo-only player inflating their defensive/clean-sheet/bonus upside
            # the way a single flat ratio used to.
            appearance_pts = mp.p_appearance * short_play + mp.p_60_plus * (long_play - short_play)
            attacking_pts = (goal_pts * xg90 + assist_pts * xa90) * attack_mult * mp.p_appearance
            defensive_pts = dc_prob * dc_pts * mp.p_60_plus
            clean_sheet_pts = cs_prob * cs_pts * mp.p_60_plus
            conceded_penalty = expected_conceded * conceded_pts_per_goal * mp.p_appearance
            save_pts = saves90 * save_pts_per_save * mp.p_appearance
            bonus_pts = bonus_est * mp.p_appearance

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

        # Uncertainty widens for low chance-of-a-long-appearance and blank-fixture
        # players - p_60_plus is the stricter signal, since that's what most of a
        # player's point sources actually depend on reaching.
        confidence_gap = 1 - mp.p_60_plus
        uncertainty = round(total_ev * (0.15 + 0.35 * confidence_gap) + 0.3, 2)
        if prior and prior.consistency is not None:
            consistency_adj = max(
                -CONSISTENCY_ADJ_CLAMP,
                min(CONSISTENCY_ADJ_CLAMP, (prior.consistency - CONSISTENCY_NEUTRAL_CV) * CONSISTENCY_ADJ_SCALE),
            )
            uncertainty = round(uncertainty + consistency_adj, 2)
        if faces_promoted_team:
            # A promoted opponent's fdr_equivalent leans on a bottom-quartile
            # fallback, not real data for that specific team - flag the lower
            # confidence visibly rather than presenting it at the same
            # precision as an established opponent.
            uncertainty = round(uncertainty + 0.3, 2)

        # Capped-upside caveat: good rate, but rarely reaches the 60' threshold
        # that unlocks defensive/clean-sheet/bonus points - the concrete case
        # this playing-time model exists to catch (a super-sub with flashy
        # per-90 stats isn't the same prospect as a nailed starter with a
        # lower rate).
        capped_upside = xgi90 >= 0.4 and mp.p_60_plus < 0.35 and mp.p_appearance >= 0.3

        minutes_reason = mp.reason
        if mp.p_appearance > 0.05:
            minutes_reason = f"{mp.reason} (~{mp.expected_minutes_if_appears:.0f} min when playing)"

        why: list[str] = [minutes_reason]
        if capped_upside:
            why.append(
                f"Capped upside: {xgi90:.2f} xGI/90 is strong, but rarely reaching 60' limits "
                "defensive/clean-sheet/bonus points"
            )
        elif xgi90 > 0:
            why.append(f"Underlying output: {xgi90:.2f} combined xG+xA per 90 minutes")
        if prior and prior.consistency is not None and prior.consistency < 0.2:
            why.append(f"Consistently productive across the last {len(prior.seasons_used)} seasons")
        elif prior and prior.consistency is not None and prior.consistency > 0.6:
            why.append("Output driven by one standout season - underlying rates are volatile")
        if e.get("penalties_order") == 1:
            why.append(f"Primary penalty taker (+{SET_PIECE_PENALTY_XG_BOOST:.2f} xG/90)")
        elif e.get("penalties_order") == 2:
            why.append(f"Backup penalty taker (+{SET_PIECE_BACKUP_PENALTY_XG_BOOST:.2f} xG/90)")
        elif e.get("direct_freekicks_order") == 1:
            why.append(f"Primary free-kick taker (+{SET_PIECE_FREEKICK_XG_BOOST:.2f} xG/90)")
        elif e.get("corners_and_indirect_freekicks_order") == 1:
            why.append(f"Primary corner taker (+{SET_PIECE_CORNER_XA_BOOST:.2f} xA/90)")
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
                expected_minutes_ratio=round(mp.p_appearance, 2),
                p_appearance=round(mp.p_appearance, 2),
                p_60_plus=round(mp.p_60_plus, 2),
                expected_minutes_if_appears=round(mp.expected_minutes_if_appears, 1),
                total_ev=round(total_ev, 2),
                uncertainty=uncertainty,
                why=why[:3],
                fixtures=fixture_evs,
            )
        )

    return results
