"""Reconstructs a bootstrap-static-shaped dict + fixtures list for a past
season "as of" a given gameweek, strictly from vaastav's cached CSVs
(engine/calibration/cache/<season>/{merged_gw.csv,fixtures.csv}) - no
lookahead: every current-season-so-far stat (minutes, starts, per-90 rates)
is a cumulative sum over rows with `GW < gw` only, exactly matching what a
live bootstrap-static would have shown before that gameweek's deadline.

This is the shared foundation both `run_season.py` (validating the existing
heuristic model against real history) and `engine/ml/features.py` (training
the ML model) build on, so the reconstruction problem is solved once, not
twice.

Deliberate, documented limitations (this tests/trains against the CORE
FDR/xG/minutes model only, not every Phase 5 add-on):
- No `chance_of_playing_next_round`/`news`/`status` history exists in the
  CSVs - every player is treated as fully available ("a"). A real
  injury/rotation news signal can't be reconstructed retroactively.
- No `penalties_order`/`direct_freekicks_order`/`corners_and_indirect_freekicks_order`
  history exists either - the set-piece boost never fires in a backtest.
- No `team_strength`/`odds`/`understat` inputs are reconstructed - those all
  need external live data (markets, Understat) that doesn't exist
  historically in a comparable form.
- `game_config.scoring` is hand-maintained per season below, not fetched -
  FPL's real rule changes over time (most notably: defensive_contribution
  scoring only exists from 2025-26 onward) are only approximated to the
  extent captured here.
- No real multi-season `priors` are reconstructed (that would need its own
  historical element-summary equivalent, out of scope here). Passing
  `priors=None` outright was tried first and found to badly distort
  `_expected_minutes_profile`'s minutes/starts-share blend: that blend's
  "current" side is normalized against a *fixed 38-game season*
  (`FULL_SEASON_MINUTES`), so mid-season it's structurally deflated even for
  a nailed starter, and in live use a real prior (typically ~0.85-0.95 for a
  proven starter) is what keeps the blended figure sensible before a full
  season's minutes have accumulated. Without any prior at all, a 9-games-in
  nailed starter like a top-flight striker was mis-classified as a "fringe
  player" - clearly wrong. `build_priors_for_gw` below instead builds a
  same-season *synthetic* prior per player: each rate stat's "prior" is set
  to that same player's own cumulative current-season rate (making
  `_blended_rate`'s blend a same-value no-op, correct and undistorted -
  exactly matching what a real prior contributes for a rate stat), while
  `weighted_minutes_share`/`weighted_starts_share` are normalized against
  *games played so far* (`cum_minutes / (team_played * 90)`, not the fixed
  38-game constant) - a fair, in-scope estimate of "true share so far,"
  extrapolated forward on the assumption a player's role stays stable.
  **Caveat worth stating plainly**: even with this correction, minutes-share
  classification can still read conservative in the first third of a
  season, because the *current*-side of `_expected_minutes_profile`'s own
  blend is unavoidably deflated by the same fixed-season denominator - this
  synthetic prior only supplies a correct comparison point, it can't change
  how the live model itself weighs the two sides. That's a genuine, useful
  backtest finding in its own right (a candidate for `tune.py` to
  investigate - is `STAT_STABILIZATION_MINUTES["minutes_share"]` too slow to
  trust in-season data alone?), not something papered over here.
"""
from __future__ import annotations

import csv
from functools import lru_cache
from pathlib import Path

from engine.calibration.fetch_historical import CACHE_DIR
from engine.calibration.fit_coefficients import POSITION_MAP
from engine.priors import PlayerPrior

# model.py's RATE_FIELD_MAP prior lookup keys - the merged_gw.csv column
# names whose cumulative per-90 rate becomes this synthetic prior's own
# "history", so _blended_rate's blend is a same-value no-op (see module
# docstring).
PRIOR_RATE_FIELDS = ["expected_goals", "expected_assists", "defensive_contribution", "saves"]

ELEMENT_TYPE_BY_POSITION = {"GKP": 1, "DEF": 2, "MID": 3, "FWD": 4}

# defensive_contribution scoring (2pts at the CBIT/CBIRT threshold) only
# exists from 2025-26 onward - earlier seasons get it zeroed out, not
# fabricated.
SEASONS_WITH_DC = {"2025-26"}

