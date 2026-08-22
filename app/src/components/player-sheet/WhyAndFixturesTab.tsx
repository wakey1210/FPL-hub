import type { PlayerEV } from '../../types/fpl'
import { fdrClasses } from '../../lib/format'

interface Props {
  player: PlayerEV
}

/** The "why this rating" bullets + fixture-by-fixture list - the deliberate
 * anti-black-box differentiator from competitor AI-picker apps (see the
 * module comment on the orchestrator, PlayerDetailSheet.tsx). Content and
 * order are unchanged from the pre-redesign sheet; this is a pure
 * extraction, not a rewrite - keeping it as the default, prominent tab is
 * intentional. */
export function WhyAndFixturesTab({ player }: Props) {
  return (
    <>
      <h3 className="text-sm font-semibold text-white/80 mb-2">Why this rating</h3>
      <ul className="space-y-1.5 mb-4">
        {player.why.map((reason, i) => (
          <li key={i} className="text-sm text-white/80 flex gap-2">
            <span className="text-primary">●</span>
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
    </>
  )
}
