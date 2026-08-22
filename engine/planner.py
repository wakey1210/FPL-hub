"""Five-gameweek-ahead transfer and chip planner.

Deliberately a greedy week-by-week simulation that reuses
`engine.transfers.suggest_transfers`/`suggest_multiple_transfers` as its
per-gameweek building block, NOT a joint multi-period MILP. A true joint
optimisation across 5 gameweeks needs binary bought/sold-by-week variables
and hit-cost terms per player per week - a much harder, far less explainable
problem than `optimise.py`'s one-shot squad pick, and it would cut against
this project's stated "transparent heuristic, don't over-engineer" ethos.
Chip timing is a handful of rare, discrete decisions - better handled as
explicit rule checks than solver variables.

Each simulated week can now make as many transfers as free transfers allow
(via `suggest_multiple_transfers`), optionally one more paid-hit swap beyond
that, or bank the week entirely if a one-week lookahead shows a bigger
combined move is available next week with a pooled free transfer. A
Wildcard, when it clears `WILDCARD_MIN_GAIN`, replaces a week's incremental
logic with a full `optimise.select_squad` rebuild - genuinely unlimited
transfers, not an annotated single swap.
"""
from __future__ import annotations

from dataclasses import dataclass, field, replace

from engine.model import PlayerEV
from engine.transfers import HIT_COST, suggest_multiple_transfers, suggest_transfers

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
MAX_FREE_BATCH_PER_WEEK = 5  # matches MAX_FREE_TRANSFERS - can't have more banked than the cap allows
BANK_PREMIUM_MAX = 2.0  # extra margin (on top of the flat 4pt hit) required early in the horizon
BENCH_BOOST_MIN_EV = 8.0  # bench must project at least this many points to be worth boosting
TRIPLE_CAPTAIN_MIN_UPLIFT = 1.5  # peak single-GW EV must beat the player's own horizon average by this multiple
# Hand-picked starting point, not derived from first principles - a real
# squad rebuild should clear a much higher bar than a single swap's flat -4
# hit, since it's a much bigger, harder-to-reverse commitment. A candidate
# for empirical tuning via the Phase 6 backtest harness (engine/historical/).
WILDCARD_MIN_GAIN = HIT_COST * 4


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


def _describe_batch(
    pre_transfer_squad: list[PlayerEV], all_players: list[PlayerEV], batch, hit_suggestion_id: int | None
) -> str:
    """One rationale line per swap in a (possibly multi-transfer) batch,
    leading with the incoming player's own top "why" factor - same reasoning
    style as the single-transfer case, just repeated per swap. `batch` is
    every suggestion applied this week (free + at most one hit-costing
    extra); `hit_suggestion_id` is that extra swap's `in_id`, if any, so its
    line can note the hit. `pre_transfer_squad` must be a snapshot taken
    *before* any of this week's swaps were applied, so outgoing players can
    still be looked up by id.
    """
    by_id = {p.id: p for p in pre_transfer_squad}
    lines = []
    for s in batch:
        out_player = by_id.get(s.out_id)
        in_player = next((p for p in all_players if p.id == s.in_id), None)
        if not out_player or not in_player:
            continue
        why_prefix = f"{in_player.why[0]} — " if in_player.why else ""
        hit_note = f", -{HIT_COST} hit" if s.in_id == hit_suggestion_id else ""
        lines.append(f"{why_prefix}OUT {out_player.web_name} → IN {in_player.web_name} (+{s.ev_delta:.1f} EV{hit_note})")
    return "; ".join(lines)


def _try_wildcard_rebuild(
    squad: list[PlayerEV], all_players: list[PlayerEV], bank: int, min_gain: float
) -> tuple[list[PlayerEV], float, str] | None:
    """Full budget-constrained squad rebuild via `optimise.select_squad` -
    genuinely unlimited transfers, not an annotated single swap. `squad` and
    `all_players` must already be remaining-horizon-EV-adjusted (via
    `_remaining_ev`) by the caller. Returns None if the confirmed gain
    doesn't clear `min_gain` (pass a very negative number, e.g. `float("-inf")`,
    for an unconditional pre-season rebuild).
    """
    from engine.optimise import select_squad

    budget = bank + sum(p.now_cost for p in squad)
    result = select_squad(all_players, budget=budget)
    by_id = {p.id: p for p in all_players}
    new_squad = [by_id[i] for i in result.squad_ids]

    current_value = sum(p.total_ev for p in squad)
    actual_gain = round(result.total_ev - current_value, 2)
    if actual_gain <= min_gain:
        return None

    rationale = (
        f"Wildcard rebuild: +{actual_gain:.1f} EV over the current squad's remaining-horizon "
        f"value from a full reshuffle within budget."
    )
    return new_squad, actual_gain, rationale


