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
}
