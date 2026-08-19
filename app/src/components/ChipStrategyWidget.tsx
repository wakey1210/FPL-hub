import { CHIP_LABELS, CHIP_ORDER, chipStatus } from '../lib/chipStatus'

const STATUS_STYLES: Record<string, string> = {
  used: 'bg-white/5 text-white/40',
  recommended: 'bg-primary/15 text-primary border border-primary/40',
  locked: 'bg-white/5 text-white/40',
  available: 'bg-white/10 text-white/70',
}

interface Props {
  chipsUsed: { name: string; event: number }[]
  currentEvent: number | null
  recommendedByChip: Record<string, number>
}

/** At-a-glance chip status - inspired by how well FFH surfaces "which chips
 * do I have left and when should I use them" as a single persistent widget,
 * rather than burying it inside individual gameweek cards. */
export function ChipStrategyWidget({ chipsUsed, currentEvent, recommendedByChip }: Props) {
  return (
    <div className="rounded-xl bg-surface p-3 mb-5">
      <p className="text-sm font-semibold mb-2">Your chip strategy</p>
      <div className="grid grid-cols-2 gap-2">
        {CHIP_ORDER.map((chip) => {
          const result = chipStatus(chip, chipsUsed, currentEvent, recommendedByChip[chip])
          return (
            <div key={chip} className={`rounded-lg px-3 py-2 ${STATUS_STYLES[result.status]}`}>
              <p className="text-xs font-semibold">{CHIP_LABELS[chip]}</p>
              <p className="text-[11px]">{result.detail}</p>
            </div>
          )
        })}
      </div>
    </div>
  )
}
