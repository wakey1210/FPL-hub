import type { PlayerEV } from '../types/fpl'
import { teamColor } from '../lib/teamColors'

interface Props {
  player: PlayerEV
  points: number
  badge?: 'C' | 'VC'
  onClick?: () => void
  highlighted?: boolean
}

/** A single "shirt" tile used in the pitch view: club-coloured jersey, name,
 * price and EV, with an optional captain/vice-captain badge - mirrors the
 * official app's Pick Team screen. `points` is passed in explicitly (rather
 * than read off `player` directly) so callers can choose next-gameweek vs.
 * multi-gameweek total depending on context - see PitchView. */
export function PlayerChip({ player, points, badge, onClick, highlighted }: Props) {
  return (
    <button
      onClick={onClick}
      className={`flex flex-col items-center gap-0.5 w-14 shrink-0 text-center transition-transform active:scale-95 ${
        highlighted ? 'scale-105' : ''
      }`}
    >
      <div className="relative">
        <div
          className={`w-9 h-9 rounded-md shadow-md flex items-center justify-center text-white text-[9px] font-bold ${
            highlighted ? 'ring-2 ring-primary ring-offset-2 ring-offset-emerald-700' : ''
          }`}
          style={{ backgroundColor: teamColor(player.team_short) }}
        >
          {player.team_short}
        </div>
        {badge && (
          <span
            className={`absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full text-[10px] font-bold flex items-center justify-center ${
              badge === 'C' ? 'bg-warning text-warning-foreground' : 'bg-carbone-200 text-carbone-900'
            }`}
          >
            {badge}
          </span>
        )}
        {player.status !== 'a' && (
          <span className="absolute -bottom-1 -right-1 w-3 h-3 rounded-full bg-danger border border-white" />
        )}
      </div>
      <span className="text-[10px] font-semibold text-white leading-tight truncate w-full">
        {player.web_name}
      </span>
      <span className="text-[9px] text-white/70 leading-tight">{points.toFixed(1)} pts</span>
    </button>
  )
}