# Standard FPL scoring rules, stable across every cached season except DC
# (see SEASONS_WITH_DC) - hand-maintained here since historical seasons have
# no game_config endpoint to fetch this from, unlike the live pipeline.
_BASE_SCORING = {
    "goals_scored": {"GKP": 10, "DEF": 6, "MID": 5, "FWD": 4},
    "assists": 3,
    "clean_sheets": {"GKP": 4, "DEF": 4, "MID": 1, "FWD": 0},
    "goals_conceded": {"GKP": 2, "DEF": 2, "MID": 0, "FWD": 0},
    "saves": 3,
    "long_play": 2,
    "short_play": 1,
}


def _scoring_for_season(season: str) -> dict:
    dc_pts = 2 if season in SEASONS_WITH_DC else 0
    return {
        **_BASE_SCORING,
        "defensive_contribution": {"GKP": 0, "DEF": dc_pts, "MID": dc_pts, "FWD": dc_pts},
    }


@lru_cache(maxsize=None)
def _load_season_data(season: str) -> tuple[tuple[dict, ...], dict[str, dict], dict[str, str]]:
    """Loads + lightly indexes one season's cached CSVs once - reused across
    every gameweek's reconstruction within a `run_season` call, since the
    raw rows themselves never change."""
    cache = CACHE_DIR / season
    with open(cache / "fixtures.csv", newline="") as f:
        fixtures_by_id = {r["id"]: r for r in csv.DictReader(f)}
    with open(cache / "merged_gw.csv", newline="") as f:
        merged_gw_rows = tuple(csv.DictReader(f))

    # merged_gw.csv's own `team` name string + `was_home`, cross-referenced
    # against fixtures.csv's numeric team_h/team_a, gives the numeric-id ->
    # name mapping without any external alias table (confirmed by
    # inspection: FPL's own per-season numeric team ids are consistent
    # between the two files).
    team_name_by_id: dict[str, str] = {}
    for r in merged_gw_rows:
        fx = fixtures_by_id.get(r["fixture"])
        if not fx:
            continue
        numeric_id = fx["team_h"] if r["was_home"] == "True" else fx["team_a"]
        team_name_by_id.setdefault(numeric_id, r["team"])

    return merged_gw_rows, fixtures_by_id, team_name_by_id


def build_bootstrap_for_gw(season: str, gw: int) -> tuple[dict, list[dict]]:
    """Returns (bootstrap, fixtures) shaped exactly like a live
    `fetch.get_bootstrap()`/`fetch.get_fixtures()` pair, reconstructed as of
    gameweek `gw` (i.e. only gameweeks `< gw` have been "played" yet) -
    engine.model.build_player_ev needs zero changes to consume this.
    """
    merged_gw_rows, fixtures_by_id, team_name_by_id = _load_season_data(season)
    team_ids = sorted(int(i) for i in team_name_by_id)
    name_by_int_id = {int(k): v for k, v in team_name_by_id.items()}

    events_seen = sorted({int(fx["event"]) for fx in fixtures_by_id.values() if fx.get("event")})

    played_count = {tid: 0 for tid in team_ids}
    for fx in fixtures_by_id.values():
        if not fx.get("event") or int(fx["event"]) >= gw or fx.get("finished") != "True":
            continue
        played_count[int(fx["team_h"])] += 1
        played_count[int(fx["team_a"])] += 1

    teams = [
        {
            "id": tid,
            "name": name_by_int_id[tid],
            "short_name": name_by_int_id[tid][:3].upper(),
            "played": played_count[tid],
        }
        for tid in team_ids
    ]
    events = [{"id": ev, "finished": ev < gw} for ev in events_seen]

    rows_by_element: dict[str, list[dict]] = {}
    for r in merged_gw_rows:
        rows_by_element.setdefault(r["element"], []).append(r)

    elements = []
    for element_id, rows in rows_by_element.items():
        rows = sorted(rows, key=lambda r: int(r["GW"]))
        past_rows = [r for r in rows if int(r["GW"]) < gw]
        reference_row = past_rows[-1] if past_rows else rows[0]

        position = POSITION_MAP.get(reference_row["position"])
        if position is None:
            continue  # "AM" (manager) rows - same exclusion as fit_coefficients.py

        cum_minutes = sum(int(r["minutes"] or 0) for r in past_rows)
        cum_starts = sum(int(r["starts"] or 0) for r in past_rows)

        def cum_rate(field: str, _rows=past_rows, _minutes=cum_minutes) -> float:
            if _minutes == 0:
                return 0.0
            total = sum(float(r.get(field) or 0.0) for r in _rows)
            return round(90 * total / _minutes, 4)

        team_name = reference_row["team"]
        team_id = next((tid for tid in team_ids if name_by_int_id[tid] == team_name), team_ids[0])

        elements.append(
            {
                "id": int(element_id),
                "web_name": reference_row["name"],
                "element_type": ELEMENT_TYPE_BY_POSITION[position],
                "team": team_id,
                "now_cost": round(float(reference_row["value"])),
                "selected_by_percent": 0.0,
                "status": "a",
                "news": "",
                "chance_of_playing_next_round": None,
                "minutes": cum_minutes,
                "starts": cum_starts,
                "expected_goals_per_90": cum_rate("expected_goals"),
                "expected_assists_per_90": cum_rate("expected_assists"),
                "defensive_contribution_per_90": cum_rate("defensive_contribution")
                if season in SEASONS_WITH_DC
                else 0.0,
                "saves_per_90": cum_rate("saves"),
                "penalties_order": None,
                "direct_freekicks_order": None,
                "corners_and_indirect_freekicks_order": None,
                "ict_index_rank_type": None,
                "removed": False,
            }
        )

    bootstrap = {
        "teams": teams,
        "events": events,
        "elements": elements,
        "game_config": {"scoring": _scoring_for_season(season)},
    }
    fixtures = [
        {
            "id": int(fx["id"]),
            "event": int(fx["event"]),
            "team_h": int(fx["team_h"]),
            "team_a": int(fx["team_a"]),
            "team_h_difficulty": int(fx["team_h_difficulty"]) if fx.get("team_h_difficulty") else 3,
            "team_a_difficulty": int(fx["team_a_difficulty"]) if fx.get("team_a_difficulty") else 3,
        }
        for fx in fixtures_by_id.values()
        if fx.get("event")
    ]
    return bootstrap, fixtures


