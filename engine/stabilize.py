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

    Only for genuine *rate* stats (attacking output, defensive actions,
    saves) - you can't measure a per-90 rate with zero minutes, so falling
    back to the prior is correct there. Selection stats (whether a player
    plays at all) need `blend_rate_by_games` instead - see its docstring for
    why keying that on the player's own minutes is actively wrong.
    """
    weight_current = blend_weight(stat, current_minutes)
    return weight_current * current_rate + (1 - weight_current) * prior_rate


# Team games played at which a *selection* stat (will this player play at
# all, not how well) is weighted equally with the historical prior.
#
# Deliberately fast - 1 game, not the 3-4 a *rate* stat needs (see
# STAT_STABILIZATION_MINUTES). A rate genuinely is noisy at small samples
# (a shot taken or not is partly luck), so it's right to lean on the prior
# for a few matches. Selection isn't the same kind of noisy: a fit,
# unsuspended player registering zero involvement is a fairly clear signal
# on its own, and critically, minutes gate *everything else* - a brilliant
# underlying rate is worth exactly zero points if the player doesn't set
# foot on the pitch, so under-reacting here is far costlier than
# over-reacting. Weighting current data equally with the prior after just
# one missed game (and >50% after two) means a nailed player's rating falls
# hard the moment they're dropped, and recovers just as fast the moment
# they start again - deliberately symmetric, not just a one-way penalty.
STAT_STABILIZATION_GAMES: dict[str, float] = {
    "minutes_share": 1,
    "starts": 1,
}


def blend_weight_by_games(stat: str, team_played: int) -> float:
    """Fraction of the blend that should come from current-season data, for
    selection stats - keyed on games the player's *team* has played, not the
    player's own accumulated minutes.

    A fit, unsuspended player who's an unused substitute or left out of the
    squad entirely has zero minutes by construction - `blend_weight` would
    return 0.0 for them no matter how many gameweeks that's true for, so a
    real, strengthening "this player isn't being picked" signal could never
    outweigh a stale prior. Games played is the right sample-size measure
    here instead: "0 starts in 1 team game" is weak evidence (could be
    rotation), but "0 starts in 4 team games" for someone with no injury
    flag is strong evidence regardless of how few minutes they've had -
    the whole point being measured is an *absence* of minutes, so gating
    the measurement on minutes is circular.
    """
    k = STAT_STABILIZATION_GAMES[stat]
    if team_played <= 0:
        return 0.0
    return team_played / (team_played + k)


def blend_rate_by_games(stat: str, current_rate: float, team_played: int, prior_rate: float) -> float:
    """Selection-stat counterpart to `blend_rate` - see `blend_weight_by_games`."""
    weight_current = blend_weight_by_games(stat, team_played)
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

    # Selection-stat worked example: a fit player who was a ~76% multi-
    # season starter, left out of the squad entirely (0 starts) for several
    # of their team's games with no injury flag.
    starts_prior = 0.76
    for games in (0, 1, 3, 6):
        blended_starts = blend_rate_by_games("starts", 0.0, games, starts_prior)
        weight = blend_weight_by_games("starts", games)
        print(f"{games} team games missed: weight_current={weight:.3f}, blended_starts_share={blended_starts:.3f}")
