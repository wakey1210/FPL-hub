import { useJsonData } from '../lib/data'
import { Layout, LoadingState, ErrorState } from '../components/Layout'
import { fdrClasses } from '../lib/format'
import { PlanStepCard } from '../components/PlanStepCard'
import { StagedTransfersCart } from '../components/StagedTransfersCart'
import { ChipStrategyWidget } from '../components/ChipStrategyWidget'
import { usePlannedChanges } from '../lib/usePlannedChanges'
import type { TeamTicker } from '../types/ticker'
import type { TransferPlan } from '../types/transferPlan'
import type { Meta } from '../types/fpl'
import type { MyTeam } from '../types/myTeam'

export function PlannerPage() {
  const ticker = useJsonData<TeamTicker[]>('fixtures.json')
  const transferPlan = useJsonData<TransferPlan>('transfer_plan.json')
  const meta = useJsonData<Meta>('meta.json')
  const myTeam = useJsonData<MyTeam>('my_team.json')
  const { plan, addStagedTransfer, removeStagedTransfer, clearStagedTransfers } = usePlannedChanges()

  if (ticker.loading) return <Layout title="Planner"><LoadingState /></Layout>
  if (ticker.error || !ticker.data) return <Layout title="Planner"><ErrorState message={ticker.error ?? 'no data'} /></Layout>

  const gwCount = Math.max(...ticker.data.map((t) => t.fixtures.length), 0)
  const gwLabels = Array.from({ length: gwCount }, (_, i) => i + 1)
  const hasPlan = transferPlan.data?.available && (transferPlan.data.steps?.length ?? 0) > 0

  const isStaged = (outId: number, inId: number) =>
    plan.stagedTransfers.some((t) => t.outId === outId && t.inId === inId)

  const recommendedByChip: Record<string, number> = {}
  if (hasPlan) {
    for (const step of transferPlan.data!.steps!) {
      if (step.chip_played) recommendedByChip[step.chip_played] = step.event
    }
  }
  const currentEvent = meta.data?.next_gameweek ?? meta.data?.current_gameweek ?? null

  return (
    <Layout title="Planner">
      {myTeam.data?.configured && (
        <ChipStrategyWidget
          chipsUsed={myTeam.data.chips_used ?? []}
          currentEvent={currentEvent}
          recommendedByChip={recommendedByChip}
        />
      )}
      {hasPlan ? (
        <div className="mb-5">
          <p className="text-sm font-semibold mb-1">
            Your 5-week plan (GW{transferPlan.data!.horizon_start}–{transferPlan.data!.horizon_end})
          </p>
          <p className="text-[11px] text-white/40 mb-2">
            Suggested transfers and chip timing, factoring in your bank, free transfers and hit costs.
          </p>
          <div className="space-y-2">
            {transferPlan.data!.steps!.map((step) => (
              <PlanStepCard
                key={step.event}
                step={step}
                added={step.out[0] ? isStaged(step.out[0].id, step.in[0].id) : false}
                onAdd={
                  step.out[0]
                    ? () =>
                        addStagedTransfer({
                          outId: step.out[0].id,
                          inId: step.in[0].id,
                          outName: step.out[0].web_name,
                          inName: step.in[0].web_name,
                          hitCost: step.hit_cost,
                        })
                    : undefined
                }
              />
            ))}
          </div>
        </div>
      ) : (
        <div className="mb-5 rounded-xl bg-[#1e1e2a] p-4">
          <p className="text-sm text-white/60">
            {transferPlan.data?.reason ?? 'No 5-week plan available yet.'}
          </p>
        </div>
      )}

      <p className="text-xs text-white/50 mb-3">
        Fixture difficulty ticker, easiest run first. Use this to time transfers, wildcards and chips -
        the Ben Crellin sheet replacement.
      </p>
      <div className="overflow-x-auto -mx-4 px-4">
        <table className="w-full text-sm border-separate border-spacing-y-1.5 min-w-[420px]">
          <thead>
            <tr className="text-[11px] text-white/40">
              <th className="text-left font-medium pr-2">Team</th>
              {gwLabels.map((gw) => (
                <th key={gw} className="font-medium px-0.5">GW{gw}</th>
              ))}
              <th className="font-medium pl-2">Avg</th>
            </tr>
          </thead>
          <tbody>
            {ticker.data.map((team) => (
              <tr key={team.team_short} className="bg-[#1e1e2a]">
                <td className="rounded-l-lg pl-2 py-1.5 font-semibold text-xs whitespace-nowrap">
                  {team.team_short}
                </td>
                {gwLabels.map((gw) => {
                  const fx = team.fixtures.find((f) => f.event === gw)
                  return (
                    <td key={gw} className="px-0.5 py-1.5 text-center">
                      {fx ? (
                        <span
                          className={`inline-block w-full min-w-[38px] rounded text-[10px] font-bold py-1 ${fdrClasses(fx.fdr)}`}
                        >
                          {fx.is_home ? fx.opponent_short : fx.opponent_short.toLowerCase()}
                        </span>
                      ) : (
                        <span className="text-white/20 text-[10px]">-</span>
                      )}
                    </td>
                  )
                })}
                <td className="rounded-r-lg pr-2 pl-2 text-xs font-semibold text-white/70 text-right">
                  {team.avg_fdr?.toFixed(1) ?? '-'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[10px] text-white/30 mt-3">Uppercase = home fixture, lowercase = away.</p>
      {plan.stagedTransfers.length > 0 && <div className="h-28" />}
      <StagedTransfersCart
        staged={plan.stagedTransfers}
        onRemove={removeStagedTransfer}
        onClear={clearStagedTransfers}
      />
    </Layout>
  )
}
