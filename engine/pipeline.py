"""Orchestrates fetch -> model -> optimise and writes the JSON the PWA reads.

Run with: python -m engine.pipeline
Outputs land in /data as latest-overwrite files (not per-run snapshots), so
the repo doesn't grow unbounded as GitHub Actions runs this on a schedule.
"""
from __future__ import annotations

import json
import os
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

from engine import accuracy, fetch, model, my_team, optimise, planner, priors, transfers

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
COEFFICIENTS_PATH = Path(__file__).resolve().parent / "calibration" / "coefficients.json"


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

    # Both of these are cheap local file reads - no HTTP calls - so the hot
    # loop's API-call count stays at 2 (bootstrap + fixtures) regardless.
    player_priors = priors.load_player_priors()
    coefficients = json.loads(COEFFICIENTS_PATH.read_text()) if COEFFICIENTS_PATH.exists() else None

    print(
        f"Building expected-points model... "
        f"({len(player_priors)} player priors, "
        f"{'calibrated' if coefficients else 'default'} coefficients)"
    )
    players = model.build_player_ev(bootstrap, fixtures, priors=player_priors, coefficients=coefficients)
    players_by_id = {p.id: p for p in players}

    generated_at = datetime.now(timezone.utc).isoformat()

    print("Tracking prediction accuracy...")
    if next_event:
        accuracy.record_predictions(players, next_event["id"], generated_at)
    accuracy.score_finished_gameweeks(bootstrap)
    accuracy_out = accuracy.summary()

    print("Optimising initial squad...")
    squad_result = optimise.select_squad(players)
    squad_players = [players_by_id[i] for i in squad_result.squad_ids]
    xi_result = optimise.select_starting_xi(squad_players)

    meta = {
        "generated_at": generated_at,
        "season_started": model.season_started(bootstrap),
        "forecast_gameweeks": model.FORECAST_GAMEWEEKS,
        "current_gameweek": current_event["id"] if current_event else None,
        "next_gameweek": next_event["id"] if next_event else None,
        "next_deadline": next_event["deadline_time"] if next_event else None,
        "model_version": "v1-heuristic",
        "player_priors_loaded": len(player_priors),
        "coefficients_loaded": coefficients is not None,
        "coefficients_generated_at": coefficients.get("generated_at") if coefficients else None,
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

    team_id_raw = os.environ.get("FPL_TEAM_ID")
    meta["team_configured"] = bool(team_id_raw)

    my_team_out: dict = {"configured": False}
    transfer_suggestions_out: dict = {"available": False, "reason": "No team configured"}
    transfer_plan_out: dict = {"available": False, "reason": "No team configured"}

    if team_id_raw:
        print(f"Fetching manager data for team {team_id_raw}...")
        team_data = my_team.build_my_team(int(team_id_raw))
        my_team_out = {"configured": True, **team_data}

        if team_data["has_squad"]:
            print("Building transfer suggestions...")
            current_squad = [
                players_by_id[pick["element"]]
                for pick in team_data["picks"]
                if pick["element"] in players_by_id
            ]
            bank = team_data["summary"]["bank"] or 0
            free_transfers = team_data["summary"]["free_transfers_estimate"]

            suggestions = transfers.suggest_transfers(
                squad=current_squad, all_players=players, bank=bank, free_transfers=free_transfers
            )
            transfer_suggestions_out = {
                "available": True,
                "free_transfers": free_transfers,
                "bank": bank,
                "suggestions": [
                    {
                        **asdict(s),
                        "out": asdict(players_by_id[s.out_id]),
                        "in": asdict(players_by_id[s.in_id]),
                    }
                    for s in suggestions
                ],
            }

            print("Building 5-week transfer/chip plan...")
            plan_start_event = next_event["id"] if next_event else 1
            plan_steps = planner.plan_transfers(
                squad=current_squad,
                all_players=players,
                bank=bank,
                free_transfers=free_transfers,
                chips_used=team_data["chips_used"],
                current_event=plan_start_event,
            )
            transfer_plan_out = {
                "available": True,
                "horizon_start": plan_start_event,
                "horizon_end": plan_start_event + len(plan_steps) - 1,
                "steps": [
                    {
                        **asdict(s),
                        "out": [asdict(players_by_id[i]) for i in s.transfers_out],
                        "in": [asdict(players_by_id[i]) for i in s.transfers_in],
                    }
                    for s in plan_steps
                ],
            }
        else:
            transfer_suggestions_out = {
                "available": False,
                "reason": "No squad picked yet for this season",
            }
            transfer_plan_out = {
                "available": False,
                "reason": "No squad picked yet for this season",
            }

    _write_json("meta.json", meta)
    _write_json("teams.json", teams)
    _write_json("players.json", players_out)
    _write_json("fixtures.json", fixture_ticker)
    _write_json("squad_recommendation.json", squad_out)
    _write_json("my_team.json", my_team_out)
    _write_json("transfer_suggestions.json", transfer_suggestions_out)
    _write_json("transfer_plan.json", transfer_plan_out)
    _write_json("accuracy_summary.json", accuracy_out)
    print("Pipeline complete.")


if __name__ == "__main__":
    run()
