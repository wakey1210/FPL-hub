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

from engine import accuracy, fetch, model, model_changes, my_team, optimise, planner, price_history, priors, transfers
from engine.ml import predict as ml_predict

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
COEFFICIENTS_PATH = Path(__file__).resolve().parent / "calibration" / "coefficients.json"
TEAM_STRENGTH_PATH = Path(__file__).resolve().parent / "calibration" / "team_strength.json"
ODDS_PATH = DATA_DIR / "odds.json"
UNDERSTAT_PATH = DATA_DIR / "understat_xg.json"


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
    team_strength = json.loads(TEAM_STRENGTH_PATH.read_text()) if TEAM_STRENGTH_PATH.exists() else None
    odds = json.loads(ODDS_PATH.read_text()) if ODDS_PATH.exists() else None
    understat = json.loads(UNDERSTAT_PATH.read_text()) if UNDERSTAT_PATH.exists() else None

    print(
        f"Building expected-points model... "
        f"({len(player_priors)} player priors, "
        f"{'calibrated' if coefficients else 'default'} coefficients, "
        f"{'loaded' if team_strength else 'no'} team-strength data, "
        f"{odds['fixtures_matched'] if odds else 0} odds-priced fixtures, "
        f"{len(understat['players']) if understat else 0} understat-matched players)"
    )
    players = model.build_player_ev(
        bootstrap,
        fixtures,
        priors=player_priors,
        coefficients=coefficients,
        team_strength=team_strength,
        odds=odds,
        understat=understat,
    )
    if ml_predict.model_available():
        print("Adding parallel ML prediction (engine/ml/predict.py)...")
        ml_predict.add_ml_predictions(players, bootstrap)

    players_by_id = {p.id: p for p in players}

    generated_at = datetime.now(timezone.utc).isoformat()

    # Must run before data/players.json is overwritten below (line ~232) -
    # this diffs against whatever's still on disk from the previous run.
    model_changes_out = model_changes.build_model_changes(players, generated_at)

    print("Tracking prediction accuracy...")
    if next_event:
        accuracy.record_predictions(players, next_event["id"], generated_at)
    accuracy.score_finished_gameweeks(fixtures)
    accuracy_out = accuracy.summary()
    ml_status = accuracy.ml_form()
    # Always computed/logged above regardless - only gates whether the app
    # actually surfaces ml_ev/ml_why, never whether it's tracked. Also
    # requires a handful of real gameweeks to have been played first (too
    # little in-season signal before then) - see engine/ml/predict.py.
    ml_eligible = (
        ml_predict.model_available()
        and current_event is not None
        and current_event["id"] >= ml_predict.MIN_GAMEWEEK_FOR_ML
        and accuracy.ml_currently_better()
    )

    print("Recording daily price history and price-move risk...")
    now_utc = datetime.now(timezone.utc)
    price_history.record_prices(players, now_utc)
    price_moves_out = price_history.build_price_moves(
        players, generated_at, bootstrap["total_players"], now_utc
    )

    print("Optimising initial squad...")
    squad_result = optimise.select_squad(players)

    meta = {
        "generated_at": generated_at,
        "season_started": model.season_started(fixtures),
        "forecast_gameweeks": model.FORECAST_GAMEWEEKS,
        "current_gameweek": current_event["id"] if current_event else None,
        "next_gameweek": next_event["id"] if next_event else None,
        "next_deadline": next_event["deadline_time"] if next_event else None,
        "model_version": "v1-heuristic",
        "player_priors_loaded": len(player_priors),
        "coefficients_loaded": coefficients is not None,
        "coefficients_generated_at": coefficients.get("generated_at") if coefficients else None,
        "team_strength_loaded": team_strength is not None,
        "team_strength_generated_at": team_strength.get("generated_at") if team_strength else None,
        "odds_loaded": odds is not None,
        "odds_generated_at": odds.get("generated_at") if odds else None,
        "odds_fixtures_matched": odds.get("fixtures_matched") if odds else 0,
        "understat_loaded": understat is not None,
        "understat_generated_at": understat.get("generated_at") if understat else None,
        "understat_players_matched": len(understat["players"]) if understat else 0,
        "ml_model_loaded": ml_predict.model_available(),
        "ml_eligible": ml_eligible,
        "ml_status": ml_status,
    }

    teams = [
        {
            "id": t["id"],
            "code": t["code"],
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
        "starting_ids": squad_result.starting_ids,
        "bench_ids": squad_result.bench_ids,
        "captain_id": squad_result.captain_id,
        "vice_captain_id": squad_result.vice_captain_id,
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
            sell_prices = transfers.compute_sell_prices(
                team_data["picks"], team_data["transfers"], players_by_id
            )

            suggestions = transfers.suggest_transfers(
                squad=current_squad,
                all_players=players,
                bank=bank,
                free_transfers=free_transfers,
                sell_prices=sell_prices,
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
                season_started=model.season_started(fixtures),
                sell_prices=sell_prices,
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
    _write_json("price_moves.json", price_moves_out)
    _write_json("model_changes.json", model_changes_out)
    print("Pipeline complete.")


if __name__ == "__main__":
    run()
