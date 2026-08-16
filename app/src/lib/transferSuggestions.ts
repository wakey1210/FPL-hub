import type { PlayerEV, Position } from '../types/fpl'

// Mirrors engine/transfers.py exactly - a greedy single-transfer suggester,
// ported to run client-side against a locally-declared squad (which
// engine/transfers.py can't see, since it only runs server-side in the
// pipeline). See engine/transfers.py for the authoritative version; this
// must stay in sync with it.
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
    const usesHit = freeTransfers < 1
    const netGain = Math.round((evDelta - (usesHit ? HIT_COST : 0)) * 100) / 100
    const rationale = [
      ...best.why.slice(0, 2),
      `+${evDelta.toFixed(1)} EV over ${outPlayer.web_name} across the next ${FORECAST_GAMEWEEKS} gameweeks`,
    ]
    suggestions.push({
      outId: outPlayer.id,
      inId: best.id,
      evDelta,
      costDelta: best.now_cost - outPlayer.now_cost,
      netGain,
      usesHit,
      rationale,
      out: outPlayer,
      in: best,
    })
  }

  suggestions.sort((a, b) => b.netGain - a.netGain)
  return suggestions.slice(0, topN)
}
