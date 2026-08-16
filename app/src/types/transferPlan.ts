import type { PlayerEV } from './fpl'

export interface PlanStep {
  event: number
  transfers_out: number[]
  transfers_in: number[]
  hit_cost: number
  chip_played: string | null
  projected_gain: number
  free_transfers_after: number
  bank_after: number
  rationale: string
  out: PlayerEV[]
  in: PlayerEV[]
}

export interface TransferPlan {
  available: boolean
  reason?: string
  horizon_start?: number
  horizon_end?: number
  steps?: PlanStep[]
}
