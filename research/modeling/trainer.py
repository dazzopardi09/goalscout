# research/modeling/trainer.py
#
# Adapted from backend/app/modelling/trainer.py.
#
# Removed (DB layer):
#   - `from sqlalchemy.orm import Session`
#   - `from app.models.match import Match`
#   - `from app.modelling.repository import save_model_parameters`
#
# Replaced:
#   - `_load_training_data(db, config)` → `_build_training_data(matches, config)`
#     where `matches` is a list of plain Python dicts. No DB queries.
#   - `train_*_for_league(db, league_id, ...)` → `train_*(matches, ...)` —
#     no DB session, no save_model_parameters() call. Returns the params object.
#
# Preserved BYTE-IDENTICAL from original:
#   - `_compute_time_weights`
#   - `_initial_parameters`
#   - `_unpack_parameters`
#   - `_neg_log_likelihood_poisson`
#   - `_tau_dc`
#   - `_neg_log_likelihood_dc`
#   - `compute_match_lambdas`

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, date
from typing import Any, Dict, List, Optional, Sequence, Tuple

import math
import numpy as np
from scipy.optimize import minimize

from parameters import LeagueModelParams, TeamStrength


# ============================================================
# Data Structures
# ============================================================

@dataclass
class TrainingConfig:
    league_id: int = 0
    date_from: Optional[datetime] = None
    date_to: Optional[datetime] = None
    min_matches_per_team: int = 10
    lambda_reg: float = 0.1
    goal_cap: int = 6
    decay_half_life_days: Optional[float] = 180.0
    model_type: str = "poisson"  # or "dixon_coles"


@dataclass
class TrainingData:
    league_id: int
    team_ids: List[Any]                    # team identifiers (str names in this sandbox)
    team_index_by_id: Dict[Any, int]
    home_team_idx: np.ndarray
    away_team_idx: np.ndarray
    home_goals: np.ndarray
    away_goals: np.ndarray
    match_dates: List[date]


# ============================================================
# Build training data from a list of match dicts (DB-free)
# ============================================================

def _build_training_data(
    matches: List[Dict[str, Any]],
    config: TrainingConfig,
) -> TrainingData:
    """
    Build TrainingData from a list of plain Python dicts. Each dict must contain:
        home_team: hashable (str in this sandbox)
        away_team: hashable
        home_goals: int
        away_goals: int
        date:       datetime.date or datetime.datetime
    """
    if not matches:
        raise ValueError("No matches provided to trainer.")

    home_team_ids: List[Any] = []
    away_team_ids: List[Any] = []
    home_goals: List[int] = []
    away_goals: List[int] = []
    match_dates: List[date] = []

    for m in matches:
        home_team_ids.append(m["home_team"])
        away_team_ids.append(m["away_team"])
        home_goals.append(int(m["home_goals"]))
        away_goals.append(int(m["away_goals"]))

        d = m["date"]
        if isinstance(d, datetime):
            match_dates.append(d.date())
        else:
            match_dates.append(d)

    unique_team_ids = sorted(set(home_team_ids + away_team_ids))
    team_index_by_id = {tid: idx for idx, tid in enumerate(unique_team_ids)}

    hi = np.array([team_index_by_id[t] for t in home_team_ids], dtype=int)
    ai = np.array([team_index_by_id[t] for t in away_team_ids], dtype=int)
    hg = np.array(home_goals, dtype=int)
    ag = np.array(away_goals, dtype=int)

    return TrainingData(
        league_id=config.league_id,
        team_ids=unique_team_ids,
        team_index_by_id=team_index_by_id,
        home_team_idx=hi,
        away_team_idx=ai,
        home_goals=hg,
        away_goals=ag,
        match_dates=match_dates,
    )


# ============================================================
# Time Decay (DC Only)  — unchanged from original
# ============================================================

def _compute_time_weights(
    match_dates: Sequence[date],
    half_life_days: Optional[float],
    reference_date: Optional[date] = None,
) -> np.ndarray:

    n = len(match_dates)
    if half_life_days is None or half_life_days <= 0:
        return np.ones(n, dtype=float)

    if reference_date is None:
        reference_date = max(match_dates)

    ages = np.array([(reference_date - d).days for d in match_dates], dtype=float)
    return 2.0 ** (-ages / half_life_days)


# ============================================================
# Parameter Vector Helpers  — unchanged from original
# ============================================================

def _initial_parameters(
    data: TrainingData,
    model_type: str,
) -> np.ndarray:
    n_teams = len(data.team_ids)
    has_rho = model_type == "dixon_coles"

    mean_home = float(data.home_goals.mean())
    mean_away = float(data.away_goals.mean())

    log_mu_home0 = math.log(mean_home if mean_home > 0 else 1.0)
    log_mu_away0 = math.log(mean_away if mean_away > 0 else 1.0)
    gamma0 = math.log(mean_home / mean_away) if mean_away > 0 else 0.0
    rho0 = 0.0

    num_team_params = (n_teams - 1) * 2

    base = [log_mu_home0, log_mu_away0, gamma0]
    if has_rho:
        base.append(rho0)

    return np.array(base + [0.0] * num_team_params, dtype=float)


