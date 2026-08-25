import type { Position } from './fpl'

/** Mirrors data/model_changes.json (engine/model_changes.py) - the biggest
 * predicted-EV movers since the previous pipeline run, diffed from
 * data/players.json's own previous-run snapshot (no separate history log
 * needed). `has_previous` is false only on the very first pipeline run
 * ever, when there's nothing yet to diff against. */
export interface ModelChangeRow {
  id: number
  web_name: string
  team_short: string
  position: Position
  now_cost: number
  prev_ev: number
  current_ev: number
  ev_delta: number
  why: string[]
}

export interface ModelChanges {
  generated_at: string
  has_previous: boolean
  risers: ModelChangeRow[]
  fallers: ModelChangeRow[]
}
