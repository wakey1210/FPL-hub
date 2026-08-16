import { useCallback, useEffect, useState } from 'react'
import type { PlannedChanges, StagedTransfer } from '../types/plannedChanges'
import { EMPTY_PLAN } from '../types/plannedChanges'
import type { PlayerEV } from '../types/fpl'

const STORAGE_KEY = 'fpl_planned_changes'

function load(): PlannedChanges {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return EMPTY_PLAN
    return { ...EMPTY_PLAN, ...JSON.parse(raw) }
  } catch {
    return EMPTY_PLAN
  }
}

/** Persists locally-planned lineup/transfer changes - this app can't write
 * back to FPL (the login flow is broken), so "making a change" here means
 * staging a plan to go apply on the official site, not a live action. */
export function usePlannedChanges() {
  const [plan, setPlan] = useState<PlannedChanges>(load)

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(plan))
  }, [plan])

  const bySameId = (byId: Map<number, PlayerEV>, id: number) => byId.get(id)

  const swapToStarting = useCallback(
    (playerId: number, squad: PlayerEV[], startingIds: number[], benchIds: number[]) => {
      const byId = new Map(squad.map((p) => [p.id, p]))
      const incoming = bySameId(byId, playerId)
      if (!incoming) return
      // Only same-position swaps are offered - this always keeps the formation
      // valid (position counts per the starting XI don't change), so no
      // separate formation-legality check is needed.
      const sameOnField = startingIds
        .map((id) => byId.get(id))
        .filter((p): p is PlayerEV => !!p && p.position === incoming.position)
      if (sameOnField.length === 0) return
      const weakest = sameOnField.reduce((a, b) => (a.total_ev <= b.total_ev ? a : b))
      const newStarting = startingIds.filter((id) => id !== weakest.id).concat(playerId)
      const newBench = benchIds.filter((id) => id !== playerId).concat(weakest.id)
      setPlan((p) => ({ ...p, startingIds: newStarting, benchIds: newBench }))
    },
    []
  )

  const swapToBench = useCallback(
    (playerId: number, squad: PlayerEV[], startingIds: number[], benchIds: number[]) => {
      const byId = new Map(squad.map((p) => [p.id, p]))
      const outgoing = bySameId(byId, playerId)
      if (!outgoing) return
      const sameOnBench = benchIds
        .map((id) => byId.get(id))
        .filter((p): p is PlayerEV => !!p && p.position === outgoing.position)
      if (sameOnBench.length === 0) return
      const strongest = sameOnBench.reduce((a, b) => (a.total_ev >= b.total_ev ? a : b))
      const newStarting = startingIds.filter((id) => id !== playerId).concat(strongest.id)
      const newBench = benchIds.filter((id) => id !== strongest.id).concat(playerId)
      setPlan((p) => ({ ...p, startingIds: newStarting, benchIds: newBench }))
    },
    []
  )

  /** Sets a new captain. If the new captain was the vice, the old captain
   * becomes the new vice (a straight swap) - otherwise the vice is untouched. */
  const setCaptain = useCallback((playerId: number, oldCaptainId: number, oldViceId: number) => {
    setPlan((p) => ({
      ...p,
      captainId: playerId,
      viceCaptainId: playerId === oldViceId ? oldCaptainId : oldViceId,
    }))
  }, [])

  const setViceCaptain = useCallback((playerId: number, oldCaptainId: number, oldViceId: number) => {
    setPlan((p) => ({
      ...p,
      viceCaptainId: playerId,
      captainId: playerId === oldCaptainId ? oldViceId : oldCaptainId,
    }))
  }, [])

  const resetLineup = useCallback(() => {
    setPlan((p) => ({ ...p, startingIds: null, benchIds: null, captainId: null, viceCaptainId: null }))
  }, [])

  const addStagedTransfer = useCallback((transfer: StagedTransfer) => {
    setPlan((p) => ({
      ...p,
      stagedTransfers: p.stagedTransfers.some((t) => t.outId === transfer.outId && t.inId === transfer.inId)
        ? p.stagedTransfers
        : [...p.stagedTransfers, transfer],
    }))
  }, [])

  const removeStagedTransfer = useCallback((index: number) => {
    setPlan((p) => ({ ...p, stagedTransfers: p.stagedTransfers.filter((_, i) => i !== index) }))
  }, [])

  const clearStagedTransfers = useCallback(() => {
    setPlan((p) => ({ ...p, stagedTransfers: [] }))
  }, [])

  return {
    plan,
    swapToStarting,
    swapToBench,
    setCaptain,
    setViceCaptain,
    resetLineup,
    addStagedTransfer,
    removeStagedTransfer,
    clearStagedTransfers,
  }
}