def _unpack_parameters(
    theta: np.ndarray,
    n_teams: int,
    model_type: str,
):
    has_rho = model_type == "dixon_coles"

    offset = 0
    log_mu_home = theta[offset]; offset += 1
    log_mu_away = theta[offset]; offset += 1
    gamma = theta[offset]; offset += 1

    rho = None
    if has_rho:
        rho = theta[offset]
        offset += 1

    attack_free = theta[offset: offset + (n_teams - 1)]
    offset += (n_teams - 1)
    defence_free = theta[offset: offset + (n_teams - 1)]

    attack = np.zeros(n_teams)
    defence = np.zeros(n_teams)

    attack[:-1] = attack_free
    attack[-1] = -attack_free.sum()

    defence[:-1] = defence_free
    defence[-1] = -defence_free.sum()

    mu_home = math.exp(log_mu_home)
    mu_away = math.exp(log_mu_away)

    return mu_home, mu_away, gamma, rho, attack, defence


# ============================================================
# Likelihood — Poisson  — unchanged from original
# ============================================================

def _neg_log_likelihood_poisson(
    theta: np.ndarray,
    data: TrainingData,
    lambda_reg: float,
):

    n_teams = len(data.team_ids)
    mu_home, mu_away, gamma, _, attack, defence = _unpack_parameters(
        theta, n_teams, "poisson"
    )

    hi = data.home_team_idx
    ai = data.away_team_idx
    x = data.home_goals.astype(float)
    y = data.away_goals.astype(float)

    lam_home = mu_home * np.exp(attack[hi] - defence[ai] + gamma)
    lam_away = mu_away * np.exp(attack[ai] - defence[hi])

    lam_home = np.clip(lam_home, 1e-8, None)
    lam_away = np.clip(lam_away, 1e-8, None)

    base = x * np.log(lam_home) - lam_home + y * np.log(lam_away) - lam_away

    reg = lambda_reg * ((attack**2).sum() + (defence**2).sum())
    return -(float(base.sum()) - reg)


# ============================================================
# Dixon–Coles τ adjustment  — standard formula (Dixon & Coles 1997)
# Fixed in Milestone 2: the inherited (0,0)/(1,0)/(0,1) branches were
# non-standard, producing tau(0,0) < 0 for typical lambdas and forcing
# the optimiser to rho=0 (degenerate Poisson).
# Standard form:
#   tau(0,0) = 1 - lam_home * lam_away * rho
#   tau(0,1) = 1 + lam_home * rho
#   tau(1,0) = 1 + lam_away * rho
#   tau(1,1) = 1 - rho
#   tau(x,y) = 1  for x+y >= 2
# ============================================================

def _tau_dc(x, y, lam_home, lam_away, rho):
    if (x, y) == (0, 0):
        return 1 - lam_home * lam_away * rho
    if (x, y) == (0, 1):
        return 1 + lam_home * rho
    if (x, y) == (1, 0):
        return 1 + lam_away * rho
    if (x, y) == (1, 1):
        return 1 - rho
    return 1.0


# ============================================================
# Likelihood — Dixon–Coles  — unchanged from original
# ============================================================

def _neg_log_likelihood_dc(
    theta: np.ndarray,
    data: TrainingData,
    weights: np.ndarray,
    lambda_reg: float,
):

    n_teams = len(data.team_ids)
    mu_home, mu_away, gamma, rho, attack, defence = _unpack_parameters(
        theta, n_teams, "dixon_coles"
    )
    if rho is None:
        rho = 0.0

    hi = data.home_team_idx
    ai = data.away_team_idx
    x = data.home_goals.astype(int)
    y = data.away_goals.astype(int)

    lam_home_arr = mu_home * np.exp(attack[hi] - defence[ai] + gamma)
    lam_away_arr = mu_away * np.exp(attack[ai] - defence[hi])

    lam_home_arr = np.clip(lam_home_arr, 1e-8, None)
    lam_away_arr = np.clip(lam_away_arr, 1e-8, None)

    total = 0.0
    for i in range(len(x)):
        lam_h = float(lam_home_arr[i])
        lam_a = float(lam_away_arr[i])
        tau = _tau_dc(int(x[i]), int(y[i]), lam_h, lam_a, rho)
        if tau <= 0:
            return 1e10

        total += weights[i] * (
            int(x[i]) * math.log(lam_h) - lam_h +
            int(y[i]) * math.log(lam_a) - lam_a +
            math.log(tau)
        )

    reg = lambda_reg * ((attack**2).sum() + (defence**2).sum())
    return -(total - reg)


# ============================================================
# TRAINERS  — DB layer removed, otherwise unchanged
# ============================================================

