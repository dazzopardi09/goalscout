# GoalScout — Data Architecture

This document explains how GoalScout's data layers are structured, which parts
exist today, which parts are planned, and when to create each one.

---

## The problem this document solves

GoalScout will eventually have multiple models making predictions about the same
fixtures using different inputs. Without a shared vocabulary and stable identifiers,
comparing models becomes painful: you can't easily ask "where did `current` and
`context_raw` disagree last weekend?" or "when both models agree, what's the
combined hit rate?" This document defines the structure that makes those questions
answerable without a big-bang migration later.

---

## Layers

### 1. Raw historical data

**What it is:** Season CSV files downloaded from Football-Data.co.uk. One file per
league per season. Contains every fixture result, scoreline, and market odds (opening
and closing) as published by the data provider. Treated as immutable input — we never
edit these files.

**Where it lives:**
```
data/historical/{league}/{season}.csv
```
Example: `data/historical/england/2024_25.csv`

**Status: EXISTS**

---

### 2. Feature store

**What it is:** Pre-computed per-fixture feature sets, grouped by feature definition
version. A feature set is the set of inputs a model reads before making a prediction.
The feature store exists to prevent two models from computing the same features
independently and getting different answers due to a bug or version drift in one of
them. It also makes ML training straightforward: the training data is already there,
computed once, with the leakage guarantee baked in at write time.

**Where it would live:**
```
data/features/{featureSetVersion}/{league}_{season}.jsonl
```
Example: `data/features/pre_match_v1/england_2024_25.jsonl`

Each row would contain one fixture's worth of features (rolling stats, season
aggregates, etc.) but no predictions and no model output. Every row includes the
`fixtureId` join key.

**Status: NOT YET BUILT**

**When to build it:** The first time either of these is true:

1. **A genuinely independent second model reads the same feature set.** This means a
   model with its own scoring logic that consumes `pre_match_v1` rolling stats as
   inputs — for example, a Poisson goal-total model, an opponent-adjusted variant of
   `context_raw`, or a "context with xG" experiment. Note that `context_calibrated`
   does NOT qualify: it is a post-processing step on `context_raw`'s output
   probability, not an independent model with its own feature inputs (see the
   `calibrated_current` precedent). As long as only one model reads a given feature
   set, there is nothing to deduplicate and the feature store adds overhead without
   benefit.

2. **You want to train an ML model.** ML training needs a clean feature matrix over
   all fixtures (including ones the rule-based model skipped), with no model-decision
   filtering. The feature store is that matrix.

Neither trigger is on the current roadmap.

**What NOT to do:** Don't merge `pre_match_v1` (rolling stats from Football-Data.co.uk)
and season aggregates (from SoccerSTATS) into a single feature store. They are
different temporal windows from different sources. They may not exist for the same set
of leagues, and computing them requires completely different pipelines. A unified
feature store implies a level of compatibility that doesn't exist. Treat them as
separate feature sets with separate version names.

---

### 3. Prediction store

**What it is:** Lightweight per-model prediction records. One row per fixture per
model, recording only what the model decided — direction, score, grade, probability —
along with the `fixtureId` join key and model version. No features, no result.

**Why it's separate from the backtest store:** The backtest store is for analysis after
the fact. The prediction store is for comparing models on the same fixture *before or
during* the match. A future live-prediction pipeline would write here as matches are
scored, then the settler would write the result, and you'd join the two to produce the
backtest evaluation.

**Where it would live:**
```
data/predictions/{model}/{league}_{season}.jsonl
```
Example: `data/predictions/context_raw/england_2024_25.jsonl`

**Status: NOT YET BUILT**

The backtest store (below) currently covers this role for historical analysis. The
prediction store becomes necessary when GoalScout starts making live predictions with
`context_raw` (planned August 2026 with the new European season). At that point, live
predictions are written here as they are generated, rather than being reconstructed
retrospectively.

---

### 4. Backtest store

