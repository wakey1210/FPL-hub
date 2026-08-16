# FPL Hub

A personal Fantasy Premier League assistant: a transparent, free prediction
engine plus a mobile-first PWA styled like the official FPL app. Built to
replace a mix of tools (Ben Crellin's transfer-planning sheet, Fantasy
Football Hub's paid AI picker) with something self-hosted, auditable, and
free to run.

**Live app:** https://wakey1210.github.io/FPL-hub/

## Why

Commercial FPL "AI" pickers are black boxes - no published methodology, no
accuracy tracking, no explanation of *why* a player is rated highly. This
project does the opposite: every prediction ships with an uncertainty band
and a plain-English breakdown of what drove it, and the model's real
gameweek-by-gameweek error is tracked in-app (More tab) from the first
scored gameweek onward.

## Architecture

```
/engine   Python: fetches the official FPL API, builds a transparent expected-
          points (EV) model, and runs a linear-programming optimiser for
          squad/transfer suggestions. Outputs JSON.
/data     Committed JSON output from the engine (latest-overwrite, not
          per-run snapshots, to keep repo size bounded).
/app      React + TypeScript + Tailwind PWA that reads /data/*.json and
          renders it - pitch view, transfers list, fixture planner.
```

Everything runs free on GitHub:
- **GitHub Actions** (`.github/workflows/pipeline.yml`) fetches data and
  recomputes predictions every 3 hours (or on demand via
  `workflow_dispatch`), committing the results to `/data`. If a
  `FPL_TEAM_ID` repository variable is set, it also tracks that manager's
  squad/transfers/chips/bank and generates transfer suggestions.
- **`refresh-priors.yml`** rebuilds each player's multi-season prior
  (`data/player_priors.json`) weekly - much heavier than the 3-hourly loop
  (~587 API calls first run, incremental after), so it stays on its own
  schedule.
- **`calibrate.yml`** refits the model's FDR/defensive-contribution
  constants and team-strength ratings against historical data - manual only,
  meant to be re-run once a season closes out, not on any automatic cadence.
- **`refresh-odds.yml`** and **`refresh-understat.yml`** refresh betting-odds
  and Understat data respectively, each on their own weekly/twice-weekly
  schedule, kept off the 3-hourly hot loop so a missing secret or an outage
  in either never blocks it.
- **GitHub Pages** (`.github/workflows/deploy-pages.yml`) rebuilds and
  redeploys the static PWA whenever `/app` or `/data` changes.

There's no backend server: the FPL API doesn't send CORS headers, so the
browser can never call it directly - the Actions pipeline does that fetching
server-side and the app just reads the resulting same-origin JSON files.

## The model (v1)

For each player, over the next 6 gameweeks:

```
EV = appearance points (from expected minutes)
   + attacking points (xG/xA per-90, adjusted by opponent fixture difficulty)
   + defensive-contribution points (from CBIT/CBIRT per-90 rate)
   + clean-sheet points - expected-goals-conceded penalty (FDR-based)
   + save points (goalkeepers)
   + a small bonus-points estimate
```

Scoring constants are read live from the FPL API's own rules (`game_config`),
not hardcoded, so an in-season rule tweak doesn't silently break anything.
Every player's EV carries an uncertainty band and the top 3 factors behind
it. See `engine/model.py` for the full, commented implementation.

This is a heuristic v1, not a trained model - it's expected to be tuned
in-season as its real error is logged and compared against public benchmarks
(the open [OpenFPL](https://arxiv.org/abs/2508.09992) project reports
~1.2-2.0 RMSE per player-gameweek for public-data models, which is the
target range).

### Historical calibration and adaptive blending

Rather than leaning on a single (possibly noisy, thin) season, three things
draw on multiple past seasons:

1. **`engine/priors.py`** blends each player's own last up-to-3 completed
   seasons (via the FPL API's `element-summary/{id}/history_past`) into a
   recency-and-minutes-weighted personal baseline - a season under 450
   minutes (~5 matches) is dropped as too thin to trust. Cached to
   `data/player_priors.json`, refreshed weekly.
2. **`engine/calibration/fit_coefficients.py`** fits the model's FDR/clean-
   sheet/defensive-contribution constants to several seasons of real
   per-gameweek outcomes (via the community-maintained
   [vaastav/Fantasy-Premier-League](https://github.com/vaastav/Fantasy-Premier-League)
   dataset) instead of hand-picking them - a small, published ridge
   regression per position, not a black box, with its own R², holdout RMSE
   and sample size logged alongside every fitted number in
   `engine/calibration/coefficients.json`. A position whose fit has too
   little real signal (defenders' points come mostly from clean sheets, not
   xG/xA, for instance) gets its fitted curve blended back toward the
   original hand-picked default proportional to its R², rather than shipped
   at face value. Re-run manually once a season closes out (`calibrate.yml`)
   - never on a schedule, so a bad refit can't silently replace a working one
   without a human seeing the diff first.
3. **`engine/stabilize.py`** blends each stat's this-season-so-far rate with
   its multi-season prior via an empirical-Bayes-style shrinkage: each stat
   has a "stabilization point" (in minutes of current-season data) at which
   it's weighted equally with the prior - defensive actions stabilize in
   ~2 matches, chance creation takes ~5. This is what lets the model react
   quickly to an emerging breakout player within a handful of gameweeks,
   while settling onto season-to-date form (not last-week's "hot streak" or
   one soft fixture) by mid-season. Pre-season, current-season minutes are
   zero, so this correctly resolves to exactly the multi-season prior.

The current-season rate blended in *is* adjusted for the difficulty of
opponents already faced this season, not just the calibrated FDR tables
applied to upcoming fixtures: `engine/priors.py` computes each player's
minutes-weighted average FDR faced so far (from element-summary's
per-gameweek `history`, cross-referenced with fixture difficulty) and
`engine/model.py` rebases their current-season attacking rate to an
FDR-3-equivalent before blending it with the prior - so a hot streak against
soft fixtures isn't over-trusted. This piggybacks on the weekly priors job
rather than the 3-hourly hot loop (which stays at 2 API calls): once the
season starts, that weekly job switches from incremental to a full refetch,
since this average changes every gameweek unlike the static historical
seasons blend.

### Prediction accuracy, tracked openly

`engine/accuracy.py` logs every gameweek's predictions before that
gameweek's deadline (overwriting the same slot with the freshest pre-
deadline prediction each run - team news lands late), then once real
results exist, scores them - RMSE/MAE at player-gameweek granularity,
matching how the OpenFPL benchmark above is reported. A scored gameweek is
locked and never rewritten, so what's shown is always what the model
genuinely said beforehand, not adjusted with hindsight. Visible on the More
tab from the first scored gameweek - FFH publishes no accuracy record at
all; this one is visible whatever it says.

### Playing time: appearance vs. a genuine long appearance

Total minutes isn't the same signal as "genuinely first-choice" - a player
who starts 5 of 7 matches at ~75 minutes each has a completely different
point ceiling from one who racks up similar total minutes via repeated
15-20 minute substitute cameos, even with an identical per-90 rate. Every
player's minutes are split into two probabilities instead of one flat ratio:
`p_appearance` (any minutes at all - feeds attacking returns, saves, bonus,
anything reachable off the bench) and `p_60_plus` (reaching the long-play
threshold - gates defensive contribution, clean sheets, and the long-play
share of appearance points, since those need a genuine extended appearance).
A "capped upside" caveat surfaces in a player's "why" whenever a strong
underlying rate is undercut by a low `p_60_plus` - the concrete case this
exists to catch. See `engine/model.py`'s `_expected_minutes_profile` and
`engine/priors.py`'s `weighted_starts_share`/`avg_minutes_per_start` fields.

### Four more accuracy improvements

Prompted by looking at what commercial/academic FPL prediction tools use
beyond FPL's own data:

1. **Set-piece taker boost.** Bootstrap already exposes `penalties_order`,
   `direct_freekicks_order` and `corners_and_indirect_freekicks_order`
   (1 = primary designated taker, 2 = backup) but nothing read them until
   now. A designated taker who's just inherited the role (new signing,
   teammate transferred/injured) won't show it in their volume-weighted
   blended rate until enough current-season deadball chances accumulate, so
   `engine/model.py`'s `_set_piece_boost` adds a small, hand-picked, additive
   (not multiplicative) xG/xA/90 correction for that role - surfaced in
   "why" whenever it applies.
2. **Betting-odds integration**, since commercial tools' real edge over
   public models is market-driven expected-minutes/goal-involvement signal,
   not attacking-quality modelling (public models already compete there).
   `engine/odds.py` fetches EPL match odds from
   [The Odds API](https://the-odds-api.com) (free tier, weekly/twice-weekly),
   devigs the 1X2 and over/under markets (normalization-method devig),
   solves for each side's Poisson goal rate, and derives a clean-sheet
   probability and expected goals for/against per fixture - replacing the
   FDR-table lookup entirely for any fixture a market has actually priced,
   falling back to FDR otherwise (missing key, API outage, blank/postponed
   fixture, or beyond the bookmaker's posting horizon). Requires an
   `ODDS_API_KEY` GitHub Actions **secret** (a real credential, unlike the
   plain `FPL_TEAM_ID` repository variable).
3. **Understat penalty/xG split.** FPL's own `expected_goals_per_90` is a
   single aggregate that bakes in penalties with no way to tell a player
   whose rate is inflated by spot-kicks from one generating it in open play.
   `engine/understat.py` pulls Understat's own league-wide season `xG`/`npxG`
   aggregates (no shot-level parsing needed - the split is already computed)
   for the most recently *completed* season, matches players to FPL by
   normalized name + team (accepting only high-confidence matches; a
   committed `engine/understat_manual_map.json` patches the inevitable
   exceptions), and strips the penalty share out of `prior.per90` - not the
   current-season rate, which already reflects a player's actual role once
   real gameweeks accumulate - whenever they no longer hold a penalty order.
   Understat's own `robots.txt` disallows all automated access; this is a
   knowingly-accepted, low-volume (weekly), non-commercial risk, mitigated by
   reusing the maintained `understatapi` package rather than a hand-rolled
   scraper.
4. **Team-level historical strength**, an alternative to FPL's own FDR for
   newly-promoted teams, who FPL has little current-season info to rate
   early on. `engine/calibration/team_strength.py` reuses the historical
   seasons already cached for `fit_coefficients.py` to compute each team's
   recency-weighted goals-for/against per game (home/away split) - a
   deliberately simple weighted average, not Elo, since Elo needs
   hyperparameters this project has no data to justify and produces a less
   interpretable number. A promoted team (absent from the most recent cached
   season) gets a 25th-percentile fallback rather than a guess. This only
   ever *replaces* FPL's own FDR for that specific promoted opponent's
   fixtures - established teams keep FPL's FDR untouched, since the
   calibrated `FDR_*` tables above were fitted against FPL's own raw FDR
   values - and adds a small fixed uncertainty bump so the lower-confidence
   read is visibly flagged. Lives in `engine/calibration/` on the same
   rare/manual, human-reviewed refit cadence as `fit_coefficients.py`.

## Squad optimisation

`engine/optimise.py` uses [PuLP](https://coin-or.github.io/pulp/) with the
free, open-source CBC solver to pick the highest-EV 15-man squad within
budget, position and per-club constraints, then the best starting XI,
captain and vice-captain from within it.

## Five-week transfer and chip planner

`engine/planner.py` looks 5 gameweeks ahead rather than just the next one -
a greedy week-by-week simulation (not a joint solver: chip timing is a
handful of rare, discrete decisions, better handled as explicit rule checks
than MILP variables) that reuses `engine/transfers.py`'s single-swap search
as its per-week building block, re-evaluating each candidate's *remaining*-
horizon EV as the plan progresses. Whether a transfer is worth a -4 hit
depends on a decaying "bank premium" (a hit needs to clear more than the
flat 4-point cost early in the horizon, when saving the transfer for a
still-unknown future swap has real option value) - stated as an actual
number in the plan's rationale text, never hidden. Verified against the
live 26/27 chip rules: Wildcard/Free Hit playable from GW2, Bench Boost/
Triple Captain from GW1, both halves splitting at GW19/20, with chip
*availability* derived by diffing already-used chips against those windows
(FPL doesn't publish "chips remaining" on any public endpoint). Writes
`data/transfer_plan.json`, consumed by the Planner tab's week-by-week cards
and a persistent chip-strategy status widget.

## The app is a planner, not a remote control

FPL's login flow is broken for scripts (see the API research above), so
this app can never submit a transfer or lineup change to FPL directly.
"Making a change" in Pick Team or Transfers means staging a plan - swapping
starters/bench, reassigning captain, queuing transfers - stored locally in
the browser, with a persistent reminder to apply it on the official site
before your deadline. This is a deliberate scope boundary, not a missing
feature.

Swapping players follows the same pattern as the reference apps this was
benchmarked against: tap a player, tap "Substitute", then tap *any* other
player to attempt the swap with them - it's validated against the real
starting-XI rules (`engine/optimise.py`'s `PLAY_MIN_MAX`, mirrored
client-side in `app/src/lib/formation.ts`) after the attempt, with a clear
error naming exactly which rule would be broken, rather than restricting
which players can be tapped in the first place. An "Optimise lineup" button
picks the exact best-EV valid starting XI from your current 15 (no budget
involved, just formation counts - a small enough search to solve exactly
by enumeration, not a heuristic). The pitch view shows next-gameweek points
per player, since that's what matters when picking a lineup/captain; a
"List" view alongside it (the same tap-to-swap/optimise controls, in a
table) surfaces the multi-gameweek total too, which matters more for
transfer decisions.

## Running locally

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

python -m engine.priors                       # writes data/player_priors.json (~3 min first run)
python -m engine.calibration.fetch_historical  # downloads historical seasons (~20MB, cached)
python -m engine.calibration.fit_coefficients  # writes engine/calibration/coefficients.json
python -m engine.calibration.team_strength     # writes engine/calibration/team_strength.json
ODDS_API_KEY=... python -m engine.odds         # writes data/odds.json (skips gracefully if unset)
python -m engine.understat                     # writes data/understat_xg.json
python -m engine.pipeline                      # writes the rest of /data/*.json

cd app
npm install
npm run dev                      # app reads /data via a symlink in app/public
```

## Roadmap

- [x] Initial-squad picker (EV model + optimiser + pitch-view PWA)
- [x] Team-ID tracking: transfers made, chips used, bank, rank history
- [x] Transfer suggestion engine (single-swap, factoring in hits/free transfers)
- [x] Multi-season historical priors + calibrated FDR/DC constants + adaptive in-season blending
- [x] Playing-time overhaul: starts-based `p_appearance`/`p_60_plus` split, not one flat ratio
- [x] Five-week transfer/chip planner with verified chip-window rules
- [x] Interactive Pick Team (validated tap-to-swap, optimise-lineup, captain) and Transfers/Planner staging cart
- [x] Prediction-accuracy tracking (logged RMSE/MAE vs. actual results, once gameweeks are scored)
- [x] Fixture-adjust the current-season rate blended into stabilization
- [x] Pitch/List view toggle - next-GW points on the pitch, multi-GW total in the list
- [x] Set-piece taker boost from `penalties_order`/`direct_freekicks_order`/`corners_and_indirect_freekicks_order`
- [x] Betting-odds integration (The Odds API) - devig + Poisson clean-sheet/xG, replacing FDR per-fixture where priced
- [x] Understat penalty/xG split correcting the multi-season prior for players who've lost/gained set-piece duty
- [x] Team-level historical strength model - replaces FPL's FDR for newly-promoted opponents only
- Skipped by choice: FPL account token auth for pre-deadline squad sync - too fragile (manual OIDC
  token extraction, periodic re-pasting) for what it'd add on top of public team-ID tracking
