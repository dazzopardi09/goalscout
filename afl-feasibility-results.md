# AFL Line/Spread Feasibility Study — Results

**Date:** 30 April 2026  
**Status:** Complete — negative finding  
**Scope:** Low-cost line/spread models only (Elo, rolling form, linear regression)  
**Recommendation:** Close AFL line/spread v1. Do not proceed to validation or test.

---

## Executive Summary

The AFL line/spread feasibility study tested whether simple, low-dimensional models can beat the closing line on margin prediction using only publicly available match results. Three baseline models were evaluated on two development folds (eval 2018, eval 2019):

| Model | Best MAE improvement (H&A) | Market MAE | Best model MAE |
|---|---|---|---|
| Market baseline | — | 26.3 pts | — |
| Model 1 — Elo + home advantage | **−0.90 pts** | 26.3 pts | 27.2 pts |
| Model 2 — Rolling form | **−2.52 pts** | 26.3 pts | 28.8 pts |
| Model 3 — Linear regression | **−1.36 pts** | 26.3 pts | 27.7 pts |

**All three models failed the primary criterion** (model MAE < market MAE). Cover rates on selected picks cluster around 49–52% with high pick rates (88–95% of H&A matches), consistent with systematic miscalibration rather than selective edge.

**Conclusion:** The low-cost AFL line/spread thesis is falsified on development data. The closing line captures margin-prediction signal more efficiently than simple models using only match results, team ratings, and rest/form features.

**Recommended action:** Close AFL line/spread v1. Do not run validation (2022–2024) or test (2025) on these models. Document this as a useful negative finding that rules out a false direction before real resource commitment.

---

## Study Design

### Scope and constraints

**In scope:**
- Line/spread margin prediction only
- Low-dimensional features: team ratings (Elo), rolling form, days rest
- Public data only: match results from AusSportsBetting historical dataset
- Three baseline models: Elo, rolling form, linear regression
- Development evaluation on 2018–2019 (rolling folds)

**Out of scope:**
- Totals (Over/Under) market — different signals, separate study
- Complex features: player ratings, lineup adjustment, injury data, venue/weather
- Complex ML: tree models, neural networks, ensembles
- Validation (2022–2024) and test (2025) — not run given dev failure

**Data sources:**
- AusSportsBetting AFL historical dataset (2009–2026)
- Cleaned to 2,504 matches post-2013 (2020 excluded, COVID; 2026 partial excluded)
- Columns: date, teams, venue, scores, closing line, closing odds
- Market baseline: `market_predicted_margin = −home_line_close`

**Study phases:**
- 2013: burn-in for Elo initialization (not evaluated)
- 2014–2019: development (free iteration, hyperparameter sweeps)
- 2020: excluded (COVID 16-minute quarters)
- 2021: sensitivity (deferred — not run)
- 2022–2024: validation (deferred — not run given dev failure)
- 2025: held-out test (never touched)

**Rolling development folds:**
- Fold 1: train 2013–2017, evaluate 2018 (198 H&A matches)
- Fold 2: train 2013–2018, evaluate 2019 (198 H&A matches)

**Primary success criterion:**
- Model MAE (H&A matches, mean across both folds) < market MAE
- Positive MAE improvement = model is better than closing line

**Secondary criteria (not reached):**
- Cover rate ≥ 53% on selected picks (threshold = 2 points edge vs market)
- Mean predicted-line edge ≥ +1.0 points
- Cross-fold replication (2018 and 2019 results consistent)

---

## Results

### Model 1: Elo + home advantage

**Architecture:**
- Team ratings initialized at 1500, updated after each match via win/loss Elo
- Predicted margin = `scale × (home_elo − away_elo) + home_advantage`
- Home advantage added to win-probability calculation for internal consistency
- Margin-of-victory dampening (sqrt/log) to prevent blowout over-weighting
- Inter-season regression toward 1500 to prevent rating drift