def _simulate_transfers(
    squad: list[PlayerEV],
    all_players: list[PlayerEV],
    bank: int,
    free_transfers: int,
    horizon_events: list[int],
    remaining_chips: dict[str, list[tuple[int, int]]] | None = None,
    wildcard_used: bool = False,
    force_rebuild_first_week: bool = False,
    sell_prices: dict[int, int] | None = None,
) -> tuple[list[PlanStep], list[PlayerEV]]:
    """Week-by-week transfer decisions. Bench Boost / Triple Captain are
    layered on afterwards in `plan_transfers` (they don't change the squad
    going forward, only annotate a chip flag) - Wildcard is evaluated inline
    here instead, since a successful rebuild changes every subsequent week's
    squad and needs the simulation to continue from the new one.

    Returns `(steps, final_squad)` - the caller needs the final squad to
    correctly evaluate chips/state after this horizon segment.
    """
    remaining_chips = remaining_chips or {}
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

        step = PlanStep(event=event)

        # Pre-first-deadline: an unconditional full rebuild, no chip token
        # spent, no hit, free_transfers untouched - real FPL lets you rebuild
        # your squad as many times as you like before your first-ever deadline.
        force_rebuild = force_rebuild_first_week and idx == 0
        wildcard_eligible = not wildcard_used and _chip_available(remaining_chips, "wildcard", event)

        rebuild_result = None
        if force_rebuild:
            rebuild_result = _try_wildcard_rebuild(adjusted_squad, adjusted_pool, current_bank, min_gain=float("-inf"))
        elif wildcard_eligible:
            rebuild_result = _try_wildcard_rebuild(adjusted_squad, adjusted_pool, current_bank, min_gain=WILDCARD_MIN_GAIN)

        if rebuild_result is not None:
            new_squad, actual_gain, rationale = rebuild_result
            old_ids = {p.id for p in current_squad}
            new_ids = {p.id for p in new_squad}
            step.transfers_out = [i for i in old_ids if i not in new_ids]
            step.transfers_in = [i for i in new_ids if i not in old_ids]
            step.projected_gain = actual_gain
            step.rationale = rationale
            current_bank = current_bank + sum(p.now_cost for p in current_squad) - sum(p.now_cost for p in new_squad)
            current_squad = new_squad
            if not force_rebuild:
                step.chip_played = "wildcard"
                wildcard_used = True
            # free_transfers is untouched either way - a rebuild isn't a
            # normal transfer for banking purposes.
        else:
            # Free batch: as many net-positive swaps as free transfers allow.
            free_batch = suggest_multiple_transfers(
                adjusted_squad,
                adjusted_pool,
                current_bank,
                max_transfers=min(current_ft, MAX_FREE_BATCH_PER_WEEK),
                sell_prices=sell_prices,
            )
            this_week_value = round(sum(s.ev_delta for s in free_batch), 2)

            # Bounded one-week bank-vs-spend peek: is a bigger combined move
            # available next week if this week's free transfer(s) are banked
            # instead? Skipped on the final horizon week (nothing to bank
            # for) and when there's no free transfer to bank in the first
            # place. Deliberately one week deep, not backward induction over
            # the whole horizon - reuses fixture EVs already computed for
            # the full forecast window, rather than compounding branching at
            # every future depth (opaque to explain, against this module's
            # transparent-heuristic ethos).
            banked_value = None
            if weeks_remaining > 1 and current_ft >= 1 and free_batch:
                banked_ft = min(MAX_FREE_TRANSFERS, current_ft + 1)
                next_event = horizon_events[idx + 1]
                next_squad = [replace(p, total_ev=_remaining_ev(p, next_event)) for p in current_squad]
                next_pool = [replace(p, total_ev=_remaining_ev(p, next_event)) for p in all_players]
                banked_batch = suggest_multiple_transfers(
                    next_squad,
                    next_pool,
                    current_bank,
                    max_transfers=min(banked_ft, MAX_FREE_BATCH_PER_WEEK),
                    sell_prices=sell_prices,
                )
                banked_value = round(sum(s.ev_delta for s in banked_batch), 2)

            if banked_value is not None and banked_value > this_week_value:
                step.rationale = (
                    f"Banking this week: acting now nets +{this_week_value:.1f} EV vs "
                    f"+{banked_value:.1f} EV available next week with {min(MAX_FREE_TRANSFERS, current_ft + 1)} "
                    f"free transfers pooled (using next week's fixture-adjusted projections)."
                )
            else:
                pre_transfer_squad = current_squad
                applied_ev = 0.0
                all_applied = list(free_batch)
                for s in free_batch:
                    in_player_full = next(p for p in all_players if p.id == s.in_id)
                    current_squad = [p for p in current_squad if p.id != s.out_id] + [in_player_full]
                    current_bank -= s.cost_delta
                    current_ft = max(0, current_ft - 1)
                    step.transfers_out.append(s.out_id)
                    step.transfers_in.append(s.in_id)
                    applied_ev += s.ev_delta

                # One additional hit-costing swap beyond the free allocation,
                # evaluated against the post-batch squad - same threshold
                # logic as before, just relocated to run after the free
                # batch instead of instead of it.
                post_batch_squad = [replace(p, total_ev=_remaining_ev(p, event)) for p in current_squad]
                post_batch_pool = [p for p in adjusted_pool if p.id not in {s.id for s in current_squad}]
                hit_candidates = suggest_transfers(
                    post_batch_squad,
                    post_batch_pool,
                    current_bank,
                    free_transfers=1,
                    top_n=1,
                    sell_prices=sell_prices,
                )
                hit_best = hit_candidates[0] if hit_candidates else None
                hit_in_id = None
                if hit_best and hit_best.ev_delta > HIT_COST + bank_premium:
                    in_player_full = next(p for p in all_players if p.id == hit_best.in_id)
                    current_squad = [p for p in current_squad if p.id != hit_best.out_id] + [in_player_full]
                    current_bank -= hit_best.cost_delta
                    step.transfers_out.append(hit_best.out_id)
                    step.transfers_in.append(hit_best.in_id)
                    step.hit_cost = HIT_COST
                    applied_ev += hit_best.ev_delta
                    all_applied.append(hit_best)
                    hit_in_id = hit_best.in_id

                step.projected_gain = round(applied_ev - step.hit_cost, 2)
                if step.transfers_out:
                    step.rationale = _describe_batch(pre_transfer_squad, all_players, all_applied, hit_in_id)
                else:
                    step.rationale = "No beneficial swap found - hold."

        current_ft = min(MAX_FREE_TRANSFERS, current_ft + 1)
        step.free_transfers_after = current_ft
        step.bank_after = current_bank
        steps.append(step)

    return steps, current_squad


