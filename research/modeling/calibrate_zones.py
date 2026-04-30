# research/modeling/calibrate_zones.py
#
# Calibration analysis layer for the GoalScout modelling sandbox.
#
# Reads per-league Poisson holdout JSON files and the odds validation CSV,
# produces reliability tables, league+side bias summaries, and classifies
# each discovery zone as Pass / Watchlist / Reject.
#
# ┌─────────────────────────────────────────────────────────────────────────┐
# │ HISTORICAL VALIDATION ONLY — NOT PROOF OF LIVE EDGE                    │
# │                                                                         │
# │ Classification is based on holdout back-test against football-data.     │
# │ co.uk aggregated historical odds. These are NOT GoalScout's actual      │
# │ tip-time odds. Pass/Watchlist zones require live odds validation        │
# │ before any use in production.                                           │
# └─────────────────────────────────────────────────────────────────────────┘
#
# Usage:
#   python calibrate_zones.py
#   python calibrate_zones.py --min-pass-n 40 --min-pass-roi 0.05
#   python calibrate_zones.py --bin-width 0.10
#   python calibrate_zones.py --leagues EPL Bundesliga

from __future__ import annotations

import argparse
import csv
import json
import math
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

import pandas as pd

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

ROOT            = Path(__file__).parent
OUTPUTS_DIR     = ROOT / "outputs"
ODDS_CSV        = OUTPUTS_DIR / "odds_validation.csv"
CALIBRATION_CSV = OUTPUTS_DIR / "calibration_report.csv"

# ---------------------------------------------------------------------------
# League registry — slug -> display label (mirrors run_league_scan.py)
# ---------------------------------------------------------------------------

SLUG_TO_LABEL: Dict[str, str] = {
    "epl":          "EPL",
    "championship": "Championship",
    "leagueone":    "LeagueOne",
    "leaguetwo":    "LeagueTwo",
    "bundesliga":   "Bundesliga",
    "bundesliga2":  "Bundesliga2",
    "seriea":       "SerieA",
    "serieb":       "SerieB",
    "laliga":       "LaLiga",
    "laliga2":      "LaLiga2",
    "ligue1":       "Ligue1",
    "ligue2":       "Ligue2",
    "eredivisie":   "Eredivisie",
    "belgium":      "Belgium",
    "portugal":     "Portugal",
    "scotland":     "Scotland",
}

# ---------------------------------------------------------------------------
# Formatting helpers
#
# Two distinct formatters:
#
#   _pct_dec(v)   — v is a DECIMAL probability difference, e.g. calibration_diff.
#                   0.05 → "+5.0%"  (multiplies by 100)
#
#   _pct_pts(v)   — v is already in PERCENTAGE POINTS, e.g. opening_edge_pct.
#                   8.3 → "+8.3%"   (does NOT multiply by 100)
#
#   _roi_pct(v)   — v is a DECIMAL ROI, e.g. roi_opening = 0.139 → "+13.9%"
# ---------------------------------------------------------------------------

def _r(v: Any, dp: int = 4) -> str:
    """Format a raw float to dp decimal places."""
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return "—"
    return f"{v:.{dp}f}"


def _pct_dec(v: Any, dp: int = 1) -> str:
    """
    Format a DECIMAL probability difference as a percentage string.
    Multiplies by 100. Use for calibration_diff, hit_rate, avg_model_prob etc.
    Example: 0.05 -> "+5.0%"
    """
    if v is None or v == "" or (isinstance(v, float) and math.isnan(v)):
        return "—"
    fv = float(v) * 100.0
    sign = "+" if fv >= 0 else ""
    return f"{sign}{fv:.{dp}f}%"


def _pct_pts(v: Any, dp: int = 1) -> str:
    """
    Format a value already in PERCENTAGE POINTS.
    Does NOT multiply by 100. Use for opening_edge_pct, closing_edge_pct etc.
    Example: 8.3 -> "+8.3%"
    """
    if v is None or v == "" or (isinstance(v, float) and math.isnan(v)):
        return "—"
    fv = float(v)
    sign = "+" if fv >= 0 else ""
    return f"{sign}{fv:.{dp}f}%"


