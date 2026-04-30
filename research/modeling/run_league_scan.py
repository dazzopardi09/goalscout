# research/modeling/run_league_scan.py
#
# Milestone 6: multi-league discovery scan.
#
# Fetches historical match data from football-data.co.uk (Format A leagues only),
# trains a Poisson model per league, and runs threshold analysis across all
# leagues in a single pass. Writes outputs/league_scan_summary.csv.
#
# ┌─────────────────────────────────────────────────────────────────────────┐
# │ DISCOVERY SCAN — NOT PROOF OF EDGE                                      │
# │                                                                         │
# │ This scan tests 128 threshold buckets across 16 leagues.                │
# │ At a 5% false-positive rate, ~6 buckets will look promising by chance.  │
# │ Results require validation against historical bookmaker odds before      │
# │ any conclusions about betting edge can be drawn.                        │
# └─────────────────────────────────────────────────────────────────────────┘
#
# Usage:
#   python run_league_scan.py                              # all supported leagues
#   python run_league_scan.py --leagues EPL Championship  # subset
#   python run_league_scan.py --leagues Bundesliga        # single league
#   python run_league_scan.py --no-cache                  # force re-fetch
#   python run_league_scan.py --dry-run                   # list leagues, no training
#
# Format A leagues (season-by-season files, mmz4281/ path):
#   E0, E1, E2, E3, D1, D2, I1, I2, SP1, SP2, F1, F2, N1, B1, P1, SC0
#
# Planned / unsupported (Format B or alternate data source):
#   Sweden Allsvenskan  — Format B all-seasons file (SWE.csv), parser not yet built
#   Denmark Superliga   — Format B all-seasons file (DNK.csv), parser not yet built
#   Argentina Primera   — Format B (ARG.csv) + non-standard Apertura/Clausura calendar

from __future__ import annotations

import argparse
import csv
import json
import io
import math
import sys
import urllib.request
from collections import Counter
from datetime import datetime, date
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import pandas as pd

from trainer import train_poisson
from scoreline import build_scoreline_matrix
from markets import market_over_under
from evaluator import chronological_holdout_split

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

BASE_URL   = "https://www.football-data.co.uk/mmz4281"
SOURCE_TAG = "football-data.co.uk"
ROOT       = Path(__file__).parent

HOLDOUT_PCT          = 0.20
GOAL_CAP             = 6
LAMBDA_REG           = 0.1
MIN_MATCHES_PER_TEAM = 10

OVER_THRESHOLDS  = [0.55, 0.60, 0.65, 0.70]
UNDER_THRESHOLDS = [0.45, 0.40, 0.35, 0.30]

SAMPLE_STRONG   = 50   # N >= 50: stronger candidate (still discovery only)
SAMPLE_WATCHLIST = 20  # 20 <= N < 50: watchlist
# N < 20: too small to surface in summary

SEASONS = [
    ("2223", "2022-23"),
    ("2324", "2023-24"),
    ("2425", "2024-25"),
]

CSV_COLUMNS = [
    "league", "model", "side", "threshold",
    "count", "hit_rate", "avg_model_prob", "fair_odds",
    "brier", "log_loss", "avg_expected_total_goals",
    "sample_warning", "input_rows", "train_rows", "holdout_rows",
]

OUTPUT_CSV = ROOT / "outputs" / "league_scan_summary.csv"

# ---------------------------------------------------------------------------
# League registry
# ---------------------------------------------------------------------------
# Each entry:
#   key          — CLI name (used in --leagues)
#   div          — football-data.co.uk division code
#   label        — value written to `league` column in our CSV schema
#   slug         — used as the inputs/{slug}_matches.csv filename
#   min_per_season — warn if a season has fewer usable rows than this
#
# Format A URL: https://www.football-data.co.uk/mmz4281/{YYYY}/{div}.csv

