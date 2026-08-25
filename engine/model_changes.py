"""Which players' predicted EV moved the most since the previous pipeline
run - "what changed" for the model itself, not the official price-change
tracking `price_history.py` already covers.

Needs no history log of its own: `engine/pipeline.py` writes every /data
file at the very end of a run, so `data/players.json` on disk is still the
*previous* run's content for the whole duration of this run - the "before"
snapshot to diff against is already sitting right there.
"""
from __future__ import annotations

import json
from pathlib import Path

from engine.model import PlayerEV

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
PLAYERS_PATH = DATA_DIR / "players.json"

TOP_N = 10


def _load_previous_players() -> dict[str, dict] | None:
    """The previous run's committed players.json, keyed by id as a string
    (matching JSON object-key convention elsewhere in this project) - `None`
    on the very first run, when there's nothing to diff against yet.
    """
    try:
        raw = json.loads(PLAYERS_PATH.read_text())
    except FileNotFoundError:
        return None
    return {str(p["id"]): p for p in raw}


def build_model_changes(players: list[PlayerEV], generated_at: str, top_n: int = TOP_N) -> dict:
    """Builds the `data/model_changes.json` payload: the biggest total_ev
    risers/fallers since the previous pipeline run. A player only present in
    one of the two snapshots (new signing, departure) is skipped - there's
    no meaningful "before" or "after" value to diff for them.
    """
    previous = _load_previous_players()

    def _row(p: PlayerEV, prev_ev: float) -> dict:
        return {
            "id": p.id,
            "web_name": p.web_name,
            "team_short": p.team_short,
            "position": p.position,
            "now_cost": p.now_cost,
            "prev_ev": prev_ev,
            "current_ev": p.total_ev,
            "ev_delta": round(p.total_ev - prev_ev, 2),
            "why": list(p.why[:2]),
        }

    if previous is None:
        return {"generated_at": generated_at, "has_previous": False, "risers": [], "fallers": []}

    deltas = []
    for p in players:
        prev = previous.get(str(p.id))
        if prev is None:
            continue  # new to the game since the previous run
        deltas.append(_row(p, prev["total_ev"]))

    risers = sorted((r for r in deltas if r["ev_delta"] > 0), key=lambda r: -r["ev_delta"])[:top_n]
    fallers = sorted((r for r in deltas if r["ev_delta"] < 0), key=lambda r: r["ev_delta"])[:top_n]

    return {
        "generated_at": generated_at,
        "has_previous": True,
        "risers": risers,
        "fallers": fallers,
    }
