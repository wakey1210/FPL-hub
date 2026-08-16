export type ChipName = 'wildcard' | 'freehit' | 'bboost' | '3xc'

export interface ChipUseRecord {
  name: ChipName
  event: number
}

/** A user-declared squad/bank/free-transfers/chips-used, stored purely
 * client-side - lets Transfers/Planner start suggesting moves immediately,
 * before a live FPL team ID has synced real post-deadline picks. Superseded
 * entirely once a live sync exists (see hasLiveTeam in PickTeamPage.tsx). */
export interface DeclaredTeam {
  squadIds: number[] | null
  bank: number // tenths of £m, matches PlayerEV.now_cost units
  freeTransfers: number
  chipsUsed: ChipUseRecord[]
  lastConfirmedEvent: number | null
}

export const EMPTY_DECLARED_TEAM: DeclaredTeam = {
  squadIds: null,
  bank: 0,
  freeTransfers: 1,
  chipsUsed: [],
  lastConfirmedEvent: null,
}