def _roi_pct(v: Any, dp: int = 1) -> str:
    """
    Format a DECIMAL ROI as a percentage string.
    Multiplies by 100. Example: 0.139 -> "+13.9%"
    """
    if v is None or v == "" or (isinstance(v, float) and math.isnan(v)):
        return "—"
    fv = float(v) * 100.0
    sign = "+" if fv >= 0 else ""
    return f"{sign}{fv:.{dp}f}%"


def _safe_float(v: Any) -> Optional[float]:
    if v is None or v == "":
        return None
    try:
        f = float(v)
        return None if math.isnan(f) else f
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------------------
# Load all available per-league JSON files
# ---------------------------------------------------------------------------

def _load_all_jsons(selected_labels: Optional[List[str]]) -> Dict[str, pd.DataFrame]:
    """
    Returns dict: label -> DataFrame with columns:
        date, home_team, away_team, p_over_2_5, actual_over_2_5,
        home_goals, away_goals, expected_home_goals, expected_away_goals,
        season (filled with 'unknown' if absent)
    """
    result: Dict[str, pd.DataFrame] = {}

    json_files = sorted(OUTPUTS_DIR.glob("*_poisson.json"))
    if not json_files:
        print(f"  No *_poisson.json files found in {OUTPUTS_DIR}", file=sys.stderr)
        return result

    for path in json_files:
        slug  = path.stem.replace("_poisson", "")
        label = SLUG_TO_LABEL.get(slug, slug)

        if selected_labels and label not in selected_labels:
            continue

        try:
            with path.open() as f:
                doc = json.load(f)
        except Exception as exc:
            print(f"  WARNING: could not read {path.name}: {exc}", file=sys.stderr)
            continue

        preds = doc.get("predictions", [])
        if not preds:
            print(f"  WARNING: {path.name} has no predictions — skipping.", file=sys.stderr)
            continue

        rows = []
        for p in preds:
            rows.append({
                "date":                p.get("date"),
                "home_team":           p.get("home_team"),
                "away_team":           p.get("away_team"),
                "p_over_2_5":          _safe_float(p.get("p_over_2_5")),
                "actual_over_2_5":     bool(p.get("actual_over_2_5")),
                "home_goals":          p.get("home_goals"),
                "away_goals":          p.get("away_goals"),
                "expected_home_goals": _safe_float(p.get("expected_home_goals")),
                "expected_away_goals": _safe_float(p.get("expected_away_goals")),
                "season":              p.get("season", "unknown"),
            })

        df = pd.DataFrame(rows)
        df = df.dropna(subset=["p_over_2_5"])
        df["p_under_2_5"]    = 1.0 - df["p_over_2_5"]
        df["actual_under_2_5"] = ~df["actual_over_2_5"]
        result[label] = df

    return result


# ---------------------------------------------------------------------------
# Table A: Reliability by probability bin
# ---------------------------------------------------------------------------

