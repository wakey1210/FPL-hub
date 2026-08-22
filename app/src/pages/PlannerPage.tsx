import { useMemo } from 'react'
import { useJsonData } from '../lib/data'
import { Layout, LoadingState, ErrorState } from '../components/Layout'
import { fdrClasses } from '../lib/format'
import { PlanStepCard } from '../components/PlanStepCard'
import { StagedTransfersCart } from '../components/StagedTransfersCart'
import { ChipStrategyWidget } from '../components/ChipStrategyWidget'
import { ChipsUsedEditor } from '../components/ChipsUsedEditor'
import { usePlannedChanges } from '../lib/usePlannedChanges'
import { useDeclaredTeam } from '../lib/useDeclaredTeam'
import { planTransfers } from '../lib/transferPlanner'
import { squadAtEvent, bankAndFreeTransfersAtEvent, liveTeamAsDeclared } from '../lib/squadTimeline'
import { riskWindowsForGw } from '../lib/dgwBgwRisk'
import type { TeamTicker } from '../types/ticker'
import type { PlanStep, TransferPlan } from '../types/transferPlan'
import type { Meta, PlayerEV } from '../types/fpl'
import type { MyTeam } from '../types/myTeam'

export function PlannerPage() {
  const ticker = useJsonData<TeamTicker[]>('fixtures.json')
  const transferPlan = useJsonData<TransferPlan>('transfer_plan.json')
  const meta = useJsonData<Meta>('meta.json')
  const myTeam = useJsonData<MyTeam>('my_team.json')
  const players = useJsonData<PlayerEV[]>('players.json')
  const { plan, addStagedTransfer, removeStagedTransfer, clearStagedTransfers } = usePlannedChanges()
  const { declared, setChipUsed } = useDeclaredTeam()

  const hasLiveTeam = myTeam.data?.configured && myTeam.data.has_squad && myTeam.data.picks
  const effectiveTeam = hasLiveTeam ? liveTeamAsDeclared(myTeam.data!) : declared
  const currentEvent = meta.data?.next_gameweek ?? meta.data?.current_gameweek ?? null

  // Client-side rolling 5-week/chip plan from a declared squad - recomputes
  // whenever players.json refreshes, the staged-transfers cart changes, or
  // chips-used is updated, off the same 3-hourly hot loop. Picks up from
  // wherever the user's own manually-staged transfers (from Pick Team's
  // per-gameweek editor) leave off, rather than contradicting them - the
  // algorithm's own horizon starts the gameweek after the last one the user
  // has already manually decided.
  const declaredSteps = useMemo((): PlanStep[] => {
    if (hasLiveTeam || !declared.squadIds || !players.data || currentEvent === null) return []
    const byId = new Map(players.data.map((p) => [p.id, p]))
    const lastStagedEvent = plan.stagedTransfers.reduce((max, t) => Math.max(max, t.event), currentEvent - 1)
    const planStartEvent = Math.max(currentEvent, lastStagedEvent + 1)
    const squad = squadAtEvent(declared.squadIds, players.data, plan.stagedTransfers, planStartEvent - 1)
    if (squad.length === 0) return []
    const { bank, freeTransfers } = bankAndFreeTransfersAtEvent(declared, plan.stagedTransfers, planStartEvent - 1)
    return planTransfers(
      squad,
      players.data,
      bank,
      freeTransfers,
      declared.chipsUsed,
      planStartEvent,
      5,
      meta.data?.season_started ?? true
    ).map((s) => ({
      event: s.event,
      transfers_out: s.transfersOut,
      transfers_in: s.transfersIn,
      hit_cost: s.hitCost,
      chip_played: s.chipPlayed,
      projected_gain: s.projectedGain,
      free_transfers_after: s.freeTransfersAfter,
      bank_after: s.bankAfter,
      rationale: s.rationale,
      out: s.transfersOut.map((id) => byId.get(id)).filter((p): p is PlayerEV => !!p),
      in: s.transfersIn.map((id) => byId.get(id)).filter((p): p is PlayerEV => !!p),
    }))
  }, [hasLiveTeam, declared, players.data, currentEvent, plan.stagedTransfers, meta.data?.season_started])

  if (ticker.loading) return <Layout title="Planner"><LoadingState /></Layout>
  if (ticker.error || !ticker.data) return <Layout title="Planner"><ErrorState message={ticker.error ?? 'no data'} /></Layout>

  const gwCount = Math.max(...ticker.data.map((t) => t.fixtures.length), 0)
  const gwLabels = Array.from({ length: gwCount }, (_, i) => i + 1)
  const liveSteps = hasLiveTeam && transferPlan.data?.available ? transferPlan.data.steps ?? [] : []
  const activeSteps = hasLiveTeam ? liveSteps : declaredSteps
  const hasPlan = activeSteps.length > 0

  const isStaged = (outId: number, inId: number) =>
    plan.stagedTransfers.some((t) => t.outId === outId && t.inId === inId)

  const recommendedByChip: Record<string, number> = {}
  for (const step of activeSteps) {
    if (step.chip_played) recommendedByChip[step.chip_played] = step.event
  }

  return (
    <Layout title="Planner">
      {hasLiveTeam ? (
        <ChipStrategyWidget
          chipsUsed={myTeam.data!.chips_used ?? []}
          currentEvent={currentEvent}
          recommendedByChip={recommendedByChip}
        />
      ) : (
        <ChipsUsedEditor chipsUsed={declared.chipsUsed} onToggle={setChipUsed} />
      )}
      {hasPlan ? (
        <div className="mb-5">
          <p className="text-sm font-semibold mb-1">
            Your 5-week plan (GW{activeSteps[0].event}–{activeSteps[activeSteps.length - 1].event})
          </p>
          <p className="text-[11px] text-white/40 mb-2">
            {hasLiveTeam
              ? 'Suggested transfers and chip timing, factoring in your bank, free transfers and hit costs.'
              : 'Based on your declared squad - will switch to your live FPL team once synced.'}
          </p>
          <div className="space-y-2">
            {activeSteps.map((step) => (
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
                          costDelta: step.in[0].now_cost - step.out[0].now_cost,
                          event: step.event,
                        })
                    : undefined
                }
              />
            ))}
          </div>
        </div>
      ) : (
        <div className="mb-5 rounded-xl bg-surface p-4">
          <p className="text-sm text-white/60">
            {hasLiveTeam
              ? transferPlan.data?.reason ?? 'No 5-week plan available yet.'
              : 'Confirm your squad on the Pick Team tab to see a 5-week plan.'}
          </p>
        </div>
      )}

      <p className="text-xs text-white/50 mb-3">
        Fixture difficulty ticker, easiest run first. Use this to time transfers, wildcards and chips -
        the Ben Crellin sheet replacement. Green "2x" cells are confirmed double gameweeks, "BLANK"
        cells are confirmed blanks - both detected directly from already-fetched fixtures, not forecast.
      </p>
      <div className="overflow-x-auto -mx-4 px-4">
        <table className="w-full text-sm border-separate border-spacing-y-1.5 min-w-[420px]">
          <thead>
            <tr className="text-[11px] text-white/40">
              <th className="text-left font-medium pr-2">Team</th>
              {gwLabels.map((gw) => {
                const risk = riskWindowsForGw(gw)
                return (
                  <th key={gw} className="font-medium px-0.5" title={risk.map((r) => r.label).join(' · ')}>
                    GW{gw}
                    {risk.length > 0 && <span className="text-warning">*</span>}
                  </th>
                )
              })}
              <th className="font-medium pl-2">Avg</th>
            </tr>
          </thead>
          <tbody>
            {ticker.data.map((team) => (
              <tr key={team.team_short} className="bg-surface">
                <td className="rounded-l-lg pl-2 py-1.5 font-semibold text-xs whitespace-nowrap">
                  {team.team_short}
                  {team.unscheduled_count > 0 && (
                    <span
                      className="ml-1 text-warning"
                      title={`${team.unscheduled_count} fixture(s) postponed, pending reschedule`}
                    >
                      !
                    </span>
                  )}
                </td>
                {gwLabels.map((gw) => {
                  const fxs = team.fixtures.filter((f) => f.event === gw)
                  const isDouble = team.double_events.includes(gw)
                  const isBlank = team.blank_events.includes(gw)
                  return (
                    <td key={gw} className="px-0.5 py-1.5 text-center">
                      {isBlank ? (
                        <span className="inline-block w-full min-w-[38px] rounded text-[9px] font-bold py-1 bg-white/10 text-white/50">
                          BLANK
                        </span>
                      ) : fxs.length > 0 ? (
                        <div className="flex flex-col gap-0.5">
                          {fxs.map((fx, i) => (
                            <span
                              key={i}
                              className={`inline-block w-full min-w-[38px] rounded text-[10px] font-bold py-1 ${fdrClasses(fx.fdr)}`}
                            >
                              {fx.is_home ? fx.opponent_short : fx.opponent_short.toLowerCase()}
                            </span>
                          ))}
                          {isDouble && <span className="text-[8px] text-success font-bold">2x</span>}
                        </div>
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
      <p className="text-[10px] text-white/30 mt-3">
        Uppercase = home fixture, lowercase = away. <span className="text-warning">*</span> = a
        gameweek where double/blank gameweeks have historically landed in recent seasons (base-rate
        context only, not a forecast of which club is affected - hover for detail).
      </p>
      {plan.stagedTransfers.length > 0 && <div className="h-28" />}
      <StagedTransfersCart
        staged={plan.stagedTransfers}
        onRemove={(i) =>
          removeStagedTransfer(
            i,
            (event) => bankAndFreeTransfersAtEvent(effectiveTeam, plan.stagedTransfers, event - 1).freeTransfers
          )
        }
        onClear={clearStagedTransfers}
      />
    </Layout>
  )
}
