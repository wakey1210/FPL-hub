import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useJsonData } from '../lib/data'
import { Layout, LoadingState, ErrorState } from '../components/Layout'
import { PitchView } from '../components/PitchView'
import { PlayerFixtureTable } from '../components/PlayerFixtureTable'
import { PlayerDetailSheet, type SheetAction } from '../components/PlayerDetailSheet'
import { ConfirmSquadModal } from '../components/ConfirmSquadModal'
import { usePlannedChanges } from '../lib/usePlannedChanges'
import { useDeclaredTeam } from '../lib/useDeclaredTeam'
import { optimiseStartingXI } from '../lib/formation'
import { squadAtEvent, bankAndFreeTransfersAtEvent, isOverrideValidForSquad, pointsAtEvent } from '../lib/squadTimeline'
import { formatPrice } from '../lib/format'
import type { Meta, PlayerEV, SquadRecommendation } from '../types/fpl'
import type { MyTeam } from '../types/myTeam'

export function PickTeamPage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const squadRec = useJsonData<SquadRecommendation>('squad_recommendation.json')
  const myTeam = useJsonData<MyTeam>('my_team.json')
  const allPlayers = useJsonData<PlayerEV[]>('players.json')
  const meta = useJsonData<Meta>('meta.json')
  const [selected, setSelected] = useState<PlayerEV | null>(null)
  const [swapAnchor, setSwapAnchor] = useState<PlayerEV | null>(null)
  const [swapError, setSwapError] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<'pitch' | 'list'>('pitch')
  const [showConfirmModal, setShowConfirmModal] = useState(false)
  const {
    plan,
    trySwap,
    applyOptimisedLineup,
    setCaptain,
    setViceCaptain,
    resetLineup,
    clearAllLineupOverrides,
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

  // The AI-recommended squad is already a fully-formed pick - making the
  // user manually "confirm" it before gameweek navigation/transfers unlock
  // is an unnecessary extra step. Auto-declares it the first time there's no
  // declared squad yet and no live team synced; "Confirm my squad" remains
  // available afterward as the explicit "start over" action. Uses the
  // recommendation's own leftover budget (budget_tenths - total_cost)
  // instead of assuming it spent exactly £100.0m, since a corrected
  // optimiser run - or, once the season's underway, real price movement -
  // won't always spend the full budget exactly.
  useEffect(() => {
    if (hasLiveTeam || declared.squadIds || !squadRec.data) return
    confirmSquad(
      squadRec.data.squad.map((p) => p.id),
      squadRec.data.budget_tenths - squadRec.data.total_cost,
      1,
      currentEvent
    )
  }, [hasLiveTeam, declared.squadIds, squadRec.data, currentEvent, confirmSquad])

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
  // can't show a week with no fixture-EV data. Kept in the URL (?gw=) rather
  // than local state so navigating to Add Player/Confirm Transfers and back
  // doesn't lose which gameweek was being viewed.
  const horizon = allPlayers.data?.[0]?.fixtures.length ?? 6
  const minEvent = declared.lastConfirmedEvent ?? currentEvent ?? 1
  const maxEvent = minEvent + horizon - 1
  const gwParam = Number(searchParams.get('gw'))
  // Live-synced mode has no gameweek nav (see the isConfirmed-gated arrows
  // below), but still needs to default to whichever gameweek the user can
  // actually still act on. `picks_event` is the manager's last-PASSED
  // deadline - i.e. the gameweek currently being played, already locked -
  // so defaulting there when a next deadline is upcoming left live-synced
  // users unable to plan/transfer for it at all from this page (they'd be
  // staring at a frozen, un-actionable squad for the entire time a gameweek
  // is in play). `currentEvent` (next_gameweek, falling back to
  // current_gameweek only once there's no next one left in the season)
  // takes priority instead - the live squad itself is unchanged either way
  // until a transfer is actually staged, so this just re-labels "your real
  // squad" as "the starting point for your next transfer", not a different
  // squad.
  const viewEvent = isConfirmed
    ? Math.min(Math.max(gwParam || minEvent, minEvent), maxEvent)
    : currentEvent ?? myTeam.data?.picks_event ?? 0

  const setViewEvent = (event: number) => setSearchParams({ gw: String(event) }, { replace: true })

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
  const squadById = new Map(view.squad.map((p) => [p.id, p]))

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
    // Live-synced users need this too, not just the declared/"confirmed"
    // path - AddPlayerPage/ConfirmTransfersPage already work off whatever
    // event/staged-transfers state they're given regardless of which mode
    // built the squad, so gating this on `isConfirmed` only was withholding
    // a working feature from the primary (real-team) user during exactly
    // the window they're most likely to want it: a gameweek in play, with
    // `viewEvent` now the upcoming one they can still act on.
    if (isConfirmed || hasLiveTeam) {
      actions.push({
        label: 'Transfer',
        onClick: () => {
          setSelected(null)
          navigate('/add-player', { state: { outPlayerId: player.id, event: viewEvent } })
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
    setSearchParams({}, { replace: true })
    setShowConfirmModal(false)
  }

  const { bank: bankAtView, freeTransfers: freeTransfersAtView } = isConfirmed
    ? bankAndFreeTransfersAtEvent(declared, plan.stagedTransfers, viewEvent)
    : { bank: 0, freeTransfers: 0 }
  const stagedThisWeek = plan.stagedTransfers.filter((t) => t.event === viewEvent)
  const teamValue = view.squad.reduce((sum, p) => sum + p.now_cost, 0) + bankAtView
  const confirmSquadDefaults = isConfirmed
    ? bankAndFreeTransfersAtEvent(declared, plan.stagedTransfers, minEvent)
    : { bank: 0, freeTransfers: 1 }

  return (
    <Layout title="Pick Team">
      <p className="text-xs text-white/50 mb-2">
        {liveView
          ? viewEvent === myTeam.data?.picks_event
            ? `Your actual squad from GW${myTeam.data?.picks_event}.`
            : `Your real squad, ready for GW${viewEvent} transfers.`
          : isConfirmed
            ? "Based on your declared squad - will switch to your live FPL team once synced."
            : "AI-recommended squad, ahead of your first deadline. Confirm your squad below to unlock gameweek-by-gameweek transfers."}
      </p>

      {isConfirmed && (
        <div className="flex items-center justify-between mb-2">
          <button
            onClick={() => setViewEvent(Math.max(minEvent, viewEvent - 1))}
            disabled={viewEvent <= minEvent}
            aria-label="Previous gameweek"
            className="min-h-[36px] min-w-[36px] rounded-lg bg-white/10 text-white disabled:opacity-30 transition-colors active:bg-white/20"
          >
            ‹
          </button>
          <div className="text-center">
            <p className="text-sm font-semibold">Gameweek {viewEvent}</p>
            <p className="text-[10px] text-white/40">
              {formatPrice(teamValue)} value · {formatPrice(bankAtView)} bank ·{' '}
              {freeTransfersAtView} free transfer{freeTransfersAtView === 1 ? '' : 's'}
            </p>
          </div>
          <button
            onClick={() => setViewEvent(Math.min(maxEvent, viewEvent + 1))}
            disabled={viewEvent >= maxEvent}
            aria-label="Next gameweek"
            className="min-h-[36px] min-w-[36px] rounded-lg bg-white/10 text-white disabled:opacity-30 transition-colors active:bg-white/20"
          >
            ›
          </button>
        </div>
      )}

      {(isConfirmed || hasLiveTeam) && stagedThisWeek.length > 0 && (
        <button
          onClick={() => navigate(`/confirm-transfers?gw=${viewEvent}`)}
          className="w-full flex items-center justify-between mb-3 rounded-xl bg-primary/10 border border-primary/40 px-3 py-2.5 text-left transition-colors active:bg-primary/20"
        >
          <span className="text-sm font-semibold text-white">
            Review {stagedThisWeek.length} transfer{stagedThisWeek.length === 1 ? '' : 's'} for GW{viewEvent}
            {stagedThisWeek.some((t) => t.hitCost > 0) && <span className="text-danger"> (hit)</span>}
          </span>
          <span className="text-primary text-lg">→</span>
        </button>
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
        <PlayerFixtureTable
          rows={[...view.startingIds, ...view.benchIds].map((id) => {
            const player = squadById.get(id)!
            const badge = id === view.captainId ? ('C' as const) : id === view.viceCaptainId ? ('VC' as const) : undefined
            return { player, badge }
          })}
          fromEvent={viewEvent}
          onSelectPlayer={handleSelectPlayer}
          highlightId={swapAnchor?.id ?? null}
          dividerBeforeIndex={view.startingIds.length}
          dividerLabel="Bench"
        />
      )}
      <PlayerDetailSheet
        key={selected?.id ?? 'closed'}
        player={selected}
        onClose={() => setSelected(null)}
        actions={selected ? actionsFor(selected) : []}
        captainState={
          selected
            ? {
                isCaptain: view.captainId === selected.id,
                isViceCaptain: view.viceCaptainId === selected.id,
                onToggleCaptain: () => {
                  setCaptain(viewEvent, selected.id, view.captainId, view.viceCaptainId, view.startingIds, view.benchIds)
                  setSelected(null)
                },
                onToggleVice: () => {
                  setViceCaptain(viewEvent, selected.id, view.captainId, view.viceCaptainId, view.startingIds, view.benchIds)
                  setSelected(null)
                },
              }
            : undefined
        }
      />
      {showConfirmModal && (
        <ConfirmSquadModal
          squadSize={view.squad.length}
          defaultBank={confirmSquadDefaults.bank}
          defaultFreeTransfers={confirmSquadDefaults.freeTransfers}
          alreadyConfirmed={isConfirmed}
          onConfirm={handleConfirmSquad}
          onClose={() => setShowConfirmModal(false)}
        />
      )}
    </Layout>
  )
}
