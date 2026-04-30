# research/modeling/rank_candidate_zones.py
#
# Reads outputs/calibration_report.csv and produces a ranked candidate list
# with a single quality_score per zone.
#
# ┌─────────────────────────────────────────────────────────────────────────┐
# │ RESEARCH ONLY — NOT PROOF OF LIVE EDGE                                  │
# │                                                                         │
# │ Scoring is based on holdout back-test against historical aggregated     │
# │ odds. Rankings are discovery candidates only. All zones require live    │
# │ forward tracking before any use in production.                          │
# └─────────────────────────────────────────────────────────────────────────┘
#
# Usage:
#   python rank_candidate_zones.py
#   python rank_candidate_zones.py --min-forward-n 40 --min-forward-roi 0.05

from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

import pandas as pd

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

ROOT          = Path(__file__).parent
OUTPUTS_DIR   = ROOT / "outputs"
INPUT_CSV     = OUTPUTS_DIR / "calibration_report.csv"
OUTPUT_CSV    = OUTPUTS_DIR / "candidate_zone_rankings.csv"

# ---------------------------------------------------------------------------
# Scoring constants — change here to adjust the model without touching logic
#
# Units:
#   roi_opening        — decimal (0.139 = 13.9%)
#   opening_edge_pct   — percentage points (8.3 = 8.3%)
#   closing_edge_pct   — percentage points
#   calibration_diff   — decimal (0.05 = 5%)
#
# All inputs are converted to percentage points before scoring so the
# constants are on a comparable scale.
# ---------------------------------------------------------------------------

# ── Rewards ──────────────────────────────────────────────────────────────
ROI_WEIGHT            = 1.00   # multiplier on ROI_Open converted to pct pts
OPEN_EDGE_WEIGHT      = 0.50   # multiplier on opening_edge_pct
CLOSE_EDGE_WEIGHT     = 0.35   # multiplier on closing_edge_pct

# ── Calibration penalty ───────────────────────────────────────────────────
CAL_DIFF_PENALTY      = 0.75   # multiplier on |calibration_diff| in pct pts

# ── Sample size penalty ───────────────────────────────────────────────────
SAMPLE_PENALTY_BELOW  = 40     # apply penalty when N < this
SAMPLE_PENALTY_AMOUNT = 3.0    # points subtracted

# ── Contradiction penalties ───────────────────────────────────────────────
# Case 1: CloseEdge looks strong but ROI is weak (possible data artefact)
CONTRA_CLOSE_EDGE_THRESHOLD   = 5.0    # closing_edge_pct > this ...
CONTRA_WEAK_ROI_THRESHOLD     = 3.0    # ... and roi_opening_pct < this → mild penalty
CONTRA_WEAK_PENALTY           = 3.0    # points subtracted

# Case 2: CloseEdge strong but ROI negative
CONTRA_NEG_ROI_THRESHOLD      = 0.0    # roi_opening_pct < this → stronger penalty
CONTRA_STRONG_PENALTY         = 6.0    # points subtracted (stacks with weak penalty)

# Case 3: OpenEdge strong but ROI negative
CONTRA_OPEN_EDGE_THRESHOLD    = 5.0    # opening_edge_pct > this ...
CONTRA_OPEN_NEG_PENALTY       = 4.0    # ... and roi negative → points subtracted

# ── Recommendation thresholds ────────────────────────────────────────────
FWD_MIN_SCORE         = 5.0    # quality_score >= this (can be overridden by --min-forward-score)
FWD_MIN_N             = 40     # N >= this (can be overridden by --min-forward-n)
FWD_MIN_ROI           = 0.03   # roi_opening >= this decimal (can be overridden by --min-forward-roi)
FWD_CLASSIFICATIONS   = {"Pass"}   # only these classifications qualify for forward_track
FWD_NO_MAJOR_FLAGS    = True   # forward_track requires no major contradiction flags


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _safe_float(v: Any) -> Optional[float]:
    if v is None or v == "":
        return None
    try:
        f = float(v)
        return None if math.isnan(f) else f
    except (TypeError, ValueError):
        return None


def _pct_dec(v: Optional[float], dp: int = 1) -> str:
    """Decimal → percentage string.  0.05 → '+5.0%'"""
    if v is None:
        return "—"
    fv = v * 100.0
    sign = "+" if fv >= 0 else ""
    return f"{sign}{fv:.{dp}f}%"


