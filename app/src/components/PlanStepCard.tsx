import type { PlanStep } from '../types/transferPlan'
import { teamColor } from '../lib/teamColors'

const CHIP_LABELS: Record<string, string> = {
  wildcard: 'Wildcard',
  freehit: 'Free Hit',
  bboost: 'Bench Boost',
  '3xc': 'Triple Captain',
}

interface Props {
  step: PlanStep
  onAdd?: () => void
  added?: boolean
}

export function PlanStepCard({ step, onAdd, added }: Props) {
  const hasTransfer = step.out.length > 0 && step.in.length > 0
  // Defaults with `?? []` even though the TS type marks this non-optional:
  // the frontend deploy and the data-refresh pipeline run on independent
  // schedules (deploy-pages.yml fires on every push to main, data refreshes
  // separately via pipeline.yml), so there's a real window right after
  // shipping a new PlanStep field where the live site's code expects it but
  // the currently-deployed transfer_plan.json snapshot predates it - same
  // class of bug as SeasonStatsTab's earlier stale-players.json crash, and
  // this app still has no error boundary, so an undefined field here blanks
  // the whole Planner tab.
  const swapRationale = step.swap_rationale ?? []

  return (
    <div className="rounded-xl bg-surface p-3">
      <div className="flex items-center justify-between mb-1.5">
        <p className="text-xs font-bold text-white/70">GW{step.event}</p>
        {step.chip_played && (
          <span className="text-[10px] font-bold bg-primary text-primary-foreground px-2 py-0.5 rounded-full">
            {CHIP_LABELS[step.chip_played] ?? step.chip_played}
          </span>
        )}
      </div>

      {hasTransfer ? (
        <div className="space-y-2 mb-2">
          {step.out.map((outP, i) => {
            const inP = step.in[i]
            const swapWhy = swapRationale[i]
            return (
              <div key={outP.id} className="space-y-0.5">
                <div className="flex items-center gap-2 text-sm">
                  <span className="w-2 h-6 rounded-full shrink-0" style={{ backgroundColor: teamColor(outP.team_short) }} />
                  <span>
                    OUT {outP.web_name} → IN {inP?.web_name}
                  </span>
                </div>
                {swapWhy && swapWhy.length > 0 && (
                  <ul className="pl-4 space-y-0.5">
                    {swapWhy.map((line, j) => (
                      <li key={j} className="text-[11px] text-white/60 leading-snug">
                        {line}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )
          })}
        </div>
      ) : (
        <p className="text-sm text-white/50 mb-2">No transfer this week</p>
      )}

      {(!hasTransfer || swapRationale.length === 0) && (
        <p className="text-[11px] text-white/50 mb-2">{step.rationale}</p>
      )}

      <div className="flex items-center justify-between">
        <p className={`text-sm font-bold ${step.projected_gain > 0 ? 'text-success' : 'text-white/40'}`}>
          {step.projected_gain > 0 ? '+' : ''}
          {step.projected_gain.toFixed(1)} pts
          {step.hit_cost > 0 && <span className="text-danger"> (-{step.hit_cost} hit)</span>}
        </p>
        <p className="text-[11px] text-white/40">
          {step.free_transfers_after} FT · £{(step.bank_after / 10).toFixed(1)}m bank
        </p>
      </div>

      {hasTransfer && onAdd && (
        <button
          onClick={onAdd}
          disabled={added}
          className={`w-full mt-2 min-h-[44px] rounded-lg text-sm font-semibold transition-colors active:opacity-80 ${
            added ? 'bg-white/10 text-white/50' : 'bg-primary text-primary-foreground'
          }`}
        >
          {added ? 'Added to plan' : 'Add to plan'}
        </button>
      )}
    </div>
  )
}
