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

---

## Multi-League Replay Testing (Feature Validation Across Leagues)

### Purpose
Evaluate whether the current model performs better outside EPL and identify league-dependent signal.

---

### Leagues tested
- EPL (baseline)
- A-League
- Eredivisie
- Bundesliga
- Danish Superliga

---

### Summary Results

| League            | Bets | Hit Rate | Brier  | O2.5 | U2.5 |
|------------------|------|----------|--------|------|------|
| EPL              | 261  | 49.8%    | 0.2826 | ~53% | ~47% |
| A-League         | 136  | 58.1%    | 0.2639 | 63.4% | 42.9% |
| Eredivisie       | 246  | 50.4%    | 0.2728 | 56.8% | 43.8% |
| Bundesliga       | 252  | 51.2%    | 0.2630 | 59.3% | 41.1% |
| Danish Superliga | 145  | 52.4%    | 0.2585 | 59.8% | 37.5% |

---

### Key Findings

#### 1. Strong directional bias
- O2.5 consistently outperforms U2.5 across all leagues
- U2.5 is consistently weak (≈37–47%)
- Model behaves like an **over classifier**, not a balanced predictor

---

#### 2. League dependency confirmed
- A-League shows strongest raw edge (58.1%)
- Other leagues cluster around ~50–52%
- Model performance is **not transferable across leagues**

---

#### 3. Probability signal is partially real
- Higher probability buckets (0.70+) perform better across multiple leagues
- Indicates underlying signal exists but is weak and noisy

---

#### 4. Grade system issues persist
- A+ consistently unreliable across all leagues
- A grade sometimes useful (e.g. Danish ~59.5%)
- B grade inconsistent
- Grade system is not stable across environments

---

#### 5. Consistent high-performing segments
Across multiple leagues:

- O2.5 only → ~57–63%
- A + O2.5 → ~58–65%
- "No - grade + O2.5" → ~58–64%

These segments show:
- some signal concentration
- but not strong enough to confirm a robust edge

---

### Interpretation

- Model contains **weak but real signal**
- Signal is primarily driven by **goal environment (overs)**
- Current feature set behaves as a noisy proxy for total goals
- League context influences signal strength significantly

---

### Updated Conclusion

Multi-league testing confirms:

- The model is **not fundamentally broken**, but:
  - signal is weak
  - heavily dependent on league context
- Raw goal-based features do not generalise well
- Improvements via weighting, filtering, or league selection alone are limited

---

### Implication for next phase

The limitation is now clearly **data representation**, not:
- pipeline
- replay system
- league coverage

Next step should focus on:

→ **Replacing raw goal features with xG-based features**

This is expected to:
- reduce noise
- improve stability of relationships
- provide a better foundation for probabilistic modelling

---

### Status

Multi-league validation complete.

Key takeaway:
- current model ≈ weak over classifier
- xG integration is the next required step

---

## Multi-League Replay (10-Game Window Validation)

### Purpose
Re-test model performance across leagues using a longer rolling window (5 → 10 games) to evaluate noise vs signal.

---

### Leagues Tested
- EPL
- A-League
- Eredivisie
- Bundesliga
- Danish Superliga

---

### Results Summary

| League            | Bets | Hit Rate | O2.5 | Brier  | Verdict |
|------------------|------|----------|------|--------|--------|
| EPL              | 259  | 47.5%    | 51.2% | 0.2732 | No signal |
| A-League         | 132  | 60.6%    | 66.0% | 0.2402 | Strong |
| Danish Superliga | 135  | 56.3%    | 62.2% | 0.2492 | Moderate |
| Bundesliga       | 252  | 55.7%    | 61.3% | 0.2548 | Usable |
| Eredivisie       | 246  | 51.0%    | 56.7% | 0.2548 | Weak |

---

### Key Findings

#### 1. League dependency confirmed
- Model performance varies significantly by league
- A-League strongest, EPL weakest
- No universal model behaviour

---

#### 2. Model behaves as Over 2.5 classifier
- O2.5 consistently outperforms U2.5 across all leagues
- U2.5 consistently underperforms (~37–44%)
- Model is not balanced across markets

