"""Multi-season per-player priors: a recency-and-minutes-weighted blend of
each player's own last few completed seasons.

Gives the model a sturdier personal baseline than a single (possibly thin or
noisy) season - a player who missed half of last season through injury
shouldn't have their per-90 rate dictated purely by those few games.
`element-summary/{id}/history_past` (season aggregates, one row per prior
season) is the right granularity for this - richer per-gameweek history for
formula *calibration* lives in `engine/calibration/`, which is a separate,
much rarer job.

Fetching this for every player is 587 HTTP calls - much heavier than the
3-hourly pipeline's 2-call bootstrap+fixtures fetch - so this runs on its own
weekly schedule (see .github/workflows/refresh-priors.yml) and caches to
data/player_priors.json; the main pipeline just reads that file.
"""
from __future__ import annotations

import json
import sys
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

from engine import fetch

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
CACHE_PATH = DATA_DIR / "player_priors.json"

SEASON_WEIGHTS = [3, 2, 1]  # most-recent season first, up to 3 seasons
MIN_MINUTES_FOR_SEASON = 450  # ~5 full matches - below this a season is too thin to trust
REQUEST_PAUSE = 0.2  # polite pacing across ~587 sequential calls
RATE_FIELDS = [
    "expected_goals",
    "expected_assists",
    "expected_goal_involvements",
    "defensive_contribution",
    "saves",
    "starts",
]
FULL_SEASON_MINUTES = 38 * 90
FULL_SEASON_MATCHES = 38


@dataclass
class PlayerPrior:
    id: int
    web_name: str
    seasons_used: list[str] = field(default_factory=list)
    seasons_excluded: list[str] = field(default_factory=list)
    weighted_minutes_share: float = 0.0
    weighted_starts_share: float = 0.0
    avg_minutes_per_start: float = 0.0
    per90: dict[str, float] = field(default_factory=dict)
    total_weight_minutes: float = 0.0


def _blend_seasons(
    seasons: list[dict],
) -> tuple[list[str], list[str], float, float, float, dict[str, float], float]:
    """`seasons` is history_past ordered most-recent-first, already capped to
    the last 3. Returns (used, excluded, weighted_minutes_share,
    weighted_starts_share, avg_minutes_per_start, per90, total_weight_minutes).
    """
    used, excluded = [], []
    weight_minutes_sum = 0.0
    weighted_minutes_share_sum = 0.0
    weighted_starts_share_sum = 0.0
    minutes_per_start_weight_sum = 0.0
    minutes_per_start_numerator = 0.0
    rate_numerators = {f: 0.0 for f in RATE_FIELDS}

    for season, weight in zip(seasons, SEASON_WEIGHTS):
        minutes = season.get("minutes") or 0
        if minutes < MIN_MINUTES_FOR_SEASON:
            excluded.append(season["season_name"])
            continue
        used.append(season["season_name"])
        weight_minutes_sum += weight * minutes
        weighted_minutes_share_sum += weight * min(minutes / FULL_SEASON_MINUTES, 1.0)
        starts = int(season.get("starts") or 0)
        weighted_starts_share_sum += weight * min(starts / FULL_SEASON_MATCHES, 1.0)
        if starts > 0:
            # How long they typically lasted once actually starting - a nailed
            # starter should land near 85-90, a player who gets hooked early
            # or is often withdrawn on 60-70 minutes will land lower.
            minutes_per_start_weight_sum += weight * starts
            minutes_per_start_numerator += weight * starts * (minutes / starts)
        for f in RATE_FIELDS:
            # FPL's API returns some of these as strings (e.g. "25.50") and
            # others as ints/floats - coerce defensively either way.
            rate_numerators[f] += weight * float(season.get(f) or 0.0)

    if weight_minutes_sum == 0:
        return used, excluded, 0.0, 0.0, 0.0, {f: 0.0 for f in RATE_FIELDS}, 0.0

    per90 = {f: round(90 * rate_numerators[f] / weight_minutes_sum, 4) for f in RATE_FIELDS}
    total_weight = sum(w for s, w in zip(seasons, SEASON_WEIGHTS) if s["season_name"] in used)
    weighted_minutes_share = round(weighted_minutes_share_sum / total_weight, 4) if total_weight else 0.0
    weighted_starts_share = round(weighted_starts_share_sum / total_weight, 4) if total_weight else 0.0
    avg_minutes_per_start = (
        round(minutes_per_start_numerator / minutes_per_start_weight_sum, 1)
        if minutes_per_start_weight_sum
        else 0.0
    )
    return (
        used,
        excluded,
        weighted_minutes_share,
        weighted_starts_share,
        avg_minutes_per_start,
        per90,
        weight_minutes_sum,
    )