def _reliability_table(
    dfs: Dict[str, pd.DataFrame],
    bin_width: float,
    include_seasons: bool,
) -> pd.DataFrame:
    """
    For each league + side (Over/Under), bin predictions by model probability
    and compare mean predicted prob to actual hit rate.

    calibration_diff = actual_hit_rate - mean_model_prob  (decimal)
      > 0 → model underconfident (actual higher than predicted)
      < 0 → model overconfident  (actual lower than predicted)
    """
    # Safe bin generation using only standard Python — no pandas/numpy helpers
    bin_edges = [round(i * bin_width, 6) for i in range(int(round(1.0 / bin_width)) + 1)]

    all_rows: List[Dict[str, Any]] = []

    for label, df in sorted(dfs.items()):
        for side, prob_col, outcome_col in [
            ("Over",  "p_over_2_5",  "actual_over_2_5"),
            ("Under", "p_under_2_5", "actual_under_2_5"),
        ]:
            sub = df[[prob_col, outcome_col, "season"]].copy()
            sub = sub.dropna(subset=[prob_col])
            sub["outcome_int"] = sub[outcome_col].astype(int)

            sub["bin_lo"] = pd.cut(
                sub[prob_col],
                bins=bin_edges,
                labels=[round(e, 6) for e in bin_edges[:-1]],
                include_lowest=True,
                right=False,
            )

            groups = sub.groupby("bin_lo", observed=True)
            for bin_lo, grp in groups:
                if len(grp) == 0:
                    continue
                mean_prob  = grp[prob_col].mean()
                hit_rate   = grp["outcome_int"].mean()
                cal_diff   = hit_rate - mean_prob   # decimal
                bin_lo_f   = float(bin_lo)
                bin_hi_f   = round(bin_lo_f + bin_width, 3)

                row: Dict[str, Any] = {
                    "league":           label,
                    "side":             side,
                    "bin_lo":           bin_lo_f,
                    "bin_hi":           bin_hi_f,
                    "n":                len(grp),
                    "mean_model_prob":  round(mean_prob, 4),
                    "actual_hit_rate":  round(hit_rate, 4),
                    "calibration_diff": round(cal_diff, 4),  # decimal
                }

                if include_seasons:
                    for season_val, sg in grp.groupby("season", observed=True):
                        if season_val and season_val != "unknown":
                            s_hit = sg["outcome_int"].mean()
                            row[f"hit_{season_val}"] = round(s_hit, 4) if len(sg) > 0 else None

                all_rows.append(row)

    if not all_rows:
        return pd.DataFrame()

    return pd.DataFrame(all_rows)


# ---------------------------------------------------------------------------
# Table C: League + side bias summary
# ---------------------------------------------------------------------------

def _bias_summary(dfs: Dict[str, pd.DataFrame]) -> pd.DataFrame:
    """
    One row per (league, side). Shows overall mean predicted prob vs actual
    hit rate. calibration_diff stored as decimal.
    """
    rows: List[Dict[str, Any]] = []
    for label, df in sorted(dfs.items()):
        for side, prob_col, outcome_col in [
            ("Over",  "p_over_2_5",  "actual_over_2_5"),
            ("Under", "p_under_2_5", "actual_under_2_5"),
        ]:
            sub = df[[prob_col, outcome_col]].dropna(subset=[prob_col])
            if sub.empty:
                continue
            mean_prob = sub[prob_col].mean()
            hit_rate  = sub[outcome_col].astype(int).mean()
            rows.append({
                "league":           label,
                "side":             side,
                "n":                len(sub),
                "mean_model_prob":  round(mean_prob, 4),
                "actual_hit_rate":  round(hit_rate, 4),
                "calibration_diff": round(hit_rate - mean_prob, 4),  # decimal
            })
    return pd.DataFrame(rows)


# ---------------------------------------------------------------------------
# Table B: Zone classification
# ---------------------------------------------------------------------------

