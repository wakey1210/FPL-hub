"""Understat.com integration: a penalty/open-play xG split FPL's own
aggregate `expected_goals_per_90` doesn't expose.

FPL's own xG field (Opta-derived, already used throughout engine/model.py) is
a single per-90 aggregate - it bakes in penalties with no way to tell a
player whose rate is inflated by spot-kicks (which won't recur at the same
rate if they lose the nominated-taker role) from one generating the same
rate through open play. Understat's own league-wide player data already
reports both `xG` (total) and `npxG` (non-penalty), season-aggregate, so
`pens_share_of_xg = (xG - npxG) / xG` needs no shot-level parsing at all.

Used only as a *ratio correction* layered onto FPL's own xG magnitude, never
as a second, competing absolute xG number - Understat's and Opta's xG models
don't agree in absolute terms, so mixing bases directly would be
inconsistent. See `_understat_penalty_adjustment` in engine/model.py.

Understat's own robots.txt disallows all automated access site-wide
(`Disallow: /`) - unlike FBref (which both prohibits scraping AND enforces it
with a Cloudflare bot-wall), this is unenforced, and low-volume personal use
via a maintained package is an accepted, informed risk (not something to
pretend is risk-free). Mitigated by keeping this weekly (not 3-hourly), using
a descriptive User-Agent (set on `understatapi`'s underlying session), and
reusing the maintained `understatapi` package rather than a hand-rolled
scraper - the same posture already taken reusing vaastav's community-
maintained historical CSVs.
"""
from __future__ import annotations

import json
import re
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

import understatapi
from rapidfuzz import fuzz

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
CACHE_PATH = DATA_DIR / "understat_xg.json"
MANUAL_MAP_PATH = Path(__file__).resolve().parent / "understat_manual_map.json"

MATCH_CONFIDENCE_THRESHOLD = 85.0  # rapidfuzz score (0-100); below this, log as unmatched, never guess
MIN_MATCHES_FOR_SPLIT = 3  # below this a season's xG/npxG split is too thin to trust

# Understat's team_title strings -> FPL bootstrap team["name"] - a small,
# stable, hand-maintained table (only 20 teams), same role as odds.py's
# TEAM_NAME_ALIASES for a different provider's naming.
TEAM_NAME_ALIASES = {
    "manchester city": "man city",
    "manchester united": "man utd",
    "newcastle united": "newcastle",
    "nottingham forest": "nott'm forest",
    "tottenham": "spurs",
    "wolverhampton wanderers": "wolves",
}


def _normalize_name(name: str) -> str:
    """Lowercase, strip diacritics/punctuation - Understat and FPL don't
    always agree on accents (e.g. "Gabriel Jesus" vs "Gabriel Jesús")."""
    decomposed = unicodedata.normalize("NFKD", name)
    ascii_only = "".join(c for c in decomposed if not unicodedata.combining(c))
    return re.sub(r"[^a-z ]", "", ascii_only.lower()).strip()


def _normalize_team(name: str) -> str:
    return TEAM_NAME_ALIASES.get(name.lower(), name.lower())


def _last_completed_understat_season(bootstrap: dict) -> str:
    """Understat's `season` parameter is just the year a season started in
    (e.g. "2025" for 2025-26) - derived from the current season's first
    gameweek deadline rather than the system clock. Returns the *previous*
    season deliberately, not the current one: this feeds a correction to
    `prior.per90` (engine/priors.py's multi-season blend, weighted mostly
    toward the most recent completed season), not to the current season's
    own rate - FPL's own current-season xG already reflects a player's
    actual current-season role directly once enough matches accumulate, so
    Understat's split is only useful for the *stale* prior component, which
    is by construction always about last season (or earlier), never this one.
    """
    first_event = min(bootstrap["events"], key=lambda e: e["id"])
    deadline = datetime.fromisoformat(first_event["deadline_time"].replace("Z", "+00:00"))
    return str(deadline.year - 1)


def fetch_league_player_data(season: str) -> list[dict]:
    client = understatapi.UnderstatClient()
    return client.league(league="EPL").get_player_data(season=season)


def _fpl_candidates(bootstrap: dict) -> dict[int, dict]:
    """{fpl_id: {"names": [...], "team_name":}} for fuzzy-matching against.
    Understat's `player_name` is sometimes a short "known-as" form (e.g.
    "Richarlison") and sometimes closer to a full name - matching against
    both FPL's full legal name (first_name + second_name) and its own
    "known-as" `web_name` (e.g. "Richarlison", "B.Fernandes") covers both
    cases without needing a single, always-right representation.
    """
    teams_by_id = {t["id"]: t["name"] for t in bootstrap["teams"]}
    return {
        e["id"]: {
            "names": [f"{e['first_name']} {e['second_name']}", e["web_name"]],
            "team_name": teams_by_id[e["team"]],
        }
        for e in bootstrap["elements"]
        if not e.get("removed")
    }


