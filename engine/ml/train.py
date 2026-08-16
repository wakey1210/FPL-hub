"""Trains the OpenFPL-style parallel ML prediction (XGBoost gradient-boosted
trees) - a genuinely trained model, refit from scratch every time this runs,
alongside (never replacing) `engine/model.py`'s transparent heuristic.

**Training window, confirmed by inspecting the actual cached CSVs (not
assumed)**: only 2022-23 onward has BOTH `position`/`team` name columns AND
xG/xA stats (`expected_goals`/`expected_assists` etc.) - vaastav's earlier
seasons (2018-19 through 2021-22) are missing one or both, since FPL only
started publishing Opta xG data around 2022-23. Extending further back for
more training volume (considered in the original design) isn't actually
viable: it would either crash (`position`/`team` columns don't exist before
2020-21) or silently inject rows with a permanently-zero xG signal
(2020-21/2021-22 have `position`/`team` but no xG columns) that would teach
the model an incorrect "xG=0 sometimes still means average points" pattern.
So this trains on the same 4 seasons `engine/calibration/fit_coefficients.py`'s
ridge regression already uses, **plus the current season's own gameweeks
already played** - refetched fresh every run via `fetch_historical.fetch_season`
(vaastav's repo publishes the current season too, updated through 2026-27).
That refetch is what makes this "retrain every gameweek as real results come
in": a full retrain naturally picks up whatever new gameweeks just landed in
the cache, no incremental-update machinery needed.

**Full retrain from scratch every run, not incremental boosting-continuation**
- cheap at this data scale (seconds) and far more robust/reproducible/
rollback-able than extending an existing tree ensemble with new rounds: there's
no clean way to "forget" a wrong-at-the-time tree, and a mid-sequence model is
a bad diff/rollback point (see the plan's reasoning for this explicit choice).
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import xgboost as xgb

from engine import model
from engine.calibration.fetch_historical import SEASONS, fetch_season
from engine.historical.bootstrap import _load_season_data, build_bootstrap_for_gw, build_priors_for_gw
from engine.ml.features import FEATURE_NAMES, build_feature_row, points90_target

OUTPUT_DIR = Path(__file__).resolve().parent
MODEL_PATH = OUTPUT_DIR / "model.json"
META_PATH = OUTPUT_DIR / "model_meta.json"

CURRENT_SEASON = "2026-27"  # bump manually each year, same as fetch_historical.SEASONS
MIN_MINUTES_FOR_ROW = 30  # matches fit_coefficients.py's own threshold
HOLDOUT_SEASON = SEASONS[-1]
XGB_PARAMS = {
    "max_depth": 4,
    "eta": 0.1,
    "subsample": 0.8,
    "colsample_bytree": 0.8,
    "objective": "reg:squarederror",
    "eval_metric": "rmse",
}
NUM_BOOST_ROUND = 200


def _training_seasons() -> list[str]:
    """Historical seasons + the current season if it has any real gameweeks
    played yet - pre-season, this correctly resolves to historical-only,
    same cold-start posture as everything else in this project.
    """
    seasons = list(SEASONS)
    try:
        fetch_season(CURRENT_SEASON, force=True)
        merged_gw_rows, _, _ = _load_season_data(CURRENT_SEASON)
        if any(int(r["GW"]) >= 2 for r in merged_gw_rows):
            seasons.append(CURRENT_SEASON)
        else:
            print(f"  {CURRENT_SEASON} cached but no completed gameweeks yet - historical seasons only")
    except Exception as exc:  # noqa: BLE001 - not yet published is expected pre-season, not an error
        print(f"  {CURRENT_SEASON} not yet available ({exc}) - using historical seasons only")
    return seasons


def _rows_for_season(season: str) -> tuple[list[dict], list[float]]:
    merged_gw_rows, _, _ = _load_season_data(season)
    last_gw = max(int(r["GW"]) for r in merged_gw_rows)

    features: list[dict] = []
    targets: list[float] = []
    for gw in range(2, last_gw + 1):  # GW1 has zero historical signal by construction - see bootstrap.py
        bootstrap, fixtures = build_bootstrap_for_gw(season, gw)
        priors = build_priors_for_gw(season, gw)
        players = model.build_player_ev(bootstrap, fixtures, forecast_gws=1, priors=priors)
        elements_by_id = {e["id"]: e for e in bootstrap["elements"]}
        real_rows = {int(r["element"]): r for r in merged_gw_rows if int(r["GW"]) == gw}

        for player in players:
            if not player.fixtures:
                continue
            real = real_rows.get(player.id)
            if not real:
                continue
            minutes = int(real["minutes"] or 0)
            if minutes < MIN_MINUTES_FOR_ROW:
                continue
            element = elements_by_id.get(player.id)
            if not element:
                continue
            features.append(build_feature_row(player, player.fixtures[0], element))
            targets.append(points90_target(int(real["total_points"] or 0), minutes))

    return features, targets


def train() -> dict:
    seasons = _training_seasons()
    print(f"Training on seasons: {seasons}")

    all_features: list[dict] = []
    all_targets: list[float] = []
    season_boundaries: dict[str, tuple[int, int]] = {}
    for season in seasons:
        start = len(all_features)
        feats, targs = _rows_for_season(season)
        all_features.extend(feats)
        all_targets.extend(targs)
        season_boundaries[season] = (start, len(all_features))
        print(f"  {season}: {len(feats)} rows")

    X = np.array([[row[name] for name in FEATURE_NAMES] for row in all_features])
    y = np.array(all_targets)

    holdout_start, holdout_end = season_boundaries.get(HOLDOUT_SEASON, (len(X), len(X)))
    train_mask = np.ones(len(X), dtype=bool)
    train_mask[holdout_start:holdout_end] = False

    holdout_rmse = None
    if (~train_mask).any() and train_mask.any():
        dtrain = xgb.DMatrix(X[train_mask], label=y[train_mask], feature_names=FEATURE_NAMES)
        dtest = xgb.DMatrix(X[~train_mask], label=y[~train_mask], feature_names=FEATURE_NAMES)
        holdout_booster = xgb.train(XGB_PARAMS, dtrain, num_boost_round=NUM_BOOST_ROUND)
        preds = holdout_booster.predict(dtest)
        holdout_rmse = round(float(np.sqrt(np.mean((preds - y[~train_mask]) ** 2))), 3)

    # Ship a model fit on ALL rows (train+holdout) - the holdout split above is
    # purely to report an honest out-of-sample diagnostic, matching
    # fit_coefficients.py's own convention.
    dall = xgb.DMatrix(X, label=y, feature_names=FEATURE_NAMES)
    final_booster = xgb.train(XGB_PARAMS, dall, num_boost_round=NUM_BOOST_ROUND)
    final_booster.save_model(str(MODEL_PATH))

    meta = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "seasons": seasons,
        "holdout_season": HOLDOUT_SEASON,
        "holdout_rmse": holdout_rmse,
        "n_obs": len(X),
        "feature_names": FEATURE_NAMES,
        "xgb_params": XGB_PARAMS,
        "num_boost_round": NUM_BOOST_ROUND,
    }
    META_PATH.write_text(json.dumps(meta, indent=2))
    print(f"wrote {MODEL_PATH} and {META_PATH} ({len(X)} rows, holdout RMSE={holdout_rmse})")
    return meta


if __name__ == "__main__":
    train()
