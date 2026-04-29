# GoalScout — AFL Line/Spread Feasibility Study Plan (v2)

**Date:** 30 April 2026
**Status:** Plan only. No implementation until this is committed and pre-registration is signed off.
**Scope:** Line/spread market only. H2H is a sanity-check, not a target. Totals deferred. No props, no quarters, no ML beyond linear models and Elo.

**Changes from v1:**
1. H2H sanity check downgraded from automatic gate to audit trigger. Unexpected H2H success now pauses the result for investigation rather than failing it outright.
2. Pre-registration timing clarified: validation seasons (2022–2024) are explicitly available for model selection and generalisation checking. Pre-registration locks the chosen model and thresholds *after* validation work and *before* the untouched 2025 test.
3. "Complex models won't help" claim softened. v1 tests a low-cost, low-dimensional thesis; failure of v1 falsifies *that* thesis only, not the broader question of whether richer models could work.

---

## 0. What this study is and isn't

**Is:** a bounded, falsifiable test of whether simple, well-known AFL margin models can produce a measurable predictive edge against the closing line, on enough matches that the result is statistically meaningful.

**Isn't:** a profit study, a production design, an automation plan, or a commitment to AFL as GoalScout's future. It produces one of three outcomes (fail / inconclusive / promising), each with a defined next step.

**Hard time cap:** three weekends. If the study isn't producing results by the end of weekend three, stop and re-evaluate.

---

## 1. Dataset construction

### Seasons

| Phase | Seasons | Matches (approx) | Use |
|---|---|---|---|
| Elo burn-in | 2013 | 207 | Initialise team ratings only. No evaluation. |
| Development | 2014–2019 | ≈1,241 | Feature engineering, hyperparameter tuning. Iterate freely. |
| Validation | 2022, 2023, 2024 | ≈639 | Generalisation check. Lock model architecture here. |
| **Held-out test** | **2025** | **216** | **One single evaluation. Touch once.** |
| Excluded | 2009–2012 | — | Pre-2013 lacks the closing-line columns we need. |
| Excluded | 2020 | 162 | 16-minute quarters + hubs + no crowds. Different sport for modelling. |
| Sensitivity | 2021 | 207 | Re-run study with and without 2021 in training. Report any divergence. |
| Out of scope | 2026 partial | 63 | Reserved for live paper-tracking only, post-study. |

The development span 2014–2019 deliberately ends before COVID. Validation span 2022–2024 deliberately starts after the 2021 disrupted-recovery year. The 2020/2021 gap is treated as a structural break, not as missing data to interpolate.

### Required columns from AusSportsBetting (post-2013)

| Field | Purpose |
|---|---|
| `Date` | Match date; primary time key |
| `Kick off (local)` | Cross-check for fixture matching |
| `Home Team`, `Away Team` | Team identifiers |
| `Venue` | Future feature (travel, ground bias) |
| `Home Score`, `Away Score` | Outcome — used to compute margin |
| `Play off game?` | Identify finals (excluded from CLV evaluation) |
| `Home Odds Close`, `Away Odds Close` | H2H sanity-check baseline |
| `Home Line Close`, `Away Line Close` | The handicap value (must be opposite signs). Primary benchmark. |
| `Home Line Odds Close`, `Away Line Odds Close` | The price at which a line bet would have settled. Used for ROI calc only. |

That is the entire dependency. No other columns are required for v1.

### Optional features from fitzRoy

fitzRoy is **not** used for odds in this study. It's reduced to:

| Function | Use |
|---|---|
| `fetch_fixture()` | Cross-validate AusSportsBetting team-name normalisation |
| `fetch_results()` | Independent confirmation of margin |
| `fetch_player_stats()` | **Deferred to v2.** Not in v1 feature set. |
| `fetch_lineup()` | **Deferred to v2.** Lineup adjustment isn't part of this study. |

If AusSportsBetting team names are inconsistent (e.g., "Brisbane" vs "Brisbane Lions", "GWS" vs "Greater Western Sydney"), normalise to AFL Tables / fitzRoy convention as the canonical form.

### Cleaning rules

Apply in this order; log row counts dropped at each step.

