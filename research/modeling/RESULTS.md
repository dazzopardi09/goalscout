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

---

## Milestone 9 — Calibration Zone Classification

Added `calibrate_zones.py`.

Purpose: combine the Poisson holdout predictions and historical odds validation into a practical decision report.

The script reads:

- `outputs/{slug}_poisson.json`
- `outputs/odds_validation.csv`

It writes:

- `outputs/calibration_report.csv`

It prints three tables:

| Table | Purpose |
|---|---|
| League + side bias summary | Shows whether the model is generally overconfident or underconfident per league/side |
| Reliability by probability bin | Shows whether predicted probability bands match actual hit rates |
| Zone classification | Classifies each league/side/threshold as Pass, Watchlist, or Reject |

Classification defaults:

| Classification | Rule |
|---|---|
| Pass | `N >= 30`, positive opening edge, positive closing edge, positive opening ROI |
| Watchlist | Positive opening and closing edge, but too small / weak for Pass |
| Reject | Negative edge, bad ROI below watch floor, or contradictory signal |

The script is research-only. It does not change model probabilities and does not touch the live app.

### Calibration Bias Summary

| League | Side | N | Mean model prob | Actual hit rate | Calibration diff | Read |
|---|---|---:|---:|---:|---:|---|
| Bundesliga | Over | 184 | 59.9% | 58.7% | -1.2pp | broadly calibrated |
| Bundesliga | Under | 184 | 40.1% | 41.3% | +1.2pp | broadly calibrated |
| Championship | Over | 331 | 46.0% | 46.5% | +0.5pp | broadly calibrated |
| Championship | Under | 331 | 54.0% | 53.5% | -0.5pp | broadly calibrated |
| EPL | Over | 228 | 56.3% | 55.3% | -1.1pp | broadly calibrated |
| EPL | Under | 228 | 43.7% | 44.7% | +1.1pp | broadly calibrated |
| League Two | Over | 331 | 49.6% | 44.1% | -5.5pp | overconfident |
| League Two | Under | 331 | 50.4% | 55.9% | +5.5pp | underconfident / useful |
| Scotland | Over | 137 | 55.0% | 60.6% | +5.5pp | underconfident, but market edge was negative |
| Scotland | Under | 137 | 45.0% | 39.4% | -5.5pp | overconfident |
| Serie A | Over | 228 | 47.6% | 45.6% | -2.0pp | overall okay, but high Over bins are poor |
| Serie A | Under | 228 | 52.4% | 54.4% | +2.0pp | mildly underconfident / useful |

Key calibration read:

- League Two Over is overconfident overall.
- League Two Under is underconfident overall.
- Scotland Over has positive historical hit-rate bias, but failed market-edge validation.
- Serie A Over is not terrible overall, but high-confidence Over zones are badly overconfident.
- Serie A Under remains one of the cleanest useful sides.
- Bundesliga is broadly calibrated, with useful Over zones and interesting smaller-sample Under zones.

### Zone Classification Results

Default classification run:

| Result | Count |
|---|---:|
| Pass | 8 |
| Watchlist | 17 |
| Reject | 19 |

### Pass Zones

| League | Side | Threshold | N | Hit rate | Calibration diff | Open edge | ROI open | Close edge | Read |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| League Two | Under | <= 0.40 | 56 | 69.6% | +4.7pp | +3.2% | +13.9% | +2.3% | strongest balanced candidate |
| Bundesliga | Over | >= 0.70 | 32 | 81.2% | +5.7pp | +3.3% | +13.9% | +3.1% | strong but smaller sample |
| Serie A | Under | <= 0.40 | 57 | 66.7% | +0.7pp | +5.4% | +11.3% | +5.1% | strong candidate |
| Serie A | Under | <= 0.35 | 32 | 65.6% | -3.1pp | +7.0% | +7.2% | +6.6% | stronger edge, smaller sample |
| Serie A | Under | <= 0.45 | 96 | 61.5% | -1.0pp | +3.7% | +4.6% | +3.5% | broader useful zone |
| Bundesliga | Over | >= 0.65 | 67 | 71.6% | +0.4pp | +2.8% | +3.9% | +2.5% | coherent candidate |
| Bundesliga | Over | >= 0.55 | 140 | 65.7% | +0.2pp | +1.1% | +1.4% | +0.9% | valid but marginal |
| Bundesliga | Over | >= 0.60 | 107 | 66.4% | -1.6pp | +2.0% | +0.3% | +1.9% | valid but very thin ROI |

