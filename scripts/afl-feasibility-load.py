"""
afl-feasibility-load.py
=======================
GoalScout — AFL Line/Spread Feasibility Study
Step 1: Load, clean, and verify the AusSportsBetting AFL dataset.

Inputs
------
data/research/afl/aussportsbetting-afl-*.xlsx
  - Headers are on Excel row 2, so read with header=1.
  - Personal-use only per AusSportsBetting terms; do not commit this file.

Outputs
-------
data/processed/afl-matches.parquet     (gitignored — contains raw odds)
data/processed/afl-matches-summary.csv (committed — aggregate stats only)

Usage
-----
python scripts/afl-feasibility-load.py
python scripts/afl-feasibility-load.py --xlsx path/to/custom.xlsx
python scripts/afl-feasibility-load.py --debug   # prints extra rows during verification
"""

import argparse
import sys
from pathlib import Path
from typing import Optional

import pandas as pd


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

# Columns we require from the xlsx. Renamed to clean snake_case for processing.
REQUIRED_COLUMNS = {
    "Date": "date",
    "Kick Off (local)": "kick_off_local",
    "Home Team": "home_team",
    "Away Team": "away_team",
    "Venue": "venue",
    "Home Score": "home_score",
    "Away Score": "away_score",
    "Play Off Game?": "is_finals",
    "Home Odds Close": "home_odds_close",
    "Away Odds Close": "away_odds_close",
    "Home Line Close": "home_line_close",
    "Away Line Close": "away_line_close",
    "Home Line Odds Close": "home_line_odds_close",
    "Away Line Odds Close": "away_line_odds_close",
}

# Seasons and their expected row counts from the pre-flight (±2 tolerance).
# 2009–2012 excluded (no closing-line data). 2020 excluded (COVID quarters).
# 2026 excluded (partial season, reserved for live paper-tracking).
EXCLUDED_SEASONS_HARD = {2009, 2010, 2011, 2012, 2020, 2026}

# Pre-flight row counts for post-2013 seasons (tolerance ±2).
EXPECTED_ROWS_BY_SEASON = {
    2013: 207, 2014: 207, 2015: 206, 2016: 207, 2017: 207,
    2018: 207, 2019: 207, 2021: 207, 2022: 207, 2023: 216,
    2024: 216, 2025: 216,
}

# H2H overround cap. Rows above this are not bettable in practice.
MAX_H2H_OVERROUND = 1.10

# Line odds values that indicate a data error.
INVALID_LINE_ODDS = {0.0}

# H2H odds values that indicate a data error (1.000 = even-money payout placeholder).
INVALID_H2H_ODDS = {1.0}

# Float tolerance for handicap symmetry check.
SYMMETRY_TOLERANCE = 0.01

# Sign convention: confirmed correct value to verify.
# "home covers if (home_score - away_score) + home_line_close > 0"
# i.e. home_line_close < 0 means home is favoured.
# We cannot assert on a specific match without seeing the data, so we instead:
#   (a) assert symmetry programmatically, and
#   (b) print the 5 clearest home-favourite rows for human eyeball verification.
SIGN_CONVENTION_SAMPLE_N = 5


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def log(msg: str) -> None:
    print(msg, flush=True)


def drop_with_count(
    df: pd.DataFrame,
    mask: pd.Series,
    reason: str,
    cleaning_log: Optional[list] = None,
) -> pd.DataFrame:
    """Drop rows where mask is True, log count, optionally append to cleaning_log."""
    n_before = len(df)
    n = mask.sum()
    if n:
        log(f"  DROP  {n:>5} rows — {reason}")
    else:
        log(f"  OK    {n:>5} rows would drop — {reason}")
    result = df[~mask].copy()
    if cleaning_log is not None:
        cleaning_log.append({
            "step": reason,
            "rows_before": n_before,
            "rows_dropped": int(n),
            "rows_after": len(result),
            "pct_dropped": round(100 * n / n_before, 4) if n_before else 0.0,
        })
    return result


# ---------------------------------------------------------------------------
# Step 1: Find and load the xlsx
# ---------------------------------------------------------------------------

