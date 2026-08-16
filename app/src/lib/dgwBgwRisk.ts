/** Historically-elevated-risk gameweek windows for double/blank gameweeks -
 * base-rate context only, NOT a forecast of which specific club is affected.
 * Real double/blank gameweeks only emerge once a specific league fixture is
 * actually postponed and rearranged to make way for a domestic cup
 * quarter-/semi-final or final weekend - unknowable which club until each
 * cup round is drawn and played (cascading fully by March/April). FPL's own
 * FA Cup replays were abolished from 2024-25 specifically to reduce this
 * kind of fixture pile-up, so League Cup/FA Cup calendar collisions are now
 * the dominant cause, not replay overflow.
 *
 * These ranges are the calendar-fixed part - knowable pre-season, since the
 * cup calendar itself is fixed - not the club-specific part, which needs
 * live cup-progression data this project doesn't have (FPL's public API
 * covers the Premier League only). See engine/model.py's build_fixture_ticker
 * for the genuinely-computed (not forecast) double/blank detection this
 * complements.
 */
export interface RiskWindow {
  start: number
  end: number
  label: string
}

export const DGW_BGW_RISK_WINDOWS: RiskWindow[] = [
  { start: 24, end: 29, label: 'League Cup final proximity - DGWs/BGWs have landed here in recent seasons' },
  { start: 26, end: 34, label: 'FA Cup QF/SF proximity - DGWs/BGWs have landed here in recent seasons' },
]

export function riskWindowsForGw(gw: number): RiskWindow[] {
  return DGW_BGW_RISK_WINDOWS.filter((w) => gw >= w.start && gw <= w.end)
}