def _apply_chip_calls(
    steps: list[PlanStep],
    squad: list[PlayerEV],
    all_players: list[PlayerEV],
    chips_used: list[dict],
) -> None:
    """Layers Bench Boost / Triple Captain calls onto an existing week-by-week
    plan, mutating `steps` in place. Wildcard is evaluated inline inside
    `_simulate_transfers` instead (a successful rebuild changes the squad for
    every subsequent week, unlike Bench Boost/Triple Captain which only
    annotate a chip flag with no lasting effect on the squad going forward -
    see that function). Only one chip per week; if both look attractive in
    the same week, the larger projected gain wins and the other is left as
    "considered, not recommended".
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

    for i, step in enumerate(steps):
        event = step.event
        week_squad = weekly_squads[i]
        adjusted_squad = [replace(p, total_ev=_remaining_ev(p, event)) for p in week_squad]

        if _chip_available(remaining, "bboost", event):
            xi = select_starting_xi(adjusted_squad)
            by_id = {p.id: p for p in adjusted_squad}
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

    # Apply whichever chip call is strongest per candidate week, respecting
    # one-chip-per-week and not overwriting an existing wildcard week (already
    # set inline by _simulate_transfers) unless nothing else claimed it.
    for candidate, chip_name, label in (
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
    season_started: bool = True,
    sell_prices: dict[int, int] | None = None,
) -> list[PlanStep]:
    """`season_started=False` treats the very first simulated week as a free,
    unconditional full-squad rebuild - real FPL lets you rebuild as many
    times as you like before your first-ever deadline, at zero hit cost and
    with no effect on free_transfers, distinct from a genuine Wildcard (which
    consumes a chip token and is gated by `WILDCARD_MIN_GAIN`).

    `sell_prices` (see `engine.transfers.compute_sell_prices`) should be the
    same map passed to the single-swap suggestions for this manager, so the
    Planner and Transfers pages agree on how much budget a sale actually
    frees up - falls back to `now_cost` per-player (via `suggest_transfers`)
    when omitted, e.g. for the client-side declared-squad mirror.
    """
    horizon_events = list(range(current_event, current_event + horizon))
    remaining_chips = _chip_windows_remaining(chips_used)
    steps, _ = _simulate_transfers(
        squad,
        all_players,
        bank,
        free_transfers,
        horizon_events,
        remaining_chips=remaining_chips,
        force_rebuild_first_week=not season_started,
        sell_prices=sell_prices,
    )
    _apply_chip_calls(steps, squad, all_players, chips_used)
    return steps