LEAGUE_REGISTRY: Dict[str, Dict[str, Any]] = {
    "EPL":          {"div": "E0",  "label": "EPL",            "slug": "epl",            "min_per_season": 370},
    "Championship": {"div": "E1",  "label": "Championship",   "slug": "championship",   "min_per_season": 530},
    "LeagueOne":    {"div": "E2",  "label": "LeagueOne",      "slug": "leagueone",      "min_per_season": 530},
    "LeagueTwo":    {"div": "E3",  "label": "LeagueTwo",      "slug": "leaguetwo",      "min_per_season": 530},
    "Bundesliga":   {"div": "D1",  "label": "Bundesliga",     "slug": "bundesliga",     "min_per_season": 290},
    "Bundesliga2":  {"div": "D2",  "label": "Bundesliga2",    "slug": "bundesliga2",    "min_per_season": 290},
    "SerieA":       {"div": "I1",  "label": "SerieA",         "slug": "seriea",         "min_per_season": 370},
    "SerieB":       {"div": "I2",  "label": "SerieB",         "slug": "serieb",         "min_per_season": 570},
    "LaLiga":       {"div": "SP1", "label": "LaLiga",         "slug": "laliga",         "min_per_season": 370},
    "LaLiga2":      {"div": "SP2", "label": "LaLiga2",        "slug": "laliga2",        "min_per_season": 480},
    "Ligue1":       {"div": "F1",  "label": "Ligue1",         "slug": "ligue1",         "min_per_season": 370},
    "Ligue2":       {"div": "F2",  "label": "Ligue2",         "slug": "ligue2",         "min_per_season": 480},
    "Eredivisie":   {"div": "N1",  "label": "Eredivisie",     "slug": "eredivisie",     "min_per_season": 290},
    "Belgium":      {"div": "B1",  "label": "Belgium",        "slug": "belgium",        "min_per_season": 230},
    "Portugal":     {"div": "P1",  "label": "Portugal",       "slug": "portugal",       "min_per_season": 290},
    "Scotland":     {"div": "SC0", "label": "Scotland",       "slug": "scotland",       "min_per_season": 220},
}

# Leagues on football-data.co.uk but not supported by this script's Format A parser.
# Included here so --dry-run surfaces them clearly.
UNSUPPORTED: Dict[str, str] = {
    "Sweden":    "Format B all-seasons file (new/SWE.csv) — parser not yet built",
    "Denmark":   "Format B all-seasons file (new/DNK.csv) — parser not yet built",
    "Argentina": "Format B (new/ARG.csv) + Apertura/Clausura calendar — requires custom handling",
}

# Leagues GoalScout currently shortlists but that need an alternate data source entirely.
ALTERNATE_SOURCE: Dict[str, str] = {
    "A-League":      "No clean football-data.co.uk source — use Football-Data.org or another provider",
    "South Korea":   "No clean football-data.co.uk source",
    "Brazil SerieA": "Format B (new/BRA.csv) available but season calendar handling needed",
    "Turkey":        "No clean football-data.co.uk source for Süper Lig",
}

# ---------------------------------------------------------------------------
# HTTP + date helpers  (adapted from fetch_epl.py)
# ---------------------------------------------------------------------------

def _fetch_url(url: str) -> str:
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "GoalScout-research/1.0 (league-scan)"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8", errors="replace")