def find_xlsx(override: Optional[str]) -> Path:
    if override:
        p = Path(override)
        if not p.exists():
            sys.exit(f"ERROR: --xlsx path not found: {p}")
        return p

    candidates = sorted(Path("data/research/afl").glob("aussportsbetting-afl*.xlsx"))
    if not candidates:
        sys.exit(
            "ERROR: No aussportsbetting-afl*.xlsx found in data/research/afl/\n"
            "       Download from https://www.aussportsbetting.com/data/historical-afl-results-and-odds-data/\n"
            "       Save as data/research/afl/aussportsbetting-afl-YYYY-MM-DD.xlsx"
        )
    if len(candidates) > 1:
        log(f"WARNING: Multiple xlsx files found; using most recent: {candidates[-1]}")
    return candidates[-1]


def load_xlsx(path: Path) -> pd.DataFrame:
    log(f"\n--- Loading {path.name} ---")
    # Headers are on Excel row 2, so header=1 (0-indexed).
    raw = pd.read_excel(path, sheet_name="Data", header=1, dtype=str)
    log(f"  Raw shape: {raw.shape[0]} rows × {raw.shape[1]} columns")
    return raw


# ---------------------------------------------------------------------------
# Step 2: Select and rename required columns
# ---------------------------------------------------------------------------

def select_columns(raw: pd.DataFrame) -> pd.DataFrame:
    log("\n--- Selecting required columns ---")
    missing = [c for c in REQUIRED_COLUMNS if c not in raw.columns]
    if missing:
        sys.exit(
            f"ERROR: Required columns not found in xlsx:\n  {missing}\n"
            f"Available columns:\n  {raw.columns.tolist()}"
        )
    df = raw[list(REQUIRED_COLUMNS.keys())].rename(columns=REQUIRED_COLUMNS).copy()
    log(f"  Selected {len(REQUIRED_COLUMNS)} columns. Rows: {len(df)}")
    return df


# ---------------------------------------------------------------------------
# Step 3: Parse types
# ---------------------------------------------------------------------------

def parse_types(df: pd.DataFrame) -> pd.DataFrame:
    log("\n--- Parsing column types ---")

    df["date"] = pd.to_datetime(df["date"], errors="coerce")
    df["season"] = df["date"].dt.year

    for col in ["home_score", "away_score"]:
        df[col] = pd.to_numeric(df[col], errors="coerce")

    for col in [
        "home_odds_close", "away_odds_close",
        "home_line_close", "away_line_close",
        "home_line_odds_close", "away_line_odds_close",
    ]:
        df[col] = pd.to_numeric(df[col], errors="coerce")

    # is_finals: treat any truthy non-empty string as True
    df["is_finals"] = df["is_finals"].fillna("").str.strip().str.upper().isin(["Y", "YES", "TRUE", "1"])

    log(f"  Date range: {df['date'].min().date()} → {df['date'].max().date()}")
    log(f"  Seasons: {sorted(df['season'].dropna().astype(int).unique())}")
    return df


# ---------------------------------------------------------------------------
# Step 4: Apply cleaning rules (per study plan Section 1)
# ---------------------------------------------------------------------------

