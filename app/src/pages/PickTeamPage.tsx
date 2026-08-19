import { useEffect, useMemo, useState } from 'react'
import { useJsonData } from '../lib/data'
import { Layout, LoadingState, ErrorState } from '../components/Layout'
import { PitchView } from '../components/PitchView'
import { SquadListView } from '../components/SquadListView'
import { PlayerDetailSheet, type SheetAction } from '../components/PlayerDetailSheet'
import { ConfirmSquadModal } from '../components/ConfirmSquadModal'
import { ReplacementPicker } from '../components/ReplacementPicker'
import { StagedTransfersCart } from '../components/StagedTransfersCart'
import { usePlannedChanges } from '../lib/usePlannedChanges'
import { useDeclaredTeam } from '../lib/useDeclaredTeam'
import { optimiseStartingXI } from '../lib/formation'
import { squadAtEvent, bankAndFreeTransfersAtEvent, isOverrideValidForSquad, pointsAtEvent } from '../lib/squadTimeline'
import { formatPrice } from '../lib/format'
import type { Meta, PlayerEV, SquadRecommendation } from '../types/fpl'
import type { MyTeam } from '../types/myTeam'

export function PickTeamPage() {
  const squadRec = useJsonData<SquadRecommendation>('squad_recommendation.json')
  const myTeam = useJsonData<MyTeam>('my_team.json')
  const allPlayers = useJsonData<PlayerEV[]>('players.json')
  const meta = useJsonData<Meta>('meta.json')
  const [selected, setSelected] = useState<PlayerEV | null>(null)
  const [swapAnchor, setSwapAnchor] = useState<PlayerEV | null>(null)
  const [swapError, setSwapError] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<'pitch' | 'list'>('pitch')
  const [showConfirmModal, setShowConfirmModal] = useState(false)
  const [transferOutTarget, setTransferOutTarget] = useState<PlayerEV | null>(null)
  const [viewEventOverride, setViewEventOverride] = useState<number | null>(null)
  const {
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
  } = usePlannedChanges()
  const { declared, confirmSquad, clearDeclaredTeam } = useDeclaredTeam()

  const hasLiveTeam = myTeam.data?.configured && myTeam.data.has_squad && myTeam.data.picks
  const currentEvent = meta.data?.next_gameweek ?? meta.data?.current_gameweek ?? null

  // Once a real team ID has synced, the server-computed suggestions/plan
  // take over entirely - a stale client-declared squad from before the sync
  // would otherwise linger and confuse which source is authoritative.
  useEffect(() => {
    if (hasLiveTeam) clearDeclaredTeam()
  }, [hasLiveTeam, clearDeclaredTeam])

  const liveView = useMemo(() => {
    if (!hasLiveTeam || !allPlayers.data) return null
    const byId = new Map(allPlayers.data.map((p) => [p.id, p]))
    const picks = myTeam.data!.picks!
    const squad = picks.map((p) => byId.get(p.element)).filter((p): p is PlayerEV => !!p)
    const startingIds = picks.filter((p) => p.position <= 11).map((p) => p.element)
    const benchIds = picks
      .filter((p) => p.position > 11)
      .sort((a, b) => a.position - b.position)
      .map((p) => p.element)
    const captainId = picks.find((p) => p.is_captain)?.element ?? startingIds[0]
    const viceCaptainId = picks.find((p) => p.is_vice_captain)?.element ?? startingIds[1]
    return { squad, startingIds, benchIds, captainId, viceCaptainId }
  }, [hasLiveTeam, allPlayers.data, myTeam.data])

  const loading = squadRec.loading || myTeam.loading || (hasLiveTeam && allPlayers.loading)
  if (loading) return <Layout title="Pick Team"><LoadingState /></Layout>

  // "Confirmed" = a declared, not-live-synced squad - the only mode with a
  // real gameweek timeline (transfers rolling forward, bank/FT changing week
  // to week). Before confirming, or once a live team ID has synced, Pick
  // Team behaves exactly as it always has: a single "now" view.
  const isConfirmed = !hasLiveTeam && !!declared.squadIds

  // Gameweek navigation bounds match players.json's own forecast horizon -
  // can't show a week with no fixture-EV data.
  const horizon = allPlayers.data?.[0]?.fixtures.length ?? 6
  const minEvent = declared.lastConfirmedEvent ?? currentEvent ?? 1
  const maxEvent = minEvent + horizon - 1
  const viewEvent = isConfirmed
    ? Math.min(Math.max(viewEventOverride ?? minEvent, minEvent), maxEvent)
    : myTeam.data?.picks_event ?? currentEvent ?? 0

  const squadAtView =
    isConfirmed && allPlayers.data
      ? squadAtEvent(declared.squadIds!, allPlayers.data, plan.stagedTransfers, viewEvent)
      : null

  const baseView =
    liveView ??
    (squadAtView
      ? { squad: squadAtView, startingIds: null, benchIds: null, captainId: null, viceCaptainId: null }
      : squadRec.data
        ? {
            squad: squadRec.data.squad,
            startingIds: squadRec.data.starting_ids as number[] | null,
            benchIds: squadRec.data.bench_ids as number[] | null,
            captainId: squadRec.data.captain_id as number | null,
            viceCaptainId: squadRec.data.vice_captain_id as number | null,
          }
        : null)

  if (!baseView) return <Layout title="Pick Team"><ErrorState message={squadRec.error ?? 'no data'} /></Layout>

  const override = plan.lineupOverrides[viewEvent]
  const validOverride = override && isOverrideValidForSquad(override, baseView.squad) ? override : null
  // Only the confirmed/GW-navigable mode falls back to an auto-optimised
  // pick per viewed gameweek - the live/unconfirmed defaults (real official
  // picks, or the server-recommended squad) are authoritative on their own.
  const autoLineup = isConfirmed ? optimiseStartingXI(baseView.squad, pointsAtEvent(viewEvent)) : null

  const view = {
    squad: baseView.squad,
    startingIds: validOverride?.startingIds ?? baseView.startingIds ?? autoLineup!.startingIds,
    benchIds: validOverride?.benchIds ?? baseView.benchIds ?? autoLineup!.benchIds,
    captainId: validOverride?.captainId ?? baseView.captainId ?? autoLineup!.captainId,
    viceCaptainId: validOverride?.viceCaptainId ?? baseView.viceCaptainId ?? autoLineup!.viceCaptainId,
  }

  const hasOverrides = !!override

  const handleSelectPlayer = (player: PlayerEV) => {
    if (swapAnchor) {
      if (swapAnchor.id === player.id) {
        setSwapAnchor(null)
        return
      }
      const result = trySwap(
        viewEvent,
        swapAnchor.id,
        player.id,
        view.squad,
        view.startingIds,
        view.benchIds,
        view.captainId,
        view.viceCaptainId
      )
      if (result.success) {
        setSwapAnchor(null)
        setSwapError(null)
      } else {
        setSwapError(result.error ?? 'That swap is not allowed.')
      }
      return
    }
    setSelected(player)
  }

  const actionsFor = (player: PlayerEV): SheetAction[] => {
    const actions: SheetAction[] = [
      {
        label: 'Substitute',
        onClick: () => {
          setSelected(null)
          setSwapAnchor(player)
        },
      },
    ]
    if (view.captainId !== player.id) {
      actions.push({
        label: 'Make captain',
        onClick: () => {
          setCaptain(viewEvent, player.id, view.captainId, view.viceCaptainId, view.startingIds, view.benchIds)
          setSelected(null)
        },
        variant: 'secondary',
      })
    }
    if (view.viceCaptainId !== player.id) {
      actions.push({
        label: 'Make vice-captain',
        onClick: () => {
          setViceCaptain(viewEvent, player.id, view.captainId, view.viceCaptainId, view.startingIds, view.benchIds)
          setSelected(null)
        },
        variant: 'secondary',
      })
    }
    if (isConfirmed) {
      actions.push({
        label: 'Transfer out',
        onClick: () => {
          setSelected(null)
          setTransferOutTarget(player)
        },
        variant: 'secondary',
      })
    }
    return actions
  }

  const handleOptimise = () => {
    if (isConfirmed) {
      // The auto-optimised pick already IS the no-override fallback for this
      // mode, so "optimise" and "clear this week's override" are the same
      // action here.
      resetLineup(viewEvent)
    } else {
      const lineup = optimiseStartingXI(view.squad)
      applyOptimisedLineup(viewEvent, lineup)
    }
  }

  const handleConfirmSquad = (bank: number, freeTransfers: number) => {
    const event = meta.data?.next_gameweek ?? meta.data?.current_gameweek ?? null
    confirmSquad(view.squad.map((p) => p.id), bank, freeTransfers, event)
    clearAllLineupOverrides()
    clearStagedTransfers()
    setViewEventOverride(null)
    setShowConfirmModal(false)
  }

  const handlePickReplacement = (inPlayer: PlayerEV) => {
    if (!transferOutTarget || !allPlayers.data) return
    const { freeTransfers } = bankAndFreeTransfersAtEvent(declared, plan.stagedTransfers, viewEvent - 1)
    const usedSoFarThisWeek = plan.stagedTransfers.filter((t) => t.event === viewEvent).length
    addStagedTransfer({
      outId: transferOutTarget.id,
      inId: inPlayer.id,
      outName: transferOutTarget.web_name,
      inName: inPlayer.web_name,
      hitCost: usedSoFarThisWeek >= freeTransfers ? 4 : 0,
      costDelta: inPlayer.now_cost - transferOutTarget.now_cost,
      event: viewEvent,
    })
    setTransferOutTarget(null)
  }

  const { bank: bankAtView, freeTransfers: freeTransfersAtView } = isConfirmed
    ? bankAndFreeTransfersAtEvent(declared, plan.stagedTransfers, viewEvent)
    : { bank: 0, freeTransfers: 0 }
  const stagedThisWeek = plan.stagedTransfers.filter((t) => t.event === viewEvent)

  return (
    <Layout title="Pick Team">
      <p className="text-xs text-white/50 mb-2">
        {liveView
          ? `Your actual squad from GW${myTeam.data?.picks_event}.`
          : "AI-recommended squad, ahead of your first deadline. Once you've picked a squad, this will track your actual picks."}
      </p>

      {isConfirmed && (
        <div className="flex items-center justify-between mb-2">
          <button
            onClick={() => setViewEventOverride(Math.max(minEvent, viewEvent - 1))}
            disabled={viewEvent <= minEvent}
            aria-label="Previous gameweek"
            className="min-h-[36px] min-w-[36px] rounded-lg bg-white/10 text-white disabled:opacity-30 transition-colors active:bg-white/20"
          >
            ‹
          </button>
          <div className="text-center">
            <p className="text-sm font-semibold">Gameweek {viewEvent}</p>
            <p className="text-[10px] text-white/40">
              {formatPrice(bankAtView)} bank · {freeTransfersAtView} free transfer{freeTransfersAtView === 1 ? '' : 's'}
              {stagedThisWeek.length > 0 &&
                ` · ${stagedThisWeek.length} staged${stagedThisWeek.some((t) => t.hitCost > 0) ? ' (hit)' : ''}`}
            </p>
          </div>
          <button
            onClick={() => setViewEventOverride(Math.min(maxEvent, viewEvent + 1))}
            disabled={viewEvent >= maxEvent}
            aria-label="Next gameweek"
            className="min-h-[36px] min-w-[36px] rounded-lg bg-white/10 text-white disabled:opacity-30 transition-colors active:bg-white/20"
          >
            ›
          </button>
        </div>
      )}

      {swapAnchor ? (
        <div className="flex items-center justify-between mb-3 rounded-xl bg-primary/10 border border-primary/40 px-3 py-2">
          <p className="text-[11px] text-white/80">
            Choose a player to swap with <span className="font-semibold text-white">{swapAnchor.web_name}</span>.
          </p>
          <button
            onClick={() => setSwapAnchor(null)}
            className="ml-2 shrink-0 min-h-[36px] px-3 rounded-lg bg-white/10 text-xs font-semibold text-white transition-colors active:bg-white/20"
          >
            Cancel
          </button>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2 mb-3">
          <button
            onClick={handleOptimise}
            className="flex-1 min-h-[44px] px-3 rounded-xl bg-primary text-primary-foreground text-sm font-semibold transition-colors active:opacity-80"
          >
            Optimise lineup
          </button>
          {!isConfirmed && hasOverrides && (
            <button
              onClick={() => resetLineup(viewEvent)}
              className="shrink-0 min-h-[44px] px-3 rounded-lg bg-white/10 text-xs font-semibold text-white transition-colors active:bg-white/20"
            >
              Reset
            </button>
          )}
          {!hasLiveTeam && (
            <button
              onClick={() => setShowConfirmModal(true)}
              className="shrink-0 min-h-[44px] px-3 rounded-lg bg-white/10 text-xs font-semibold text-white transition-colors active:bg-white/20"
            >
              Confirm my squad
            </button>
          )}
        </div>
      )}

      {swapError && (
        <div className="flex items-start justify-between gap-2 mb-3 rounded-xl bg-danger/10 border border-danger/40 px-3 py-2">
          <p className="text-[11px] text-danger">{swapError}</p>
          <button
            onClick={() => setSwapError(null)}
            aria-label="Dismiss"
            className="shrink-0 text-danger px-1 min-h-[36px] min-w-[36px]"
          >
            ×
          </button>
        </div>
      )}

      <p className="text-[10px] text-white/30 mb-3">
        Changes are a plan to apply on the official FPL app, not a live change.
      </p>

      <div className="flex gap-1 mb-3 bg-surface rounded-xl p-1 w-fit">
        {(['pitch', 'list'] as const).map((mode) => (
          <button
            key={mode}
            onClick={() => setViewMode(mode)}
            className={`min-h-[36px] px-4 rounded-lg text-xs font-semibold capitalize transition-colors ${
              viewMode === mode ? 'bg-primary text-primary-foreground' : 'text-white/60'
            }`}
          >
            {mode}
          </button>
        ))}
      </div>

      {viewMode === 'pitch' ? (
        <PitchView
          squad={view.squad}
          startingIds={view.startingIds}
          benchIds={view.benchIds}
          captainId={view.captainId}
          viceCaptainId={view.viceCaptainId}
          onSelectPlayer={handleSelectPlayer}
          highlightId={swapAnchor?.id ?? null}
          pointsForPlayer={isConfirmed ? pointsAtEvent(viewEvent) : undefined}
        />
      ) : (
        <SquadListView
          squad={view.squad}
          startingIds={view.startingIds}
          benchIds={view.benchIds}
          captainId={view.captainId}
          viceCaptainId={view.viceCaptainId}
          onSelectPlayer={handleSelectPlayer}
          highlightId={swapAnchor?.id ?? null}
          pointsForPlayer={isConfirmed ? pointsAtEvent(viewEvent) : undefined}
          pointsLabel={isConfirmed ? `GW${viewEvent}` : undefined}
        />
      )}
      <PlayerDetailSheet
        player={selected}
        onClose={() => setSelected(null)}
        actions={selected ? actionsFor(selected) : []}
      />
      {transferOutTarget && allPlayers.data && (
        <ReplacementPicker
          outPlayer={transferOutTarget}
          allPlayers={allPlayers.data}
          excludeIds={view.squad.map((p) => p.id)}
          onPick={handlePickReplacement}
          onClose={() => setTransferOutTarget(null)}
        />
      )}
      {showConfirmModal && (
        <ConfirmSquadModal
          squadSize={view.squad.length}
          defaultBank={0}
          onConfirm={handleConfirmSquad}
          onClose={() => setShowConfirmModal(false)}
        />
      )}
      {isConfirmed && plan.stagedTransfers.length > 0 && <div className="h-28" />}
      {isConfirmed && (
        <StagedTransfersCart
          staged={plan.stagedTransfers}
          onRemove={(i) =>
            removeStagedTransfer(
              i,
              (event) => bankAndFreeTransfersAtEvent(declared, plan.stagedTransfers, event - 1).freeTransfers
            )
          }
          onClear={clearStagedTransfers}
        />
      )}
    </Layout>
  )
}
