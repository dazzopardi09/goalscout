"""
afl-feasibility-elo.py
======================
GoalScout — AFL Line/Spread Feasibility Study
Step 2: Elo hyperparameter sweep on development seasons.

Overview
--------
Runs a grid search over Elo hyperparameters on two rolling dev folds:
  Fold 1: burn 2013, train 2014-2017, evaluate 2018
  Fold 2: burn 2013, train 2014-2018, evaluate 2019

The closing line (market_predicted_margin) is used ONLY as a comparison
benchmark in evaluation. It is never a model input or feature.

2025 is never loaded or evaluated. 2020 is excluded by the loader.
2021 sensitivity analysis is deferred to the validation script.

Inputs
------
data/processed/afl-matches.parquet  (written by afl-feasibility-load.py)

Outputs (aggregate only — safe to commit)
------------------------------------------
data/processed/afl-elo-sweep-results.csv
    One row per (param_combo × fold). No per-match odds or predictions.

data/processed/afl-elo-best-params.csv
    Top-N combos ranked by mean MAE improvement across both folds.

Usage
-----
python scripts/afl-feasibility-elo.py
python scripts/afl-feasibility-elo.py --parquet path/to/afl-matches.parquet
python scripts/afl-feasibility-elo.py --top-n 20
"""

import argparse
import itertools
import math
import sys
import time
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import pandas as pd


# ---------------------------------------------------------------------------
# Study-phase constants
# These mirror the study plan. Do not modify without updating the plan.
# ---------------------------------------------------------------------------

BURN_IN_SEASONS = {2013}
DEV_SEASONS = set(range(2014, 2020))          # 2014-2019 inclusive
SENSITIVITY_SEASONS = {2021}                   # deferred to validation script
VALIDATION_SEASONS = {2022, 2023, 2024}        # deferred to validation script
HELD_OUT_SEASONS = {2025}                      # never touched in this script
EXCLUDED_SEASONS = {2009, 2010, 2011, 2012, 2020, 2026}

# Rolling dev folds: (burn_seasons, train_seasons, eval_season)
DEV_FOLDS: List[Tuple[set, set, int]] = [
    (BURN_IN_SEASONS, {2014, 2015, 2016, 2017}, 2018),
    (BURN_IN_SEASONS, {2014, 2015, 2016, 2017, 2018}, 2019),
]

# Pick selection threshold (points) for dev reporting only.
# Final threshold is selected after validation and locked in pre-registration.
PICK_THRESHOLD = 2.0

# Elo initialisation rating for all teams.
ELO_INITIAL = 1500.0

# Elo denominator (standard chess-style; affects scale interpretation).
ELO_SIGMA = 400.0

# Top-N best param combos to write to afl-elo-best-params.csv
DEFAULT_TOP_N = 10


# ---------------------------------------------------------------------------
# Hyperparameter grid
# ---------------------------------------------------------------------------

PARAM_GRID = {
    # K: Elo update rate. Higher = faster adaptation, more noise.
    "K": [25, 40, 55],

    # home_advantage: points added to predicted margin for home team.
    "home_advantage": [5, 7, 9, 11],

    # scale: Elo-point-to-margin conversion.
    # scale=0.05 means a 100-Elo-point advantage → 5-point margin prediction.
    "scale": [0.04, 0.05, 0.06],

    # inter_season_regression: fraction pulled toward ELO_INITIAL each off-season.
    # 0.2 means: new_r = r + 0.2 * (1500 - r)  →  new_r = 0.8*r + 300
    "inter_season_regression": [0.1, 0.2, 0.3],

    # margin_adj: how to dampen large margins in the Elo update.
    # 'none'  = no dampening (blowouts have full effect)
    # 'sqrt'  = square-root dampening (moderate)
    # 'log'   = log dampening (aggressive — blowouts count less)
    "margin_adj": ["none", "sqrt", "log"],
}


# ---------------------------------------------------------------------------
# Elo model
# ---------------------------------------------------------------------------

def _mov_factor(actual_margin: float, margin_adj: str) -> float:
    """
    Margin-of-victory dampening factor.
    Normalised so that a typical 20-point margin produces factor ≈ 1.0.
    This keeps K directly interpretable across adjustment types.
    """
    abs_m = abs(actual_margin)
    if margin_adj == "none":
        return 1.0
    elif margin_adj == "sqrt":
        return math.sqrt(abs_m) / math.sqrt(20.0)   # sqrt(20)≈4.47
    elif margin_adj == "log":
        return math.log1p(abs_m) / math.log1p(20.0) # log(21)≈3.04
    else:
        raise ValueError(f"Unknown margin_adj: {margin_adj!r}")


