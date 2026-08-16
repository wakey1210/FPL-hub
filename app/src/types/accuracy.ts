export interface GameweekAccuracy {
  event: number
  generated_at: string
  scored: boolean
  rmse: number
  mae: number
  n: number
}

export type AccuracySummary = GameweekAccuracy[]
