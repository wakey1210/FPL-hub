"""Tiny shared load/write helpers for the append-style JSON logs this project
keeps in data/ - see engine/accuracy.py (per-gameweek log) and
engine/price_history.py (per-day log) for the two current shapes built on
top of this. Each caller supplies its own path and empty-log default shape;
this module only owns the read-json-or-default / mkdir-and-write mechanics.
"""
from __future__ import annotations

import json
from pathlib import Path


def load_log(path: Path, default: dict) -> dict:
    if not path.exists():
        return default
    return json.loads(path.read_text())


def write_log(path: Path, log: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(log, indent=2))
