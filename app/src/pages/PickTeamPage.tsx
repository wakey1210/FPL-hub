import { useEffect, useMemo, useState } from 'react'
import { useJsonData } from '../lib/data'
import { Layout, LoadingState, ErrorState } from '../components/Layout'
import { PitchView } from '../components/PitchView'
import { SquadListView } from '../components/SquadListView'
import { PlayerDetailSheet, type SheetAction } from '../components/PlayerDetailSheet'
import { ConfirmSquadModal } from '../components/ConfirmSquadModal'
import { usePlannedChanges } from '../lib/usePlannedChanges'
import { useDeclaredTeam } from '../lib/useDeclaredTeam'
import { optimiseStartingXI } from '../lib/formation'
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
  const { plan, trySwap, applyOptimisedLineup, setCaptain, setViceCaptain, resetLineup, clearStagedTransfers } =
    usePlannedChanges()
  const { confirmSquad, clearDeclaredTeam } = useDeclaredTeam()

  const hasLiveTeam = myTeam.data?.configured && myTeam.data.has_squad && myTeam.data.picks

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

  const baseView = liveView ?? (squadRec.data
    ? {
        squad: squadRec.data.squad,
        startingIds: squadRec.data.starting_ids,
        benchIds: squadRec.data.bench_ids,
        captainId: squadRec.data.captain_id,
        viceCaptainId: squadRec.data.vice_captain_id,
      }
    : null)

  if (!baseView) return <Layout title="Pick Team"><ErrorState message={squadRec.error ?? 'no data'} /></Layout>

  const hasOverrides = plan.startingIds !== null
  const view = {
    squad: baseView.squad,
    startingIds: plan.startingIds ?? baseView.startingIds,
    benchIds: plan.benchIds ?? baseView.benchIds,
    captainId: plan.captainId ?? baseView.captainId,
    viceCaptainId: plan.viceCaptainId ?? baseView.viceCaptainId,
  }

  const handleSelectPlayer = (player: PlayerEV) => {
    if (swapAnchor) {
      if (swapAnchor.id === player.id) {
        setSwapAnchor(null)
        return
      }
      const result = trySwap(swapAnchor.id, player.id, view.squad, view.startingIds, view.benchIds)
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
          setCaptain(player.id, view.captainId, view.viceCaptainId)
          setSelected(null)
        },
        variant: 'secondary',
      })
    }
    if (view.viceCaptainId !== player.id) {
      actions.push({
        label: 'Make vice-captain',
        onClick: () => {
          setViceCaptain(player.id, view.captainId, view.viceCaptainId)
          setSelected(null)
        },
        variant: 'secondary',
      })
    }
    return actions
  }

  const handleOptimise = () => {
    const lineup = optimiseStartingXI(view.squad)
    applyOptimisedLineup(lineup)
  }

  const handleConfirmSquad = (bank: number, freeTransfers: number) => {
    const event = meta.data?.next_gameweek ?? meta.data?.current_gameweek ?? null
    confirmSquad(view.squad.map((p) => p.id), bank, freeTransfers, event)
    resetLineup()
    clearStagedTransfers()
    setShowConfirmModal(false)
  }

  return (
    <Layout title="Pick Team">
      <p className="text-xs text-white/50 mb-2">
        {liveView
          ? `Your actual squad from GW${myTeam.data?.picks_event}.`
          : "AI-recommended squad, ahead of your first deadline. Once you've picked a squad, this will track your actual picks."}
      </p>

      {swapAnchor ? (
        <div className="flex items-center justify-between mb-3 rounded-xl bg-[#00ff87]/10 border border-[#00ff87]/40 px-3 py-2">
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
            className="flex-1 min-h-[44px] px-3 rounded-xl bg-[#00ff87] text-black text-sm font-semibold transition-colors active:opacity-80"
          >
            Optimise lineup
          </button>
          {hasOverrides && (
            <button
              onClick={resetLineup}
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
        <div className="flex items-start justify-between gap-2 mb-3 rounded-xl bg-rose-950/40 border border-rose-500/40 px-3 py-2">
          <p className="text-[11px] text-rose-200">{swapError}</p>
          <button
            onClick={() => setSwapError(null)}
            aria-label="Dismiss"
            className="shrink-0 text-rose-300 px-1 min-h-[36px] min-w-[36px]"
          >
            ×
          </button>
        </div>
      )}

      <p className="text-[10px] text-white/30 mb-3">
        Changes are a plan to apply on the official FPL app, not a live change.
      </p>

      <div className="flex gap-1 mb-3 bg-[#1e1e2a] rounded-xl p-1 w-fit">
        {(['pitch', 'list'] as const).map((mode) => (
          <button
            key={mode}
            onClick={() => setViewMode(mode)}
            className={`min-h-[36px] px-4 rounded-lg text-xs font-semibold capitalize transition-colors ${
              viewMode === mode ? 'bg-[#00ff87] text-black' : 'text-white/60'
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
        />
      )}
      <PlayerDetailSheet
        player={selected}
        onClose={() => setSelected(null)}
        actions={selected ? actionsFor(selected) : []}
      />
      {showConfirmModal && (
        <ConfirmSquadModal
          squadSize={view.squad.length}
          defaultBank={0}
          onConfirm={handleConfirmSquad}
          onClose={() => setShowConfirmModal(false)}
        />
      )}
    </Layout>
  )
}
