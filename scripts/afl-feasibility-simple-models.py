"""
afl-feasibility-simple-models.py
================================
GoalScout — AFL Line/Spread Feasibility Study
Step 3: Rolling form (Model 2) and linear regression (Model 3) sweep on dev folds.

Purpose
-------
Complete the study plan's three-baseline test. Model 1 (Elo) failed dev MAE.
Models 2 and 3 are run here to confirm or refute the negative result.

If Models 2 and 3 also fail, the low-cost AFL line thesis is falsified and
the AFL track is closed (per study plan section 9).

Inputs
------
data/processed/afl-matches.parquet

Allowed feature inputs ONLY:
  date, season, home_team, away_team, venue, margin,
  market_predicted_margin (evaluation only — never a feature),
  home_covered, is_finals

Closing-line and odds columns are explicitly forbidden as features.

Outputs (aggregate only — safe to commit)
------------------------------------------
data/processed/afl-simple-models-results.csv
data/processed/afl-simple-models-best.csv

Usage
-----
python scripts/afl-feasibility-simple-models.py
python scripts/afl-feasibility-simple-models.py --top-n 15
"""

import argparse
import itertools
import sys
import time
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd


# ---------------------------------------------------------------------------
# Study-phase constants
# ---------------------------------------------------------------------------

DEV_SEASONS = set(range(2014, 2020))                  # 2014-2019 inclusive
SENSITIVITY_SEASONS = {2021}                           # deferred
VALIDATION_SEASONS = {2022, 2023, 2024}                # deferred
HELD_OUT_SEASONS = {2025}                              # never evaluated

# Rolling dev folds: (train_seasons, eval_season).
# 2013 is included in the train data so teams have history before fold predictions.
DEV_FOLDS: List[Tuple[set, int]] = [
    ({2013, 2014, 2015, 2016, 2017}, 2018),
    ({2013, 2014, 2015, 2016, 2017, 2018}, 2019),
]

# Hard-coded "must not be in eval" seasons. Belt-and-suspenders for the guard.
FORBIDDEN_EVAL_SEASONS = VALIDATION_SEASONS | HELD_OUT_SEASONS

# Pick selection threshold (points) for dev reporting only.
# Final threshold is selected after validation and locked in pre-registration.
PICK_THRESHOLD = 2.0

# Default top-N for best-params CSV
DEFAULT_TOP_N = 10

# Allowed input columns (whitelist). Anything else is rejected from features.
ALLOWED_INPUT_COLUMNS = {
    "date", "season", "home_team", "away_team", "venue",
    "margin", "market_predicted_margin", "home_covered", "is_finals",
}

# Forbidden input columns (closing-line / odds — must never reach feature code)
FORBIDDEN_FEATURE_COLUMNS = {
    "home_odds_close", "away_odds_close",
    "home_line_close", "away_line_close",
    "home_line_odds_close", "away_line_odds_close",
}


# ---------------------------------------------------------------------------
# Hyperparameter grids
# ---------------------------------------------------------------------------

# Rolling-form (Model 2) grid
MODEL2_GRID = {
    "window": [3, 5, 8, 10],
    "opponent_adjust": [False, True],
    "home_advantage": [5, 7, 9],
}

# Linear regression (Model 3) grid — feature config only, coefs are fitted
MODEL3_GRID = {
    "window": [3, 5, 8, 10],
    "opponent_adjust": [False, True],
}

# Minimum prior matches required for a team's form to be valid.
# Below this, the match is skipped from evaluation.
MIN_HISTORY = 2

# Default days-rest fallback for first match of a team's history (or first of season)
DEFAULT_DAYS_REST = 7


# ---------------------------------------------------------------------------
# Feature computation (single sequential pass, leakage-safe)
# ---------------------------------------------------------------------------

