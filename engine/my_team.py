"""Pulls one specific manager's team via the public FPL API.

No login is needed - a team's picks, transfers, chips, bank and value are
all public once you have the team ID (verified during research: `entry`,
`entry/history` and `entry/transfers` are open endpoints; only the picks for
a gameweek are gated, and only until that gameweek's deadline passes).

The team ID is supplied via the `FPL_TEAM_ID` environment variable (a GitHub
Actions repository variable, not a secret - team IDs aren't sensitive, since
this whole feature only works *because* they're public data) so the pipeline
can track one specific manager without a login or a backend.
"""
from __future__ import annotations

from engine import fetch

MAX_FREE_TRANSFERS = 5


def _estimate_free_transfers(current_history: list[dict], chips: list[dict]) -> int:
    """FPL doesn't publish "free transfers remaining" on any public endpoint
    (only the login-gated `my-team` does). We reconstruct it from the public
    per-gameweek history: +1 FT per gameweek played, minus transfers made,
    capped at 5, reset to 1 the gameweek after a Wildcard or Free Hit (which
    don't consume a free transfer). This is an estimate, not an official
    number - it can drift if a manager takes a hit mid-chip-window edge case.
    """
    chip_gw = {c["event"]: c["name"] for c in chips}
    free_transfers = 1
    for gw in current_history:
        made = gw["event_transfers"]
        free_transfers = max(0, free_transfers - made)
        free_transfers = min(MAX_FREE_TRANSFERS, free_transfers + 1)
        if chip_gw.get(gw["event"]) in ("wildcard", "freehit"):
            free_transfers = 1
    return free_transfers


def build_my_team(team_id: int) -> dict:
    entry = fetch.get_entry(team_id)
    history = fetch.get_entry_history(team_id)
    transfers = fetch.get_entry_transfers(team_id)

    current_history = history["current"]
    chips = history["chips"]
    latest_gw = current_history[-1] if current_history else None

    # Picks are only public once that gameweek's deadline has passed. Try the
    # most recent played gameweek; if none has been played yet this season
    # (e.g. pre-GW1), there's no squad to show yet.
    current_picks = None
    picks_event = latest_gw["event"] if latest_gw else None
    if picks_event:
        try:
            picks_data = fetch.get_entry_picks(team_id, picks_event)
            current_picks = picks_data["picks"]
        except Exception:  # noqa: BLE001 - genuinely optional data
            current_picks = None

    return {
        "team_id": team_id,
        "manager_name": f"{entry['player_first_name']} {entry['player_last_name']}",
        "team_name": entry["name"],
        "has_squad": current_picks is not None,
        "picks_event": picks_event,
        "picks": current_picks,
        "summary": {
            "overall_points": entry["summary_overall_points"],
            "overall_rank": entry["summary_overall_rank"],
            "gameweek_points": entry["summary_event_points"],
            "bank": latest_gw["bank"] if latest_gw else None,
            "team_value": latest_gw["value"] if latest_gw else None,
            "free_transfers_estimate": (
                _estimate_free_transfers(current_history, chips) if current_history else 1
            ),
        },
        "chips_used": chips,
        "transfers_made_this_season": len(transfers),
        "gw_history": current_history,
        "recent_seasons": history["past"][-5:],
    }
