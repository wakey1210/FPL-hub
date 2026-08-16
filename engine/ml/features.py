"""Builds a flat feature row for one player-gameweek from an already-built
`PlayerEV` + one of its `FixtureEV`s - reads fields straight off
`model.build_player_ev()`'s own output, including quantities exposed on
`PlayerEV`/`FixtureEV` specifically for this purpose (`xg90`, `attack_mult`,
`cs_prob`, etc. - see `engine/model.py`'s dataclass docstrings).

Both live inference (`engine/ml/predict.py`, fed by a real bootstrap-static)
and historical training (`engine/ml/train.py`, fed by
`engine.historical.bootstrap`'s reconstruction) call `build_player_ev()` the
exact same way and then this exact same function - eliminating train/serve
feature skew by construction (one shared code path), not by discipline
alone.
"""
from __future__ import annotations

from engine.model import FixtureEV, PlayerEV

POSITIONS = ["GKP", "DEF", "MID", "FWD"]

FEATURE_NAMES = [
    "xg90",
    "xa90",
    "dc90",
    "saves90",
    "dc_prob",
    "p_appearance",
    "p_60_plus",
    "expected_minutes_if_appears",
    "fdr",
    "is_home",
    "attack_mult",
    "cs_prob",
    "expected_conceded",
    "now_cost",
    "selected_by_percent",
    "has_penalties",
    "has_direct_freekicks",
    "has_corners",
    *[f"position_{p}" for p in POSITIONS],
]


def build_feature_row(player: PlayerEV, fixture: FixtureEV, element: dict) -> dict[str, float]:
    """`element` is the raw bootstrap element dict, needed only for the
    set-piece order flags - not yet exposed on `PlayerEV` since they're a
    discrete role flag, not a computed rate. Note: in historical training
    rows these are always 0 (see `engine.historical.bootstrap`'s documented
    "no set-piece history" limitation) - harmless (XGBoost can't split on a
    zero-variance training feature, so it's simply unused at inference too),
    kept for a consistent feature schema rather than special-cased away.
    """
    row: dict[str, float] = {
        "xg90": player.xg90,
        "xa90": player.xa90,
        "dc90": player.dc90,
        "saves90": player.saves90,
        "dc_prob": player.dc_prob,
        "p_appearance": player.p_appearance,
        "p_60_plus": player.p_60_plus,
        "expected_minutes_if_appears": player.expected_minutes_if_appears,
        "fdr": float(fixture.fdr),
        "is_home": 1.0 if fixture.is_home else 0.0,
        "attack_mult": fixture.attack_mult,
        "cs_prob": fixture.cs_prob,
        "expected_conceded": fixture.expected_conceded,
        "now_cost": float(player.now_cost),
        "selected_by_percent": player.selected_by_percent,
        "has_penalties": 1.0 if element.get("penalties_order") else 0.0,
        "has_direct_freekicks": 1.0 if element.get("direct_freekicks_order") else 0.0,
        "has_corners": 1.0 if element.get("corners_and_indirect_freekicks_order") else 0.0,
    }
    for pos in POSITIONS:
        row[f"position_{pos}"] = 1.0 if player.position == pos else 0.0
    return row


def points90_target(total_points: int, minutes: int) -> float:
    """Points earned beyond the deterministic appearance points, scaled to
    /90 - identical target definition to
    `engine/calibration/fit_coefficients.py`'s regression, for direct
    comparability between the ridge-regression heuristic fit and this model.
    """
    appearance_pts = 2 if minutes >= 60 else 1
    return (total_points - appearance_pts) * (90 / minutes)
