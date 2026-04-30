# research/modeling/train_epl.py
#
# Pipeline entry point.  Milestone 2 adds:
#   - --model poisson | dixon_coles  (default: dixon_coles)
#   - Degeneracy detection: DC with |rho| < RHO_DEGENERATE_THRESHOLD is
#     relabelled "dixon_coles_degenerate" so output JSON is never misleading.
#   - rho surfaced in metrics block for DC runs.
#   - requested_model and rho_degenerate_threshold in config block.
#   - Output filename is model-specific:
#       outputs/epl_dixon_coles.json
#       outputs/epl_poisson.json
#
# Usage:
#   python train_epl.py                      # Dixon-Coles (default)
#   python train_epl.py --model poisson
#   python train_epl.py --model dixon_coles

from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, date
from pathlib import Path
from typing import Any, Dict, List, Optional
import json
import sys

import pandas as pd

from trainer import train_dixon_coles, train_poisson
from scoreline import build_scoreline_matrix
from markets import market_btts, market_over_under
from evaluator import chronological_holdout_split, brier_score, log_loss


# ---------- Configuration ----------

TARGET_LEAGUE = "EPL"
HOLDOUT_PCT = 0.20
GOAL_CAP = 6
DECAY_HALF_LIFE_DAYS = 180.0
MIN_MATCHES_PER_TEAM = 10
LAMBDA_REG = 0.1

# A DC fit with |rho| below this threshold is effectively Poisson.
RHO_DEGENERATE_THRESHOLD = 1e-3

ROOT = Path(__file__).parent
INPUT_CSV = ROOT / "inputs" / "epl_matches.csv"


# ---------- Helpers ----------

def _parse_date_safe(value: Any) -> Optional[date]:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    try:
        if pd.isna(value):
            return None
    except (TypeError, ValueError):
        pass
    try:
        return pd.to_datetime(value).date()
    except Exception:
        return None


def _to_int_safe(v: Any) -> Optional[int]:
    try:
        iv = int(v)
        return iv if iv >= 0 else None
    except (TypeError, ValueError):
        return None


def _detect_suspicious_team_pairs(teams: List[str]) -> List[str]:
    warnings: List[str] = []
    sorted_teams = sorted(teams)
    for i, a in enumerate(sorted_teams):
        for b in sorted_teams[i + 1:]:
            la, lb = a.lower(), b.lower()
            shorter, longer = (la, lb) if len(la) < len(lb) else (lb, la)
            if len(shorter) < 4:
                continue
            if longer.startswith(shorter + " ") or longer.endswith(" " + shorter):
                warnings.append(f"Possible duplicate team names: '{a}' vs '{b}'")
    return warnings


# ---------- Pipeline ----------