**Hyperparameter grid:**
- K: [25, 40, 55]
- home_advantage: [5, 7, 9, 11]
- scale: [0.04, 0.05, 0.06]
- inter_season_regression: [0.1, 0.2, 0.3]
- margin_adj: ['none', 'sqrt', 'log']
- **324 combos × 2 folds = 648 evaluations**

**Best combo (mean across folds):**
- K=55, home_adv=7, scale=0.06, regression=0.1, sqrt dampening
- Model MAE (H&A): **27.22 pts**
- Market MAE (H&A): **26.32 pts**
- MAE improvement: **−0.90 pts**
- Avg picks (threshold 2.0): 177.5 / ~198 H&A matches (**90% pick rate**)
- Cover rate: **52.97%** (95% CI includes 50% and breakeven 52.4%)

**Result:** ❌ **Failed.** Every combo produced negative MAE improvement. Cover rate consistent with noise. High pick rate indicates poor calibration.

**Interpretation:** Best combos cluster at grid ceiling (K=55, scale=0.06), suggesting the optimizer wants "louder" parameters — a sign the model lacks the right structure, not that it needs better tuning.

---

### Model 2: Rolling recent form

**Architecture:**
- Predicted margin = `(home_form − away_form) + home_advantage`
- Form = mean margin in last N games
- Optional opponent adjustment: each historical margin adjusted by opponent's form at the time (leakage-safe)
- No parameter updates; form computed on-the-fly per match

**Hyperparameter grid:**
- window: [3, 5, 8, 10] games
- opponent_adjust: [False, True]
- home_advantage: [5, 7, 9] points
- **24 combos × 2 folds = 48 evaluations**

**Best combo (mean across folds):**
- window=10, opponent_adjust=False, home_adv=7
- Model MAE (H&A): **28.55 pts**
- Market MAE (H&A): **26.32 pts**
- MAE improvement: **−2.24 pts**
- Avg picks: 189.5 (**96% pick rate**)
- Cover rate: **49.87%**

**Result:** ❌ **Failed.** Worst of the three models. Added noise relative to Elo.

**Interpretation:** Rolling form alone is too volatile — recent 10-game samples fluctuate wildly in AFL (typical margin std ~40 points). Opponent adjustment didn't help; if anything, it amplified noise.

---

### Model 3: Linear regression

**Architecture:**
- Features: intercept + `form_diff` + `rest_diff`
- `form_diff` = home_form − away_form (using rolling N-game window)
- `rest_diff` = home_days_rest − away_days_rest (no lookahead; first-of-season default 7 days)
- Fitted via `numpy.linalg.lstsq` on training set, applied to eval set

**Hyperparameter grid:**
- window: [3, 5, 8, 10] (for form computation)
- opponent_adjust: [False, True]
- **8 combos × 2 folds = 16 evaluations**

**Best combo (mean across folds):**
- window=8, opponent_adjust=False
- Coefficients: intercept=5.9, form_diff=0.58, rest_diff=−0.08
- Model MAE (H&A): **27.68 pts**
- Market MAE (H&A): **26.32 pts**
- MAE improvement: **−1.36 pts**
- Avg picks: 177.0 (**89% pick rate**)
- Cover rate: **51.98%**

**Result:** ❌ **Failed.** Closest to market of the three models, but still negative.

**Interpretation:** The fitted coefficient on `form_diff` (0.58) is sensible — a one-point form advantage translates to ~0.6 points in predicted margin. But the feature itself is noisy. The `rest_diff` coefficient (−0.08) is near zero, indicating rest has minimal predictive value at this level of analysis. The intercept (5.9) acts as a learned home advantage, consistent with AFL's ~6-point historical home edge.

---

## Cross-model interpretation

### Why all three failed

**The closing line is structurally more informed:**
- Bookmakers incorporate: team news, lineup changes, weather, venue-specific effects, recent injuries, coaching changes, betting flow, sharp money movement
- Simple models use: past match results only
- The feature gap is too wide for low-dimensional models to bridge

