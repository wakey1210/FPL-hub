"""Live ML inference: loads `model.json` + `model_meta.json` (written by
`engine/ml/train.py`) and computes `ml_ev`/`ml_uncertainty`/`ml_why` per
player, using the exact same `features.build_feature_row()` every training
row used - see that module's docstring for why this eliminates train/serve
feature skew by construction.

Predicts `points90` (points beyond the deterministic appearance bonus, per
90 minutes - the same target `train.py` fits against) for each upcoming
fixture, then converts back to a fixture-level EV using the same
appearance-points/minutes-profile scaling `engine/model.py` already applies
(so playing-time discipline isn't lost to the tree ensemble), and sums
across the forecast window - directly comparable in scale to `total_ev`.

Every call here is optional and additive: if `model.json` doesn't exist yet
(no `retrain-model.yml` run has ever completed), `model_available()` returns
False and the caller should simply skip ML predictions entirely - never a
hard dependency of the main pipeline.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import shap
import xgboost as xgb

from engine.model import PlayerEV
from engine.ml.features import FEATURE_NAMES, build_feature_row

MODEL_PATH = Path(__file__).resolve().parent / "model.json"
META_PATH = Path(__file__).resolve().parent / "model_meta.json"

# Too little in-season signal exists before this gameweek for the ML
# prediction to be trustworthy - engine/pipeline.py gates surfacing it (not
# computing it - it still trains/logs quietly) on this.
MIN_GAMEWEEK_FOR_ML = 6

FEATURE_LABELS = {
    "xg90": "expected goals per 90",
    "xa90": "expected assists per 90",
    "dc90": "defensive contribution rate",
    "saves90": "save rate",
    "dc_prob": "defensive-contribution bonus chance",
    "p_appearance": "chance of playing",
    "p_60_plus": "chance of a long appearance",
    "expected_minutes_if_appears": "expected minutes when playing",
    "fdr": "fixture difficulty",
    "is_home": "home advantage",
    "attack_mult": "attacking fixture strength",
    "cs_prob": "clean-sheet probability",
    "expected_conceded": "expected goals conceded",
    "now_cost": "price",
    "selected_by_percent": "ownership",
    "has_penalties": "penalty-taker role",
    "has_direct_freekicks": "free-kick-taker role",
    "has_corners": "corner-taker role",
    "position_GKP": "goalkeeper position",
    "position_DEF": "defender position",
    "position_MID": "midfielder position",
    "position_FWD": "forward position",
}


def model_available() -> bool:
    return MODEL_PATH.exists() and META_PATH.exists()


def _load() -> tuple[xgb.Booster, dict]:
    booster = xgb.Booster()
    booster.load_model(str(MODEL_PATH))
    meta = json.loads(META_PATH.read_text())
    return booster, meta


def add_ml_predictions(players: list[PlayerEV], bootstrap: dict) -> None:
    """Mutates each `PlayerEV` in place, setting `ml_ev`/`ml_uncertainty`/
    `ml_why` from the trained model - a no-op (fields stay at their
    dataclass defaults) if `model.json` doesn't exist.
    """
    if not model_available():
        return
    booster, meta = _load()
    holdout_rmse = meta.get("holdout_rmse") or 2.5
    elements_by_id = {e["id"]: e for e in bootstrap["elements"]}
    scoring = bootstrap["game_config"]["scoring"]

    rows: list[dict] = []
    row_index: list[tuple[PlayerEV, int]] = []  # (player, fixture_index)
    for player in players:
        element = elements_by_id.get(player.id)
        if not element:
            continue
        for i, fixture in enumerate(player.fixtures):
            rows.append(build_feature_row(player, fixture, element))
            row_index.append((player, i))

    if not rows:
        return

    X = np.array([[row[name] for name in FEATURE_NAMES] for row in rows])
    dmatrix = xgb.DMatrix(X, feature_names=FEATURE_NAMES)
    predicted_points90 = booster.predict(dmatrix)

    explainer = shap.TreeExplainer(booster)
    shap_values = explainer.shap_values(X)

    per_player_shap: dict[int, np.ndarray] = {}
    long_play, short_play = scoring["long_play"], scoring["short_play"]
    for (player, fixture_idx), pred, shap_row in zip(row_index, predicted_points90, shap_values):
        fixture = player.fixtures[fixture_idx]
        appearance_pts = player.p_appearance * short_play + player.p_60_plus * (long_play - short_play)
        # Scales the rate-based prediction by expected playing time and
        # appearance probability, the same convention build_player_ev uses
        # for its own attacking/defensive point components.
        fixture.ml_points = round(
            float(appearance_pts + pred * (player.expected_minutes_if_appears / 90) * player.p_appearance), 2
        )
        per_player_shap.setdefault(player.id, np.zeros(len(FEATURE_NAMES)))
        per_player_shap[player.id] += np.abs(shap_row)

    for player in players:
        if player.id not in per_player_shap:
            continue
        player.ml_ev = round(sum(f.ml_points for f in player.fixtures), 2)
        player.ml_uncertainty = round(holdout_rmse * (player.p_appearance or 0.1), 2)
        top_features = sorted(
            zip(FEATURE_NAMES, per_player_shap[player.id]), key=lambda kv: -kv[1]
        )[:3]
        player.ml_why = [FEATURE_LABELS.get(name, name) for name, _ in top_features if _ > 0]