---

#### 3. Rolling window impact (5 → 10 games)

- Improves performance in strong leagues:
  - A-League: 58.1% → 60.6%
  - Danish: 52.4% → 56.3%
- No improvement (or worse) in weak leagues:
  - EPL declines further
  - Eredivisie remains near noise

Conclusion:
- Window size reduces noise
- Does not create signal where none exists

---

#### 4. Signal exists but is unstable

- Strong segments appear in:
  - A-League (A-grade ~70%)
  - Bundesliga (mid-probability buckets)
  - Danish Superliga (consistent O2.5 edge)

- However:
  - signal is inconsistent across leagues
  - probability calibration remains unreliable

---

#### 5. Feature limitations evident

- Current inputs (goals, O2.5%, CS%, FTS%) are:
  - lagging indicators
  - outcome-based
  - noisy proxies for underlying performance

- Even with improved windowing:
  - signal remains weak or unstable in several leagues

---

### Updated Conclusion

- Model contains real but weak signal
- Signal is:
  - league-dependent
  - primarily driven by overs
- Rolling window improves stability but not fundamental performance
- Current feature set is insufficient for robust modelling

---

### Implication

Primary bottleneck is likely:

→ **feature quality, not pipeline or windowing**

---

### Next Step (Pending Validation)

- Evaluate moving to xG-based features
- Re-test model using:
  - longer rolling window (10 games)
  - improved inputs (expected goals instead of raw goals)

---

### Status

Multi-league + window validation complete.

Key takeaway:
- Current model = weak, league-dependent over signal
- Not robust enough in current form
- Ready for next phase (feature upgrade)

---

## Controlled Test: Per-League O2.5 Calibration Feasibility

### Purpose
Test whether the current model’s O2.5 probabilities can be improved via post-hoc calibration, rather than requiring immediate feature replacement.

Method used:
- Platt scaling fitted per league
- O2.5 predictions only
- calibration inputs:
  - raw `modelProbability`
  - settled replay outcomes

This was treated as a diagnostic test of **probability ordering quality**, not a final production implementation.

---

### Results

| League      | Sample | A      | B      | Interpretation |
|-------------|--------|--------|--------|----------------|
| A-League    | 100    | 0.965  | -0.316 | Strong / usable |
| Bundesliga  | 160    | -0.026 | 0.444  | Weak / not useful |

---

### Interpretation of calibration coefficients

Platt scaling form:

`calibrated_p = sigmoid(A * logit(rawProb) + B)`

Meaning:
- `A > 0` and reasonably close to 1:
  - probabilities are sensibly ordered
  - calibration can improve probability honesty
- `A ≈ 0`:
  - raw probabilities contain little useful ranking information
  - calibration collapses toward a near-constant estimate
- `A < 0`:
  - indicates poor or inverted ordering
  - calibration is unlikely to rescue the model

---

### A-League

Result:
- `A = 0.965`
- `B = -0.316`

Interpretation:
- O2.5 probabilities are already well ordered
- Model appears to have **real discriminative signal**
- Main issue is slight probability shift / overstatement of base probability
- Calibration is likely a valid next step here

Conclusion:
- A-League is currently the strongest candidate for a calibrated “working” model segment

---

### Bundesliga

Result:
- `A = -0.026`
- `B = 0.444`

Interpretation:
- Raw probability ordering is weak or effectively non-informative
- Calibration would likely collapse toward a league-level constant probability
- This suggests that, for Bundesliga, the current model does **not** have strong enough probability structure for calibration to add much value

Conclusion:
- Bundesliga is not a strong calibration-first candidate in current form

---

### Updated cross-league understanding

The project now appears to have **different bottlenecks by league**:

- **A-League**
  - signal exists
  - calibration likely worthwhile

- **Bundesliga**
  - some directional signal exists
  - probability ordering too weak for calibration-first approach

- **EPL**
  - no meaningful signal
  - feature quality remains the core problem

This suggests the model should no longer be treated as one global problem.

---

### Updated conclusion

