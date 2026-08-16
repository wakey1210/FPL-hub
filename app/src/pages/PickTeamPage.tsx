import { useState } from 'react'
import { useJsonData } from '../lib/data'
import { Layout, LoadingState, ErrorState } from '../components/Layout'
import { PitchView } from '../components/PitchView'
import { PlayerDetailSheet } from '../components/PlayerDetailSheet'
import type { PlayerEV, SquadRecommendation } from '../types/fpl'

export function PickTeamPage() {
  const squad = useJsonData<SquadRecommendation>('squad_recommendation.json')
  const [selected, setSelected] = useState<PlayerEV | null>(null)

  if (squad.loading) return <Layout title="Pick Team"><LoadingState /></Layout>
  if (squad.error || !squad.data) return <Layout title="Pick Team"><ErrorState message={squad.error ?? 'no data'} /></Layout>

  return (
    <Layout title="Pick Team">
      <p className="text-xs text-white/50 mb-3">
        AI-recommended squad, ahead of your first deadline. Once you set your team ID in More, this will
        track your actual picks.
      </p>
      <PitchView
        squad={squad.data.squad}
        startingIds={squad.data.starting_ids}
        benchIds={squad.data.bench_ids}
        captainId={squad.data.captain_id}
        viceCaptainId={squad.data.vice_captain_id}
        onSelectPlayer={setSelected}
      />
      <PlayerDetailSheet player={selected} onClose={() => setSelected(null)} />
    </Layout>
  )
}