def _classify_zones(
    odds_df: pd.DataFrame,
    reliability_df: pd.DataFrame,
    min_pass_n: int,
    min_pass_roi: float,
    min_pass_open_edge: float,
    min_pass_close_edge: float,
    watch_roi_floor: float,
) -> pd.DataFrame:
    """
    Join odds validation results with calibration data, classify each zone.

    opening_edge_pct and closing_edge_pct in odds_validation.csv are in
    PERCENTAGE POINTS (e.g. 8.3 means 8.3%). The min_pass_* args are also
    in percentage points for edge, and decimal for ROI.
    """
    if odds_df.empty:
        return pd.DataFrame()

    ov = odds_df.copy()
    ov.columns = [c.strip() for c in ov.columns]

    # Build overall calibration diff lookup: (league, side) -> decimal diff
    cal_lookup: Dict[tuple, float] = {}
    if not reliability_df.empty:
        agg = (
            reliability_df.groupby(["league", "side"])
            .apply(lambda g: (
                (g["actual_hit_rate"] * g["n"]).sum() / g["n"].sum()
                - (g["mean_model_prob"] * g["n"]).sum() / g["n"].sum()
            ))
            .reset_index(name="cal_diff")
        )
        for _, row in agg.iterrows():
            cal_lookup[(row["league"], row["side"])] = round(float(row["cal_diff"]), 4)

    classified_rows: List[Dict[str, Any]] = []

    for _, row in ov.iterrows():
        league     = str(row.get("league", ""))
        side       = str(row.get("side", ""))
        threshold  = _safe_float(row.get("threshold"))
        n_zone     = _safe_float(row.get("n_zone")) or _safe_float(row.get("n_odds_open"))
        hit_rate   = _safe_float(row.get("hit_rate"))    # decimal
        avg_prob   = _safe_float(row.get("avg_model_prob"))  # decimal

        # These are in PERCENTAGE POINTS in odds_validation.csv
        open_edge  = _safe_float(row.get("opening_edge_pct"))
        close_edge = _safe_float(row.get("closing_edge_pct"))
        ev_open    = _safe_float(row.get("ev_opening"))
        roi_open   = _safe_float(row.get("roi_opening"))   # decimal

        cal_diff   = cal_lookup.get((league, side))  # decimal

        # Zone-level calibration diff (decimal)
        zone_cal_diff = None
        if hit_rate is not None and avg_prob is not None:
            zone_cal_diff = round(hit_rate - avg_prob, 4)

        if threshold is None or n_zone is None:
            continue

        n = int(n_zone)

        # Classification logic
        # open_edge and close_edge are pct points; min_pass_open/close_edge also pct points
        has_positive_open  = open_edge  is not None and open_edge  > min_pass_open_edge
        has_positive_close = close_edge is not None and close_edge > min_pass_close_edge
        has_min_n          = n >= min_pass_n
        has_positive_roi   = roi_open   is not None and roi_open   > min_pass_roi

        if has_positive_open and has_positive_close and has_min_n and has_positive_roi:
            classification = "Pass"
            reason = (
                f"OpenEdge {_pct_pts(open_edge)}, CloseEdge {_pct_pts(close_edge)}, "
                f"ROI {_roi_pct(roi_open)}, N={n}"
            )
        elif has_positive_open and has_positive_close:
            roi_above_floor = (roi_open is None) or (roi_open >= watch_roi_floor)
            if not has_min_n and roi_above_floor:
                classification = "Watchlist"
                reason = f"Small sample N={n} (need >={min_pass_n})"
            elif has_min_n and not has_positive_roi and roi_above_floor:
                classification = "Watchlist"
                reason = (
                    f"ROI {_roi_pct(roi_open)} weak but above floor "
                    f"({_roi_pct(watch_roi_floor)}); OpenEdge {_pct_pts(open_edge)}"
                )
            elif not has_min_n and not roi_above_floor:
                classification = "Reject"
                reason = (
                    f"Small sample N={n} and ROI {_roi_pct(roi_open)} "
                    f"below watch floor ({_roi_pct(watch_roi_floor)})"
                )
            else:
                classification = "Reject"
                reason = (
                    f"Positive edges but ROI {_roi_pct(roi_open)} "
                    f"below watch floor ({_roi_pct(watch_roi_floor)})"
                )
        else:
            classification = "Reject"
            parts = []
            if not has_positive_open:
                parts.append(f"OpenEdge {_pct_pts(open_edge)}")
            if not has_positive_close:
                parts.append(f"CloseEdge {_pct_pts(close_edge)}")
            if not parts:
                parts.append(f"ROI {_roi_pct(roi_open)}")
            reason = "Negative edge: " + ", ".join(parts)

        classified_rows.append({
            "league":           league,
            "side":             side,
            "threshold":        threshold,
            "n":                n,
            "hit_rate":         hit_rate,         # decimal, formatted with _pct_dec in display
            "avg_model_prob":   avg_prob,         # decimal
            "calibration_diff": zone_cal_diff,    # decimal
            "overall_cal_diff": cal_diff,         # decimal
            "opening_edge_pct": open_edge,        # pct points
            "ev_opening":       ev_open,           # decimal
            "roi_opening":      roi_open,          # decimal
            "closing_edge_pct": close_edge,        # pct points
            "classification":   classification,
            "reason":           reason,
        })

    if not classified_rows:
        return pd.DataFrame()

    df_out = pd.DataFrame(classified_rows)

    order = {"Pass": 0, "Watchlist": 1, "Reject": 2}
    df_out["_sort_class"] = df_out["classification"].map(order)
    df_out["_sort_roi"]   = df_out["roi_opening"].fillna(-999.0)
    df_out = df_out.sort_values(["_sort_class", "_sort_roi"], ascending=[True, False])
    df_out = df_out.drop(columns=["_sort_class", "_sort_roi"])

    return df_out


