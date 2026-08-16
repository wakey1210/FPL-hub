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

export interface SquadResult {
  squadIds: number[]
  totalCost: number
  totalEv: number
}

function score(p: PlayerEV): number {
  return p.total_ev - RISK_AVERSION * p.uncertainty
}

const UNAVAILABLE_STATUSES = new Set(['i', 's', 'u'])

export function selectSquad(
  players: PlayerEV[],
  budget: number = BUDGET_TENTHS,
  maxPerClub: number = MAX_PER_CLUB,
  excludeUnavailable = true
): SquadResult {
  const candidates = players.filter((p) => !excludeUnavailable || !UNAVAILABLE_STATUSES.has(p.status))
  const clubs = Array.from(new Set(candidates.map((p) => p.team_short)))

  const constraints: Record<string, { max?: number; min?: number; equal?: number }> = {
    budget: { max: budget },
    total_players: { equal: 15 },
  }
  for (const pos of Object.keys(SQUAD_QUOTAS) as Position[]) {
    constraints[`quota_${pos}`] = { equal: SQUAD_QUOTAS[pos] }
  }
  for (const club of clubs) {
    constraints[`club_${club}`] = { max: maxPerClub }
  }

  const variables: Record<string, Record<string, number>> = {}
  const binaries: Record<string, 1> = {}
  for (const p of candidates) {
    const key = String(p.id)
    variables[key] = {
      score: score(p),
      budget: p.now_cost,
      total_players: 1,
      [`quota_${p.position}`]: 1,
      [`club_${p.team_short}`]: 1,
    }
    binaries[key] = 1
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

  const byId = new Map(candidates.map((p) => [p.id, p]))
  const squadIds = candidates
    .filter((p) => Math.round(Number(result[String(p.id)] ?? 0)) === 1)
    .map((p) => p.id)
  const totalCost = squadIds.reduce((sum, id) => sum + byId.get(id)!.now_cost, 0)
  const totalEv = Math.round(squadIds.reduce((sum, id) => sum + byId.get(id)!.total_ev, 0) * 100) / 100

  return { squadIds, totalCost, totalEv }
}
