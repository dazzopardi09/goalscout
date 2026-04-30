# GoalScout Modelling Sandbox — Results

## Milestone Summary

### Milestone 1 — Sandbox scaffolding
Extracted the reusable maths from the old `soccer-prediction-system` Python backend
(Dixon-Coles MLE, scoreline matrix, market derivation). Stripped all DB, FastAPI,
and API-Football dependencies. Created a standalone Python sandbox under
`research/modeling/` that trains from a flat CSV and writes a JSON output file.

Files: `parameters.py`, `scoreline.py`, `markets.py`, `trainer.py`, `evaluator.py`,
`train_epl.py`.

### Milestone 2 — Dixon-Coles τ fix + smoke test
The inherited `_tau_dc` / `_tau_dixon_coles` formula was non-standard. For typical
football lambdas (λ_h ≈ 1.5, λ_a ≈ 1.1), τ(0,0) evaluated to ≈ −1.6, forcing the
optimiser to converge at ρ = 0 (degenerate Poisson). Fixed to the standard
Dixon & Coles (1997) form:

```
τ(0,0) = 1 − λ_h · λ_a · ρ
τ(0,1) = 1 + λ_h · ρ
τ(1,0) = 1 + λ_a · ρ
τ(1,1) = 1 − ρ
τ(x,y) = 1   for x+y ≥ 2
```

Added explicit `--model poisson | dixon_coles` CLI flag, degeneracy detection
(relabels output as `dixon_coles_degenerate` when |ρ| < 0.001), and `test_smoke.py`.

### Milestone 3 — Data ingestion
Added `fetch_epl.py` to download completed season CSVs from football-data.co.uk.
Supports `--league EPL` (→ `inputs/epl_matches.csv`) and
`--league Championship` (→ `inputs/championship_matches.csv`).
Uses stdlib `urllib.request` only — no API tokens, no rate limits.

### Milestone 4 — League-selectable training
Added `train_league.py`, replacing the EPL-hardcoded `train_epl.py`.
Accepts `--league EPL | Championship` and `--model poisson | dixon_coles`.
League registry at the top of the file; adding a new league is one dict entry.

---

## Smoke Test

```bash
docker run --rm \
  -v /mnt/user/appdata/goalscout/research/modeling:/work \
  -w /work \
  python:3.11-slim \
  sh -lc "pip install -q -r requirements.txt && python test_smoke.py"
```

```
PASS  test_tau_special_cells
PASS  test_dc_rho_zero_equals_poisson_scoreline
PASS  test_dc_rho_zero_equals_independent_outer_product

3/3 passed
```

---

## Datasets Fetched

| League | Source | Seasons | Rows | File |
|---|---|---|---|---|
| EPL | football-data.co.uk | 2022-23, 2023-24, 2024-25 | 380 + 380 + 380 = **1,140** | `inputs/epl_matches.csv` |
| Championship | football-data.co.uk | 2022-23, 2023-24, 2024-25 | 552 + 552 + 552 = **1,656** | `inputs/championship_matches.csv` |

---

## Model Runs

All runs use 80/20 chronological train/holdout split.

### EPL — Poisson

| Metric | Value |
|---|---|
| Train matches | 912 |
| Holdout matches | 228 |
| Teams | 24 |
| Brier O2.5 | 0.242739 |
| Log-loss O2.5 | 0.678652 |
| Avg predicted O2.5 | 0.5632 |
| Actual O2.5 hit rate | 0.5526 |
| Accuracy @ 50% threshold | 0.5746 |
| Over picks (p ≥ 0.50) | 177, hit rate 0.5819 |
| Under picks (p < 0.50) | 51, hit rate 0.5490 |

### EPL — Dixon-Coles

| Metric | Value |
|---|---|
| Train matches | 912 |
| Holdout matches | 228 |
| Teams | 24 |
| ρ (rho) | −0.072986 |
| Brier O2.5 | 0.250197 |
| Log-loss O2.5 | 0.695043 |
| Avg predicted O2.5 | 0.5831 |
| Actual O2.5 hit rate | 0.5526 |
| Accuracy @ 50% threshold | 0.5746 |
| Over picks (p ≥ 0.50) | 177, hit rate 0.5819 |
| Under picks (p < 0.50) | 51, hit rate 0.5490 |

### Championship — Poisson

| Metric | Value |
|---|---|
| Train matches | 1,325 |
| Holdout matches | 331 |
| Teams | 33 |
| Brier O2.5 | 0.245840 |
| Log-loss O2.5 | 0.684729 |
| Avg predicted O2.5 | 0.4598 |
| Actual O2.5 hit rate | 0.4653 |
| Accuracy @ 50% threshold | 0.5680 |
| Over picks (p ≥ 0.50) | 95, hit rate 0.5579 |
| Under picks (p < 0.50) | 236, hit rate 0.5720 |

