import type { PlayerEV } from '../types/fpl'
import { formatPrice } from '../lib/format'
import { teamColor } from '../lib/teamColors'

interface Props {
  squad: PlayerEV[]
  startingIds: number[]
  benchIds: number[]
  captainId: number
  viceCaptainId: number
  onSelectPlayer?: (player: PlayerEV) => void
  highlightId?: number | null
  /** Points shown in the left-hand column - defaults to next gameweek's. A
   * caller viewing a different gameweek (Pick Team's GW navigation) passes
   * squadTimeline.ts's `pointsAtEvent` plus a matching `pointsLabel`. */
  pointsForPlayer?: (player: PlayerEV) => number
  pointsLabel?: string
}

/** Table alternative to the pitch graphic - the shirt view can't fit a
 * multi-gameweek breakdown without crowding, so the more detailed next-GW
 * vs. N-GW-total comparison (more useful when weighing transfers than when
 * just picking a lineup) lives here instead. */
export function SquadListView({
  squad,
  startingIds,
  benchIds,
  captainId,
  viceCaptainId,
  onSelectPlayer,
  highlightId,
  pointsForPlayer = (p) => p.fixtures[0]?.points ?? 0,
  pointsLabel = 'next GW',
}: Props) {
  const byId = new Map(squad.map((p) => [p.id, p]))
  const starting = startingIds.map((id) => byId.get(id)).filter((p): p is PlayerEV => !!p)
  const bench = benchIds.map((id) => byId.get(id)).filter((p): p is PlayerEV => !!p)

  const row = (p: PlayerEV) => (
    <button
      key={p.id}
      onClick={() => onSelectPlayer?.(p)}
      className={`w-full flex items-center gap-2 py-2 px-3 text-left transition-colors active:bg-white/10 min-h-[44px] ${
        p.id === highlightId ? 'bg-[#00ff87]/10' : ''
      }`}
    >
      <span className="w-1.5 self-stretch rounded-full shrink-0" style={{ backgroundColor: teamColor(p.team_short) }} />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold truncate flex items-center gap-1.5">
          {p.web_name}
          {p.id === captainId && (
            <span className="text-[9px] font-bold bg-yellow-400 text-black rounded-full w-4 h-4 flex items-center justify-center">C</span>
          )}
          {p.id === viceCaptainId && (
            <span className="text-[9px] font-bold bg-slate-200 text-slate-800 rounded-full w-4 h-4 flex items-center justify-center">VC</span>
          )}
        </p>
        <p className="text-[10px] text-white/40">
          {p.position} · {formatPrice(p.now_cost)}
        </p>
      </div>
      <div className="text-right shrink-0 w-12">
        <p className="text-sm font-bold text-[#00ff87]">{pointsForPlayer(p).toFixed(1)}</p>
        <p className="text-[9px] text-white/40">{pointsLabel}</p>
      </div>
      <div className="text-right shrink-0 w-14">
        <p className="text-sm font-semibold text-white/80">{p.total_ev.toFixed(1)}</p>
        <p className="text-[9px] text-white/40">{p.fixtures.length}GW total</p>
      </div>
    </button>
  )

  return (
    <div className="rounded-2xl bg-[#1e1e2a] overflow-hidden divide-y divide-white/5">
      <p className="text-[11px] uppercase tracking-wide text-white/50 px-3 pt-2 pb-1">Starting XI</p>
      {starting.map(row)}
      <p className="text-[11px] uppercase tracking-wide text-white/50 px-3 pt-2 pb-1">Bench</p>
      {bench.map(row)}
    </div>
  )
}