def _form_from_history(history: List[dict], window: int, opponent_adjust: bool) -> Optional[float]:
    """
    Compute rolling form from a team's past matches.
    history: list of dicts {date, margin, opp_form_at_match}, sorted by date asc
    Returns None if fewer than MIN_HISTORY matches available.

    For opponent_adjust=True, each historical margin is adjusted by subtracting
    the opponent's form AT THE TIME of that match (already computed and stored,
    so no recursion).
    """
    if len(history) < MIN_HISTORY:
        return None

    recent = history[-window:]
    if opponent_adjust:
        # Filter to entries where opp_form_at_match was available
        # (early-season entries may have None)
        usable = [h for h in recent if h["opp_form_at_match"] is not None]
        if len(usable) < MIN_HISTORY:
            # Fall back to raw form on the same recent window
            return float(np.mean([h["margin"] for h in recent]))
        return float(np.mean([h["margin"] - h["opp_form_at_match"] for h in usable]))
    else:
        return float(np.mean([h["margin"] for h in recent]))


def compute_features_pass(
    df: pd.DataFrame, window: int, opponent_adjust: bool
) -> pd.DataFrame:
    """
    Single sequential pass through all matches in date order.

    For each match, computes features using ONLY data from prior matches.
    Then records this match's actuals in both teams' histories.

    Returns a new DataFrame with feature columns added.
    Matches where either team has insufficient history get NaN features.

    No lookahead. No closing-line or odds inputs anywhere in this function.
    """
    df = df.sort_values(["date", "home_team"]).reset_index(drop=True)

    team_history: Dict[str, List[dict]] = {}
    last_match_date: Dict[str, pd.Timestamp] = {}

    feature_rows = []

    for _, row in df.iterrows():
        date = row["date"]
        home = row["home_team"]
        away = row["away_team"]
        margin = float(row["margin"])

        home_hist = team_history.get(home, [])
        away_hist = team_history.get(away, [])

        # Compute features BEFORE updating histories — no lookahead
        home_form = _form_from_history(home_hist, window, opponent_adjust)
        away_form = _form_from_history(away_hist, window, opponent_adjust)
        form_diff = (home_form - away_form) if (home_form is not None and away_form is not None) else np.nan

        # Days rest (using last match date for each team)
        home_rest = (date - last_match_date[home]).days if home in last_match_date else DEFAULT_DAYS_REST
        away_rest = (date - last_match_date[away]).days if away in last_match_date else DEFAULT_DAYS_REST
        rest_diff = home_rest - away_rest

        feature_rows.append({
            "date": date,
            "season": int(row["season"]),
            "home_team": home,
            "away_team": away,
            "is_finals": bool(row["is_finals"]),
            "margin": margin,
            "market_predicted_margin": float(row["market_predicted_margin"]),
            "home_covered": row["home_covered"],
            "home_form": home_form,
            "away_form": away_form,
            "form_diff": form_diff,
            "rest_diff": rest_diff,
        })

        # Update histories AFTER recording prediction features
        # Store opponent's form at the time of this match for future adjustment lookups
        team_history.setdefault(home, []).append({
            "date": date, "margin": margin, "opp_form_at_match": away_form,
        })
        team_history.setdefault(away, []).append({
            "date": date, "margin": -margin, "opp_form_at_match": home_form,
        })
        last_match_date[home] = date
        last_match_date[away] = date

    return pd.DataFrame(feature_rows)


# ---------------------------------------------------------------------------
# Model 2: Rolling form prediction
# ---------------------------------------------------------------------------

def predict_rolling_form(features: pd.DataFrame, home_advantage: float) -> pd.Series:
    """
    Model 2: predict margin = form_diff + home_advantage.
    Returns NaN where form_diff is NaN (insufficient history).
    No fitting required — this is a parameter-free (after sweep) heuristic.
    """
    return features["form_diff"] + home_advantage


# ---------------------------------------------------------------------------
# Model 3: Linear regression
# ---------------------------------------------------------------------------

def fit_linear_regression(
    train_features: pd.DataFrame
) -> Tuple[np.ndarray, List[str]]:
    """
    Fit OLS linear regression: margin ~ form_diff + rest_diff + intercept.
    Uses numpy.linalg.lstsq. Returns (coefficients, feature_names).
    """
    feature_names = ["intercept", "form_diff", "rest_diff"]
    df = train_features.dropna(subset=["form_diff"])

    X = np.column_stack([
        np.ones(len(df)),
        df["form_diff"].to_numpy(dtype=float),
        df["rest_diff"].to_numpy(dtype=float),
    ])
    y = df["margin"].to_numpy(dtype=float)

    coef, _, _, _ = np.linalg.lstsq(X, y, rcond=None)
    return coef, feature_names