**What it is:** Full historical evaluation files. Each row covers one fixture and
contains everything — features, predictions, result, and derived evaluation fields
(won/lost, edge, CLV, ROI contribution). Written by the backtest runner scripts, not by
the live prediction pipeline.

**Where it lives:**
```
data/backtests/{model}/{league}_{season}.jsonl
data/backtests/{model}/_index.json
```
Example: `data/backtests/context_raw/england_2024_25.jsonl`

**Status: EXISTS** (for `context_raw` only, EPL 2024-25)

Every row carries a `status` field as a lifecycle marker:
- `"settled"` — prediction was made and the match result is known
- `"skipped"` — model passed on this fixture (below threshold, insufficient data, etc.)
- `"pre_match"` — reserved for future live pipeline use (Stage 8+)

Backtest rows only ever use `"settled"` or `"skipped"`. The live prediction pipeline
(Stage 8) will write `"pre_match"` rows and update them to `"settled"` once results
arrive. UI consumers should always filter on `status` explicitly rather than inferring
state from null fields.

**Who reads it:** The Stage 4 research section of GoalScout's Performance tab reads
this directly. The backtest runner re-generates it when you run
`node scripts/context/run-backtest.js`.

**Note on `current` and `calibrated_current`:** These models do not have backtest
files yet. They log live predictions to `predictions.jsonl` and settle them via
`settler.js`. Retroactive backtesting of `current` against historical CSVs is a future
task. When that happens, the backtest files will live at
`data/backtests/current/england_2024_25.jsonl` etc., and the `fixtureId` join key will
connect them to the `context_raw` backtest files for cross-model comparison.

---

## The `fixtureId` join key

Every row in every data file (feature store, prediction store, backtest store) carries
a `fixtureId` field. This is the stable identifier that lets you join across models.

**Format:**
```
{leagueCode}_{YYYYMMDD}_{homeSlug}_{awaySlug}
```

**Example:**
```
E0_20241109_arsenal_newcastle_united
```

**Rules:**
- `leagueCode` is the Football-Data.co.uk division code (`E0`, `D1`, `I1`, etc.)
- Date is UTC from the CSV, formatted `YYYYMMDD` with no separators
- Team slugs are lowercase, non-alphanumeric characters replaced with `_`,
  consecutive underscores collapsed, leading/trailing underscores trimmed
- The same function (`makeFixtureId` in `run-backtest.js`) must be used everywhere

**Why this format and not a hash?** Human-readable. You can spot a wrong match by eye.
Hashes hide errors. The format is deterministic from the CSV data so it can be
recomputed at any time without a lookup table.

---

## Model versioning

Every row also carries:

- `modelVersion` — identifies the scoring logic and flag definitions that produced the
  prediction. Bump this when scoring tables, flag thresholds, or probability formulas
  change. Example: `context_raw_v1.1`.

- `featureSetVersion` — identifies which feature computation produced the inputs.
  Bump this when rolling-stats window size, decay, or field definitions change.
  Example: `pre_match_v1`.

Both are recorded in `_index.json` alongside the per-season summary stats, so you can
tell at a glance whether a backtest file was produced by the current or a previous
version of the model.

---

## How a cross-model comparison works today

Neither `current` nor `calibrated_current` produce backtest JSONL files yet, so a
full cross-model join is future work. When it becomes possible, the query is:

```javascript
// Load both backtest files for the same season
const contextRows  = loadJSONL('data/backtests/context_raw/england_2024_25.jsonl');
const currentRows  = loadJSONL('data/backtests/current/england_2024_25.jsonl');

// Index by fixtureId
const contextMap   = new Map(contextRows.map(r  => [r.fixtureId, r]));
const currentMap   = new Map(currentRows.map(r  => [r.fixtureId, r]));

// Fixtures where both models made a prediction and disagreed
const disagreed = [...contextMap.entries()]
  .filter(([id, cr]) => {
    const cur = currentMap.get(id);
    return cur && !cur.skipped && !cr.skipped && cur.direction !== cr.context_direction;
  });
```

