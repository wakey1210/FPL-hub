export interface GameweekAccuracy {
  event: number
  generated_at: string
  scored: boolean
  rmse: number
  mae: number
  n: number
  ml_rmse?: number | null
  ml_mae?: number | null
  ml_n?: number | null
}

export type AccuracySummary = GameweekAccuracy[]
