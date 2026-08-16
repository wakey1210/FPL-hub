"""Orchestrates fetch -> model -> optimise and writes the JSON the PWA reads.

Run with: python -m engine.pipeline
Outputs land in /data as latest-overwrite files (not per-run snapshots), so
the repo doesn't grow unbounded as GitHub Actions runs this on a schedule.
"""
from __future__ import annotations

import json
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

from engine import fetch, model, optimise

DATA_DIR = Path(__file__).resolve().parent.parent / "data"


def _write_json(name: str, payload: object) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    path = DATA_DIR / name
    path.write_text(json.dumps(payload, indent=2, default=str))
    print(f"wrote {path} ({path.stat().st_size:,} bytes)")


def run() -> None:
    print("Fetching bootstrap-static and fixtures...")
    bootstrap = fetch.get_bootstrap()
    fixtures = fetch.get_fixtures()

    events = bootstrap["events"]
    next_event = next((e for e in events if e["is_next"]), None)
    current_event = next((e for e in events if e["is_current"]), None)

    print("Building expected-points model...")
    players = model.build_player_ev(bootstrap, fixtures)
    players_by_id = {p.id: p for p in players}

    print("Optimising initial squad...")
    squad_result = optimise.select_squad(players)
    squad_players = [players_by_id[i] for i in squad_result.squad_ids]
    xi_result = optimise.select_starting_xi(squad_players)

    meta = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "season_started": model.season_started(bootstrap),
        "forecast_gameweeks": model.FORECAST_GAMEWEEKS,
        "current_gameweek": current_event["id"] if current_event else None,
        "next_gameweek": next_event["id"] if next_event else None,
        "next_deadline": next_event["deadline_time"] if next_event else None,
        "model_version": "v1-heuristic",
    }

    teams = [
        {
            "id": t["id"],
            "name": t["name"],
            "short_name": t["short_name"],
            "strength_overall_home": t["strength_overall_home"],
            "strength_overall_away": t["strength_overall_away"],
        }
        for t in bootstrap["teams"]
    ]

    players_out = [asdict(p) for p in players]
    fixture_ticker = model.build_fixture_ticker(bootstrap, fixtures)

    squad_out = {
        "budget_tenths": optimise.BUDGET_TENTHS,
        "total_cost": squad_result.total_cost,
        "total_ev": squad_result.total_ev,
        "squad": [asdict(players_by_id[i]) for i in squad_result.squad_ids],
        "starting_ids": xi_result.starting_ids,
        "bench_ids": xi_result.bench_ids,
        "captain_id": xi_result.captain_id,
        "vice_captain_id": xi_result.vice_captain_id,
    }

    _write_json("meta.json", meta)
    _write_json("teams.json", teams)
    _write_json("players.json", players_out)
    _write_json("fixtures.json", fixture_ticker)
    _write_json("squad_recommendation.json", squad_out)
    print("Pipeline complete.")


if __name__ == "__main__":
    run()