def apply_cleaning_rules(df: pd.DataFrame):
    """Apply cleaning rules 1–7. Returns (cleaned_df, cleaning_log)."""
    log("\n--- Applying cleaning rules ---")
    start = len(df)
    cleaning_log = []

    # Rule 1 — Drop pre-2013 and hard-excluded seasons (2020, 2026, etc.)
    df = drop_with_count(
        df,
        df["season"].isin(EXCLUDED_SEASONS_HARD) | (df["season"] < 2013),
        "excluded season (pre-2013, 2020, 2026 partial)",
        cleaning_log,
    )

    # Rule 2 — Drop rows with null home_line_close or home_line_odds_close
    df = drop_with_count(
        df,
        df["home_line_close"].isna() | df["home_line_odds_close"].isna(),
        "null Home Line Close or Home Line Odds Close",
        cleaning_log,
    )

    # Rule 3 — Drop line odds = 0.000
    df = drop_with_count(
        df,
        df["home_line_odds_close"].isin(INVALID_LINE_ODDS) |
        df["away_line_odds_close"].isin(INVALID_LINE_ODDS),
        "line odds = 0.000 (data error)",
        cleaning_log,
    )

    # Rule 4 — Drop H2H odds = 1.000
    df = drop_with_count(
        df,
        df["home_odds_close"].isin(INVALID_H2H_ODDS) |
        df["away_odds_close"].isin(INVALID_H2H_ODDS),
        "H2H odds = 1.000 (data error / placeholder)",
        cleaning_log,
    )

    # Rule 5 — Drop rows where handicap symmetry fails
    symmetry_ok = (df["home_line_close"] + df["away_line_close"]).abs() <= SYMMETRY_TOLERANCE
    df = drop_with_count(
        df,
        ~symmetry_ok,
        "handicap symmetry failed (home_line + away_line ≠ 0)",
        cleaning_log,
    )

    # Rule 6 — Drop rows with null match scores (abandoned / postponed)
    df = drop_with_count(
        df,
        df["home_score"].isna() | df["away_score"].isna(),
        "null match scores (abandoned or postponed)",
        cleaning_log,
    )

    # Rule 7 — Drop rows with H2H overround > MAX_H2H_OVERROUND (not bettable)
    df["h2h_overround"] = (1 / df["home_odds_close"]) + (1 / df["away_odds_close"])
    df = drop_with_count(
        df,
        df["h2h_overround"] > MAX_H2H_OVERROUND,
        f"H2H overround > {MAX_H2H_OVERROUND:.0%} (outlier; not bettable)",
        cleaning_log,
    )

    end = len(df)
    pct_kept = 100 * end / start if start else 0
    log(f"\n  Before cleaning: {start:,} rows")
    log(f"  After cleaning:  {end:,} rows ({pct_kept:.1f}% retained)")

    return df, cleaning_log


# ---------------------------------------------------------------------------
# Step 5: Derive target columns
# ---------------------------------------------------------------------------

def derive_columns(df: pd.DataFrame) -> pd.DataFrame:
    log("\n--- Deriving target columns ---")

    df["margin"] = df["home_score"] - df["away_score"]

    # Market baseline: the closing line expressed as a predicted margin.
    # Convention: home_line_close < 0 means home favoured, so market predicts
    # a positive home margin. Evaluation scripts use this as the benchmark.
    df["market_predicted_margin"] = -df["home_line_close"]

    # home_covered: True if home team covered the handicap.
    # Convention: home_line_close < 0 means home is favoured.
    # home_covered = 1 if (margin + home_line_close) > 0
    # Pushes (== 0) treated as void — excluded from CLV evaluation later.
    df["cover_raw"] = df["margin"] + df["home_line_close"]
    df["home_covered"] = df["cover_raw"].apply(
        lambda x: 1 if x > 0 else (0 if x < 0 else None)
    )

    n_pushes = df["home_covered"].isna().sum()
    if n_pushes:
        log(f"  NOTE: {n_pushes} push(es) detected (cover_raw == 0) — treated as void")
    else:
        log("  Pushes: 0 (as expected with half-point lines)")

    log(f"  Margin range: {df['margin'].min():.0f} → {df['margin'].max():.0f} points")
    log(f"  Margin mean:  {df['margin'].mean():.1f} (positive = home advantage)")
    return df


# ---------------------------------------------------------------------------
# Step 6: Sign convention verification (human eyeball)
# ---------------------------------------------------------------------------

