import { useCallback, useEffect, useState } from 'react'
import type { LineupOverride, PlannedChanges, StagedTransfer } from '../types/plannedChanges'
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
 * staging a plan to go apply on the official site, not a live action.
 * Lineup overrides are keyed by gameweek event - each future gameweek you
 * view on Pick Team is independently editable, defaulting to the
 * auto-optimised XI when no override exists for that week. */
export function usePlannedChanges() {
  const [plan, setPlan] = useState<PlannedChanges>(load)

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(plan))
  }, [plan])

  /** Tries to swap two specific players (a starter and a bench player, in
   * either order) for a given gameweek's lineup - the caller picks exactly
   * who, matching the "choose a player to swap with X" pattern rather than
   * an auto-picked partner. Returns the validation result so the caller can
   * show an error if the resulting formation would be invalid. */
  const trySwap = useCallback(
    (
      event: number,
      idA: number,
      idB: number,
      squad: PlayerEV[],
      startingIds: number[],
      benchIds: number[],
      captainId: number,
      viceCaptainId: number
    ): SwapResult => {
      const result = attemptSwap(idA, idB, squad, startingIds, benchIds)
      if (result.success) {
        setPlan((p) => ({
          ...p,
          lineupOverrides: {
            ...p.lineupOverrides,
            [event]: {
              startingIds: result.startingIds!,
              benchIds: result.benchIds!,
              captainId,
              viceCaptainId,
            },
          },
        }))
      }
      return result
    },
    []
  )

  const applyOptimisedLineup = useCallback((event: number, lineup: OptimisedLineup) => {
    setPlan((p) => ({
      ...p,
      lineupOverrides: { ...p.lineupOverrides, [event]: { ...lineup } },
    }))
  }, [])

  /** Sets a new captain for a given gameweek. If the new captain was the
   * vice, the old captain becomes the new vice (a straight swap) - otherwise
   * the vice is untouched. */
  const setCaptain = useCallback(
    (
      event: number,
      playerId: number,
      oldCaptainId: number,
      oldViceId: number,
      startingIds: number[],
      benchIds: number[]
    ) => {
      setPlan((p) => ({
        ...p,
        lineupOverrides: {
          ...p.lineupOverrides,
          [event]: {
            startingIds,
            benchIds,
            captainId: playerId,
            viceCaptainId: playerId === oldViceId ? oldCaptainId : oldViceId,
          },
        },
      }))
    },
    []
  )

  const setViceCaptain = useCallback(
    (
      event: number,
      playerId: number,
      oldCaptainId: number,
      oldViceId: number,
      startingIds: number[],
      benchIds: number[]
    ) => {
      setPlan((p) => ({
        ...p,
        lineupOverrides: {
          ...p.lineupOverrides,
          [event]: {
            startingIds,
            benchIds,
            viceCaptainId: playerId,
            captainId: playerId === oldCaptainId ? oldViceId : oldCaptainId,
          },
        },
      }))
    },
    []
  )

  const resetLineup = useCallback((event: number) => {
    setPlan((p) => {
      const { [event]: _removed, ...rest } = p.lineupOverrides
      return { ...p, lineupOverrides: rest }
    })
  }, [])

  /** Clears every gameweek's lineup override at once - used when confirming
   * a fresh squad, since every previous override was staged against a squad
   * that no longer exists. */
  const clearAllLineupOverrides = useCallback(() => {
    setPlan((p) => ({ ...p, lineupOverrides: {} }))
  }, [])

  const addStagedTransfer = useCallback((transfer: StagedTransfer) => {
    setPlan((p) => ({
      ...p,
      stagedTransfers: p.stagedTransfers.some((t) => t.outId === transfer.outId && t.inId === transfer.inId)
        ? p.stagedTransfers
        : [...p.stagedTransfers, transfer],
    }))
  }, [])

  /** Removing a transfer can free up a slot that a later-staged transfer in
   * the same gameweek was paying a hit for - recompute hit costs for the
   * remaining transfers sharing the removed one's event, in their existing
   * order, against `freeTransfersAtEvent` (first N free, rest cost 4). */
  const removeStagedTransfer = useCallback((index: number, freeTransfersAtEvent?: (event: number) => number) => {
    setPlan((p) => {
      const removed = p.stagedTransfers[index]
      const remaining = p.stagedTransfers.filter((_, i) => i !== index)
      if (!removed || !freeTransfersAtEvent) return { ...p, stagedTransfers: remaining }

      const free = freeTransfersAtEvent(removed.event)
      let seen = 0
      const rebalanced = remaining.map((t) => {
        if (t.event !== removed.event) return t
        seen += 1
        return { ...t, hitCost: seen > free ? 4 : 0 }
      })
      return { ...p, stagedTransfers: rebalanced }
    })
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
    clearAllLineupOverrides,
    addStagedTransfer,
    removeStagedTransfer,
    clearStagedTransfers,
  }
}

export type { LineupOverride }
