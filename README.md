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
  recomputes predictions every 3 hours as a baseline, or on demand via
  `workflow_dispatch`, committing the results to `/data`. FPL has no webhook
  for "a fixture just finished", so an additional 15-minute poll runs across
  the windows Premier League fixtures actually kick off in (Fri-Mon all day,
  Tue-Thu evenings, UTC) - each run only actually commits (and redeploys
  Pages) if `/data` genuinely changed, so this stays cheap the rest of the
  time. If a `FPL_TEAM_ID` repository variable is set, it also tracks that
  manager's squad/transfers/chips/bank and generates transfer suggestions.
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

### Confirm my squad - a rolling planner before any live sync

The Planner tab is meant to replace a transfer-planning spreadsheet, which
is most valuable exactly when there's no live-synced FPL team yet to work
from. A "Confirm my squad" button on Pick Team (shown whenever there's no
live team sync) saves the currently-shown 15 plus a manually-entered bank
and free-transfers count locally (`app/src/lib/useDeclaredTeam.ts`) - never
written back to FPL, same boundary as everything else in this app. From
there, `engine/transfers.py`'s single-swap suggester and `engine/planner.py`'s
full 5-week/chip planner are ported line-for-line to TypeScript
(`app/src/lib/transferSuggestions.ts`, `transferPlanner.ts`) so both run
entirely client-side against the already-fetched `players.json` - "rolling"
comes for free, since that data already refreshes every 3 hours via the
existing hot loop, with no new backend polling. A "Chips used" editor
(`ChipsUsedEditor.tsx`) lets the plan know which of each chip's two
half-season windows are already spent, since there's no live sync to read
that from otherwise. The moment a real FPL team ID starts returning
post-deadline picks, the declared state is cleared and the server-computed
`transfer_plan.json`/`transfer_suggestions.json` take over as the
authoritative source, exactly mirroring the existing pitch-view fallback.

Every suggestion and plan step explains itself using the incoming player's
own underlying-stats/fixture-difficulty "why" factors plus a line
quantifying the edge over the outgoing player - on both the server
(`engine/transfers.py`/`engine/planner.py`) and client paths, so this isn't
just a raw EV-delta number.

### "Form is temporary, class is permanent" - a consistency-weighted risk

A player who's been reliably good across several seasons is lower-risk than
one whose similar average was driven by a single standout season or a short
hot streak. `engine/priors.py` computes the coefficient of variation of
each qualifying season's own `expected_goal_involvements` per-90 rate (zero
new API calls - each season's rate is already derived inside the existing
multi-season blend, before being collapsed into a weighted average); `None`
if fewer than 2 seasons qualify, since a single season has no meaningful
spread to measure. `engine/model.py` composes a small, bounded adjustment
onto the uncertainty band from this - tightening it for consistently
productive players, widening it for boom-bust ones - and surfaces a "why"
clause when it's a materially notable case either way.

### Historical backtest + a genuine ML prediction, run in parallel

Prompted by a technique used to backtest statistical models against real
sports results: `engine/historical/` reconstructs a bootstrap-shaped state
for any cached historical season "as of" a given gameweek (no lookahead -
only gameweeks strictly before are ever visible), letting the *existing*
model/optimiser/transfer logic - completely unmodified - simulate a full
season's real squad-selection and transfer decisions, scored against real
recorded results. `engine.historical.run_season`/`score.py` validate the
transfer/planner *decisions* this way (distinct from `fit_coefficients.py`'s
per-player-gameweek RMSE), and `tune.py` reuses the same harness for a
small, human-reviewed grid search over a handful of hand-picked constants -
never gradient-based/RL tuning, always a printed old-vs-new table a person
reviews before manually adopting a change. See that package's module
docstrings for the honest limitations found while building it (a same-season
synthetic prior was needed since no real prior data exists historically; a
documented run-to-run variance from EV ties; a necessarily uninformed GW1).

That same historical reconstruction is the shared foundation for a second,
genuinely-trained prediction: `engine/ml/` fits an XGBoost model (matching
OpenFPL's own published approach) on real player-gameweek outcomes across
the seasons with full xG data (2022-23 onward - confirmed by inspecting the
cached CSVs, since earlier seasons are missing either `position`/`team`
columns or the xG stats entirely) plus the current season's own gameweeks
already played, **refetched and fully retrained from scratch every week**
(`retrain-model.yml`) - not incremental boosting-continuation, which is
fragile and hard to roll back. Every feature it trains/predicts on is read
directly off `engine.model.build_player_ev()`'s own output (several
previously-internal quantities - `xg90`, `attack_mult`, `cs_prob`, etc. -
are now exposed on `PlayerEV`/`FixtureEV` specifically for this), so the
exact same code computes a feature whether called live or during training -
eliminating train/serve skew by construction, not by discipline.

This `ml_ev`/`ml_why` prediction is **parallel, never a replacement**:
`engine/accuracy.py` logs and scores both the heuristic and the ML model
side by side every gameweek, and the ML numbers are only ever surfaced in
the app (currently just the More tab's accuracy comparison) once gameweek 6
has passed *and* its logged RMSE has beaten the heuristic's over 4
consecutive scored gameweeks - a code-level check
(`accuracy.ml_currently_better()`), not a one-off manual judgment, and it's
hidden again automatically if it falls behind. Explanations use SHAP's
per-prediction feature attributions, so this doesn't regress into FFH-style
"trust me" even though it's a trained model, not a hand-picked formula.

## Running locally

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
# macOS only, for engine/ml/: brew install libomp (xgboost needs it locally;
# Linux/CI runners already bundle libgomp)

python -m engine.priors                       # writes data/player_priors.json (~3 min first run)
python -m engine.calibration.fetch_historical  # downloads historical seasons (~20MB, cached)
python -m engine.calibration.fit_coefficients  # writes engine/calibration/coefficients.json
python -m engine.calibration.team_strength     # writes engine/calibration/team_strength.json
ODDS_API_KEY=... python -m engine.odds         # writes data/odds.json (skips gracefully if unset)
python -m engine.understat                     # writes data/understat_xg.json
python -m engine.ml.train                      # writes engine/ml/model.json (skips gracefully if slow/unavailable)
python -m engine.pipeline                      # writes the rest of /data/*.json

# Optional, ad hoc - not part of any scheduled workflow:
python -m engine.historical.run_season --season 2024-25

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
- [x] Confirm-my-squad + fully rolling (single-GW and 5-week/chip) planner, ported to run client-side
- [x] Transfer/plan-step rationale using the incoming player's own underlying-stats/fixture-difficulty "why"
- [x] Consistency-weighted uncertainty ("form is temporary, class is permanent")
- [x] Historical backtest/replay harness (`engine/historical/`) + human-reviewed constant-tuning tool
- [x] Parallel OpenFPL-style ML prediction (XGBoost, retrained weekly), tracked but gated behind proven real accuracy
- Skipped by choice: FPL account token auth for pre-deadline squad sync - too fragile (manual OIDC
  token extraction, periodic re-pasting) for what it'd add on top of public team-ID tracking
