import type { PlayerEV } from '../types/fpl'
import type { DeclaredTeam } from '../types/declaredTeam'
import type { LineupOverride, StagedTransfer } from '../types/plannedChanges'
import type { MyTeam } from '../types/myTeam'

const MAX_FREE_TRANSFERS = 5

/** A live-synced manager's real squad/bank/free-transfers, reshaped to the
 * same `DeclaredTeam` fields `squadAtEvent`/`bankAndFreeTransfersAtEvent`
 * already expect - lets AddPlayerPage/ConfirmTransfersPage/PickTeamPage
 * reuse the exact same event-by-event rollover logic for a live team
 * instead of forking a second copy of it. `lastConfirmedEvent` is
 * `picks_event` (the manager's last-passed deadline): that's the gameweek
 * `bank`/`free_transfers_estimate` are actually known-accurate as of, same
 * role `lastConfirmedEvent` plays for a declared squad's own confirm-time
 * snapshot. `chipsUsed` is intentionally left empty - no current caller of
 * this needs chip state from the live path (PlannerPage reads
 * `chips_used` from `myTeam.json` directly for that). */
export function liveTeamAsDeclared(myTeam: MyTeam): DeclaredTeam {
  return {
    squadIds: (myTeam.picks ?? []).map((p) => p.element),
    bank: myTeam.summary?.bank ?? 0,
    freeTransfers: myTeam.summary?.free_transfers_estimate ?? 1,
    chipsUsed: [],
    lastConfirmedEvent: myTeam.picks_event ?? null,
  }
}

/** The 15-man squad as of a given gameweek - the base declared squad with
 * every staged transfer tagged `event <= targetEvent` folded on, in staging
 * order. Transfers tagged for a later event don't affect an earlier one. */
export function squadAtEvent(
  baseSquadIds: number[],
  allPlayers: PlayerEV[],
  staged: StagedTransfer[],
  targetEvent: number
): PlayerEV[] {
  const byId = new Map(allPlayers.map((p) => [p.id, p]))
  let ids = [...baseSquadIds]
  for (const t of staged) {
    if (t.event > targetEvent) continue
    ids = ids.filter((id) => id !== t.outId).concat(t.inId)
  }
  return ids.map((id) => byId.get(id)).filter((p): p is PlayerEV => !!p)
}

/** Bank and free-transfer count as of a given gameweek - walks forward from
 * the squad's confirmation event applying each week's staged transfers and
 * rolling free transfers over with FPL's real rule (min 5 banked, +1/week).
 * Mirrors the exact rollover expression already used in transferPlanner.ts's
 * `simulateTransfers` - this is the same rule, just applied to the user's
 * own manual choices instead of the algorithm's. */
export function bankAndFreeTransfersAtEvent(
  declared: DeclaredTeam,
  staged: StagedTransfer[],
  targetEvent: number
): { bank: number; freeTransfers: number } {
  const startEvent = declared.lastConfirmedEvent ?? targetEvent
  let bank = declared.bank
  let freeTransfers = declared.freeTransfers

  for (let event = startEvent; event <= targetEvent; event++) {
    const thisWeek = staged.filter((t) => t.event === event)
    for (const t of thisWeek) bank -= t.costDelta
    freeTransfers = Math.max(0, freeTransfers - thisWeek.length)
    if (event < targetEvent) freeTransfers = Math.min(MAX_FREE_TRANSFERS, freeTransfers + 1)
  }

  return { bank, freeTransfers }
}

/** A lineup override is stale (e.g. a referenced player was since transferred
 * out) if its player-id set no longer exactly matches the squad-at-event's
 * id set. Falls back to auto-optimise rather than showing/crashing on a sold
 * player. */
export function isOverrideValidForSquad(override: LineupOverride, squad: PlayerEV[]): boolean {
  const squadIds = new Set(squad.map((p) => p.id))
  const overrideIds = new Set([...override.startingIds, ...override.benchIds])
  if (overrideIds.size !== squadIds.size) return false
  for (const id of overrideIds) if (!squadIds.has(id)) return false
  return true
}

/** Scorer for optimiseStartingXI when viewing a gameweek other than "now" -
 * that gameweek's own fixture points, not fixtures[0]. Equivalent to
 * formation.ts's default `nextGwPoints` when `event` is the current gameweek,
 * since fixtures[0] is that event by construction. */
export function pointsAtEvent(event: number): (player: PlayerEV) => number {
  return (player) => player.fixtures.find((f) => f.event === event)?.points ?? 0
}
