import type { PlayerEV } from '../types/fpl'
import type { ChipUseRecord } from '../types/declaredTeam'
import { suggestTransfers, suggestMultipleTransfers, HIT_COST, type TransferSuggestionResult } from './transferSuggestions'
import { optimiseStartingXI } from './formation'
import { selectSquad } from './squadOptimiser'
import { CHIP_WINDOWS } from './chipStatus'

// Mirrors engine/planner.py exactly - a greedy week-by-week simulation,
// ported to run client-side against a locally-declared squad/bank/free-
// transfers/chips-used. See engine/planner.py for the authoritative
// version (including why it's greedy, not a joint MILP); this must stay in
// sync with it.
const MAX_FREE_TRANSFERS = 5
const MAX_FREE_BATCH_PER_WEEK = 5 // matches MAX_FREE_TRANSFERS - can't have more banked than the cap allows
const BANK_PREMIUM_MAX = 2.0
const BENCH_BOOST_MIN_EV = 8.0
const TRIPLE_CAPTAIN_MIN_UPLIFT = 1.5
// Hand-picked starting point, not derived from first principles - a real
// squad rebuild should clear a much higher bar than a single swap's flat -4
// hit, since it's a much bigger, harder-to-reverse commitment.
const WILDCARD_MIN_GAIN = HIT_COST * 4

export interface PlanStepResult {
  event: number
  transfersOut: number[]
  transfersIn: number[]
  hitCost: number
  chipPlayed: string | null
  projectedGain: number
  freeTransfersAfter: number
  bankAfter: number
  rationale: string
}

/** Sum of this player's fixture-by-fixture EV from `fromEvent` onward, not
 * the full multi-week total_ev - what matters for a decision made partway
 * through the plan is the EV still to come. */
function remainingEv(player: PlayerEV, fromEvent: number): number {
  return (
    Math.round(
      player.fixtures.filter((f) => f.event >= fromEvent).reduce((sum, f) => sum + f.points, 0) * 100
    ) / 100
  )
}

function withRemainingEv(player: PlayerEV, fromEvent: number): PlayerEV {
  return { ...player, total_ev: remainingEv(player, fromEvent) }
}

function chipWindowsRemaining(chipsUsed: ChipUseRecord[]): Record<string, [number, number][]> {
  const usedEvents: Record<string, number[]> = {}
  for (const c of chipsUsed) (usedEvents[c.name] ??= []).push(c.event)

  const remaining: Record<string, [number, number][]> = {}
  for (const [name, windows] of Object.entries(CHIP_WINDOWS)) {
    remaining[name] = windows.filter(
      ([start, stop]) => !(usedEvents[name] ?? []).some((ev) => ev >= start && ev <= stop)
    )
  }
  return remaining
}

function chipAvailable(remaining: Record<string, [number, number][]>, chip: string, event: number): boolean {
  return (remaining[chip] ?? []).some(([start, stop]) => event >= start && event <= stop)
}

/** One rationale line per swap in a (possibly multi-transfer) batch, leading
 * with the incoming player's own top "why" factor - same reasoning style as
 * the single-transfer case, just repeated per swap. `preTransferSquad` must
 * be a snapshot taken *before* any of this week's swaps were applied, so
 * outgoing players can still be looked up by id. `hitSuggestionInId` is the
 * hit-costing extra swap's `inId`, if any, so its line can note the hit. */
function describeBatch(
  preTransferSquad: PlayerEV[],
  allPlayers: PlayerEV[],
  batch: TransferSuggestionResult[],
  hitSuggestionInId: number | null
): string {
  const byId = new Map(preTransferSquad.map((p) => [p.id, p]))
  const lines: string[] = []
  for (const s of batch) {
    const outPlayer = byId.get(s.outId)
    const inPlayer = allPlayers.find((p) => p.id === s.inId)
    if (!outPlayer || !inPlayer) continue
    const whyPrefix = inPlayer.why[0] ? `${inPlayer.why[0]} — ` : ''
    const hitNote = s.inId === hitSuggestionInId ? `, -${HIT_COST} hit` : ''
    lines.push(`${whyPrefix}OUT ${outPlayer.web_name} → IN ${inPlayer.web_name} (+${s.evDelta.toFixed(1)} EV${hitNote})`)
  }
  return lines.join('; ')
}