**AFL-specific challenges:**
- High variance: typical margin std ~40 points; even large rating differences produce wide prediction intervals
- Parity: mean absolute closing line ~17–22 points in recent years (down from ~28 in 2013 as expansion teams matured); competition is tighter, edges are smaller
- Finals exclusion: removing finals (9 matches/season) cuts 4.5% of the sample, but those matches are higher-stakes and may be better modeled; excluding them narrows the eval set

**Pick rate as a diagnostic:**
Models picking 88–96% of games at a 2-point threshold are not finding selective edges — they're systematically sitting 2+ points away from the market on almost every fixture. This indicates:
1. Absolute miscalibration (predictions too wide or too narrow)
2. Overfitting to noise (confusing random fluctuation for signal)
3. Missing structural features the market has (venue effects, lineup, weather)

**Cover rates are indistinguishable from noise:**
With ~180 picks and a standard error of ~3.7%, a 52% cover rate has a 95% CI of roughly [44.6%, 59.4%]. This includes both 50% (coin flip) and 52.4% (breakeven at 1.91 line odds). None of the models clear this bar with statistical confidence.

---

## What this result does NOT test

This study falsifies the **low-cost AFL line/spread thesis** only. It does not test:

### AFL totals (Over/Under) market

Totals may depend on different signals than margin:
- **Venue scoring profile:** some venues consistently produce higher combined scores (outdoor vs roof, larger vs smaller grounds)
- **Weather:** wind, rain, temperature affect ball movement and scoring efficiency
- **Roof/open stadium:** controlled environment vs elements
- **Rolling points-for/against:** team offensive and defensive strength independent of margin
- **Team scoring style:** fast/slow tempo, contested/uncontested ball movement
- **Injuries to key scorers:** forwards, rucks, key defenders
- **Recent combined-score trends:** both teams' recent total-score outputs

The AusSportsBetting dataset has historical totals columns (`Total Score Close`, `Total Score Over Close`, `Total Score Under Close`), though with higher missingness than line/spread (~7.6% null post-2013 vs <0.1% for lines). A separate totals feasibility study would require its own scoping, data verification, and baseline model selection.

### Richer line/spread models

More complex approaches may still work, but they require:
- **Player-level data:** individual ratings, lineup adjustment, positional depth
- **Injury data:** published injury lists, match-availability updates
- **Venue/travel effects:** home-state advantage, flight distances, time zones
- **Weather data:** temperature, wind, rainfall at match time
- **Scraped data:** live odds movement, lineup announcements, team news feeds

These are **out of scope for v1** by design. The study plan explicitly states:

> "If simple low-dimensional models fail, the low-cost AFL line thesis fails. More complex player-level ratings, lineup adjustment, injury-aware features — may still work, but they require a separate justification, separate data pipelines, and are explicitly out of scope for v1."

The negative v1 result does not prove richer models can't work — it only proves the **low-cost path** doesn't.

---

## Recommended next direction

### Immediate action: close AFL line/spread v1

**Do not run:**
- 2022–2024 validation folds
- 2025 held-out test
- H2H sanity check (deferred; no longer needed)
- 2021 sensitivity analysis (deferred; no longer needed)

**Do not attempt to rescue with:**
- Threshold tuning (the MAE gap is structural, not a parameter issue)
- Complex ML (XGBoost, neural networks — out of scope for v1 by design)
- Player-level features (requires new data pipelines; separate justification needed)
- Additional line/spread features (venue effects, weather — same reasoning)

**Document and commit:**
- This results document as `reports/afl-feasibility-results.md`
- Final sweep CSVs already committed:
  - `data/processed/afl-elo-sweep-results.csv`
  - `data/processed/afl-elo-best-params.csv`
  - `data/processed/afl-simple-models-results.csv`
  - `data/processed/afl-simple-models-best.csv`
- Study plan documents:
  - `AFL-FEASIBILITY-STUDY-PLAN-v2.md`
  - `GOALSCOUT-AFL-FEASIBILITY-STRESS-TEST.md`
  - `GOALSCOUT-AFL-PREFLIGHT.md`