def _parse_date(raw: str) -> Optional[str]:
    for fmt in ("%d/%m/%Y", "%d/%m/%y"):
        try:
            return datetime.strptime(raw.strip(), fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return None


def _to_int_safe(v: Any) -> Optional[int]:
    try:
        iv = int(float(v))
        return iv if iv >= 0 else None
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------------------
# Fetch one league's data (Format A, three seasons)
# ---------------------------------------------------------------------------

def _fetch_league(
    cfg: Dict[str, Any],
    no_cache: bool,
) -> Tuple[List[Dict[str, Any]], int]:
    """
    Fetch or load cached match data for one league across all SEASONS.
    Returns (match_dicts, input_rows_total).
    Raises on total failure (all seasons failed).
    """
    div   = cfg["div"]
    label = cfg["label"]
    slug  = cfg["slug"]
    min_s = cfg["min_per_season"]

    cache_path = ROOT / "inputs" / f"{slug}_matches.csv"

    # ---- Use cache if available and not bypassed ----
    if cache_path.exists() and not no_cache:
        print(f"    Using cached {cache_path.name}")
        df_cache = pd.read_csv(cache_path)
        input_rows = len(df_cache)
        matches = [
            {
                "home_team":  str(r["home_team"]).strip(),
                "away_team":  str(r["away_team"]).strip(),
                "home_goals": int(r["home_goals"]),
                "away_goals": int(r["away_goals"]),
                "date":       date.fromisoformat(str(r["date"])),
            }
            for _, r in df_cache.iterrows()
            if pd.notna(r["home_goals"]) and pd.notna(r["away_goals"])
        ]
        return matches, input_rows

    # ---- Fetch from football-data.co.uk ----
    all_rows: List[Dict[str, Any]] = []
    any_success = False

    for yyyy, season_label in SEASONS:
        url = f"{BASE_URL}/{yyyy}/{div}.csv"
        print(f"    Fetching {url} ...", end=" ", flush=True)
        try:
            raw = _fetch_url(url)
        except Exception as exc:
            print(f"FAILED ({exc}) — skipping season {season_label}")
            continue

        df = pd.read_csv(io.StringIO(raw), low_memory=False)
        rows_raw = len(df)

        required = ["Date", "HomeTeam", "AwayTeam", "FTHG", "FTAG"]
        missing = [c for c in required if c not in df.columns]
        if missing:
            print(f"SKIP — missing columns {missing}")
            continue

        df = df.dropna(subset=required)
        df = df[pd.to_numeric(df["FTHG"], errors="coerce").notna()]
        df = df[pd.to_numeric(df["FTAG"], errors="coerce").notna()]
        rows_used = len(df)
        print(f"{rows_used}/{rows_raw} rows")

        if rows_used < min_s:
            print(
                f"    WARNING: {rows_used} rows for {season_label} "
                f"(expected >= {min_s}) — season may be incomplete"
            )

        for _, r in df.iterrows():
            parsed = _parse_date(str(r["Date"]))
            if parsed is None:
                continue
            hg = _to_int_safe(r["FTHG"])
            ag = _to_int_safe(r["FTAG"])
            if hg is None or ag is None:
                continue
            all_rows.append({
                "league":     label,
                "season":     season_label,
                "date":       parsed,
                "home_team":  str(r["HomeTeam"]).strip(),
                "away_team":  str(r["AwayTeam"]).strip(),
                "home_goals": hg,
                "away_goals": ag,
                "source":     SOURCE_TAG,
            })
        any_success = True

    if not any_success or not all_rows:
        raise RuntimeError(f"All season downloads failed for {label}")

    # Write cache
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    schema = ["league", "season", "date", "home_team",
              "away_team", "home_goals", "away_goals", "source"]
    with cache_path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=schema)
        w.writeheader()
        w.writerows(all_rows)

    input_rows = len(all_rows)
    # Convert to match dicts with date objects for training
    matches = [
        {
            "home_team":  r["home_team"],
            "away_team":  r["away_team"],
            "home_goals": r["home_goals"],
            "away_goals": r["away_goals"],
            "date":       date.fromisoformat(r["date"]),
        }
        for r in all_rows
    ]
    return matches, input_rows


# ---------------------------------------------------------------------------
# Train Poisson on match dicts
# ---------------------------------------------------------------------------

def _train(matches: List[Dict[str, Any]]) -> Any:
    return train_poisson(matches, lambda_reg=LAMBDA_REG, goal_cap=GOAL_CAP)


# ---------------------------------------------------------------------------
# Threshold analysis (in-memory, no JSON written)
# ---------------------------------------------------------------------------

def _brier(probs: List[float], outcomes: List[int]) -> float:
    if not probs:
        return float("nan")
    return sum((p - o) ** 2 for p, o in zip(probs, outcomes)) / len(probs)


def _log_loss(probs: List[float], outcomes: List[int], eps: float = 1e-15) -> float:
    if not probs:
        return float("nan")
    total = 0.0
    for p, o in zip(probs, outcomes):
        pc = min(max(p, eps), 1.0 - eps)
        total += -(o * math.log(pc) + (1 - o) * math.log(1.0 - pc))
    return total / len(probs)


