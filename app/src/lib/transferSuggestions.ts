import type { PlayerEV, Position } from '../types/fpl'

// Mirrors engine/transfers.py exactly - a greedy single-transfer suggester,
// ported to run client-side against a locally-declared squad (which
// engine/transfers.py can't see, since it only runs server-side in the
// pipeline). See engine/transfers.py for the authoritative version; this
// must stay in sync with it. A paid transfer ("-4 hit") is never suggested -
// it's always a real-money bet against genuine uncertainty in a heuristic
// model, so with no free transfer available, suggestTransfers returns
// nothing rather than a swap that would cost one.
export const HIT_COST = 4
const FORECAST_GAMEWEEKS = 6 // mirrors engine/model.py's FORECAST_GAMEWEEKS

export interface TransferSuggestionResult {
  outId: number
  inId: number
  evDelta: number
  costDelta: number // tenths of £m; positive = the swap costs more money
  netGain: number
  usesHit: boolean
  rationale: string[]
  out: PlayerEV
  in: PlayerEV
}

const UNAVAILABLE_STATUSES = new Set(['i', 's', 'u'])

export function suggestTransfers(
  squad: PlayerEV[],
  allPlayers: PlayerEV[],
  bank: number,
  freeTransfers: number,
  topN = 5
): TransferSuggestionResult[] {
  // A hit is never worth suggesting (see the module comment) - with no free
  // transfer available, every swap here would need one, so there's nothing
  // left to suggest until a free transfer is available.
  if (freeTransfers < 1) return []

  const squadIds = new Set(squad.map((p) => p.id))
  const byPosition: Partial<Record<Position, PlayerEV[]>> = {}
  for (const p of allPlayers) {
    if (squadIds.has(p.id) || UNAVAILABLE_STATUSES.has(p.status)) continue
    ;(byPosition[p.position] ??= []).push(p)
  }

  const suggestions: TransferSuggestionResult[] = []
  for (const outPlayer of squad) {
    const budget = bank + outPlayer.now_cost
    let best: PlayerEV | null = null
    for (const cand of byPosition[outPlayer.position] ?? []) {
      if (cand.now_cost > budget) continue
      if (!best || cand.total_ev > best.total_ev) best = cand
    }
    if (!best || best.total_ev <= outPlayer.total_ev) continue

    const evDelta = Math.round((best.total_ev - outPlayer.total_ev) * 100) / 100
    const rationale = [
      ...best.why.slice(0, 2),
      `+${evDelta.toFixed(1)} EV over ${outPlayer.web_name} across the next ${FORECAST_GAMEWEEKS} gameweeks`,
    ]
    suggestions.push({
      outId: outPlayer.id,
      inId: best.id,
      evDelta,
      costDelta: best.now_cost - outPlayer.now_cost,
      netGain: evDelta, // a free transfer, by the guard above - never a hit
      usesHit: false,
      rationale,
      out: outPlayer,
      in: best,
    })
  }

  suggestions.sort((a, b) => b.netGain - a.netGain)
  return suggestions.slice(0, topN)
}

/** Mirrors engine/transfers.py's suggest_multiple_transfers exactly -
 * greedily chains up to `maxTransfers` individually net-positive swaps, not
 * a full combinatorial search across which N swaps to make together (see
 * the Python docstring for why). Each step re-runs `suggestTransfers`
 * against the already-partially-updated squad/bank: a player just swapped
 * out is no longer in `workingSquad` so can't be swapped out again, and a
 * player just swapped in is now in `workingSquad` so `suggestTransfers`'s
 * own squad-membership filter naturally excludes them from being suggested
 * again - no extra bookkeeping needed for either case. Stops the moment no
 * further net-positive swap exists, even if `maxTransfers` hasn't been reached. */
export function suggestMultipleTransfers(
  squad: PlayerEV[],
  allPlayers: PlayerEV[],
  bank: number,
  maxTransfers: number,
  topNPerStep = 1
): TransferSuggestionResult[] {
  if (maxTransfers <= 0) return []

  let workingSquad = [...squad]
  let workingBank = bank
  const batch: TransferSuggestionResult[] = []

  for (let i = 0; i < maxTransfers; i++) {
    const candidates = suggestTransfers(workingSquad, allPlayers, workingBank, 1, topNPerStep)
    if (candidates.length === 0 || candidates[0].evDelta <= 0) break
    const best = candidates[0]
    batch.push(best)
    const inPlayer = allPlayers.find((p) => p.id === best.inId)!
    workingSquad = workingSquad.filter((p) => p.id !== best.outId).concat(inPlayer)
    workingBank -= best.costDelta
  }

  return batch
}
