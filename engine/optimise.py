"""Squad and starting-XI optimisation.

Uses PuLP with its bundled CBC solver (open-source, no license/paid API
needed) to solve the classic FPL squad-selection MILP:

    maximise sum(value picked) subject to budget, position quotas, and
    a maximum of 3 players per real-world club.

`select_squad` picks the 15-man squad; `select_starting_xi` then re-solves a
small MILP over just those 15 to pick the best valid starting XI (respecting
each position's min/max "play" counts) plus captain and vice-captain.
"""
from __future__ import annotations

from dataclasses import dataclass

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


@dataclass
class SquadResult:
    squad_ids: list[int]
    total_cost: int
    total_ev: float


@dataclass
class StartingXIResult:
    starting_ids: list[int]
    bench_ids: list[int]  # ordered: first is auto-sub priority
    captain_id: int
    vice_captain_id: int


def _score(p: PlayerEV) -> float:
    return p.total_ev - RISK_AVERSION * p.uncertainty


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
    by_id = {p.id: p for p in candidates}

    prob += pulp.lpSum(_score(p) * pick[p.id] for p in candidates)
    prob += pulp.lpSum(p.now_cost * pick[p.id] for p in candidates) <= budget
    prob += pulp.lpSum(pick[p.id] for p in candidates) == 15

    for pos, quota in SQUAD_QUOTAS.items():
        prob += (
            pulp.lpSum(pick[p.id] for p in candidates if p.position == pos) == quota
        )

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
    total_cost = sum(by_id[i].now_cost for i in squad_ids)
    total_ev = sum(by_id[i].total_ev for i in squad_ids)
    return SquadResult(squad_ids=squad_ids, total_cost=total_cost, total_ev=round(total_ev, 2))


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
    # Bench order: best outfield reserve first (auto-sub priority), GK last.
    bench_ids.sort(key=lambda i: (by_id[i].position == "GKP", -_score(by_id[i])))

    starters_by_score = sorted(starting_ids, key=lambda i: -_score(by_id[i]))
    captain_id, vice_captain_id = starters_by_score[0], starters_by_score[1]

    return StartingXIResult(
        starting_ids=starting_ids,
        bench_ids=bench_ids,
        captain_id=captain_id,
        vice_captain_id=vice_captain_id,
    )
