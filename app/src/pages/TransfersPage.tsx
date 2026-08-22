import { useMemo, useState } from 'react'
import { useJsonData } from '../lib/data'
import { Layout, LoadingState, ErrorState } from '../components/Layout'
import { PlayerFixtureTable } from '../components/PlayerFixtureTable'
import { PlayerDetailSheet } from '../components/PlayerDetailSheet'
import { TransferSuggestionCard } from '../components/TransferSuggestionCard'
import { StagedTransfersCart } from '../components/StagedTransfersCart'
import { usePlannedChanges } from '../lib/usePlannedChanges'
import { useDeclaredTeam } from '../lib/useDeclaredTeam'
import { suggestTransfers } from '../lib/transferSuggestions'
import { squadAtEvent, bankAndFreeTransfersAtEvent, liveTeamAsDeclared } from '../lib/squadTimeline'
import type { PlayerEV, Position, Meta } from '../types/fpl'
import type { MyTeam } from '../types/myTeam'
import type { TransferSuggestion, TransferSuggestions } from '../types/transferSuggestions'

const POSITIONS: (Position | 'ALL')[] = ['ALL', 'GKP', 'DEF', 'MID', 'FWD']

export function TransfersPage() {
  const players = useJsonData<PlayerEV[]>('players.json')
  const suggestions = useJsonData<TransferSuggestions>('transfer_suggestions.json')
  const myTeam = useJsonData<MyTeam>('my_team.json')
  const meta = useJsonData<Meta>('meta.json')
  const [query, setQuery] = useState('')
  const [position, setPosition] = useState<Position | 'ALL'>('ALL')
  const [selected, setSelected] = useState<PlayerEV | null>(null)
  const { plan, addStagedTransfer, removeStagedTransfer, clearStagedTransfers } = usePlannedChanges()
  const { declared } = useDeclaredTeam()

  const hasLiveTeam = myTeam.data?.configured && myTeam.data.has_squad && myTeam.data.picks
  const effectiveTeam = hasLiveTeam ? liveTeamAsDeclared(myTeam.data!) : declared
  const currentEvent = meta.data?.next_gameweek ?? meta.data?.current_gameweek ?? null

  // Client-side rolling suggestions from a declared (not live-synced) squad -
  // recomputes automatically whenever players.json refreshes or the staged-
  // transfers cart changes, off the same 3-hourly hot loop that already
  // refreshes players.json, no extra polling needed. The squad/bank/free
  // transfers used here already fold in everything staged up to and
  // including the next gameweek, so a suggestion never contradicts a
  // transfer already staged from Pick Team or an earlier suggestion.
  const declaredSuggestions = useMemo((): TransferSuggestion[] => {
    if (hasLiveTeam || !declared.squadIds || !players.data || currentEvent === null) return []
    const squad = squadAtEvent(declared.squadIds, players.data, plan.stagedTransfers, currentEvent)
    if (squad.length === 0) return []
    const { bank, freeTransfers } = bankAndFreeTransfersAtEvent(declared, plan.stagedTransfers, currentEvent)
    return suggestTransfers(squad, players.data, bank, freeTransfers).map((s) => ({
      out_id: s.outId,
      in_id: s.inId,
      ev_delta: s.evDelta,
      cost_delta: s.costDelta,
      net_gain: s.netGain,
      uses_hit: s.usesHit,
      rationale: s.rationale,
      out: s.out,
      in: s.in,
    }))
  }, [hasLiveTeam, declared, players.data, plan.stagedTransfers, currentEvent])

  const filtered = useMemo(() => {
    if (!players.data) return []
    return players.data
      .filter((p) => position === 'ALL' || p.position === position)
      .filter((p) => p.web_name.toLowerCase().includes(query.toLowerCase()))
      .sort((a, b) => b.total_ev - a.total_ev)
      .slice(0, 100)
  }, [players.data, query, position])

  if (players.loading) return <Layout title="Transfers"><LoadingState /></Layout>
  if (players.error || !players.data) return <Layout title="Transfers"><ErrorState message={players.error ?? 'no data'} /></Layout>

  const liveSuggestions = hasLiveTeam && suggestions.data?.available ? suggestions.data.suggestions ?? [] : []
  const activeSuggestions = hasLiveTeam ? liveSuggestions : declaredSuggestions
  const hasSuggestions = activeSuggestions.length > 0
  const isStaged = (outId: number, inId: number) =>
    plan.stagedTransfers.some((t) => t.outId === outId && t.inId === inId)

  return (
    <Layout title="Transfers">
      {hasSuggestions ? (
        <div className="mb-4">
          <div className="flex items-baseline justify-between mb-2">
            <p className="text-sm font-semibold">Suggested transfers</p>
            {hasLiveTeam && (
              <p className="text-[11px] text-white/40">{suggestions.data!.free_transfers} FT available</p>
            )}
          </div>
          {!hasLiveTeam && (
            <p className="text-[11px] text-white/40 mb-2">
              Based on your declared squad - will switch to your live FPL team once synced.
            </p>
          )}
          <div className="space-y-2">
            {activeSuggestions.map((s) => (
              <TransferSuggestionCard
                key={`${s.out_id}-${s.in_id}`}
                s={s}
                added={isStaged(s.out_id, s.in_id)}
                onAdd={() =>
                  addStagedTransfer({
                    outId: s.out_id,
                    inId: s.in_id,
                    outName: s.out.web_name,
                    inName: s.in.web_name,
                    hitCost: s.uses_hit ? 4 : 0,
                    costDelta: s.cost_delta,
                    event: currentEvent ?? 0,
                  })
                }
              />
            ))}
          </div>
        </div>
      ) : (
        !hasLiveTeam &&
        !declared.squadIds && (
          <div className="mb-4 rounded-xl bg-surface p-4">
            <p className="text-sm text-white/60">
              Confirm your squad on the Pick Team tab to see transfer suggestions.
            </p>
          </div>
        )
      )}

      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search player..."
        className="w-full rounded-xl bg-surface px-3 py-2 text-base mb-3 placeholder:text-white/30 outline-none"
      />
      <div className="flex gap-2 mb-3">
        {POSITIONS.map((pos) => (
          <button
            key={pos}
            onClick={() => setPosition(pos)}
            className={`min-h-[36px] px-3 py-1 rounded-full text-xs font-semibold transition-colors ${
              position === pos ? 'bg-primary text-primary-foreground' : 'bg-surface text-white/60'
            }`}
          >
            {pos}
          </button>
        ))}
      </div>
      <p className="text-[11px] text-white/40 mb-2">Sorted by projected points, next {players.data[0]?.fixtures.length ?? 6} GWs</p>
      <PlayerFixtureTable
        rows={filtered.map((player) => ({ player }))}
        fromEvent={currentEvent ?? 1}
        onSelectPlayer={setSelected}
      />
      {plan.stagedTransfers.length > 0 && <div className="h-28" />}
      <PlayerDetailSheet key={selected?.id ?? 'closed'} player={selected} onClose={() => setSelected(null)} />
      <StagedTransfersCart
        staged={plan.stagedTransfers}
        onRemove={(i) =>
          removeStagedTransfer(
            i,
            (event) => bankAndFreeTransfersAtEvent(effectiveTeam, plan.stagedTransfers, event - 1).freeTransfers
          )
        }
        onClear={clearStagedTransfers}
      />
    </Layout>
  )
}