This works because both runners use `makeFixtureId` with the same inputs.

---

## Current state (as of Stage 3 complete)

| Layer            | Status      | Location |
|------------------|-------------|----------|
| Raw historical   | ✅ Exists   | `data/historical/` |
| Feature store    | 🔲 Future   | `data/features/` — see trigger conditions above |
| Prediction store | 🔲 Future   | `data/predictions/` — becomes real at Stage 9 |
| Backtest store   | ✅ Exists   | `data/backtests/context_raw/` (EPL 2024-25) |

Next step: **Stage 4** — Context Research UI.

---

## Roadmap (in order)

---

### Stage 4 — Context Research UI

**Purpose:** Make the EPL 2024-25 backtest data browsable inside GoalScout. First
time model behaviour is visible beyond terminal output.

**Inputs:** `data/backtests/context_raw/england_2024_25.jsonl`, `_index.json`

**Outputs:** Performance tab research section with selector strip, headline cards,
filter bar (direction/grade/status/flags/gameweek/edge/result), flag performance
table with expected-direction indicators, gameweek hit-rate chart, edge-vs-outcome
chart, predictions table, detail drawer.

**Decisions made here:** Is the UI sufficient to diagnose individual predictions and
read flag signals without terminal output?

**Exit criteria:** Any prediction is findable in under 30 seconds. Flag performance
table is readable at a glance.

---

### Stage 5 — Single-season analysis and model assessment

**Purpose:** A dedicated analysis gate before adding any more data. Scaling a
miscalibrated model across five seasons produces five seasons of miscalibrated
results. This stage decides whether to proceed as-is or make a targeted fix first.

**Inputs:** Stage 4 UI, EPL 2024-25 backtest summary, flag performance numbers.

**Outputs:** Written assessment in `PROJECT-STATUS.md` covering:
- Which flags are working as designed, which aren't
- Whether the threshold of 4 is too aggressive (121 below-threshold skips = 32% of
  all fixtures — unusually high)
- Whether U2.5 signal is genuinely absent or just underrepresented at 38 predictions
- Whether `strong_two_sided_over` underperforming is noise or a structural problem
- A decision: proceed to Stage 6 as-is, or apply a targeted fix first

**Decisions made here:**
- **Proceed as-is** — inconclusive but not alarming; multi-season data will clarify
- **Targeted fix** — one or two specific changes before expanding; bump
  `MODEL_VERSION` and re-run Stage 3 before Stage 6
- Do not make sweeping changes based on one season of data

**Exit criteria:** Written decision on whether to proceed to Stage 6 or fix first.
No code changes unless the decision is a targeted fix.

---

### Stage 6 — Multi-season EPL expansion

**Purpose:** Validate whether Stage 5 findings hold across multiple seasons. One
season has too much noise to distinguish signal from luck. Five seasons starts to be
statistically meaningful for flag-level analysis.

**Inputs:** Football-Data.co.uk EPL CSVs for 2019-20 through 2023-24 (five
additional seasons). See `scripts/context/DOWNLOAD.md`.

**Outputs:** Five additional JSONL files in `data/backtests/context_raw/`. Updated
`_index.json`. Season selector in UI becomes meaningful. Gameweek chart shows
multiple season overlays.

**Decisions made here:**
- Do CDO and `both_leaky_defence` signals hold across seasons?
- Is `strong_two_sided_over` underperformance consistent or a 2024-25 anomaly?
- Is 53% prediction rate stable across seasons, or does it vary significantly?
- What is the aggregate hit rate across all six seasons?

**Exit criteria:** Six seasons of EPL data loaded. Flag performance table has N>50
for all major flags. Aggregate stats visible in UI.

---

### Stage 7 — Cross-league expansion

**Purpose:** Test whether the model generalises beyond the EPL. Different leagues
have different base O2.5 rates and tactical styles. Bundesliga (high-scoring) and
Serie A (low-scoring) are the most useful early stress tests.

