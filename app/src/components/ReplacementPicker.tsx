import { useMemo, useState } from 'react'
import type { PlayerEV } from '../types/fpl'
import { PlayerRow } from './PlayerRow'

interface Props {
  outPlayer: PlayerEV
  allPlayers: PlayerEV[]
  excludeIds: number[]
  onPick: (player: PlayerEV) => void
  onClose: () => void
}

/** Position-locked replacement browser opened from a player's "Transfer out"
 * action - same search/sort pattern as TransfersPage.tsx's browse list
 * (reusing PlayerRow), just scoped to one position and excluding anyone
 * already in the squad being viewed, matching FFH's "in your team" exclusion. */
export function ReplacementPicker({ outPlayer, allPlayers, excludeIds, onPick, onClose }: Props) {
  const [query, setQuery] = useState('')
  const excluded = useMemo(() => new Set(excludeIds), [excludeIds])

  const options = useMemo(() => {
    return allPlayers
      .filter((p) => p.position === outPlayer.position)
      .filter((p) => p.id === outPlayer.id || !excluded.has(p.id))
      .filter((p) => p.web_name.toLowerCase().includes(query.toLowerCase()))
      .sort((a, b) => b.total_ev - a.total_ev)
      .slice(0, 100)
  }, [allPlayers, outPlayer, excluded, query])

  return (
    <div className="fixed inset-0 z-40 flex items-end bg-black/50" onClick={onClose}>
      <div
        className="w-full bg-[#1e1e2a] rounded-t-2xl p-5 pb-8 max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-start mb-3 shrink-0">
          <div>
            <h2 className="text-lg font-bold text-white">Replace {outPlayer.web_name}</h2>
            <p className="text-sm text-white/60">{outPlayer.position}</p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-white/60 text-2xl leading-none px-2 min-w-[44px] min-h-[44px] transition-colors active:text-white"
          >
            ×
          </button>
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search player..."
          className="w-full rounded-xl bg-white/5 px-3 py-2 text-sm mb-3 placeholder:text-white/30 outline-none shrink-0"
        />
        <div className="space-y-1.5 overflow-y-auto">
          {options.map((p) => (
            <PlayerRow key={p.id} player={p} onClick={() => onPick(p)} />
          ))}
          {options.length === 0 && (
            <p className="text-sm text-white/40 text-center py-6">No players match.</p>
          )}
        </div>
      </div>
    </div>
  )
}
