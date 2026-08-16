"""Recency-weighted, per-team historical goals-for/against strength model.

FPL's own Fixture Difficulty Rating (`team_h_difficulty`/`team_a_difficulty`
on `/api/fixtures/`) is a blunt instrument for newly-promoted teams, who FPL
has little/no current-season information to base a rating on early in the
season. This derives an alternative opponent-strength read from real
multi-season results (goals scored/conceded, home/away split) reusing the
same historical cache `fetch_historical.py` already downloads for
`fit_coefficients.py` - no new data source needed.

Deliberately NOT Elo: Elo needs two hyperparameters (K-factor, home-advantage
constant) this project has no data to justify, and produces a unitless
rating that's less interpretable than every other number in this codebase
(`FDR_EXPECTED_CONCEDED`, `PlayerPrior.per90` are all real, auditable units).
A simple recency-weighted average (mirroring `engine/priors.py`'s
`SEASON_WEIGHTS = [3, 2, 1]` convention) is a static pre-season prior, which
is all this needs to be - FPL's own FDR already re-rates established teams
through the season, so this only has to solve the promoted-team case well.

Lives in engine/calibration/ (not its own module) since it reuses the same
cached historical seasons and the same rare/manual, human-reviewed refit
cadence as fit_coefficients.py (calibrate.yml, workflow_dispatch only).
"""
from __future__ import annotations

import csv
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from engine import fetch
from engine.calibration.fetch_historical import CACHE_DIR, SEASONS

OUTPUT_PATH = Path(__file__).resolve().parent / "team_strength.json"
SEASON_WEIGHTS = [3, 2, 1]  # most-recent first, up to 3 seasons - mirrors engine/priors.py
PROMOTED_FALLBACK_PERCENTILE = 0.25
FDR_VALUES = [1, 2, 3, 4, 5]


@dataclass
class _SideGames:
    goals_for: int = 0
    goals_against: int = 0
    games: int = 0


def _load_team_season_rows(season: str) -> dict[str, dict[str, _SideGames]]:
    """Returns {team_name: {"home": _SideGames, "away": _SideGames}} for one
    season, deduped to one row per team-per-fixture. merged_gw.csv is
    player-gameweek granularity, so every player on a team shares the same
    match's team_h_score/team_a_score/was_home - no join against fixtures.csv's
    numeric team_h/team_a IDs is needed, since merged_gw.csv's own `team`
    column already carries the name string (matches bootstrap's team["name"]
    directly, e.g. "Man Utd", "Nott'm Forest", "Spurs" - confirmed by
    inspection, not assumed).
    """
    cache = CACHE_DIR / season / "merged_gw.csv"
    if not cache.exists():
        return {}
    seen_fixtures: set[tuple[str, str]] = set()
    by_team: dict[str, dict[str, _SideGames]] = {}
    with open(cache, newline="") as f:
        for r in csv.DictReader(f):
            team, fixture = r["team"], r["fixture"]
            key = (team, fixture)
            if key in seen_fixtures:
                continue
            seen_fixtures.add(key)
            try:
                team_h_score = int(r["team_h_score"])
                team_a_score = int(r["team_a_score"])
            except (ValueError, TypeError):
                continue  # blank/postponed fixture row
            was_home = r["was_home"] == "True"
            goals_for = team_h_score if was_home else team_a_score
            goals_against = team_a_score if was_home else team_h_score
            side = "home" if was_home else "away"
            bucket = by_team.setdefault(team, {"home": _SideGames(), "away": _SideGames()})
            g = bucket[side]
            g.goals_for += goals_for
            g.goals_against += goals_against
            g.games += 1
    return by_team


def _weighted_rate(season_games: list[tuple[str, _SideGames]]) -> tuple[float, float, list[str]]:
    """`season_games` ordered most-recent-first. Returns (attack_rate,
    defense_rate, seasons_used) weighted [3, 2, 1] over up to the 3 most
    recent seasons the team actually has games in - correctly skips seasons a
    promoted team wasn't in the top flight for, without crashing.
    """
    used = [(season, g) for season, g in season_games if g.games > 0][:3]
    if not used:
        return 0.0, 0.0, []
    weight_games_sum = sum(w * g.games for (_, g), w in zip(used, SEASON_WEIGHTS))
    attack_num = sum(w * g.goals_for for (_, g), w in zip(used, SEASON_WEIGHTS))
    defense_num = sum(w * g.goals_against for (_, g), w in zip(used, SEASON_WEIGHTS))
    return attack_num / weight_games_sum, defense_num / weight_games_sum, [s for s, _ in used]


