import type { PlayerEV } from '../../types/fpl'

interface Props {
  player: PlayerEV
}

/** The EV / chance-of-playing / chance-of-60'+ tile row - a pure extraction
 * from the original PlayerDetailSheet, behavior and content unchanged. */
export function PlayerStatRow({ player }: Props) {
  return (
    <>
      <div className="flex gap-2 mb-4">
        <div className="flex-1 bg-white/5 rounded-lg p-3 text-center">
          <p className="text-2xl font-bold text-primary">{player.total_ev.toFixed(1)}</p>
          <p className="text-[11px] text-white/50">EV next {player.fixtures.length} GWs (±{player.uncertainty.toFixed(1)})</p>
        </div>
        <div className="flex-1 bg-white/5 rounded-lg p-3 text-center">
          <p className="text-2xl font-bold text-white">{Math.round(player.p_appearance * 100)}%</p>
          <p className="text-[11px] text-white/50">Chance of playing</p>
        </div>
        <div className="flex-1 bg-white/5 rounded-lg p-3 text-center">
          <p className="text-2xl font-bold text-white">{Math.round(player.p_60_plus * 100)}%</p>
          <p className="text-[11px] text-white/50">Chance of 60'+</p>
        </div>
      </div>
      <p className="text-[11px] text-white/40 -mt-2 mb-4">
        ~{player.expected_minutes_if_appears.toFixed(0)} minutes when they do play
      </p>
    </>
  )
}