def train_poisson(
    matches: List[Dict[str, Any]],
    *,
    lambda_reg: float = 0.1,
    goal_cap: int = 6,
) -> LeagueModelParams:

    config = TrainingConfig(
        league_id=0,
        lambda_reg=lambda_reg,
        goal_cap=goal_cap,
        model_type="poisson",
    )

    data = _build_training_data(matches, config)
    theta0 = _initial_parameters(data, "poisson")

    result = minimize(
        _neg_log_likelihood_poisson,
        theta0,
        args=(data, lambda_reg),
        method="L-BFGS-B",
    )

    if not result.success:
        raise RuntimeError(f"Poisson optimisation failed: {result.message}")

    theta_star = result.x
    mu_home, mu_away, gamma, _, attack, defence = _unpack_parameters(
        theta_star, len(data.team_ids), "poisson"
    )

    team_strengths = {
        tid: TeamStrength(team_id=tid, attack=float(attack[idx]), defence=float(defence[idx]))
        for idx, tid in enumerate(data.team_ids)
    }

    trained_at = datetime.utcnow()

    return LeagueModelParams(
        league_id=0,
        model_type="poisson",
        mu_home=float(mu_home),
        mu_away=float(mu_away),
        gamma=float(gamma),
        rho=None,
        team_strengths=team_strengths,
        goal_cap=goal_cap,
        trained_at=trained_at,
        training_config={
            "lambda_reg": lambda_reg,
            "goal_cap": goal_cap,
        },
        metrics={
            "log_likelihood": float(
                -_neg_log_likelihood_poisson(theta_star, data, lambda_reg)
            ),
            "num_matches": int(len(data.home_goals)),
            "num_teams": len(data.team_ids),
            "optimizer_success": True,
            "optimizer_message": result.message,
        },
    )


def train_dixon_coles(
    matches: List[Dict[str, Any]],
    *,
    lambda_reg: float = 0.1,
    goal_cap: int = 6,
    decay_half_life_days: float = 180.0,
) -> LeagueModelParams:

    config = TrainingConfig(
        league_id=0,
        lambda_reg=lambda_reg,
        goal_cap=goal_cap,
        decay_half_life_days=decay_half_life_days,
        model_type="dixon_coles",
    )

    data = _build_training_data(matches, config)
    theta0 = _initial_parameters(data, "dixon_coles")

    weights = _compute_time_weights(
        match_dates=data.match_dates,
        half_life_days=decay_half_life_days,
        reference_date=None,
    )

    result = minimize(
        _neg_log_likelihood_dc,
        theta0,
        args=(data, weights, lambda_reg),
        method="L-BFGS-B",
    )

    if not result.success:
        raise RuntimeError(f"DC optimisation failed: {result.message}")

    theta_star = result.x
    mu_home, mu_away, gamma, rho, attack, defence = _unpack_parameters(
        theta_star, len(data.team_ids), "dixon_coles"
    )

    team_strengths = {
        tid: TeamStrength(team_id=tid, attack=float(attack[idx]), defence=float(defence[idx]))
        for idx, tid in enumerate(data.team_ids)
    }

    trained_at = datetime.utcnow()

    return LeagueModelParams(
        league_id=0,
        model_type="dixon_coles",
        mu_home=float(mu_home),
        mu_away=float(mu_away),
        gamma=float(gamma),
        rho=float(rho),
        team_strengths=team_strengths,
        goal_cap=goal_cap,
        trained_at=trained_at,
        training_config={
            "lambda_reg": lambda_reg,
            "goal_cap": goal_cap,
            "decay_half_life_days": decay_half_life_days,
        },
        metrics={
            "log_likelihood": float(
                -_neg_log_likelihood_dc(theta_star, data, weights, lambda_reg)
            ),
            "num_matches": int(len(data.home_goals)),
            "num_teams": len(data.team_ids),
            "rho": float(rho),
            "optimizer_success": True,
            "optimizer_message": result.message,
        },
    )


def compute_match_lambdas(
    params: LeagueModelParams,
    home_team_id: Any,
    away_team_id: Any,
) -> Tuple[float, float]:
    """
    Compute (lambda_home, lambda_away) for a single match given a trained
    LeagueModelParams object and the home/away team IDs (or names).

    Uses zero-strength fallback for unknown teams (matches original behaviour).
    Use scoreline.build_scoreline_matrix instead if you want strict ValueError
    on unknown teams.
    """
    home_strength: TeamStrength = params.team_strengths.get(
        home_team_id, TeamStrength(team_id=home_team_id, attack=0.0, defence=0.0)
    )
    away_strength: TeamStrength = params.team_strengths.get(
        away_team_id, TeamStrength(team_id=away_team_id, attack=0.0, defence=0.0)
    )

    attack_home = home_strength.attack
    defence_home = home_strength.defence
    attack_away = away_strength.attack
    defence_away = away_strength.defence

    lam_home = params.mu_home * math.exp(attack_home - defence_away + params.gamma)
    lam_away = params.mu_away * math.exp(attack_away - defence_home)

    return float(lam_home), float(lam_away)