def _analyse_holdout(
    params: Any,
    holdout: List[Dict[str, Any]],
    league_label: str,
    input_rows: int,
    train_rows: int,
) -> List[Dict[str, Any]]:
    """
    Run threshold analysis on holdout matches. Returns list of summary row dicts.
    """
    holdout_rows = len(holdout)
    p_o25_list: List[float] = []
    actual_o25: List[int] = []
    exp_total_list: List[float] = []
    skipped = 0

    for m in holdout:
        if (m["home_team"] not in params.team_strengths
                or m["away_team"] not in params.team_strengths):
            skipped += 1
            continue
        matrix, lh, la = build_scoreline_matrix(params, m["home_team"], m["away_team"])
        ou = market_over_under(matrix, line=2.5)
        actual_total = m["home_goals"] + m["away_goals"]
        p_o25_list.append(ou["over"])
        actual_o25.append(1 if actual_total > 2 else 0)
        exp_total_list.append(lh + la)

    rows: List[Dict[str, Any]] = []

    for t in OVER_THRESHOLDS:
        idx = [i for i, p in enumerate(p_o25_list) if p >= t]
        if not idx:
            continue
        mp    = [p_o25_list[i] for i in idx]
        out   = [actual_o25[i] for i in idx]
        et    = [exp_total_list[i] for i in idx]
        count = len(idx)
        hit   = sum(out) / count
        avg_p = sum(mp) / count
        rows.append({
            "league":                   league_label,
            "model":                    "poisson",
            "side":                     "Over",
            "threshold":                t,
            "count":                    count,
            "hit_rate":                 round(hit, 4),
            "avg_model_prob":           round(avg_p, 4),
            "fair_odds":                round(1.0 / avg_p, 3) if avg_p > 0 else None,
            "brier":                    round(_brier(mp, out), 6),
            "log_loss":                 round(_log_loss(mp, out), 6),
            "avg_expected_total_goals": round(sum(et) / count, 3),
            "sample_warning":           count < SAMPLE_WATCHLIST,
            "input_rows":               input_rows,
            "train_rows":               train_rows,
            "holdout_rows":             holdout_rows,
        })

    for t in UNDER_THRESHOLDS:
        idx = [i for i, p in enumerate(p_o25_list) if p <= t]
        if not idx:
            continue
        mp    = [1.0 - p_o25_list[i] for i in idx]   # model prob for Under side
        out   = [1 - actual_o25[i]   for i in idx]   # 1 if actual was Under
        et    = [exp_total_list[i]    for i in idx]
        count = len(idx)
        hit   = sum(out) / count
        avg_p = sum(mp) / count
        rows.append({
            "league":                   league_label,
            "model":                    "poisson",
            "side":                     "Under",
            "threshold":                t,
            "count":                    count,
            "hit_rate":                 round(hit, 4),
            "avg_model_prob":           round(avg_p, 4),
            "fair_odds":                round(1.0 / avg_p, 3) if avg_p > 0 else None,
            "brier":                    round(_brier(mp, out), 6),
            "log_loss":                 round(_log_loss(mp, out), 6),
            "avg_expected_total_goals": round(sum(et) / count, 3),
            "sample_warning":           count < SAMPLE_WATCHLIST,
            "input_rows":               input_rows,
            "train_rows":               train_rows,
            "holdout_rows":             holdout_rows,
        })

    return rows


# ---------------------------------------------------------------------------
# Write per-league model output JSON (consumed by evaluate_odds.py)
# ---------------------------------------------------------------------------

def _write_model_output_json(
    cfg: Dict[str, Any],
    params: Any,
    holdout: List[Dict[str, Any]],
    input_rows: int,
    train_rows: int,
) -> None:
    """
    Write outputs/{slug}_poisson.json with the fields expected by evaluate_odds.py:
      - league, model, input_rows, train_rows, holdout_rows
      - predictions[]: date, home_team, away_team, p_over_2_5, actual_over_2_5,
                       home_goals, away_goals, expected_home_goals, expected_away_goals

    Silently skips any holdout match whose teams are not in the trained params.
    """
    slug = cfg["slug"]
    label = cfg["label"]
    out_path = ROOT / "outputs" / f"{slug}_poisson.json"

    predictions: List[Dict[str, Any]] = []
    skipped = 0

    for m in holdout:
        if (
            m["home_team"] not in params.team_strengths
            or m["away_team"] not in params.team_strengths
        ):
            skipped += 1
            continue

        matrix, lh, la = build_scoreline_matrix(
            params,
            m["home_team"],
            m["away_team"],
        )
        ou = market_over_under(matrix, line=2.5)
        actual_total = m["home_goals"] + m["away_goals"]

        predictions.append({
            "date": m["date"].isoformat(),
            "home_team": m["home_team"],
            "away_team": m["away_team"],
            "p_over_2_5": round(ou["over"], 4),
            "actual_over_2_5": actual_total > 2,
            "home_goals": m["home_goals"],
            "away_goals": m["away_goals"],
            "expected_home_goals": round(lh, 4),
            "expected_away_goals": round(la, 4),
        })

    doc = {
        "league": label,
        "model": "poisson",
        "input_rows": input_rows,
        "train_rows": train_rows,
        "holdout_rows": len(holdout),
        "predictions": predictions,
    }

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(doc, indent=2), encoding="utf-8")

    skipped_note = f" ({skipped} skipped — unknown teams)" if skipped else ""
    print(
        f"    JSON: wrote {len(predictions)} holdout predictions "
        f"to {out_path.name}{skipped_note}"
    )


