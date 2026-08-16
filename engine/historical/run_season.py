"""Walks a cached historical season gameweek-by-gameweek, using the real
`engine.model`/`engine.optimise`/`engine.transfers` logic completely
unmodified (only `engine.historical.bootstrap`'s reconstruction is new) to
pick an initial squad and make transfer decisions each week, scoring the
simulated team against real recorded results - strictly no lookahead, since
`build_bootstrap_for_gw(season, gw)` only ever exposes gameweeks `< gw`.

This validates real transfer/squad-selection *decisions* over a season, not
just per-player-gameweek point accuracy (that's what
`engine/calibration/fit_coefficients.py`'s holdout RMSE already covers) -
see the module docstring in `engine/historical/bootstrap.py` for the
documented scope limitations (core FDR/xG/minutes model only, same-season
synthetic priors, no odds/Understat/team-strength/set-piece inputs).

**GW1 caveat, confirmed by running this**: the very first simulated
gameweek's initial squad pick is necessarily close to uninformed - before
any gameweek has been played, `build_priors_for_gw` has nothing to build a
same-season prior from, so every player lands in the same "very little
senior game time" minutes tier and differentiation comes only from
whatever's already committed to the historical cache (which starts at
season boundaries, not mid-career). This genuinely mirrors the live app's
own pre-season cold start (see `engine/model.py`'s own module docstring),
so it isn't a bug specific to this harness - but it does mean a season
total is more meaningfully read from GW2 onward, once real in-season signal
exists, than as a single number starting from GW1. A future refinement
could seed GW1 from the *previous* cached season's final-gameweek
reconstruction where available (closer to how a real manager enters a new
season already knowing last year's form) - not built here, flagged as a
fast-follow rather than silently assumed away.

**Run-to-run variance, confirmed by testing**: two calls to `run_season` in
the *same* process return identical totals, but separate process runs of
the exact same season/args can differ by ~5-10% (e.g. 2024-25 GW1-38: 1632,
1534, and 1800 pts across three separate runs). Root cause: the same-season
synthetic priors' documented conservatism (see `bootstrap.py`) clusters many
players into a small number of identical EV tiers, so `optimise.select_squad`'s
MILP frequently has several tied-optimal solutions - which one comes back
depends on the order candidates are handed to the CBC solver, which is
sensitive to Python's per-process string-hash randomization (dict iteration
order for the `element`-string-keyed rows feeding into element construction).
This is a real property of the current harness, not swept under the rug: for
a *stable, comparable* number (e.g. before/after a `tune.py` sweep), run with
a fixed hash seed - `PYTHONHASHSEED=0 python -m engine.historical.run_season
--season 2024-25` - or average a few runs.

Not part of any scheduled workflow - run manually as a dev CLI:

    python -m engine.historical.run_season --season 2024-25
"""
from __future__ import annotations

from dataclasses import dataclass, field

from engine import model, optimise
from engine.historical.bootstrap import build_bootstrap_for_gw, build_priors_for_gw, real_stats_for_gw
from engine.optimise import BUDGET_TENTHS
from engine.transfers import HIT_COST, suggest_transfers

MAX_FREE_TRANSFERS = 5
DEFAULT_END_GW = 38


@dataclass
class WeekResult:
    event: int
    points: int
    transfer_made: bool
    hit_cost: int
    bank_after: int
    free_transfers_after: int


@dataclass
class SeasonResult:
    season: str
    total_points: int = 0
    weekly: list[WeekResult] = field(default_factory=list)


def _stat(stats: dict[int, dict], player_id: int) -> dict:
    return stats.get(player_id, {"points": 0, "minutes": 0})