def _win_prob(home_rating: float, away_rating: float) -> float:
    """Standard Elo win probability for home team."""
    return 1.0 / (1.0 + 10.0 ** (-(home_rating - away_rating) / ELO_SIGMA))


def predict_margin(home_rating: float, away_rating: float,
                   home_advantage: float, scale: float) -> float:
    """Predict home-team margin from current Elo ratings."""
    return scale * (home_rating - away_rating) + home_advantage


def update_ratings(
    ratings: Dict[str, float],
    home: str,
    away: str,
    actual_margin: float,
    K: float,
    home_advantage: float,
    scale: float,
    margin_adj: str,
) -> None:
    """
    Update Elo ratings in-place after a match.

    Home advantage is expressed in Elo units (home_advantage / scale) and
    added to the home rating when computing win probability. This makes the
    update internally consistent with predict_margin, which also includes
    home_advantage. Without this adjustment, equal-rated teams are treated
    as 50/50 in the update even though the prediction gives home a positive
    margin — a systematic inconsistency.

    This mirrors the FiveThirtyEight approach for NFL Elo: HFA is applied
    to the effective rating difference in the win-probability calculation,
    not to the ratings themselves.

    The closing line is NOT used here. Update depends only on:
      - actual_margin (home score - away score)
      - current ratings of the two teams
      - home_advantage and scale (for win-probability consistency)
    """
    home_r = ratings.get(home, ELO_INITIAL)
    away_r = ratings.get(away, ELO_INITIAL)

    # Win outcome: 1=home win, 0=away win, 0.5=draw
    actual_outcome = 1.0 if actual_margin > 0 else (0.0 if actual_margin < 0 else 0.5)

    # Convert home_advantage from points to Elo units, then apply to win probability.
    # This makes wp consistent with predict_margin, which includes home_advantage.
    # e.g. home_advantage=7, scale=0.05 → home_adv_elo=140 Elo points.
    home_adv_elo = home_advantage / scale
    wp = _win_prob(home_r + home_adv_elo, away_r)

    # Elo update (bounded in ±K before MOV scaling)
    raw_delta = K * (actual_outcome - wp)

    # MOV dampening: larger margins → larger update, but log/sqrt dampened
    mov = _mov_factor(actual_margin, margin_adj)
    # Floor at 0.1 to avoid near-zero updates on very close games with log adj
    mov = max(mov, 0.1)

    delta = raw_delta * mov

    ratings[home] = home_r + delta
    ratings[away] = away_r - delta


def apply_inter_season_regression(
    ratings: Dict[str, float],
    regression: float,
) -> None:
    """Pull all ratings toward ELO_INITIAL by the regression fraction."""
    for team in ratings:
        ratings[team] += regression * (ELO_INITIAL - ratings[team])


# ---------------------------------------------------------------------------
# Fold runner
# ---------------------------------------------------------------------------

def run_elo_fold(
    df: pd.DataFrame,
    burn_seasons: set,
    train_seasons: set,
    eval_season: int,
    params: dict,
) -> pd.DataFrame:
    """
    Run Elo sequentially through burn + train + eval seasons.
    Returns a DataFrame of per-match predictions for eval_season only.
    The eval_season rows contain NO odds columns — only predicted and actual margins.

    Prediction happens BEFORE the match updates ratings (no lookahead).
    Ratings ARE updated after eval-season matches (keeps sequence valid).
    """
    all_seasons = burn_seasons | train_seasons | {eval_season}

    # Hard guard: 2025 must never appear in any fold.
    overlap_held_out = all_seasons & HELD_OUT_SEASONS
    if overlap_held_out:
        raise ValueError(
            f"SAFETY VIOLATION: held-out seasons {overlap_held_out} "
            f"included in fold evaluation. Aborting."
        )

    subset = (
        df[df["season"].isin(all_seasons)]
        .sort_values(["date", "home_team"])
        .reset_index(drop=True)
    )

    ratings: Dict[str, float] = {}
    current_season: Optional[int] = None
    eval_records = []

    for _, row in subset.iterrows():
        season = int(row["season"])

        # Apply inter-season regression at each season boundary (after burn-in)
        if season != current_season:
            if current_season is not None:
                apply_inter_season_regression(ratings, params["inter_season_regression"])
            current_season = season

        home = row["home_team"]
        away = row["away_team"]
        actual_margin = float(row["margin"])

        # Predict BEFORE updating — no lookahead
        home_r = ratings.get(home, ELO_INITIAL)
        away_r = ratings.get(away, ELO_INITIAL)
        pred = predict_margin(home_r, away_r, params["home_advantage"], params["scale"])

        # Record eval-season predictions (no odds columns — aggregate-safe)
        if season == eval_season:
            eval_records.append({
                "season": season,
                "is_finals": bool(row["is_finals"]),
                "predicted_margin": pred,
                "actual_margin": actual_margin,
                "market_predicted_margin": float(row["market_predicted_margin"]),
                "home_covered": row["home_covered"],   # 1/0/None; None = push
            })

        # Update ratings (always — including during eval season)
        update_ratings(ratings, home, away, actual_margin,
                       params["K"], params["home_advantage"], params["scale"],
                       params["margin_adj"])

    return pd.DataFrame(eval_records)


