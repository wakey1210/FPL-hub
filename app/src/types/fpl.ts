export type Position = 'GKP' | 'DEF' | 'MID' | 'FWD'

export interface FixtureEV {
  event: number
  opponent_short: string
  is_home: boolean
  fdr: number
  points: number
  attack_mult: number
  cs_prob: number
  expected_conceded: number
  ml_points: number
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
  // Raw FPL price-momentum fields (see engine/model.py) - used by the
  // price-changes page's risk bucketing, never blended into total_ev.
  cost_change_event: number
  cost_change_start: number
  transfers_in_event: number
  transfers_out_event: number
  xg90: number
  xa90: number
  dc90: number
  saves90: number
  dc_prob: number
  ml_ev: number
  ml_uncertainty: number
  ml_why: string[]
  // Imagery keys (distinct from `id`/`team_short`) plus season-actuals for
  // the "season stats" sheet tab.
  code: number
  team_code: number
  clean_sheets: number
  goals_conceded: number
  saves: number
  starts: number
  expected_goals_conceded: number
}

export interface Team {
  id: number
  code: number
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
  ml_model_loaded?: boolean
  ml_eligible?: boolean
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