def build_priors_for_gw(season: str, gw: int) -> dict[int, PlayerPrior]:
    """Same-season synthetic priors (see module docstring for why `None` was
    tried first and rejected) - one per element with any minutes before `gw`.
    """
    merged_gw_rows, fixtures_by_id, _ = _load_season_data(season)

    played_count: dict[str, int] = {}
    for fx in fixtures_by_id.values():
        if not fx.get("event") or int(fx["event"]) >= gw or fx.get("finished") != "True":
            continue
        played_count[fx["team_h"]] = played_count.get(fx["team_h"], 0) + 1
        played_count[fx["team_a"]] = played_count.get(fx["team_a"], 0) + 1

    rows_by_element: dict[str, list[dict]] = {}
    for r in merged_gw_rows:
        rows_by_element.setdefault(r["element"], []).append(r)

    priors: dict[int, PlayerPrior] = {}
    for element_id, rows in rows_by_element.items():
        rows = sorted(rows, key=lambda r: int(r["GW"]))
        past_rows = [r for r in rows if int(r["GW"]) < gw]
        cum_minutes = sum(int(r["minutes"] or 0) for r in past_rows)
        if cum_minutes == 0:
            continue  # no minutes yet - nothing to build a same-season prior from

        reference_row = past_rows[-1]
        fixture = fixtures_by_id.get(reference_row["fixture"])
        team_numeric_id = (
            (fixture["team_h"] if reference_row["was_home"] == "True" else fixture["team_a"])
            if fixture
            else None
        )
        team_played = played_count.get(team_numeric_id, len(past_rows)) if team_numeric_id else len(past_rows)
        cum_starts = sum(int(r["starts"] or 0) for r in past_rows)

        per90 = {
            f: round(90 * sum(float(r.get(f) or 0.0) for r in past_rows) / cum_minutes, 4)
            for f in PRIOR_RATE_FIELDS
        }

        priors[int(element_id)] = PlayerPrior(
            id=int(element_id),
            web_name=reference_row["name"],
            seasons_used=[season],
            weighted_minutes_share=min(cum_minutes / (max(team_played, 1) * 90), 1.0),
            weighted_starts_share=min(cum_starts / max(team_played, 1), 1.0),
            avg_minutes_per_start=round(cum_minutes / cum_starts, 1) if cum_starts else 0.0,
            per90=per90,
            total_weight_minutes=cum_minutes,
            current_season_avg_fdr=None,
            consistency=None,
        )

    return priors


def real_stats_for_gw(season: str, gw: int) -> dict[int, dict]:
    """{fpl_element_id: {"points": int, "minutes": int}} actually recorded in
    this exact gameweek - the ground truth `run_season.py` scores simulated
    squads against (minutes included so it can apply a simple auto-sub rule
    for a starter who didn't play)."""
    merged_gw_rows, _, _ = _load_season_data(season)
    return {
        int(r["element"]): {"points": int(r["total_points"] or 0), "minutes": int(r["minutes"] or 0)}
        for r in merged_gw_rows
        if int(r["GW"]) == gw
    }
