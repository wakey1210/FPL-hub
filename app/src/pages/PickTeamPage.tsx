import { useMemo, useState } from 'react'
import { useJsonData } from '../lib/data'
import { Layout, LoadingState, ErrorState } from '../components/Layout'
import { PitchView } from '../components/PitchView'
import { PlayerDetailSheet } from '../components/PlayerDetailSheet'
import type { PlayerEV, SquadRecommendation } from '../types/fpl'
import type { MyTeam } from '../types/myTeam'

export function PickTeamPage() {
  const squadRec = useJsonData<SquadRecommendation>('squad_recommendation.json')
  const myTeam = useJsonData<MyTeam>('my_team.json')
  const allPlayers = useJsonData<PlayerEV[]>('players.json')
  const [selected, setSelected] = useState<PlayerEV | null>(null)

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

  const view = liveView ?? (squadRec.data
    ? {
        squad: squadRec.data.squad,
        startingIds: squadRec.data.starting_ids,
        benchIds: squadRec.data.bench_ids,
        captainId: squadRec.data.captain_id,
        viceCaptainId: squadRec.data.vice_captain_id,
      }
    : null)

  if (!view) return <Layout title="Pick Team"><ErrorState message={squadRec.error ?? 'no data'} /></Layout>

  return (
    <Layout title="Pick Team">
      <p className="text-xs text-white/50 mb-3">
        {liveView
          ? `Your actual squad from GW${myTeam.data?.picks_event}.`
          : "AI-recommended squad, ahead of your first deadline. Once you've picked a squad, this will track your actual picks."}
      </p>
      <PitchView
        squad={view.squad}
        startingIds={view.startingIds}
        benchIds={view.benchIds}
        captainId={view.captainId}
        viceCaptainId={view.viceCaptainId}
        onSelectPlayer={setSelected}
      />
      <PlayerDetailSheet player={selected} onClose={() => setSelected(null)} />
    </Layout>
  )
}
