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
}

export interface TransferSuggestions {
  available: boolean
  reason?: string
  free_transfers?: number
  bank?: number
  suggestions?: TransferSuggestion[]
}
