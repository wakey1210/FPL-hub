"""Fits the EV model's heuristic adjustment factors to historical outcomes,
replacing hand-picked round numbers with values derived from real data.

This is explicitly NOT a black-box model: it's a small ridge regression
(closed-form, plain numpy) per position, and every fitted number is written
to `coefficients.json` in the open alongside its own fit diagnostics
(R-squared, holdout RMSE, sample size), so anyone (including future-us) can
see exactly how confident each number should be.

Important methodological guard: the regression predicts each player-
gameweek's "performance points" (total_points minus the deterministic
appearance points for having played) from stats that are conceivably
knowable/forecastable ahead of a fixture - expected_goals, expected_assists,
defensive_contribution, fixture difficulty, home/away. It deliberately does
NOT use bps/ict_index/influence/creativity/threat as predictors, because
those are themselves largely *derived from* that match's bonus-point
ranking - fitting on them would mostly rediscover the official bonus
formula in a roundabout way, not reveal anything about forecastable
underlying quality.

Run manually (or via a workflow_dispatch-only Action) after a season closes
out - this is rare, not part of the 3-hourly hot loop. Always inspect the
printed old-vs-new diff and the holdout backtest before trusting the result.
"""
from __future__ import annotations

import csv
import json
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from engine.calibration.fetch_historical import CACHE_DIR, SEASONS
from engine.model import FDR_ATTACK_MULT as HAND_PICKED_FDR_ATTACK_MULT

OUTPUT_PATH = Path(__file__).resolve().parent / "coefficients.json"

POSITION_MAP = {"GK": "GKP", "DEF": "DEF", "MID": "MID", "FWD": "FWD"}  # "AM" (manager) rows are dropped
MIN_MINUTES_FOR_ROW = 30  # below this a per-90 rate is too noisy to include in the fit
DC_THRESHOLDS = {"DEF": 10, "MID": 12, "FWD": 12}
# A single, fairly strong, fixed lambda - not picked per-position by holdout RMSE.
# Overall points90-prediction RMSE barely moves with lambda for low-signal positions
# (DEF's points come mostly from clean sheets/bonus, not xG/xA), so an automatic
# per-position search would happily pick near-zero regularization for exactly the
# position whose fdr coefficient is noisiest - which is what produced a degenerate,
# clipped-at-the-bound multiplier table on the first attempt. A fixed, moderately
# strong lambda keeps every position's fitted curve sane; holdout RMSE is still
# reported at that lambda as a diagnostic, just not used to choose it.
RIDGE_LAMBDA = 50.0
FDR_VALUES = [1, 2, 3, 4, 5]
BASELINE_FDR = 3
FDR_MULT_BOUNDS = (0.6, 1.6)
# How much of a position's fitted fdr_attack_mult to trust vs. shrink back
# toward the original hand-picked curve, scaled by that position's R-squared.
# DEF's points come mostly from clean sheets/bonus rather than xG/xA, so a
# regression using only xG/xA/fdr/home-away explains very little of a
# defender's variance (R2 ~0.09 in practice) - trusting it fully produced a
# degenerate, bound-clipped curve on the first fit. Below this R2, the fitted
# curve is blended with (not replaced by) the sensible hand-picked default,
# proportional to how much real signal the fit actually has.
R2_FULL_TRUST = 0.20


def _to_float(value: str | None) -> float:
    try:
        return float(value) if value not in (None, "") else 0.0
    except ValueError:
        return 0.0


def load_season_rows(season: str) -> list[dict]:
    """Joins merged_gw.csv with fixtures.csv (for FDR - merged_gw.csv has no
    difficulty column of its own) and returns cleaned player-gameweek rows.
    """
    cache = CACHE_DIR / season
    with open(cache / "fixtures.csv", newline="") as f:
        fixtures_by_id = {r["id"]: r for r in csv.DictReader(f)}

    rows = []
    with open(cache / "merged_gw.csv", newline="") as f:
        has_dc = "defensive_contribution" in csv.DictReader(f).fieldnames  # type: ignore[union-attr]

    with open(cache / "merged_gw.csv", newline="") as f:
        for r in csv.DictReader(f):
            position = POSITION_MAP.get(r["position"])
            if position is None:
                continue
            minutes = int(r["minutes"] or 0)
            if minutes < MIN_MINUTES_FOR_ROW:
                continue
            fixture = fixtures_by_id.get(r["fixture"])
            if fixture is None:
                continue

            is_home = r["was_home"] == "True"
            fdr_raw = fixture["team_h_difficulty"] if is_home else fixture["team_a_difficulty"]
            if not fdr_raw:
                continue
            fdr = int(fdr_raw)
            total_points = int(r["total_points"] or 0)
            appearance_pts = 2 if minutes >= 60 else 1
            scale = 90 / minutes

            dc_raw = _to_float(r.get("defensive_contribution")) if has_dc else None
            rows.append(
                {
                    "season": season,
                    "position": position,
                    "points90": (total_points - appearance_pts) * scale,
                    "xg90": _to_float(r.get("expected_goals")) * scale,
                    "xa90": _to_float(r.get("expected_assists")) * scale,
                    "dc90": dc_raw * scale if dc_raw is not None else None,
                    "dc_raw": dc_raw,  # for the per-match threshold check, unscaled
                    "fdr": fdr,
                    "is_home": 1.0 if is_home else 0.0,
                    "clean_sheet": int(r.get("clean_sheets") or 0),
                    "goals_conceded": int(r.get("goals_conceded") or 0),
                }
            )
    return rows