# ---------------------------------------------------------------------------
# Console display helpers
# ---------------------------------------------------------------------------

def _r(v: Any, dp: int = 4) -> str:
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return "—"
    return f"{v:.{dp}f}"


def _print_league_table(league: str, rows: List[Dict]) -> None:
    print(f"\n  {'Side':<6}  {'Thresh':>6}  {'N':>5}  {'HitRate':>8}  "
          f"{'AvgProb':>8}  {'FairOdds':>9}  {'Brier':>7}")
    print(f"  {'─'*64}")
    for r in rows:
        warn = " *" if r["sample_warning"] else "  "
        print(
            f"  {r['side']:<6}  {r['threshold']:>6.2f}  {r['count']:>5}  "
            f"{_r(r['hit_rate']):>8}  {_r(r['avg_model_prob']):>8}  "
            f"{_r(r['fair_odds'], 3):>9}  {_r(r['brier'], 5):>7}{warn}"
        )


def _print_discovery_warning(n_leagues: int) -> None:
    n_buckets = n_leagues * (len(OVER_THRESHOLDS) + len(UNDER_THRESHOLDS))
    expected_fp = round(n_buckets * 0.05)
    print()
    print("━" * 72)
    print("  DISCOVERY SCAN — NOT PROOF OF EDGE")
    print("━" * 72)
    print(f"  Testing {n_buckets} threshold buckets across {n_leagues} leagues.")
    print(f"  At a 5% false-positive rate, ~{expected_fp} buckets will look")
    print("  promising by chance alone. All results must be validated against")
    print("  historical bookmaker odds before drawing any conclusions about edge.")
    print("━" * 72)