def build_player_priors(
    element_ids: list[int],
    element_names: dict[int, str],
    already_cached: dict[int, dict] | None = None,
    force: bool = False,
) -> dict[int, PlayerPrior]:
    already_cached = already_cached or {}
    priors: dict[int, PlayerPrior] = {}
    to_fetch = element_ids if force else [i for i in element_ids if i not in already_cached]
    skipped = len(element_ids) - len(to_fetch)
    if skipped:
        print(f"Skipping {skipped} already-cached players (use force=True to refresh all)")

    for i, player_id in enumerate(to_fetch):
        try:
            summary = fetch.get_element_summary(player_id)
        except Exception as exc:  # noqa: BLE001 - one player's failure shouldn't kill the run
            print(f"  warning: failed to fetch {player_id}: {exc}")
            continue
        recent_seasons = list(reversed(summary.get("history_past", [])))[:3]
        (
            used,
            excluded,
            minutes_share,
            starts_share,
            avg_minutes_per_start,
            per90,
            weight_minutes,
        ) = _blend_seasons(recent_seasons)
        priors[player_id] = PlayerPrior(
            id=player_id,
            web_name=element_names.get(player_id, ""),
            seasons_used=used,
            seasons_excluded=excluded,
            weighted_minutes_share=minutes_share,
            weighted_starts_share=starts_share,
            avg_minutes_per_start=avg_minutes_per_start,
            per90=per90,
            total_weight_minutes=weight_minutes,
        )
        if (i + 1) % 50 == 0:
            print(f"  ...{i + 1}/{len(to_fetch)} fetched")
        time.sleep(REQUEST_PAUSE)

    # Preserve anything already cached that wasn't re-fetched this run.
    for player_id, cached in already_cached.items():
        if player_id not in priors:
            priors[player_id] = PlayerPrior(**cached)

    return priors


def load_player_priors(path: Path = CACHE_PATH) -> dict[int, PlayerPrior]:
    if not path.exists():
        return {}
    raw = json.loads(path.read_text())
    return {int(pid): PlayerPrior(**p) for pid, p in raw.get("players", {}).items()}


def _write_cache(priors: dict[int, PlayerPrior], path: Path = CACHE_PATH) -> None:
    from datetime import datetime, timezone

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "season_weights": SEASON_WEIGHTS,
        "min_minutes_per_season": MIN_MINUTES_FOR_SEASON,
        "players": {str(pid): asdict(p) for pid, p in priors.items()},
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2))
    print(f"wrote {path} ({path.stat().st_size:,} bytes, {len(priors)} players)")


def main() -> None:
    force = "--force" in sys.argv
    bootstrap = fetch.get_bootstrap()
    element_ids = [e["id"] for e in bootstrap["elements"] if not e.get("removed")]
    element_names = {e["id"]: e["web_name"] for e in bootstrap["elements"]}

    existing_raw = {}
    if CACHE_PATH.exists() and not force:
        existing_raw = {
            int(pid): p for pid, p in json.loads(CACHE_PATH.read_text()).get("players", {}).items()
        }

    priors = build_player_priors(element_ids, element_names, already_cached=existing_raw, force=force)
    _write_cache(priors)


if __name__ == "__main__":
    main()