def _fit_ridge(X: np.ndarray, y: np.ndarray, lam: float) -> np.ndarray:
    """Closed-form ridge regression with an unregularized intercept."""
    n, k = X.shape
    X1 = np.hstack([np.ones((n, 1)), X])
    reg = np.eye(k + 1) * lam
    reg[0, 0] = 0.0
    beta = np.linalg.solve(X1.T @ X1 + reg, X1.T @ y)
    return beta


def _predict(beta: np.ndarray, X: np.ndarray) -> np.ndarray:
    X1 = np.hstack([np.ones((X.shape[0], 1)), X])
    return X1 @ beta


def _rmse(pred: np.ndarray, actual: np.ndarray) -> float:
    return float(np.sqrt(np.mean((pred - actual) ** 2)))


def _r_squared(pred: np.ndarray, actual: np.ndarray) -> float:
    ss_res = np.sum((actual - pred) ** 2)
    ss_tot = np.sum((actual - actual.mean()) ** 2)
    return float(1 - ss_res / ss_tot) if ss_tot > 0 else 0.0


def fit_position_model(rows: list[dict], position: str, holdout_season: str | None) -> dict:
    """Fits points90 ~ xg90 + xa90 + fdr + is_home via ridge regression at a
    fixed lambda (see RIDGE_LAMBDA), reporting holdout RMSE as a diagnostic.
    """
    train_rows = [r for r in rows if r["season"] != holdout_season] if holdout_season else rows
    test_rows = [r for r in rows if r["season"] == holdout_season] if holdout_season else []

    def to_xy(subset: list[dict]) -> tuple[np.ndarray, np.ndarray]:
        X = np.array([[r["xg90"], r["xa90"], r["fdr"], r["is_home"]] for r in subset])
        y = np.array([r["points90"] for r in subset])
        return X, y

    holdout_rmse = None
    if test_rows:
        X_train, y_train = to_xy(train_rows)
        X_test, y_test = to_xy(test_rows)
        train_beta = _fit_ridge(X_train, y_train, RIDGE_LAMBDA)
        holdout_rmse = round(_rmse(_predict(train_beta, X_test), y_test), 3)

    # Ship coefficients fit on ALL available rows (train+holdout) - the holdout split
    # above is purely to report an honest out-of-sample RMSE, not to pick hyperparameters.
    X_all, y_all = to_xy(rows)
    final_beta = _fit_ridge(X_all, y_all, RIDGE_LAMBDA)
    intercept, coef_xg90, coef_xa90, coef_fdr, coef_is_home = final_beta

    baseline_points90 = float(y_all.mean())
    r_squared = round(_r_squared(_predict(final_beta, X_all), y_all), 3)
    trust = max(0.0, min(1.0, r_squared / R2_FULL_TRUST))
    hand_picked = HAND_PICKED_FDR_ATTACK_MULT

    fdr_attack_mult_fitted = {
        str(f): round(
            max(FDR_MULT_BOUNDS[0], min(FDR_MULT_BOUNDS[1], 1 + coef_fdr * (f - BASELINE_FDR) / baseline_points90)), 3
        )
        for f in FDR_VALUES
    }
    # Blend toward the hand-picked default when the fit has little real signal
    # to offer (see R2_FULL_TRUST) rather than trusting a noisy fit outright.
    fdr_attack_mult = {
        str(f): round(trust * fdr_attack_mult_fitted[str(f)] + (1 - trust) * hand_picked[f], 3)
        for f in FDR_VALUES
    }

    return {
        "lambda": RIDGE_LAMBDA,
        "holdout_rmse": holdout_rmse,
        "r_squared": r_squared,
        "fit_trust": round(trust, 3),
        "n_obs": len(rows),
        "coef_xg90": round(float(coef_xg90), 3),
        "coef_xa90": round(float(coef_xa90), 3),
        "coef_is_home": round(float(coef_is_home), 3),
        "baseline_points90": round(baseline_points90, 3),
        "fdr_attack_mult_fitted": fdr_attack_mult_fitted,
        "fdr_attack_mult": fdr_attack_mult,
    }


