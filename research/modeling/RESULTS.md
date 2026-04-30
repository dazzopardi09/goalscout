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

---

## Milestone 5 — Threshold Analysis

Added `analyse_thresholds.py` to evaluate holdout predictions by probability zones instead of only whole-league accuracy.

Threshold zones:

| Side | Rule |
|---|---|
| Over | `p_over_2_5 >= 0.55`, `0.60`, `0.65`, `0.70` |
| Under | `p_over_2_5 <= 0.45`, `0.40`, `0.35`, `0.30` |

Finding: whole-league accuracy is not enough. The useful signal is league-specific, side-specific, and threshold-specific.

---

## Milestone 6 — Multi-League Discovery Scan

Added `run_league_scan.py`.

It trains a Poisson model per supported football-data.co.uk Format A league, runs a chronological holdout scan, and writes:

- `outputs/league_scan_summary.csv`
- `outputs/{slug}_poisson.json` for odds validation

Supported Format A leagues now include EPL, Championship, League One, League Two, Bundesliga, Bundesliga 2, Serie A, Serie B, La Liga, La Liga 2, Ligue 1, Ligue 2, Eredivisie, Belgium, Portugal, and Scotland.

### Strongest Discovery Zones Before Odds Validation

| League | Side | Threshold | N | Hit rate | Avg model prob | Fair odds |
|---|---|---:|---:|---:|---:|---:|
| Scotland | Over | >= 0.55 | 66 | 72.7% | 63.1% | 1.586 |
| Bundesliga | Over | >= 0.65 | 67 | 71.6% | 71.2% | 1.404 |
| League Two | Under | <= 0.40 | 56 | 69.6% | 64.9% | 1.540 |
| Serie A | Under | <= 0.40 | 56 | 67.9% | 66.1% | 1.513 |
| EPL | Over | >= 0.55 | 139 | 61.9% | 61.8% | 1.617 |
| Championship | Under | <= 0.40 | 77 | 61.0% | 63.1% | 1.584 |

Important: this was discovery only. Hit rate without bookmaker odds is not evidence of betting edge.

---

## Milestone 7 — Historical Odds Validation

Added `evaluate_odds.py`.

Purpose: validate discovery zones against football-data.co.uk historical Over/Under 2.5 odds.

Important caveat: this uses football-data.co.uk aggregated opening and closing odds, not exact GoalScout tip-time odds.

| Odds type | Role |
|---|---|
| Opening average odds | Approximate historical entry price |
| Closing average odds | Market-efficiency and CLV proxy |

Primary columns:

| Use | Over column | Under column |
|---|---|---|
| Opening average | `Avg>2.5` | `Avg<2.5` |
| Closing average | `AvgC>2.5` | `AvgC<2.5` |

Metrics now calculated per league, side, and threshold:

- hit rate
- average model probability
- average opening odds
- opening edge
- expected value at opening odds
- realised ROI at opening odds
- average closing odds
- closing edge

### Odds-Backed Validation Results For Priority Leagues

| League | Side | Threshold | N | Hit rate | Open edge | EV open | ROI open | Close edge | Read |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| League Two | Under | <= 0.40 | 56 | 69.6% | +3.2% | +5.5% | +13.9% | +2.3% | Strongest balanced candidate |
| Serie A | Under | <= 0.40 | 57 | 66.7% | +5.4% | +9.5% | +11.3% | +5.1% | Strong candidate |
| Bundesliga | Under | <= 0.45 | 29 | 75.9% | +9.8% | +19.4% | +46.2% | +10.3% | Very interesting, but smaller sample |
| Bundesliga | Over | >= 0.65 | 67 | 71.6% | +2.8% | +4.8% | +3.9% | +2.5% | Coherent but less explosive |
| EPL | Under | <= 0.45 | 25 | 60.0% | +6.0% | +11.9% | +12.6% | +5.3% | Interesting, small sample |
| Scotland | Over | >= 0.55 | 66 | 72.7% | -0.8% | -0.5% | +15.5% | -0.7% | Profitable historically, but not model-edge backed |

### Zones Weakened Or Rejected By Odds Validation

| League | Side | Threshold | N | Hit rate | Open edge | ROI open | Read |
|---|---|---:|---:|---:|---:|---:|---|
| EPL | Over | >= 0.55 | 139 | 61.9% | -3.6% | -4.7% | Hit rate looked good, but market odds were too short |
| League Two | Over | >= 0.55 | 95 | 47.4% | +7.7% | -11.7% | Model badly overvalued Overs |
| Serie A | Over | >= 0.55 | 58 | 41.4% | +4.7% | -26.7% | Model badly overvalued Overs |

### Current Interpretation

The odds-backed results support the project pivot.

The useful pattern is not a global Over/Under threshold. It is closer to:

`league + side + probability zone + odds validation`

Current best candidate zones:

1. League Two Under <= 0.40
2. Serie A Under <= 0.40
3. Bundesliga Under <= 0.45
4. Bundesliga Over >= 0.65
5. EPL Under <= 0.45

League Two Overs and Serie A Overs are red flags. The model showed positive theoretical edge but realised results were poor. This suggests the raw Poisson model needs league-specific and side-specific calibration before being used as a live betting signal.

---

## Milestone 8 — Existing GoalScout History Edge Analysis

Added `analyse_goalscout_history.py`.

Purpose: analyse existing live GoalScout `data/history/predictions.jsonl` with deduplication and market-odds edge bands.

Deduplication key: `fixtureId + market + selection + modelVersion`

Historical live prediction summary:

| Metric | Value |
|---|---:|
| Raw rows | 243 |
| Deduped rows | 168 |
| Duplicates removed | 75 |
| Settled rows | 153 |
| Pending / void | 15 |

Model version breakdown:

| Model version | Deduped | Settled |
|---|---:|---:|
| baseline-v1 | 164 | 149 |
| baseline-v1.1 | 1 | 1 |
| context_raw_v1.2 | 3 | 3 |

So the live history signal is almost entirely baseline-v1, not calibrated/Poisson.

### Live GoalScout Edge-Band Result

| Edge band | N | Hit rate | Avg odds | ROI |
|---|---:|---:|---:|---:|
| Negative | 21 | 66.7% | 1.506 | -0.2% |
| 0-5% | 8 | 75.0% | 1.511 | +11.8% |
| 5-10% | 18 | 66.7% | 1.626 | +10.0% |
| 10%+ | 64 | 67.2% | 1.811 | +20.5% |

Clean CLV summary:

| Metric | Value |
|---|---:|
| Clean CLV records | 67 |
| Mean CLV | +3.03% |
| Positive CLV | 43 / 67 |
| Negative / zero CLV | 24 / 67 |

Interpretation: the old live baseline history showed a promising edge/CLV relationship, but it is small sample and mostly baseline-v1. It should be treated as a separate evidence stream from the Poisson sandbox.

---

## Current Direction

GoalScout should not become a generic O/U dashboard with one global rule.

The current evidence supports a research-first betting product built around:

- league-specific model behaviour
- side-specific calibration
- probability threshold zones
- historical odds validation
- live odds comparison

Next modelling priorities:

1. Add a league + side calibration layer.
2. Extend historical odds validation to all 16 Format A leagues.
3. Build a Format B parser for Argentina, Sweden, Denmark, and Brazil.
4. Find an alternate data source for A-League and possibly Saudi Pro League.
5. Add a serious candidate ranking metric that balances sample size, opening EV, realised ROI, and closing edge.
6. Only then integrate the strongest validated zones back into the live GoalScout app.
