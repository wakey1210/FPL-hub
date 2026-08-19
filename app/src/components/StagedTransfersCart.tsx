import type { StagedTransfer } from '../types/plannedChanges'

interface Props {
  staged: StagedTransfer[]
  onRemove: (index: number) => void
  onClear: () => void
}

/** Persistent cart bar for transfers staged from suggestions/the planner/Pick
 * Team - this app can't submit transfers to FPL directly (no working login),
 * so "staging" means building a plan to go make on the official site.
 * Grouped by the gameweek each transfer takes effect from, since Pick Team's
 * GW navigation means that's no longer always "now". */
export function StagedTransfersCart({ staged, onRemove, onClear }: Props) {
  if (staged.length === 0) return null

  const totalHit = staged.reduce((sum, t) => sum + t.hitCost, 0)
  const events = [...new Set(staged.map((t) => t.event))].sort((a, b) => a - b)

  return (
    <div className="fixed bottom-[64px] inset-x-0 z-20 bg-surface border-t border-white/10 px-4 py-3">
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center justify-between mb-2">
          <p className="text-sm font-semibold">
            {staged.length} transfer{staged.length === 1 ? '' : 's'} staged
            {totalHit > 0 && <span className="text-danger"> · -{totalHit} hit</span>}
          </p>
          <button
            onClick={onClear}
            className="text-xs text-white/50 underline min-h-[36px] px-2 transition-colors active:text-white"
          >
            Clear
          </button>
        </div>
        <div className="space-y-1.5 max-h-28 overflow-y-auto">
          {events.map((event) => (
            <div key={event}>
              <p className="text-[10px] uppercase tracking-wide text-white/40 mb-0.5">GW{event}</p>
              {staged.map((t, i) =>
                t.event === event ? (
                  <div key={`${t.outId}-${t.inId}`} className="flex items-center justify-between text-xs text-white/70">
                    <span>
                      OUT {t.outName} → IN {t.inName}
                      {t.hitCost > 0 && <span className="text-danger"> (-{t.hitCost})</span>}
                    </span>
                    <button
                      onClick={() => onRemove(i)}
                      aria-label={`Remove ${t.outName} to ${t.inName} transfer`}
                      className="text-white/40 px-2 min-h-[36px] transition-colors active:text-white"
                    >
                      ×
                    </button>
                  </div>
                ) : null
              )}
            </div>
          ))}
        </div>
        <p className="text-[10px] text-white/40 mt-1">Apply these on the official FPL app before each deadline.</p>
      </div>
    </div>
  )
}
