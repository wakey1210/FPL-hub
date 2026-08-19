import { CHIP_LABELS, CHIP_ORDER, CHIP_WINDOWS } from '../lib/chipStatus'
import type { ChipName, ChipUseRecord } from '../types/declaredTeam'

interface Props {
  chipsUsed: ChipUseRecord[]
  onToggle: (name: ChipName, event: number, used: boolean) => void
}

/** Manual "which chips have I already used" checklist for a declared (not
 * live-synced) squad - the ported planner logic needs to know which of each
 * chip's two half-season windows are already spent, and there's no live
 * sync to read that from otherwise. Editable any time during the season,
 * not just when the squad is first confirmed. */
export function ChipsUsedEditor({ chipsUsed, onToggle }: Props) {
  return (
    <div className="rounded-xl bg-surface p-3 mb-5">
      <p className="text-sm font-semibold mb-1">Chips used</p>
      <p className="text-[11px] text-white/40 mb-2">
        Tick off chips you've already played on the official app, so the plan below knows what's left.
      </p>
      <div className="grid grid-cols-2 gap-2">
        {CHIP_ORDER.flatMap((name) =>
          (CHIP_WINDOWS[name] ?? []).map(([start, stop], halfIdx) => {
            const used = chipsUsed.some((c) => c.name === name && c.event >= start && c.event <= stop)
            return (
              <button
                key={`${name}-${halfIdx}`}
                onClick={() => onToggle(name as ChipName, start, !used)}
                className={`rounded-lg px-3 py-2 text-left transition-colors ${
                  used
                    ? 'bg-primary/15 text-primary border border-primary/40'
                    : 'bg-white/10 text-white/60'
                }`}
              >
                <p className="text-xs font-semibold">
                  {CHIP_LABELS[name]} ({halfIdx === 0 ? '1st' : '2nd'} half)
                </p>
                <p className="text-[11px]">
                  GW{start}-{stop} {used ? '· used' : ''}
                </p>
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}