def fit_clean_sheet_tables(rows: list[dict]) -> dict:
    """Empirical (not regressed) clean-sheet rate and expected-goals-conceded
    by FDR bucket - simple conditional means, shared across positions since
    both are team-level facts, not position-specific.
    Note: rows are one-per-player-per-match, so a single fixture is counted
    once per player who featured in it (mild pseudo-replication) - this
    doesn't bias the estimated rate/mean itself, just slightly overstates
    how much independent data backs it.
    """
    by_fdr: dict[int, list[dict]] = {}
    for r in rows:
        by_fdr.setdefault(r["fdr"], []).append(r)

    cs_prob, expected_conceded = {}, {}
    for f in FDR_VALUES:
        bucket = by_fdr.get(f, [])
        if not bucket:
            continue
        cs_prob[str(f)] = round(sum(r["clean_sheet"] for r in bucket) / len(bucket), 3)
        expected_conceded[str(f)] = round(sum(r["goals_conceded"] for r in bucket) / len(bucket), 3)
    return {"fdr_clean_sheet_prob": cs_prob, "fdr_expected_conceded": expected_conceded}


def fit_dc_damping(rows: list[dict]) -> dict:
    """Defensive contribution scoring only exists from 2025/26 onward, so
    this is fit on a single season - lower confidence, flagged as such, and
    not backtested (there's no earlier season with the stat to hold out).

    Calibrates how much of the model's naive "per-90 rate / threshold"
    probability estimate is actually realized match-to-match, since hitting
    a discrete per-match threshold from a continuous season-average rate
    isn't a sure thing even when the average rate matches the threshold.
    """
    by_position: dict[str, list[dict]] = {}
    for r in rows:
        if r["dc_raw"] is None or r["position"] not in DC_THRESHOLDS:
            continue
        by_position.setdefault(r["position"], []).append(r)

    damping_by_position = {}
    for position, pos_rows in by_position.items():
        threshold = DC_THRESHOLDS[position]
        naive_probs, actual_hits = [], []
        for r in pos_rows:
            naive_probs.append(min(r["dc90"] / threshold, 1.0))
            actual_hits.append(1.0 if r["dc_raw"] >= threshold else 0.0)
        naive_probs, actual_hits = np.array(naive_probs), np.array(actual_hits)
        # Ratio of actually-observed hit rate to the naive rate/threshold estimate,
        # only where the naive estimate is large enough to divide by meaningfully.
        mask = naive_probs > 0.1
        damping_by_position[position] = round(
            float(np.clip(np.mean(actual_hits[mask]) / np.mean(naive_probs[mask]), 0.3, 1.0)), 3
        ) if mask.any() else 0.85

    return {"dc_damping_by_position": damping_by_position, "dc_n_obs": len(rows)}


def run(seasons: list[str] = SEASONS, holdout_season: str = SEASONS[-1]) -> dict:
    all_rows = []
    for season in seasons:
        all_rows.extend(load_season_rows(season))
    print(f"Loaded {len(all_rows)} player-gameweek rows across {seasons}")

    positions_out = {}
    for position in ["DEF", "MID", "FWD"]:
        pos_rows = [r for r in all_rows if r["position"] == position]
        fit = fit_position_model(pos_rows, position=position, holdout_season=holdout_season)
        fit.update(fit_clean_sheet_tables(pos_rows))
        positions_out[position] = fit
        print(
            f"  {position}: n={fit['n_obs']} R2={fit['r_squared']} "
            f"holdout_rmse={fit['holdout_rmse']} fdr_attack_mult={fit['fdr_attack_mult']}"
        )

    # GKP: no attacking coefficients (xg/xa near-irrelevant), just the shared CS/conceded tables.
    gkp_rows = [r for r in all_rows if r["position"] == "GKP"]
    positions_out["GKP"] = {"n_obs": len(gkp_rows), **fit_clean_sheet_tables(gkp_rows)}

    dc_rows = [r for r in all_rows if r["season"] == "2025-26"]
    dc_fit = fit_dc_damping(dc_rows)
    print(f"  DC damping (2025-26 only, n={dc_fit['dc_n_obs']}): {dc_fit['dc_damping_by_position']}")

    for position, fit in positions_out.items():
        ordered = [fit.get("fdr_attack_mult", {}).get(str(f)) for f in FDR_VALUES]
        values = [v for v in ordered if v is not None]
        if values and values != sorted(values, reverse=True):
            print(f"  WARNING: {position}'s fdr_attack_mult isn't monotonically decreasing: {ordered}")

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source_seasons": seasons,
        "holdout_season": holdout_season,
        "positions": positions_out,
        "dc_damping_by_position": dc_fit["dc_damping_by_position"],
        "dc_n_obs": dc_fit["dc_n_obs"],
    }


def main() -> None:
    old = json.loads(OUTPUT_PATH.read_text()) if OUTPUT_PATH.exists() else None
    new = run()

    if old:
        print("\n--- old vs new fdr_attack_mult (DEF/MID/FWD) ---")
        for position in ["DEF", "MID", "FWD"]:
            old_mult = old.get("positions", {}).get(position, {}).get("fdr_attack_mult", {})
            new_mult = new["positions"][position]["fdr_attack_mult"]
            print(f"  {position}: old={old_mult} new={new_mult}")

    OUTPUT_PATH.write_text(json.dumps(new, indent=2))
    print(f"\nwrote {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