Previous conclusion:
- next step should likely be xG integration

Updated conclusion:
- this is still likely true for weak-signal leagues (especially EPL)
- however, A-League may justify a calibration-first step before xG

Refined view:
- **feature upgrade** remains the likely long-term next phase
- **calibration** may be a valid short-term optimisation for leagues where discrimination already exists

---

### Status

Calibration feasibility has now been partially tested.

Current best understanding:
- A-League may already contain a usable O2.5 model with better-calibrated probabilities
- other leagues remain weaker and less calibration-friendly
- next project decision should be:
  - whether to pursue a calibrated A-League path first
  - or move directly to xG for broader model improvement

  ---

## Phase: Calibration Implementation (A-League O2.5)

### Objective
Validate whether post-hoc calibration (Platt scaling) improves probability quality for leagues where discrimination exists.

Based on prior analysis:
- A-League identified as the only league with strong probability ordering (A ≈ 0.965)
- Other leagues showed weak or no discrimination and were excluded from calibration

---

### Calibration Setup

Applied Platt scaling:

calibrated_p = sigmoid(A * logit(raw_p) + B)

Parameters (A-League O2.5):
- A = 0.965
- B = -0.316
- Training sample = 100

Implementation:
- Calibration applied only when:
  - leagueKey = a_league
  - market = over_2.5
- U2.5 probabilities derived as:
  - 1 - calibrated O2.5

Raw probabilities retained for comparison:
- rawModelProbability
- modelProbability (calibrated)

---

### Results (Post-Calibration)

#### Overall
- Total bets: 132
- Hit rate: 60.6% (unchanged)

#### Brier Score
- Before: ~0.2639
- After:  0.2378

Interpretation:
- Significant improvement in probability calibration
- Model predictions now better aligned with observed outcomes

---

### Probability Buckets (Calibration Check)

| Bucket     | Hit Rate |
|------------|----------|
| <0.50      | 53.8%    |
| 0.50–0.59  | 53.3%    |
| 0.60–0.69  | 60.0%    |
| 0.70–0.79  | 74.1%    |
| 0.80+      | 50.0%    |

Interpretation:
- Monotonic improvement across buckets
- 0.70–0.79 bucket aligns closely with expected probability
- High-confidence predictions now more reliable

---

### Segment Performance

#### A-Grade
- 70.5% (31 / 44)

#### A-Grade + O2.5
- 78.4% (29 / 37)

#### O2.5 Overall
- 66.0% (66 / 100)

Interpretation:
- Strongest signal concentrated in:
  - A-grade
  - O2.5 direction
- Calibration improves confidence in these segments

---

### Key Observations

1. Calibration improved probability accuracy, not hit rate
   - Expected outcome — model ranking unchanged

2. A-League confirmed as a valid model environment
   - Strong discrimination
   - Stable ordering
   - Calibration effective

3. Model remains directional
   - O2.5 significantly stronger than U2.5
   - U2.5 remains weak and should not be a focus

4. Extreme probability flips observed
   - Some raw low probabilities converted to high calibrated values
   - Requires monitoring but not immediately problematic

---

### Updated League Classification

| Category        | Leagues |
|----------------|--------|
| Calibratable    | A-League |
| Weak signal     | Danish Superliga, Eerste Divisie |
| No signal       | Bundesliga, EPL, Eredivisie |

---

### Conclusion

- Calibration successfully improved probability quality for A-League
- This represents the first fully validated model segment in the project
- Other leagues do not currently justify calibration

---

### Next Decision Point

Options:

A) Add odds + EV layer and test profitability  
B) Expand A-League dataset (prior seasons) to confirm robustness  
C) Move to xG for structurally weak leagues  

Further direction pending evaluation.

---

## Phase: Cross-Season Validation (A-League O2.5)

### Objective
Validate whether the calibrated A-League O2.5 model holds up across multiple independent seasons.

This phase used the same calibrated model logic and applied it to 3 seasons:

- 2022–23
- 2023–24
- 2024–25

No model changes were made between runs.

---

### Results Summary

