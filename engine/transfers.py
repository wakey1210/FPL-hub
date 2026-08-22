"""Transfer suggestions.

v1 is a greedy single-transfer suggester, not a full multi-gameweek
optimiser (a proper LP-based transfer planner across several gameweeks is on
the roadmap). For each player in the current squad, it finds the best
same-position replacement affordable within budget, and ranks all such swaps
by net EV gain - the EV delta minus a 4-point hit if it would cost a paid
transfer.

Sell price is computed exactly via `compute_sell_prices` (below), using each
squad member's real purchase price - either the most recent `element_in_cost`
from the manager's public transfer history, or `now_cost - cost_change_start`
for players held since day 1 - and FPL's real halve-and-floor-the-rise rule.
`suggest_transfers` falls back to `now_cost` only when no `sell_prices` map
is supplied (e.g. the client-side declared-squad mirror in the app, which has
no transfer history to work from), in which case suggested budgets may be
very slightly optimistic for players who have risen in price since purchase.
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
    # The outgoing player's real sell price (see compute_sell_prices) - shown
    # separately from their current market value so the UI can distinguish
    # "worth £X.Xm now" from "sells for £Y.Ym", which can differ once a
    # player has risen in price since being bought.
    out_sell_price: int = 0


def compute_sell_prices(
    picks: list[dict],
    transfer_history: list[dict],
    players_by_id: dict[int, PlayerEV],
) -> dict[int, int]:
    """Reconstructs each current squad member's real sell price from public
    FPL data - no bespoke purchase-price ledger needed.

    - Players transferred in this season: their most recent transfer-in
      record's `element_in_cost` (the exact price paid, per
      `fetch.get_entry_transfers`) is the purchase price.
    - Players held since day 1 (never appearing as an `element_in` in the
      transfer history): `now_cost - cost_change_start` reconstructs the
      season-start price from A1's new field.

    FPL's real sell-price rule is then applied: a manager keeps only half of
    any price *rise* since purchase (rounded down in the game's favour), but
    absorbs the full drop if the price has fallen - so profit is only halved
    when positive.
    """
    bought_price: dict[int, int] = {}
    for t in sorted(transfer_history, key=lambda t: t["time"]):
        bought_price[t["element_in"]] = t["element_in_cost"]

    sell_prices: dict[int, int] = {}
    for pick in picks:
        element_id = pick["element"]
        player = players_by_id.get(element_id)
        if player is None:
            continue
        purchase_price = bought_price.get(element_id, player.now_cost - player.cost_change_start)
        profit = player.now_cost - purchase_price
        sell_prices[element_id] = purchase_price + profit // 2 if profit > 0 else player.now_cost

    return sell_prices


def suggest_transfers(
    squad: list[PlayerEV],
    all_players: list[PlayerEV],
    bank: int,
    free_transfers: int,
    top_n: int = 5,
    sell_prices: dict[int, int] | None = None,
) -> list[TransferSuggestion]:
    squad_ids = {p.id for p in squad}
    by_position: dict[str, list[PlayerEV]] = {}
    for p in all_players:
        if p.id in squad_ids or p.status in ("i", "s", "u"):
            continue
        by_position.setdefault(p.position, []).append(p)

    suggestions: list[TransferSuggestion] = []
    for out_player in squad:
        out_sell_price = (sell_prices or {}).get(out_player.id, out_player.now_cost)
        budget = bank + out_sell_price
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
                cost_delta=best.now_cost - out_sell_price,
                net_gain=net_gain,
                uses_hit=uses_hit,
                rationale=rationale,
                out_sell_price=out_sell_price,
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
    sell_prices: dict[int, int] | None = None,
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
            working_squad,
            all_players,
            working_bank,
            free_transfers=1,
            top_n=top_n_per_step,
            sell_prices=sell_prices,
        )
        if not candidates or candidates[0].ev_delta <= 0:
            break
        best = candidates[0]
        batch.append(best)
        in_player = next(p for p in all_players if p.id == best.in_id)
        working_squad = [p for p in working_squad if p.id != best.out_id] + [in_player]
        working_bank -= best.cost_delta

    return batch