def verify_sign_convention(df: pd.DataFrame, debug: bool = False) -> None:
    log("\n--- Sign convention verification ---")

    # (a) Programmatic: assert handicap symmetry already applied in cleaning.
    # We re-confirm here as a belt-and-suspenders check after all derivations.
    sym = (df["home_line_close"] + df["away_line_close"]).abs().max()
    log(f"  Max |home_line + away_line| across all rows: {sym:.4f} (expect ≤ {SYMMETRY_TOLERANCE})")
    if sym > SYMMETRY_TOLERANCE:
        log("  WARNING: Symmetry check failed — investigate before proceeding.")

    # (b) Cover rate aggregate — should be ~50% if the closing line is efficient.
    valid = df["home_covered"].notna()
    cover_rate = df.loc[valid, "home_covered"].mean()
    n_picks = valid.sum()
    log(f"\n  Home-covered rate across all post-2013 rows: {cover_rate:.3f} ({n_picks:,} matches)")
    log("  Expected: ~0.500 (closing line is efficient by design)")
    if abs(cover_rate - 0.5) > 0.03:
        log("  WARNING: Cover rate deviates from 0.500 by >3%. Investigate odds-source before continuing.")

    # (c) Human eyeball: 5 clearest home favourites.
    log(f"\n  ── Top {SIGN_CONVENTION_SAMPLE_N} clearest home favourites (most negative home_line_close) ──")
    log("  Confirm: margin should generally be positive (home won) for these rows.")
    log("  Confirm: home_line_close should be negative (home is favoured).")
    log("")
    sample = (
        df[df["home_line_close"] < 0]
        .nsmallest(SIGN_CONVENTION_SAMPLE_N, "home_line_close")
        [["season", "date", "home_team", "away_team", "home_line_close", "margin", "home_covered"]]
    )
    log(sample.to_string(index=False))

    # (d) Human eyeball: 5 clearest away favourites.
    log(f"\n  ── Top {SIGN_CONVENTION_SAMPLE_N} clearest away favourites (most positive home_line_close) ──")
    log("  Confirm: margin should generally be negative (home lost) for these rows.")
    log("  Confirm: home_line_close should be positive (away is favoured).")
    log("")
    sample2 = (
        df[df["home_line_close"] > 0]
        .nlargest(SIGN_CONVENTION_SAMPLE_N, "home_line_close")
        [["season", "date", "home_team", "away_team", "home_line_close", "margin", "home_covered"]]
    )
    log(sample2.to_string(index=False))

    log("\n  ACTION: Visually confirm the above rows match your knowledge of those fixtures.")
    log("  If home_line_close sign is inverted, update the cover_raw formula in derive_columns()")
    log("  and document the correct convention in AFL-FEASIBILITY-PRE-REG.md.")


# ---------------------------------------------------------------------------
# Step 7: Per-season row count check
# ---------------------------------------------------------------------------

def check_season_row_counts(df: pd.DataFrame) -> None:
    log("\n--- Season row count check (vs pre-flight expected) ---")
    actual = df.groupby("season").size().to_dict()
    all_ok = True
    for season, expected in sorted(EXPECTED_ROWS_BY_SEASON.items()):
        got = actual.get(season, 0)
        diff = got - expected
        flag = "✓" if abs(diff) <= 2 else "⚠ MISMATCH"
        log(f"  {season}: expected {expected:>3}, got {got:>3} (diff {diff:+d})  {flag}")
        if abs(diff) > 2:
            all_ok = False
    # Report any unexpected seasons in the cleaned data
    unexpected = set(actual.keys()) - set(EXPECTED_ROWS_BY_SEASON.keys())
    for s in sorted(unexpected):
        log(f"  {s}: unexpected season in cleaned output — {actual[s]} rows  ⚠")
        all_ok = False
    if all_ok:
        log("  All season counts within ±2 of pre-flight expectations.")
    else:
        log("  WARNING: One or more cleaned season counts differs from raw pre-flight counts. This may be expected if cleaning rules removed rows in that season. Check afl-cleaning-summary.csv before treating as a blocker.")


# ---------------------------------------------------------------------------
# Step 8: Write outputs
# ---------------------------------------------------------------------------

def write_outputs(df: pd.DataFrame, cleaning_log: list) -> dict:
    log("\n--- Writing outputs ---")
    out_dir = Path("data/processed")
    out_dir.mkdir(parents=True, exist_ok=True)

    # Parquet — full cleaned dataset (gitignored; contains raw odds)
    parquet_path = out_dir / "afl-matches.parquet"
    df.to_parquet(parquet_path, index=False)
    log(f"  Written: {parquet_path}  ({parquet_path.stat().st_size / 1024:.1f} KB)  [gitignored]")

    # Season summary CSV — aggregate stats only (committed; no row-level odds)
    summary = _build_summary(df)
    csv_path = out_dir / "afl-matches-summary.csv"
    summary.to_csv(csv_path, index=False)
    log(f"  Written: {csv_path}  [{csv_path.stat().st_size} bytes]  [committed]")

    # Cleaning audit CSV — step names and counts only (committed; no odds)
    cleaning_df = pd.DataFrame(cleaning_log)
    cleaning_csv_path = out_dir / "afl-cleaning-summary.csv"
    cleaning_df.to_csv(cleaning_csv_path, index=False)
    log(f"  Written: {cleaning_csv_path}  [{cleaning_csv_path.stat().st_size} bytes]  [committed]")

    return {
        "parquet": parquet_path,
        "summary_csv": csv_path,
        "cleaning_csv": cleaning_csv_path,
        "summary": summary,
    }


