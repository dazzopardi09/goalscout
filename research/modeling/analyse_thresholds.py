# research/modeling/analyse_thresholds.py
#
# Milestone 5: threshold / pick-zone analysis for O2.5 model outputs.
#
# Reads one or more JSON files produced by train_league.py and reports
# hit rates, calibration, and fair odds at each probability threshold.
#
# Usage:
#   python analyse_thresholds.py                              # all outputs/*.json
#   python analyse_thresholds.py --file outputs/epl_poisson.json
#   python analyse_thresholds.py --league EPL
#   python analyse_thresholds.py --league EPL --model poisson
#
# Output:
#   Console tables (one per file)
#   outputs/threshold_analysis.csv  (machine-readable, appended per run)

from __future__ import annotations

import argparse
import csv
import glob
import json
import math
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).parent

# ---------------------------------------------------------------------------
# Threshold definitions
# ---------------------------------------------------------------------------

OVER_THRESHOLDS  = [0.55, 0.60, 0.65, 0.70]   # pick Over when pO2.5 >= t
UNDER_THRESHOLDS = [0.45, 0.40, 0.35, 0.30]   # pick Under when pO2.5 <= t

SAMPLE_WARNING_MIN = 20   # warn when fewer than this many picks in a bucket

CSV_COLUMNS = [
    "source_file", "league", "model", "side", "threshold",
    "count", "hit_rate", "avg_model_prob", "fair_odds",
    "brier", "log_loss", "avg_expected_total_goals", "sample_warning",
]

OUTPUT_CSV = ROOT / "outputs" / "threshold_analysis.csv"

# ---------------------------------------------------------------------------
# Maths helpers  (stdlib only — no numpy/scipy needed here)
# ---------------------------------------------------------------------------

def _brier(probs: list[float], outcomes: list[int]) -> float:
    if not probs:
        return float("nan")
    return sum((p - o) ** 2 for p, o in zip(probs, outcomes)) / len(probs)


def _log_loss(probs: list[float], outcomes: list[int], eps: float = 1e-15) -> float:
    if not probs:
        return float("nan")
    total = 0.0
    for p, o in zip(probs, outcomes):
        pc = min(max(p, eps), 1.0 - eps)
        total += -(o * math.log(pc) + (1 - o) * math.log(1.0 - pc))
    return total / len(probs)


def _fair_odds(avg_prob: float) -> float:
    if avg_prob <= 0:
        return float("inf")
    return round(1.0 / avg_prob, 3)


def _r(v: float | None, dp: int = 4) -> str:
    """Format a float for display, or '—' if None/nan."""
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return "—"
    return f"{v:.{dp}f}"

# ---------------------------------------------------------------------------
# Core analysis
# ---------------------------------------------------------------------------

def analyse_file(path: Path) -> list[dict[str, Any]]:
    """
    Run threshold analysis on one output JSON file.
    Returns a list of row dicts (one per threshold bucket).
    """
    with path.open() as f:
        doc = json.load(f)

    league     = doc.get("league", "?")
    model      = doc.get("model", "?")
    preds      = doc.get("predictions", [])
    source     = path.name

    if not preds:
        print(f"  WARNING: {path.name} has no predictions — skipping.")
        return []

    # Pull per-prediction values
    p_o25_list   = [float(p["p_over_2_5"])        for p in preds]
    actual_o25   = [int(bool(p["actual_over_2_5"])) for p in preds]

    # expected_home_goals + expected_away_goals = expected total goals
    # Both fields always present in train_league.py output
    exp_total_list = [
        float(p.get("expected_home_goals", 0)) + float(p.get("expected_away_goals", 0))
        for p in preds
    ]

    rows: list[dict[str, Any]] = []

    # ---- Over buckets ----
    for t in OVER_THRESHOLDS:
        indices = [i for i, p in enumerate(p_o25_list) if p >= t]
        count = len(indices)
        if count == 0:
            continue

        model_probs = [p_o25_list[i]  for i in indices]
        outcomes    = [actual_o25[i]  for i in indices]
        exp_total   = [exp_total_list[i] for i in indices]

        hit_rate      = sum(outcomes) / count
        avg_prob      = sum(model_probs) / count
        avg_exp_total = sum(exp_total) / count
        brier         = _brier(model_probs, outcomes)
        ll            = _log_loss(model_probs, outcomes)
        warn          = count < SAMPLE_WARNING_MIN

        rows.append({
            "source_file":              source,
            "league":                   league,
            "model":                    model,
            "side":                     "Over",
            "threshold":                t,
            "count":                    count,
            "hit_rate":                 round(hit_rate, 4),
            "avg_model_prob":           round(avg_prob, 4),
            "fair_odds":                _fair_odds(avg_prob),
            "brier":                    round(brier, 6),
            "log_loss":                 round(ll, 6),
            "avg_expected_total_goals": round(avg_exp_total, 3),
            "sample_warning":           warn,
        })

    # ---- Under buckets ----
    for t in UNDER_THRESHOLDS:
        indices = [i for i, p in enumerate(p_o25_list) if p <= t]
        count = len(indices)
        if count == 0:
            continue

        # For Under, the model probability for the *selected side* is (1 - pO2.5)
        model_probs  = [1.0 - p_o25_list[i] for i in indices]
        # Outcome: Under hits when actual_over_2_5 == 0
        outcomes     = [1 - actual_o25[i]    for i in indices]
        exp_total    = [exp_total_list[i]     for i in indices]

        hit_rate      = sum(outcomes) / count
        avg_prob      = sum(model_probs) / count
        avg_exp_total = sum(exp_total) / count
        brier         = _brier(model_probs, outcomes)
        ll            = _log_loss(model_probs, outcomes)
        warn          = count < SAMPLE_WARNING_MIN

        rows.append({
            "source_file":              source,
            "league":                   league,
            "model":                    model,
            "side":                     "Under",
            "threshold":                t,
            "count":                    count,
            "hit_rate":                 round(hit_rate, 4),
            "avg_model_prob":           round(avg_prob, 4),
            "fair_odds":                _fair_odds(avg_prob),
            "brier":                    round(brier, 6),
            "log_loss":                 round(ll, 6),
            "avg_expected_total_goals": round(avg_exp_total, 3),
            "sample_warning":           warn,
        })

    return rows

