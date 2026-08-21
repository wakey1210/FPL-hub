"""Squad and starting-XI optimisation.

Uses PuLP with its bundled CBC solver (open-source, no license/paid API
needed) to solve the classic FPL squad-selection MILP:

    maximise sum(value picked) subject to budget, position quotas, and
    a maximum of 3 players per real-world club.

`select_squad` jointly picks the 15-man squad *and* which 11 of them start -
a bench player only scores via rare auto-subs, so weighting its EV the same
as a starter's would misdirect budget toward players who mostly won't play;
see `BENCH_WEIGHT` below. `select_starting_xi` separately re-solves a small
MILP over an *already-fixed* 15 to pick the best valid starting XI (respecting
each position's min/max "play" counts) plus captain and vice-captain - used
to re-optimise an existing squad's lineup for a specific gameweek (e.g. chip
timing), a genuinely different problem from initial squad selection.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import pulp

from engine.model import PlayerEV

SQUAD_QUOTAS = {"GKP": 2, "DEF": 5, "MID": 5, "FWD": 3}
BUDGET_TENTHS = 1000  # £100.0m, in FPL's tenths-of-a-million units
MAX_PER_CLUB = 3
STARTING_XI_SIZE = 11
PLAY_MIN_MAX = {
    "GKP": (1, 1),
    "DEF": (3, 5),
    "MID": (2, 5),
    "FWD": (1, 3),
}
RISK_AVERSION = 0.1  # objective = EV - RISK_AVERSION * uncertainty
# Bench points only ever count via a rare auto-sub, so squad selection should
# direct budget toward starters, not toward EV that mostly won't be realised.
# Hand-picked starting point, not derived from first principles - same status
# as RISK_AVERSION/HIT_COST/WILDCARD_MIN_GAIN elsewhere in this codebase,
# a candidate for later tuning against the Phase 6 backtest harness.
BENCH_WEIGHT = 0.15


@dataclass
class SquadResult:
    squad_ids: list[int]
    total_cost: int
    total_ev: float
    starting_ids: list[int] = field(default_factory=list)
    bench_ids: list[int] = field(default_factory=list)
    captain_id: int | None = None
    vice_captain_id: int | None = None


@dataclass
class StartingXIResult:
    starting_ids: list[int]
    bench_ids: list[int]  # ordered: first is auto-sub priority
    captain_id: int
    vice_captain_id: int


def _score(p: PlayerEV) -> float:
    return p.total_ev - RISK_AVERSION * p.uncertainty


def _order_bench_and_pick_captains(
    starting_ids: list[int], bench_ids: list[int], by_id: dict[int, PlayerEV]
) -> tuple[list[int], int, int]:
    """Bench order: best outfield reserve first (auto-sub priority), GK last.
    Captain/vice: the two highest-scoring starters. Shared by select_squad's
    jointly-determined XI and select_starting_xi's standalone re-optimisation
    so this logic isn't duplicated between the two."""
    ordered_bench = sorted(bench_ids, key=lambda i: (by_id[i].position == "GKP", -_score(by_id[i])))
    starters_by_score = sorted(starting_ids, key=lambda i: -_score(by_id[i]))
    return ordered_bench, starters_by_score[0], starters_by_score[1]


def select_squad(
    players: list[PlayerEV],
    budget: int = BUDGET_TENTHS,
    max_per_club: int = MAX_PER_CLUB,
    exclude_unavailable: bool = True,
) -> SquadResult:
    candidates = [
        p for p in players if (not exclude_unavailable or p.status not in ("i", "s", "u"))
    ]
    prob = pulp.LpProblem("fpl_squad_selection", pulp.LpMaximize)
    pick = {p.id: pulp.LpVariable(f"pick_{p.id}", cat="Binary") for p in candidates}
    start = {p.id: pulp.LpVariable(f"start_{p.id}", cat="Binary") for p in candidates}
    by_id = {p.id: p for p in candidates}

    for p in candidates:
        prob += start[p.id] <= pick[p.id]

    # A starter contributes its full score; a squad player left on the bench
    # only contributes BENCH_WEIGHT of it - see module docstring.
    prob += pulp.lpSum(_score(p) * start[p.id] for p in candidates) + BENCH_WEIGHT * pulp.lpSum(
        _score(p) * (pick[p.id] - start[p.id]) for p in candidates
    )
    prob += pulp.lpSum(p.now_cost * pick[p.id] for p in candidates) <= budget
    prob += pulp.lpSum(pick[p.id] for p in candidates) == 15
    prob += pulp.lpSum(start[p.id] for p in candidates) == STARTING_XI_SIZE

    for pos, quota in SQUAD_QUOTAS.items():
        prob += (
            pulp.lpSum(pick[p.id] for p in candidates if p.position == pos) == quota
        )

    for pos, (min_play, max_play) in PLAY_MIN_MAX.items():
        pos_start = pulp.lpSum(start[p.id] for p in candidates if p.position == pos)
        prob += pos_start >= min_play
        prob += pos_start <= max_play

    clubs = {p.team_short for p in candidates}
    for club in clubs:
        prob += (
            pulp.lpSum(pick[p.id] for p in candidates if p.team_short == club)
            <= max_per_club
        )

    prob.solve(pulp.PULP_CBC_CMD(msg=False))
    if pulp.LpStatus[prob.status] != "Optimal":
        raise RuntimeError(f"Squad optimisation failed: {pulp.LpStatus[prob.status]}")

    squad_ids = [p.id for p in candidates if pick[p.id].value() == 1]
    starting_ids = [p.id for p in candidates if start[p.id].value() == 1]
    bench_ids = [i for i in squad_ids if i not in starting_ids]
    ordered_bench, captain_id, vice_captain_id = _order_bench_and_pick_captains(
        starting_ids, bench_ids, by_id
    )
    total_cost = sum(by_id[i].now_cost for i in squad_ids)
    total_ev = sum(by_id[i].total_ev for i in squad_ids)
    return SquadResult(
        squad_ids=squad_ids,
        total_cost=total_cost,
        total_ev=round(total_ev, 2),
        starting_ids=starting_ids,
        bench_ids=ordered_bench,
        captain_id=captain_id,
        vice_captain_id=vice_captain_id,
    )


def select_starting_xi(squad: list[PlayerEV]) -> StartingXIResult:
    prob = pulp.LpProblem("fpl_starting_xi", pulp.LpMaximize)
    start = {p.id: pulp.LpVariable(f"start_{p.id}", cat="Binary") for p in squad}
    by_id = {p.id: p for p in squad}

    prob += pulp.lpSum(_score(p) * start[p.id] for p in squad)
    prob += pulp.lpSum(start[p.id] for p in squad) == STARTING_XI_SIZE

    for pos, (min_play, max_play) in PLAY_MIN_MAX.items():
        pos_sum = pulp.lpSum(start[p.id] for p in squad if p.position == pos)
        prob += pos_sum >= min_play
        prob += pos_sum <= max_play

    prob.solve(pulp.PULP_CBC_CMD(msg=False))
    if pulp.LpStatus[prob.status] != "Optimal":
        raise RuntimeError(f"Starting XI optimisation failed: {pulp.LpStatus[prob.status]}")

    starting_ids = [p.id for p in squad if start[p.id].value() == 1]
    bench_ids = [p.id for p in squad if p.id not in starting_ids]
    ordered_bench, captain_id, vice_captain_id = _order_bench_and_pick_captains(
        starting_ids, bench_ids, by_id
    )

    return StartingXIResult(
        starting_ids=starting_ids,
        bench_ids=ordered_bench,
        captain_id=captain_id,
        vice_captain_id=vice_captain_id,
    )
