import { useCallback, useEffect, useState } from 'react'
import type { ChipName, DeclaredTeam } from '../types/declaredTeam'
import { EMPTY_DECLARED_TEAM } from '../types/declaredTeam'
import type { StagedTransfer } from '../types/plannedChanges'

const STORAGE_KEY = 'fpl_declared_team'

function load(): DeclaredTeam {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return EMPTY_DECLARED_TEAM
    return { ...EMPTY_DECLARED_TEAM, ...JSON.parse(raw) }
  } catch {
    return EMPTY_DECLARED_TEAM
  }
}

/** Persists a client-declared squad/bank/free-transfers/chips-used - purely
 * local, same "this app can't write back to FPL" boundary as
 * usePlannedChanges. This is what lets Transfers/Planner work immediately
 * instead of waiting for a live team-ID sync. */
export function useDeclaredTeam() {
  const [declared, setDeclared] = useState<DeclaredTeam>(load)

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(declared))
  }, [declared])

  const confirmSquad = useCallback(
    (squadIds: number[], bank: number, freeTransfers: number, event: number | null) => {
      setDeclared((d) => ({ ...d, squadIds, bank, freeTransfers, lastConfirmedEvent: event }))
    },
    []
  )

  const clearDeclaredTeam = useCallback(() => {
    setDeclared(EMPTY_DECLARED_TEAM)
  }, [])

  /** Chips are ticked off gradually through the season, not all at
   * confirm-squad time - editable any time from the Planner tab. */
  const setChipUsed = useCallback((name: ChipName, event: number, used: boolean) => {
    setDeclared((d) => ({
      ...d,
      chipsUsed: used
        ? [...d.chipsUsed.filter((c) => c.name !== name), { name, event }]
        : d.chipsUsed.filter((c) => c.name !== name),
    }))
  }, [])

  const remainingBank = useCallback(
    (staged: StagedTransfer[]) => declared.bank - staged.reduce((sum, t) => sum + t.costDelta, 0),
    [declared.bank]
  )

  const remainingFreeTransfers = useCallback(
    (staged: StagedTransfer[]) => Math.max(0, declared.freeTransfers - staged.length),
    [declared.freeTransfers]
  )

  return { declared, confirmSquad, clearDeclaredTeam, setChipUsed, remainingBank, remainingFreeTransfers }
}
