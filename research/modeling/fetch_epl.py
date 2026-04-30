# research/modeling/fetch_epl.py
#
# Milestone 3 data ingestion script.
#
# Downloads completed season CSVs from football-data.co.uk and writes
# a CSV in the schema expected by train_epl.py:
#
#   league,season,date,home_team,away_team,home_goals,away_goals,source
#
# Usage (via Docker, same pattern as test_smoke.py):
#
#   docker run --rm \
#     -v /mnt/user/appdata/goalscout/research/modeling:/work \
#     -w /work \
#     python:3.11-slim \
#     sh -lc "pip install -q -r requirements.txt && python fetch_epl.py"
#
#   python fetch_epl.py --league EPL          # default, writes inputs/epl_matches.csv
#   python fetch_epl.py --league Championship # writes inputs/championship_matches.csv

from __future__ import annotations

import argparse
import csv
import io
import sys
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any

import pandas as pd

# ---------------------------------------------------------------------------
# League registry
#
# To add a new league, add a dict here. Nothing else needs to change.
# URL pattern: https://www.football-data.co.uk/mmz4281/{YYYY}/{div}.csv
# YYYY codes: "2223" = 2022-23, "2324" = 2023-24, "2425" = 2024-25
# ---------------------------------------------------------------------------

LEAGUE_REGISTRY: dict[str, dict[str, Any]] = {
    "EPL": {
        "div":    "E0",
        "label":  "EPL",
        "output": "epl_matches.csv",
        "seasons": [
            ("2223", "2022-23"),
            ("2324", "2023-24"),
            ("2425", "2024-25"),
        ],
        "min_expected_rows": 370,   # 380 matches per full EPL season
    },
    "Championship": {
        "div":    "E1",
        "label":  "Championship",
        "output": "championship_matches.csv",
        "seasons": [
            ("2223", "2022-23"),
            ("2324", "2023-24"),
            ("2425", "2024-25"),
        ],
        "min_expected_rows": 530,   # 552 matches per full Championship season
    },
}

BASE_URL      = "https://www.football-data.co.uk/mmz4281"
OUTPUT_SCHEMA = ["league", "season", "date", "home_team",
                 "away_team", "home_goals", "away_goals", "source"]
SOURCE_TAG    = "football-data.co.uk"
ROOT          = Path(__file__).parent

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _fetch_url(url: str) -> str:
    """Download URL with stdlib urllib — no third-party deps."""
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "GoalScout-research/1.0 (data pipeline)"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8", errors="replace")


def _parse_date(raw: str) -> str:
    """
    Convert DD/MM/YYYY (football-data.co.uk format) to YYYY-MM-DD.
    Returns the original string on failure — train_epl.py will drop
    the row at the invalid_date cleaning stage.
    """
    for fmt in ("%d/%m/%Y", "%d/%m/%y"):
        try:
            return datetime.strptime(raw.strip(), fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return raw.strip()


def _process_season(
    div: str,
    yyyy: str,
    season_label: str,
    league_label: str,
    min_expected: int,
) -> list[dict]:
    """
    Fetch one season CSV and return rows in our output schema.
    Raises on HTTP error or missing required columns.
    """
    url = f"{BASE_URL}/{yyyy}/{div}.csv"
    print(f"  Fetching {url} ...", end=" ", flush=True)

    try:
        raw = _fetch_url(url)
    except Exception as exc:
        print(f"FAILED ({exc})")
        raise

    df = pd.read_csv(io.StringIO(raw), low_memory=False)
    rows_raw = len(df)
    print(f"{rows_raw} rows")

    # Guard against schema changes
    required_src = ["Date", "HomeTeam", "AwayTeam", "FTHG", "FTAG"]
    missing = [c for c in required_src if c not in df.columns]
    if missing:
        raise ValueError(
            f"{url}: missing columns {missing}. "
            "football-data.co.uk may have changed its schema."
        )

    # Drop rows missing any essential field or with non-numeric goals
    df = df.dropna(subset=required_src)
    df = df[pd.to_numeric(df["FTHG"], errors="coerce").notna()]
    df = df[pd.to_numeric(df["FTAG"], errors="coerce").notna()]

    rows_used = len(df)
    dropped   = rows_raw - rows_used
    if dropped:
        print(f"    Dropped {dropped} incomplete/non-numeric rows")

    if rows_used < min_expected:
        print(
            f"  WARNING: only {rows_used} usable rows for {season_label} "
            f"(expected >= {min_expected}). "
            "Season may be incomplete or the file may be truncated."
        )

    rows = []
    for _, r in df.iterrows():
        rows.append({
            "league":     league_label,
            "season":     season_label,
            "date":       _parse_date(str(r["Date"])),
            "home_team":  str(r["HomeTeam"]).strip(),
            "away_team":  str(r["AwayTeam"]).strip(),
            "home_goals": int(float(r["FTHG"])),
            "away_goals": int(float(r["FTAG"])),
            "source":     SOURCE_TAG,
        })

    return rows


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(
        description="Fetch football-data.co.uk CSVs and write a clean match CSV."
    )
    parser.add_argument(
        "--league",
        choices=list(LEAGUE_REGISTRY.keys()),
        default="EPL",
        help="League to fetch (default: EPL).",
    )
    args = parser.parse_args()

    cfg = LEAGUE_REGISTRY[args.league]
    output_csv = ROOT / "inputs" / cfg["output"]
    output_csv.parent.mkdir(parents=True, exist_ok=True)

    print(f"League : {args.league}")
    print(f"Seasons: {[s for _, s in cfg['seasons']]}")
    print(f"Output : {output_csv}\n")

    all_rows: list[dict] = []

    for yyyy, season_label in cfg["seasons"]:
        rows = _process_season(
            cfg["div"], yyyy, season_label, cfg["label"], cfg["min_expected_rows"]
        )
        all_rows.extend(rows)

    if not all_rows:
        print("\nERROR: no rows collected — nothing written.", file=sys.stderr)
        return 1

    # Sort chronologically before writing
    all_rows.sort(key=lambda r: r["date"])

    with output_csv.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=OUTPUT_SCHEMA)
        writer.writeheader()
        writer.writerows(all_rows)

    # ---------- Summary ----------
    print(f"\n{'─' * 40}")
    print(f"{'Season':<16} {'Rows':>6}")
    print(f"{'─' * 40}")
    by_season: dict[str, int] = {}
    for r in all_rows:
        key = r["season"]
        by_season[key] = by_season.get(key, 0) + 1
    for season, count in sorted(by_season.items()):
        flag = "  *** LOW ***" if count < cfg["min_expected_rows"] else ""
        print(f"{season:<16} {count:>6}{flag}")
    print(f"{'─' * 40}")
    print(f"{'TOTAL':<16} {len(all_rows):>6}")
    print(f"{'─' * 40}")
    print(f"\nWrote: {output_csv}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
