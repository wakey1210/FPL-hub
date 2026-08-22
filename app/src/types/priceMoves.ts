import type { Position } from './fpl'

/** Mirrors data/price_moves.json (engine/price_history.py). Bucket labels
 * and raw transfer counts only - deliberately no fake precise percentage,
 * since FPL doesn't publish its real price-change thresholds. */
export type PriceRiskBucket = 'rising' | 'watch' | 'stable' | 'falling' | 'already moved today'

export interface PriceMoveRow {
  id: number
  web_name: string
  team_short: string
  position: Position
  now_cost: number
  // The real day-over-day price diff (today's logged price vs yesterday's) -
  // what "risers/fallers today" is sorted and filtered by. `cost_change_event`
  // is FPL's own gameweek-cumulative figure, kept alongside for context but
  // NOT the same thing as "today".
  cost_change_today: number
  cost_change_event: number
  transfers_in_event: number
  transfers_out_event: number
}

export interface WatchlistRow {
  id: number
  web_name: string
  team_short: string
  position: Position
  bucket: PriceRiskBucket
  transfers_in_event: number
  transfers_out_event: number
  cost_change_event: number
  now_cost: number
}

export interface PriceMoves {
  generated_at: string
  risers_today: PriceMoveRow[]
  fallers_today: PriceMoveRow[]
  watchlist: WatchlistRow[]
}
