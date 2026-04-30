# research/modeling/scoreline.py
#
# Copied verbatim from backend/app/modelling/scoreline.py.
# Only change vs original: import path
#   `from app.modelling.parameters` → `from parameters`

from __future__ import annotations

import math
from typing import Dict, Tuple

from parameters import LeagueModelParams, TeamStrength


ScorelineMatrix = Dict[Tuple[int, int], float]


def _get_team_strengths(params: LeagueModelParams, team_id: int) -> TeamStrength:
    try:
        return params.team_strengths[team_id]
    except KeyError:
        raise ValueError(
            f"Team ID {team_id} not found in model parameters for league_id={params.league_id}"
        )


def _compute_lambdas(
    params: LeagueModelParams,
    home_team_id: int,
    away_team_id: int,
) -> Tuple[float, float]:
    """
    λ_home = mu_home * exp(attack_home - defence_away + gamma)
    λ_away = mu_away * exp(attack_away - defence_home)
    """
    home = _get_team_strengths(params, home_team_id)
    away = _get_team_strengths(params, away_team_id)

    lam_home = (
        params.mu_home
        * math.exp(home.attack - away.defence + params.gamma)
    )
    lam_away = (
        params.mu_away
        * math.exp(away.attack - home.defence)
    )

    # Safety guard
    lam_home = max(lam_home, 1e-8)
    lam_away = max(lam_away, 1e-8)

    return lam_home, lam_away


def _poisson_pmf(k: int, lam: float) -> float:
    return math.exp(-lam) * lam**k / math.factorial(k)


def _tau_dixon_coles(
    x: int,
    y: int,
    lam_home: float,
    lam_away: float,
    rho: float,
) -> float:
    """
    Standard Dixon-Coles (1997) low-score adjustment factor tau(x, y).
    Fixed in Milestone 2: inherited branches were non-standard.
      tau(0,0) = 1 - lam_home * lam_away * rho
      tau(0,1) = 1 + lam_home * rho
      tau(1,0) = 1 + lam_away * rho
      tau(1,1) = 1 - rho
      tau(x,y) = 1  for x+y >= 2
    """
    if (x, y) == (0, 0):
        return 1 - lam_home * lam_away * rho
    if (x, y) == (0, 1):
        return 1 + lam_home * rho
    if (x, y) == (1, 0):
        return 1 + lam_away * rho
    if (x, y) == (1, 1):
        return 1 - rho
    return 1.0


def build_scoreline_matrix(
    params: LeagueModelParams,
    home_team_id: int,
    away_team_id: int,
    *,
    normalise: bool = True,
) -> Tuple[ScorelineMatrix, float, float]:
    """
    Build full scoreline probability matrix P(X=x, Y=y) for x,y in [0, goal_cap].

    Returns:
        matrix: dict[(x, y)] -> probability
        lam_home, lam_away: Poisson means used
    """
    lam_home, lam_away = _compute_lambdas(params, home_team_id, away_team_id)
    G = params.goal_cap

    matrix: ScorelineMatrix = {}
    total = 0.0

    use_dc = params.model_type == "dixon_coles" and params.rho is not None

    for x in range(G + 1):
        px = _poisson_pmf(x, lam_home)
        for y in range(G + 1):
            py = _poisson_pmf(y, lam_away)
            p = px * py

            if use_dc:
                tau = _tau_dixon_coles(x, y, lam_home, lam_away, params.rho)
                p *= tau

            matrix[(x, y)] = p
            total += p

    # Normalise to sum to 1 (within truncated grid)
    if normalise and total > 0:
        for k in list(matrix.keys()):
            matrix[k] = matrix[k] / total

    return matrix, lam_home, lam_away
