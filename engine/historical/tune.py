"""Grid-search over a hand-picked constant, reusing `run_season` as the inner
loop and scoring each candidate by its backtested season total - explicitly
NOT gradient-based/RL tuning. No backprop, no reward-shaping, no optimizer:
this just runs the harness once per candidate value and prints an old-vs-new
table for a human to review before manually editing the constant in source,
matching `engine/calibration/fit_coefficients.py`'s existing "print the
diff, a human decides" discipline - nothing here is ever auto-applied.
"""
from __future__ import annotations

from dataclasses import dataclass

from engine import stabilize
from engine.historical.run_season import DEFAULT_END_GW, run_season


@dataclass
class GridPoint:
    value: float
    season_total: int


def sweep_stabilization_minutes(
    stat: str, candidate_values: list[float], season: str, start_gw: int = 1, end_gw: int = DEFAULT_END_GW
) -> list[GridPoint]:
    """Temporarily patches `stabilize.STAT_STABILIZATION_MINUTES[stat]` to
    each candidate value, runs a full season backtest, and restores the
    original value afterward - the patch never persists past this call.
    """
    original = stabilize.STAT_STABILIZATION_MINUTES[stat]
    results = []
    try:
        for value in candidate_values:
            stabilize.STAT_STABILIZATION_MINUTES[stat] = value
            season_result = run_season(season, start_gw, end_gw)
            results.append(GridPoint(value=value, season_total=season_result.total_points))
    finally:
        stabilize.STAT_STABILIZATION_MINUTES[stat] = original
    return results


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--season", required=True)
    parser.add_argument(
        "--stat", required=True, help="a key in stabilize.STAT_STABILIZATION_MINUTES, e.g. minutes_share"
    )
    parser.add_argument("--values", required=True, help="comma-separated candidate K values, e.g. 180,270,360,450")
    args = parser.parse_args()

    values = [float(v) for v in args.values.split(",")]
    original = stabilize.STAT_STABILIZATION_MINUTES[args.stat]
    results = sweep_stabilization_minutes(args.stat, values, args.season)

    print(f"{args.season} - sweeping stabilize.STAT_STABILIZATION_MINUTES['{args.stat}'] (current: {original})")
    print(f"{'K value':>10}  {'season total':>12}")
    for r in results:
        marker = " <- current" if r.value == original else ""
        print(f"{r.value:>10}  {r.season_total:>12}{marker}")
    print("\nNothing has been changed in source - review the table above and edit the constant by hand if warranted.")


if __name__ == "__main__":
    main()
