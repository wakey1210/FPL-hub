"""Betting-odds -> clean-sheet/expected-goals pipeline, an alternative to the
static FDR_* tables in engine/model.py for fixtures a market has priced.

FPL's own Fixture Difficulty Rating is a fixed 1-5 rating that doesn't move
between gameweeks; betting odds move daily with team news, injuries and form,
so where available they're a more responsive opponent-strength signal. This
module fetches match-odds (1X2 + total goals) from The Odds API
(the-odds-api.com - free tier: 500 credits/month, email-only signup, no
payment details; soccer_epl covers the EPL; h2h+totals costs 2 credits/call,
so even a daily fetch is nowhere near the cap), devigs them, and derives a
clean-sheet probability and expected goals for/against per team per fixture -
in the same units as FDR_CLEAN_SHEET_PROB/FDR_EXPECTED_CONCEDED/
FDR_ATTACK_MULT, so engine/model.py can substitute them in directly.

Runs on its own schedule (.github/workflows/refresh-odds.yml), separate from
the 3-hourly hot loop and the weekly priors job, so a missing API key or an
outage never blocks either. Reads the key from the ODDS_API_KEY environment
variable (a GitHub Actions *secret*, not a repository variable like
FPL_TEAM_ID, since this one is a real credential) - never logs it.
"""
from __future__ import annotations

import json
import math
import os
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import requests
from scipy.optimize import brentq
from scipy.stats import poisson

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
CACHE_PATH = DATA_DIR / "odds.json"

BASE = "https://api.the-odds-api.com/v4"
HEADERS = {"User-Agent": "FPL-hub/0.1 (personal project; contact via github.com/wakey1210/FPL-hub)"}
TIMEOUT = 15
RETRIES = 3
SPORT_KEY = "soccer_epl"

LEAGUE_AVG_GOALS_PER_TEAM = 1.45  # roughly one team's share of a ~2.9-goal average EPL match
TOTAL_GOALS_LINE_FALLBACK = 2.5
MATCH_TIME_TOLERANCE = timedelta(hours=6)

# The Odds API uses full club names (e.g. "Arsenal FC", "Tottenham Hotspur");
# FPL's own bootstrap team["name"] uses its own short forms (e.g. "Arsenal",
# "Spurs", "Nott'm Forest"). A tiny static lookup handles the mismatches that
# simple substring matching can't - anything not covered here just fails to
# match and falls back to FDR, rather than guessing.
TEAM_NAME_ALIASES = {
    "tottenham hotspur": "spurs",
    "manchester united": "man utd",
    "manchester city": "man city",
    "nottingham forest": "nott'm forest",
    "wolverhampton wanderers": "wolves",
    "newcastle united": "newcastle",
    "west ham united": "west ham",
    "brighton and hove albion": "brighton",
    "leeds united": "leeds",
}


def _get(path: str, api_key: str, **params: Any) -> Any:
    url = f"{BASE}/{path}"
    query = {**params, "apiKey": api_key}
    last_err: Exception | None = None
    for attempt in range(RETRIES):
        try:
            resp = requests.get(url, headers=HEADERS, params=query, timeout=TIMEOUT)
            resp.raise_for_status()
            return resp.json()
        except Exception as exc:  # noqa: BLE001 - retry on anything transient
            last_err = exc
            if attempt < RETRIES - 1:
                time.sleep(1.5 * (attempt + 1))
    # Never include `query` (carries the key) in a raised message that might get logged.
    raise RuntimeError(f"Failed to fetch {url}: {last_err}") from last_err


def get_epl_odds(api_key: str, regions: str = "uk", markets: str = "h2h,totals") -> list[dict]:
    return _get(f"sports/{SPORT_KEY}/odds", api_key, regions=regions, markets=markets, oddsFormat="decimal")


def _normalize_team_name(name: str) -> str:
    n = name.lower().replace(" fc", "").replace("afc ", "").strip()
    return TEAM_NAME_ALIASES.get(n, n)


def _devig_three_way(odds_home: float, odds_draw: float, odds_away: float) -> tuple[float, float, float]:
    """Normalization-method devig: raw implied probabilities sum to more than
    1 (the bookmaker's margin); dividing each by that sum removes it while
    preserving their relative weight. Simple and transparent, matching this
    project's stated preference over more elaborate devig methods (e.g.
    Shin's method) for a personal, non-commercial tool.
    """
    p_home, p_draw, p_away = 1 / odds_home, 1 / odds_draw, 1 / odds_away
    margin = p_home + p_draw + p_away
    return p_home / margin, p_draw / margin, p_away / margin