| Season   | Bets | Overall | O2.5 | A + O2.5 | Brier |
|----------|------|---------|------|-----------|-------|
| 2024–25  | 132  | 60.6%   | 66.0% | 78.4%    | 0.2378 |
| 2023–24  | 135  | 58.5%   | 64.1% | 72.7%    | 0.2394 |
| 2022–23  | 130  | 60.0%   | 63.6% | 62.9%    | 0.2390 |

---

### Key Findings

#### 1. O2.5 signal is stable across seasons
O2.5 hit rate remained tightly clustered:

- 66.0%
- 64.1%
- 63.6%

Interpretation:
- core A-League O2.5 model signal appears genuine
- this is the strongest evidence so far that the model is not just one-season noise

---

#### 2. Calibration remains robust across seasons
Brier score remained consistently below the naive A-League baseline (~0.240):

- 0.2378
- 0.2394
- 0.2390

Interpretation:
- calibration is not just helping one season
- probability quality appears stable enough to carry across seasons

---

#### 3. A-grade / elite-pick layer is not stable
A + O2.5 performance declined materially across seasons:

- 78.4%
- 72.7%
- 62.9%

Interpretation:
- apparent “elite pick” quality was overstated in the strongest season
- grade filtering does not appear robust enough to be treated as the core edge
- the real signal is broader than A-grade alone

---

#### 4. Model is stronger at general O2.5 selection than at top-end segmentation
Overall O2.5 remains strong and stable, while grades vary more than the base model.

Interpretation:
- the reliable edge is likely:
  - calibrated A-League O2.5
- not:
  - A+ / A-grade concentration

---

### Updated Conclusion

The project now has its first cross-season validated model segment:

→ **A-League O2.5 with calibrated probabilities**

This appears to be:
- real
- consistent
- transferable across seasons

However:
- grade segmentation is not robust enough to be trusted as a primary filter
- the strongest current interpretation is that the model provides a modest but repeatable O2.5 edge, rather than a small set of “elite” picks

---

### Updated Best Understanding

Current best reading:

- model works in A-League
- calibration works
- O2.5 is the real market
- U2.5 remains weak
- grade filtering is unstable and should not be over-trusted

---

### Next Decision Point

With cross-season validation now complete, the next likely step is:

A) add bookmaker odds and test EV / ROI  
B) continue expanding historical validation  
C) move to xG for structurally weak leagues

Current expectation:
- A-League path is now mature enough to justify an EV / ROI layer

---

## Phase: Per-Season Discrimination Check (A-League O2.5)

### Objective
Test whether the model’s probability ordering / discrimination is stable across seasons, independent of the live calibration map.

This was done by fitting Platt scaling separately on each season’s raw O2.5 model probabilities using the full season sample.

This was a diagnostic step only:
- not a deployable calibration map
- not a train/test exercise
- purpose was to measure whether raw model probability retains a meaningful monotonic relationship to outcomes in each season

---

### Per-Season Platt Results

| Season   | A     | B      | n   |
|----------|-------|--------|-----|
| 2024–25  | 0.965 | -0.316 | 100 |
| 2023–24  | 0.611 | -0.022 | 103 |
| 2022–23  | 0.559 |  0.002 | 99  |

---

### Interpretation

#### 1. Discrimination exists in all seasons
All three seasons show positive A values well above zero.

Interpretation:
- raw model probabilities are not random
- there is real ordering signal in all seasons

---

#### 2. Discrimination strength is not stable
A values vary materially:

- 2024–25: strong discrimination (~0.97)
- 2023–24: moderate discrimination (~0.61)
- 2022–23: moderate discrimination (~0.56)

Interpretation:
- signal strength changes across seasons
- model is materially stronger in some seasons than others
- this makes the model unstable as a deployable betting system in current form

---

#### 3. This explains the hit-rate / ROI mismatch
Across seasons:
- hit rate remained relatively stable
- ROI varied sharply

Interpretation:
- model continues to identify broadly similar match types
- but when discrimination weakens, the model becomes overconfident
- this causes “positive edge” bets to fail when compared against market prices

---

