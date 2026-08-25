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

interface Props {
  s: TransferSuggestion
  onAdd?: () => void
  added?: boolean
}

export function TransferSuggestionCard({ s, onAdd, added }: Props) {
  return (
    <div className="rounded-xl bg-surface p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="space-y-1.5">
          <MiniChip label={`OUT  ${s.out.web_name}`} teamShort={s.out.team_short} />
          <MiniChip label={`IN  ${s.in.web_name}`} teamShort={s.in.team_short} />
          {s.out_sell_price != null && s.out_sell_price !== s.out.now_cost && (
            <p className="text-[10px] text-white/40 pl-4">sells for {formatPrice(s.out_sell_price)}</p>
          )}
        </div>
        <div className="text-right shrink-0">
          <p className={`text-lg font-bold ${s.net_gain > 0 ? 'text-success' : 'text-danger'}`}>
            {s.net_gain > 0 ? '+' : ''}
            {s.net_gain.toFixed(1)}
          </p>
          <p className="text-[10px] text-white/40">
            {s.cost_delta > 0 ? '+' : ''}
            {formatPrice(s.cost_delta)}
          </p>
        </div>
      </div>
      {s.rationale?.length > 0 && (
        <ul className="mt-2 space-y-0.5">
          {s.rationale.map((line, i) => (
            <li key={i} className="text-[11px] text-white/60 leading-snug">
              {line}
            </li>
          ))}
        </ul>
      )}
      {onAdd && (
        <button
          onClick={onAdd}
          disabled={added}
          className={`w-full mt-3 min-h-[44px] rounded-lg text-sm font-semibold transition-colors active:opacity-80 ${
            added ? 'bg-white/10 text-white/50' : 'bg-primary text-primary-foreground'
          }`}
        >
          {added ? 'Added to plan' : 'Add to plan'}
        </button>
      )}
    </div>
  )
}
