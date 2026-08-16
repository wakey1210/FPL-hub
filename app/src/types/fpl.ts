export type Position = 'GKP' | 'DEF' | 'MID' | 'FWD'

export interface FixtureEV {
  event: number
  opponent_short: string
  is_home: boolean
  fdr: number
  points: number
}

export interface PlayerEV {
  id: number
  web_name: string
  team_short: string
  position: Position
  now_cost: number
  selected_by_percent: number
  status: string
  news: string
  expected_minutes_ratio: number
  p_appearance: number
  p_60_plus: number
  expected_minutes_if_appears: number
  total_ev: number
  uncertainty: number
  why: string[]
  fixtures: FixtureEV[]
}

export interface Team {
  id: number
  name: string
  short_name: string
  strength_overall_home: number
  strength_overall_away: number
}

export interface Meta {
  generated_at: string
  season_started: boolean
  forecast_gameweeks: number
  current_gameweek: number | null
  next_gameweek: number | null
  next_deadline: string | null
  model_version: string
}

export interface SquadRecommendation {
  budget_tenths: number
  total_cost: number
  total_ev: number
  squad: PlayerEV[]
  starting_ids: number[]
  bench_ids: number[]
  captain_id: number
  vice_captain_id: number
}