/** Full budget-constrained squad rebuild via selectSquad - genuinely
 * unlimited transfers, not an annotated single swap. `squad`/`allPlayers`
 * must already be remaining-horizon-EV-adjusted by the caller. Returns null
 * if the confirmed gain doesn't clear `minGain` (pass `-Infinity` for an
 * unconditional pre-season rebuild). */
function tryWildcardRebuild(
  squad: PlayerEV[],
  allPlayers: PlayerEV[],
  bank: number,
  minGain: number
): { newSquad: PlayerEV[]; actualGain: number; rationale: string } | null {
  const budget = bank + squad.reduce((sum, p) => sum + p.now_cost, 0)
  const result = selectSquad(allPlayers, budget)
  const byId = new Map(allPlayers.map((p) => [p.id, p]))
  const newSquad = result.squadIds.map((id) => byId.get(id)!)

  const currentValue = squad.reduce((sum, p) => sum + p.total_ev, 0)
  const actualGain = Math.round((result.totalEv - currentValue) * 100) / 100
  if (actualGain <= minGain) return null

  const rationale =
    `Wildcard rebuild: +${actualGain.toFixed(1)} EV over the current squad's remaining-horizon ` +
    `value from a full reshuffle within budget.`
  return { newSquad, actualGain, rationale }
}