# ---------------------------------------------------------------------------
# Evaluation
# ---------------------------------------------------------------------------

def evaluate_fold(preds: pd.DataFrame, pick_threshold: float) -> dict:
    """
    Compute aggregate metrics for one fold's predictions.
    Returns a dict of scalar metrics. No per-match odds in output.

    Includes both all-matches and home-and-away-only (excl. finals) metrics.
    """
    # All matches
    mae_model_all = (preds["predicted_margin"] - preds["actual_margin"]).abs().mean()
    mae_market_all = (preds["market_predicted_margin"] - preds["actual_margin"]).abs().mean()

    # Home-and-away only (exclude finals — smaller sample, different dynamics)
    ha = preds[~preds["is_finals"]]
    mae_model_ha = (ha["predicted_margin"] - ha["actual_margin"]).abs().mean()
    mae_market_ha = (ha["market_predicted_margin"] - ha["actual_margin"]).abs().mean()

    # Pick selection: |model line - market line| >= threshold
    preds = preds.copy()
    preds["line_diff"] = preds["predicted_margin"] - preds["market_predicted_margin"]
    preds["picked"] = preds["line_diff"].abs() >= pick_threshold

    # Only picks where home_covered is not null (no pushes)
    picks = preds[preds["picked"] & preds["home_covered"].notna()].copy()
    n_picks = len(picks)

    cover_rate = None
    if n_picks > 0:
        # Home pick: model thinks home is better than market → back home
        home_picks = picks[picks["line_diff"] > 0]
        # Away pick: model thinks away is better than market → back away
        away_picks = picks[picks["line_diff"] < 0]

        home_wins = int(home_picks["home_covered"].sum())
        away_wins = int((1 - away_picks["home_covered"]).sum())
        cover_rate = (home_wins + away_wins) / n_picks

    return {
        "n_matches": len(preds),
        "n_ha_matches": len(ha),
        "n_finals_excluded": len(preds) - len(ha),
        # All-match metrics
        "model_mae_all": round(mae_model_all, 4),
        "market_mae_all": round(mae_market_all, 4),
        "mae_improvement_all": round(mae_market_all - mae_model_all, 4),
        # Home-and-away metrics (primary for study — finals excluded)
        "model_mae_ha": round(mae_model_ha, 4),
        "market_mae_ha": round(mae_market_ha, 4),
        "mae_improvement_ha": round(mae_market_ha - mae_model_ha, 4),
        # Pick metrics
        "n_picks": n_picks,
        "cover_rate": round(cover_rate, 4) if cover_rate is not None else None,
    }


# ---------------------------------------------------------------------------
# Sweep runner
# ---------------------------------------------------------------------------

def build_param_combos() -> List[dict]:
    keys = list(PARAM_GRID.keys())
    values = list(PARAM_GRID.values())
    return [dict(zip(keys, combo)) for combo in itertools.product(*values)]


