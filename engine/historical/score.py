"""Compares a simulated season (real transfer/squad decisions) against a
pick-once-and-hold baseline run through the exact same harness - isolates
how much value the transfer/planner logic itself adds, separate from the
underlying point-prediction quality (that's `fit_coefficients.py`'s holdout
RMSE). Real average-manager/top-10k benchmarks are out of scope for v1 -
not reliably available from the data sources already in use.
"""
from __future__ import annotations

from dataclasses import dataclass

from engine.historical.run_season import DEFAULT_END_GW, SeasonResult, run_season


@dataclass
class SeasonComparison:
    season: str
    strategy_total: int
    baseline_total: int
    uplift: int


def compare_to_baseline(
    season: str, start_gw: int = 1, end_gw: int = DEFAULT_END_GW, coefficients: dict | None = None
) -> SeasonComparison:
    strategy: SeasonResult = run_season(season, start_gw, end_gw, coefficients, allow_transfers=True)
    baseline: SeasonResult = run_season(season, start_gw, end_gw, coefficients, allow_transfers=False)
    return SeasonComparison(
        season=season,
        strategy_total=strategy.total_points,
        baseline_total=baseline.total_points,
        uplift=strategy.total_points - baseline.total_points,
    )


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--season", required=True)
    parser.add_argument("--start-gw", type=int, default=1)
    parser.add_argument("--end-gw", type=int, default=DEFAULT_END_GW)
    args = parser.parse_args()

    comparison = compare_to_baseline(args.season, args.start_gw, args.end_gw)
    print(f"{comparison.season}:")
    print(f"  Strategy (transfers allowed): {comparison.strategy_total} pts")
    print(f"  Baseline (pick once, hold):   {comparison.baseline_total} pts")
    print(f"  Uplift from transfers:        {comparison.uplift:+d} pts")


if __name__ == "__main__":
    main()
