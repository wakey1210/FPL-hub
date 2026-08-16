"""Adaptive blend between a player's multi-season historical prior
(`engine/priors.py`) and their current-season rate, so the model reacts
quickly to emerging players early in the season without being whipsawed by
small-sample noise, and settles onto season-to-date form by mid-season.

This is an empirical-Bayes-style shrinkage estimator: each underlying rate
stat has its own "stabilization point" `K`, in minutes of *current-season*
data, at which it's weighted equally with the historical prior. Stats that
naturally vary less match-to-match (defensive actions happen almost every
game a player starts) stabilize faster than higher-variance ones (a
striker's underlying chance quality takes longer to distinguish from noise).

    weight_current = current_minutes / (current_minutes + K)
    blended        = weight_current * current_rate + (1 - weight_current) * prior_rate

`current_rate` must already be fixture-difficulty-adjusted by the caller
(normalized for the strength of opponents already faced this season, rebased
to an FDR-3 equivalent) before being passed in here - that's what stops a hot
streak against soft fixtures being over-trusted. The calibrated
`fdr_attack_mult`/`fdr_clean_sheet_prob` from `engine/calibration` are then
applied separately, afterwards, to the *upcoming* fixtures being forecast -
so opponent strength is accounted for once on the way in (past) and once on
the way out (future), never both at once for the same fixture.
"""
from __future__ import annotations

# Minutes of current-season data at which a stat is weighted equally with
# the historical prior - see the module docstring for the reasoning.
STAT_STABILIZATION_MINUTES: dict[str, float] = {
    "defensive_contribution": 180,  # ~2 matches - happens almost every game a player starts
    "expected_goals": 300,  # ~3.3 matches
    "expected_assists": 450,  # ~5 matches - creativity is noisier than shot-taking
    "start_rate": 360,  # ~4 matches
    "saves": 630,  # ~7 matches
}


def blend_weight(stat: str, current_minutes: float) -> float:
    """Fraction of the blend that should come from current-season data."""
    k = STAT_STABILIZATION_MINUTES[stat]
    if current_minutes <= 0:
        return 0.0
    return current_minutes / (current_minutes + k)


def blend_rate(stat: str, current_rate: float, current_minutes: float, prior_rate: float) -> float:
    """Blends a fixture-adjusted current-season rate with a multi-season
    prior. With zero current-season minutes this returns exactly the prior
    (weight_current=0) - the correct behaviour pre-season and for anyone who
    hasn't played yet.
    """
    weight_current = blend_weight(stat, current_minutes)
    return weight_current * current_rate + (1 - weight_current) * prior_rate


if __name__ == "__main__":
    # Self-check against the worked example from the design: a breakout
    # player with a fixture-adjusted xg90 of 0.55 against a multi-season
    # prior of 0.28.
    prior = 0.28
    current = 0.55
    for label, minutes in [("GW6", 540), ("GW15", 1350)]:
        blended = blend_rate("expected_goals", current, minutes, prior)
        weight = blend_weight("expected_goals", minutes)
        print(f"{label}: {minutes} mins, weight_current={weight:.3f}, blended_xg90={blended:.3f}")

    fluke = blend_rate("expected_goals", 1.2, 180, prior)
    print(f"Single fluke hat-trick (180 mins, rate=1.2): blended_xg90={fluke:.3f}")

    rookie = blend_rate("expected_goals", 0.0, 0, prior)
    assert rookie == prior, "zero current-season minutes should return exactly the prior"
    print(f"Zero minutes: blended_xg90={rookie:.3f} (== prior, as expected)")