def match_understat_players(
    understat_rows: list[dict], bootstrap: dict, manual_map: dict[str, str] | None = None
) -> tuple[dict[int, dict], list[dict]]:
    """Matches Understat league player rows to FPL element IDs by normalized
    name + team (only within the same team, to avoid common-surname false
    positives), accepting only high-confidence (>MATCH_CONFIDENCE_THRESHOLD)
    automatic matches. `manual_map` is {fpl_id_str: understat_id_str},
    checked first and always trusted. Returns (matched_by_fpl_id, unmatched).
    """
    manual_map = manual_map or {}
    manual_by_understat_id = {v: k for k, v in manual_map.items()}
    candidates = _fpl_candidates(bootstrap)
    # Every (normalized name variant) -> fpl_id, across both full-name and
    # web_name forms - a player contributes one entry per variant.
    by_normalized_name: dict[str, int] = {}
    for fpl_id, c in candidates.items():
        for name in c["names"]:
            by_normalized_name.setdefault(_normalize_name(name), fpl_id)

    matched: dict[int, dict] = {}
    unmatched: list[dict] = []

    for row in understat_rows:
        understat_id = row["id"]
        if understat_id in manual_by_understat_id:
            fpl_id = int(manual_by_understat_id[understat_id])
            matched[fpl_id] = {**row, "matched_via": "manual_override"}
            continue

        row_teams = {_normalize_team(t) for t in row["team_title"].split(",")}
        row_name = _normalize_name(row["player_name"])

        # Exact normalized-name match (either name variant) within the same team(s) first.
        exact_fpl_id = by_normalized_name.get(row_name)
        if exact_fpl_id is not None and _normalize_team(candidates[exact_fpl_id]["team_name"]) in row_teams:
            matched[exact_fpl_id] = {**row, "matched_via": "name+team"}
            continue

        # Fuzzy fallback, restricted to same-team candidates only - best
        # score across a candidate's name variants (full name or web_name).
        same_team = {fpl_id: c for fpl_id, c in candidates.items() if _normalize_team(c["team_name"]) in row_teams}
        if not same_team:
            unmatched.append(row)
            continue
        best_fpl_id, best_score = None, 0.0
        for fpl_id, c in same_team.items():
            score = max(fuzz.token_sort_ratio(row_name, _normalize_name(n)) for n in c["names"])
            if score > best_score:
                best_fpl_id, best_score = fpl_id, score
        if best_fpl_id is not None and best_score >= MATCH_CONFIDENCE_THRESHOLD:
            matched[best_fpl_id] = {**row, "matched_via": "name+team"}
        else:
            unmatched.append(row)

    return matched, unmatched


def build_understat_cache(bootstrap: dict) -> dict:
    manual_map = json.loads(MANUAL_MAP_PATH.read_text()) if MANUAL_MAP_PATH.exists() else {}
    season = _last_completed_understat_season(bootstrap)
    rows = fetch_league_player_data(season)
    matched, unmatched = match_understat_players(rows, bootstrap, manual_map)

    players_out: dict[str, dict] = {}
    for fpl_id, row in matched.items():
        try:
            xg = float(row["xG"])
            npxg = float(row["npxG"])
            games = int(row["games"])
        except (KeyError, ValueError, TypeError):
            continue
        if games < MIN_MATCHES_FOR_SPLIT:
            continue  # too thin a sample last season to trust the split
        pens_share = round((xg - npxg) / xg, 3) if xg > 0 else 0.0
        players_out[str(fpl_id)] = {
            "understat_id": row["id"],
            "matched_via": row["matched_via"],
            "pens_share_of_xg": pens_share,
            "matches_used": games,
        }

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "season": season,
        "players": players_out,
        "unmatched": [{"understat_id": r["id"], "player_name": r["player_name"], "team": r["team_title"]} for r in unmatched],
    }


def main() -> None:
    from engine import fetch

    bootstrap = fetch.get_bootstrap()
    try:
        cache = build_understat_cache(bootstrap)
    except Exception as exc:  # noqa: BLE001 - a scrape/parse failure must never touch the existing cache
        print(f"Understat refresh failed ({exc}) - leaving existing cache untouched")
        return

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    CACHE_PATH.write_text(json.dumps(cache, indent=2))
    print(
        f"wrote {CACHE_PATH} ({len(cache['players'])} matched, "
        f"{len(cache['unmatched'])} unmatched, season={cache['season']})"
    )


if __name__ == "__main__":
    main()
