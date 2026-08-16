"""One-time/annual download of historical per-gameweek data used to fit
`fit_coefficients.py`'s regression.

This is static, finished-season data (it never changes once a season ends),
so it's fetched into a local, gitignored cache rather than re-pulled by any
scheduled job - re-run manually only when a new season has completed and you
want to include it in the next calibration refit.

Source: vaastav/Fantasy-Premier-League (community-maintained, actively
updated through 2026/27), which has per-player-gameweek CSVs going back to
2016-17 - far richer than the live FPL API's `history_past` (season
aggregates only), which is what makes fitting a real regression possible.
"""
from __future__ import annotations

from pathlib import Path

import requests

CACHE_DIR = Path(__file__).resolve().parent / "cache"
SEASONS = ["2022-23", "2023-24", "2024-25", "2025-26"]
BASE_URL = "https://raw.githubusercontent.com/vaastav/Fantasy-Premier-League/master/data"
HEADERS = {"User-Agent": "FPL-hub/0.1 (personal project; contact via github.com/wakey1210/FPL-hub)"}


def _fetch_file(url: str, dest: Path, force: bool) -> Path:
    if dest.exists() and not force:
        print(f"  {dest.name}: already cached")
        return dest
    resp = requests.get(url, headers=HEADERS, timeout=30)
    resp.raise_for_status()
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(resp.content)
    print(f"  {dest.name}: downloaded ({len(resp.content):,} bytes)")
    return dest


def fetch_season(season: str, force: bool = False) -> tuple[Path, Path]:
    """Downloads both the per-gameweek stats and the fixtures list (for FDR -
    merged_gw.csv has no difficulty column of its own, so fixtures.csv is
    joined in later on the `fixture`/`id` columns)."""
    print(f"{season}:")
    gws = _fetch_file(f"{BASE_URL}/{season}/gws/merged_gw.csv", CACHE_DIR / season / "merged_gw.csv", force)
    fixtures = _fetch_file(f"{BASE_URL}/{season}/fixtures.csv", CACHE_DIR / season / "fixtures.csv", force)
    return gws, fixtures


def fetch_all(seasons: list[str] = SEASONS, force: bool = False) -> list[tuple[Path, Path]]:
    return [fetch_season(s, force=force) for s in seasons]


if __name__ == "__main__":
    import sys

    fetch_all(force="--force" in sys.argv)
