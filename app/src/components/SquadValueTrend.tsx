import type { GwHistoryEntry } from '../types/myTeam'
import { formatPrice } from '../lib/format'

const WIDTH = 280
const HEIGHT = 64
const PADDING = 4

/** Small sparkline of squad value (team value + bank) over the season,
 * from the real per-gameweek `bank`/`value` history FPL already returns
 * (engine/my_team.py) - genuinely accurate, not reconstructed. Plain inline
 * SVG rather than a charting dependency, matching this app's lightweight-
 * frontend conventions (no chart library in app/package.json). */
export function SquadValueTrend({ history }: { history: GwHistoryEntry[] }) {
  if (history.length < 2) {
    return <p className="text-xs text-white/40">Needs at least two gameweeks of history to chart a trend.</p>
  }

  const points = history.map((gw) => ({ event: gw.event, total: gw.value + gw.bank }))
  const values = points.map((p) => p.total)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1

  const coords = points.map((p, i) => {
    const x = PADDING + (i / (points.length - 1)) * (WIDTH - 2 * PADDING)
    const y = HEIGHT - PADDING - ((p.total - min) / range) * (HEIGHT - 2 * PADDING)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })

  const first = points[0].total
  const last = points[points.length - 1].total
  const delta = last - first

  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <p className="text-lg font-bold">{formatPrice(last)}</p>
        <p className={`text-xs font-semibold ${delta > 0 ? 'text-success' : delta < 0 ? 'text-danger' : 'text-white/40'}`}>
          {delta > 0 ? '+' : delta < 0 ? '-' : ''}
          {formatPrice(Math.abs(delta))} this season
        </p>
      </div>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="w-full h-16" preserveAspectRatio="none">
        <polyline points={coords.join(' ')} fill="none" stroke="currentColor" strokeWidth="2" className="text-primary" />
      </svg>
      <div className="flex justify-between text-[10px] text-white/40 mt-1">
        <span>GW{points[0].event}</span>
        <span>GW{points[points.length - 1].event}</span>
      </div>
    </div>
  )
}