def predict_linear_regression(
    features: pd.DataFrame, coef: np.ndarray
) -> pd.Series:
    """Apply fitted linear coefficients. Returns NaN where features are NaN."""
    intercept, b_form, b_rest = coef
    pred = intercept + b_form * features["form_diff"] + b_rest * features["rest_diff"]
    return pred


# ---------------------------------------------------------------------------
# Evaluation
# ---------------------------------------------------------------------------

def evaluate_predictions(
    eval_df: pd.DataFrame,
    predicted_margin: pd.Series,
    pick_threshold: float,
) -> dict:
    """
    Aggregate metrics for one fold's predictions.
    Drops matches where prediction is NaN (insufficient history).
    Returns scalar dict only — no per-match data leaks out.
    """
    df = eval_df.copy()
    df["predicted_margin"] = predicted_margin

    n_total = len(df)
    df = df.dropna(subset=["predicted_margin"])
    n_skipped = n_total - len(df)

    if len(df) == 0:
        return {"n_matches": 0, "n_skipped_no_history": n_skipped, "model_mae_all": None}

    # MAE — all matches
    mae_model_all = (df["predicted_margin"] - df["margin"]).abs().mean()
    mae_market_all = (df["market_predicted_margin"] - df["margin"]).abs().mean()

    # H&A only (exclude finals)
    ha = df[~df["is_finals"]]
    mae_model_ha = (ha["predicted_margin"] - ha["margin"]).abs().mean() if len(ha) else np.nan
    mae_market_ha = (ha["market_predicted_margin"] - ha["margin"]).abs().mean() if len(ha) else np.nan

    # Pick selection
    df = df.copy()
    df["line_diff"] = df["predicted_margin"] - df["market_predicted_margin"]
    df["picked"] = df["line_diff"].abs() >= pick_threshold
    picks = df[df["picked"] & df["home_covered"].notna()].copy()
    n_picks = len(picks)

    cover_rate = None
    if n_picks > 0:
        home_picks = picks[picks["line_diff"] > 0]
        away_picks = picks[picks["line_diff"] < 0]
        home_wins = int(home_picks["home_covered"].sum())
        away_wins = int((1 - away_picks["home_covered"]).sum())
        cover_rate = (home_wins + away_wins) / n_picks

    # Prediction distribution diagnostics
    pred = df["predicted_margin"]
    pred_mean = float(pred.mean())
    pred_std = float(pred.std())
    pred_mean_abs = float(pred.abs().mean())
    pred_p10 = float(pred.quantile(0.10))
    pred_p50 = float(pred.quantile(0.50))
    pred_p90 = float(pred.quantile(0.90))

    return {
        "n_matches": len(df),
        "n_ha_matches": len(ha),
        "n_finals_excluded": len(df) - len(ha),
        "n_skipped_no_history": n_skipped,
        "model_mae_all": round(mae_model_all, 4),
        "market_mae_all": round(mae_market_all, 4),
        "mae_improvement_all": round(mae_market_all - mae_model_all, 4),
        "model_mae_ha": round(mae_model_ha, 4) if not np.isnan(mae_model_ha) else None,
        "market_mae_ha": round(mae_market_ha, 4) if not np.isnan(mae_market_ha) else None,
        "mae_improvement_ha": round(mae_market_ha - mae_model_ha, 4) if not np.isnan(mae_model_ha) else None,
        "n_picks": n_picks,
        "cover_rate": round(cover_rate, 4) if cover_rate is not None else None,
        "pred_mean": round(pred_mean, 4),
        "pred_std": round(pred_std, 4),
        "pred_mean_abs": round(pred_mean_abs, 4),
        "pred_p10": round(pred_p10, 4),
        "pred_p50": round(pred_p50, 4),
        "pred_p90": round(pred_p90, 4),
    }


