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
gameweek-by-gameweek error will be tracked in-app once the season starts.

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
  constants against historical data - manual only, meant to be re-run once a
  season closes out, not on any automatic cadence.
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

Known limitation: the current-season rate blended in isn't yet adjusted for
the difficulty of opponents already faced this season (only the calibrated
FDR tables applied to *upcoming* fixtures are) - full per-gameweek-with-FDR
history for every player would add ~587 more calls to what's otherwise a
deliberately cheap, 2-call hot loop. Flagged as a fast-follow.

## Squad optimisation

`engine/optimise.py` uses [PuLP](https://coin-or.github.io/pulp/) with the
free, open-source CBC solver to pick the highest-EV 15-man squad within
budget, position and per-club constraints, then the best starting XI,
captain and vice-captain from within it.

## Running locally

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

python -m engine.priors                       # writes data/player_priors.json (~3 min first run)
python -m engine.calibration.fetch_historical  # downloads historical seasons (~20MB, cached)
python -m engine.calibration.fit_coefficients  # writes engine/calibration/coefficients.json
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
- [ ] Prediction-accuracy page (logged RMSE/MAE vs. actual results)
- [ ] Multi-gameweek transfer/chip planning (currently single-swap only)
- [ ] Fixture-adjust the current-season rate blended into stabilization (see "known limitation" above)
- [ ] Optional: FPL account token auth for pre-deadline squad sync
