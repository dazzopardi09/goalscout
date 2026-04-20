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

## Controlled Test: Manual shortlist weight tweak (failed)

### Change tested
A small manual scoring adjustment was tested in `shortlist.js`:

- reduced U2.5 clean sheet weighting
- increased U2.5 failed-to-score weighting
- reduced O2.5 combined TG hype at the highest threshold

### Result
The model got slightly worse.

### Replay result after tweak
- Predictions: 262
- Hit rate: 49.2%
- Brier score: 0.2787

### Key outcomes
- A grade: 50.5%
- O2.5: 53.8%
- U2.5: 44.7%
- A + U2.5: 50.8%

### Interpretation
- The manual weighting tweak did not improve signal quality
- Earlier apparent U2.5 edge was likely fragile / small-sample noise
- Hand-tuning weights without a learned calibration or model layer is unreliable

### Conclusion
Reverted `shortlist.js` back to the original baseline logic.

This confirms:
- the replay system is useful for controlled experiments
- manual score tweaking is not a reliable improvement path
- next step should be probability calibration rather than more ad hoc weight changes

## Controlled Test: Logistic Regression (feature signal check)

### Purpose
Determine whether current features contain real predictive signal, and whether learned weights outperform manual scoring.

### Dataset
- Source: replay predictions + results
- Rows: 262
- Features:
  - homeO25pct
  - awayO25pct
  - homeCSpct
  - awayCSpct
  - homeFTSpct
  - awayFTSpct
  - combinedTG
- Target:
  - result (1 = win, 0 = loss)

### Method
- Logistic regression (scikit-learn)
- Train/test split: 60/40

### Result

- Brier score: **0.2573** (improved from ~0.2826 baseline)

### Learned coefficients

| Feature      | Coefficient |
|--------------|------------|
| homeO25      | -0.0010 |
| awayO25      | -0.0069 |
| homeCS       | -0.0122 |
| awayCS       | -0.0008 |
| homeFTS      | -0.0021 |
| awayFTS      |  0.0071 |
| combinedTG   |  0.1533 |

### Key findings

- Combined total goals (combinedTG) is the **only strong positive signal**
- O2.5 percentages contribute little or negative signal
- Clean sheet % (CS) appears negatively correlated with success
- FTS signal is weak and inconsistent
- Current handcrafted scoring is mis-weighting features significantly

### Interpretation

- The model has **some real signal**, but it is buried under noise
- Manual weighting and shortlist scoring are not aligned with actual predictive power
- The model is effectively a weak proxy for total-goals environment

### Conclusion

- Feature set is not useless — signal exists
- Main issue is **incorrect weighting / model structure**
- Manual tuning is unreliable
- Learned models provide immediate improvement

### Implication for next steps

- Calibration (Platt scaling) is now viable and meaningful
- Future model improvements should prioritise:
  - goal-based modelling (Poisson)
  - or learned weighting approaches
- Avoid further manual shortlist tuning without data-driven backing

## Controlled Test: Full Fixture Logistic Regression (unbiased)

### Purpose
Remove selection bias from previous experiments by evaluating feature signal across the full set of completed EPL fixtures, not just model-selected predictions.

### Dataset
- Source: `epl_2025_26_fixtures.json`
- Completed fixtures: 294 (after sample-size filtering)
- Features (point-in-time, no leakage):
  - homeO25pct, awayO25pct
  - homeCSpct, awayCSpct
  - homeFTSpct, awayFTSpct
  - combinedTG (homeAvgTG + awayAvgTG)
- Targets:
  - O2.5 → totalGoals > 2.5
  - U2.5 → totalGoals < 2.5

### Method
- Logistic regression (scikit-learn)
- Separate models for O2.5 and U2.5
- Train/test split: 60/40

---

### Results

#### O2.5 model
- Rows: 294
- Brier: **0.2568**

Coefficients:
- homeO25: +0.0093
- awayO25: -0.0128
- combinedTG: -0.0629

---

#### U2.5 model
- Rows: 294
- Brier: **0.2478**

Coefficients:
- homeCS: +0.0054
- awayCS: -0.0017
- homeFTS: +0.0072
- awayFTS: +0.0066
- combinedTG: +0.2356

---

### Key Findings

