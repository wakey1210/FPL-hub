"""Daily price history log and a price-risk heuristic.

FPL prices move roughly once a day (~00:30-02:30 UTC) based on net transfer
momentum, but FPL publishes no official "chance of a price change" number -
only community sites reverse-engineer estimates from undocumented thresholds.
This module deliberately does NOT invent a fake percentage. It only:

1. Logs each day's `now_cost` per player (`record_prices`), keyed by UTC
   calendar date - same load/write-a-JSON-log shape as engine/accuracy.py
   (via engine/jsonlog.py), just keyed by date instead of gameweek. This is
   also the ONLY reliable source of "did this player's price actually change
   today": FPL's own `cost_change_event` field accumulates over the whole
   current gameweek (since the last deadline), not the calendar day, so
   `build_price_moves` diffs today's logged price against yesterday's
   instead of trusting `cost_change_event` for same-day movement.
2. Buckets players into a coarse, hand-picked risk category from their raw
   transfer momentum (`price_risk_bucket`) - same "documented heuristic, not
   a calibrated fit" status as model.py's FDR_* tables or transfers.py's
   HIT_COST, not a statistically fitted probability.

Retention: full-season, no pruning. At ~587 players x a handful of bytes each,
a full season of daily entries is roughly 1MB - trivial for a committed JSON
file - and keeps the door open for a future squad-value trend chart.
"""
from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Literal

from engine.jsonlog import load_log, write_log
from engine.model import PlayerEV

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
LOG_PATH = DATA_DIR / "price_log.json"

RiskBucket = Literal["rising", "watch", "stable", "falling", "already moved today"]


def _load_log() -> dict:
    return load_log(LOG_PATH, {"days": {}})


def _write_log(log: dict) -> None:
    write_log(LOG_PATH, log)


def record_prices(players: list[PlayerEV], now_utc: datetime) -> None:
    """Overwrites today's (UTC calendar date) price snapshot on every
    pipeline run - safe to call repeatedly, no lock/dedupe state needed. The
    existing 3-hourly cron (00/03/06/09/12/15/18/21 UTC) already brackets
    FPL's real change window: the 00:00 run writes yesterday's stable price,
    the 03:00 run overwrites it with today's real post-change price, and
    every run after that just re-writes the same unchanged value (no diff,
    no extra commit, per pipeline.yml's existing "skip if nothing changed"
    guard).
    """
    log = _load_log()
    date_key = now_utc.date().isoformat()
    log["days"][date_key] = {
        "date": date_key,
        "recorded_at": now_utc.isoformat(),
        "prices": {str(p.id): p.now_cost for p in players},
    }
    _write_log(log)


def _yesterdays_prices(now_utc: datetime) -> dict[str, int] | None:
    """The most recent logged day strictly before today, if one exists -
    `None` on the very first day this module has ever run (nothing to diff
    against yet). Assumes `record_prices` has already been called for today
    in this same pipeline run, so "today" itself is excluded from the
    candidates."""
    log = _load_log()
    today_key = now_utc.date().isoformat()
    prior_days = sorted(d for d in log["days"] if d < today_key)
    if not prior_days:
        return None
    return log["days"][prior_days[-1]]["prices"]


# Hand-picked cutoffs on momentum-per-owner, same documented-heuristic status
# as model.py's FDR_* tables / transfers.py's HIT_COST - not a calibrated fit,
# since FPL doesn't publish the real thresholds to fit against.
RISING_CUTOFF = 0.02
WATCH_CUTOFF = 0.005
FALLING_CUTOFF = -0.02
WATCH_FALL_CUTOFF = -0.005

# Floor for the owner-base denominator so a near-zero-owned player's momentum
# ratio doesn't blow up from a handful of transfers.
MIN_OWNER_BASE = 1000.0