Practical interpretation: not all Pass zones are equal. The strongest carry-forward candidates are:

1. League Two Under <= 0.40
2. Serie A Under <= 0.40
3. Serie A Under <= 0.35
4. Bundesliga Over >= 0.65
5. Bundesliga Over >= 0.70

Bundesliga Over >= 0.55 and >= 0.60 technically pass but are marginal because realised ROI is very thin.

### Watchlist Zones Of Interest

| League | Side | Threshold | N | Hit rate | Open edge | ROI open | Close edge | Read |
|---|---|---:|---:|---:|---:|---:|---:|---|
| Bundesliga | Under | <= 0.45 | 29 | 75.9% | +9.8% | +46.2% | +10.3% | excellent signal, just below N threshold |
| League Two | Under | <= 0.35 | 26 | 73.1% | +5.7% | +16.8% | +4.5% | coherent, slightly small |
| EPL | Under | <= 0.45 | 25 | 60.0% | +6.0% | +12.6% | +5.3% | interesting but small |
| Championship | Under | <= 0.40 | 77 | 61.0% | +1.4% | -0.9% | +1.4% | market edge exists but realised ROI weak |
| Championship | Under | <= 0.45 | 165 | 57.0% | +0.2% | -4.6% | +0.2% | very weak; likely not actionable yet |

Best watchlist candidates:

1. Bundesliga Under <= 0.45
2. League Two Under <= 0.35
3. EPL Under <= 0.45

### Rejected / Dangerous Zones

| League | Side | Threshold | Reason |
|---|---|---:|---|
| EPL | Over | >= 0.55 / 0.60 / 0.65 | negative open and close edge; market already priced it too short |
| League Two | Over | >= 0.55 / 0.60 | positive theoretical edge but poor realised ROI |
| Serie A | Over | >= 0.55 / 0.60 / 0.65 | high Over zones are badly overconfident |
| Scotland | Over | >= 0.55 / 0.60 / 0.65 / 0.70 | profitable historically, but negative open and close edge |
| League Two | Under | <= 0.45 | positive ROI but negative close edge |
| EPL | Under | <= 0.35 | tiny sample and poor ROI |

Important rejected pattern:

League Two and Serie A Overs are the clearest danger zones. The model reports theoretical edge, but realised results are poor. This suggests the raw Poisson model is directionally unreliable for those Over zones. The safest correction for now is not probability adjustment; it is exclusion.

### Updated Interpretation

The modelling evidence now supports a three-stage research funnel:

1. Discovery scan finds promising league/side/threshold zones.
2. Historical odds validation checks whether the market already priced those zones correctly.
3. Calibration classification separates usable zones from false positives.

The current evidence does not support a global O/U model. The useful pattern remains:

`league + side + probability zone + odds validation`

Current carry-forward candidates:

| Tier | Zones |
|---|---|
| Strong candidates | League Two Under <= 0.40; Serie A Under <= 0.40; Bundesliga Over >= 0.65 |
| Aggressive / smaller-sample candidates | Serie A Under <= 0.35; Bundesliga Over >= 0.70; Bundesliga Under <= 0.45 |
| Watchlist | League Two Under <= 0.35; EPL Under <= 0.45 |
| Reject / avoid | EPL Overs; League Two Overs; Serie A Overs; Scotland Overs |

Next modelling priorities:

