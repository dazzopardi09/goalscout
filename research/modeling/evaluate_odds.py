# research/modeling/evaluate_odds.py
#
# Milestone 7: historical odds validation for Poisson discovery zones.
#
# Fetches raw football-data.co.uk Format A CSVs in-memory because odds columns
# are stripped from the cached inputs/*.csv files. Joins those odds to the
# holdout predictions already produced by train_league.py / run_league_scan.py,
# then computes opening/closing odds metrics per league/side/threshold zone.
#
# ┌─────────────────────────────────────────────────────────────────────────┐
# │ WARNING: HISTORICAL VALIDATION ONLY — NOT PROOF OF LIVE EDGE           │
# │                                                                         │
# │ This script uses football-data.co.uk aggregated opening and closing     │
# │ odds, NOT the exact odds captured by GoalScout at tip time.             │
# │ Opening odds are an early-week average; closing odds are more           │
# │ efficient but represent a later point than any real tip.                │
# │ Results show how the Poisson model compares to historical market        │
# │ prices on the holdout set. They do not prove live betting edge.         │
# └─────────────────────────────────────────────────────────────────────────┘
#
# Usage:
#   python evaluate_odds.py
#   python evaluate_odds.py --leagues LeagueTwo Scotland EPL SerieA Championship Bundesliga
#
# Output:
#   outputs/odds_validation.csv

from __future__ import annotations

import argparse
import csv
import io
import json
import math
import sys
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import pandas as pd

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

ROOT = Path(__file__).parent
OUTPUT_CSV = ROOT / "outputs" / "odds_validation.csv"

BASE_URL = "https://www.football-data.co.uk/mmz4281"

SEASONS = [
    ("2223", "2022-23"),
    ("2324", "2023-24"),
    ("2425", "2024-25"),
]

# ---------------------------------------------------------------------------
# League registry — mirrors run_league_scan.py
# ---------------------------------------------------------------------------

LEAGUE_REGISTRY: Dict[str, Dict[str, Any]] = {
    "EPL": {"div": "E0", "label": "EPL", "slug": "epl"},
    "Championship": {"div": "E1", "label": "Championship", "slug": "championship"},
    "LeagueOne": {"div": "E2", "label": "LeagueOne", "slug": "leagueone"},
    "LeagueTwo": {"div": "E3", "label": "LeagueTwo", "slug": "leaguetwo"},
    "Bundesliga": {"div": "D1", "label": "Bundesliga", "slug": "bundesliga"},
    "Bundesliga2": {"div": "D2", "label": "Bundesliga2", "slug": "bundesliga2"},
    "SerieA": {"div": "I1", "label": "SerieA", "slug": "seriea"},
    "SerieB": {"div": "I2", "label": "SerieB", "slug": "serieb"},
    "LaLiga": {"div": "SP1", "label": "LaLiga", "slug": "laliga"},
    "LaLiga2": {"div": "SP2", "label": "LaLiga2", "slug": "laliga2"},
    "Ligue1": {"div": "F1", "label": "Ligue1", "slug": "ligue1"},
    "Ligue2": {"div": "F2", "label": "Ligue2", "slug": "ligue2"},
    "Eredivisie": {"div": "N1", "label": "Eredivisie", "slug": "eredivisie"},
    "Belgium": {"div": "B1", "label": "Belgium", "slug": "belgium"},
    "Portugal": {"div": "P1", "label": "Portugal", "slug": "portugal"},
    "Scotland": {"div": "SC0", "label": "Scotland", "slug": "scotland"},
}

# ---------------------------------------------------------------------------
# Odds column preference chains
# ---------------------------------------------------------------------------

OPENING_OVER_COLS = ["Avg>2.5", "P>2.5", "B365>2.5"]
OPENING_UNDER_COLS = ["Avg<2.5", "P<2.5", "B365<2.5"]

CLOSING_OVER_COLS = ["AvgC>2.5", "PC>2.5", "B365C>2.5"]
CLOSING_UNDER_COLS = ["AvgC<2.5", "PC<2.5", "B365C<2.5"]

# ---------------------------------------------------------------------------
# Threshold zones to evaluate
# ---------------------------------------------------------------------------

OVER_THRESHOLDS = [0.55, 0.60, 0.65, 0.70]
UNDER_THRESHOLDS = [0.45, 0.40, 0.35, 0.30]