def _print_final_summary(all_rows: List[Dict]) -> None:
    strong    = [r for r in all_rows if r["count"] >= SAMPLE_STRONG]
    watchlist = [r for r in all_rows if SAMPLE_WATCHLIST <= r["count"] < SAMPLE_STRONG]

    print()
    print("━" * 72)
    print(f"  SUMMARY — large-sample zones (N >= {SAMPLE_STRONG})")
    print("━" * 72)
    if strong:
        print(f"  {'League':<14} {'Side':<6} {'Thresh':>6} {'N':>5} "
              f"{'HitRate':>8} {'AvgProb':>8} {'FairOdds':>9}")
        print(f"  {'─'*62}")
        for r in sorted(strong, key=lambda x: (-x["hit_rate"], x["league"])):
            print(
                f"  {r['league']:<14} {r['side']:<6} {r['threshold']:>6.2f} "
                f"{r['count']:>5} {_r(r['hit_rate']):>8} "
                f"{_r(r['avg_model_prob']):>8} {_r(r['fair_odds'], 3):>9}"
            )
    else:
        print("  None (no bucket with N >= 50 found)")

    print()
    print(f"  WATCHLIST — smaller sample zones ({SAMPLE_WATCHLIST} <= N < {SAMPLE_STRONG})")
    print("━" * 72)
    if watchlist:
        print(f"  {'League':<14} {'Side':<6} {'Thresh':>6} {'N':>5} "
              f"{'HitRate':>8} {'AvgProb':>8}")
        print(f"  {'─'*54}")
        for r in sorted(watchlist, key=lambda x: (-x["hit_rate"], x["league"])):
            print(
                f"  {r['league']:<14} {r['side']:<6} {r['threshold']:>6.2f} "
                f"{r['count']:>5} {_r(r['hit_rate']):>8} "
                f"{_r(r['avg_model_prob']):>8}"
            )
    else:
        print(f"  None")

    print()
    print("  Unsupported / requires alternate data source:")
    print("━" * 72)
    for name, reason in UNSUPPORTED.items():
        print(f"  {name}: {reason}")
    for name, reason in ALTERNATE_SOURCE.items():
        print(f"  {name}: {reason}")
    print()
    print("  Results are discovery only. Validate against historical odds before use.")
    print("━" * 72)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(
        description="Multi-league Poisson O2.5 discovery scan using football-data.co.uk."
    )
    parser.add_argument(
        "--leagues",
        nargs="+",
        choices=list(LEAGUE_REGISTRY.keys()),
        default=list(LEAGUE_REGISTRY.keys()),
        metavar="LEAGUE",
        help=(
            "Leagues to scan (default: all). "
            f"Choices: {', '.join(LEAGUE_REGISTRY.keys())}"
        ),
    )
    parser.add_argument(
        "--no-cache",
        action="store_true",
        help="Force re-fetch from football-data.co.uk even if cached CSV exists.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="List supported/unsupported leagues and planned fetches — no training.",
    )
    args = parser.parse_args()

    selected = args.leagues

    # ---- Dry run ----
    if args.dry_run:
        print("\nSupported leagues (Format A — will be fetched and trained):")
        for key in selected:
            cfg = LEAGUE_REGISTRY[key]
            cache = ROOT / "inputs" / f"{cfg['slug']}_matches.csv"
            status = "cached" if cache.exists() and not args.no_cache else "will fetch"
            print(f"  {key:<14} div={cfg['div']:<4}  [{status}]")
        print("\nUnsupported leagues (Format B or alternate source required):")
        for name, reason in {**UNSUPPORTED, **ALTERNATE_SOURCE}.items():
            print(f"  {name}: {reason}")
        print()
        return 0

    # ---- Discovery warning ----
    _print_discovery_warning(len(selected))

    all_rows: List[Dict] = []
    failed_leagues: List[str] = []

    for key in selected:
        cfg = LEAGUE_REGISTRY[key]
        label = cfg["label"]
        print(f"\n[{label}]")

        # Fetch / load
        try:
            matches, input_rows = _fetch_league(cfg, args.no_cache)
        except Exception as exc:
            print(f"  SKIP — fetch failed: {exc}")
            failed_leagues.append(label)
            continue

        print(f"    {input_rows} rows loaded")

        if len(matches) < 50:
            print(f"  SKIP — too few matches ({len(matches)}) to train meaningfully")
            failed_leagues.append(label)
            continue

        # Split
        try:
            train_matches, holdout_matches = chronological_holdout_split(
                matches, HOLDOUT_PCT
            )
        except Exception as exc:
            print(f"  SKIP — split failed: {exc}")
            failed_leagues.append(label)
            continue

        print(f"    train={len(train_matches)}, holdout={len(holdout_matches)}")

        # Check per-team sample size
        team_counts: Counter = Counter()
        for m in train_matches:
            team_counts[m["home_team"]] += 1
            team_counts[m["away_team"]] += 1
        underweight = [t for t, c in team_counts.items() if c < MIN_MATCHES_PER_TEAM]
        if underweight:
            print(f"    NOTE: {len(underweight)} team(s) with < {MIN_MATCHES_PER_TEAM} training matches")

        # Train
        try:
            params = _train(train_matches)
        except Exception as exc:
            print(f"  SKIP — training failed: {exc}")
            failed_leagues.append(label)
            continue

        print(
            f"    log_likelihood={params.metrics['log_likelihood']:.2f}, "
            f"teams={params.metrics['num_teams']}"
        )

        # Threshold analysis
        rows = _analyse_holdout(params, holdout_matches, label, input_rows,
                                len(train_matches))

        # Write per-league JSON for evaluate_odds.py
        _write_model_output_json(cfg, params, holdout_matches, input_rows,
                                 len(train_matches))

        _print_league_table(label, rows)
        all_rows.extend(rows)

    # ---- Write CSV ----
    if all_rows:
        OUTPUT_CSV.parent.mkdir(parents=True, exist_ok=True)
        with OUTPUT_CSV.open("w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=CSV_COLUMNS)
            writer.writeheader()
            writer.writerows(all_rows)
        print(f"\nWrote {len(all_rows)} rows to {OUTPUT_CSV}")
    else:
        print("\nWARNING: no rows to write — all leagues failed or were skipped.")

    # ---- Final summary ----
    _print_final_summary(all_rows)

    if failed_leagues:
        print(f"\n  Failed/skipped leagues: {', '.join(failed_leagues)}")

    return 0 if not failed_leagues else 1


if __name__ == "__main__":
    sys.exit(main())
