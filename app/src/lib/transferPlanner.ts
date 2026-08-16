import type { PlayerEV } from '../types/fpl'
import type { ChipUseRecord } from '../types/declaredTeam'
import { suggestTransfers, HIT_COST } from './transferSuggestions'
import { optimiseStartingXI } from './formation'
import { CHIP_WINDOWS } from './chipStatus'

// Mirrors engine/planner.py exactly - a greedy week-by-week simulation,
// ported to run client-side against a locally-declared squad/bank/free-
// transfers/chips-used. See engine/planner.py for the authoritative
// version (including why it's greedy, not a joint MILP); this must stay in
// sync with it.
const MAX_FREE_TRANSFERS = 5
const BANK_PREMIUM_MAX = 2.0
const BENCH_BOOST_MIN_EV = 8.0
const TRIPLE_CAPTAIN_MIN_UPLIFT = 1.5

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

function simulateTransfers(
  squad: PlayerEV[],
  allPlayers: PlayerEV[],
  bank: number,
  freeTransfers: number,
  horizonEvents: number[]
): PlanStepResult[] {
  let currentSquad = [...squad]
  let currentBank = bank
  let currentFt = freeTransfers
  const steps: PlanStepResult[] = []
  const horizon = horizonEvents.length

  horizonEvents.forEach((event, idx) => {
    const weeksRemaining = horizon - idx
    const bankPremium = BANK_PREMIUM_MAX * (weeksRemaining / horizon)

    const adjustedSquad = currentSquad.map((p) => withRemainingEv(p, event))
    const adjustedPool = allPlayers.map((p) => withRemainingEv(p, event))

    // free_transfers=1 disables suggestTransfers' own hit penalty so it just
    // ranks swaps by raw evDelta - the hit/bank decision below is this
    // planner's own, so it can factor in the decaying bank premium.
    const candidates = suggestTransfers(adjustedSquad, adjustedPool, currentBank, 1, 1)
    const best = candidates[0] ?? null

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

    if (best && best.evDelta > 0) {
      let take = false
      if (currentFt >= 1) {
        take = true
        step.hitCost = 0
      } else if (best.evDelta > HIT_COST + bankPremium) {
        take = true
        step.hitCost = HIT_COST
      }

      if (take) {
        const outPlayer = currentSquad.find((p) => p.id === best.outId)!
        const inPlayerFull = allPlayers.find((p) => p.id === best.inId)!
        currentSquad = currentSquad.filter((p) => p.id !== best.outId).concat(inPlayerFull)
        currentBank = currentBank - best.costDelta
        currentFt = Math.max(0, currentFt - 1)
        step.transfersOut = [best.outId]
        step.transfersIn = [best.inId]
        step.projectedGain = Math.round((best.evDelta - step.hitCost) * 100) / 100
        const hitNote = step.hitCost ? ` (takes a -${HIT_COST} hit)` : ' (free transfer)'
        // Lead with the incoming player's own top "why" factor, same as
        // engine/planner.py's enriched rationale.
        const whyPrefix = inPlayerFull.why[0] ? `${inPlayerFull.why[0]} — ` : ''
        step.rationale =
          `${whyPrefix}OUT ${outPlayer.web_name} → IN ${inPlayerFull.web_name}: ` +
          `+${best.evDelta.toFixed(1)} EV over the rest of the plan${hitNote}`
      } else if (best.evDelta > 0) {
        step.rationale =
          `Best available swap (+${best.evDelta.toFixed(1)} EV) doesn't clear the hit ` +
          `threshold yet (${(HIT_COST + bankPremium).toFixed(1)} pts needed with ` +
          `${weeksRemaining} planning week(s) left) - banking the free transfer instead.`
      }
    } else {
      step.rationale = 'No beneficial swap found - hold.'
    }

    currentFt = Math.min(MAX_FREE_TRANSFERS, currentFt + 1)
    step.freeTransfersAfter = currentFt
    step.bankAfter = currentBank
    steps.push(step)
  })

  return steps
}

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
  let bestWc: [number, number] | null = null

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

    if (chipAvailable(remaining, 'wildcard', event)) {
      const weekSquadIds = new Set(weekSquad.map((p) => p.id))
      const byPosition: Record<string, PlayerEV[]> = {}
      for (const p of allPlayers) {
        if (!weekSquadIds.has(p.id)) (byPosition[p.position] ??= []).push(p)
      }
      let totalPositiveDelta = 0
      for (const owned of adjustedSquad) {
        const pool = byPosition[owned.position] ?? []
        const bestAlt = Math.max(0, ...pool.map((p) => remainingEv(p, event)))
        if (bestAlt > owned.total_ev) totalPositiveDelta += bestAlt - owned.total_ev
      }
      if (totalPositiveDelta > HIT_COST * 2 && (!bestWc || totalPositiveDelta > bestWc[1])) {
        bestWc = [i, totalPositiveDelta]
      }
    }
  })

  const candidates: [[number, number] | [number, number, string] | null, string, string][] = [
    [bestWc, 'wildcard', 'Wildcard'],
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
  horizon = 5
): PlanStepResult[] {
  const horizonEvents = Array.from({ length: horizon }, (_, i) => currentEvent + i)
  const steps = simulateTransfers(squad, allPlayers, bank, freeTransfers, horizonEvents)
  applyChipCalls(steps, squad, allPlayers, chipsUsed)
  return steps
}
