# research/modeling/parameters.py
#
# Adapted from backend/app/modelling/parameters.py.
# Only change vs original: `team_id` and team_strengths key annotations relaxed
# from `int` to `Any`, because in this sandbox we identify teams by name (str)
# rather than by DB primary key.

from __future__ import annotations
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Dict, Optional


@dataclass
class TeamStrength:
    team_id: Any
    attack: float
    defence: float


@dataclass
class LeagueModelParams:
    """
    Domain object representing a trained Poisson or Dixon–Coles model.
    """
    league_id: int
    model_type: str  # "poisson" or "dixon_coles"

    mu_home: float
    mu_away: float
    gamma: float
    rho: Optional[float] = None

    team_strengths: Dict[Any, TeamStrength] = None
    goal_cap: int = 6
    trained_at: Optional[datetime] = None

    training_config: Dict = None
    metrics: Dict = None
