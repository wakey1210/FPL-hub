export interface StagedTransfer {
  outId: number
  inId: number
  outName: string
  inName: string
  hitCost: number
}

export interface PlannedChanges {
  startingIds: number[] | null
  benchIds: number[] | null
  captainId: number | null
  viceCaptainId: number | null
  stagedTransfers: StagedTransfer[]
}

export const EMPTY_PLAN: PlannedChanges = {
  startingIds: null,
  benchIds: null,
  captainId: null,
  viceCaptainId: null,
  stagedTransfers: [],
}
