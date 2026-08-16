// Mirrors engine/planner.py's CHIP_WINDOWS - verified live from the 26/27
// bootstrap["chips"] data: Wildcard/Free Hit playable from GW2, Bench Boost/
// Triple Captain from GW1, both halves splitting at the GW19/20 boundary.
const CHIP_WINDOWS: Record<string, [number, number][]> = {
  wildcard: [
    [2, 19],
    [20, 38],
  ],
  freehit: [
    [2, 19],
    [20, 38],
  ],
  bboost: [
    [1, 19],
    [20, 38],
  ],
  '3xc': [
    [1, 19],
    [20, 38],
  ],
}

export const CHIP_LABELS: Record<string, string> = {
  wildcard: 'Wildcard',
  freehit: 'Free Hit',
  bboost: 'Bench Boost',
  '3xc': 'Triple Captain',
}

export const CHIP_ORDER = ['wildcard', 'freehit', 'bboost', '3xc']

export interface ChipStatusResult {
  status: 'used' | 'recommended' | 'locked' | 'available'
  detail: string
}

export function chipStatus(
  name: string,
  chipsUsed: { name: string; event: number }[],
  currentEvent: number | null,
  recommendedEvent: number | undefined
): ChipStatusResult {
  const usedEvents = chipsUsed.filter((c) => c.name === name).map((c) => c.event)
  const windows = CHIP_WINDOWS[name] ?? []
  const remaining = windows.filter((w) => !usedEvents.some((e) => e >= w[0] && e <= w[1]))

  if (remaining.length === 0) {
    const last = usedEvents[usedEvents.length - 1]
    return { status: 'used', detail: last ? `Used GW${last}` : 'Used' }
  }
  if (recommendedEvent !== undefined) {
    return { status: 'recommended', detail: `Recommended GW${recommendedEvent}` }
  }
  const nextWindowStart = remaining[0][0]
  if (currentEvent !== null && currentEvent < nextWindowStart) {
    return { status: 'locked', detail: `Available from GW${nextWindowStart}` }
  }
  return { status: 'available', detail: 'Not set' }
}