def _devig_two_way(odds_a: float, odds_b: float) -> tuple[float, float]:
    p_a, p_b = 1 / odds_a, 1 / odds_b
    margin = p_a + p_b
    return p_a / margin, p_b / margin


def _total_goals_lambda(p_over: float, line: float) -> float:
    """Solves for the total-match Poisson rate implied by a devigged
    over/under probability at `line` (typically 2.5): the number of whole
    goals strictly required to be "over" is floor(line) + 1 goals, i.e. more
    than floor(line) goals scored, so 1 - poisson.cdf(floor(line), lambda) ==
    p_over. Solved numerically since there's no closed form for lambda.
    """
    threshold = math.floor(line)

    def f(lam: float) -> float:
        return (1 - poisson.cdf(threshold, lam)) - p_over

    try:
        return brentq(f, 0.1, 8.0)
    except ValueError:
        # p_over outside the range achievable in [0.1, 8.0] - shouldn't happen
        # for real EPL markets, but fall back to a league-average total.
        return 2 * LEAGUE_AVG_GOALS_PER_TEAM


def _fixture_probabilities(bookmaker_markets: list[dict]) -> dict | None:
    """Averages devigged probabilities across every bookmaker in the response
    that has both an h2h and a totals market - simple and more robust than
    picking one bookmaker arbitrarily, while staying a plain arithmetic mean,
    not a weighted/black-box combination.
    """
    h2h_samples, totals_samples = [], []
    totals_line = TOTAL_GOALS_LINE_FALLBACK
    for bookmaker in bookmaker_markets:
        markets_by_key = {m["key"]: m for m in bookmaker.get("markets", [])}
        h2h = markets_by_key.get("h2h")
        totals = markets_by_key.get("totals")
        if not h2h or not totals:
            continue
        prices = {o["name"]: o["price"] for o in h2h["outcomes"]}
        over = next((o for o in totals["outcomes"] if o["name"] == "Over"), None)
        under = next((o for o in totals["outcomes"] if o["name"] == "Under"), None)
        if len(prices) != 3 or "Draw" not in prices or not over or not under:
            continue
        team_names = [n for n in prices if n != "Draw"]
        if len(team_names) != 2:
            continue
        h2h_samples.append((prices, team_names))
        totals_line = over.get("point", TOTAL_GOALS_LINE_FALLBACK)
        p_over, _ = _devig_two_way(over["price"], under["price"])
        totals_samples.append(p_over)

    if not h2h_samples or not totals_samples:
        return None
    return {
        "h2h_samples": h2h_samples,
        "avg_p_over": sum(totals_samples) / len(totals_samples),
        "totals_line": totals_line,
    }


def compute_fixture_odds(event: dict) -> dict | None:
    """Given one The Odds API event (with `home_team`/`away_team` and
    `bookmakers`), returns clean-sheet/expected-goals/attack-mult numbers for
    both sides, in the same units as engine.model's FDR_* tables - or None if
    the event lacks a usable h2h+totals market pair.
    """
    probs = _fixture_probabilities(event.get("bookmakers", []))
    if not probs:
        return None

    # Average the devigged home/draw/away probabilities across bookmakers.
    home_name, away_name = event["home_team"], event["away_team"]
    p_home_sum = p_draw_sum = p_away_sum = 0.0
    n = 0
    for prices, team_names in probs["h2h_samples"]:
        if home_name not in prices or away_name not in prices:
            continue
        p_h, p_d, p_a = _devig_three_way(prices[home_name], prices["Draw"], prices[away_name])
        p_home_sum, p_draw_sum, p_away_sum = p_home_sum + p_h, p_draw_sum + p_d, p_away_sum + p_a
        n += 1
    if n == 0:
        return None
    p_home, p_draw, p_away = p_home_sum / n, p_draw_sum / n, p_away_sum / n

    lambda_total = _total_goals_lambda(probs["avg_p_over"], probs["totals_line"])
    # Split total goals into a home/away expectation using the relative
    # home/away win-probability skew - a lightweight heuristic in place of a
    # full Dixon-Coles fit (documented as an approximation, not full match
    # simulation - a candidate for tightening if engine/accuracy.py shows it
    # matters).
    log_ratio = math.log(max(p_home, 1e-6) / max(p_away, 1e-6))
    lambda_home = max(0.1, (lambda_total + log_ratio) / 2)
    lambda_away = max(0.1, (lambda_total - log_ratio) / 2)

    return {
        "clean_sheet_prob_home": round(math.exp(-lambda_away), 3),
        "clean_sheet_prob_away": round(math.exp(-lambda_home), 3),
        "expected_conceded_home": round(lambda_away, 3),
        "expected_conceded_away": round(lambda_home, 3),
        "attack_mult_home": round(lambda_home / LEAGUE_AVG_GOALS_PER_TEAM, 3),
        "attack_mult_away": round(lambda_away / LEAGUE_AVG_GOALS_PER_TEAM, 3),
    }