# ---------------------------------------------------------------------------
# Display
# ---------------------------------------------------------------------------

def _print_table(rows: list[dict], source: str, league: str, model: str) -> None:
    if not rows:
        return

    title = f"{league} / {model}  [{source}]"
    print(f"\n{'─' * 74}")
    print(f"  {title}")
    print(f"{'─' * 74}")
    hdr = (f"{'Side':<6}  {'Thresh':>7}  {'N':>5}  {'HitRate':>8}  "
           f"{'AvgProb':>8}  {'FairOdds':>9}  {'Brier':>8}  {'LogLoss':>8}  "
           f"{'ExpGls':>7}")
    print(hdr)
    print(f"{'─' * 74}")

    for r in rows:
        warn_flag = " *" if r["sample_warning"] else "  "
        line = (
            f"{r['side']:<6}  "
            f"{r['threshold']:>7.2f}  "
            f"{r['count']:>5}  "
            f"{_r(r['hit_rate']):>8}  "
            f"{_r(r['avg_model_prob']):>8}  "
            f"{_r(r['fair_odds'], 3):>9}  "
            f"{_r(r['brier'], 5):>8}  "
            f"{_r(r['log_loss'], 5):>8}  "
            f"{_r(r['avg_expected_total_goals'], 2):>7}"
            f"{warn_flag}"
        )
        print(line)

    print(f"{'─' * 74}")
    print(f"  * sample < {SAMPLE_WARNING_MIN} — treat with caution")


# ---------------------------------------------------------------------------
# CSV writer
# ---------------------------------------------------------------------------

def _write_csv(all_rows: list[dict]) -> None:
    OUTPUT_CSV.parent.mkdir(parents=True, exist_ok=True)
    write_header = not OUTPUT_CSV.exists()
    with OUTPUT_CSV.open("a", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_COLUMNS)
        if write_header:
            writer.writeheader()
        writer.writerows(all_rows)
    print(f"\nAppended {len(all_rows)} rows to {OUTPUT_CSV}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(
        description="Threshold / pick-zone analysis for O2.5 model output JSON files."
    )
    parser.add_argument(
        "--file",
        help="Analyse a single JSON file (e.g. outputs/epl_poisson.json).",
    )
    parser.add_argument(
        "--league",
        help="Filter to files whose top-level 'league' field matches.",
    )
    parser.add_argument(
        "--model",
        help="Filter to files whose top-level 'model' field matches "
             "(e.g. poisson, dixon_coles).",
    )
    args = parser.parse_args()

    # Resolve candidate files
    if args.file:
        candidates = [Path(args.file)]
        if not candidates[0].is_absolute():
            candidates = [ROOT / candidates[0]]
    else:
        candidates = sorted(
            Path(p) for p in glob.glob(str(ROOT / "outputs" / "*.json"))
            if Path(p).name != "threshold_analysis.csv"
        )

    if not candidates:
        print("No JSON output files found. Run train_league.py first.", file=sys.stderr)
        return 1

    all_rows: list[dict] = []

    for path in candidates:
        if not path.exists():
            print(f"ERROR: file not found: {path}", file=sys.stderr)
            continue

        # Peek at league/model for filtering without full parse
        try:
            with path.open() as f:
                doc = json.load(f)
        except Exception as e:
            print(f"ERROR reading {path.name}: {e}", file=sys.stderr)
            continue

        file_league = doc.get("league", "")
        file_model  = doc.get("model", "")

        if args.league and file_league != args.league:
            continue
        if args.model and not file_model.startswith(args.model):
            continue

        rows = analyse_file(path)
        if rows:
            _print_table(rows, path.name, file_league, file_model)
            all_rows.extend(rows)

    if not all_rows:
        print("No matching files or no predictions found.", file=sys.stderr)
        return 1

    # Overwrite (not append) so the CSV always reflects the current run
    OUTPUT_CSV.parent.mkdir(parents=True, exist_ok=True)
    with OUTPUT_CSV.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_COLUMNS)
        writer.writeheader()
        writer.writerows(all_rows)
    print(f"\nWrote {len(all_rows)} rows to {OUTPUT_CSV}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