def build_team_strength(seasons: list[str] = SEASONS, current_team_names: list[str] | None = None) -> dict:
    # Most-recent-first, matching the weighting convention above.
    seasons_desc = list(reversed(seasons))
    rows_by_season = {s: _load_team_season_rows(s) for s in seasons_desc}

    all_team_names = sorted({t for rows in rows_by_season.values() for t in rows})
    if current_team_names is None:
        current_team_names = all_team_names
    most_recent_season = seasons_desc[0]
    promoted = [t for t in current_team_names if t not in rows_by_season[most_recent_season]]

    raw: dict[str, dict[str, float | list[str]]] = {}
    for team in all_team_names:
        home_games = [(s, rows_by_season[s].get(team, {}).get("home", _SideGames())) for s in seasons_desc]
        away_games = [(s, rows_by_season[s].get(team, {}).get("away", _SideGames())) for s in seasons_desc]
        attack_home, defense_home, seasons_home = _weighted_rate(home_games)
        attack_away, defense_away, seasons_away = _weighted_rate(away_games)
        raw[team] = {
            "attack_rate_home": attack_home,
            "defense_rate_home": defense_home,
            "attack_rate_away": attack_away,
            "defense_rate_away": defense_away,
            "seasons_used": sorted(set(seasons_home) | set(seasons_away), reverse=True),
        }

    # League-average multipliers keep the numbers interpretable ("20% above
    # league-average attack at home"), same interpretability bar as the
    # FDR_* tables in engine/model.py.
    established = {t: r for t, r in raw.items() if t not in promoted}

    def _league_avg(key: str) -> float:
        values = [r[key] for r in established.values() if r[key] > 0]
        return sum(values) / len(values) if values else 1.0

    league_avg = {k: _league_avg(k) for k in ("attack_rate_home", "defense_rate_home", "attack_rate_away", "defense_rate_away")}

    def _percentile(key: str, pct: float) -> float:
        values = sorted(r[key] for r in established.values() if r[key] > 0)
        if not values:
            return league_avg[key]
        idx = min(len(values) - 1, int(pct * len(values)))
        return values[idx]

    fallback = {k: _percentile(k, PROMOTED_FALLBACK_PERCENTILE) for k in league_avg}

    teams_out: dict[str, dict] = {}
    strength_scores: dict[str, float] = {}
    for team in current_team_names:
        r = raw.get(team, {"seasons_used": []})
        is_promoted = team in promoted
        source = fallback if is_promoted else r
        attack_home = source.get("attack_rate_home", fallback["attack_rate_home"]) or fallback["attack_rate_home"]
        defense_home = source.get("defense_rate_home", fallback["defense_rate_home"]) or fallback["defense_rate_home"]
        attack_away = source.get("attack_rate_away", fallback["attack_rate_away"]) or fallback["attack_rate_away"]
        defense_away = source.get("defense_rate_away", fallback["defense_rate_away"]) or fallback["defense_rate_away"]

        attack_strength_home = round(attack_home / league_avg["attack_rate_home"], 3)
        defense_strength_home = round(defense_home / league_avg["defense_rate_home"], 3)
        attack_strength_away = round(attack_away / league_avg["attack_rate_away"], 3)
        defense_strength_away = round(defense_away / league_avg["defense_rate_away"], 3)

        teams_out[team] = {
            "attack_strength_home": attack_strength_home,
            "defense_strength_home": defense_strength_home,
            "attack_strength_away": attack_strength_away,
            "defense_strength_away": defense_strength_away,
            "confidence": "promoted_fallback" if is_promoted else "historical",
            "seasons_used": r.get("seasons_used", []),
        }
        # Higher attack, lower defense_strength (concedes less) = stronger team.
        # Averaged home/away for a single ranking scalar.
        strength_scores[team] = (
            (attack_strength_home + attack_strength_away) - (defense_strength_home + defense_strength_away)
        ) / 2

    # Rank into FDR-equivalent buckets (1=weakest/easiest opponent,
    # 5=strongest/hardest), same 1-5 scale FPL's own FDR uses, so it's a
    # drop-in replacement value, not a new scale to re-learn.
    ranked = sorted(strength_scores, key=lambda t: strength_scores[t])
    n = len(ranked)
    for idx, team in enumerate(ranked):
        bucket = 1 + min(4, (idx * 5) // n)
        teams_out[team]["fdr_equivalent"] = bucket

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source_seasons": seasons,
        "promoted_teams": promoted,
        "league_avg": {k: round(v, 3) for k, v in league_avg.items()},
        "teams": teams_out,
    }


def main() -> None:
    bootstrap = fetch.get_bootstrap()
    current_team_names = [t["name"] for t in bootstrap["teams"]]
    old = json.loads(OUTPUT_PATH.read_text()) if OUTPUT_PATH.exists() else None
    new = build_team_strength(current_team_names=current_team_names)

    if old:
        print("--- old vs new fdr_equivalent (promoted teams only) ---")
        for team in new["promoted_teams"]:
            old_fdr = old.get("teams", {}).get(team, {}).get("fdr_equivalent")
            new_fdr = new["teams"].get(team, {}).get("fdr_equivalent")
            print(f"  {team}: old={old_fdr} new={new_fdr}")

    print(f"Promoted teams (using {PROMOTED_FALLBACK_PERCENTILE:.0%}-percentile fallback): {new['promoted_teams']}")
    for team, data in sorted(new["teams"].items(), key=lambda kv: kv[1]["fdr_equivalent"]):
        print(f"  {team}: fdr_equivalent={data['fdr_equivalent']} confidence={data['confidence']}")

    OUTPUT_PATH.write_text(json.dumps(new, indent=2))
    print(f"\nwrote {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
