# GoalScout — Replay Analysis Log

## Baseline: Replay v1 (EPL 2025–26)

### Overall
- Predictions: 261
- Hit rate: 49.8%
- Brier score: 0.2826

Interpretation:
- Model has **no edge vs base rate**
- Probability calibration is **poor**
- Pipeline is working correctly (no leakage)

---

## Key Findings

### 1. Grades

| Grade | Count | Hit Rate |
|------|------|----------|
| A+   | 20   | 30.0% ❌ |
| A    | 63   | 57.1% ✅ |
| B    | 101  | 44.6% ❌ |
| -    | 77   | 55.8% ⚠️ |

Insights:
- A+ is **broken / inverted**
- A shows **real signal**
- Grade system rewards **signal concentration, not predictive value**

---

### 2. Direction

| Market | Count | Hit Rate |
|--------|------|----------|
| O2.5   | 118  | 53.4% |
| U2.5   | 143  | 46.9% |

Insights:
- O2.5 ≈ EPL base rate (~53%) → **no edge**
- U2.5 underperforms overall
- Directional performance is uneven

---

### 3. Probability Calibration

| Bucket | Hit Rate |
|--------|----------|
| 0.80+  | 45.8% ❌ |
| 0.70–0.79 | 54.5% |
| 0.60–0.69 | 53.3% |

Insights:
- High probabilities are **overconfident and wrong**
- Model probability ≠ real probability
- Calibration is a major issue

---

### 4. Filter Tests

| Filter | Count | Hit Rate |
|--------|------|----------|
| A only | 63 | 57.1% |
| O2.5 only | 118 | 53.4% |
| A + O2.5 | 25 | 48.0% ❌ |
| A + U2.5 | 38 | 63.2% ⚠️ |

Insights:
- **A + U2.5 is strongest segment (small sample)**
- Grade improves U2.5 but worsens O2.5
- Potential edge exists in **high-confidence unders**

---

## Deep Dive: A + U2.5 Segment

### Overall
- Count: 38
- Hit rate: 63.2%

### Feature profile

#### Winners
- awayFTS% higher (≈31%)
- slightly lower avgTG

#### Losers
- lower awayFTS%
- slightly higher avgTG

Insights:
- U2.5 success driven more by:
  - **teams failing to score**
  - not clean sheet %
- CS% may be overweighted in current model

---

## Known Issues

- A+ grading logic is flawed
- Probability model is miscalibrated
- Features are shallow (no xG, no opponent strength)
- U2.5 probability derived indirectly from O2.5 (weak design)
- Replay currently missing **leagueStats context**

---

## Missing from Replay (vs Live)

Previously suspected missing:
- leagueStats (o25%, avgGoals)

Status:
- Added to replay feature-builder
- Re-ran full replay + settlement + analysis
- **No measurable change in outcomes**

Conclusion:
- leagueStats is **not a meaningful bottleneck** in the current model
- the main issues remain elsewhere:
  - broken A+ grading
  - poor probability calibration
  - shallow feature set

---

## Controlled Test: Add leagueStats

### Change made
Added point-in-time leagueStats to replay:
- `o25pct`
- `avgGoals`
- computed only from completed fixtures before target kickoff

### Result
No change in model behaviour.

### Comparison vs previous baseline
- Hit rate: unchanged at **49.8%**
- Brier score: unchanged at **0.2826**
- Grade performance: unchanged
- Direction performance: unchanged
- Filter test performance: unchanged

### Interpretation
- Replay pipeline is deterministic and trustworthy
- Adding league-level context did **not** improve the model
- League context is not the current limiting factor

---

## Updated Conclusions

### What does NOT currently fix the model
- adding leagueStats alone

### What still appears broken
- A+ logic
- probability calibration
- overconfidence in high-probability selections

### What still appears promising
- A grade selections
- A grade + U2.5 subset (small sample, worth further investigation)

---

## Priority Order (updated)

### Next likely high-value changes
1. Fix or remove A+ grading
2. Improve probability calibration
3. Revisit U2.5 logic:
   - increase FTS% importance
   - reduce CS% reliance
   - penalise higher avgTG more clearly

### Later improvements
- home/away splits
- recency weighting
- opponent/team strength context
- xG integration
- Poisson-based approach

---

## Current Best Understanding

The model is not failing because it lacks league context.

The model is mainly failing because:
- its feature set is too shallow
- its scoring system mis-ranks extreme cases
- its probabilities are not calibrated to real outcomes

The replay system is now proven good enough to test all future changes against this baseline.