# ---------------------------------------------------------------------------
# Sweep runner
# ---------------------------------------------------------------------------

def _check_eval_safety(eval_season: int) -> None:
    """Hard guard: eval season must not be in validation or held-out sets."""
    if eval_season in FORBIDDEN_EVAL_SEASONS:
        raise ValueError(
            f"SAFETY VIOLATION: eval_season {eval_season} is in forbidden set "
            f"{sorted(FORBIDDEN_EVAL_SEASONS)}. Aborting."
        )


def run_model2_sweep(df: pd.DataFrame, pick_threshold: float) -> List[dict]:
    """Sweep rolling-form (Model 2) parameters on each dev fold."""
    rows = []
    keys = list(MODEL2_GRID.keys())
    combos = [dict(zip(keys, c)) for c in itertools.product(*MODEL2_GRID.values())]

    print(f"\n  Model 2 (rolling form): {len(combos)} combos × {len(DEV_FOLDS)} folds")

    # Pre-compute features per (window, opponent_adjust) pair — saves work
    feature_cache: Dict[Tuple[int, bool], pd.DataFrame] = {}

    for combo_id, params in enumerate(combos):
        cache_key = (params["window"], params["opponent_adjust"])
        if cache_key not in feature_cache:
            feature_cache[cache_key] = compute_features_pass(
                df, window=params["window"], opponent_adjust=params["opponent_adjust"]
            )
        feats = feature_cache[cache_key]

        for train_seasons, eval_season in DEV_FOLDS:
            _check_eval_safety(eval_season)
            eval_feats = feats[feats["season"] == eval_season].copy()
            preds = predict_rolling_form(eval_feats, home_advantage=params["home_advantage"])
            metrics = evaluate_predictions(eval_feats, preds, pick_threshold)

            rows.append({
                "model_type": "rolling_form",
                "combo_id": f"M2-{combo_id}",
                "fold": f"eval_{eval_season}",
                "eval_season": eval_season,
                "window": params["window"],
                "opponent_adjust": params["opponent_adjust"],
                "home_advantage": params["home_advantage"],
                "include_rest": False,
                "coef_intercept": None,
                "coef_form_diff": None,
                "coef_rest_diff": None,
                **metrics,
            })

    return rows


def run_model3_sweep(df: pd.DataFrame, pick_threshold: float) -> List[dict]:
    """Sweep linear regression (Model 3) feature configs on each dev fold."""
    rows = []
    keys = list(MODEL3_GRID.keys())
    combos = [dict(zip(keys, c)) for c in itertools.product(*MODEL3_GRID.values())]

    print(f"\n  Model 3 (linear regression): {len(combos)} combos × {len(DEV_FOLDS)} folds")

    feature_cache: Dict[Tuple[int, bool], pd.DataFrame] = {}

    for combo_id, params in enumerate(combos):
        cache_key = (params["window"], params["opponent_adjust"])
        if cache_key not in feature_cache:
            feature_cache[cache_key] = compute_features_pass(
                df, window=params["window"], opponent_adjust=params["opponent_adjust"]
            )
        feats = feature_cache[cache_key]

        for train_seasons, eval_season in DEV_FOLDS:
            _check_eval_safety(eval_season)

            train_feats = feats[feats["season"].isin(train_seasons)].copy()
            eval_feats = feats[feats["season"] == eval_season].copy()

            coef, _ = fit_linear_regression(train_feats)
            preds = predict_linear_regression(eval_feats, coef)
            metrics = evaluate_predictions(eval_feats, preds, pick_threshold)

            rows.append({
                "model_type": "linear_regression",
                "combo_id": f"M3-{combo_id}",
                "fold": f"eval_{eval_season}",
                "eval_season": eval_season,
                "window": params["window"],
                "opponent_adjust": params["opponent_adjust"],
                "home_advantage": None,
                "include_rest": True,
                "coef_intercept": round(float(coef[0]), 4),
                "coef_form_diff": round(float(coef[1]), 4),
                "coef_rest_diff": round(float(coef[2]), 4),
                **metrics,
            })

    return rows


