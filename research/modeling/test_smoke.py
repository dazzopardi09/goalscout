# research/modeling/test_smoke.py
#
# Smoke tests for the modelling sandbox.
# No pytest required. Run with:
#   python test_smoke.py
# Exit code 0 = all pass, 1 = any failure.
#
# Tests:
#   1. tau values at the four special cells match the standard formula,
#      checked in BOTH trainer._tau_dc and scoreline._tau_dixon_coles
#      independently (guards against the two copies diverging again).
#   2. DC scoreline matrix with rho=0 equals the independent Poisson
#      scoreline matrix, cell by cell (tolerance 1e-12).
#   3. DC scoreline matrix with rho=0 also equals a hand-rolled Poisson
#      outer product (defence in depth).

from __future__ import annotations

import math
import sys
from datetime import datetime

from parameters import LeagueModelParams, TeamStrength
from scoreline import build_scoreline_matrix, _tau_dixon_coles
from trainer import _tau_dc

GOAL_CAP = 6
TOL = 1e-12


# ---------- Fixture ----------

def _make_params(model_type: str, rho) -> LeagueModelParams:
    return LeagueModelParams(
        league_id=0,
        model_type=model_type,
        mu_home=1.5,
        mu_away=1.1,
        gamma=0.25,
        rho=rho,
        team_strengths={
            "A": TeamStrength("A", attack=0.10, defence=-0.05),
            "B": TeamStrength("B", attack=-0.10, defence=0.05),
        },
        goal_cap=GOAL_CAP,
        trained_at=datetime.utcnow(),
        training_config={},
        metrics={},
    )


# ---------- Tests ----------

def test_tau_special_cells():
    """
    tau at the four special cells matches the standard DC formula in BOTH
    trainer._tau_dc and scoreline._tau_dixon_coles.
    """
    lh, la, rho = 1.5, 1.1, 0.1
    expected = {
        (0, 0): 1 - lh * la * rho,
        (0, 1): 1 + lh * rho,
        (1, 0): 1 + la * rho,
        (1, 1): 1 - rho,
    }
    for (x, y), ref in expected.items():
        a = _tau_dc(x, y, lh, la, rho)
        b = _tau_dixon_coles(x, y, lh, la, rho)
        assert abs(a - ref) < TOL, (
            f"trainer._tau_dc({x},{y}) = {a:.15f}, expected {ref:.15f}"
        )
        assert abs(b - ref) < TOL, (
            f"scoreline._tau_dixon_coles({x},{y}) = {b:.15f}, expected {ref:.15f}"
        )


def test_dc_rho_zero_equals_poisson_scoreline():
    """
    DC scoreline matrix with rho=0 must equal the Poisson scoreline matrix
    cell by cell (tolerance 1e-12).
    """
    dc_params = _make_params("dixon_coles", 0.0)
    p_params  = _make_params("poisson", None)

    dc_mat, _, _ = build_scoreline_matrix(dc_params, "A", "B")
    p_mat,  _, _ = build_scoreline_matrix(p_params,  "A", "B")

    assert set(dc_mat.keys()) == set(p_mat.keys()), "Key sets differ"
    for k in dc_mat:
        assert abs(dc_mat[k] - p_mat[k]) < TOL, (
            f"Cell {k}: DC={dc_mat[k]:.15f}, Poisson={p_mat[k]:.15f}"
        )


def test_dc_rho_zero_equals_independent_outer_product():
    """
    Defence in depth: DC(rho=0) also matches a hand-rolled Poisson outer
    product built from the same lambdas that build_scoreline_matrix returns.
    """
    dc_params = _make_params("dixon_coles", 0.0)
    dc_mat, lh, la = build_scoreline_matrix(dc_params, "A", "B")

    def pmf(k: int, lam: float) -> float:
        return math.exp(-lam) * lam ** k / math.factorial(k)

    raw = {
        (x, y): pmf(x, lh) * pmf(y, la)
        for x in range(GOAL_CAP + 1)
        for y in range(GOAL_CAP + 1)
    }
    total = sum(raw.values())
    ref = {k: v / total for k, v in raw.items()}

    for k in dc_mat:
        assert abs(dc_mat[k] - ref[k]) < TOL, (
            f"Cell {k}: DC={dc_mat[k]:.15f}, outer-product={ref[k]:.15f}"
        )


# ---------- Runner ----------

def run() -> int:
    tests = [
        test_tau_special_cells,
        test_dc_rho_zero_equals_poisson_scoreline,
        test_dc_rho_zero_equals_independent_outer_product,
    ]
    failures = 0
    for t in tests:
        try:
            t()
            print(f"PASS  {t.__name__}")
        except AssertionError as e:
            print(f"FAIL  {t.__name__}: {e}")
            failures += 1
        except Exception as e:
            print(f"ERROR {t.__name__}: {type(e).__name__}: {e}")
            failures += 1

    print(f"\n{len(tests) - failures}/{len(tests)} passed")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(run())
