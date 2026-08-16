"""Fetch data from the official (unofficial/undocumented) FPL API.

The API has no published rate limits but is unofficial, so we fetch politely:
a descriptive User-Agent, short timeouts, a couple of retries, and we only hit
`element-summary` for a bounded number of players (not all 587) to keep each
pipeline run fast and light.
"""
from __future__ import annotations

import time
from typing import Any

import requests

BASE = "https://fantasy.premierleague.com/api"
HEADERS = {
    "User-Agent": "FPL-hub/0.1 (personal project; contact via github.com/wakey1210/FPL-hub)"
}
TIMEOUT = 15
RETRIES = 3


def _get(path: str, **params: Any) -> Any:
    url = f"{BASE}/{path}"
    last_err: Exception | None = None
    for attempt in range(RETRIES):
        try:
            resp = requests.get(url, headers=HEADERS, params=params, timeout=TIMEOUT)
            resp.raise_for_status()
            return resp.json()
        except Exception as exc:  # noqa: BLE001 - want to retry on anything transient
            last_err = exc
            if attempt < RETRIES - 1:
                time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"Failed to fetch {url}: {last_err}") from last_err


def get_bootstrap() -> dict:
    """Players, teams, gameweeks (events), chips, scoring config."""
    return _get("bootstrap-static/")


def get_fixtures(event: int | None = None) -> list[dict]:
    """All fixtures, or fixtures for a single gameweek if `event` is given."""
    if event is not None:
        return _get("fixtures/", event=event)
    return _get("fixtures/")


def get_element_summary(player_id: int) -> dict:
    """Per-GW history (this season) and history_past (prior seasons) for one player."""
    return _get(f"element-summary/{player_id}/")


def get_event_live(event: int) -> dict:
    """Actual per-player stats/points for a gameweek - `elements` is empty
    until that gameweek's matches have actually been played."""
    return _get(f"event/{event}/live/")


def get_entry(team_id: int) -> dict:
    return _get(f"entry/{team_id}/")


def get_entry_history(team_id: int) -> dict:
    return _get(f"entry/{team_id}/history/")


def get_entry_transfers(team_id: int) -> list[dict]:
    return _get(f"entry/{team_id}/transfers/")


def get_entry_picks(team_id: int, event: int) -> dict:
    """Only available once the deadline for `event` has passed."""
    return _get(f"entry/{team_id}/event/{event}/picks/")