#### 4. Core issue is not calibration alone
Calibration improved probability honesty, but this test shows that the underlying model strength is season-dependent.

Interpretation:
- the main limitation is now the stability of the underlying signal
- not just the final probability transformation

---

### Updated Conclusion

The A-League model is now best described as:

→ **real but unstable**

More specifically:
- there is genuine cross-season O2.5 signal
- but discrimination is not strong enough or consistent enough to justify confident betting deployment yet

This means:
- A-League O2.5 remains the strongest segment found so far
- but it should not yet be treated as a fully robust betting model

---

### Updated Best Understanding

Current model behaviour:
- calibrated probabilities can be useful
- O2.5 signal is real
- however, raw goal-based features appear to produce season-dependent signal strength
- this likely explains why ROI can swing sharply even when hit rate remains similar

---

### Next Decision Point

Primary question now:

- continue trying to extract EV from the current model
- or improve the model itself so discrimination becomes more stable across seasons

Current expectation:
- the next correct step is likely a feature/model upgrade rather than further EV threshold tuning

---

## Phase: Historical Odds / EV Testing (A-League O2.5)

### Objective
Test whether the calibrated A-League O2.5 model beats the market, not just outcomes.

Historical closing odds were sourced from the AusSportsBetting A-League dataset and matched to replay predictions by:
- date
- home team
- away team

Odds used:
- O/U 2.5 closing prices
- devigged implied market probabilities
- matched coverage only

---

### EV / ROI Results (matched odds sample)

| Season   | Bets | Coverage | ROI (all) | ROI (edge > 5) | Bets (edge > 5) |
|----------|------|----------|-----------|----------------|-----------------|
| 2022–23  | 87   | 87.9%    | +6.63%    | +12.96%        | 60              |
| 2023–24  | 88   | 85.4%    | -11.65%   | -16.71%        | 27              |
| 2024–25  | 80   | 80.0%    | -5.35%    | +11.51%        | 32              |

---

### Per-Season Discrimination on Matched Sample

| Season   | A     | Bets |
|----------|-------|------|
| 2022–23  | 0.479 | 87   |
| 2023–24  | 0.526 | 88   |
| 2024–25  | 1.164 | 80   |

Interpretation:
- discrimination strength varies materially by season
- 2024–25 shows much stronger ordering than 2022–23 / 2023–24
- this likely explains why edge filtering only works in some seasons

---

### Key Findings

#### 1. Outcome accuracy is not enough
The model showed consistent O2.5 hit rates across seasons, but ROI did not hold across seasons.

Interpretation:
- being directionally right is not sufficient
- model must consistently outperform market pricing, not just outcomes

---

#### 2. Edge filtering is not robust enough
`edge > 5%` performed well in 2 seasons but failed badly in 2023–24.

Interpretation:
- edge filtering helps only when underlying discrimination is strong
- edge calculation becomes unreliable when the model is weak / overconfident

---

#### 3. Current raw-goals model has reached its ceiling
The project now has enough evidence to say:
- the model contains real signal
- but signal strength is season-dependent
- current raw-goals features do not produce a stable betting model across seasons

---

### Final Conclusion of Current Model Phase

The current A-League raw-goals O2.5 model is:

- informative
- partially predictive
- but not robust enough as a stable betting model

This phase established:
- replay pipeline works
- calibration pipeline works
- historical odds / EV pipeline works
- market comparison framework works

However:
- the model itself is not stable enough across seasons to justify further optimisation on raw-goal features

---

### Strategic Next Step

Do **not** keep tuning this raw-goals model further.

Instead, build a **new xG-based signal/model independently** from the current raw-goals model.

Rationale:
- keep models modular
- compare raw-goals vs xG fairly
- allow league-specific usage later
- optionally combine / ensemble only after independent testing

Proposed structure:

- raw-goals model → existing signal
- xG model → new independent signal
- blended / ensemble model → optional future phase

This allows:
- A-League to continue using the existing raw-goals signal if useful
- other leagues (EPL, Bundesliga, etc.) to test xG independently
- future comparison or combination without contaminating the experiments