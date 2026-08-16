import { useCallback, useEffect, useState } from 'react'
import type { PlannedChanges, StagedTransfer } from '../types/plannedChanges'
import { EMPTY_PLAN } from '../types/plannedChanges'
import type { PlayerEV } from '../types/fpl'
import { attemptSwap, type OptimisedLineup, type SwapResult } from './formation'

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

  /** Tries to swap two specific players (a starter and a bench player, in
   * either order) - the caller picks exactly who, matching the "choose a
   * player to swap with X" pattern rather than an auto-picked partner.
   * Returns the validation result so the caller can show an error if the
   * resulting formation would be invalid (e.g. 2 goalkeepers). */
  const trySwap = useCallback(
    (idA: number, idB: number, squad: PlayerEV[], startingIds: number[], benchIds: number[]): SwapResult => {
      const result = attemptSwap(idA, idB, squad, startingIds, benchIds)
      if (result.success) {
        setPlan((p) => ({ ...p, startingIds: result.startingIds!, benchIds: result.benchIds! }))
      }
      return result
    },
    []
  )

  const applyOptimisedLineup = useCallback((lineup: OptimisedLineup) => {
    setPlan((p) => ({
      ...p,
      startingIds: lineup.startingIds,
      benchIds: lineup.benchIds,
      captainId: lineup.captainId,
      viceCaptainId: lineup.viceCaptainId,
    }))
  }, [])

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
    trySwap,
    applyOptimisedLineup,
    setCaptain,
    setViceCaptain,
    resetLineup,
    addStagedTransfer,
    removeStagedTransfer,
    clearStagedTransfers,
  }
}