# ---------------------------------------------------------------------------
# Console printing
# ---------------------------------------------------------------------------

def _print_header(title: str, width: int = 78) -> None:
    print()
    print("━" * width)
    print(f"  {title}")
    print("━" * width)


def _print_reliability(rel_df: pd.DataFrame, min_n_display: int = 5) -> None:
    _print_header("TABLE A — RELIABILITY BY PROBABILITY BIN")
    print("  calibration_diff = actual_hit_rate - mean_model_prob")
    print("  > 0: model underconfident   < 0: model overconfident")
    print("  ◀ = |calibration_diff| > 5%")
    print()

    if rel_df.empty:
        print("  No reliability data available.")
        return

    for (league, side), grp in rel_df.groupby(["league", "side"]):
        grp = grp[grp["n"] >= min_n_display]
        if grp.empty:
            continue
        print(f"  {league} / {side}")
        print(f"  {'Bin':<12} {'N':>5}  {'MeanProb':>9}  {'HitRate':>9}  {'CalDiff':>9}")
        print(f"  {'─'*52}")
        for _, row in grp.iterrows():
            # calibration_diff is decimal → _pct_dec multiplies by 100
            diff_str = _pct_dec(row["calibration_diff"])
            marker   = "  ◀" if abs(float(row["calibration_diff"])) > 0.05 else ""
            print(
                f"  {row['bin_lo']:.2f}–{row['bin_hi']:.2f}    "
                f"{int(row['n']):>5}  "
                f"{_pct_dec(row['mean_model_prob']):>9}  "
                f"{_pct_dec(row['actual_hit_rate']):>9}  "
                f"{diff_str:>9}{marker}"
            )
        print()


def _print_bias_summary(bias_df: pd.DataFrame) -> None:
    _print_header("TABLE C — LEAGUE + SIDE BIAS SUMMARY  (all holdout matches)")
    print("  calibration_diff > 0: model underconfident (actual > predicted)")
    print("  calibration_diff < 0: model overconfident  (actual < predicted)")
    print("  ◀ = |calibration_diff| > 5%")
    print()

    if bias_df.empty:
        print("  No bias data available.")
        return

    print(f"  {'League':<14} {'Side':<6}  {'N':>6}  {'MeanProb':>9}  "
          f"{'HitRate':>9}  {'CalDiff':>9}")
    print(f"  {'─'*64}")

    for _, row in bias_df.iterrows():
        # All three are decimal values → use _pct_dec
        diff_str = _pct_dec(row["calibration_diff"])
        marker   = "  ◀" if abs(float(row["calibration_diff"])) > 0.05 else ""
        print(
            f"  {str(row['league']):<14} {str(row['side']):<6}  "
            f"{int(row['n']):>6}  "
            f"{_pct_dec(row['mean_model_prob']):>9}  "
            f"{_pct_dec(row['actual_hit_rate']):>9}  "
            f"{diff_str:>9}{marker}"
        )