def price_risk_bucket(p: PlayerEV, total_managers: int, moved_today: bool) -> RiskBucket:
    """Coarse, forward-looking risk bucket from net transfer momentum
    normalized by current ownership - NOT a fake percentage. FPL doesn't
    publish exact price-change thresholds, only the raw transfer counts this
    is built from, which is exactly what the UI shows alongside the bucket
    so the user can judge the evidence themselves.

    `total_managers` must be FPL's real manager count (bootstrap-static's
    top-level `total_players` field, confusingly named - it's managers, not
    footballers) - passing the footballer pool size here instead would make
    `owner_base` collapse to `MIN_OWNER_BASE` for almost every player
    regardless of real ownership, since even a 100%-owned player's share of
    ~600 footballers is far below that floor.

    `moved_today` comes from the caller diffing today's logged price against
    yesterday's (see `_yesterdays_prices`) rather than this function reading
    `cost_change_event` itself - that field is gameweek-cumulative, not
    daily, so it can't answer "did this change today" on its own.
    """
    if moved_today:
        # Already moved today - reporting a forward-looking bucket here
        # would be stale, not wrong-but-harmless.
        return "already moved today"

    net_momentum = p.transfers_in_event - p.transfers_out_event
    owner_base = max(total_managers * p.selected_by_percent / 100, MIN_OWNER_BASE)
    momentum_ratio = net_momentum / owner_base

    if momentum_ratio >= RISING_CUTOFF:
        return "rising"
    if momentum_ratio >= WATCH_CUTOFF:
        return "watch"
    if momentum_ratio <= FALLING_CUTOFF:
        return "falling"
    if momentum_ratio <= WATCH_FALL_CUTOFF:
        return "watch"
    return "stable"


def build_price_moves(
    players: list[PlayerEV], generated_at: str, total_managers: int, now_utc: datetime
) -> dict:
    """Builds the `data/price_moves.json` payload: today's already-happened
    risers/fallers (from a real day-over-day price diff, not FPL's
    gameweek-cumulative `cost_change_event`), plus a forward-looking
    watchlist bucketed by `price_risk_bucket`. Raw transfer numbers are
    included throughout so the frontend never needs to (and never should)
    present a fake precise percentage.
    """
    yesterday_prices = _yesterdays_prices(now_utc)

    def daily_change(p: PlayerEV) -> int:
        if yesterday_prices is None:
            return 0  # no prior snapshot yet - nothing to diff against
        prev = yesterday_prices.get(str(p.id))
        if prev is None:
            return 0  # new to the game/log since yesterday
        return p.now_cost - prev

    changes = {p.id: daily_change(p) for p in players}

    risers = sorted(
        (p for p in players if changes[p.id] > 0),
        key=lambda p: -changes[p.id],
    )
    fallers = sorted(
        (p for p in players if changes[p.id] < 0),
        key=lambda p: changes[p.id],
    )

    watchlist = []
    for p in players:
        bucket = price_risk_bucket(p, total_managers, moved_today=changes[p.id] != 0)
        if bucket in ("rising", "falling"):
            watchlist.append(
                {
                    "id": p.id,
                    "web_name": p.web_name,
                    "team_short": p.team_short,
                    "position": p.position,
                    "bucket": bucket,
                    "transfers_in_event": p.transfers_in_event,
                    "transfers_out_event": p.transfers_out_event,
                    "cost_change_event": p.cost_change_event,
                    "now_cost": p.now_cost,
                }
            )
    watchlist.sort(key=lambda w: -(w["transfers_in_event"] - w["transfers_out_event"]))

    def _move_row(p: PlayerEV) -> dict:
        return {
            "id": p.id,
            "web_name": p.web_name,
            "team_short": p.team_short,
            "position": p.position,
            "now_cost": p.now_cost,
            "cost_change_today": changes[p.id],
            "cost_change_event": p.cost_change_event,
            "transfers_in_event": p.transfers_in_event,
            "transfers_out_event": p.transfers_out_event,
        }

    return {
        "generated_at": generated_at,
        "risers_today": [_move_row(p) for p in risers],
        "fallers_today": [_move_row(p) for p in fallers],
        "watchlist": watchlist,
    }
