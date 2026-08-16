import { useJsonData } from '../lib/data'
import { Layout, LoadingState, ErrorState } from '../components/Layout'
import { countdownParts, formatDeadline, formatPrice } from '../lib/format'
import type { Meta, SquadRecommendation } from '../types/fpl'

export function StatusPage() {
  const meta = useJsonData<Meta>('meta.json')
  const squad = useJsonData<SquadRecommendation>('squad_recommendation.json')

  if (meta.loading || squad.loading) return <Layout title="FPL Hub"><LoadingState /></Layout>
  if (meta.error || !meta.data) return <Layout title="FPL Hub"><ErrorState message={meta.error ?? 'no data'} /></Layout>

  const countdown = countdownParts(meta.data.next_deadline)

  return (
    <Layout title="FPL Hub">
      <div className="space-y-4">
        <div className="rounded-2xl bg-gradient-to-br from-[#37003c] to-[#5c0c66] p-5">
          <p className="text-xs uppercase tracking-wide text-[#00ff87] font-semibold">
            {meta.data.season_started ? `Gameweek ${meta.data.current_gameweek}` : 'Pre-season'}
          </p>
          <p className="text-sm text-white/70 mt-1">
            {meta.data.next_gameweek ? `GW${meta.data.next_gameweek} deadline` : 'Next deadline'}
          </p>
          <p className="text-base font-semibold mt-0.5">{formatDeadline(meta.data.next_deadline)}</p>
          {countdown && (
            <div className="flex gap-4 mt-3">
              {(['days', 'hours', 'minutes'] as const).map((unit) => (
                <div key={unit} className="text-center">
                  <p className="text-2xl font-bold tabular-nums">{countdown[unit]}</p>
                  <p className="text-[10px] uppercase text-white/50">{unit}</p>
                </div>
              ))}
            </div>
          )}
        </div>

        {squad.data && (
          <div className="rounded-2xl bg-[#1e1e2a] p-5">
            <p className="text-sm text-white/60 mb-2">Recommended initial squad</p>
            <div className="flex justify-between">
              <div>
                <p className="text-2xl font-bold">{formatPrice(squad.data.total_cost)}</p>
                <p className="text-[11px] text-white/50">of £100.0m budget</p>
              </div>
              <div className="text-right">
                <p className="text-2xl font-bold text-[#00ff87]">{squad.data.total_ev.toFixed(0)}</p>
                <p className="text-[11px] text-white/50">projected pts, next {squad.data.squad[0]?.fixtures.length ?? 6} GWs</p>
              </div>
            </div>
          </div>
        )}

        <div className="rounded-2xl bg-[#1e1e2a] p-5 text-sm text-white/70">
          <p className="font-semibold text-white mb-1">About this model</p>
          <p>
            Predictions are a transparent v1 heuristic (model {meta.data.model_version}) built from public
            FPL data - expected minutes, underlying xG/xA, and fixture difficulty. Every player shows an
            uncertainty range and the reasons behind its score. Accuracy will be tracked here once
            gameweeks start.
          </p>
        </div>
      </div>
    </Layout>
  )
}