1. Extend odds validation and calibration classification to all 16 Format A leagues.
2. Add a stricter candidate-ranking score that penalises small samples and thin ROI.
3. Add season-split stability checks before any probability correction.
4. Build Format B parsers for Argentina, Sweden, Denmark, and Brazil.
5. Find alternate data sources for A-League and possibly Saudi Pro League.
6. Only after more validation, consider live paper-tracking integration.

---

## Milestone 10 — Strict Classification Run

Added a stricter `calibrate_zones.py` run across all 16 supported football-data.co.uk Format A leagues.

This was used to reduce noise from the loose classification run and keep only zones with stronger sample size, positive market edge, and positive realised ROI.

### Strict run settings

- Minimum sample size: N >= 40
- Minimum opening edge: greater than +2.0%
- Minimum closing edge: greater than +2.0%
- Minimum opening ROI: greater than +3.0%
- Watchlist ROI floor: -3.0%

### Strict classification result

- Pass: 5
- Watchlist: 47
- Reject: 68

The stricter run removed marginal zones such as:

- Bundesliga Over >= 0.55
- Bundesliga Over >= 0.60
- LaLiga2 Over >= 0.55

These zones were technically positive under looser rules, but were too thin or too noisy to treat as serious carry-forward candidates.

### Strict pass zones

1. League Two Under <= 0.40
   - N: 56
   - Hit rate: 69.6%
   - Opening edge: +3.2%
   - Opening ROI: +13.9%
   - Closing edge: +2.3%
   - Read: cleanest original candidate.

2. Eredivisie Over >= 0.65
   - N: 40
   - Hit rate: 77.5%
   - Opening edge: +3.2%
   - Opening ROI: +13.4%
   - Closing edge: +3.3%
   - Read: strongest new candidate from the full 16-league scan.

3. Serie A Under <= 0.40
   - N: 57
   - Hit rate: 66.7%
   - Opening edge: +5.4%
   - Opening ROI: +11.3%
   - Closing edge: +5.1%
   - Read: very strong candidate.

4. Serie A Under <= 0.45
   - N: 96
   - Hit rate: 61.5%
   - Opening edge: +3.7%
   - Opening ROI: +4.6%
   - Closing edge: +3.5%
   - Read: broader and safer version of the Serie A Under signal.

5. Bundesliga Over >= 0.65
   - N: 67
   - Hit rate: 71.6%
   - Opening edge: +2.8%
   - Opening ROI: +3.9%
   - Closing edge: +2.5%
   - Read: coherent but thinner ROI than the top candidates.

### Current carry-forward zones

Primary zones for live paper-tracking:

1. League Two Under <= 0.40
2. Serie A Under <= 0.40
3. Eredivisie Over >= 0.65
4. Serie A Under <= 0.45
5. Bundesliga Over >= 0.65

These remain research candidates only. They are not proof of live edge because validation used football-data.co.uk aggregated historical opening and closing odds, not GoalScout's actual tip-time odds.

### Watchlist interpretation

The Watchlist is still noisy and should not be treated as a list of near-passes.

Useful watchlist examples:

- Bundesliga Under <= 0.45
  - Strong result, but N = 29, below the strict sample threshold.

- League Two Under <= 0.35
  - Coherent signal, but still below strict sample threshold.

- EPL Under <= 0.45
  - Interesting, but sample is still small.

Watchlist zones with N between 1 and 9 should be ignored until more data exists.

Zones with positive theoretical edge but poor realised ROI should remain avoided. Examples include Portugal Under, Serie B Under, League Two Over, and Serie A Over.

### Updated modelling direction

The strict run reinforces the main conclusion:

GoalScout should not deploy a general Poisson Over/Under betting model.

The useful pattern is:

league + side + probability threshold + odds validation + calibration classification

Current implementation direction:

1. Forward-track only the 5 strict-pass zones.
2. Keep watchlist zones visible only for research.
3. Exclude rejected danger zones from any live recommendation logic.
4. Add season-split stability checks before any production integration.
5. Compare live GoalScout tip-time odds against these zones before treating them as actionable.

