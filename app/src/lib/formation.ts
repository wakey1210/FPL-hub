import type { PlayerEV, Position } from '../types/fpl'

// Mirrors engine/optimise.py's PLAY_MIN_MAX - the real FPL starting-XI rules.
export const PLAY_MIN_MAX: Record<Position, [number, number]> = {
  GKP: [1, 1],
  DEF: [3, 5],
  MID: [2, 5],
  FWD: [1, 3],
}
export const STARTING_XI_SIZE = 11

const POSITION_LABELS: Record<Position, string> = {
  GKP: 'goalkeeper',
  DEF: 'defender',
  MID: 'midfielder',
  FWD: 'forward',
}

export interface SwapResult {
  success: boolean
  error?: string
  startingIds?: number[]
  benchIds?: number[]
}

function countByPosition(ids: number[], byId: Map<number, PlayerEV>): Record<Position, number> {
  const counts: Record<Position, number> = { GKP: 0, DEF: 0, MID: 0, FWD: 0 }
  for (const id of ids) {
    const p = byId.get(id)
    if (p) counts[p.position] += 1
  }
  return counts
}

/** Attempts to swap two players between the starting XI and bench (in
 * either direction), validating the resulting formation exactly like the
 * real game does - GKP must be exactly 1, DEF 3-5, MID 2-5, FWD 1-3. Tries
 * the swap first and reports a clear error if it's invalid, rather than
 * pre-emptively graying out targets - simpler to reason about and matches
 * how the official-feeling reference apps handle it. */
export function attemptSwap(
  idA: number,
  idB: number,
  squad: PlayerEV[],
  startingIds: number[],
  benchIds: number[]
): SwapResult {
  if (idA === idB) return { success: false, error: 'Pick a different player to swap with.' }

  const byId = new Map(squad.map((p) => [p.id, p]))
  const aStarting = startingIds.includes(idA)
  const bStarting = startingIds.includes(idB)

  if (aStarting === bStarting) {
    return {
      success: false,
      error: aStarting
        ? 'Both players are already in your starting XI - pick a bench player to swap in instead.'
        : 'Both players are on your bench - pick a starting player to swap out instead.',
    }
  }

  const outgoing = aStarting ? idA : idB // currently starting, moving to bench
  const incoming = aStarting ? idB : idA // currently on bench, moving into the XI

  const newStartingIds = startingIds.filter((id) => id !== outgoing).concat(incoming)
  const newBenchIds = benchIds.filter((id) => id !== incoming).concat(outgoing)

  const counts = countByPosition(newStartingIds, byId)
  for (const pos of Object.keys(PLAY_MIN_MAX) as Position[]) {
    const [min, max] = PLAY_MIN_MAX[pos]
    if (counts[pos] < min || counts[pos] > max) {
      const incomingPlayer = byId.get(incoming)
      const outgoingPlayer = byId.get(outgoing)
      return {
        success: false,
        error:
          `That swap would leave ${counts[pos]} ${POSITION_LABELS[pos]}${counts[pos] === 1 ? '' : 's'} ` +
          `in your starting XI (needs ${min === max ? min : `${min}-${max}`}) - ` +
          `${outgoingPlayer?.web_name ?? 'that player'} and ${incomingPlayer?.web_name ?? 'that player'} aren't a valid swap.`,
      }
    }
  }

  return { success: true, startingIds: newStartingIds, benchIds: newBenchIds }
}

export interface OptimisedLineup {
  startingIds: number[]
  benchIds: number[]
  captainId: number
  viceCaptainId: number
}

/** Next gameweek's points, not the multi-gameweek total - matches PitchView:
 * picking a lineup/captain is a decision about the upcoming deadline, so
 * that's the number "highest possible scoring gameweek" actually means.
 * The 6-week total is for transfer decisions (TransfersPage/PlanStepCard),
 * not this. */
function nextGwPoints(player: PlayerEV): number {
  return player.fixtures[0]?.points ?? 0
}

/** Picks the valid starting XI (from a fixed 15-man squad - no budget
 * involved, just formation counts) that maximises next-gameweek points -
 * exact, not heuristic: GKP always contributes exactly 1 (pick the better
 * of the 2 owned), then every valid (DEF, MID, FWD) count combination
 * summing to 10 is enumerated (at most a few dozen), and the combination
 * with the highest next-GW total wins. Captain/vice are the two highest
 * next-GW scorers among the chosen XI. */
export function optimiseStartingXI(squad: PlayerEV[]): OptimisedLineup {
  const byPosition: Record<Position, PlayerEV[]> = { GKP: [], DEF: [], MID: [], FWD: [] }
  for (const p of squad) byPosition[p.position].push(p)
  for (const pos of Object.keys(byPosition) as Position[]) {
    byPosition[pos].sort((a, b) => nextGwPoints(b) - nextGwPoints(a))
  }

  const topN = (pos: Position, n: number) => byPosition[pos].slice(0, n)
  const sumPoints = (players: PlayerEV[]) => players.reduce((s, p) => s + nextGwPoints(p), 0)

  const gk = topN('GKP', 1)
  const [defMin, defMax] = PLAY_MIN_MAX.DEF
  const [midMin, midMax] = PLAY_MIN_MAX.MID
  const [fwdMin, fwdMax] = PLAY_MIN_MAX.FWD

  let best: { def: number; mid: number; fwd: number; total: number } | null = null
  for (let def = defMin; def <= defMax; def++) {
    for (let mid = midMin; mid <= midMax; mid++) {
      for (let fwd = fwdMin; fwd <= fwdMax; fwd++) {
        if (def + mid + fwd !== STARTING_XI_SIZE - 1) continue
        if (def > byPosition.DEF.length || mid > byPosition.MID.length || fwd > byPosition.FWD.length) continue
        const total = sumPoints(topN('DEF', def)) + sumPoints(topN('MID', mid)) + sumPoints(topN('FWD', fwd))
        if (!best || total > best.total) best = { def, mid, fwd, total }
      }
    }
  }
  if (!best) throw new Error('No valid formation found for this squad')

  const startingPlayers = [
    ...gk,
    ...topN('DEF', best.def),
    ...topN('MID', best.mid),
    ...topN('FWD', best.fwd),
  ]
  const startingIds = startingPlayers.map((p) => p.id)
  const benchIds = squad
    .filter((p) => !startingIds.includes(p.id))
    .sort((a, b) => nextGwPoints(b) - nextGwPoints(a))
    .map((p) => p.id)

  const byScore = [...startingPlayers].sort((a, b) => nextGwPoints(b) - nextGwPoints(a))
  return {
    startingIds,
    benchIds,
    captainId: byScore[0].id,
    viceCaptainId: byScore[1].id,
  }
}
