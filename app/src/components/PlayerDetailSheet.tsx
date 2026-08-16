import type { PlayerEV } from '../types/fpl'
import { formatPrice, fdrClasses } from '../lib/format'

interface Props {
  player: PlayerEV | null
  onClose: () => void
}

/** Bottom sheet with the transparent "why" behind a player's EV - the
 * anti-black-box feature that differentiates this from FFH's AI picker. */
export function PlayerDetailSheet({ player, onClose }: Props) {
  if (!player) return null

  return (
    <div className="fixed inset-0 z-30 flex items-end bg-black/50" onClick={onClose}>
      <div
        className="w-full bg-[#1e1e2a] rounded-t-2xl p-5 pb-8 max-h-[75vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-start mb-3">
          <div>
            <h2 className="text-lg font-bold text-white">{player.web_name}</h2>
            <p className="text-sm text-white/60">
              {player.position} · {player.team_short} · {formatPrice(player.now_cost)} ·{' '}
              {player.selected_by_percent.toFixed(1)}% owned
            </p>
          </div>
          <button onClick={onClose} className="text-white/60 text-2xl leading-none px-2">
            ×
          </button>
        </div>

        <div className="flex gap-4 mb-4">
          <div className="flex-1 bg-white/5 rounded-lg p-3 text-center">
            <p className="text-2xl font-bold text-[#00ff87]">{player.total_ev.toFixed(1)}</p>
            <p className="text-[11px] text-white/50">EV next {player.fixtures.length} GWs (±{player.uncertainty.toFixed(1)})</p>
          </div>
          <div className="flex-1 bg-white/5 rounded-lg p-3 text-center">
            <p className="text-2xl font-bold text-white">{Math.round(player.expected_minutes_ratio * 100)}%</p>
            <p className="text-[11px] text-white/50">Expected minutes</p>
          </div>
        </div>

        {player.news && (
          <p className="text-sm text-amber-300 bg-amber-950/40 rounded-lg p-2 mb-4">{player.news}</p>
        )}

        <h3 className="text-sm font-semibold text-white/80 mb-2">Why this rating</h3>
        <ul className="space-y-1.5 mb-4">
          {player.why.map((reason, i) => (
            <li key={i} className="text-sm text-white/80 flex gap-2">
              <span className="text-[#00ff87]">●</span>
              {reason}
            </li>
          ))}
        </ul>

        <h3 className="text-sm font-semibold text-white/80 mb-2">Fixture-by-fixture</h3>
        <div className="space-y-1.5">
          {player.fixtures.map((f) => (
            <div key={f.event} className="flex items-center justify-between text-sm">
              <span className="text-white/70">
                GW{f.event} · {f.is_home ? 'vs' : '@'} {f.opponent_short}
              </span>
              <div className="flex items-center gap-2">
                <span className={`w-6 h-5 rounded text-[10px] font-bold flex items-center justify-center ${fdrClasses(f.fdr)}`}>
                  {f.fdr}
                </span>
                <span className="text-white font-medium w-10 text-right">{f.points.toFixed(1)}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
