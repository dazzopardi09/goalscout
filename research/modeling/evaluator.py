# research/modeling/evaluator.py
#
# Lightweight evaluation helpers for the modelling sandbox. New code (not
# adapted from the old backend's validation.py, which was DB-coupled and
# heavier than milestone 1 needs).

from __future__ import annotations

import math
from typing import Any, Dict, List, Tuple


def chronological_holdout_split(
    matches: List[Dict[str, Any]],
    holdout_pct: float,
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """
    Sort matches by date ascending. Return (train, holdout) where holdout
    is the chronologically last `holdout_pct` of the data.

    Football has temporal structure (form, table position, injuries), so a
    chronological split is the only honest baseline. A random split would
    leak information from the future into the training set.
    """
    if not matches:
        return [], []
    if not (0.0 < holdout_pct < 1.0):
        raise ValueError(
            f"holdout_pct must be in (0, 1), got {holdout_pct}"
        )

    sorted_matches = sorted(matches, key=lambda m: m["date"])
    n = len(sorted_matches)
    n_holdout = max(1, int(round(n * holdout_pct)))
    n_train = n - n_holdout

    if n_train < 1:
        raise ValueError(
            f"holdout_pct={holdout_pct} leaves no training data "
            f"(n={n}, n_holdout={n_holdout})"
        )

    return sorted_matches[:n_train], sorted_matches[n_train:]


def brier_score(probs: List[float], outcomes: List[int]) -> float:
    """
    Mean squared error between predicted probability and binary outcome.
    Lower is better. 0.25 = coin flip baseline.
    """
    if len(probs) != len(outcomes):
        raise ValueError("probs and outcomes must have the same length")
    if not probs:
        return float("nan")
    return sum((p - o) ** 2 for p, o in zip(probs, outcomes)) / len(probs)


def log_loss(
    probs: List[float],
    outcomes: List[int],
    eps: float = 1e-15,
) -> float:
    """
    Binary cross-entropy / log-loss. Lower is better.
    Probabilities are clipped to [eps, 1-eps] to avoid log(0).
    """
    if len(probs) != len(outcomes):
        raise ValueError("probs and outcomes must have the same length")
    if not probs:
        return float("nan")

    total = 0.0
    for p, o in zip(probs, outcomes):
        p_clipped = min(max(p, eps), 1.0 - eps)
        total += -(o * math.log(p_clipped) + (1 - o) * math.log(1.0 - p_clipped))
    return total / len(probs)