# ---------------------------------------------------------------------------
# Best-params aggregation
# ---------------------------------------------------------------------------

def build_best(results: pd.DataFrame, top_n: int) -> pd.DataFrame:
    """Aggregate across folds (mean) per combo, rank by mean H&A MAE improvement."""
    metric_cols = [
        "model_mae_all", "market_mae_all", "mae_improvement_all",
        "model_mae_ha", "market_mae_ha", "mae_improvement_ha",
        "n_picks", "cover_rate",
        "pred_mean", "pred_std", "pred_mean_abs",
        "pred_p10", "pred_p50", "pred_p90",
    ]
    coef_cols = ["coef_intercept", "coef_form_diff", "coef_rest_diff"]
    param_cols = ["model_type", "window", "opponent_adjust", "home_advantage", "include_rest"]

    agg_dict = {c: "mean" for c in metric_cols + coef_cols}

    agg = (
        results.groupby(["combo_id"] + param_cols, dropna=False)
        .agg(agg_dict)
        .reset_index()
        .rename(columns={c: f"mean_{c}" for c in metric_cols + coef_cols})
    )

    return (
        agg.sort_values("mean_mae_improvement_ha", ascending=False)
           .head(top_n)
           .reset_index(drop=True)
    )


# ---------------------------------------------------------------------------
# Output writing
# ---------------------------------------------------------------------------

def write_outputs(results: pd.DataFrame, best: pd.DataFrame) -> dict:
    out_dir = Path("data/processed")
    out_dir.mkdir(parents=True, exist_ok=True)

    sweep_path = out_dir / "afl-simple-models-results.csv"
    best_path = out_dir / "afl-simple-models-best.csv"

    results.to_csv(sweep_path, index=False)
    best.to_csv(best_path, index=False)

    print(f"\n  Written: {sweep_path}  ({sweep_path.stat().st_size} bytes)  [committed]")
    print(f"  Written: {best_path}  ({best_path.stat().st_size} bytes)  [committed]")

    return {"sweep": sweep_path, "best": best_path}


# ---------------------------------------------------------------------------
# Leaderboard
# ---------------------------------------------------------------------------

def print_leaderboard(best: pd.DataFrame) -> None:
    print("\n" + "=" * 80)
    print("TOP COMBOS — ranked by mean MAE improvement (H&A matches, both folds)")
    print("Positive MAE improvement = model MAE < market MAE = model is better")
    print("=" * 80)

    cols = [
        "model_type", "window", "opponent_adjust", "home_advantage",
        "mean_model_mae_ha", "mean_market_mae_ha", "mean_mae_improvement_ha",
        "mean_n_picks", "mean_cover_rate",
    ]
    rename = {
        "model_type": "model",
        "opponent_adjust": "opp_adj",
        "home_advantage": "home_adv",
        "mean_model_mae_ha": "model_MAE",
        "mean_market_mae_ha": "mkt_MAE",
        "mean_mae_improvement_ha": "MAE_impr",
        "mean_n_picks": "n_picks",
        "mean_cover_rate": "cover",
    }

    disp = best[cols].rename(columns=rename)
    disp.index = range(1, len(disp) + 1)

    for c in ["model_MAE", "mkt_MAE", "MAE_impr", "n_picks", "cover"]:
        if c in disp.columns:
            disp[c] = disp[c].round(4)

    print(disp.to_string())
    print()

    # Headline
    if len(best) > 0:
        top = best.iloc[0]
        improvement = top.get("mean_mae_improvement_ha")
        if improvement is not None and improvement > 0:
            print(f"  Best combo improves on market MAE by {improvement:.4f} points.")
        else:
            print(f"  Best combo does NOT improve on market MAE ({improvement:.4f}).")
            print(f"  Combined with Model 1 (Elo) failure, the low-cost AFL line thesis is falsified.")

    print("\n--- Reminder ---")
    print("  Validation (2022-2024) and test (2025) are not run yet.")
    print("  Do not interpret these dev results as evidence of real edge.")


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------