def _build_summary(df: pd.DataFrame) -> pd.DataFrame:
    """Aggregate stats per season. No row-level odds."""
    valid_cover = df[df["home_covered"].notna()]
    rows = []
    for season, g in df.groupby("season"):
        vc = valid_cover[valid_cover["season"] == season]
        rows.append({
            "season": int(season),
            "total_matches": len(g),
            "finals_matches": int(g["is_finals"].sum()),
            "ha_matches": int((~g["is_finals"]).sum()),
            "null_line_close": int(g["home_line_close"].isna().sum()),
            "pushes": int(g["home_covered"].isna().sum()),
            "mean_margin": round(g["margin"].mean(), 2),
            "std_margin": round(g["margin"].std(), 2),
            "mean_abs_line": round(g["home_line_close"].abs().mean(), 2),
            "home_covered_rate": round(vc["home_covered"].mean(), 4) if len(vc) else None,
            "home_win_rate": round((g["margin"] > 0).mean(), 4),
        })
    return pd.DataFrame(rows)


# ---------------------------------------------------------------------------
# Step 9: Print summary table
# ---------------------------------------------------------------------------

def print_summary(summary: pd.DataFrame) -> None:
    log("\n--- Summary table ---")
    log(summary.to_string(index=False))

    log("\n--- Study phase assignment ---")
    phase_map = {
        2013: "burn-in (Elo init only)",
        **{s: "development" for s in range(2014, 2020)},
        2021: "sensitivity",
        **{s: "validation" for s in [2022, 2023, 2024]},
        2025: "HELD-OUT TEST (do not evaluate until pre-registered)",
    }
    for _, row in summary.iterrows():
        s = int(row["season"])
        phase = phase_map.get(s, "unassigned")
        log(f"  {s}: {row['total_matches']:>3} matches — {phase}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="AFL Feasibility — load and clean AusSportsBetting xlsx")
    parser.add_argument("--xlsx", default=None, help="Path to xlsx (auto-detected if omitted)")
    parser.add_argument("--debug", action="store_true", help="Print extra rows during verification")
    args = parser.parse_args()

    log("=" * 60)
    log("AFL Feasibility Study — Step 1: Load & Clean")
    log("=" * 60)

    xlsx_path = find_xlsx(args.xlsx)
    raw = load_xlsx(xlsx_path)
    df = select_columns(raw)
    df = parse_types(df)
    df, cleaning_log = apply_cleaning_rules(df)
    df = derive_columns(df)
    verify_sign_convention(df, debug=args.debug)
    check_season_row_counts(df)
    outputs = write_outputs(df, cleaning_log)
    print_summary(outputs["summary"])

    log("\n" + "=" * 60)
    log("DONE")
    log(f"  Parquet:          {outputs['parquet']}  (gitignored)")
    log(f"  Summary CSV:      {outputs['summary_csv']}  (commit this)")
    log(f"  Cleaning CSV:     {outputs['cleaning_csv']}  (commit this)")
    log("")
    log("ACCEPTANCE CHECKS:")
    log("  [ ] All season row counts within ±2 of pre-flight expected")
    log("  [ ] Cover rate ~0.500 (±0.030)")
    log("  [ ] Sign convention eyeball confirms home favourites have negative home_line_close")
    log("  [ ] Cleaning dropped <1% of post-2013 rows total")
    log("  [ ] data/processed/afl-matches.parquet exists and is non-empty")
    log("  [ ] data/processed/afl-matches-summary.csv exists and is non-empty")
    log("=" * 60)


if __name__ == "__main__":
    main()