function simulateTransfers(
  squad: PlayerEV[],
  allPlayers: PlayerEV[],
  bank: number,
  freeTransfers: number,
  horizonEvents: number[],
  remainingChips: Record<string, [number, number][]> = {},
  wildcardUsedAtStart = false,
  forceRebuildFirstWeek = false
): { steps: PlanStepResult[]; finalSquad: PlayerEV[] } {
  let currentSquad = [...squad]
  let currentBank = bank
  let currentFt = freeTransfers
  let wildcardUsed = wildcardUsedAtStart
  const steps: PlanStepResult[] = []
  const horizon = horizonEvents.length

  horizonEvents.forEach((event, idx) => {
    const weeksRemaining = horizon - idx
    const bankPremium = BANK_PREMIUM_MAX * (weeksRemaining / horizon)

    const adjustedSquad = currentSquad.map((p) => withRemainingEv(p, event))
    const adjustedPool = allPlayers.map((p) => withRemainingEv(p, event))

    const step: PlanStepResult = {
      event,
      transfersOut: [],
      transfersIn: [],
      hitCost: 0,
      chipPlayed: null,
      projectedGain: 0,
      freeTransfersAfter: 0,
      bankAfter: 0,
      rationale: '',
    }

    // Pre-first-deadline: an unconditional full rebuild, no chip token
    // spent, no hit, free transfers untouched.
    const forceRebuild = forceRebuildFirstWeek && idx === 0
    const wildcardEligible = !wildcardUsed && chipAvailable(remainingChips, 'wildcard', event)

    const rebuildResult = forceRebuild
      ? tryWildcardRebuild(adjustedSquad, adjustedPool, currentBank, -Infinity)
      : wildcardEligible
        ? tryWildcardRebuild(adjustedSquad, adjustedPool, currentBank, WILDCARD_MIN_GAIN)
        : null

    if (rebuildResult) {
      const { newSquad, actualGain, rationale } = rebuildResult
      const oldIds = new Set(currentSquad.map((p) => p.id))
      const newIds = new Set(newSquad.map((p) => p.id))
      step.transfersOut = [...oldIds].filter((id) => !newIds.has(id))
      step.transfersIn = [...newIds].filter((id) => !oldIds.has(id))
      step.projectedGain = actualGain
      step.rationale = rationale
      currentBank =
        currentBank +
        currentSquad.reduce((sum, p) => sum + p.now_cost, 0) -
        newSquad.reduce((sum, p) => sum + p.now_cost, 0)
      currentSquad = newSquad
      if (!forceRebuild) {
        step.chipPlayed = 'wildcard'
        wildcardUsed = true
      }
      // free transfers untouched either way - a rebuild isn't a normal
      // transfer for banking purposes.
    } else {
      // Free batch: as many net-positive swaps as free transfers allow.
      const freeBatch = suggestMultipleTransfers(
        adjustedSquad,
        adjustedPool,
        currentBank,
        Math.min(currentFt, MAX_FREE_BATCH_PER_WEEK)
      )
      const thisWeekValue = Math.round(freeBatch.reduce((sum, s) => sum + s.evDelta, 0) * 100) / 100

      // Bounded one-week bank-vs-spend peek: is a bigger combined move
      // available next week if this week's free transfer(s) are banked
      // instead? Skipped on the final horizon week and when there's no free
      // transfer to bank. Deliberately one week deep, not backward
      // induction over the whole horizon.
      let bankedValue: number | null = null
      let bankedFt = currentFt
      if (weeksRemaining > 1 && currentFt >= 1 && freeBatch.length > 0) {
        bankedFt = Math.min(MAX_FREE_TRANSFERS, currentFt + 1)
        const nextEvent = horizonEvents[idx + 1]
        const nextSquad = currentSquad.map((p) => withRemainingEv(p, nextEvent))
        const nextPool = allPlayers.map((p) => withRemainingEv(p, nextEvent))
        const bankedBatch = suggestMultipleTransfers(
          nextSquad,
          nextPool,
          currentBank,
          Math.min(bankedFt, MAX_FREE_BATCH_PER_WEEK)
        )
        bankedValue = Math.round(bankedBatch.reduce((sum, s) => sum + s.evDelta, 0) * 100) / 100
      }

      if (bankedValue !== null && bankedValue > thisWeekValue) {
        step.rationale =
          `Banking this week: acting now nets +${thisWeekValue.toFixed(1)} EV vs ` +
          `+${bankedValue.toFixed(1)} EV available next week with ${bankedFt} free transfers ` +
          `pooled (using next week's fixture-adjusted projections).`
      } else {
        const preTransferSquad = currentSquad
        let appliedEv = 0
        const allApplied: TransferSuggestionResult[] = [...freeBatch]
        for (const s of freeBatch) {
          const inPlayerFull = allPlayers.find((p) => p.id === s.inId)!
          currentSquad = currentSquad.filter((p) => p.id !== s.outId).concat(inPlayerFull)
          currentBank -= s.costDelta
          currentFt = Math.max(0, currentFt - 1)
          step.transfersOut.push(s.outId)
          step.transfersIn.push(s.inId)
          appliedEv += s.evDelta
        }

        // One additional hit-costing swap beyond the free allocation,
        // evaluated against the post-batch squad - same threshold logic as
        // before, just relocated to run after the free batch.
        const postBatchSquad = currentSquad.map((p) => withRemainingEv(p, event))
        const postBatchIds = new Set(currentSquad.map((p) => p.id))
        const postBatchPool = adjustedPool.filter((p) => !postBatchIds.has(p.id))
        const hitCandidates = suggestTransfers(postBatchSquad, postBatchPool, currentBank, 1, 1)
        const hitBest = hitCandidates[0] ?? null
        let hitInId: number | null = null
        if (hitBest && hitBest.evDelta > HIT_COST + bankPremium) {
          const inPlayerFull = allPlayers.find((p) => p.id === hitBest.inId)!
          currentSquad = currentSquad.filter((p) => p.id !== hitBest.outId).concat(inPlayerFull)
          currentBank -= hitBest.costDelta
          step.transfersOut.push(hitBest.outId)
          step.transfersIn.push(hitBest.inId)
          step.hitCost = HIT_COST
          appliedEv += hitBest.evDelta
          allApplied.push(hitBest)
          hitInId = hitBest.inId
        }

        step.projectedGain = Math.round((appliedEv - step.hitCost) * 100) / 100
        step.rationale =
          step.transfersOut.length > 0
            ? describeBatch(preTransferSquad, allPlayers, allApplied, hitInId)
            : 'No beneficial swap found - hold.'
      }
    }

    currentFt = Math.min(MAX_FREE_TRANSFERS, currentFt + 1)
    step.freeTransfersAfter = currentFt
    step.bankAfter = currentBank
    steps.push(step)
  })

  return { steps, finalSquad: currentSquad }
}

/** Layers Bench Boost / Triple Captain calls onto an existing week-by-week
 * plan. Wildcard is evaluated inline inside `simulateTransfers` instead (a
 * successful rebuild changes the squad for every subsequent week, unlike
 * these two which only annotate a chip flag with no lasting effect). */