def match_events_to_fixtures(odds_events: list[dict], fixtures: list[dict], teams_by_id: dict[int, dict]) -> dict[int, dict]:
    """Matches The Odds API events to FPL fixture IDs by kickoff time (within
    MATCH_TIME_TOLERANCE) + normalized team names. Returns {fpl_fixture_id:
    odds_event}; fixtures with no confident match are simply omitted (never
    guessed), so engine.model falls back to FDR for them.
    """
    normalized_teams = {
        _normalize_team_name(t["name"]): t["id"] for t in teams_by_id.values()
    }
    matched: dict[int, dict] = {}
    for event in odds_events:
        try:
            commence = datetime.fromisoformat(event["commence_time"].replace("Z", "+00:00"))
        except (KeyError, ValueError):
            continue
        home_id = normalized_teams.get(_normalize_team_name(event.get("home_team", "")))
        away_id = normalized_teams.get(_normalize_team_name(event.get("away_team", "")))
        if home_id is None or away_id is None:
            continue
        for fx in fixtures:
            if fx["team_h"] != home_id or fx["team_a"] != away_id:
                continue
            try:
                kickoff = datetime.fromisoformat(fx["kickoff_time"].replace("Z", "+00:00"))
            except (KeyError, ValueError, TypeError):
                continue
            if abs(kickoff - commence) <= MATCH_TIME_TOLERANCE:
                matched[fx["id"]] = event
                break
    return matched


def build_odds_cache(bootstrap: dict, fixtures: list[dict], api_key: str) -> dict:
    teams_by_id = {t["id"]: t for t in bootstrap["teams"]}
    odds_events = get_epl_odds(api_key)
    matched = match_events_to_fixtures(odds_events, fixtures, teams_by_id)

    fixtures_out: dict[str, dict] = {}
    unmatched_fixture_ids = []
    for fixture_id, event in matched.items():
        computed = compute_fixture_odds(event)
        if computed:
            fixtures_out[str(fixture_id)] = computed
        else:
            unmatched_fixture_ids.append(fixture_id)

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": "the-odds-api",
        "events_fetched": len(odds_events),
        "fixtures_matched": len(fixtures_out),
        "fixtures": fixtures_out,
    }


def _upcoming_fixture_ids_already_cached(cache: dict | None, fixtures: list[dict], events: list[dict]) -> bool:
    """True if every upcoming (unplayed) fixture already has an odds entry -
    lets the weekly job skip the API call entirely once nothing new is due,
    keeping well inside the free-tier credit budget even on repeated manual
    workflow_dispatch runs."""
    if not cache:
        return False
    upcoming_ids = {fx["id"] for fx in fixtures if fx["event"] in {e["id"] for e in events if not e["finished"]}}
    cached_ids = {int(k) for k in cache.get("fixtures", {})}
    return upcoming_ids.issubset(cached_ids)


def main() -> None:
    from engine import fetch

    api_key = os.environ.get("ODDS_API_KEY")
    if not api_key:
        print("ODDS_API_KEY not set - skipping odds refresh (engine.model falls back to FDR tables)")
        return

    bootstrap = fetch.get_bootstrap()
    fixtures = fetch.get_fixtures()

    existing = json.loads(CACHE_PATH.read_text()) if CACHE_PATH.exists() else None
    if _upcoming_fixture_ids_already_cached(existing, fixtures, bootstrap["events"]):
        print("All upcoming fixtures already have cached odds - skipping fetch")
        return

    try:
        cache = build_odds_cache(bootstrap, fixtures, api_key)
    except Exception as exc:  # noqa: BLE001 - never let an odds-fetch failure touch the existing cache
        print(f"Odds refresh failed ({exc}) - leaving existing cache untouched")
        return

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    CACHE_PATH.write_text(json.dumps(cache, indent=2))
    print(f"wrote {CACHE_PATH} ({cache['fixtures_matched']}/{cache['events_fetched']} fixtures matched)")


if __name__ == "__main__":
    main()