---

### Next project decision: AFL totals or soccer hybrid/CLV?

**Option A — AFL totals feasibility study**

A new, scoped feasibility study for the totals (Over/Under) market. This is **not a continuation** of line/spread v1 — it's a separate investigation with different signals, different data checks, and different baseline models.

**Scope:**
- Totals market only: predict combined score, compare to closing total
- Data verification: AusSportsBetting totals columns have ~7.6% missingness post-2013; check coverage, quality, bookmaker consistency
- Baseline models:
  - Rolling combined-score average (team points-for + points-against)
  - Venue scoring profile + team offensive/defensive ratings
  - Linear regression: team rolling totals + venue effect + weather (if available)
- Same study structure: dev folds (2018–2019), validation (2022–2024), held-out test (2025)
- Pre-registration before test
- Same pass/fail criteria: beat closing total on MAE, sustained cover rate >52.4%

**Why this might work where line/spread didn't:**
- Totals signal may be less efficient than margin (bookmakers focus line-setting effort on margin spreads; totals are sometimes secondary)
- Venue effects are stronger for totals than margin (some grounds consistently produce 160–180 combined scores, others 130–150)
- Weather is a totals signal but not necessarily a margin signal (wind affects both teams' scoring, cancels out in margin but compounds in total)

**Why it might not:**
- The totals closing line may be just as efficient as the margin closing line
- Missing 7.6% of matches in the training set could degrade model quality
- AFL totals may require the same rich features (injuries, lineup, weather) that line/spread does

**Time cost:** ~2–3 weekends (data verification, loader, 2–3 baseline models, dev sweep, results doc).

---

**Option B — Soccer hybrid model + CLV infrastructure**

Return to the existing GoalScout soccer path. Focus on:

1. **Market-prior + residual hybrid model:**
   - Baseline: closing odds implied probability (market prior)
   - Residual model: predict `P(over_2.5) − market_prior` using Understat xG, recent form, fixture difficulty
   - Combine: `final_P = market_prior + λ × residual` where λ is a shrinkage parameter
   - Hypothesis: even a small systematic residual (±2–5%) can produce edge when market prior is well-calibrated

2. **Better open/close odds capture and CLV measurement:**
   - Store opening odds (early market price) alongside closing odds
   - Measure Closing Line Value (CLV): did our picks move toward our position between open and close?
   - CLV is a leading indicator of model quality before results are settled
   - Track: `CLV = (close_odds − open_odds) × direction_of_pick`

3. **Infrastructure improvements:**
   - Betfair API integration for live odds snapshots
   - Historical odds storage (open, close, intraday if available)
   - Pick logging with timestamps
   - Calibration plots, Brier scores, ROC curves

**Why this makes sense:**
- Soccer Over 2.5 / BTTS is the original GoalScout target market
- Understat xG has been identified as the likely free xG source for a soccer hybrid model, but integration status should be verified before implementation
- Soccer remains attractive because GoalScout already has infrastructure and higher match volume, not because its closing line is assumed softer
- CLV infrastructure is reusable across markets (if we later return to AFL, the same tracking applies)

**Time cost:** Comparable to Option A (~2–3 weekends for hybrid model dev, ~1–2 weeks for Betfair + CLV infrastructure).

---

### Final recommendation

**The immediate action is to close AFL line/spread v1.**

**The next project decision is whether to open a separate AFL totals feasibility study (Option A) or return to soccer hybrid/CLV infrastructure (Option B).**

Both are defensible paths. The choice depends on:
- **Interest in AFL vs soccer as a market:** AFL is domestic, smaller, possibly less efficient. Soccer is global, larger, well-studied.
- **Belief in totals as a differentiated signal:** If venue/weather effects on combined score are genuinely underpriced, Option A. If not, Option B.
- **Infrastructure priority:** CLV measurement is a prerequisite for any serious betting operation. If we don't have it yet, Option B builds it. If we do, Option A is viable.

No recommendation is made here between A and B. That decision should be informed by:
1. A brief pre-flight check on AFL totals data quality (does the 7.6% missingness cluster in certain seasons/venues/bookmakers?)
2. A review of GoalScout's current soccer infrastructure gaps (do we have open/close odds? Betfair integration? CLV tracking?)
3. A strategic judgment on which market offers the better risk-adjusted opportunity given resource constraints.

---

## Appendices

### A. File manifest

**Scripts (committed):**
- `scripts/afl-feasibility-load.py` — loader, cleaning, sign convention verification
- `scripts/afl-feasibility-elo.py` — Elo sweep (324 combos × 2 folds)
- `scripts/afl-feasibility-simple-models.py` — rolling form + linear regression (32 combos × 2 folds)

**Data (committed, aggregate-only):**
- `data/processed/afl-matches-summary.csv` — per-season stats (no row-level odds)
- `data/processed/afl-cleaning-summary.csv` — cleaning step audit trail
- `data/processed/afl-elo-sweep-results.csv` — 648 rows, model metrics only
- `data/processed/afl-elo-best-params.csv` — top-10 Elo combos
- `data/processed/afl-simple-models-results.csv` — 64 rows, model metrics + coefficients
- `data/processed/afl-simple-models-best.csv` — top-10 simple-model combos

**Data (gitignored, not committed):**
- `data/research/afl/aussportsbetting-afl-2026-04-30.xlsx` — source data (personal-use license per AusSportsBetting terms)
- `data/processed/afl-matches.parquet` — full cleaned dataset (contains row-level closing odds)

**Docs (committed):**
- `AFL-FEASIBILITY-STUDY-PLAN.md` — study design, rolling folds, pass/fail criteria
- `AFL-PREFLIGHT-CHECKLIST.md` — pre-flight data verification checklist
- `AFL-PREFLIGHT-RESULTS.md` — data-source verification results (AusSportsBetting, fitzRoy, Odds API)
- `reports/afl-feasibility-results.md` — this document

---

### B. Sign convention verification (from loader)

**Handicap symmetry:** `Home Line Close + Away Line Close ≈ 0` across all 2,504 matches. Max absolute deviation: 0.0000 (perfect).

**Cover rate aggregate:** 0.5000 exactly across all post-2013 rows. The closing line is efficient by design.

**Eyeball sample (5 clearest home favourites):**

| Season | Home Team | Away Team | Home Line Close | Margin | Home Covered |
|---|---|---|---|---|---|
| 2013 | Hawthorn | GWS Giants | −101.5 | +83 | 0 |
| 2013 | Essendon | GWS Giants | −92.5 | +39 | 0 |
| 2013 | North Melbourne | GWS Giants | −87.5 | +86 | 0 |
| 2013 | Collingwood | GWS Giants | −86.5 | +40 | 0 |
| 2023 | Brisbane | West Coast | −85.5 | +81 | 0 |

Interpretation: Large home favourites (negative line) won but didn't cover the extreme spreads (GWS and West Coast were expansion teams with historically bad records in those seasons). Sign convention confirmed correct: `home_line_close < 0` = home favoured; `home_covered = 1` if `(margin + home_line_close) > 0`.

---

### C. Reproducibility

All scripts are deterministic (no random seeds needed). To reproduce:

1. Obtain AusSportsBetting AFL historical dataset (personal-use license) and place at `data/research/afl/aussportsbetting-afl-YYYY-MM-DD.xlsx`
2. Run loader: `python scripts/afl-feasibility-load.py`
3. Run Elo sweep: `python scripts/afl-feasibility-elo.py`
4. Run simple models: `python scripts/afl-feasibility-simple-models.py`

Expected runtime: ~20 seconds total (15s Elo, 2s simple models, 3s loader).

All outputs are committed except the source xlsx and the parquet (which contains row-level closing odds and is therefore not redistributable under AusSportsBetting's terms).

---

**End of report.**