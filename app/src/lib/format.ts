export function formatPrice(nowCost: number): string {
  return `£${(nowCost / 10).toFixed(1)}m`
}

/** FDR 1 (easiest) -> 5 (hardest), matching the official app's green-to-red scale. */
export function fdrClasses(fdr: number): string {
  switch (fdr) {
    case 1:
      return 'bg-emerald-500 text-white'
    case 2:
      return 'bg-emerald-300 text-emerald-950'
    case 3:
      return 'bg-slate-300 text-slate-900'
    case 4:
      return 'bg-rose-400 text-white'
    default:
      return 'bg-rose-700 text-white'
  }
}

export function formatDeadline(iso: string | null): string {
  if (!iso) return 'TBC'
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function countdownParts(iso: string | null): { days: number; hours: number; minutes: number } | null {
  if (!iso) return null
  const diffMs = new Date(iso).getTime() - Date.now()
  if (diffMs <= 0) return { days: 0, hours: 0, minutes: 0 }
  const totalMinutes = Math.floor(diffMs / 60000)
  return {
    days: Math.floor(totalMinutes / 1440),
    hours: Math.floor((totalMinutes % 1440) / 60),
    minutes: totalMinutes % 60,
  }
}