def run_sweep(df: pd.DataFrame, pick_threshold: float) -> pd.DataFrame:
    """
    Run every param combo × every dev fold. Returns aggregate-only results.
    """
    combos = build_param_combos()
    n_combos = len(combos)
    n_folds = len(DEV_FOLDS)
    total = n_combos * n_folds

    print(f"\n  Grid: {n_combos} combos × {n_folds} folds = {total} evaluations")
    print(f"  Pick threshold: {pick_threshold} points\n")

    rows = []
    start = time.time()

    for i, params in enumerate(combos):
        for fold_idx, (burn, train, eval_s) in enumerate(DEV_FOLDS):
            preds = run_elo_fold(df, burn, train, eval_s, params)
            metrics = evaluate_fold(preds, pick_threshold)

            row = {
                "combo_id": i,
                "fold": f"eval_{eval_s}",
                "eval_season": eval_s,
                **params,
                **metrics,
            }
            rows.append(row)

        # Progress every 10%
        if (i + 1) % max(1, n_combos // 10) == 0:
            elapsed = time.time() - start
            pct = (i + 1) / n_combos * 100
            print(f"  {pct:5.1f}%  ({i+1}/{n_combos} combos)  {elapsed:.1f}s elapsed")

    print(f"\n  Sweep complete in {time.time() - start:.1f}s")
    return pd.DataFrame(rows)


# ---------------------------------------------------------------------------
# Best-params aggregation
# ---------------------------------------------------------------------------

def build_best_params(results: pd.DataFrame, top_n: int) -> pd.DataFrame:
    """
    Aggregate across folds (mean) and rank by mae_improvement_ha.
    Returns top_n rows.
    """
    param_cols = list(PARAM_GRID.keys())
    metric_cols = [
        "model_mae_all", "market_mae_all", "mae_improvement_all",
        "model_mae_ha", "market_mae_ha", "mae_improvement_ha",
        "n_picks", "cover_rate",
    ]

    agg = (
        results.groupby(["combo_id"] + param_cols)[metric_cols]
        .mean()
        .reset_index()
        .rename(columns={c: f"mean_{c}" for c in metric_cols})
    )

    agg = agg.sort_values("mean_mae_improvement_ha", ascending=False)
    return agg.head(top_n).reset_index(drop=True)


# ---------------------------------------------------------------------------
# Output writing
# ---------------------------------------------------------------------------

def write_outputs(results: pd.DataFrame, best: pd.DataFrame) -> dict:
    out_dir = Path("data/processed")
    out_dir.mkdir(parents=True, exist_ok=True)

    sweep_path = out_dir / "afl-elo-sweep-results.csv"
    best_path = out_dir / "afl-elo-best-params.csv"

    results.to_csv(sweep_path, index=False)
    best.to_csv(best_path, index=False)

    print(f"\n  Written: {sweep_path}  ({sweep_path.stat().st_size} bytes)  [committed]")
    print(f"  Written: {best_path}  ({best_path.stat().st_size} bytes)  [committed]")

    return {"sweep": sweep_path, "best": best_path}


# ---------------------------------------------------------------------------
# Leaderboard printing
# ---------------------------------------------------------------------------

def print_leaderboard(best: pd.DataFrame) -> None:
    print("\n" + "=" * 72)
    print("TOP COMBOS — ranked by mean MAE improvement (H&A matches, both folds)")
    print("Positive MAE improvement = model MAE < market MAE = model is better")
    print("=" * 72)

    display_cols = [
        "K", "home_advantage", "scale", "inter_season_regression", "margin_adj",
        "mean_model_mae_ha", "mean_market_mae_ha", "mean_mae_improvement_ha",
        "mean_n_picks", "mean_cover_rate",
    ]
    display_cols = [c for c in display_cols if c in best.columns]

    # Rename for compact display
    rename = {
        "K": "K",
        "home_advantage": "home_adv",
        "scale": "scale",
        "inter_season_regression": "regr",
        "margin_adj": "adj",
        "mean_model_mae_ha": "model_MAE",
        "mean_market_mae_ha": "mkt_MAE",
        "mean_mae_improvement_ha": "MAE_impr",
        "mean_n_picks": "n_picks",
        "mean_cover_rate": "cover",
    }

    disp = best[display_cols].rename(columns=rename)
    disp.index = range(1, len(disp) + 1)  # 1-indexed rank

    # Round floats
    for col in ["model_MAE", "mkt_MAE", "MAE_impr", "n_picks", "cover"]:
        if col in disp.columns:
            disp[col] = disp[col].round(4)

    print(disp.to_string())
    print()

    # Sanity notes
    top = best.iloc[0]
    market_mae = top.get("mean_market_mae_ha", None)
    model_mae = top.get("mean_model_mae_ha", None)
    improvement = top.get("mean_mae_improvement_ha", None)

    print("--- Notes ---")
    if improvement is not None:
        if improvement > 0:
            print(f"  Best combo improves on market MAE by {improvement:.4f} points (H&A matches).")
        else:
            print(f"  Best combo does NOT improve on market MAE ({improvement:.4f}). No model beats market.")
    if market_mae is not None and model_mae is not None:
        print(f"  Market MAE: {market_mae:.4f} pts  |  Best model MAE: {model_mae:.4f} pts")
    print(
        "  Reminder: validation (2022-2024) and test (2025) are not run yet.\n"
        "  Do not interpret these dev results as evidence of real edge."
    )


# ---------------------------------------------------------------------------
# Data loading and validation
# ---------------------------------------------------------------------------

def load_data(parquet_path: Path) -> pd.DataFrame:
    print(f"\n--- Loading {parquet_path} ---")
    df = pd.read_parquet(parquet_path)
    print(f"  Shape: {df.shape}")

    # Verify 2020 is absent (excluded by loader)
    if 2020 in df["season"].values:
        sys.exit("ERROR: 2020 found in parquet. Loader should have excluded it. Re-run loader.")

    # Verify 2025 is absent from parquet entirely, OR if present, guard here
    seasons_present = set(df["season"].astype(int).unique())
    print(f"  Seasons present: {sorted(seasons_present)}")

    if HELD_OUT_SEASONS & seasons_present:
        print(
            f"  WARNING: held-out season(s) {HELD_OUT_SEASONS & seasons_present} "
            f"found in parquet. They will be filtered out before any sweep."
        )
        df = df[~df["season"].isin(HELD_OUT_SEASONS)].copy()
        print(f"  After removing held-out: {len(df)} rows")

    # Required columns
    needed = {"date", "season", "home_team", "away_team", "margin",
               "market_predicted_margin", "home_covered", "is_finals"}
    missing = needed - set(df.columns)
    if missing:
        sys.exit(f"ERROR: Required columns missing from parquet: {missing}")

    # Confirm closing-line columns are present but will NOT be used as features
    # (they stay in the parquet but are explicitly excluded from model inputs below)
    odds_cols = {"home_line_close", "away_line_close",
                 "home_line_odds_close", "away_line_odds_close",
                 "home_odds_close", "away_odds_close"}
    present_odds = odds_cols & set(df.columns)
    if present_odds:
        print(
            f"  NOTE: Odds columns present in parquet ({sorted(present_odds)}) "
            f"but will NOT be used as model features."
        )

    df["season"] = df["season"].astype(int)
    df["date"] = pd.to_datetime(df["date"])
    df = df.sort_values(["date", "home_team"]).reset_index(drop=True)

    print(f"  Ready: {len(df)} rows across seasons {sorted(df['season'].unique())}")
    return df


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="AFL Feasibility — Elo hyperparameter sweep on dev seasons"
    )
    parser.add_argument(
        "--parquet",
        default="data/processed/afl-matches.parquet",
        help="Path to cleaned parquet (default: data/processed/afl-matches.parquet)",
    )
    parser.add_argument(
        "--top-n",
        type=int,
        default=DEFAULT_TOP_N,
        help=f"Number of top combos to write to best-params CSV (default: {DEFAULT_TOP_N})",
    )
    parser.add_argument(
        "--pick-threshold",
        type=float,
        default=PICK_THRESHOLD,
        help=f"Line-diff threshold for pick selection in points (default: {PICK_THRESHOLD})",
    )
    args = parser.parse_args()

    print("=" * 60)
    print("AFL Feasibility Study — Step 2: Elo Sweep")
    print("=" * 60)
    print(f"  Dev folds:  {[(f'train {sorted(tr)}, eval {ev}') for _, tr, ev in DEV_FOLDS]}")
    print(f"  Grid size:  {sum(len(v) for v in PARAM_GRID.values())} params "
          f"→ {len(build_param_combos())} combos")
    print(f"  Held-out:   {sorted(HELD_OUT_SEASONS)}  (never evaluated)")
    print(f"  2021:       sensitivity only — deferred to validation script")

    df = load_data(Path(args.parquet))
    results = run_sweep(df, args.pick_threshold)
    best = build_best_params(results, args.top_n)
    write_outputs(results, best)
    print_leaderboard(best)

    print("=" * 60)
    print("DONE")
    print(f"  Sweep results: data/processed/afl-elo-sweep-results.csv  [committed]")
    print(f"  Best params:   data/processed/afl-elo-best-params.csv    [committed]")
    print()
    print("NEXT STEPS:")
    print("  1. Review leaderboard. If MAE improvement > 0, continue.")
    print("  2. Do NOT run 2022-2024 validation until model selection is locked.")
    print("  3. Do NOT run 2025 until pre-registration is committed.")
    print("=" * 60)


if __name__ == "__main__":
    main()