def _pct_pts(v: Optional[float], dp: int = 1) -> str:
    """Already percentage points → string.  8.3 → '+8.3%'"""
    if v is None:
        return "—"
    sign = "+" if v >= 0 else ""
    return f"{sign}{v:.{dp}f}%"


def _roi_pct(v: Optional[float], dp: int = 1) -> str:
    """Decimal ROI → percentage string.  0.139 → '+13.9%'"""
    if v is None:
        return "—"
    fv = v * 100.0
    sign = "+" if fv >= 0 else ""
    return f"{sign}{fv:.{dp}f}%"


def _score_str(v: float) -> str:
    sign = "+" if v >= 0 else ""
    return f"{sign}{v:.2f}"


# ---------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------

def _compute_score(
    roi_open: Optional[float],       # decimal
    open_edge: Optional[float],      # pct points
    close_edge: Optional[float],     # pct points
    cal_diff: Optional[float],       # decimal
    n: int,
) -> tuple[float, List[str]]:
    """
    Returns (quality_score, risk_flags).
    All arithmetic is done in percentage-point space for readability.
    """
    score = 0.0
    flags: List[str] = []

    # Convert ROI to percentage points for uniform scale
    roi_pct = (roi_open * 100.0) if roi_open is not None else 0.0
    oe      = open_edge  if open_edge  is not None else 0.0
    ce      = close_edge if close_edge is not None else 0.0
    cd_pct  = (abs(cal_diff) * 100.0) if cal_diff is not None else 0.0

    # ── Rewards ──────────────────────────────────────────────────────────
    score += ROI_WEIGHT       * roi_pct
    score += OPEN_EDGE_WEIGHT * oe
    score += CLOSE_EDGE_WEIGHT * ce

    # ── Calibration penalty ───────────────────────────────────────────────
    cal_penalty = CAL_DIFF_PENALTY * cd_pct
    score -= cal_penalty
    if cd_pct > 5.0:
        flags.append(f"cal_diff {_pct_dec(cal_diff)} (>±5%)")

    # ── Sample penalty ────────────────────────────────────────────────────
    if n < SAMPLE_PENALTY_BELOW:
        score -= SAMPLE_PENALTY_AMOUNT
        flags.append(f"small_sample N={n}<{SAMPLE_PENALTY_BELOW}")

    # ── Contradiction: CloseEdge strong but ROI weak ──────────────────────
    close_contradiction = False
    if ce > CONTRA_CLOSE_EDGE_THRESHOLD:
        if roi_pct < CONTRA_NEG_ROI_THRESHOLD:
            # Stacks both penalties
            score -= CONTRA_WEAK_PENALTY
            score -= CONTRA_STRONG_PENALTY
            flags.append(
                f"MAJOR: close_edge {_pct_pts(ce)} but roi_open {_roi_pct(roi_open)} negative"
            )
            close_contradiction = True
        elif roi_pct < CONTRA_WEAK_ROI_THRESHOLD:
            score -= CONTRA_WEAK_PENALTY
            flags.append(
                f"close_edge {_pct_pts(ce)} but roi_open {_roi_pct(roi_open)} weak "
                f"(<{CONTRA_WEAK_ROI_THRESHOLD}%)"
            )
            close_contradiction = True

    # ── Contradiction: OpenEdge strong but ROI negative ───────────────────
    if oe > CONTRA_OPEN_EDGE_THRESHOLD and roi_pct < CONTRA_NEG_ROI_THRESHOLD:
        score -= CONTRA_OPEN_NEG_PENALTY
        flags.append(
            f"MAJOR: open_edge {_pct_pts(oe)} but roi_open {_roi_pct(roi_open)} negative"
        )

    return round(score, 3), flags


# ---------------------------------------------------------------------------
# Recommendation
# ---------------------------------------------------------------------------

def _recommend(
    score: float,
    n: int,
    roi_open: Optional[float],
    classification: str,
    flags: List[str],
    min_forward_score: float,
    min_forward_n: int,
    min_forward_roi: float,
) -> str:
    has_major_flag = any("MAJOR" in f for f in flags)
    roi_pct = (roi_open * 100.0) if roi_open is not None else -999.0

    if (
        score >= min_forward_score
        and n >= min_forward_n
        and roi_pct >= min_forward_roi * 100.0
        and classification in FWD_CLASSIFICATIONS
        and (not FWD_NO_MAJOR_FLAGS or not has_major_flag)
    ):
        return "forward_track"

    if score < 0 or classification == "Reject" or has_major_flag:
        return "avoid"

    return "watch_only"


