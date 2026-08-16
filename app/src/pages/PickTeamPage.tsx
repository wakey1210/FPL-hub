import { useMemo, useState } from 'react'
import { useJsonData } from '../lib/data'
import { Layout, LoadingState, ErrorState } from '../components/Layout'
import { PitchView } from '../components/PitchView'
import { PlayerDetailSheet, type SheetAction } from '../components/PlayerDetailSheet'
import { usePlannedChanges } from '../lib/usePlannedChanges'
import type { PlayerEV, SquadRecommendation } from '../types/fpl'
import type { MyTeam } from '../types/myTeam'

export function PickTeamPage() {
  const squadRec = useJsonData<SquadRecommendation>('squad_recommendation.json')
  const myTeam = useJsonData<MyTeam>('my_team.json')
  const allPlayers = useJsonData<PlayerEV[]>('players.json')
  const [selected, setSelected] = useState<PlayerEV | null>(null)
  const { plan, swapToStarting, swapToBench, setCaptain, setViceCaptain, resetLineup } = usePlannedChanges()

  const hasLiveTeam = myTeam.data?.configured && myTeam.data.has_squad && myTeam.data.picks

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

  const actionsFor = (player: PlayerEV): SheetAction[] => {
    const actions: SheetAction[] = []
    const isStarting = view.startingIds.includes(player.id)
    if (isStarting) {
      const sameOnBench = view.benchIds
        .map((id) => view.squad.find((p) => p.id === id))
        .some((p) => p?.position === player.position)
      if (sameOnBench) {
        actions.push({
          label: 'Move to bench',
          onClick: () => {
            swapToBench(player.id, view.squad, view.startingIds, view.benchIds)
            setSelected(null)
          },
        })
      }
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
    } else {
      const sameOnField = view.startingIds
        .map((id) => view.squad.find((p) => p.id === id))
        .some((p) => p?.position === player.position)
      if (sameOnField) {
        actions.push({
          label: 'Swap into starting XI',
          onClick: () => {
            swapToStarting(player.id, view.squad, view.startingIds, view.benchIds)
            setSelected(null)
          },
        })
      }
    }
    return actions
  }

  return (
    <Layout title="Pick Team">
      <p className="text-xs text-white/50 mb-2">
        {liveView
          ? `Your actual squad from GW${myTeam.data?.picks_event}.`
          : "AI-recommended squad, ahead of your first deadline. Once you've picked a squad, this will track your actual picks."}
      </p>
      <div className="flex items-center justify-between mb-3 rounded-xl bg-[#1e1e2a] px-3 py-2">
        <p className="text-[11px] text-white/60">
          Tap a player to swap starters/bench or set captain — changes are a plan to apply on the official
          FPL app, not a live change.
        </p>
        {hasOverrides && (
          <button
            onClick={resetLineup}
            className="ml-2 shrink-0 min-h-[44px] px-3 rounded-lg bg-white/10 text-xs font-semibold text-white transition-colors active:bg-white/20"
          >
            Reset
          </button>
        )}
      </div>
      <PitchView
        squad={view.squad}
        startingIds={view.startingIds}
        benchIds={view.benchIds}
        captainId={view.captainId}
        viceCaptainId={view.viceCaptainId}
        onSelectPlayer={setSelected}
      />
      <PlayerDetailSheet
        player={selected}
        onClose={() => setSelected(null)}
        actions={selected ? actionsFor(selected) : []}
      />
    </Layout>
  )
}
