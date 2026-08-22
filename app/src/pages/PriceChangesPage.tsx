import { useNavigate } from 'react-router-dom'
import { useJsonData } from '../lib/data'
import { Layout, LoadingState, ErrorState } from '../components/Layout'
import { formatPrice, priceRiskClasses } from '../lib/format'
import { teamColor } from '../lib/teamColors'
import type { PriceMoveRow, PriceMoves, WatchlistRow } from '../types/priceMoves'

function PlayerLine({ p, teamShort }: { p: { web_name: string; team_short: string }; teamShort?: string }) {
  return (
    <div className="flex items-center gap-2">
      <span
        className="w-2 h-6 rounded-full shrink-0"
        style={{ backgroundColor: teamColor(teamShort ?? p.team_short) }}
      />
      <span className="text-sm font-semibold">{p.web_name}</span>
      <span className="text-[11px] text-white/40">{p.team_short}</span>
    </div>
  )
}

function MoveRow({ row }: { row: PriceMoveRow }) {
  const rose = row.cost_change_today > 0
  return (
    <div className="flex items-center justify-between rounded-xl bg-surface px-3 py-2.5">
      <PlayerLine p={row} />
      <div className="text-right">
        <p className={`text-sm font-bold ${rose ? 'text-success' : 'text-danger'}`}>
          {rose ? '+' : ''}
          {formatPrice(row.cost_change_today)}
        </p>
        <p className="text-[10px] text-white/40">
          now {formatPrice(row.now_cost)} · {row.transfers_in_event.toLocaleString()} in /{' '}
          {row.transfers_out_event.toLocaleString()} out
        </p>
      </div>
    </div>
  )
}

function WatchlistItem({ row }: { row: WatchlistRow }) {
  return (
    <div className="flex items-center justify-between rounded-xl bg-surface px-3 py-2.5">
      <PlayerLine p={row} />
      <div className="flex items-center gap-2">
        <div className="text-right">
          <p className="text-[11px] text-white/50">
            {row.transfers_in_event.toLocaleString()} in / {row.transfers_out_event.toLocaleString()} out
          </p>
          <p className="text-[10px] text-white/40">{formatPrice(row.now_cost)}</p>
        </div>
        <span className={`px-2 py-1 rounded-full text-[10px] font-bold uppercase ${priceRiskClasses(row.bucket)}`}>
          {row.bucket}
        </span>
      </div>
    </div>
  )
}

/** Routed-but-not-bottom-nav page (same convention as AddPlayerPage /
 * ConfirmTransfersPage), reached via a link from MorePage. Shows today's
 * already-applied price changes plus a forward-looking watchlist bucketed
 * by transfer momentum - deliberately no fake precise "% chance of a price
 * change", since FPL doesn't publish its real thresholds; only the bucket
 * label and the raw transfer numbers behind it, so the user can judge the
 * evidence themselves (see engine/price_history.py). */
export function PriceChangesPage() {
  const navigate = useNavigate()
  const moves = useJsonData<PriceMoves>('price_moves.json')

  const backToMore = () => navigate('/more')

  if (moves.loading) return <Layout title="Price changes" onBack={backToMore} showNav={false}><LoadingState /></Layout>
  if (moves.error || !moves.data) {
    return <Layout title="Price changes" onBack={backToMore} showNav={false}><ErrorState message={moves.error ?? 'no data'} /></Layout>
  }

  const { risers_today, fallers_today, watchlist } = moves.data
  const risingWatch = watchlist.filter((w) => w.bucket === 'rising')
  const fallingWatch = watchlist.filter((w) => w.bucket === 'falling')

  return (
    <Layout title="Price changes" onBack={backToMore} showNav={false}>
      <div className="rounded-xl bg-surface-raised px-4 py-3 mb-4 text-xs text-white/60">
        Estimated from transfer momentum - FPL doesn't publish exact price-change thresholds. Bucket
        labels and raw transfer counts only, never a precise percentage.
      </div>

      <section className="mb-5">
        <h2 className="text-sm font-semibold mb-2">Risers today</h2>
        {risers_today.length === 0 ? (
          <p className="text-xs text-white/40">No price rises applied yet today.</p>
        ) : (
          <div className="space-y-1.5">
            {risers_today.map((r) => (
              <MoveRow key={r.id} row={r} />
            ))}
          </div>
        )}
      </section>

      <section className="mb-5">
        <h2 className="text-sm font-semibold mb-2">Fallers today</h2>
        {fallers_today.length === 0 ? (
          <p className="text-xs text-white/40">No price falls applied yet today.</p>
        ) : (
          <div className="space-y-1.5">
            {fallers_today.map((r) => (
              <MoveRow key={r.id} row={r} />
            ))}
          </div>
        )}
      </section>

      <section className="mb-5">
        <h2 className="text-sm font-semibold mb-1">Watchlist</h2>
        <p className="text-[11px] text-white/40 mb-2">
          Players whose transfer momentum today looks like tonight's price change window may move them.
        </p>
        {risingWatch.length === 0 && fallingWatch.length === 0 ? (
          <p className="text-xs text-white/40">Nothing standing out right now.</p>
        ) : (
          <div className="space-y-3">
            {risingWatch.length > 0 && (
              <div>
                <p className="text-[11px] uppercase tracking-wide text-white/40 mb-1.5">Likely to rise</p>
                <div className="space-y-1.5">
                  {risingWatch.map((w) => (
                    <WatchlistItem key={w.id} row={w} />
                  ))}
                </div>
              </div>
            )}
            {fallingWatch.length > 0 && (
              <div>
                <p className="text-[11px] uppercase tracking-wide text-white/40 mb-1.5">Likely to fall</p>
                <div className="space-y-1.5">
                  {fallingWatch.map((w) => (
                    <WatchlistItem key={w.id} row={w} />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </section>
    </Layout>
  )
}
