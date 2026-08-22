import type { PlayerEV } from './fpl'

export interface TransferSuggestion {
  out_id: number
  in_id: number
  ev_delta: number
  cost_delta: number
  net_gain: number
  uses_hit: boolean
  rationale: string[]
  out: PlayerEV
  in: PlayerEV
  // Real sell price for `out` (engine/transfers.py's compute_sell_prices) -
  // optional since the client-side declared-squad mirror in
  // lib/transferSuggestions.ts has no transfer history to compute it from.
  out_sell_price?: number
}

export interface TransferSuggestions {
  available: boolean
  reason?: string
  free_transfers?: number
  bank?: number
  suggestions?: TransferSuggestion[]
}
