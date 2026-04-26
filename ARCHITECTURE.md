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

## Current state (as of Stage 3)

| Layer          | Status    | Location |
|----------------|-----------|----------|
| Raw historical | ✅ Exists | `data/historical/` |
| Feature store  | 🔲 Future | `data/features/` |
| Prediction store | 🔲 Future | `data/predictions/` |
| Backtest store | ✅ Exists | `data/backtests/context_raw/` |

---

## What to do next (in order)

1. **Stage 4** — Build the research UI over `data/backtests/context_raw/`. Read the
   JSONL directly. No abstraction layer.

2. **Stage 6** — Expand the backtest to more EPL seasons and other leagues. One JSONL
   per league/season. The `_index.json` accumulates entries.

3. **Stage 8** — Live deployment. `context_raw` writes live predictions to
   `data/predictions/context_raw/`. The prediction store becomes real.

4. **Stage 9** — `context_calibrated`. This is a post-processing step on `context_raw`'s
   output probability, following the same pattern as `calibrated_current` relative to
   `current`. It applies Platt scaling to `context_o25_prob_raw` using parameters
   learned from 150+ settled predictions. It does not read `pre_match_v1` features and
   is not a trigger for building the feature store.

5. **Future** — Retroactive backtest of `current` using season-aggregate inputs.
   Produces `data/backtests/current/`. Cross-model comparison via `fixtureId` becomes
   possible.