- Removing selection bias confirms that **predictive signal exists** in the feature set
- Both models outperform the baseline (~0.28 Brier)
- However, coefficient signs are **unstable and often counterintuitive**
- `combinedTG` shows inconsistent directionality:
  - negative in O2.5 model (unexpected)
  - positive in U2.5 model (unexpected)

---

### Interpretation

- Features are acting as **noisy, correlated proxies** for underlying goal expectation
- Multicollinearity and overlapping signals reduce interpretability and stability
- The model struggles to form consistent relationships due to:
  - indirect feature representation
  - redundancy across features
  - lack of a direct measure of goal-scoring intensity

---

### Comparison to Previous Experiments

- Confirms earlier regression improvement (signal exists)
- Corrects prior misinterpretation caused by:
  - direction mixing (fixed)
  - selection bias from replay predictions (fixed)
- Reveals that instability is not due to dataset bias alone

---

### Conclusions

- Feature set is **partially useful but fundamentally limited**
- Current approach relies on indirect proxies for goal behaviour
- Logistic regression improves performance but exposes structural weaknesses
- Manual shortlist scoring is not aligned with learned relationships

---

### Implications

- Model limitation is now clearly **representation-based**, not just weighting-based
- Improving model structure alone will not fully resolve instability
- Future improvements should prioritise:
  - better representation of goal generation
  - reduction of proxy overlap
  - clearer separation of signal sources

---

### Status

This is the first fully unbiased validation of feature signal.

Key open question:
- whether these features can be stabilised further
- or whether a different modelling approach is required

## Controlled Test: Single-feature + decomposed goal feature validation

### Purpose
Test whether raw goal-based rolling features contain meaningful predictive signal for O2.5 / U2.5 outcomes before moving to a more complex model.

---

### Test A — Single feature: `combinedTG`

#### Setup
- Full fixture universe (294 completed EPL fixtures after sample filter)
- Logistic regression
- Single predictor only:
  - `combinedTG`
- Separate O2.5 / U2.5 runs

#### Result
- O2.5 Brier: **0.2474**
- U2.5 Brier: **0.2474**
- Coefficients mirrored in sign:
  - O2.5: `combinedTG = -0.104`
  - U2.5: `combinedTG = +0.104`

#### Interpretation
- Improvement over naive baseline (~0.249) is extremely small and may be noise
- Symmetry is expected because O2.5 and U2.5 are complementary events
- `combinedTG` alone does **not** provide strong or reliable predictive signal
- Result suggests weak / noisy information rather than useful standalone discrimination

---

### Test B — Decomposed goal features

#### Setup
Replaced `combinedTG` with:
- `homeAttack` = avg goals scored
- `homeDefence` = avg goals conceded
- `awayAttack`
- `awayDefence`

Same full fixture universe, same no-leakage construction.

#### Result
- O2.5 Brier: **0.2574**
- Coefficients:
  - `homeAttack = +0.1389`
  - `homeDefence = +0.1671`
  - `awayAttack = -0.1876`
  - `awayDefence = -0.5450`

#### Interpretation
- Decomposition did **not** recover useful predictive signal
- Result is worse than naive baseline (~0.249)
- Coefficients remain unstable / unintuitive
- Attack/defence decomposition on raw goals is still too noisy

---

### Overall conclusion from goal-feature validation

The current evidence now supports:

- rolling five-game **raw goal-based features are insufficient**
- the issue is not just:
  - shortlist weighting
  - multicollinearity
  - selection bias
- the bottleneck is the **data representation itself**

More precise statement:
- five-game rolling averages of raw goals scored/conceded do not provide stable predictive power for EPL O2.5 outcomes

---

### Important implication

A Poisson model built on the **same raw goal averages** is not justified yet.

Reason:
- Poisson would consume the same weak/noisy inputs
- it would be a cleaner mathematical model using poor underlying data
- no evidence yet that this would add signal

---

### Next recommended direction

Move from **raw goals** to **xG-based inputs**.

Reason:
- xG measures chance quality instead of noisy finished outcomes
- directly addresses the representation problem identified in testing
- can be plugged into the same replay / regression framework without redesigning the system

Suggested xG replacements:
- `homeXgForAvg`
- `homeXgAgainstAvg`
- `awayXgForAvg`
- `awayXgAgainstAvg`

---

### Status

This is the strongest conclusion reached so far.

The project now has:
- a validated replay pipeline
- a validated regression-testing workflow
- evidence that raw goal-derived features are too noisy
- a clear next data upgrade path: **xG**