def _print_zone_classification(class_df: pd.DataFrame) -> None:
    _print_header("TABLE B — ZONE CLASSIFICATION")
    print("  Pass = meets all thresholds  |  "
          "Watchlist = edges positive but weak  |  Reject = fails edge check")
    print()

    if class_df.empty:
        print("  No classification data — ensure outputs/odds_validation.csv exists.")
        return

    for cls in ["Pass", "Watchlist", "Reject"]:
        sub = class_df[class_df["classification"] == cls]
        if sub.empty:
            continue
        print(f"  ── {cls.upper()} ({len(sub)}) ──")
        print(
            f"  {'League':<14} {'Side':<6} {'Thresh':>6}  {'N':>5}  "
            f"{'Hit%':>7}  {'CalDiff':>8}  {'OpenEdge':>9}  "
            f"{'ROI_Open':>9}  {'CloseEdge':>10}"
        )
        print(f"  {'─'*86}")
        for _, row in sub.iterrows():
            # hit_rate is decimal → _pct_dec
            # calibration_diff is decimal → _pct_dec
            # opening_edge_pct is pct points → _pct_pts
            # roi_opening is decimal → _roi_pct
            # closing_edge_pct is pct points → _pct_pts
            print(
                f"  {str(row['league']):<14} {str(row['side']):<6} "
                f"{float(row['threshold']):>6.2f}  "
                f"{int(row['n']):>5}  "
                f"{_pct_dec(row['hit_rate']):>7}  "
                f"{_pct_dec(row['calibration_diff']):>8}  "
                f"{_pct_pts(row['opening_edge_pct']):>9}  "
                f"{_roi_pct(row['roi_opening']):>9}  "
                f"{_pct_pts(row['closing_edge_pct']):>10}"
            )
            print(f"    ↳ {row['reason']}")
        print()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(
        description="Calibration analysis for Poisson O/U 2.5 discovery zones."
    )
    parser.add_argument(
        "--leagues",
        nargs="+",
        metavar="LEAGUE",
        help="Restrict to these league labels (e.g. EPL Bundesliga). Default: all.",
    )
    parser.add_argument(
        "--bin-width",
        type=float,
        default=0.05,
        help="Probability bin width for reliability table (default: 0.05).",
    )
    parser.add_argument(
        "--min-n-display",
        type=int,
        default=5,
        help="Min predictions per bin to display in reliability table (default: 5).",
    )
    parser.add_argument(
        "--no-seasons",
        action="store_true",
        help="Skip per-season breakdown in reliability table.",
    )
    parser.add_argument(
        "--min-pass-n",
        type=int,
        default=30,
        help="Minimum N for Pass classification (default: 30).",
    )
    parser.add_argument(
        "--min-pass-roi",
        type=float,
        default=0.0,
        help="Minimum ROI_Open (decimal, e.g. 0.05 = 5%%) for Pass (default: 0.0).",
    )
    parser.add_argument(
        "--min-pass-open-edge",
        type=float,
        default=0.0,
        help="Minimum opening_edge_pct (pct points) for Pass (default: 0.0).",
    )
    parser.add_argument(
        "--min-pass-close-edge",
        type=float,
        default=0.0,
        help="Minimum closing_edge_pct (pct points) for Pass (default: 0.0).",
    )
    parser.add_argument(
        "--watch-roi-floor",
        type=float,
        default=-0.05,
        help="ROI_Open floor (decimal) for Watchlist; below this → Reject. Default: -0.05.",
    )
    args = parser.parse_args()

    # ── Discovery warning ─────────────────────────────────────────────────
    print()
    print("━" * 72)
    print("  HISTORICAL VALIDATION ONLY — NOT PROOF OF LIVE EDGE")
    print("━" * 72)
    print("  Calibration uses football-data.co.uk aggregated historical odds.")
    print("  Pass/Watchlist zones still require live odds validation before use.")
    print("  All results are based on holdout back-test, not forward testing.")
    print("━" * 72)

    print(f"\nClassification thresholds:")
    print(f"  Pass:      N >= {args.min_pass_n}, "
          f"OpenEdge > {args.min_pass_open_edge}%, "
          f"CloseEdge > {args.min_pass_close_edge}%, "
          f"ROI_Open > {args.min_pass_roi * 100:.1f}%")
    print(f"  Watchlist: OpenEdge > 0 AND CloseEdge > 0, "
          f"ROI_Open >= {args.watch_roi_floor * 100:.1f}% (but fails Pass)")
    print(f"  Reject:    everything else")

    # ── Load JSON files ───────────────────────────────────────────────────
    print(f"\nScanning {OUTPUTS_DIR} for *_poisson.json files ...")
    dfs = _load_all_jsons(args.leagues)

    if not dfs:
        print("No JSON data loaded. Run run_league_scan.py first.", file=sys.stderr)
        return 1

    print(f"Loaded data for: {', '.join(sorted(dfs.keys()))}")

    # ── Reliability table ─────────────────────────────────────────────────
    include_seasons = not args.no_seasons
    try:
        rel_df = _reliability_table(dfs, args.bin_width, include_seasons)
    except Exception as exc:
        print(f"WARNING: reliability table failed: {exc}", file=sys.stderr)
        rel_df = pd.DataFrame()

    # ── Bias summary ──────────────────────────────────────────────────────
    try:
        bias_df = _bias_summary(dfs)
    except Exception as exc:
        print(f"WARNING: bias summary failed: {exc}", file=sys.stderr)
        bias_df = pd.DataFrame()

    # ── Load odds validation ──────────────────────────────────────────────
    if not ODDS_CSV.exists():
        print(
            f"\nWARNING: {ODDS_CSV} not found. Zone classification will be skipped.",
            file=sys.stderr,
        )
        print("  Run: python evaluate_odds.py")
        odds_df = pd.DataFrame()
    else:
        try:
            odds_df = pd.read_csv(ODDS_CSV)
            if args.leagues:
                odds_df = odds_df[odds_df["league"].isin(args.leagues)]
        except Exception as exc:
            print(f"WARNING: could not read {ODDS_CSV}: {exc}", file=sys.stderr)
            odds_df = pd.DataFrame()

    # ── Zone classification ───────────────────────────────────────────────
    class_df = pd.DataFrame()
    if not odds_df.empty:
        try:
            class_df = _classify_zones(
                odds_df,
                rel_df,
                min_pass_n=args.min_pass_n,
                min_pass_roi=args.min_pass_roi,
                min_pass_open_edge=args.min_pass_open_edge,
                min_pass_close_edge=args.min_pass_close_edge,
                watch_roi_floor=args.watch_roi_floor,
            )
        except Exception as exc:
            print(f"WARNING: zone classification failed: {exc}", file=sys.stderr)

    # ── Print tables ──────────────────────────────────────────────────────
    _print_bias_summary(bias_df)
    _print_reliability(
        rel_df if not rel_df.empty else pd.DataFrame(),
        min_n_display=args.min_n_display,
    )
    _print_zone_classification(class_df)

    # ── Write calibration CSV ─────────────────────────────────────────────
    if not class_df.empty:
        CALIBRATION_CSV.parent.mkdir(parents=True, exist_ok=True)
        csv_cols = [
            "league", "side", "threshold", "n",
            "hit_rate", "avg_model_prob", "calibration_diff", "overall_cal_diff",
            "opening_edge_pct", "ev_opening", "roi_opening",
            "closing_edge_pct",
            "classification", "reason",
        ]
        csv_cols = [c for c in csv_cols if c in class_df.columns]
        class_df[csv_cols].to_csv(CALIBRATION_CSV, index=False)
        print(f"\nWrote {len(class_df)} rows to {CALIBRATION_CSV}")

        counts = class_df["classification"].value_counts()
        print(f"\n  Pass: {counts.get('Pass', 0)}  "
              f"Watchlist: {counts.get('Watchlist', 0)}  "
              f"Reject: {counts.get('Reject', 0)}")
    else:
        print(
            "\nNo classification rows produced — "
            "check that outputs/odds_validation.csv exists and is non-empty."
        )

    print()
    print("━" * 72)
    print("  Calibration analysis complete.")
    print("  Pass/Watchlist zones are discovery candidates only.")
    print("  Live odds validation required before any production use.")
    print("━" * 72)

    return 0


if __name__ == "__main__":
    sys.exit(main())
