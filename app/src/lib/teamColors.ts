// Primary shirt colour per club, for the pitch view only (purely decorative).
// Not sourced from the FPL API (it doesn't publish kit colours) - a small,
// hand-maintained lookup is fine here. Falls back to a neutral grey for any
// club not listed (e.g. a newly promoted side not yet added).
export const TEAM_COLORS: Record<string, string> = {
  ARS: '#EF0107',
  AVL: '#670E36',
  BOU: '#DA291C',
  BRE: '#e30613',
  BHA: '#0057B8',
  BUR: '#6C1D45',
  CHE: '#034694',
  CRY: '#1B458F',
  EVE: '#003399',
  FUL: '#000000',
  IPS: '#0044A9',
  LEE: '#FFCD00',
  LEI: '#003090',
  LIV: '#C8102E',
  MCI: '#6CABDD',
  MUN: '#DA291C',
  NEW: '#241F20',
  NFO: '#DD0000',
  SOU: '#D71920',
  SUN: '#E11B22',
  TOT: '#132257',
  WHU: '#7A263A',
  WOL: '#FDB913',
}

export function teamColor(shortName: string): string {
  return TEAM_COLORS[shortName] ?? '#5B5B6B'
}