# ---------------------------------------------------------------------------
# Console printing
# ---------------------------------------------------------------------------

def _print_section(
    title: str,
    rows: List[Dict[str, Any]],
    width: int = 82,
) -> None:
    print()
    print("━" * width)
    print(f"  {title}  ({len(rows)} zone{'s' if len(rows) != 1 else ''})")
    print("━" * width)

    if not rows:
        print("  (none)")
        return

    print(
        f"  {'#':>3}  {'League':<14} {'Side':<6} {'Thresh':>6}  {'N':>5}  "
        f"{'Hit%':>7}  {'ROI_Open':>9}  {'OpenEdge':>9}  "
        f"{'CloseEdge':>10}  {'Score':>7}"
    )
    print(f"  {'─'*78}")

    for r in rows:
        flags_str = "; ".join(r["risk_flags"]) if r["risk_flags"] else "—"
        print(
            f"  {r['rank']:>3}  {r['league']:<14} {r['side']:<6} "
            f"{r['threshold']:>6.2f}  "
            f"{r['n']:>5}  "
            f"{_pct_dec(r['hit_rate']):>7}  "
            f"{_roi_pct(r['roi_opening']):>9}  "
            f"{_pct_pts(r['opening_edge_pct']):>9}  "
            f"{_pct_pts(r['closing_edge_pct']):>10}  "
            f"{_score_str(r['quality_score']):>7}"
        )
        if r["risk_flags"]:
            print(f"       ⚠ {flags_str}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(
        description="Rank Poisson O/U 2.5 candidate zones by quality score."
    )
    parser.add_argument(
        "--input",
        default=str(INPUT_CSV),
        help=f"Path to calibration_report.csv (default: {INPUT_CSV}).",
    )
    parser.add_argument(
        "--min-forward-score",
        type=float,
        default=FWD_MIN_SCORE,
        help=f"Min quality_score for forward_track (default: {FWD_MIN_SCORE}).",
    )
    parser.add_argument(
        "--min-forward-n",
        type=int,
        default=FWD_MIN_N,
        help=f"Min N for forward_track (default: {FWD_MIN_N}).",
    )
    parser.add_argument(
        "--min-forward-roi",
        type=float,
        default=FWD_MIN_ROI,
        help=f"Min ROI_Open decimal for forward_track (default: {FWD_MIN_ROI} = {FWD_MIN_ROI*100:.0f}%%).",
    )
    args = parser.parse_args()

    input_path = Path(args.input)
    if not input_path.exists():
        print(
            f"ERROR: {input_path} not found.\n"
            "Run calibrate_zones.py first to generate calibration_report.csv.",
            file=sys.stderr,
        )
        return 1

    print()
    print("━" * 72)
    print("  RESEARCH ONLY — NOT PROOF OF LIVE EDGE")
    print("━" * 72)
    print("  Rankings are based on holdout back-test against historical odds.")
    print("  forward_track zones require live forward tracking before any use.")
    print("━" * 72)

    print(f"\nForward-track criteria:")
    print(f"  quality_score >= {args.min_forward_score}")
    print(f"  N >= {args.min_forward_n}")
    print(f"  ROI_Open >= {args.min_forward_roi * 100:.1f}%")
    print(f"  classification in {FWD_CLASSIFICATIONS}")
    print(f"  no MAJOR contradiction flags")

    # ── Load calibration report ───────────────────────────────────────────
    try:
        df = pd.read_csv(input_path)
    except Exception as exc:
        print(f"ERROR reading {input_path}: {exc}", file=sys.stderr)
        return 1

    if df.empty:
        print("ERROR: calibration_report.csv is empty.", file=sys.stderr)
        return 1

    print(f"\nLoaded {len(df)} zones from {input_path.name}")

    # ── Score each zone ───────────────────────────────────────────────────
    output_rows: List[Dict[str, Any]] = []

    for _, row in df.iterrows():
        roi_open   = _safe_float(row.get("roi_opening"))
        open_edge  = _safe_float(row.get("opening_edge_pct"))
        close_edge = _safe_float(row.get("closing_edge_pct"))
        cal_diff   = _safe_float(row.get("calibration_diff"))
        n          = int(row.get("n", 0))
        cls        = str(row.get("classification", ""))

        score, flags = _compute_score(roi_open, open_edge, close_edge, cal_diff, n)

        rec = _recommend(
            score, n, roi_open, cls, flags,
            min_forward_score=args.min_forward_score,
            min_forward_n=args.min_forward_n,
            min_forward_roi=args.min_forward_roi,
        )

        output_rows.append({
            "league":            str(row.get("league", "")),
            "side":              str(row.get("side", "")),
            "threshold":         _safe_float(row.get("threshold")),
            "n":                 n,
            "classification":    cls,
            "hit_rate":          _safe_float(row.get("hit_rate")),
            "avg_model_prob":    _safe_float(row.get("avg_model_prob")),
            "calibration_diff":  cal_diff,
            "opening_edge_pct":  open_edge,
            "roi_opening":       roi_open,
            "closing_edge_pct":  close_edge,
            "quality_score":     score,
            "risk_flags":        flags,
            "recommendation":    rec,
        })

    # Sort by quality_score descending, assign rank
    output_rows.sort(key=lambda r: r["quality_score"], reverse=True)
    for i, r in enumerate(output_rows, 1):
        r["rank"] = i

    # ── Console output ────────────────────────────────────────────────────
    forward  = [r for r in output_rows if r["recommendation"] == "forward_track"]
    watch    = [r for r in output_rows if r["recommendation"] == "watch_only"]
    avoid    = [r for r in output_rows if r["recommendation"] == "avoid"]

    _print_section("FORWARD TRACK — strong candidates for live monitoring", forward)
    _print_section("WATCH ONLY — promising but insufficient evidence", watch)
    _print_section("AVOID — negative score, Reject classification, or major contradiction", avoid)

    # ── Score breakdown legend ────────────────────────────────────────────
    print()
    print("  Score formula (all values in percentage points):")
    print(f"    + {ROI_WEIGHT:.2f} × ROI_Open")
    print(f"    + {OPEN_EDGE_WEIGHT:.2f} × OpenEdge")
    print(f"    + {CLOSE_EDGE_WEIGHT:.2f} × CloseEdge")
    print(f"    − {CAL_DIFF_PENALTY:.2f} × |CalDiff|")
    print(f"    − {SAMPLE_PENALTY_AMOUNT:.1f}  if N < {SAMPLE_PENALTY_BELOW}")
    print(f"    − {CONTRA_WEAK_PENALTY:.1f}  if CloseEdge > {CONTRA_CLOSE_EDGE_THRESHOLD}% and ROI < {CONTRA_WEAK_ROI_THRESHOLD}%")
    print(f"    − {CONTRA_STRONG_PENALTY:.1f}  additionally if CloseEdge > {CONTRA_CLOSE_EDGE_THRESHOLD}% and ROI < 0%")
    print(f"    − {CONTRA_OPEN_NEG_PENALTY:.1f}  if OpenEdge > {CONTRA_OPEN_EDGE_THRESHOLD}% and ROI < 0%")

    # ── Write CSV ─────────────────────────────────────────────────────────
    OUTPUT_CSV.parent.mkdir(parents=True, exist_ok=True)

    csv_cols = [
        "rank", "league", "side", "threshold", "n", "classification",
        "hit_rate", "avg_model_prob", "calibration_diff",
        "opening_edge_pct", "roi_opening", "closing_edge_pct",
        "quality_score", "risk_flags", "recommendation",
    ]

    with OUTPUT_CSV.open("w", newline="", encoding="utf-8") as f:
        writer = __import__("csv").DictWriter(f, fieldnames=csv_cols)
        writer.writeheader()
        for r in output_rows:
            writer.writerow({
                **{k: r[k] for k in csv_cols if k != "risk_flags"},
                "risk_flags": "; ".join(r["risk_flags"]) if r["risk_flags"] else "",
            })

    print(f"\nWrote {len(output_rows)} ranked zones to {OUTPUT_CSV}")
    print(
        f"\n  forward_track: {len(forward)}  "
        f"watch_only: {len(watch)}  "
        f"avoid: {len(avoid)}"
    )
    print()
    print("━" * 72)
    print("  Ranking complete. forward_track zones are discovery candidates only.")
    print("  Do not use in production without live forward validation.")
    print("━" * 72)

    return 0


if __name__ == "__main__":
    sys.exit(main())