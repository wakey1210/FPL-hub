export interface Pick {
  element: number
  position: number
  multiplier: number
  is_captain: boolean
  is_vice_captain: boolean
}

export interface GwHistoryEntry {
  event: number
  points: number
  total_points: number
  rank: number | null
  overall_rank: number
  bank: number
  value: number
  event_transfers: number
  event_transfers_cost: number
}

export interface SeasonSummary {
  season_name: string
  total_points: number
  rank: number
  rank_percentage: string
}

export interface ChipUsed {
  name: string
  event: number
}

export interface MyTeam {
  configured: boolean
  team_id?: number
  manager_name?: string
  team_name?: string
  has_squad?: boolean
  picks_event?: number | null
  picks?: Pick[] | null
  summary?: {
    overall_points: number | null
    overall_rank: number | null
    gameweek_points: number | null
    bank: number | null
    team_value: number | null
    free_transfers_estimate: number
  }
  chips_used?: ChipUsed[]
  transfers_made_this_season?: number
  gw_history?: GwHistoryEntry[]
  recent_seasons?: SeasonSummary[]
}
