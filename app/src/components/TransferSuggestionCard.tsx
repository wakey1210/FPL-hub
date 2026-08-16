import type { TransferSuggestion } from '../types/transferSuggestions'
import { formatPrice } from '../lib/format'
import { teamColor } from '../lib/teamColors'

function MiniChip({ label, teamShort }: { label: string; teamShort: string }) {
  return (
    <div className="flex items-center gap-2">
      <span
        className="w-2 h-8 rounded-full shrink-0"
        style={{ backgroundColor: teamColor(teamShort) }}
      />
      <span className="text-sm font-semibold">{label}</span>
    </div>
  )
}

export function TransferSuggestionCard({ s }: { s: TransferSuggestion }) {
  return (
    <div className="rounded-xl bg-[#1e1e2a] p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="space-y-1.5">
          <MiniChip label={`OUT  ${s.out.web_name}`} teamShort={s.out.team_short} />
          <MiniChip label={`IN  ${s.in.web_name}`} teamShort={s.in.team_short} />
        </div>
        <div className="text-right shrink-0">
          <p className={`text-lg font-bold ${s.net_gain > 0 ? 'text-[#00ff87]' : 'text-rose-400'}`}>
            {s.net_gain > 0 ? '+' : ''}
            {s.net_gain.toFixed(1)}
          </p>
          <p className="text-[10px] text-white/40">
            {s.cost_delta > 0 ? '+' : ''}
            {formatPrice(s.cost_delta)}
          </p>
        </div>
      </div>
      {s.uses_hit && (
        <p className="text-[11px] text-amber-300 mt-2">Uses a -4 hit (no free transfer left)</p>
      )}
    </div>
  )
}