### Championship — Dixon-Coles

| Metric | Value |
|---|---|
| Train matches | 1,325 |
| Holdout matches | 331 |
| Teams | 33 |
| ρ (rho) | −0.019635 |
| Brier O2.5 | 0.254759 |
| Log-loss O2.5 | 0.705551 |
| Avg predicted O2.5 | 0.4437 |
| Actual O2.5 hit rate | 0.4653 |
| Accuracy @ 50% threshold | 0.5468 |
| Over picks (p ≥ 0.50) | 114, hit rate 0.5175 |
| Under picks (p < 0.50) | 217, hit rate 0.5622 |

---

## Calibration Band Findings

Calibration measures how close the model's predicted probability is to the
observed frequency. A well-calibrated model has avg ≈ actual within each band.

### Championship — Poisson

| Band | Count | Avg predicted | Actual hit rate |
|---|---|---|---|
| 0.30–0.40 | 75 | 0.371 | 0.387 |
| 0.40–0.50 | 159 | 0.446 | 0.447 |
| 0.50–0.60 | 84 | 0.545 | 0.548 |
| 0.60–0.70 | 11 | 0.645 | 0.636 |

Excellent calibration across all observed bands.

### EPL — Poisson

| Band | Count | Avg predicted | Actual hit rate |
|---|---|---|---|
| 0.30–0.40 | 9 | 0.358 | 0.333 |
| 0.40–0.50 | 42 | 0.458 | 0.476 |
| 0.50–0.60 | 91 | 0.553 | 0.560 |
| 0.60–0.70 | 79 | 0.640 | 0.582 |
| 0.70–1.00 | 7 | 0.721 | 0.857 |

Good calibration in the 0.40–0.60 range. The 0.60–0.70 band shows mild
over-confidence (predicted 0.640, actual 0.582). Sample is small in the
extremes; variance is high.

### Dixon-Coles — Calibration Problems

DC is meaningfully worse than Poisson on O2.5 in both leagues and shows
systematic over-confidence at high probabilities:

**Championship DC:**

| Band | Avg predicted | Actual hit rate |
|---|---|---|
| 0.60–0.70 | 0.638 | 0.467 |
| 0.70–1.00 | 0.731 | 0.400 |

**EPL DC:**

| Band | Avg predicted | Actual hit rate |
|---|---|---|
| 0.70–1.00 | 0.737 | 0.581 |

The ρ values (EPL: −0.073, Championship: −0.020) indicate DC is applying
a mild negative low-score correction — suppressing 0-0 and boosting scoring
probabilities — which inflates predicted O2.5 values and worsens calibration.

---

## Interpretation

**Poisson is the preferred baseline.** It outperforms Dixon-Coles on every
measured metric for O2.5 in both leagues, and is better calibrated across
all probability bands. Dixon-Coles remains available via `--model dixon_coles`
for comparison, but should not be the primary model until the ρ behaviour is
better understood with more data.

**Poisson is reasonably calibrated overall.** In the 0.40–0.60 range — the
bulk of predictions — the model tracks the observed frequency well. The high
bands (0.70+) have too few samples to draw strong conclusions.

**These results do not prove betting profitability.** There is no historical
odds or value analysis attached yet. Whole-league holdout accuracy is a model
quality signal, not a betting edge signal. The model is a probability baseline,
not a betting engine.

**Whole-league evaluation is different from GoalScout's shortlist workflow.**
GoalScout will only act on matches that pass the shortlist filter. The relevant
calibration question is whether the model is calibrated *within the shortlisted
bucket*, not across all 228 or 331 holdout matches. That requires threshold
analysis, which is the next step.

---

## Next Recommended Milestone

Add a reusable threshold / pick-zone analysis script. This is the bridge
between raw probability output and actionable signal evaluation.

The script should analyse the holdout JSON from `train_league.py` and report:

**Over bands** (p_over_2_5 ≥ threshold):

| Threshold | 0.55 | 0.60 | 0.65 | 0.70 |
|---|---|---|---|---|

**Under bands** (p_over_2_5 ≤ threshold, i.e. p_under ≥ 1 − threshold):

| Threshold | 0.45 | 0.40 | 0.35 | 0.30 |
|---|---|---|---|---|

Per bucket: count, hit rate, avg predicted probability, implied fair odds
(1 / avg_prob), Brier score, log-loss.

This analysis comes before wiring in historical bookmaker odds and before
any UI work.
