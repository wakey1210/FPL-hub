import { useNavigate } from 'react-router-dom'
import { useJsonData } from '../lib/data'
import { Layout, LoadingState, ErrorState } from '../components/Layout'
import { formatPrice } from '../lib/format'
import { teamColor } from '../lib/teamColors'
import type { ModelChangeRow, ModelChanges } from '../types/modelChanges'

function ChangeRow({ row }: { row: ModelChangeRow }) {
  const rose = row.ev_delta > 0
  return (
    <div className="rounded-xl bg-surface px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span
            className="w-2 h-6 rounded-full shrink-0"
            style={{ backgroundColor: teamColor(row.team_short) }}
          />
          <span className="text-sm font-semibold">{row.web_name}</span>
          <span className="text-[11px] text-white/40">
            {row.team_short} · {formatPrice(row.now_cost)}
          </span>
        </div>
        <p className={`text-sm font-bold shrink-0 ${rose ? 'text-success' : 'text-danger'}`}>
          {rose ? '+' : ''}
          {row.ev_delta.toFixed(1)}
        </p>
      </div>
      <p className="text-[10px] text-white/40 mt-0.5">
        {row.prev_ev.toFixed(1)} → {row.current_ev.toFixed(1)} EV
      </p>
      {row.why.length > 0 && (
        <ul className="mt-1.5 space-y-0.5">
          {row.why.map((line, i) => (
            <li key={i} className="text-[11px] text-white/60 leading-snug">
              {line}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Routed-but-not-bottom-nav page (same convention as PriceChangesPage),
 * reached via a link from MorePage. Shows the biggest predicted-EV movers
 * since the previous pipeline run - "what changed" for the model itself,
 * distinct from PriceChangesPage's official price-change tracking. A quiet
 * run with no meaningful movers is a genuine, correct state, not a bug -
 * see engine/model_changes.py. */
export function ModelChangesPage() {
  const navigate = useNavigate()
  const changes = useJsonData<ModelChanges>('model_changes.json')

  const backToMore = () => navigate('/more')

  if (changes.loading) return <Layout title="Model changes" onBack={backToMore} showNav={false}><LoadingState /></Layout>
  if (changes.error || !changes.data) {
    return <Layout title="Model changes" onBack={backToMore} showNav={false}><ErrorState message={changes.error ?? 'no data'} /></Layout>
  }

  const { has_previous, risers, fallers } = changes.data

  return (
    <Layout title="Model changes" onBack={backToMore} showNav={false}>
      <div className="rounded-xl bg-surface-raised px-4 py-3 mb-4 text-xs text-white/60">
        The biggest predicted-EV movers since the last data refresh, with each player's own top
        reasons why. A quiet refresh with nothing here is expected, not a bug.
      </div>

      {!has_previous ? (
        <p className="text-xs text-white/40">Available after the next data refresh.</p>
      ) : (
        <>
          <section className="mb-5">
            <h2 className="text-sm font-semibold mb-2">Biggest risers</h2>
            {risers.length === 0 ? (
              <p className="text-xs text-white/40">No significant risers since the last refresh.</p>
            ) : (
              <div className="space-y-1.5">
                {risers.map((r) => (
                  <ChangeRow key={r.id} row={r} />
                ))}
              </div>
            )}
          </section>

          <section className="mb-5">
            <h2 className="text-sm font-semibold mb-2">Biggest fallers</h2>
            {fallers.length === 0 ? (
              <p className="text-xs text-white/40">No significant fallers since the last refresh.</p>
            ) : (
              <div className="space-y-1.5">
                {fallers.map((r) => (
                  <ChangeRow key={r.id} row={r} />
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </Layout>
  )
}
