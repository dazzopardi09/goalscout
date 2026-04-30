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

# Fetch historical match data
python fetch_epl.py --league EPL
python fetch_epl.py --league Championship

# Train and evaluate (requires inputs/<league>_matches.csv)
python train_league.py --league EPL --model poisson
python train_league.py --league EPL --model dixon_coles
python train_league.py --league Championship --model poisson
python train_league.py --league Championship --model dixon_coles

# Threshold / pick-zone analysis (requires outputs/*.json from train_league.py)
python analyse_thresholds.py                                   # all outputs/*.json
python analyse_thresholds.py --file outputs/epl_poisson.json   # single file
python analyse_thresholds.py --league EPL                      # filter by league
python analyse_thresholds.py --league EPL --model poisson      # filter by both

# Multi-league discovery scan (Milestone 6)
python run_league_scan.py                                      # all 16 Format A leagues
python run_league_scan.py --leagues EPL Championship LeagueOne LeagueTwo
python run_league_scan.py --leagues Bundesliga                 # single league
python run_league_scan.py --no-cache                           # force re-fetch
python run_league_scan.py --dry-run                            # list leagues, no training
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
| `scoreline.py` | Builds `P(X=x, Y=y)` scoreline matrix with optional Dixon-Coles tau | Old backend (1 import path edit, tau fixed M2) |
| `markets.py` | Derives 1X2, BTTS, O/U markets from scoreline matrix | Old backend (1 import path edit) |
| `trainer.py` | Dixon-Coles / Poisson MLE via `scipy.optimize` | Old backend (DB layer stripped, tau fixed M2) |
| `evaluator.py` | Chronological holdout split, Brier score, log-loss | New |
| `fetch_epl.py` | Downloads football-data.co.uk CSVs → `inputs/*.csv` | New (M3) |
| `train_league.py` | Pipeline: CSV → split → train → predict → JSON | New (M4, replaces train_epl.py) |
| `test_smoke.py` | Tau correctness + DC=Poisson reduction checks | New (M2) |
| `analyse_thresholds.py` | Pick-zone hit rates, fair odds, Brier/log-loss per threshold | New (M5) |
| `run_league_scan.py` | Multi-league Poisson O2.5 discovery scan, writes `outputs/league_scan_summary.csv` | New (M6) |