def main() -> int:
    parser = argparse.ArgumentParser(
        description="Train a goal-scoring model on EPL match data."
    )
    parser.add_argument(
        "--model",
        choices=["poisson", "dixon_coles"],
        default="dixon_coles",
        help="Model family to fit (default: dixon_coles).",
    )
    args = parser.parse_args()
    requested_model: str = args.model

    output_json = ROOT / "outputs" / f"epl_{requested_model}.json"

    if not INPUT_CSV.exists():
        print(f"ERROR: input CSV not found at {INPUT_CSV}", file=sys.stderr)
        print(
            "Expected schema: league,season,date,home_team,away_team,"
            "home_goals,away_goals,source",
            file=sys.stderr,
        )
        return 1

    output_json.parent.mkdir(parents=True, exist_ok=True)

    print(f"[1/7] Loading {INPUT_CSV}")
    df = pd.read_csv(INPUT_CSV)
    rows_loaded = len(df)
    print(f"      rows_loaded = {rows_loaded}")

    required = ["league", "date", "home_team", "away_team", "home_goals", "away_goals"]
    missing_cols = [c for c in required if c not in df.columns]
    if missing_cols:
        print(f"ERROR: CSV missing required column(s): {missing_cols}", file=sys.stderr)
        return 2

    print(f"[2/7] Filtering to league='{TARGET_LEAGUE}' and cleaning")
    drop_reasons: Counter = Counter()

    before = len(df)
    df = df[df["league"] == TARGET_LEAGUE].copy()
    drop_reasons[f"non_{TARGET_LEAGUE}"] = before - len(df)

    before = len(df)
    df = df.dropna(subset=required)
    drop_reasons["missing_critical_field"] = before - len(df)

    df["_date"] = df["date"].apply(_parse_date_safe)
    before = len(df)
    df = df[df["_date"].notna()].copy()
    drop_reasons["invalid_date"] = before - len(df)

    df["_hg"] = df["home_goals"].apply(_to_int_safe)
    df["_ag"] = df["away_goals"].apply(_to_int_safe)
    before = len(df)
    df = df[df["_hg"].notna() & df["_ag"].notna()].copy()
    drop_reasons["invalid_goals"] = before - len(df)

    df["home_team"] = df["home_team"].astype(str).str.strip()
    df["away_team"] = df["away_team"].astype(str).str.strip()

    before = len(df)
    df = df[df["home_team"] != df["away_team"]].copy()
    drop_reasons["self_match"] = before - len(df)

    before = len(df)
    df = df.drop_duplicates(subset=["_date", "home_team", "away_team"], keep="first").copy()
    drop_reasons["duplicate"] = before - len(df)

    rows_used = len(df)
    print(f"      rows_used = {rows_used}, dropped = {dict(drop_reasons)}")

    if rows_used == 0:
        print(
            f"ERROR: no usable rows after filtering. Check that the CSV "
            f"contains rows with league='{TARGET_LEAGUE}'.",
            file=sys.stderr,
        )
        return 3

    matches: List[Dict[str, Any]] = [
        {
            "home_team": str(row["home_team"]),
            "away_team": str(row["away_team"]),
            "home_goals": int(row["_hg"]),
            "away_goals": int(row["_ag"]),
            "date": row["_date"],
        }
        for _, row in df.iterrows()
    ]

    print(f"[3/7] Building data quality block")
    teams_set = set()
    for m in matches:
        teams_set.add(m["home_team"])
        teams_set.add(m["away_team"])
    teams_list = sorted(teams_set)

    seasons_list: List[str] = []
    if "season" in df.columns:
        seasons_list = sorted({str(s) for s in df["season"].dropna().tolist()})

    date_min = min(m["date"] for m in matches)
    date_max = max(m["date"] for m in matches)

    warnings: List[str] = []
    warnings.extend(_detect_suspicious_team_pairs(teams_list))

    if rows_used < 100:
        warnings.append(
            f"Small dataset ({rows_used} matches); model fits will be unreliable. "
            "Recommend at least 2 full seasons (~760 matches) for stable estimates."
        )
    if len(seasons_list) == 1:
        warnings.append(
            f"Only one season ({seasons_list[0]}) in data; "
            "consider 2-3 seasons so the holdout is large enough to be meaningful."
        )

    print(f"[4/7] Chronological split (holdout_pct={HOLDOUT_PCT})")
    train_matches, holdout_matches = chronological_holdout_split(matches, HOLDOUT_PCT)
    print(f"      train = {len(train_matches)}, holdout = {len(holdout_matches)}")

    train_team_counts: Counter = Counter()
    for m in train_matches:
        train_team_counts[m["home_team"]] += 1
        train_team_counts[m["away_team"]] += 1
    for t, c in sorted((t, c) for t, c in train_team_counts.items() if c < MIN_MATCHES_PER_TEAM):
        warnings.append(
            f"Team '{t}' has only {c} training matches "
            f"(below min_matches_per_team={MIN_MATCHES_PER_TEAM})"
        )

    print(f"[5/7] Training {requested_model}")
    if requested_model == "poisson":
        params = train_poisson(train_matches, lambda_reg=LAMBDA_REG, goal_cap=GOAL_CAP)
        print(
            f"      log_likelihood = {params.metrics['log_likelihood']:.2f}, "
            f"teams = {params.metrics['num_teams']}"
        )
    else:
        params = train_dixon_coles(
            train_matches,
            lambda_reg=LAMBDA_REG,
            goal_cap=GOAL_CAP,
            decay_half_life_days=DECAY_HALF_LIFE_DAYS,
        )
        print(
            f"      log_likelihood = {params.metrics['log_likelihood']:.2f}, "
            f"rho = {params.rho:.4f}, "
            f"teams = {params.metrics['num_teams']}"
        )

    # Degeneracy check: if DC converged to rho~0 it is effectively Poisson
    effective_model = requested_model
    if requested_model == "dixon_coles":
        if params.rho is None or abs(params.rho) < RHO_DEGENERATE_THRESHOLD:
            effective_model = "dixon_coles_degenerate"
            warnings.append(
                f"DC fit converged to rho={params.rho} "
                f"(|rho| < {RHO_DEGENERATE_THRESHOLD}); "
                "model is effectively Poisson. "
                "Re-run with --model poisson and compare metrics."
            )
            print(
                f"      WARNING: rho={params.rho:.6f} is effectively zero "
                f"-- labelling output as '{effective_model}'"
            )

    print(f"[6/7] Predicting {len(holdout_matches)} holdout matches")
    predictions: List[Dict[str, Any]] = []
    over_probs: List[float] = []
    over_outcomes: List[int] = []
    holdout_dropped_unknown = 0

    for m in holdout_matches:
        if (m["home_team"] not in params.team_strengths
                or m["away_team"] not in params.team_strengths):
            holdout_dropped_unknown += 1
            continue

        matrix, lam_h, lam_a = build_scoreline_matrix(params, m["home_team"], m["away_team"])
        ou_2_5 = market_over_under(matrix, line=2.5)
        ou_1_5 = market_over_under(matrix, line=1.5)
        btts = market_btts(matrix)

        actual_total = m["home_goals"] + m["away_goals"]
        actual_o25 = bool(actual_total > 2.5)

        predictions.append({
            "date": m["date"].isoformat(),
            "home_team": m["home_team"],
            "away_team": m["away_team"],
            "p_over_1_5": round(ou_1_5["over"], 4),
            "p_over_2_5": round(ou_2_5["over"], 4),
            "p_under_2_5": round(ou_2_5["under"], 4),
            "p_btts_yes": round(btts["yes"], 4),
            "expected_home_goals": round(lam_h, 4),
            "expected_away_goals": round(lam_a, 4),
            "actual_home_goals": m["home_goals"],
            "actual_away_goals": m["away_goals"],
            "actual_total_goals": actual_total,
            "actual_over_2_5": actual_o25,
        })
        over_probs.append(ou_2_5["over"])
        over_outcomes.append(1 if actual_o25 else 0)

    if holdout_dropped_unknown > 0:
        warnings.append(
            f"{holdout_dropped_unknown} holdout matches dropped: "
            "team(s) not present in training set."
        )
        drop_reasons["holdout_unknown_team"] = holdout_dropped_unknown

    metrics: Dict[str, Any] = {
        "brier_over_2_5": (
            round(brier_score(over_probs, over_outcomes), 6) if over_probs else None
        ),
        "log_loss_over_2_5": (
            round(log_loss(over_probs, over_outcomes), 6) if over_probs else None
        ),
    }
    if params.rho is not None:
        metrics["rho"] = round(float(params.rho), 6)
    print(f"      metrics = {metrics}")

    print(f"[7/7] Writing {output_json}")
    output: Dict[str, Any] = {
        "league": TARGET_LEAGUE,
        "model": effective_model,
        "trained_at": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
        "matches_used": len(train_matches),
        "config": {
            "requested_model": requested_model,
            "effective_model": effective_model,
            "holdout_pct": HOLDOUT_PCT,
            "goal_cap": GOAL_CAP,
            "decay_half_life_days": (
                DECAY_HALF_LIFE_DAYS if requested_model == "dixon_coles" else None
            ),
            "min_matches_per_team": MIN_MATCHES_PER_TEAM,
            "lambda_reg": LAMBDA_REG,
            "rho_degenerate_threshold": RHO_DEGENERATE_THRESHOLD,
        },
        "data_quality": {
            "rows_loaded": rows_loaded,
            "rows_used": rows_used,
            "teams": len(teams_list),
            "seasons": seasons_list,
            "date_min": date_min.isoformat(),
            "date_max": date_max.isoformat(),
            "dropped_rows": {
                "total": int(sum(drop_reasons.values())),
                "by_reason": {k: int(v) for k, v in drop_reasons.items() if v > 0},
            },
            "warnings": warnings,
        },
        "metrics": metrics,
        "predictions": predictions,
    }

    output_json.write_text(json.dumps(output, indent=2, default=str))
    print(f"      done: {len(predictions)} predictions written")
    return 0


if __name__ == "__main__":
    sys.exit(main())
