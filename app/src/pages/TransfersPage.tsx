import { useMemo, useState } from 'react'
import { useJsonData } from '../lib/data'
import { Layout, LoadingState, ErrorState } from '../components/Layout'
import { PlayerRow } from '../components/PlayerRow'
import { PlayerDetailSheet } from '../components/PlayerDetailSheet'
import type { PlayerEV, Position } from '../types/fpl'

const POSITIONS: (Position | 'ALL')[] = ['ALL', 'GKP', 'DEF', 'MID', 'FWD']

export function TransfersPage() {
  const players = useJsonData<PlayerEV[]>('players.json')
  const [query, setQuery] = useState('')
  const [position, setPosition] = useState<Position | 'ALL'>('ALL')
  const [selected, setSelected] = useState<PlayerEV | null>(null)

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

  return (
    <Layout title="Transfers">
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search player..."
        className="w-full rounded-xl bg-[#1e1e2a] px-3 py-2 text-sm mb-3 placeholder:text-white/30 outline-none"
      />
      <div className="flex gap-2 mb-3">
        {POSITIONS.map((pos) => (
          <button
            key={pos}
            onClick={() => setPosition(pos)}
            className={`px-3 py-1 rounded-full text-xs font-semibold ${
              position === pos ? 'bg-[#00ff87] text-black' : 'bg-[#1e1e2a] text-white/60'
            }`}
          >
            {pos}
          </button>
        ))}
      </div>
      <p className="text-[11px] text-white/40 mb-2">Sorted by projected points, next {players.data[0]?.fixtures.length ?? 6} GWs</p>
      <div className="space-y-1.5">
        {filtered.map((p) => (
          <PlayerRow key={p.id} player={p} onClick={() => setSelected(p)} />
        ))}
      </div>
      <PlayerDetailSheet player={selected} onClose={() => setSelected(null)} />
    </Layout>
  )
}
