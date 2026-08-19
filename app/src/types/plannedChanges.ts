export interface StagedTransfer {
  outId: number
  inId: number
  outName: string
  inName: string
  hitCost: number
  costDelta: number // tenths of £m; positive = the swap costs more money
  event: number // the gameweek this transfer takes effect from
}

export interface LineupOverride {
  startingIds: number[]
  benchIds: number[]
  captainId: number
  viceCaptainId: number
}

export interface PlannedChanges {
  lineupOverrides: Record<number, LineupOverride> // keyed by gameweek event
  stagedTransfers: StagedTransfer[]
}

export const EMPTY_PLAN: PlannedChanges = {
  lineupOverrides: {},
  stagedTransfers: [],
}