function applyChipCalls(
  steps: PlanStepResult[],
  squad: PlayerEV[],
  allPlayers: PlayerEV[],
  chipsUsed: ChipUseRecord[]
): void {
  const remaining = chipWindowsRemaining(chipsUsed)
  const byIdAll = new Map(allPlayers.map((p) => [p.id, p]))

  let currentSquad = [...squad]
  const weeklySquads: PlayerEV[][] = []
  for (const step of steps) {
    if (step.transfersOut.length > 0) {
      currentSquad = currentSquad
        .filter((p) => !step.transfersOut.includes(p.id))
        .concat(step.transfersIn.map((i) => byIdAll.get(i)!))
    }
    weeklySquads.push([...currentSquad])
  }

  let bestBb: [number, number] | null = null
  let bestTc: [number, number, string] | null = null

  steps.forEach((step, i) => {
    const event = step.event
    const weekSquad = weeklySquads[i]
    const adjustedSquad = weekSquad.map((p) => withRemainingEv(p, event))

    if (chipAvailable(remaining, 'bboost', event)) {
      const xi = optimiseStartingXI(adjustedSquad, (p) => remainingEv(p, event))
      const byId = new Map(adjustedSquad.map((p) => [p.id, p]))
      // Bench Boost only really counts THIS gameweek's points, not the whole
      // remaining horizon - use the single-event slice, not total_ev.
      const benchEvThisGw = xi.benchIds.reduce((sum, id) => {
        const player = byId.get(id)!
        const fx = player.fixtures.find((f) => f.event === event)
        return sum + (fx?.points ?? 0)
      }, 0)
      if (benchEvThisGw >= BENCH_BOOST_MIN_EV && (!bestBb || benchEvThisGw > bestBb[1])) {
        bestBb = [i, benchEvThisGw]
      }
    }

    if (chipAvailable(remaining, '3xc', event)) {
      const xi = optimiseStartingXI(adjustedSquad, (p) => remainingEv(p, event))
      const byId = new Map(adjustedSquad.map((p) => [p.id, p]))
      for (const pid of xi.startingIds) {
        const player = byId.get(pid)!
        const fx = player.fixtures.find((f) => f.event === event)
        const thisGw = fx?.points ?? 0
        const horizonAvg = player.total_ev / Math.max(player.fixtures.length, 1)
        if (horizonAvg > 0 && thisGw >= TRIPLE_CAPTAIN_MIN_UPLIFT * horizonAvg) {
          const uplift = thisGw - horizonAvg
          if (!bestTc || uplift > bestTc[1]) bestTc = [i, uplift, player.web_name]
        }
      }
    }

  })

  const candidates: [[number, number] | [number, number, string] | null, string, string][] = [
    [bestBb, 'bboost', 'Bench Boost'],
    [bestTc, '3xc', 'Triple Captain'],
  ]
  for (const [candidate, chipName, label] of candidates) {
    if (!candidate) continue
    const i = candidate[0]
    if (steps[i].chipPlayed !== null) continue
    steps[i].chipPlayed = chipName
    const gain = candidate[1]
    if (chipName === '3xc') {
      const playerName = (candidate as [number, number, string])[2]
      steps[i].rationale += ` | ${label} recommended on ${playerName} (+${gain.toFixed(1)} pts vs. their own average)`
    } else {
      steps[i].rationale += ` | ${label} recommended (bench/upgrade potential ~${gain.toFixed(1)} pts)`
    }
    steps[i].projectedGain = Math.round((steps[i].projectedGain + gain) * 100) / 100
  }
}

export function planTransfers(
  squad: PlayerEV[],
  allPlayers: PlayerEV[],
  bank: number,
  freeTransfers: number,
  chipsUsed: ChipUseRecord[],
  currentEvent: number,
  horizon = 5,
  seasonStarted = true
): PlanStepResult[] {
  // seasonStarted=false treats the very first simulated week as a free,
  // unconditional full-squad rebuild - real FPL lets you rebuild as many
  // times as you like before your first-ever deadline, at zero hit cost and
  // with no effect on free transfers, distinct from a genuine Wildcard
  // (which consumes a chip token and is gated by WILDCARD_MIN_GAIN).
  const horizonEvents = Array.from({ length: horizon }, (_, i) => currentEvent + i)
  const remainingChips = chipWindowsRemaining(chipsUsed)
  const { steps } = simulateTransfers(
    squad,
    allPlayers,
    bank,
    freeTransfers,
    horizonEvents,
    remainingChips,
    false,
    !seasonStarted
  )
  applyChipCalls(steps, squad, allPlayers, chipsUsed)
  return steps
}
