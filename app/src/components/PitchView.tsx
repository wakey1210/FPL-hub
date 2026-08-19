import type { PlayerEV, Position } from '../types/fpl'
import { PlayerChip } from './PlayerChip'

interface Props {
  squad: PlayerEV[]
  startingIds: number[]
  benchIds: number[]
  captainId: number
  viceCaptainId: number
  onSelectPlayer?: (player: PlayerEV) => void
  highlightId?: number | null
  /** Points shown on each card - defaults to next gameweek's, since that's
   * the decision being made when picking your XI/captain "now". A caller
   * viewing a different gameweek (Pick Team's GW navigation) passes
   * squadTimeline.ts's `pointsAtEvent` instead. */
  pointsForPlayer?: (player: PlayerEV) => number
}

const ROW_ORDER: Position[] = ['GKP', 'DEF', 'MID', 'FWD']

function nextGwPoints(player: PlayerEV): number {
  return player.fixtures[0]?.points ?? 0
}

export function PitchView({
  squad,
  startingIds,
  benchIds,
  captainId,
  viceCaptainId,
  onSelectPlayer,
  highlightId,
  pointsForPlayer = nextGwPoints,
}: Props) {
  const byId = new Map(squad.map((p) => [p.id, p]))
  const starting = startingIds.map((id) => byId.get(id)).filter((p): p is PlayerEV => !!p)
  const bench = benchIds.map((id) => byId.get(id)).filter((p): p is PlayerEV => !!p)

  const badgeFor = (id: number) => (id === captainId ? 'C' : id === viceCaptainId ? 'VC' : undefined)

  return (
    <div className="space-y-3">
      <div className="rounded-2xl bg-gradient-to-b from-emerald-600 to-emerald-700 p-2 pb-4 shadow-inner">
        <div className="flex flex-col gap-4">
          {ROW_ORDER.map((pos) => {
            const rowPlayers = starting.filter((p) => p.position === pos)
            if (rowPlayers.length === 0) return null
            return (
              <div key={pos} className="flex justify-center gap-1">
                {rowPlayers.map((p) => (
                  <PlayerChip
                    key={p.id}
                    player={p}
                    points={pointsForPlayer(p)}
                    badge={badgeFor(p.id)}
                    onClick={() => onSelectPlayer?.(p)}
                    highlighted={p.id === highlightId}
                  />
                ))}
              </div>
            )
          })}
        </div>
      </div>

      <div className="rounded-2xl bg-[#2b2b3a] p-3">
        <p className="text-[11px] uppercase tracking-wide text-white/50 mb-2 px-1">Bench</p>
        <div className="flex gap-3 overflow-x-auto pb-1">
          {bench.map((p) => (
            <PlayerChip
              key={p.id}
              player={p}
              points={pointsForPlayer(p)}
              onClick={() => onSelectPlayer?.(p)}
              highlighted={p.id === highlightId}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
