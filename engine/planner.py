"""Five-gameweek-ahead transfer and chip planner.

Deliberately a greedy week-by-week simulation that reuses
`engine.transfers.suggest_transfers` as its per-gameweek building block, NOT
a joint multi-period MILP. A true joint optimisation across 5 gameweeks
needs binary bought/sold-by-week variables and hit-cost terms per player per
week - a much harder, far less explainable problem than `optimise.py`'s
one-shot squad pick, and it would cut against this project's stated
"transparent heuristic, don't over-engineer" ethos. Chip timing is a handful
of rare, discrete decisions - better handled as explicit rule checks than
solver variables.

v1 simplification: at most one transfer is considered per simulated
gameweek (not 2+ simultaneous swaps) - multi-transfer weeks are a natural
extension, not built here.
"""
from __future__ import annotations

from dataclasses import dataclass, field, replace

from engine.model import PlayerEV
from engine.transfers import HIT_COST, suggest_transfers

# Verified live from bootstrap["chips"] for the 26/27 season: each chip has two
# copies, split across the season at the GW19/20 boundary. Wildcard/Free Hit
# can't be played until GW2; Bench Boost/Triple Captain can from GW1. An
# unused chip in a window is lost, not carried into the other half.
CHIP_WINDOWS: dict[str, list[tuple[int, int]]] = {
    "wildcard": [(2, 19), (20, 38)],
    "freehit": [(2, 19), (20, 38)],
    "bboost": [(1, 19), (20, 38)],
    "3xc": [(1, 19), (20, 38)],
}
MAX_FREE_TRANSFERS = 5
BANK_PREMIUM_MAX = 2.0  # extra margin (on top of the flat 4pt hit) required early in the horizon
BENCH_BOOST_MIN_EV = 8.0  # bench must project at least this many points to be worth boosting
TRIPLE_CAPTAIN_MIN_UPLIFT = 1.5  # peak single-GW EV must beat the player's own horizon average by this multiple


@dataclass
class PlanStep:
    event: int
    transfers_out: list[int] = field(default_factory=list)
    transfers_in: list[int] = field(default_factory=list)
    hit_cost: int = 0
    chip_played: str | None = None
    projected_gain: float = 0.0
    free_transfers_after: int = 0
    bank_after: int = 0
    rationale: str = ""


def _remaining_ev(player: PlayerEV, from_event: int) -> float:
    """Sum of this player's fixture-by-fixture EV from `from_event` onward,
    not the full (up to 6-week) `total_ev` - what matters for a decision made
    partway through the forecast window is the EV still to come.
    """
    return round(sum(f.points for f in player.fixtures if f.event >= from_event), 2)


def _chip_windows_remaining(chips_used: list[dict]) -> dict[str, list[tuple[int, int]]]:
    """Which of each chip's windows haven't been used yet, derived by diffing
    `chips_used` (what my_team.py reports as already played) against the
    known CHIP_WINDOWS schedule - FPL doesn't publish "chips remaining"
    directly on any public endpoint.
    """
    used_events: dict[str, list[int]] = {}
    for c in chips_used:
        used_events.setdefault(c["name"], []).append(c["event"])

    remaining: dict[str, list[tuple[int, int]]] = {}
    for name, windows in CHIP_WINDOWS.items():
        remaining[name] = [
            (start, stop)
            for start, stop in windows
            if not any(start <= ev <= stop for ev in used_events.get(name, []))
        ]
    return remaining


def _chip_available(remaining: dict[str, list[tuple[int, int]]], chip: str, event: int) -> bool:
    return any(start <= event <= stop for start, stop in remaining.get(chip, []))


