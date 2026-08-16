import type { AccuracySummary as AccuracySummaryData } from '../types/accuracy'

const BENCHMARK_LOW = 1.2
const BENCHMARK_HIGH = 2.0

export function AccuracySummary({ data }: { data: AccuracySummaryData }) {
  if (data.length === 0) {
    return (
      <p className="text-xs text-white/50">
        No gameweeks scored yet - this fills in gameweek by gameweek once matches are played,
        logged before results are known so it can't be adjusted with hindsight.
      </p>
    )
  }

  return (
    <div>
      <p className="text-xs text-white/50 mb-2">
        RMSE/MAE per player-gameweek, logged before each gameweek's results were known. Public-data
        models typically land around {BENCHMARK_LOW.toFixed(1)}-{BENCHMARK_HIGH.toFixed(1)} RMSE
        (the OpenFPL benchmark) - shown for context, not as a target we've hit.
      </p>
      <div className="space-y-1">
        {data.map((gw) => {
          const inRange = gw.rmse >= BENCHMARK_LOW && gw.rmse <= BENCHMARK_HIGH
          return (
            <div key={gw.event} className="bg-white/5 rounded-lg px-3 py-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold">GW{gw.event}</span>
                <span className={inRange ? 'text-[#00ff87]' : 'text-amber-300'}>
                  RMSE {gw.rmse.toFixed(2)} · MAE {gw.mae.toFixed(2)}
                </span>
                <span className="text-white/40">n={gw.n}</span>
              </div>
              {gw.ml_rmse != null && (
                <div className="flex items-center justify-between text-[11px] text-white/40 mt-1">
                  <span>ML model (experimental)</span>
                  <span>
                    RMSE {gw.ml_rmse.toFixed(2)} · MAE {(gw.ml_mae ?? 0).toFixed(2)}
                  </span>
                  <span>n={gw.ml_n}</span>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
