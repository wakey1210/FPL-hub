"""Transfer suggestions.

v1 is a greedy single-transfer suggester, not a full multi-gameweek
optimiser (a proper LP-based transfer planner across several gameweeks is on
the roadmap). For each player in the current squad, it finds the best
same-position replacement affordable within budget, and ranks all such swaps
by net EV gain - the EV delta minus a 4-point hit if it would cost a paid
transfer.

Sell price is approximated as the player's current market price. FPL's real
sell price can be lower (a manager keeps only 50% of a player's price rise
when selling), but exact sell prices need either the auth-gated `my-team`
endpoint or a purchase-price ledger tracked over the season - both out of
scope for v1. This means suggested budgets may be very slightly optimistic
for players who have risen in price since being bought.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from engine.model import FORECAST_GAMEWEEKS, PlayerEV

HIT_COST = 4


@dataclass
class TransferSuggestion:
    out_id: int
    in_id: int
    ev_delta: float
    cost_delta: int  # tenths of £m; positive = the swap costs more money
    net_gain: float  # ev_delta, minus a hit cost if it would use a paid transfer
    uses_hit: bool
    # Why this specific swap - the incoming player's own top "why" factors
    # (underlying stats, fixture difficulty, etc. - whatever build_player_ev
    # already computed for them) plus one line quantifying the edge over the
    # outgoing player, reusing the existing why-list infrastructure rather
    # than a separate natural-language generator.
    rationale: list[str] = field(default_factory=list)


def suggest_transfers(
    squad: list[PlayerEV],
    all_players: list[PlayerEV],
    bank: int,
    free_transfers: int,
    top_n: int = 5,
) -> list[TransferSuggestion]:
    squad_ids = {p.id for p in squad}
    by_position: dict[str, list[PlayerEV]] = {}
    for p in all_players:
        if p.id in squad_ids or p.status in ("i", "s", "u"):
            continue
        by_position.setdefault(p.position, []).append(p)

    suggestions: list[TransferSuggestion] = []
    for out_player in squad:
        budget = bank + out_player.now_cost
        best = None
        for cand in by_position.get(out_player.position, []):
            if cand.now_cost > budget:
                continue
            if best is None or cand.total_ev > best.total_ev:
                best = cand
        if best is None or best.total_ev <= out_player.total_ev:
            continue

        ev_delta = round(best.total_ev - out_player.total_ev, 2)
        uses_hit = free_transfers < 1
        net_gain = round(ev_delta - (HIT_COST if uses_hit else 0), 2)
        rationale = list(best.why[:2]) + [
            f"+{ev_delta:.1f} EV over {out_player.web_name} across the next {FORECAST_GAMEWEEKS} gameweeks"
        ]
        suggestions.append(
            TransferSuggestion(
                out_id=out_player.id,
                in_id=best.id,
                ev_delta=ev_delta,
                cost_delta=best.now_cost - out_player.now_cost,
                net_gain=net_gain,
                uses_hit=uses_hit,
                rationale=rationale,
            )
        )

    suggestions.sort(key=lambda s: -s.net_gain)
    return suggestions[:top_n]


def suggest_multiple_transfers(
    squad: list[PlayerEV],
    all_players: list[PlayerEV],
    bank: int,
    max_transfers: int,
    top_n_per_step: int = 1,
) -> list[TransferSuggestion]:
    """Greedily chains up to `max_transfers` individually net-positive swaps -
    not a full combinatorial search across which N swaps to make together,
    which would be opaque and cut against this project's transparent-
    heuristic ethos (see engine/planner.py's own docstring). Each step
    re-runs `suggest_transfers` against the already-partially-updated
    squad/bank: a player just swapped out is no longer in `working_squad` so
    can't be swapped out again, and a player just swapped in is now in
    `working_squad` so `suggest_transfers`' own squad-membership filter
    naturally excludes them from being suggested again - no extra
    bookkeeping needed for either case. Stops the moment no further
    net-positive swap exists, even if `max_transfers` hasn't been reached.
    """
    if max_transfers <= 0:
        return []

    working_squad = list(squad)
    working_bank = bank
    batch: list[TransferSuggestion] = []

    for _ in range(max_transfers):
        candidates = suggest_transfers(
            working_squad, all_players, working_bank, free_transfers=1, top_n=top_n_per_step
        )
        if not candidates or candidates[0].ev_delta <= 0:
            break
        best = candidates[0]
        batch.append(best)
        in_player = next(p for p in all_players if p.id == best.in_id)
        working_squad = [p for p in working_squad if p.id != best.out_id] + [in_player]
        working_bank -= best.cost_delta

    return batch
