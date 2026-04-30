# research/modeling/markets.py
#
# Copied verbatim from backend/app/modelling/markets.py.
# Only change vs original: import path
#   `from app.modelling.scoreline` → `from scoreline`

from __future__ import annotations

from typing import Dict

from scoreline import ScorelineMatrix


def market_1x2(matrix: ScorelineMatrix) -> Dict[str, float]:
    """
    1X2 market probabilities from scoreline matrix.

    Returns:
        {"home": P(home win), "draw": P(draw), "away": P(away win)}
    """
    p_home = 0.0
    p_draw = 0.0
    p_away = 0.0

    for (x, y), p in matrix.items():
        if x > y:
            p_home += p
        elif x == y:
            p_draw += p
        else:
            p_away += p

    total = p_home + p_draw + p_away
    if total > 0:
        p_home /= total
        p_draw /= total
        p_away /= total

    return {
        "home": p_home,
        "draw": p_draw,
        "away": p_away,
    }


def market_btts(matrix: ScorelineMatrix) -> Dict[str, float]:
    """
    BTTS (Both Teams To Score) market.

    Returns:
        {"yes": P(both score >=1), "no": 1 - yes}
    """
    p_yes = 0.0
    for (x, y), p in matrix.items():
        if x > 0 and y > 0:
            p_yes += p

    p_no = max(0.0, 1.0 - p_yes)
    return {
        "yes": p_yes,
        "no": p_no,
    }


def market_over_under(
    matrix: ScorelineMatrix,
    line: float,
) -> Dict[str, float]:
    """
    Over/Under market for a given goal line (e.g. 2.5, 3.5).

    Returns:
        {"line": line, "over": P(goals > line), "under": P(goals < line)}
    """
    p_over = 0.0
    p_under = 0.0

    for (x, y), p in matrix.items():
        total_goals = x + y
        if total_goals > line:
            p_over += p
        elif total_goals < line:
            p_under += p
        # exact equality shouldn't occur for .5 lines, so ignore == case

    # small safety normalisation
    total = p_over + p_under
    if total > 0:
        p_over /= total
        p_under /= total

    return {
        "line": float(line),
        "over": p_over,
        "under": p_under,
    }


def market_correct_score(matrix: ScorelineMatrix) -> Dict[str, float]:
    """
    Correct score distribution – flattened to string keys "x-y".
    Useful for UI, trading, or debugging calibration.
    """
    out: Dict[str, float] = {}
    for (x, y), p in matrix.items():
        out[f"{x}-{y}"] = p
    return out
