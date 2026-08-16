export interface TickerFixture {
  event: number
  opponent_short: string
  is_home: boolean
  fdr: number
}

export interface TeamTicker {
  team_short: string
  team_name: string
  fixtures: TickerFixture[]
  avg_fdr: number | null
  // Detection, not a forecast - grouping already-fetched fixtures by team +
  // gameweek. See engine/model.py's build_fixture_ticker docstring.
  double_events: number[]
  blank_events: number[]
  unscheduled_count: number
}
