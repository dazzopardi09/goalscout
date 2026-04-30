# GoalScout Modelling Sandbox

Standalone Python sandbox for training and evaluating Dixon-Coles / Poisson goal models.

This is **research code**, fully decoupled from the live GoalScout Node app. It does
not modify, depend on, or interfere with `src/`, `public/`, or any production code path.
The Dockerfile only copies `src/` and `public/` into the production image, so this
directory is automatically excluded from the live container.

## What this is

Adapted from the modelling core of the old `soccer-prediction-system` backend (Nov 2025).
The maths (Dixon-Coles MLE, scoreline matrix, market derivation) is preserved
byte-for-byte where possible. Database, FastAPI, and API-Football dependencies have
been stripped.

## What this is not

- Not a service. Not an API. Not a UI.
- Not wired into the live GoalScout app.
- No xG, no value betting, no odds processing.
- No multi-league orchestration. EPL only for now.

## Setup

Run on your dev machine, not on Unraid.

```bash
cd research/modeling
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

## Input

Place a CSV at `inputs/epl_matches.csv` with columns:

```
league,season,date,home_team,away_team,home_goals,away_goals,source
EPL,2025-2026,2025-08-17,Liverpool,Bournemouth,4,2,football-data
```

- `league` is filtered for `EPL` (case-sensitive).
- `date` must parse to a calendar date (any common format).
- `home_goals`, `away_goals` must be integers.
- Other columns are ignored.

For meaningful holdout metrics, prefer **at least two seasons** of data (~760 matches).
A single season produces a small holdout (~76 matches) with high-variance metrics.

## Run

```bash
# Verify the tau fix and DC=Poisson reduction (no CSV needed)
python test_smoke.py

# Train and evaluate (requires inputs/epl_matches.csv)
python train_epl.py --model poisson
python train_epl.py --model dixon_coles
```

## Output

`outputs/epl_dixon_coles.json` — trained model summary, holdout predictions with actuals,
data quality block, and training config. Keys at top level:

- `league`, `model`, `trained_at`, `matches_used`
- `config` — model_type, holdout_pct, goal_cap, decay_half_life_days, min_matches_per_team, lambda_reg
- `data_quality` — rows_loaded, rows_used, teams, seasons, date_min, date_max, dropped_rows, warnings
- `metrics` — brier_over_2_5, log_loss_over_2_5
- `predictions[]` — each holdout match: predicted probabilities + expected goals + actual results

## Files

| File | Purpose | Origin |
|---|---|---|
| `parameters.py` | `LeagueModelParams`, `TeamStrength` dataclasses | Verbatim from old backend |
| `scoreline.py` | Builds `P(X=x, Y=y)` scoreline matrix with optional Dixon-Coles tau | Old backend (1 import path edit) |
| `markets.py` | Derives 1X2, BTTS, O/U markets from scoreline matrix | Old backend (1 import path edit) |
| `trainer.py` | Dixon-Coles / Poisson MLE via `scipy.optimize` | Old backend (DB layer stripped) |
| `evaluator.py` | Chronological holdout split, Brier score, log-loss | New |
| `train_epl.py` | Pipeline entry: CSV → split → train → predict → JSON | New |
