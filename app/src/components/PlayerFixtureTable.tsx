import { Fragment } from 'react'
import type { PlayerEV } from '../types/fpl'
import { formatPrice, fdrClasses } from '../lib/format'
import { teamColor } from '../lib/teamColors'

export interface FixtureTableRow {
  player: PlayerEV
  badge?: 'C' | 'VC'
}

interface Props {
  rows: FixtureTableRow[]
  /** First gameweek of the fixture window shown - Pick Team passes whichever
   * gameweek is currently being viewed, Transfers passes "now", so the
   * columns always read as "this player's next N fixtures from here". */
  fromEvent: number
  columns?: number
  onSelectPlayer?: (player: PlayerEV) => void
  highlightId?: number | null
  /** Renders a full-width divider row (e.g. "BENCH") before the row at this
   * index - lets one continuously-scrollable table span two squad sections. */
  dividerBeforeIndex?: number
  dividerLabel?: string
}

/** Player-name column is sticky (position: sticky; left: 0) so it stays
 * visible while the fixture columns scroll horizontally - the name is what
 * anchors every other number in the row. */
export function PlayerFixtureTable({
  rows,
  fromEvent,
  columns = 5,
  onSelectPlayer,
  highlightId,
  dividerBeforeIndex,
  dividerLabel,
}: Props) {
  const gwLabels = Array.from({ length: columns }, (_, i) => fromEvent + i)

  return (
    <div className="overflow-x-auto -mx-4 px-4 rounded-2xl">
      <table className="border-separate border-spacing-y-1 w-full">
        <thead>
          <tr className="text-[10px] text-white/40">
            <th className="sticky left-0 z-10 bg-background text-left font-medium pb-1 pr-2 min-w-[132px]">Player</th>
            {gwLabels.map((gw) => (
              <th key={gw} className="font-medium pb-1 px-1 min-w-[46px]">
                GW{gw}
              </th>
            ))}
            <th className="font-medium pb-1 pl-2 min-w-[44px]">Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const { player, badge } = row
            const rowFixtures = player.fixtures.filter((f) => f.event >= fromEvent && f.event < fromEvent + columns)
            const total = rowFixtures.reduce((sum, f) => sum + f.points, 0)
            const isHighlighted = player.id === highlightId
            return (
              <Fragment key={player.id}>
                {dividerBeforeIndex === i && (
                  <tr key={`divider-${player.id}`}>
                    <td colSpan={columns + 2} className="pt-2 pb-1 text-[10px] uppercase tracking-wide text-white/40">
                      {dividerLabel ?? 'Bench'}
                    </td>
                  </tr>
                )}
                <tr
                  key={player.id}
                  onClick={() => onSelectPlayer?.(player)}
                  className={`text-xs cursor-pointer ${isHighlighted ? 'bg-primary/10' : ''}`}
                >
                  <td
                    className={`sticky left-0 z-10 py-1.5 pr-2 ${isHighlighted ? 'bg-primary/10' : 'bg-surface'} rounded-l-lg`}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className="w-1.5 self-stretch rounded-full shrink-0"
                        style={{ backgroundColor: teamColor(player.team_short) }}
                      />
                      <div className="min-w-0">
                        <p className="font-semibold truncate flex items-center gap-1.5">
                          {player.web_name}
                          {badge && (
                            <span
                              className={`text-[9px] font-bold rounded-full w-4 h-4 flex items-center justify-center shrink-0 ${
                                badge === 'C' ? 'bg-warning text-warning-foreground' : 'bg-carbone-200 text-carbone-900'
                              }`}
                            >
                              {badge}
                            </span>
                          )}
                        </p>
                        <p className="text-[10px] text-white/40">
                          {player.position} · {formatPrice(player.now_cost)}
                        </p>
                      </div>
                    </div>
                  </td>
                  {gwLabels.map((gw) => {
                    const fx = player.fixtures.find((f) => f.event === gw)
                    return (
                      <td key={gw} className={`text-center py-1.5 px-1 ${isHighlighted ? 'bg-primary/10' : 'bg-surface'}`}>
                        {fx ? (
                          <div className="flex flex-col items-center gap-0.5">
                            <span className={`inline-block w-full min-w-[36px] rounded text-[9px] font-bold py-0.5 ${fdrClasses(fx.fdr)}`}>
                              {fx.is_home ? fx.opponent_short : fx.opponent_short.toLowerCase()}
                            </span>
                            <span className="text-[10px] text-white/70">{fx.points.toFixed(1)}</span>
                          </div>
                        ) : (
                          <span className="text-white/20 text-[10px]">-</span>
                        )}
                      </td>
                    )
                  })}
                  <td
                    className={`text-right py-1.5 pl-2 pr-2 font-semibold text-primary rounded-r-lg ${isHighlighted ? 'bg-primary/10' : 'bg-surface'}`}
                  >
                    {total.toFixed(1)}
                  </td>
                </tr>
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
