import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useJsonData } from '../lib/data'
import { Layout, LoadingState, ErrorState } from '../components/Layout'
import { PlayerRow } from '../components/PlayerRow'
import { usePlannedChanges } from '../lib/usePlannedChanges'
import { useDeclaredTeam } from '../lib/useDeclaredTeam'
import { squadAtEvent, bankAndFreeTransfersAtEvent } from '../lib/squadTimeline'
import { formatPrice } from '../lib/format'
import type { PlayerEV } from '../types/fpl'

interface NavState {
  outPlayerId: number
  event: number
}

/** Full-screen replacement search, reached from a player's "Transfer" action
 * on Pick Team - a real page instead of a fixed-position bottom sheet
 * (ReplacementPicker's old role) so the search input and list behave like a
 * normal page under an iOS keyboard instead of fighting a percentage-height
 * sheet for space. Position-locked, but not budget-filtered - a genuinely
 * common plan ("sell an expensive player, then use the freed cash plus a
 * cheaper sale elsewhere") needs picking the expensive replacement before
 * the funds to cover it exist yet. Budget is only enforced when the whole
 * batch is reviewed on ConfirmTransfersPage. */
export function AddPlayerPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const state = location.state as NavState | null
  const players = useJsonData<PlayerEV[]>('players.json')
  const { plan, addStagedTransfer } = usePlannedChanges()
  const { declared } = useDeclaredTeam()
  const [query, setQuery] = useState('')

  const backToPickTeam = () => navigate(state ? `/pick-team?gw=${state.event}` : '/pick-team')

  if (players.loading) return <Layout title="Add Player" onBack={backToPickTeam} showNav={false}><LoadingState /></Layout>
  if (players.error || !players.data) {
    return <Layout title="Add Player" onBack={backToPickTeam} showNav={false}><ErrorState message={players.error ?? 'no data'} /></Layout>
  }
  if (!state || !declared.squadIds) {
    return <Layout title="Add Player" onBack={backToPickTeam} showNav={false}><ErrorState message="No player selected to replace." /></Layout>
  }

  const { outPlayerId, event } = state
  const outPlayer = players.data.find((p) => p.id === outPlayerId)
  if (!outPlayer) {
    return <Layout title="Add Player" onBack={backToPickTeam} showNav={false}><ErrorState message="Player not found." /></Layout>
  }

  const squadAtView = squadAtEvent(declared.squadIds, players.data, plan.stagedTransfers, event)
  const { bank } = bankAndFreeTransfersAtEvent(declared, plan.stagedTransfers, event)
  const budget = bank + outPlayer.now_cost
  const excluded = new Set(squadAtView.map((p) => p.id))

  const options = players.data
    .filter((p) => p.position === outPlayer.position)
    .filter((p) => !excluded.has(p.id))
    .filter((p) => p.web_name.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => b.total_ev - a.total_ev)
    .slice(0, 100)

  const handlePick = (inPlayer: PlayerEV) => {
    const { freeTransfers } = bankAndFreeTransfersAtEvent(declared, plan.stagedTransfers, event - 1)
    const usedSoFarThisWeek = plan.stagedTransfers.filter((t) => t.event === event).length
    addStagedTransfer({
      outId: outPlayer.id,
      inId: inPlayer.id,
      outName: outPlayer.web_name,
      inName: inPlayer.web_name,
      hitCost: usedSoFarThisWeek >= freeTransfers ? 4 : 0,
      costDelta: inPlayer.now_cost - outPlayer.now_cost,
      event,
    })
    backToPickTeam()
  }

  return (
    <Layout title="Add Player" onBack={backToPickTeam} showNav={false}>
      <div className="rounded-xl bg-surface px-4 py-3 mb-3">
        <p className="text-sm text-white/60">Replacing</p>
        <p className="text-base font-semibold">
          {outPlayer.web_name} · {outPlayer.position}
        </p>
        <p className={`text-sm font-semibold mt-1 ${budget < 0 ? 'text-danger' : 'text-primary'}`}>
          Budget: {formatPrice(budget)}
        </p>
      </div>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search player..."
        className="w-full rounded-xl bg-surface px-3 py-2.5 text-base mb-3 placeholder:text-white/30 outline-none"
        autoFocus
      />
      <div className="space-y-1.5">
        {options.map((p) => (
          <PlayerRow key={p.id} player={p} onClick={() => handlePick(p)} />
        ))}
        {options.length === 0 && (
          <p className="text-sm text-white/40 text-center py-6">No {outPlayer.position} match.</p>
        )}
      </div>
    </Layout>
  )
}
