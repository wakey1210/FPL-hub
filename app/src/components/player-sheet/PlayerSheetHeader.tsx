import type { PlayerEV } from '../../types/fpl'
import { formatPrice } from '../../lib/format'
import { PlayerAvatar } from '../PlayerAvatar'
import { TeamBadge } from '../TeamBadge'

interface Props {
  player: PlayerEV
  onClose: () => void
}

/** Only rendered when the price actually moved today (`cost_change_event`
 * nonzero) - stays silent otherwise rather than showing a permanent
 * "no change" chip. */
function PriceTrendChip({ costChangeEvent }: { costChangeEvent: number }) {
  if (!costChangeEvent) return null
  const rising = costChangeEvent > 0
  return (
    <span
      className={`inline-flex items-center gap-0.5 text-[11px] font-semibold rounded-full px-2 py-0.5 ${
        rising ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger'
      }`}
    >
      {rising ? '▲' : '▼'}£{Math.abs(costChangeEvent / 10).toFixed(1)}m today
    </span>
  )
}

/** Photo + badge + identity block, extracted from the original
 * PlayerDetailSheet header (name/position/team/price/ownership), now with
 * imagery and a price-trend chip layered on top. */
export function PlayerSheetHeader({ player, onClose }: Props) {
  return (
    <div className="flex justify-between items-start mb-3">
      <div className="flex items-center gap-3 min-w-0">
        <div className="relative shrink-0">
          <PlayerAvatar code={player.code} teamShort={player.team_short} size={48} />
          <div className="absolute -bottom-1 -right-1 rounded-full ring-2 ring-surface overflow-hidden">
            <TeamBadge code={player.team_code} shortName={player.team_short} size={20} />
          </div>
        </div>
        <div className="min-w-0">
          <h2 className="text-lg font-bold text-white truncate">{player.web_name}</h2>
          <p className="text-sm text-white/60 truncate">
            {player.position} · {player.team_short} · {formatPrice(player.now_cost)} ·{' '}
            {player.selected_by_percent.toFixed(1)}% owned
          </p>
          {player.cost_change_event !== 0 && (
            <div className="mt-1">
              <PriceTrendChip costChangeEvent={player.cost_change_event} />
            </div>
          )}
        </div>
      </div>
      <button
        onClick={onClose}
        aria-label="Close"
        className="text-white/60 text-2xl leading-none px-2 min-w-[44px] min-h-[44px] transition-colors active:text-white shrink-0"
      >
        ×
      </button>
    </div>
  )
}