**Inputs:** Football-Data.co.uk CSVs for Bundesliga, La Liga, Serie A, Ligue 1,
Eredivisie — same seasons as Stage 6.

**Outputs:** Additional JSONL files per league per season. League selector in UI
becomes meaningful. Per-league hit rate breakdown visible.

**Decisions made here:**
- Does hit rate vary significantly by league? A model that works in EPL but not
  Bundesliga has a structural problem.
- Are there leagues where the model should not be deployed in Stage 9?
- Should league-level calibration be applied before live deployment?

**Note on sequencing:** Stage 7 comes after Stage 6 deliberately. If Stage 6
reveals a problem requiring a targeted fix, apply it before downloading and running
six more leagues of data.

**Exit criteria:** At least three leagues loaded with two or more seasons each.
Hit rate by league visible in UI. Decision on which leagues are in scope for Stage 9.

---

### Stage 8 — Pre-deployment validation and go/no-go decision

**Purpose:** A dedicated no-code review gate before live predictions start. Applies
a four-metric validation framework to all backtest data from Stages 6 and 7 and
makes an explicit deployment decision.

**Inputs:** All JSONL files from `data/backtests/context_raw/`, Stage 4 UI, Stage 5
written assessment, any model changes applied during Stages 5-7.

**Outputs:** Written deployment decision in `PROJECT-STATUS.md` covering each of the
four metrics and a go/no-go conclusion. If go: league scope and any conditions. If
no-go: specific diagnosis and return point.

#### Validation framework

Four metrics, evaluated in this order:

**1. Edge vs outcome slope — structural test, evaluated first**

Pull the edge-vs-outcome chart from the Stage 4 UI across all backtest data. The
slope must be broadly upward: high-edge predictions winning more often than low-edge
predictions. This is the test that calibration cannot fix — if the slope is flat or
negative, the model's rank ordering is broken, not just its level.

- Pass: directionally upward slope with no major reversals in the ≥10% edge buckets
- Fail: flat or downward slope in the ≥10% edge bucket

If this fails, stop. Return to Stage 5 with a specific diagnosis.

**2. CLV — edge authenticity test**

Mean CLV across all backtest predictions, aggregated across all seasons and leagues.

- Strong pass: mean CLV > +1.5%
- Acceptable: mean CLV 0% to +1.5% — proceed with caution; monitor live CLV closely
  in the first month of deployment
- Fail: mean CLV consistently below −1% across multiple seasons

Current baseline: −0.26% on one EPL season. Marginal. Needs to improve across more
data before this is a pass. A model with near-zero CLV may still be deployable if the
slope is clean and ROI is positive, but live CLV tracking becomes critical from day one.

**3. ROI — profitability test**

Aggregate flat-stake ROI across all backtest predictions. Computed on opening odds.
Minimum sample: 500 predictions across at least three seasons.

- Pass: aggregate ROI > +2%
- Conditional: ROI −2% to +2% — proceed only if CLV is positive and
  `context_calibrated` is deployed simultaneously
- Fail: aggregate ROI below −2% after calibration

Do not evaluate ROI in isolation from CLV:
- Positive ROI + negative CLV = do not trust; likely variance, not edge
- Negative ROI + positive CLV = likely a calibration problem; deploy
  `context_calibrated` first, then re-evaluate

**4. Hit rate — sanity check, evaluated last**

- Pass: > 55% aggregate
- Warning: 53–55% — not a hard fail; check whether U2.5 is dragging the average
  and whether restricting to O2.5 changes the picture
- Fail: < 53% — at or below base rate

#### Go/no-go decision logic