1. **Drop pre-2013 rows.** No closing-line data.
2. **Drop rows with null `Home Line Close` or `Home Line Odds Close`.** Expected to be tiny (≤0.073%).
3. **Drop rows with line odds = 0.000.** Data error (cannot bet at zero odds).
4. **Drop rows with H2H odds = 1.000.** Data error (no edge possible at even-money payout, almost certainly a placeholder).
5. **Drop rows where `Home Line Close + Away Line Close ≠ 0`** (allow ±0.01 for float tolerance). Sanity check on handicap symmetry — if it ever fails, the row is malformed.
6. **Drop rows with null match scores.** Match abandoned or postponed.
7. **Drop rows with H2H overround > 110%.** A few extreme rows might exist; these are not bettable in practice and shouldn't anchor the analysis.
8. **Verify line sign convention with a known match.** Pick one 2024 fixture where home was a strong favourite. Confirm `Home Line Close < 0` for that row. **Document the convention explicitly in code:** *"home covers if `(Home Score − Away Score) + Home Line Close > 0`."* If the convention is the opposite (home covers if `... < 0`), all subsequent code reverses sign.
9. **Pushes (line landing exactly on margin):** with half-point lines, expected to be 0%. If any rows show whole-point lines, treat them as voids and drop from CLV calc.

Output: `data/processed/afl-matches.parquet`, gitignored, snapshot-dated.

### How to handle 2026 partial data

Ignore for the study. The 63 rows are reserved for live paper-tracking validation if the study lands in promising or inconclusive tier. Don't include them in any backtest.

---

## 2. Target definition

### Primary target: home-team margin

```
margin = Home Score − Away Score
```

Sign: positive if home wins, negative if home loses. This is the regression target for all margin-based models.

### Cover outcome (binary, for evaluation only)

Given the line sign convention verified in cleaning step 8:

```
home_covered = 1 if (margin + Home Line Close) > 0 else 0
```

Worked examples (assuming `Home Line Close < 0` means home is favoured):