SAMPLE_WARNING_MIN = 20

# ---------------------------------------------------------------------------
# HTTP / parsing helpers
# ---------------------------------------------------------------------------

def _fetch_url(url: str) -> str:
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "GoalScout-research/1.0 (odds-validation)"},
    )

    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8", errors="replace")


def _parse_date_str(raw: Any) -> Optional[str]:
    if raw is None:
        return None

    text = str(raw).strip()

    for fmt in ("%d/%m/%Y", "%d/%m/%y"):
        try:
            return datetime.strptime(text, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue

    return None


def _pick_col(df: pd.DataFrame, candidates: List[str]) -> Optional[str]:
    """
    Pick the first candidate column that exists and contains at least one
    numeric value.
    """
    for col in candidates:
        if col not in df.columns:
            continue

        numeric = pd.to_numeric(df[col], errors="coerce")
        if numeric.notna().sum() > 0:
            return col

    return None


# ---------------------------------------------------------------------------
# Fetch raw football-data odds for one Format A league
# ---------------------------------------------------------------------------

def _fetch_raw_odds(cfg: Dict[str, Any]) -> Tuple[Optional[pd.DataFrame], str]:
    """
    Fetch all seasons for one league and keep result + O/U 2.5 odds columns.

    Returns:
        (odds_dataframe | None, odds_source_label)
    """
    div = cfg["div"]

    season_frames: List[pd.DataFrame] = []

    for season_code, season_label in SEASONS:
        url = f"{BASE_URL}/{season_code}/{div}.csv"
        print(f"    Fetching {url} ...", end=" ", flush=True)

        try:
            raw = _fetch_url(url)
        except Exception as exc:
            print(f"FAILED ({exc})")
            continue

        try:
            df_raw = pd.read_csv(io.StringIO(raw), low_memory=False)
        except Exception as exc:
            print(f"PARSE ERROR ({exc})")
            continue

        required = ["Date", "HomeTeam", "AwayTeam", "FTHG", "FTAG"]
        missing = [c for c in required if c not in df_raw.columns]

        if missing:
            print(f"SKIP — missing columns {missing}")
            continue

        df_raw = df_raw.dropna(subset=required)
        df_raw = df_raw[pd.to_numeric(df_raw["FTHG"], errors="coerce").notna()]
        df_raw = df_raw[pd.to_numeric(df_raw["FTAG"], errors="coerce").notna()]

        df_raw["date"] = df_raw["Date"].apply(_parse_date_str)
        df_raw["season"] = season_label
        df_raw["home_goals"] = pd.to_numeric(df_raw["FTHG"], errors="coerce").astype(int)
        df_raw["away_goals"] = pd.to_numeric(df_raw["FTAG"], errors="coerce").astype(int)
        df_raw["home_team"] = df_raw["HomeTeam"].astype(str).str.strip()
        df_raw["away_team"] = df_raw["AwayTeam"].astype(str).str.strip()

        df_raw = df_raw[df_raw["date"].notna()]

        print(f"{len(df_raw)} rows")
        season_frames.append(df_raw)

    if not season_frames:
        return None, "none"

    combined = pd.concat(season_frames, ignore_index=True)

    opening_over_col = _pick_col(combined, OPENING_OVER_COLS)
    opening_under_col = _pick_col(combined, OPENING_UNDER_COLS)
    closing_over_col = _pick_col(combined, CLOSING_OVER_COLS)
    closing_under_col = _pick_col(combined, CLOSING_UNDER_COLS)

    odds_source_parts = []

    if opening_over_col and opening_under_col:
        odds_source_parts.append(f"open={opening_over_col}/{opening_under_col}")
    elif opening_over_col or opening_under_col:
        odds_source_parts.append(
            f"open={opening_over_col or 'missing'}/{opening_under_col or 'missing'}"
        )

    if closing_over_col and closing_under_col:
        odds_source_parts.append(f"close={closing_over_col}/{closing_under_col}")
    elif closing_over_col or closing_under_col:
        odds_source_parts.append(
            f"close={closing_over_col or 'missing'}/{closing_under_col or 'missing'}"
        )

    odds_source = "; ".join(odds_source_parts) if odds_source_parts else "none"

    if opening_over_col:
        combined["_open_over"] = pd.to_numeric(combined[opening_over_col], errors="coerce")
    else:
        combined["_open_over"] = float("nan")

    if opening_under_col:
        combined["_open_under"] = pd.to_numeric(combined[opening_under_col], errors="coerce")
    else:
        combined["_open_under"] = float("nan")

    if closing_over_col:
        combined["_close_over"] = pd.to_numeric(combined[closing_over_col], errors="coerce")
    else:
        combined["_close_over"] = float("nan")

    if closing_under_col:
        combined["_close_under"] = pd.to_numeric(combined[closing_under_col], errors="coerce")
    else:
        combined["_close_under"] = float("nan")

    out = combined[
        [
            "date",
            "home_team",
            "away_team",
            "home_goals",
            "away_goals",
            "season",
            "_open_over",
            "_open_under",
            "_close_over",
            "_close_under",
        ]
    ].copy()

    return out, odds_source


# ---------------------------------------------------------------------------
# Load holdout predictions from existing Poisson model output JSON
# ---------------------------------------------------------------------------

def _load_holdout(slug: str) -> Optional[pd.DataFrame]:
    path = ROOT / "outputs" / f"{slug}_poisson.json"

    if not path.exists():
        return None

    try:
        with path.open(encoding="utf-8") as f:
            doc = json.load(f)
    except Exception as exc:
        print(f"    ERROR reading {path.name}: {exc}")
        return None

    preds = doc.get("predictions", [])

    if not preds:
        return None

    rows: List[Dict[str, Any]] = []

    for p in preds:
        rows.append(
            {
                "date": p.get("date"),
                "home_team": p.get("home_team"),
                "away_team": p.get("away_team"),
                "p_over_2_5": p.get("p_over_2_5"),
                "actual_over_2_5": p.get("actual_over_2_5"),
            }
        )

    df = pd.DataFrame(rows)

    df["date"] = df["date"].astype(str).str.strip()
    df["home_team"] = df["home_team"].astype(str).str.strip()
    df["away_team"] = df["away_team"].astype(str).str.strip()
    df["p_over_2_5"] = pd.to_numeric(df["p_over_2_5"], errors="coerce")

    df = df.dropna(subset=["date", "home_team", "away_team", "p_over_2_5"])

    return df


# ---------------------------------------------------------------------------
# Metrics helpers
# ---------------------------------------------------------------------------

def _valid_odds_mask(series: pd.Series) -> pd.Series:
    numeric = pd.to_numeric(series, errors="coerce")
    return numeric.notna() & (numeric > 1.0)


def _roi_at_odds(outcomes: pd.Series, odds: pd.Series) -> float:
    """
    ROI per one-unit stake.

    outcomes:
        1 = bet wins
        0 = bet loses
    odds:
        decimal odds
    """
    returns = outcomes * (odds - 1.0) + (1 - outcomes) * (-1.0)
    return float(returns.sum() / len(returns))


def _safe_round(v: float, dp: int = 4) -> Any:
    if isinstance(v, float) and math.isnan(v):
        return ""
    return round(float(v), dp)


# ---------------------------------------------------------------------------
# Threshold analysis on joined holdout + odds frame
# ---------------------------------------------------------------------------

def _analyse_zone(
    joined: pd.DataFrame,
    side: str,
    threshold: float,
    label: str,
    odds_source: str,
    n_model_total: int,
) -> Optional[Dict[str, Any]]:
    """
    Compute metrics for one (league, side, threshold) zone.
    """
    work = joined.copy()

    work["_p_under_2_5"] = 1.0 - work["p_over_2_5"]
    work["_actual_over"] = work["actual_over_2_5"].astype(bool).astype(int)
    work["_actual_under"] = (~work["actual_over_2_5"].astype(bool)).astype(int)

    if side == "Over":
        mask = work["p_over_2_5"] >= threshold
        prob_col = "p_over_2_5"
        open_odds_col = "_open_over"
        close_odds_col = "_close_over"
        outcome_col = "_actual_over"
    else:
        mask = work["p_over_2_5"] <= threshold
        prob_col = "_p_under_2_5"
        open_odds_col = "_open_under"
        close_odds_col = "_close_under"
        outcome_col = "_actual_under"

    sub = work[mask].copy()

    if sub.empty:
        return None

    n_zone = len(sub)

    outcomes_all = sub[outcome_col].astype(int)
    hit_rate = float(outcomes_all.mean()) if len(outcomes_all) else float("nan")
    avg_model_prob = float(sub[prob_col].mean())

    open_valid = sub[_valid_odds_mask(sub[open_odds_col])].copy()
    close_valid = sub[_valid_odds_mask(sub[close_odds_col])].copy()

    n_open = len(open_valid)
    n_close = len(close_valid)

    # ---- Opening odds metrics ----
    if n_open > 0:
        open_outcomes = open_valid[outcome_col].astype(int)
        open_probs = open_valid[prob_col].astype(float)
        open_odds = open_valid[open_odds_col].astype(float)

        avg_open_odds = float(open_odds.mean())
        opening_implied = float((1.0 / open_odds).mean())
        opening_edge_pct = float((open_probs - (1.0 / open_odds)).mean() * 100)
        ev_opening = float((open_probs * open_odds - 1.0).mean())
        roi_opening = _roi_at_odds(open_outcomes, open_odds)
    else:
        avg_open_odds = float("nan")
        opening_implied = float("nan")
        opening_edge_pct = float("nan")
        ev_opening = float("nan")
        roi_opening = float("nan")

    # ---- Closing odds metrics ----
    if n_close > 0:
        close_outcomes = close_valid[outcome_col].astype(int)
        close_probs = close_valid[prob_col].astype(float)
        close_odds = close_valid[close_odds_col].astype(float)

        avg_close_odds = float(close_odds.mean())
        closing_implied = float((1.0 / close_odds).mean())
        closing_edge_pct = float((close_probs - (1.0 / close_odds)).mean() * 100)
        ev_closing = float((close_probs * close_odds - 1.0).mean())
        roi_closing = _roi_at_odds(close_outcomes, close_odds)
    else:
        avg_close_odds = float("nan")
        closing_implied = float("nan")
        closing_edge_pct = float("nan")
        ev_closing = float("nan")
        roi_closing = float("nan")

    return {
        "league": label,
        "side": side,
        "threshold": threshold,
        "n_model_preds": n_model_total,
        "n_zone": n_zone,
        "n_odds_open": n_open,
        "n_odds_close": n_close,
        "hit_rate": _safe_round(hit_rate),
        "avg_model_prob": _safe_round(avg_model_prob),
        "avg_opening_odds": _safe_round(avg_open_odds, 3),
        "opening_implied": _safe_round(opening_implied),
        "opening_edge_pct": _safe_round(opening_edge_pct, 2),
        "ev_opening": _safe_round(ev_opening),
        "roi_opening": _safe_round(roi_opening),
        "avg_closing_odds": _safe_round(avg_close_odds, 3),
        "closing_implied": _safe_round(closing_implied),
        "closing_edge_pct": _safe_round(closing_edge_pct, 2),
        "ev_closing": _safe_round(ev_closing),
        "roi_closing": _safe_round(roi_closing),
        "odds_source": odds_source,
        "sample_warning": n_zone < SAMPLE_WARNING_MIN,
    }


# ---------------------------------------------------------------------------
# Formatting helpers
# ---------------------------------------------------------------------------

def _is_missing(v: Any) -> bool:
    return v == "" or (isinstance(v, float) and math.isnan(v))


def _fmt(v: Any, dp: int = 3) -> str:
    if _is_missing(v):
        return "—"

    if isinstance(v, float):
        return f"{v:.{dp}f}"

    return str(v)


def _prob_pct_str(v: Any) -> str:
    """
    Format 0-1 probability values as percentage strings.
    Example: 0.7273 -> 72.7%
    """
    if _is_missing(v):
        return "—"

    return f"{float(v) * 100:.1f}%"


def _edge_pct_str(v: Any) -> str:
    """
    Format already-percentage-point values.
    Example: 8.33 -> +8.3%
    """
    if _is_missing(v):
        return "—"

    value = float(v)

    # Avoid ugly '+-0.0%' / '-0.0%' output caused by tiny rounded values.
    if abs(value) < 0.05:
        value = 0.0

    sign = "+" if value > 0 else ""
    return f"{sign}{value:.1f}%"


def _roi_str(v: Any) -> str:
    """
    Format 0-1 ROI / EV values as percentage strings.
    Example: 0.205 -> +20.5%
    """
    if _is_missing(v):
        return "—"

    sign = "+" if float(v) >= 0 else ""
    return f"{sign}{float(v) * 100:.1f}%"


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(
        description="Historical odds validation for Poisson O/U 2.5 discovery zones."
    )

    parser.add_argument(
        "--leagues",
        nargs="+",
        choices=list(LEAGUE_REGISTRY.keys()),
        default=list(LEAGUE_REGISTRY.keys()),
        metavar="LEAGUE",
        help=(
            "Leagues to evaluate. "
            f"Choices: {', '.join(LEAGUE_REGISTRY.keys())}"
        ),
    )

    args = parser.parse_args()

    print()
    print("━" * 72)
    print("  WARNING: HISTORICAL VALIDATION ONLY — NOT PROOF OF LIVE EDGE")
    print("━" * 72)
    print("  This script uses football-data.co.uk aggregated opening and")
    print("  closing odds, NOT the exact odds GoalScout captured at tip time.")
    print("  Opening odds = early-week average across tracked bookmakers.")
    print("  Closing odds = pre-kickoff average (more efficient, later point).")
    print("  Results show model calibration vs historical market prices")
    print("  on the holdout set only. Do not interpret as live betting edge.")
    print("━" * 72)

    all_rows: List[Dict[str, Any]] = []
    skipped = 0

    for key in args.leagues:
        cfg = LEAGUE_REGISTRY[key]
        label = cfg["label"]
        slug = cfg["slug"]

        print(f"\n[{label}]")

        holdout = _load_holdout(slug)

        if holdout is None:
            print(f"  SKIP — no outputs/{slug}_poisson.json found.")
            print(
                "         Run via Docker from research/modeling, e.g. "
                f"python train_league.py --league {key} --model poisson"
            )
            skipped += 1
            continue

        n_model = len(holdout)
        print(f"  Loaded {n_model} holdout predictions from outputs/{slug}_poisson.json")

        odds_df, odds_source = _fetch_raw_odds(cfg)

        if odds_df is None or odds_df.empty:
            print(f"  SKIP — all season fetches failed for {label}")
            skipped += 1
            continue

        print(f"  Odds source: {odds_source}")

        holdout["date"] = holdout["date"].astype(str).str.strip()
        holdout["home_team"] = holdout["home_team"].astype(str).str.strip()
        holdout["away_team"] = holdout["away_team"].astype(str).str.strip()

        odds_df["date"] = odds_df["date"].astype(str).str.strip()
        odds_df["home_team"] = odds_df["home_team"].astype(str).str.strip()
        odds_df["away_team"] = odds_df["away_team"].astype(str).str.strip()

        joined = holdout.merge(
            odds_df[
                [
                    "date",
                    "home_team",
                    "away_team",
                    "_open_over",
                    "_open_under",
                    "_close_over",
                    "_close_under",
                ]
            ],
            on=["date", "home_team", "away_team"],
            how="left",
        )

        odds_any = joined[
            ["_open_over", "_open_under", "_close_over", "_close_under"]
        ].notna().any(axis=1)

        n_matched_any_odds = int(odds_any.sum())
        n_unmatched = n_model - n_matched_any_odds

        print(
            f"  Join: {n_matched_any_odds}/{n_model} predictions matched at least one odds column "
            f"({n_unmatched} unmatched)"
        )

        if n_unmatched > n_model * 0.20:
            print(
                "  WARNING: >20% of holdout predictions have no odds match. "
                "Team name or date normalisation may differ."
            )

        league_rows: List[Dict[str, Any]] = []

        for threshold in OVER_THRESHOLDS:
            row = _analyse_zone(
                joined=joined,
                side="Over",
                threshold=threshold,
                label=label,
                odds_source=odds_source,
                n_model_total=n_model,
            )

            if row:
                league_rows.append(row)

        for threshold in UNDER_THRESHOLDS:
            row = _analyse_zone(
                joined=joined,
                side="Under",
                threshold=threshold,
                label=label,
                odds_source=odds_source,
                n_model_total=n_model,
            )

            if row:
                league_rows.append(row)

        if league_rows:
            print()
            print(
                f"  {'Side':<6} {'Thresh':>6} {'N':>5} {'OpenN':>6} {'CloseN':>7} "
                f"{'Hit%':>7} {'AvgProb':>8} "
                f"{'AvgOpen':>8} {'OpenEdge':>9} {'EV_Open':>8} {'ROI_Open':>9} "
                f"{'AvgClose':>9} {'CloseEdge':>10}"
            )
            print(f"  {'─' * 118}")

            for r in league_rows:
                warn = " *" if r["sample_warning"] else "  "
                print(
                    f"  {r['side']:<6} {r['threshold']:>6.2f} {r['n_zone']:>5} "
                    f"{r['n_odds_open']:>6} {r['n_odds_close']:>7} "
                    f"{_prob_pct_str(r.get('hit_rate', '')):>7} "
                    f"{_prob_pct_str(r.get('avg_model_prob', '')):>8} "
                    f"{_fmt(r.get('avg_opening_odds', ''), 3):>8} "
                    f"{_edge_pct_str(r.get('opening_edge_pct', '')):>9} "
                    f"{_roi_str(r.get('ev_opening', '')):>8} "
                    f"{_roi_str(r.get('roi_opening', '')):>9} "
                    f"{_fmt(r.get('avg_closing_odds', ''), 3):>9} "
                    f"{_edge_pct_str(r.get('closing_edge_pct', '')):>10}"
                    f"{warn}"
                )

            print(f"  * sample < {SAMPLE_WARNING_MIN} — treat with caution")

        all_rows.extend(league_rows)

    if all_rows:
        OUTPUT_CSV.parent.mkdir(parents=True, exist_ok=True)

        cols = [
            "league",
            "side",
            "threshold",
            "n_model_preds",
            "n_zone",
            "n_odds_open",
            "n_odds_close",
            "hit_rate",
            "avg_model_prob",
            "avg_opening_odds",
            "opening_implied",
            "opening_edge_pct",
            "ev_opening",
            "roi_opening",
            "avg_closing_odds",
            "closing_implied",
            "closing_edge_pct",
            "ev_closing",
            "roi_closing",
            "odds_source",
            "sample_warning",
        ]

        with OUTPUT_CSV.open("w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=cols)
            writer.writeheader()
            writer.writerows(all_rows)

        print(f"\nWrote {len(all_rows)} rows to {OUTPUT_CSV}")

    if all_rows:
        def _sort_key(row: Dict[str, Any]) -> float:
            value = row.get("roi_opening", "")

            if _is_missing(value):
                return -999.0

            return float(value)

        sorted_rows = sorted(all_rows, key=_sort_key, reverse=True)

        print()
        print("━" * 92)
        print("  SUMMARY — sorted by opening ROI (discovery only, N shown)")
        print("━" * 92)
        print(
            f"  {'League':<14} {'Side':<6} {'Thresh':>6} {'N':>5} "
            f"{'OpenN':>6} {'Hit%':>7} {'AvgProb':>8} "
            f"{'OpenEdge':>9} {'EV_Open':>8} {'ROI_Open':>9} {'CloseEdge':>10}"
        )
        print(f"  {'─' * 90}")

        for r in sorted_rows:
            warn = " *" if r["sample_warning"] else "  "
            print(
                f"  {r['league']:<14} {r['side']:<6} {r['threshold']:>6.2f} "
                f"{r['n_zone']:>5} {r['n_odds_open']:>6} "
                f"{_prob_pct_str(r.get('hit_rate', '')):>7} "
                f"{_prob_pct_str(r.get('avg_model_prob', '')):>8} "
                f"{_edge_pct_str(r.get('opening_edge_pct', '')):>9} "
                f"{_roi_str(r.get('ev_opening', '')):>8} "
                f"{_roi_str(r.get('roi_opening', '')):>9} "
                f"{_edge_pct_str(r.get('closing_edge_pct', '')):>10}"
                f"{warn}"
            )

        print(f"  * sample < {SAMPLE_WARNING_MIN}")
        print()
        print("  INTERPRETATION")
        print("  ─────────────────────────────────────────────────────────")
        print("  Opening ROI: back-tested at historical opening average market odds.")
        print("  EV_Open: model-implied expected value at opening average odds.")
        print("  Closing edge: model prob vs closing implied prob; rough CLV proxy.")
        print("  Positive closing edge across many picks is a stronger signal")
        print("  than opening ROI alone, because closing odds are more efficient.")
        print("  None of this uses GoalScout actual tip-time odds.")
        print("  Treat this as historical validation, not proof of live edge.")
        print("━" * 92)

    if skipped:
        print(f"\n  Skipped {skipped} league(s) — missing model output or fetch failure.")

    return 0


if __name__ == "__main__":
    sys.exit(main())