def load_data(parquet_path: Path) -> pd.DataFrame:
    print(f"\n--- Loading {parquet_path} ---")
    df = pd.read_parquet(parquet_path)
    print(f"  Shape: {df.shape}")

    if 2020 in df["season"].values:
        sys.exit("ERROR: 2020 found in parquet. Loader should have excluded it.")

    seasons_present = set(df["season"].astype(int).unique())
    print(f"  Seasons present: {sorted(seasons_present)}")

    if HELD_OUT_SEASONS & seasons_present:
        df = df[~df["season"].isin(HELD_OUT_SEASONS)].copy()
        print(f"  Removed held-out 2025: {len(df)} rows remaining")

    needed = ALLOWED_INPUT_COLUMNS
    missing = needed - set(df.columns)
    if missing:
        sys.exit(f"ERROR: Required columns missing: {missing}")

    forbidden_present = FORBIDDEN_FEATURE_COLUMNS & set(df.columns)
    if forbidden_present:
        print(
            f"  NOTE: Forbidden feature columns present in parquet ({sorted(forbidden_present)})\n"
            f"        These are NOT used as features. Dropping from working frame for safety."
        )
        df = df.drop(columns=list(forbidden_present))

    df["season"] = df["season"].astype(int)
    df["date"] = pd.to_datetime(df["date"])
    df = df.sort_values(["date", "home_team"]).reset_index(drop=True)

    # Confirm only allowed columns remain
    extra = set(df.columns) - ALLOWED_INPUT_COLUMNS
    if extra:
        print(f"  NOTE: Extra columns also present (will not be used as features): {sorted(extra)}")

    print(f"  Ready: {len(df)} rows across seasons {sorted(df['season'].unique())}")
    return df


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="AFL Feasibility — Models 2 (rolling form) + 3 (linear regression) sweep"
    )
    parser.add_argument(
        "--parquet",
        default="data/processed/afl-matches.parquet",
        help="Path to cleaned parquet",
    )
    parser.add_argument(
        "--top-n",
        type=int,
        default=DEFAULT_TOP_N,
        help=f"Number of top combos in best CSV (default {DEFAULT_TOP_N})",
    )
    parser.add_argument(
        "--pick-threshold",
        type=float,
        default=PICK_THRESHOLD,
        help=f"Line-diff threshold for picks in points (default {PICK_THRESHOLD})",
    )
    args = parser.parse_args()

    print("=" * 60)
    print("AFL Feasibility Study — Step 3: Simple Models Sweep")
    print("=" * 60)
    print(f"  Dev folds: {[(f'train {sorted(tr)}, eval {ev}') for tr, ev in DEV_FOLDS]}")
    print(f"  Held-out (never evaluated): {sorted(HELD_OUT_SEASONS)}")
    print(f"  Validation (deferred): {sorted(VALIDATION_SEASONS)}")
    print(f"  Sensitivity (deferred): {sorted(SENSITIVITY_SEASONS)}")
    print(f"  Pick threshold (dev only): {args.pick_threshold} points")

    df = load_data(Path(args.parquet))

    start = time.time()
    rows = []
    rows.extend(run_model2_sweep(df, args.pick_threshold))
    rows.extend(run_model3_sweep(df, args.pick_threshold))
    print(f"\n  Sweep complete in {time.time() - start:.1f}s ({len(rows)} result rows)")

    results = pd.DataFrame(rows)
    best = build_best(results, args.top_n)
    write_outputs(results, best)
    print_leaderboard(best)

    print("=" * 60)
    print("DONE")
    print(f"  Sweep results: data/processed/afl-simple-models-results.csv")
    print(f"  Best params:   data/processed/afl-simple-models-best.csv")
    print()
    print("DECISION GATE:")
    print("  If best mean_mae_improvement_ha > 0:")
    print("    → continue to validation (separate script, not this one)")
    print("  If best mean_mae_improvement_ha <= 0:")
    print("    → low-cost AFL line thesis is falsified.")
    print("    → write reports/afl-feasibility-results.md as a negative finding.")
    print("    → close AFL track. Do not propose threshold tuning or complex features.")
    print("=" * 60)


if __name__ == "__main__":
    main()