```
Edge-vs-outcome slope flat or negative          → NO-GO  (return to Stage 5)

CLV < −1% consistently                          → NO-GO  (return to Stage 5)

CLV ≥ 0%  AND  ROI > +2%                        → GO

CLV ≥ 0%  AND  ROI −2% to +2%                   → CONDITIONAL GO
                                                   deploy context_calibrated
                                                   simultaneously; 4-week
                                                   live monitoring checkpoint

CLV ≥ 0%  AND  ROI < −2%                        → NO-GO  (targeted fix, return
                                                   to Stage 6)

CLV 0% to −1%  AND  ROI > +2%                   → MONITOR (deploy with caution;
                                                   4-week checkpoint)

CLV 0% to −1%  AND  ROI ≤ +2%                   → NO-GO
```

**Exit criteria:** Written decision (GO / CONDITIONAL GO with conditions / NO-GO
with diagnosis and return point) recorded in `PROJECT-STATUS.md`.

**Note on current baseline:** The −3.6% ROI and −0.26% CLV from EPL 2024-25 alone
are not a Stage 8 no-go signal — Stage 8 is evaluated on the aggregate output of
Stages 6-7 (multiple seasons, multiple leagues, 800+ predictions minimum). The
current single-season numbers show the model is not obviously broken, but there is
not yet enough data to make a deployment decision.

---

### Stage 9 — Live deployment

**Purpose:** Wire `context_raw` into GoalScout's live shortlist pipeline so it
generates predictions on upcoming fixtures alongside `current` and
`calibrated_current`.

**Inputs:** `context-shortlist.js` (built), rolling stats engine (built), live
fixture data from The-Odds-API or SoccerSTATS.

**Outputs:**
- `context_raw` predictions appear in the GoalScout shortlist UI
- Live predictions written to `data/predictions/context_raw/` (prediction store
  becomes real)
- Settler wired to update prediction rows with results as matches complete

**Decisions made here:** None — the deployment decision was made in Stage 8.
This is implementation only.

**Exit criteria:** At least one weekend of live predictions generated, checked,
and settled correctly.

---

### Stage 10 — context_calibrated

**Purpose:** Apply Platt scaling to `context_o25_prob_raw` to produce calibrated
probabilities. Post-processing on `context_raw` outputs — not a new feature
consumer. Follows the same pattern as `calibrated_current` relative to `current`.

**Inputs:** 150+ settled live `context_raw` predictions with results (from Stage 9).
Must be live predictions, not backtest rows — calibrating on backtest data would be
circular.

**Outputs:** Platt scaling parameters (slope and intercept) stored in config.
`context_calibrated` produces `context_o25_prob_calibrated`. Edge calculations for
`context_calibrated` use the calibrated probability. The +11.54% mean edge gap
from the backtest should narrow significantly.

**Decisions made here:** Is the Brier score of `context_calibrated` measurably
better than `context_raw` on a held-out set? If calibration makes negligible
difference, the raw probabilities may already be adequate.

**Note:** `context_calibrated` does not read `pre_match_v1` features and is not a
trigger for building the feature store.

**Exit criteria:** Brier score of `context_calibrated` measurably better than
`context_raw` on a held-out set of settled predictions.

---

### Stage 11 — Retroactive backtest of `current`

**Purpose:** Produce historical backtest files for `current` so cross-model
comparison via `fixtureId` becomes possible. This is the stage where "where did
`current` and `context_raw` disagree?" becomes a real query.

**Inputs:** Same Football-Data.co.uk CSVs used in Stages 6-7, plus historical
season-aggregate data from SoccerSTATS. The SoccerSTATS data availability for past
seasons is the main risk — it may not expose historical aggregates in the same
format as current seasons.

**Outputs:** `data/backtests/current/{league}_{season}.jsonl` files. Cross-model
comparison UI in the Performance tab.

**Decisions made here:**
- Is SoccerSTATS historical data accessible for past seasons? If not, this stage
  may be partially blocked.
- Does the disagreement analysis reveal fixture types where both models agree and
  both are right more often than either alone?

**Exit criteria:** At least one league, multiple seasons of `current` backtest data.
Cross-model join working via `fixtureId`. Disagreement analysis visible in UI.