def _simulate_transfers(
    squad: list[PlayerEV],
    all_players: list[PlayerEV],
    bank: int,
    free_transfers: int,
    horizon_events: list[int],
) -> list[PlanStep]:
    """Week-by-week transfer decisions. Chip decisions are layered on
    afterwards in `plan_transfers`, since they depend on the squad each week
    ends up with here.
    """
    current_squad = list(squad)
    current_bank = bank
    current_ft = free_transfers
    steps: list[PlanStep] = []
    horizon = len(horizon_events)

    for idx, event in enumerate(horizon_events):
        weeks_remaining = horizon - idx
        bank_premium = BANK_PREMIUM_MAX * (weeks_remaining / horizon)

        adjusted_squad = [replace(p, total_ev=_remaining_ev(p, event)) for p in current_squad]
        adjusted_pool = [replace(p, total_ev=_remaining_ev(p, event)) for p in all_players]

        # free_transfers=1 disables suggest_transfers' own hit penalty so it
        # just ranks swaps by raw ev_delta - the hit/bank decision below is
        # this planner's own, so it can factor in the decaying bank premium.
        candidates = suggest_transfers(
            squad=adjusted_squad, all_players=adjusted_pool, bank=current_bank, free_transfers=1, top_n=1
        )
        best = candidates[0] if candidates else None

        step = PlanStep(event=event)
        if best and best.ev_delta > 0:
            take = False
            if current_ft >= 1:
                take = True
                step.hit_cost = 0
            elif best.ev_delta > HIT_COST + bank_premium:
                take = True
                step.hit_cost = HIT_COST

            if take:
                by_id = {p.id: p for p in current_squad}
                out_player, in_player_full = by_id[best.out_id], next(
                    p for p in all_players if p.id == best.in_id
                )
                current_squad = [p for p in current_squad if p.id != best.out_id] + [in_player_full]
                current_bank = current_bank - best.cost_delta
                current_ft = max(0, current_ft - 1)
                step.transfers_out = [best.out_id]
                step.transfers_in = [best.in_id]
                step.projected_gain = round(best.ev_delta - step.hit_cost, 2)
                hit_note = f" (takes a -{HIT_COST} hit)" if step.hit_cost else " (free transfer)"
                step.rationale = (
                    f"OUT {out_player.web_name} → IN {in_player_full.web_name}: "
                    f"+{best.ev_delta:.1f} EV over the rest of the plan{hit_note}"
                )
            elif best.ev_delta > 0:
                step.rationale = (
                    f"Best available swap (+{best.ev_delta:.1f} EV) doesn't clear the hit "
                    f"threshold yet ({HIT_COST + bank_premium:.1f} pts needed with "
                    f"{weeks_remaining} planning week(s) left) - banking the free transfer instead."
                )
        else:
            step.rationale = "No beneficial swap found - hold."

        current_ft = min(MAX_FREE_TRANSFERS, current_ft + 1)
        step.free_transfers_after = current_ft
        step.bank_after = current_bank
        steps.append(step)

    return steps


