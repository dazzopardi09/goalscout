# Stage 9 — Calibration Training Report

Generated: 2026-04-26
Model: context_raw_v1.2
Method: Platt scaling (logistic sigmoid)

---

## Final verdicts

| League | Verdict | Calibrator | Stage 10 usage |
|--------|---------|-----------|---------------|
| **England O2.5** | **REJECTED** (all variants) | None | Raw probabilities. Flag raw > 75% as overstated. |
| **Germany O2.5** | **ACCEPTED** (v1) | `germany_o25_v1.json` | Calibrated prob for A/A+. B grade tracked with raw. |

---

## England O2.5 — Rejected

### What was tested

Three variants on the same held-out test set (2023-24, 2024-25, n=437):

- **Raw** — context_raw_v1.2 uncalibrated
- **V1** — Platt trained on 2020-21, 2021-22, 2022-23
- **V2** — Platt trained on 2022-23 only

### Scorecard

| Check | V1 | V2 |
|-------|----|----|
| Brier improved | ✓ | ✓ |
| ECE improved | ✓ | ✓ |
| No overcorrection | ✗ | ✗ |
| Sharpness preserved (≥60% raw) | ✗ | ✗ |
| Grade ordering maintained | ✓ | ✓ |
| **Score** | **3/5** | **3/5** |

### Why rejected

The raw model has one isolated problem: the 75%+ bucket (n=98) overstates by +24.8pp.
All other buckets are within ±4pp. A global Platt sigmoid strong enough to fix
the 75%+ region destroys the 60-75% range (9-17pp errors). Both V1 and V2 failed.

V2 was not better than V1. V1 gap: -6.4pp. V2 gap: -7.2pp. V2 sharpness: 23% of raw.
V1 sharpness: 20% of raw. Both collapse the probability distribution to a 52-60% band.

### Stage 10 handling

Use raw probabilities. Flag predictions where context_o25_prob_raw > 0.75.
Revisit at Stage 11 with grade-specific Platt or mapping-level fix.

---

## Germany O2.5 — Accepted

### Parameters (A=0.817704, B=0.037095)

Train: 20_21, 21_22, 22_23 | Test: 23_24, 24_25 | Excluded: 19_20 (COVID)

### Test set metrics

| Metric | Raw | Calibrated | Change |
|--------|-----|-----------|--------|
| Brier | 0.2370 | 0.2309 | -0.0061 ✓ |
| ECE | 7.13pp | 1.41pp | -5.72pp ✓ |
| Calibration gap | +2.0pp | +0.9pp | -1.1pp ✓ |

### Grade breakdown (test set)

| Grade | n | Hit% | Raw gap | Cal gap |
|-------|---|------|---------|---------|
| A+ | 132 | 67.4% | +9.5pp | -1.4pp ✓ |
| A | 83 | 72.3% | -9.3pp | -8.9pp (unchanged — model understatement, not calibration) |
| B | 133 | 52.6% | +1.7pp | +9.2pp ✗ (do not use calibrated for B) |

### Stage 10 handling

- A/A+ predictions: use calibrated probability from germany_o25_v1.json
- B grade predictions: use raw probability, tag separately
- Calibration file: data/calibration/germany_o25_v1.json

---

## Reliability diagram — Germany (test set)

| Range | n | Actual | Raw error | Cal error |
|-------|---|--------|-----------|----------|
| 50-55% | 48 | 56.3% | -3.6pp | +5.2pp |
| 55-60% | 42 | 69.0% | -11.7pp | -6.7pp |
| 60-65% | 39 | 64.1% | -1.5pp | -0.7pp |
| 65-70% | 43 | 65.1% | +2.3pp | -0.8pp |
| 70-75% | 31 | 54.8% | +17.7pp | +10.4pp |
| 75%+   | 90 | 73.3% | +10.8pp | -6.0pp |

---

## Files

| File | Status |
|------|--------|
| data/calibration/germany_o25_v1.json | Active for Stage 10 |
| data/calibration/england_o25_v1.json | Archived — rejected |
| data/calibration/england_v2_o25_v1.json | Archived — rejected |

Data files are gitignored. Parameters reproduced in this report for audit.