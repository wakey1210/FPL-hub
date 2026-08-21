import solver from 'javascript-lp-solver'
import type { PlayerEV, Position } from '../types/fpl'

// Exact TS port of engine/optimise.py's select_squad - same objective, same
// budget/position-quota/per-club constraints - using javascript-lp-solver (a
// pure-JS branch-and-cut MILP solver) in place of PuLP/CBC, so the
// client-side planner's Wildcard/pre-first-deadline full rebuild gets true
// parity with the server path rather than a heuristic approximation.
export const SQUAD_QUOTAS: Record<Position, number> = { GKP: 2, DEF: 5, MID: 5, FWD: 3 }
export const BUDGET_TENTHS = 1000 // £100.0m, in FPL's tenths-of-a-million units
export const MAX_PER_CLUB = 3
export const RISK_AVERSION = 0.1 // objective = EV - RISK_AVERSION * uncertainty
export const PLAY_MIN_MAX: Record<Position, [number, number]> = {
  GKP: [1, 1],
  DEF: [3, 5],
  MID: [2, 5],
  FWD: [1, 3],
}
export const STARTING_XI_SIZE = 11
// Bench points only ever count via a rare auto-sub - see engine/optimise.py's
// module docstring for the full rationale and tuning status.
export const BENCH_WEIGHT = 0.15

export interface SquadResult {
  squadIds: number[]
  totalCost: number
  totalEv: number
  startingIds: number[]
  benchIds: number[]
  captainId: number
  viceCaptainId: number
}

function score(p: PlayerEV): number {
  return p.total_ev - RISK_AVERSION * p.uncertainty
}

const UNAVAILABLE_STATUSES = new Set(['i', 's', 'u'])

function orderBenchAndPickCaptains(
  startingIds: number[],
  benchIds: number[],
  byId: Map<number, PlayerEV>
): { orderedBench: number[]; captainId: number; viceCaptainId: number } {
  const orderedBench = [...benchIds].sort((a, b) => {
    const aGk = byId.get(a)!.position === 'GKP'
    const bGk = byId.get(b)!.position === 'GKP'
    if (aGk !== bGk) return aGk ? 1 : -1
    return score(byId.get(b)!) - score(byId.get(a)!)
  })
  const startersByScore = [...startingIds].sort((a, b) => score(byId.get(b)!) - score(byId.get(a)!))
  return { orderedBench, captainId: startersByScore[0], viceCaptainId: startersByScore[1] }
}

// select_squad jointly picks the 15-man squad *and* which 11 start - a
// bench player only scores via rare auto-subs, so weighting its EV the same
// as a starter's would misdirect budget toward players who mostly won't
// play. Decomposed algebraically for javascript-lp-solver's one-coefficient-
// per-variable model: a `pick_${id}` variable contributes `BENCH_WEIGHT *
// score`, a `start_${id}` variable contributes `(1 - BENCH_WEIGHT) * score`,
// coupled by a `pick - start >= 0` constraint per player - when start=1
// (implies pick=1) the two terms sum to the full score; when only pick=1
// (bench), just BENCH_WEIGHT of it. Exactly reproduces
// engine/optimise.py::select_squad's `score*start + BENCH_WEIGHT*score*(pick-start)`.
export function selectSquad(
  players: PlayerEV[],
  budget: number = BUDGET_TENTHS,
  maxPerClub: number = MAX_PER_CLUB,
  excludeUnavailable = true
): SquadResult {
  const candidates = players.filter((p) => !excludeUnavailable || !UNAVAILABLE_STATUSES.has(p.status))
  const clubs = Array.from(new Set(candidates.map((p) => p.team_short)))
  const byId = new Map(candidates.map((p) => [p.id, p]))

  const constraints: Record<string, { max?: number; min?: number; equal?: number }> = {
    budget: { max: budget },
    total_players: { equal: 15 },
    total_starting: { equal: STARTING_XI_SIZE },
  }
  for (const pos of Object.keys(SQUAD_QUOTAS) as Position[]) {
    constraints[`quota_${pos}`] = { equal: SQUAD_QUOTAS[pos] }
    const [minPlay, maxPlay] = PLAY_MIN_MAX[pos]
    constraints[`startpos_${pos}`] = { min: minPlay, max: maxPlay }
  }
  for (const club of clubs) {
    constraints[`club_${club}`] = { max: maxPerClub }
  }

  const variables: Record<string, Record<string, number>> = {}
  const binaries: Record<string, 1> = {}
  for (const p of candidates) {
    const s = score(p)
    const coupleKey = `couple_${p.id}`
    constraints[coupleKey] = { min: 0 }

    variables[`pick_${p.id}`] = {
      score: BENCH_WEIGHT * s,
      budget: p.now_cost,
      total_players: 1,
      [`quota_${p.position}`]: 1,
      [`club_${p.team_short}`]: 1,
      [coupleKey]: 1,
    }
    variables[`start_${p.id}`] = {
      score: (1 - BENCH_WEIGHT) * s,
      total_starting: 1,
      [`startpos_${p.position}`]: 1,
      [coupleKey]: -1,
    }
    binaries[`pick_${p.id}`] = 1
    binaries[`start_${p.id}`] = 1
  }

  const result = solver.Solve({
    optimize: 'score',
    opType: 'max',
    constraints,
    variables,
    binaries,
  }) as Record<string, number | boolean>

  if (!result.feasible) {
    throw new Error('Squad optimisation failed: infeasible')
  }

  const squadIds = candidates
    .filter((p) => Math.round(Number(result[`pick_${p.id}`] ?? 0)) === 1)
    .map((p) => p.id)
  const startingIds = candidates
    .filter((p) => Math.round(Number(result[`start_${p.id}`] ?? 0)) === 1)
    .map((p) => p.id)
  const benchIds = squadIds.filter((id) => !startingIds.includes(id))
  const { orderedBench, captainId, viceCaptainId } = orderBenchAndPickCaptains(startingIds, benchIds, byId)

  const totalCost = squadIds.reduce((sum, id) => sum + byId.get(id)!.now_cost, 0)
  const totalEv = Math.round(squadIds.reduce((sum, id) => sum + byId.get(id)!.total_ev, 0) * 100) / 100

  return {
    squadIds,
    totalCost,
    totalEv,
    startingIds,
    benchIds: orderedBench,
    captainId,
    viceCaptainId,
  }
}
