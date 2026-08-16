"""Tracks the model's real-world prediction error, gameweek by gameweek.

Every run before a gameweek's deadline, this snapshots that gameweek's
predicted points per player (overwriting the same slot with the freshest
pre-deadline prediction each time - team news lands late, so a Friday
prediction should replace Tuesday's guess). Once that gameweek is actually
played, it's scored against real results and locked - a scored gameweek is
never overwritten, so the logged number is always what the model genuinely
said beforehand, not adjusted with hindsight.

This is the anti-FFH feature made concrete: FFH publishes no accuracy
record at all. This one is visible in-app from the first scored gameweek,
whatever it says.
"""
from __future__ import annotations

import json
from pathlib import Path

from engine import fetch
from engine.model import PlayerEV

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
LOG_PATH = DATA_DIR / "accuracy_log.json"


def _load_log() -> dict:
    if not LOG_PATH.exists():
        return {"gameweeks": {}}
    return json.loads(LOG_PATH.read_text())


def _write_log(log: dict) -> None:
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    LOG_PATH.write_text(json.dumps(log, indent=2))


def record_predictions(players: list[PlayerEV], event: int, generated_at: str) -> None:
    """Snapshots this run's prediction for `event` (the next unplayed
    gameweek). Safe to call every pipeline run - see module docstring for why
    overwriting an unscored entry is correct and scored ones are protected.
    """
    log = _load_log()
    gw_key = str(event)
    if log["gameweeks"].get(gw_key, {}).get("scored"):
        return

    predictions = {}
    for p in players:
        fixture = next((f for f in p.fixtures if f.event == event), None)
        if fixture is not None:
            predictions[str(p.id)] = fixture.points

    log["gameweeks"][gw_key] = {
        "event": event,
        "generated_at": generated_at,
        "predictions": predictions,
        "scored": False,
        "actuals": None,
        "rmse": None,
        "mae": None,
        "n": None,
    }
    _write_log(log)


def score_finished_gameweeks(bootstrap: dict) -> None:
    """Fetches actual results for any gameweek that's finished but not yet
    scored, and computes RMSE/MAE (player-gameweek granularity, matching how
    the OpenFPL benchmark quoted in the README is reported) against the
    prediction that was on record for it.
    """
    log = _load_log()
    changed = False
    finished_events = {e["id"] for e in bootstrap["events"] if e["finished"]}

    for entry in log["gameweeks"].values():
        event = entry["event"]
        if entry["scored"] or event not in finished_events:
            continue

        live = fetch.get_event_live(event)
        actuals = {str(el["id"]): el["stats"]["total_points"] for el in live.get("elements", [])}
        if not actuals:
            continue  # marked finished but live stats not populated yet - retry next run

        errors = [
            entry["predictions"][pid] - actuals[pid]
            for pid in entry["predictions"]
            if pid in actuals
        ]
        if not errors:
            continue

        n = len(errors)
        entry["actuals"] = actuals
        entry["mae"] = round(sum(abs(e) for e in errors) / n, 3)
        entry["rmse"] = round((sum(e * e for e in errors) / n) ** 0.5, 3)
        entry["n"] = n
        entry["scored"] = True
        changed = True

    if changed:
        _write_log(log)


def summary() -> list[dict]:
    """Scored gameweeks, most recent first, with the (large) `actuals` map
    stripped out - the frontend only needs the aggregate numbers."""
    log = _load_log()
    scored = [gw for gw in log["gameweeks"].values() if gw["scored"]]
    scored.sort(key=lambda gw: -gw["event"])
    return [{k: v for k, v in gw.items() if k not in ("predictions", "actuals")} for gw in scored]