| Home Line Close | Margin | Margin + Line | home_covered |
|---:|---:|---:|---:|
| −12.5 | +14 | +1.5 | 1 (home wins by more than 12.5) |
| −12.5 | +11 | −1.5 | 0 (home wins but doesn't cover) |
| +5.5 | −3 | +2.5 | 1 (home loses but covers the +5.5) |
| +5.5 | −9 | −3.5 | 0 (home loses by more than 5.5) |

Pushes (where `margin + Line == 0`) shouldn't occur with half-point lines. Drop any that do.

### Modelling decision: model margin, not cover

Model the margin directly as a regression problem. Not the binary cover outcome.

Reasons:
- Predicting "home wins by 18" preserves more information than "home covers".
- The market line is itself a margin estimate; the natural comparison is model margin vs market line.
- CLV in line points only makes sense if the model produces a continuous margin estimate.
- Binary classification at this sample size loses too much signal.

Predicted line for evaluation:
```
predicted_line_home = −predicted_margin
```
(If model says home wins by 18, model thinks home line "should be" −18.)

### Loss function

Mean squared error (MSE) for training; mean absolute error (MAE) for reporting. AFL margins have heavy tails (occasional 80-point blowouts), so MAE is more robust to report and easier to interpret.

---

## 3. Market baseline

### Closing line as benchmark

The market's closing line is the consensus margin estimate at match start. We treat it as the "market's prediction" with implied magnitude `−Home Line Close`.

For each match in the evaluation set:

```
market_predicted_margin = −Home Line Close
model_predicted_margin  = output of model
predicted_line_diff     = model_predicted_margin − market_predicted_margin
```

A positive `predicted_line_diff` means the model thinks home is a better team than the market does (margin higher than market expects).

### Pick selection rule

Only "pick" matches where the model disagrees with the market by enough to matter.

```
threshold = 2.0   # points; pre-registered, not tuned on test
if predicted_line_diff > +threshold:
    pick = "home"   # back home at closing line
elif predicted_line_diff < −threshold:
    pick = "away"   # back away at closing line
else:
    no pick
```

The threshold of 2.0 points is a pre-registration choice. Sensitivity analysis on dev seasons can sweep `threshold ∈ {1.0, 1.5, 2.0, 2.5, 3.0}` but **the registered threshold for the held-out 2025 test must be set before any test-set evaluation.**

### CLV in line points (primary metric)

For each pick:
```
edge_in_points = |predicted_line_diff|   # always positive on selected picks
```

The study's headline metric: **mean `edge_in_points` across all picks in the test set**, plus the realised cover rate on those picks.

The "expected edge in points" is the model's claim. The "realised cover rate" is whether the picks actually win at a rate consistent with that claim. A model claiming +2.5 points of edge per pick should win roughly 56–58% of picks at standard line odds. If it claims +2.5 and wins 50%, the model is wrong even though its expected edge looks good.

### How to avoid using closing odds/line as a model input

Hard rules:
- **No closing-line feature** anywhere in the model. Period.
- **No closing-odds-derived feature** (no implied probability, no no-vig probability).
- **No Squiggle features** — Squiggle's component models train on closing odds, so including Squiggle leaks the closing line transitively.
- **Opening lines are technically allowed** as features (different price-discovery signal) but **excluded for v1** to keep the feature set strictly internal-only.
- **Code review checkpoint:** before running on validation, grep the codebase for any reference to the closing-odds columns inside the feature-engineering paths. Should appear only in the evaluation pipeline.

---

## 4. Baseline models

Four models, in increasing complexity. Each is a standalone evaluation, not a hyperparameter sweep.

### Model 0 — Market-only baseline (sanity ceiling)

```
predicted_margin = −Home Line Close
```

This isn't a "model"; it's the market saying its own line. Used to establish the MAE ceiling — if our model can't get close to the market's MAE, the model is useless. Expected market MAE on AFL margins is ~26–30 points (high-variance sport).

**Why included:** without it, we can't say whether any model is better or worse than the market. This is the only model that touches closing data, and *only* in the role of "the thing we're trying to beat."

### Model 1 — Elo with home advantage

Standard Elo:
```
expected_margin = scale × (Elo_home − Elo_away) + home_advantage
```

After each match:
```
margin_residual = actual_margin − expected_margin
Elo_home += K × f(margin_residual)
Elo_away −= K × f(margin_residual)
```

Where `f()` is a margin-of-victory adjustment (log-scaled to dampen blowouts).

Hyperparameters (tuned on dev only):
- `K`: rating update rate (typical AFL: 25–60)
- `home_advantage`: constant points added to home rating (typical: 6–10 points)
- `scale`: rating-to-margin conversion (typical: 0.04–0.07)
- `inter_season_regression`: how much ratings regress to mean between seasons (typical: 0.1–0.3)
- `f()` shape: log, sqrt, or linear-clipped

**What it needs:** match dates, home/away teams, final scores. Nothing else.
**Why included:** the standard AFL modelling baseline. v1 tests the low-cost thesis: can a simple, low-dimensional model produce a measurable edge on the line market? If Models 1–3 all fail, the *low-cost thesis* is falsified. Richer models — player-level ratings, lineup adjustment, injury-aware features — may still work, but they require a separate justification, separate data pipelines, and are explicitly out of scope for v1.

### Model 2 — Recent form / rolling margin

For each team, maintain a rolling form score: average margin in last N games, opponent-adjusted (subtract opponent's expected margin per Elo).

```
form_diff = home_form − away_form
predicted_margin = a × form_diff + b × home_advantage + c
```

Hyperparameters:
- `N`: rolling window length (5, 8, 10)
- Opponent adjustment: yes/no
- Decay weighting: equal vs exponential

**What it needs:** match dates, results, Elo (for opponent adjustment).
**Why included:** form is a different signal than Elo. Captures short-term momentum (injuries, hot streaks) that Elo's slow K-factor misses.

### Model 3 — Linear regression with hand-crafted features

Inputs:
- Elo difference (home − away)
- Recent form difference (home − away)
- Days rest difference (home − away)
- Travel binary (1 if away team is from a different state or interstate venue)
- Venue indicator (Marvel roof closed vs MCG open vs others, as a categorical)
- Is finals (binary; only used for in-sample, finals are excluded from CLV eval)

Trained as ordinary least squares on dev seasons. Coefficients reported and interpreted (sign and magnitude must be sensible).

**What it needs:** all of the above features, dev-season historical data.
**Why included:** combines Elo + form + travel signals into one prediction. If Models 1 or 2 alone are competitive, this should be at least as good. If it's much better, that's interesting; if it's much worse, something is wrong with the features.

### Explicitly out of scope for v1

- Tree-based models (XGBoost, LightGBM)
- Neural networks
- Player-level / lineup-adjusted ratings
- Bayesian / hierarchical models
- Ensembles of the above

These are separate investigations with their own justification, data, and time costs. They are out of scope for v1 regardless of v1's outcome. A v1 fail does not prove they can't work; it only proves the low-cost thesis doesn't. A v1 pass does not validate them either; it just removes the urgency of moving to them.

---

## 5. Train / test structure

### Split (re-stated explicitly)

| Phase | Seasons | What happens |
|---|---|---|
| Burn-in | 2013 | Elo initialises; nothing else |
| Train | 2014–2019 | Hyperparameter sweep, free iteration |
| Validate | 2022, 2023, 2024 | Each treated as a separate held-out check |
| Test | 2025 | Single shot, after pre-registration is committed |
| Sensitivity | 2021 with/without | Run validation pipeline twice |

### Rolling-origin validation within development

Within 2014–2019, use rolling-origin to catch year-effects:
- Train 2014–2017, validate 2018
- Train 2014–2018, validate 2019

Hyperparameters chosen to maximise mean validation performance across both folds, not best-on-one-fold.

### Validation seasons treated separately

After dev-set tuning, each of 2022, 2023, 2024 gets its own held-out evaluation, with the model retrained using all earlier-than-target seasons (e.g., for 2023, train on 2014–2019 + 2022; for 2024, train on 2014–2019 + 2022 + 2023). 2020 always excluded from training.

This produces three independent generalisation estimates. **Validation results are explicitly available for model selection.** Inspecting them, comparing models, adjusting features, and re-tuning hyperparameters in response to validation performance is *expected and allowed* — that's what validation is for. The constraint is that validation must produce a *converged choice* (one model, one threshold, one set of hyperparameters) before the test set is touched.

If validation results are mutually inconsistent — e.g., 2022 looks great, 2023 looks terrible, 2024 looks mediocre — that is itself a signal that the model is not generalising. Either fix it, downgrade the expected outcome, or stop. Don't pretend the inconsistency is noise and proceed to test.

### Leakage avoidance — explicit checklist

- [ ] Elo state at match `t` uses only matches before `t`. No "season-end Elo" reused.
- [ ] Rolling form features at match `t` exclude match `t` itself.
- [ ] No closing-line, closing-odds, or Squiggle features anywhere.
- [ ] Linear regression coefficients are fitted on training seasons only, applied without re-fitting to validation/test.
- [ ] Team-name normalisation table built once, applied to all seasons consistently.
- [ ] Snapshot date of AusSportsBetting xlsx pinned in pre-registration. No re-pull mid-study.
- [ ] Lineup features deferred to v2 — not used.
- [ ] Code review pass before validation eval: grep for any reference to closing-odds columns in the feature pipeline.

### Pre-registration (committed after validation work, before any 2025 evaluation)

Pre-registration locks the *final* choice — the model, features, hyperparameters, and thresholds you intend to evaluate on 2025. It is created **after** validation work is complete and the chosen architecture has converged. Validation results inform the contents of the pre-reg.

It is not created before validation, and it is not a constraint on validation. The constraint it imposes is on the **test set only**: once committed, no re-tuning in response to test results.

Create `AFL-FEASIBILITY-PRE-REG.md` and commit it. It must contain:

1. **Snapshot date** of AusSportsBetting xlsx.
2. **Final feature list** (locked, post-validation).
3. **Final hyperparameters** for the selected model (locked, post-validation).
4. **Final pick selection rule** (threshold value, e.g., 2.0 points; locked, post-validation).
5. **Final pass/fail thresholds** (Section 6).
6. **Stated cleaning rules** (verbatim from Section 1).
7. **Validation summary**: cover rate, MAE, predicted-line edge for each of 2022, 2023, 2024 — recorded as the basis for the model choice.
8. **Statement of intent**: a single evaluation pass on 2025; no re-tuning post-results. If the result disagrees with validation, that disagreement *is* the result.

The git commit hash of the pre-reg file is referenced in the final results document. The 2025 test scripts run only against the committed version.

---

## 6. Pass / fail criteria

CLV in line points is the primary metric, supplemented by realised cover rate and bootstrap CIs. Profitability is **not** required from one season.

### Three tiers

#### 🔴 Clear fail

Any of:

- Model MAE on margin ≥ market-baseline MAE on margin (the market is at least as good).
- Mean predicted-line edge on selected picks < +0.5 points (the model claims too small an edge to matter).
- Realised cover rate on selected picks ≤ 50% on 2025 test (worse than coin flip).
- Cover rate inconsistent across validation seasons (e.g., 2022 = 56%, 2023 = 47%, 2024 = 51% — not signal, just noise).

→ **Action:** kill the AFL track. Redirect effort to soccer hybrid model + infrastructure/CLV measurement. Document the negative result; it has value.

#### 🟡 Inconclusive / paper-track only

Mixed signals:

- Model MAE marginally better than market (improvement < 0.5 points).
- OR mean predicted-line edge between +0.5 and +1.0 points.
- OR realised cover rate 50–53% (above coin-flip but below or near breakeven at typical line odds of ~1.91, which is 52.4% breakeven).
- OR validation results inconsistent but not catastrophic (e.g., 53% / 51% / 54%).

→ **Action:** do **not** build live execution. Build a minimal paper-tracker that captures live closing prices via The Odds API for the rest of 2026 and logs predictions vs outcomes. Re-evaluate in October 2026 with a full additional season.

#### 🟢 Promising

All of:

- Model MAE meaningfully better than market (≥ 0.5 points improvement, sustained across all three validation seasons).
- AND mean predicted-line edge on picks ≥ +1.0 points.
- AND realised cover rate on picks ≥ 53% on 2025 test, with 95% bootstrap CI lower bound ≥ 51%.
- AND validation seasons each individually ≥ 52% cover rate.

→ **Action:** build a minimal AFL paper-tracker (ingestion, prediction, logging only — no betting integration) for the remainder of 2026. Treat 2026 as a forward out-of-sample test. No commitment to production. Re-evaluate at end of 2026.

#### H2H sanity check — audit trigger, not a gate

The H2H market is heavily efficient. We do not expect the model to beat it. **If the same architecture also appears to beat H2H closing odds, pause and audit before accepting the line result as green.**

Likely causes of unexpected H2H success, in order of probability:

1. **Closing-odds leakage** in the feature pipeline. Re-run the code review checkpoint from Section 5 with fresh eyes.
2. **Odds-source mismatch** producing a systematic bias the model is exploiting. AusSportsBetting's "close" is not the live close at AU bookmakers; if the gap is non-random, the model can pick up the gap rather than real margin signal. Compare AusSportsBetting H2H closing prices to The Odds API live captures on a sample of recent matches.
3. **Sample artefact**: ~200 matches per season is small enough that a no-edge model can land 53–55% cover rate on H2H by chance. Compute the bootstrap CI on the H2H result; if it includes 50%, the result is consistent with noise.
4. **Genuine real edge on H2H** — possible but unlikely; if other causes are ruled out, this is the residual hypothesis. Treat with extreme scepticism and require replication on additional data before acting.

The audit produces one of three outcomes:
- Leakage or odds-source bias confirmed → fix it, re-run validation, then re-pre-register and re-run test.
- Sample artefact confirmed (H2H result inside its noise band) → accept the line result as green; note the H2H number for context.
- Cause unclear → downgrade the line result to inconclusive (paper-tracker only) and continue investigating during 2026 forward tracking.

### Bootstrap confidence intervals

For 2025 test (216 matches, expect 60–150 picks depending on threshold):

- 1,000 bootstrap resamples of the picks set.
- Report median cover rate + 95% CI.
- Report median predicted-line edge + 95% CI.

**Realistic expectations on AFL sample size:**

A 53% point estimate on 100 picks has roughly 95% CI [43%, 63%]. That's wide. To get a tight CI, you need either a larger effect or more picks. The validation-set replication (3 separate seasons × 50–150 picks = 150–450 picks) is what makes the result trustworthy, not the test season alone.

If the test set is the only evidence, a 53% one-season result is **inconclusive**, not promising. Cross-season replication is non-negotiable for the green tier.

---

## 7. Outputs

### Files the study produces

| File | Purpose | Committed? |
|---|---|---|
| `data/research/afl/aussportsbetting-afl-YYYY-MM-DD.xlsx` | Snapshot of source data | ❌ No (personal-use terms) |
| `data/processed/afl-matches.parquet` | Cleaned match dataset | ❌ No (derivative of source) |
| `data/processed/afl-matches-summary.csv` | Aggregated stats only (counts, MAE per season, no row-level odds) | ✅ Yes |
| `scripts/afl-feasibility-load.py` | Loader + cleaning | ✅ Yes |
| `scripts/afl-feasibility-elo.py` | Elo implementation + sweep | ✅ Yes |
| `scripts/afl-feasibility-eval.py` | Evaluation framework | ✅ Yes |
| `scripts/afl-feasibility-test.py` | Single-shot 2025 evaluation | ✅ Yes |
| `scripts/afl-feasibility-h2h-sanity.py` | H2H sanity check | ✅ Yes |
| `notebooks/afl-feasibility-eda.ipynb` | EDA (no raw odds in cell outputs — clear before commit) | ✅ Yes (cleared) |
| `notebooks/afl-feasibility-models.ipynb` | Model dev | ✅ Yes (cleared) |
| `notebooks/afl-feasibility-evaluation.ipynb` | Evaluation runs | ✅ Yes (cleared) |
| `reports/afl-feasibility-results.md` | Final writeup | ✅ Yes |
| `reports/figures/*.png` | Charts (no raw odds in source data) | ✅ Yes |
| `AFL-FEASIBILITY-PRE-REG.md` | Pre-registration | ✅ Yes (committed before test) |

### Charts/tables to produce

1. **Margin distribution histogram** with model's predicted margin overlaid — eyeball check that predictions aren't pathological.
2. **MAE by model by season** — one bar per `(model, season)`. Quick visual: does any model meaningfully beat market across all seasons?
3. **Predicted-line edge histogram** for selected picks — should be roughly symmetric around the threshold, not all clustered at the threshold itself (which would suggest the threshold is the only signal).
4. **Cover rate by season with bootstrap CIs** — three validation seasons + one test season + an aggregate.
5. **Cumulative ROI curve** at line odds (typically ~1.91) — purely illustrative; not a study endpoint.
6. **H2H sanity table** — model's H2H cover rate vs market closing implied probability accuracy, side by side.

### What does NOT get committed

Per AusSportsBetting personal-use terms:
- The xlsx itself.
- Any per-row dump of closing line / closing odds.
- Any CSV/parquet/JSON that lets someone reconstruct the AusSportsBetting dataset.
- Cell outputs in notebooks that print rows of odds data — clear all outputs before committing notebooks.

Add to `.gitignore` immediately:
```
data/research/afl/aussportsbetting-afl*.xlsx
data/processed/afl-matches.parquet
data/processed/afl-matches.csv
data/processed/afl-picks*.csv
data/processed/afl-picks*.parquet
```

Aggregated stats (MAE per season, cover-rate per season, count of picks) are fine to commit — they don't reproduce the source data.

---

## 8. Risks

### Data source risk
- **AusSportsBetting could change terms or stop publishing.** Mitigation: snapshot the xlsx with date suffix, document snapshot date in pre-reg, treat the dataset as fixed for the duration of the study.
- **AusSportsBetting "errors may exist" warning is real.** Cleaning rules in Section 1 catch the known patterns. Log row drops at each step.

### Odds-source mismatch
- **AusSportsBetting "close" is sourced from bet365 / Pinnacle / OddsPortal.** Live closing at Sportsbet/TAB may differ by 0.5–1.0 line points.
- A backtest CLV of +1.5 points may translate to live CLV of +0.8 or less.
- Mitigation: addressed downstream. If the study lands in promising tier, the paper-tracker captures multiple AU books' closing prices and we measure the gap directly.

### Bookmaker limits
- Even +1.0 point CLV at scale would attract restriction within weeks at AU books.
- Betfair AU spreads/totals returned no liquidity in the pre-flight sample.
- Mitigation: this is a downstream commercial concern, not a v1 study issue. Study is research only.

### Overfitting
- 6 dev seasons × ~207 matches = ~1,241 data points. Fewer than 10 features is safe; 20+ features at this size starts to overfit.
- Linear models and Elo are inherently low-dimensional. Mitigation = stay simple. The plan's explicit ban on tree models for v1 is the structural mitigation.

### Leakage
- The most insidious form: features computed using future data accidentally. Mitigation: code review checkpoint in Section 5.
- Squiggle leakage: explicitly excluded.
- Cross-fixture leakage in rolling features: assert in code that `match[t]` features only use `match[<t]` data.

### Small sample size
- One test season = 216 matches → maybe 60–150 picks. Bootstrap CIs at this scale are wide.
- Mitigation: cross-season replication on validation. If 2022, 2023, and 2024 all show consistent positive cover rate, one test season's result is corroborating evidence, not the whole evidence.

### False confidence from one good season
- 2025 could be a hot streak even from a zero-edge model. Probability of one season landing 53%+ from a true 50% model: roughly 18%. Not negligible.
- Mitigation: the green-tier criteria require validation-season consistency *and* test-season pass. Two independent gates, with H2H acting as a separate audit trigger rather than a third gate.

### Hyperparameter snooping
- The risk is iterating on the **test** set after seeing its results — running 2025, seeing a borderline outcome, "just trying threshold 1.5 instead", re-running. This is the failure mode pre-registration prevents.
- Iterating on the **validation** set is allowed and expected; that's what validation is for.
- Mitigation: pre-registration locks the chosen model, threshold, and pass/fail criteria after validation work but before any test-set evaluation. Once committed, the test is one-shot.

### Sign convention bug
- Easy to flip the line sign and get nonsense without realising it. Mitigation: cleaning rule 8 verifies on a known match before any analysis.

---

## 9. Final recommendation

### Smallest useful first script

**`scripts/afl-feasibility-load.py`**

What it does:
- Reads `data/research/afl/aussportsbetting-afl-YYYY-MM-DD.xlsx` with `header=1` (headers on Excel row 2).
- Applies cleaning rules 1–9 from Section 1.
- Verifies sign convention on a known match (assert + log).
- Writes `data/processed/afl-matches.parquet` (gitignored).
- Writes `data/processed/afl-matches-summary.csv` (committed): rows per season, null rates, drop counts at each cleaning step.
- Prints a summary table to stdout.

Why this first:
- Zero modelling. Zero tuning. Pure data prep.
- Single output, clear success criterion: row counts match pre-flight expectations within tolerance.
- Without it, nothing else can run.
- Catches data-format surprises early and cheaply.

Acceptance criteria for this script:
- Runs end-to-end without error.
- Summary table matches pre-flight row counts within ±2 rows per season.
- Sign convention verified on at least one known match.
- Cleaning drops less than 1% of post-2013 rows total.

### Subsequent script order

1. `scripts/afl-feasibility-elo.py` — Elo implementation and dev-set hyperparameter sweep.
2. `scripts/afl-feasibility-eval.py` — evaluation framework (MAE, predicted-line edge, cover rate, bootstrap CIs).
3. `scripts/afl-feasibility-h2h-sanity.py` — H2H sanity-check pipeline. Unexpected H2H success triggers an audit for leakage, odds-source mismatch, or sample artefact.
4. **Commit `AFL-FEASIBILITY-PRE-REG.md`** at this point. No further hyperparameter tuning after this commit.
5. `scripts/afl-feasibility-test.py` — single-shot 2025 evaluation. Run once. Record result.
6. `reports/afl-feasibility-results.md` — writeup, decision, next step.

### Suggested branch name

`research/afl-line-feasibility`

This is research, not a feature. The branch lives until the study is complete and merged with the results writeup; then it's archived.

### What does NOT get built in this branch

- No app integration.
- No UI for AFL.
- No Docker changes for AFL data.
- No live ingestion code (that comes later, only if the study lands in promising or inconclusive tier).
- No accordion row work, no scoring engine extension, no sharing with the existing soccer pipeline.

The AFL study runs as a separate analytical workflow. If it passes, *then* we discuss integration. Mixing it into the main GoalScout codebase prematurely is the fast path to scope creep.

---

## Appendix: what success / failure looks like in plain English

**Success looks like:** "By the end of weekend three, the writeup says: Elo with home advantage produced an MAE of 28.4 vs market 28.9, with a +1.3 point predicted-line edge on 372 picks across validation, 54.2% realised cover rate (95% CI 51.1–57.3%), consistent across 2022–2024, confirmed on 2025 with 89 picks at 55.1%. H2H sanity check came in at 51.4%, indistinguishable from coin flip and consistent with an efficient H2H market — no audit needed. Recommend building a paper-tracker for 2026."

**Inconclusive looks like:** "Mean predicted-line edge +0.7 points, validation cover rates 52% / 50% / 53%, test cover rate 52.3% with CI [47.8%, 56.7%]. Marginal, not significant. Recommend paper-tracking through end of 2026 and re-evaluating."

**Failure looks like:** "Across all four models, MAE matched the market within 0.2 points. Predicted-line edges were under 0.5 points on average. Cover rates clustered around 50% with no consistent direction. Recommend killing the AFL track."

All three are valid outcomes. The study has no preferred result.