def _apply_chip_calls(
    steps: list[PlanStep],
    squad: list[PlayerEV],
    all_players: list[PlayerEV],
    chips_used: list[dict],
) -> None:
    """Layers Bench Boost / Triple Captain / Wildcard calls onto an existing
    week-by-week plan, mutating `steps` in place. Only one chip per week; if
    more than one looks attractive in the same week, the larger projected
    gain wins and the rest are left as "considered, not recommended".
    """
    from engine.optimise import select_starting_xi

    remaining = _chip_windows_remaining(chips_used)
    by_id_all = {p.id: p for p in all_players}

    # Reconstruct the evolving squad week-by-week to evaluate chips against
    # what's actually owned at that point in the plan, not just the starting squad.
    current_squad = list(squad)
    weekly_squads: list[list[PlayerEV]] = []
    for step in steps:
        if step.transfers_out:
            current_squad = [p for p in current_squad if p.id not in step.transfers_out] + [
                by_id_all[i] for i in step.transfers_in
            ]
        weekly_squads.append(list(current_squad))

    best_bb: tuple[int, float] | None = None  # (index, bench_ev)
    best_tc: tuple[int, float, str] | None = None  # (index, uplift, player_name)
    best_wc: tuple[int, float] | None = None  # (index, total_positive_delta)

    for i, step in enumerate(steps):
        event = step.event
        week_squad = weekly_squads[i]
        adjusted_squad = [replace(p, total_ev=_remaining_ev(p, event)) for p in week_squad]

        if _chip_available(remaining, "bboost", event):
            xi = select_starting_xi(adjusted_squad)
            by_id = {p.id: p for p in adjusted_squad}
            bench_ev = sum(_remaining_ev(by_id[i], event) for i in xi.bench_ids)
            # Bench Boost only really counts THIS gameweek's points, not the
            # whole remaining horizon - approximate with the single-event slice.
            bench_ev_this_gw = sum(
                next((f.points for f in by_id[i].fixtures if f.event == event), 0.0) for i in xi.bench_ids
            )
            if bench_ev_this_gw >= BENCH_BOOST_MIN_EV and (best_bb is None or bench_ev_this_gw > best_bb[1]):
                best_bb = (i, bench_ev_this_gw)

        if _chip_available(remaining, "3xc", event):
            xi = select_starting_xi(adjusted_squad)
            by_id = {p.id: p for p in adjusted_squad}
            for pid in xi.starting_ids:
                player = by_id[pid]
                this_gw = next((f.points for f in player.fixtures if f.event == event), 0.0)
                horizon_avg = player.total_ev / max(len(player.fixtures), 1)
                if horizon_avg > 0 and this_gw >= TRIPLE_CAPTAIN_MIN_UPLIFT * horizon_avg:
                    uplift = this_gw - horizon_avg
                    if best_tc is None or uplift > best_tc[1]:
                        best_tc = (i, uplift, player.web_name)

        if _chip_available(remaining, "wildcard", event):
            by_position: dict[str, list[PlayerEV]] = {}
            for p in all_players:
                if p.id not in {s.id for s in week_squad}:
                    by_position.setdefault(p.position, []).append(p)
            total_positive_delta = 0.0
            for owned in adjusted_squad:
                pool = by_position.get(owned.position, [])
                better = [replace(p, total_ev=_remaining_ev(p, event)) for p in pool]
                best_alt = max((p.total_ev for p in better), default=0.0)
                if best_alt > owned.total_ev:
                    total_positive_delta += best_alt - owned.total_ev
            if total_positive_delta > (HIT_COST * 2) and (best_wc is None or total_positive_delta > best_wc[1]):
                best_wc = (i, total_positive_delta)

    # Apply whichever chip call is strongest per candidate week, respecting
    # one-chip-per-week and not overwriting an existing transfer decision's
    # week unless the chip is clearly the better call.
    for candidate, chip_name, label in (
        (best_wc, "wildcard", "Wildcard"),
        (best_bb, "bboost", "Bench Boost"),
        (best_tc, "3xc", "Triple Captain"),
    ):
        if candidate is None:
            continue
        i = candidate[0]
        if steps[i].chip_played is not None:
            continue
        steps[i].chip_played = chip_name
        gain = candidate[1]
        if chip_name == "3xc":
            steps[i].rationale += f" | {label} recommended on {candidate[2]} (+{gain:.1f} pts vs. their own average)"
        else:
            steps[i].rationale += f" | {label} recommended (bench/upgrade potential ~{gain:.1f} pts)"
        steps[i].projected_gain = round(steps[i].projected_gain + gain, 2)


def plan_transfers(
    squad: list[PlayerEV],
    all_players: list[PlayerEV],
    bank: int,
    free_transfers: int,
    chips_used: list[dict],
    current_event: int,
    horizon: int = 5,
) -> list[PlanStep]:
    horizon_events = list(range(current_event, current_event + horizon))
    steps = _simulate_transfers(squad, all_players, bank, free_transfers, horizon_events)
    _apply_chip_calls(steps, squad, all_players, chips_used)
    return steps