def _score_week(xi: optimise.StartingXIResult, stats: dict[int, dict]) -> int:
    """Real historical points for one simulated gameweek: a simple, documented
    auto-sub rule (a starter with 0 minutes is replaced by the first bench
    player - in bench order - who did play, without exhaustively re-checking
    formation legality afterward) plus the real captain/vice-captain armband
    rule (doubles the captain's points if they played, otherwise the
    vice-captain's if THEY played - applied independently of which specific
    player ended up in the XI after auto-subs).
    """
    used_bench: set[int] = set()
    final_ids: list[int] = []
    for player_id in xi.starting_ids:
        if _stat(stats, player_id)["minutes"] == 0:
            sub = next(
                (b for b in xi.bench_ids if b not in used_bench and _stat(stats, b)["minutes"] > 0), None
            )
            if sub is not None:
                used_bench.add(sub)
                final_ids.append(sub)
                continue
        final_ids.append(player_id)

    total = sum(_stat(stats, pid)["points"] for pid in final_ids)
    captain_stat = _stat(stats, xi.captain_id)
    if captain_stat["minutes"] > 0:
        total += captain_stat["points"]
    else:
        vice_stat = _stat(stats, xi.vice_captain_id)
        if vice_stat["minutes"] > 0:
            total += vice_stat["points"]
    return total


def run_season(
    season: str,
    start_gw: int = 1,
    end_gw: int = DEFAULT_END_GW,
    coefficients: dict | None = None,
    allow_transfers: bool = True,
) -> SeasonResult:
    """`allow_transfers=False` runs the pick-once-and-hold baseline (see
    `score.py`) through this exact same harness, for a fair comparison."""
    result = SeasonResult(season=season)
    squad_ids: list[int] = []
    bank = 0
    free_transfers = 1

    for gw in range(start_gw, end_gw + 1):
        bootstrap, fixtures = build_bootstrap_for_gw(season, gw)
        priors = build_priors_for_gw(season, gw)
        players = model.build_player_ev(bootstrap, fixtures, forecast_gws=1, priors=priors, coefficients=coefficients)
        by_id = {p.id: p for p in players}

        hit_cost = 0
        transfer_made = False
        if gw == start_gw:
            squad_result = optimise.select_squad(players)
            squad_ids = squad_result.squad_ids
            bank = BUDGET_TENTHS - squad_result.total_cost
        elif allow_transfers:
            squad_players = [by_id[i] for i in squad_ids if i in by_id]
            suggestions = suggest_transfers(squad_players, players, bank, free_transfers, top_n=1)
            if suggestions and suggestions[0].net_gain > 0:
                s = suggestions[0]
                squad_ids = [i for i in squad_ids if i != s.out_id] + [s.in_id]
                bank -= s.cost_delta
                hit_cost = HIT_COST if s.uses_hit else 0
                free_transfers = max(0, free_transfers - 1)
                transfer_made = True
            free_transfers = min(MAX_FREE_TRANSFERS, free_transfers + 1)

        squad_players = [by_id[i] for i in squad_ids if i in by_id]
        xi = optimise.select_starting_xi(squad_players)
        stats = real_stats_for_gw(season, gw)
        week_points = _score_week(xi, stats) - hit_cost

        result.total_points += week_points
        result.weekly.append(
            WeekResult(
                event=gw,
                points=week_points,
                transfer_made=transfer_made,
                hit_cost=hit_cost,
                bank_after=bank,
                free_transfers_after=free_transfers,
            )
        )

    return result


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--season", required=True, help="e.g. 2024-25 (must already be cached - see fetch_historical.py)")
    parser.add_argument("--start-gw", type=int, default=1)
    parser.add_argument("--end-gw", type=int, default=DEFAULT_END_GW)
    args = parser.parse_args()

    result = run_season(args.season, args.start_gw, args.end_gw)
    print(f"{args.season} simulated season total: {result.total_points} points")
    for w in result.weekly:
        note = f" (-{w.hit_cost} hit)" if w.hit_cost else ""
        print(f"  GW{w.event}: {w.points} pts{note}")


if __name__ == "__main__":
    main()
