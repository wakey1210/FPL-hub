import { useState } from 'react'
import type { PlayerEV } from '../types/fpl'
import { BottomSheet } from './BottomSheet'
import { PlayerSheetHeader } from './player-sheet/PlayerSheetHeader'
import { PlayerStatRow } from './player-sheet/PlayerStatRow'
import { WhyAndFixturesTab } from './player-sheet/WhyAndFixturesTab'
import { SeasonStatsTab } from './player-sheet/SeasonStatsTab'

export interface SheetAction {
  label: string
  onClick: () => void
  variant?: 'primary' | 'secondary'
}

export interface CaptainState {
  isCaptain: boolean
  isViceCaptain: boolean
  onToggleCaptain: () => void
  onToggleVice: () => void
}

interface Props {
  player: PlayerEV | null
  onClose: () => void
  actions?: SheetAction[]
  captainState?: CaptainState
}

type Tab = 'fixtures' | 'season'

const TABS: { id: Tab; label: string }[] = [
  { id: 'fixtures', label: 'Fixtures & rating' },
  { id: 'season', label: 'Season stats' },
]

/** Bottom sheet with the transparent "why" behind a player's EV - the
 * anti-black-box feature that differentiates this from FFH's AI picker.
 * `actions` renders clear, tappable CTAs (Substitute, Transfer, ...);
 * `captainState`, when provided, renders always-visible Captain/Vice-captain
 * checkboxes above them, matching the official app's pattern instead of two
 * buttons that disappear once toggled.
 *
 * This is the orchestrator: it owns tab state and composes the header/stat
 * row/tab-content pieces under components/player-sheet/. The "why" bullets
 * and fixture list (WhyAndFixturesTab) stay the default tab and are never
 * buried below the new photo header or season-stats tab - see that
 * component's own comment for why that matters.
 *
 * Callers MUST render this with `key={player?.id ?? 'closed'}` (see
 * PickTeamPage/TransfersPage) - without it, React keeps the same component
 * instance mounted across different players (the parent always renders this
 * unconditionally), so `tab` state here and the `failed` image-fallback
 * state in the nested PlayerAvatar/TeamBadge would otherwise leak from one
 * player's sheet into the next player's. */
export function PlayerDetailSheet({ player, onClose, actions, captainState }: Props) {
  const [tab, setTab] = useState<Tab>('fixtures')

  if (!player) return null

  return (
    <BottomSheet onClose={onClose}>
      <PlayerSheetHeader player={player} onClose={onClose} />

      {captainState && (
        <div className="flex gap-4 mb-3">
          <label className="flex items-center gap-2 text-sm text-white/80 min-h-[44px]">
            <input
              type="checkbox"
              checked={captainState.isCaptain}
              onChange={(e) => e.target.checked && captainState.onToggleCaptain()}
              className="w-4 h-4"
            />
            Captain
          </label>
          <label className="flex items-center gap-2 text-sm text-white/80 min-h-[44px]">
            <input
              type="checkbox"
              checked={captainState.isViceCaptain}
              onChange={(e) => e.target.checked && captainState.onToggleVice()}
              className="w-4 h-4"
            />
            Vice-captain
          </label>
        </div>
      )}

      {actions && actions.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-4">
          {actions.map((a) => (
            <button
              key={a.label}
              onClick={a.onClick}
              className={`min-h-[44px] px-4 rounded-xl text-sm font-semibold transition-colors active:opacity-80 ${
                a.variant === 'secondary'
                  ? 'bg-white/10 text-white'
                  : 'bg-primary text-primary-foreground'
              }`}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}

      <PlayerStatRow player={player} />

      {player.news && (
        <p className="text-sm text-warning bg-warning/10 rounded-lg p-2 mb-4">{player.news}</p>
      )}

      <div className="flex gap-1 mb-4 bg-white/5 rounded-lg p-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex-1 min-h-[36px] rounded-md text-xs font-semibold transition-colors ${
              tab === t.id ? 'bg-primary text-primary-foreground' : 'text-white/60'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'fixtures' ? <WhyAndFixturesTab player={player} /> : <SeasonStatsTab player={player} />}
    </BottomSheet>
  )
}
