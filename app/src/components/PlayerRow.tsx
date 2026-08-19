import type { PlayerEV } from '../types/fpl'
import { formatPrice } from '../lib/format'
import { teamColor } from '../lib/teamColors'

export function PlayerRow({ player, onClick }: { player: PlayerEV; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 py-2.5 px-3 rounded-xl bg-surface active:bg-surface-raised"
    >
      <span
        className="w-2 self-stretch rounded-full shrink-0"
        style={{ backgroundColor: teamColor(player.team_short) }}
      />
      <div className="flex-1 text-left min-w-0">
        <p className="text-sm font-semibold truncate">{player.web_name}</p>
        <p className="text-[11px] text-white/50">
          {player.position} · {player.team_short} · {formatPrice(player.now_cost)}
        </p>
      </div>
      {player.status !== 'a' && <span className="w-2 h-2 rounded-full bg-danger shrink-0" />}
      <div className="text-right shrink-0">
        <p className="text-sm font-bold text-primary">{player.total_ev.toFixed(1)}</p>
        <p className="text-[10px] text-white/40">±{player.uncertainty.toFixed(1)}</p>
      </div>
    </button>
  )
}
