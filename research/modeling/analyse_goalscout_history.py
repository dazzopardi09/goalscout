# research/modeling/analyse_goalscout_history.py
#
# Research-only script. Reads the live GoalScout prediction history, deduplicates,
# and analyses whether model probability showed real edge versus market odds.
#
# Input:  data/history/predictions.jsonl   (relative to repo root)
#         data/history/results.jsonl        (optional, used to resolve old-style records)
# Output: research/modeling/outputs/goalscout_history_edge_analysis.csv
#
# Run from repo root:
#   python research/modeling/analyse_goalscout_history.py
#
# This script does NOT modify predictions.jsonl or any live app file.
#
# Edge field note:
#   GoalScout stores `edge` in PERCENTAGE POINTS, not decimal.
#   Formula (probability.js line 142):
#       edge = (modelProbability / trueMarketProbability - 1) * 100
#   where trueMarketProbability is the margin-stripped market view.
#   So edge = 8.33 means the model is 8.33% above the market's true view.

from __future__ import annotations

import csv
import json
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# ---------------------------------------------------------------------------
# Paths  (all relative to repo root, so the script can be run from there)
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).parent.parent.parent
PREDICTIONS_FILE = REPO_ROOT / "data" / "history" / "predictions.jsonl"
RESULTS_FILE = REPO_ROOT / "data" / "history" / "results.jsonl"
OUTPUT_CSV = Path(__file__).parent / "outputs" / "goalscout_history_edge_analysis.csv"

# ---------------------------------------------------------------------------
# Edge bands — boundaries in PERCENTAGE POINTS, matching stored field scale
# ---------------------------------------------------------------------------

EDGE_BANDS = [
    ("missing", None, None),      # no marketOdds or modelProbability
    ("negative", None, 0.0),      # edge <= 0
    ("0-5%", 0.0, 5.0),
    ("5-10%", 5.0, 10.0),
    ("10%+", 10.0, None),
]


# ---------------------------------------------------------------------------
# JSONL helpers  (stdlib only — mirrors the GoalScout Node implementation)
# ---------------------------------------------------------------------------

def _read_jsonl(path: Path) -> List[Dict[str, Any]]:
    if not path.exists():
        return []

    rows: List[Dict[str, Any]] = []

    with path.open(encoding="utf-8") as f:
        for lineno, line in enumerate(f, 1):
            line = line.strip()

            if not line:
                continue

            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError as e:
                print(
                    f"  WARNING: skipping malformed JSON on line {lineno}: {e}",
                    file=sys.stderr,
                )

    return rows


# ---------------------------------------------------------------------------
# Deduplicate
# ---------------------------------------------------------------------------

def _dedupe(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Keep the last-seen record for each (fixtureId, market, selection, modelVersion).

    'Last-seen' preserves the most-settled version of a record, e.g. a record
    updated with closingOdds/clvPct after initial logging.
    """
    seen: Dict[tuple, Dict[str, Any]] = {}

    for r in rows:
        key = (
            r.get("fixtureId"),
            r.get("market"),
            r.get("selection"),
            r.get("modelVersion"),
        )
        seen[key] = r

    return list(seen.values())


# ---------------------------------------------------------------------------
# Status resolution
# Mirrors getPredictionStats() in history.js — handles both old and new records.
# ---------------------------------------------------------------------------

def _build_result_map(results: List[Dict[str, Any]]) -> Dict[Any, Dict[str, Any]]:
    result_map: Dict[Any, Dict[str, Any]] = {}

    for r in results:
        fid = r.get("fixtureId")
        if fid is not None:
            result_map[fid] = r

    return result_map


def _resolve_status(p: Dict[str, Any], result_map: Dict[Any, Dict[str, Any]]) -> str:
    status = p.get("status")

    if status in ("settled_won", "settled_lost", "void"):
        return status

    # Old-style record: no status field, look up in results.jsonl
    r = result_map.get(p.get("fixtureId"))

    if r is None:
        return "pending"

    total = r.get("totalGoals")

    if total is None:
        h = r.get("fullTimeHome", 0) or 0
        a = r.get("fullTimeAway", 0) or 0
        total = h + a

    market = p.get("market", "")

    if market == "over_2.5":
        return "settled_won" if total > 2.5 else "settled_lost"

    if market == "btts":
        btts_yes = r.get("bttsYes") or (
            (r.get("fullTimeHome") or 0) > 0
            and (r.get("fullTimeAway") or 0) > 0
        )
        return "settled_won" if btts_yes else "settled_lost"

    return "pending"


# ---------------------------------------------------------------------------
# Field extraction  (defensive — older records may omit fields)
# ---------------------------------------------------------------------------

def _get_float(row: Dict[str, Any], *keys: str) -> Optional[float]:
    for k in keys:
        v = row.get(k)

        if v is not None:
            try:
                return float(v)
            except (TypeError, ValueError):
                pass

    return None


def _get_edge(row: Dict[str, Any]) -> Tuple[Optional[float], bool]:
    """
    Returns (edge_pct, is_fallback).

    edge is stored in PERCENTAGE POINTS by GoalScout, not as a decimal.
    The live formula is:
        edge = (modelProbability / trueMarketProbability - 1) * 100

    Fallback for older records without a stored edge field:
        edge approx = (modelProbability - 1/marketOdds) * 100

    The fallback uses raw marketOdds, not the margin-stripped price, so it can
    understate edge for markets with margin. Flagged as is_fallback = True.
    """
    stored = _get_float(row, "edge")

    if stored is not None:
        return stored, False

    prob = _get_float(row, "modelProbability")
    odds = _get_float(row, "marketOdds")

    if prob is not None and odds is not None and odds > 0:
        implied = 1.0 / odds
        return round((prob - implied) * 100, 2), True

    return None, False


def _edge_band(edge: Optional[float]) -> str:
    """Boundaries are in PERCENTAGE POINTS, matching stored edge field scale."""
    if edge is None:
        return "missing"

    if edge <= 0:
        return "negative"

    if edge < 5.0:
        return "0-5%"

    if edge < 10.0:
        return "5-10%"

    return "10%+"


# ---------------------------------------------------------------------------
# Accumulator
# ---------------------------------------------------------------------------

class Bucket:
    def __init__(self):
        self.settled = 0
        self.won = 0
        self.lost = 0

        self.sum_model_prob = 0.0
        self.sum_implied = 0.0
        self.sum_edge = 0.0
        self.sum_market_odds = 0.0

        # ROI must only include rows with valid market odds.
        self.sum_returns = 0.0
        self.roi_staked = 0

        self.n_model_prob = 0
        self.n_implied = 0
        self.n_edge = 0
        self.n_market_odds = 0

    def add(
        self,
        won: bool,
        model_prob: Optional[float],
        market_odds: Optional[float],
        edge: Optional[float],
    ) -> None:
        self.settled += 1

        if won:
            self.won += 1
        else:
            self.lost += 1

        # Only calculate ROI when actual market odds exist.
        # Hit rate still uses all settled rows.
        if market_odds is not None and market_odds > 0:
            self.roi_staked += 1

            if won:
                self.sum_returns += market_odds - 1.0
            else:
                self.sum_returns -= 1.0

        if model_prob is not None:
            self.sum_model_prob += model_prob
            self.n_model_prob += 1

        if market_odds is not None and market_odds > 0:
            self.sum_implied += 1.0 / market_odds
            self.sum_market_odds += market_odds
            self.n_implied += 1
            self.n_market_odds += 1

        if edge is not None:
            self.sum_edge += edge
            self.n_edge += 1

    def hit_rate(self) -> Optional[float]:
        return self.won / self.settled if self.settled else None

    def avg_model_prob(self) -> Optional[float]:
        return self.sum_model_prob / self.n_model_prob if self.n_model_prob else None

    def avg_implied(self) -> Optional[float]:
        return self.sum_implied / self.n_implied if self.n_implied else None

    def avg_edge(self) -> Optional[float]:
        return self.sum_edge / self.n_edge if self.n_edge else None

    def avg_market_odds(self) -> Optional[float]:
        return self.sum_market_odds / self.n_market_odds if self.n_market_odds else None

    def roi(self) -> Optional[float]:
        """ROI per unit staked, only across rows with valid market odds."""
        return self.sum_returns / self.roi_staked if self.roi_staked else None


# ---------------------------------------------------------------------------
# Formatting helpers
# ---------------------------------------------------------------------------

def _pct(v: Optional[float]) -> str:
    """Format a 0-1 decimal as a percentage string."""
    return f"{v * 100:.1f}%" if v is not None else "—"


def _f(v: Optional[float], dp: int = 3) -> str:
    return f"{v:.{dp}f}" if v is not None else "—"


def _edge_pct_str(v: Optional[float]) -> str:
    """
    Format an already-in-percentage-points edge value.
    Do NOT multiply by 100 — the value is already e.g. 8.33, not 0.0833.
    """
    if v is None:
        return "—"

    sign = "+" if v >= 0 else ""
    return f"{sign}{v:.1f}%"


def _roi_str(v: Optional[float]) -> str:
    if v is None:
        return "—"

    sign = "+" if v >= 0 else ""
    return f"{sign}{v * 100:.1f}%"


# ---------------------------------------------------------------------------
# CSV helper
# ---------------------------------------------------------------------------

def _csv_row(group_type: str, group_value: str, b: Bucket) -> Dict[str, Any]:
    return {
        "group_type": group_type,
        "group_value": group_value,
        "settled": b.settled,
        "won": b.won,
        "lost": b.lost,
        "hit_rate": round(b.hit_rate(), 4) if b.hit_rate() is not None else "",
        "avg_model_prob": (
            round(b.avg_model_prob(), 4) if b.avg_model_prob() is not None else ""
        ),
        "avg_implied_prob": (
            round(b.avg_implied(), 4) if b.avg_implied() is not None else ""
        ),
        "avg_edge_pct": round(b.avg_edge(), 2) if b.avg_edge() is not None else "",
        "avg_market_odds": (
            round(b.avg_market_odds(), 3) if b.avg_market_odds() is not None else ""
        ),
        "roi_n": b.roi_staked,
        "roi": round(b.roi(), 4) if b.roi() is not None else "",
    }


def _print_bucket_row(label: str, b: Bucket) -> None:
    print(
        f"  {label[:12]:<12} {b.settled:>5} {b.won:>5} {_pct(b.hit_rate()):>7} "
        f"{_pct(b.avg_model_prob()):>8} {_pct(b.avg_implied()):>8} "
        f"{_edge_pct_str(b.avg_edge()):>8} {_f(b.avg_market_odds()):>8} "
        f"{b.roi_staked:>6} {_roi_str(b.roi()):>8}"
    )


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    print(f"Reading {PREDICTIONS_FILE}")

    if not PREDICTIONS_FILE.exists():
        print(f"ERROR: {PREDICTIONS_FILE} not found.", file=sys.stderr)
        print("Run GoalScout at least once to generate prediction history.", file=sys.stderr)
        return 1

    raw_rows = _read_jsonl(PREDICTIONS_FILE)
    results = _read_jsonl(RESULTS_FILE)
    result_map = _build_result_map(results)

    raw_count = len(raw_rows)
    deduped = _dedupe(raw_rows)
    deduped_count = len(deduped)
    dup_count = raw_count - deduped_count

    # Resolve status on deduped rows
    annotated: List[Dict[str, Any]] = []

    for p in deduped:
        p = dict(p)
        p["_status"] = _resolve_status(p, result_map)
        annotated.append(p)

    settled = [p for p in annotated if p["_status"] in ("settled_won", "settled_lost")]

    print()
    print("=" * 56)
    print("  GoalScout Prediction History — Edge Analysis")
    print("=" * 56)
    print(f"  Raw rows:       {raw_count}")
    print(f"  After dedupe:   {deduped_count}  ({dup_count} duplicates removed)")
    print(f"  Settled:        {len(settled)}")
    print(f"  Pending/void:   {deduped_count - len(settled)}")
    print()

    if not settled:
        print("No settled predictions found — nothing to analyse.")
        return 0

    # ---- modelVersion breakdown ----
    mv_deduped: Dict[str, int] = defaultdict(int)
    for p in annotated:
        mv_deduped[p.get("modelVersion") or "missing"] += 1

    mv_settled: Dict[str, int] = defaultdict(int)
    for p in settled:
        mv_settled[p.get("modelVersion") or "missing"] += 1

    all_versions = sorted(
        set(list(mv_deduped.keys()) + list(mv_settled.keys()))
    )

    print("  Model versions (deduped / settled):")
    for mv in all_versions:
        d = mv_deduped.get(mv, 0)
        s = mv_settled.get(mv, 0)
        print(f"    {mv:<20} deduped={d:>4}  settled={s:>4}")
    print()

    # ---- CLV availability ----
    clv_clean = [
        p
        for p in settled
        if p.get("clvPct") is not None and p.get("closingOddsCapturedAt") is not None
    ]
    clv_legacy = [
        p
        for p in settled
        if p.get("clvPct") is not None and p.get("closingOddsCapturedAt") is None
    ]
    clv_miss = [p for p in settled if p.get("clvPct") is None]

    print("  CLV availability (settled):")
    print(f"    Clean CLV (Tier A):  {len(clv_clean)}")
    print(f"    Legacy CLV:          {len(clv_legacy)}")
    print(f"    Missing CLV:         {len(clv_miss)}")
    print()

    # ---- Edge band analysis ----
    edge_buckets: Dict[str, Bucket] = {b[0]: Bucket() for b in EDGE_BANDS}
    band_order = [b[0] for b in EDGE_BANDS]

    fallback_edge_count = 0

    for p in settled:
        won = p["_status"] == "settled_won"
        prob = _get_float(p, "modelProbability")
        odds = _get_float(p, "marketOdds")
        edge, is_fb = _get_edge(p)

        if is_fb:
            fallback_edge_count += 1

        band = _edge_band(edge)
        edge_buckets[band].add(won, prob, odds, edge)

    if fallback_edge_count:
        print(
            f"  NOTE: {fallback_edge_count} settled record(s) had no stored `edge` field. "
            "Edge was approximated as (modelProb - 1/marketOdds) * 100 "
            "(slightly understates true edge — no margin strip)."
        )
        print()

    print("─" * 78)
    print("  EDGE BAND ANALYSIS")
    print("  (Does positive model edge predict wins vs market odds?)")
    print("  Edge is in PERCENTAGE POINTS, e.g. 8.3 = model 8.3% above market.")
    print("  ROI_N = number of settled records with valid market odds used for ROI.")
    print("─" * 78)

    hdr = (
        f"  {'Band':<12} {'N':>5} {'Won':>5} {'Hit%':>7} "
        f"{'AvgProb':>8} {'AvgImpl':>8} {'AvgEdge':>8} "
        f"{'AvgOdds':>8} {'ROI_N':>6} {'ROI':>8}"
    )
    print(hdr)
    print(f"  {'─' * 74}")

    csv_rows: List[Dict[str, Any]] = []

    for band in band_order:
        b = edge_buckets[band]

        if b.settled == 0:
            continue

        _print_bucket_row(band, b)
        csv_rows.append(_csv_row("edge_band", band, b))

    # ---- By league ----
    league_buckets: Dict[str, Bucket] = defaultdict(Bucket)

    for p in settled:
        league = p.get("league") or p.get("leagueSlug") or "unknown"
        won = p["_status"] == "settled_won"
        prob = _get_float(p, "modelProbability")
        odds = _get_float(p, "marketOdds")
        edge, _ = _get_edge(p)
        league_buckets[league].add(won, prob, odds, edge)

    print()
    print("─" * 78)
    print("  BY LEAGUE  (settled only, sorted by N desc)")
    print("─" * 78)
    print(hdr)
    print(f"  {'─' * 74}")

    for league, b in sorted(league_buckets.items(), key=lambda x: -x[1].settled):
        _print_bucket_row(league, b)
        csv_rows.append(_csv_row("league", league, b))

    # ---- By market/selection ----
    sel_buckets: Dict[str, Bucket] = defaultdict(Bucket)

    for p in settled:
        key = f"{p.get('market', '?')} / {p.get('selection', '?')}"
        won = p["_status"] == "settled_won"
        prob = _get_float(p, "modelProbability")
        odds = _get_float(p, "marketOdds")
        edge, _ = _get_edge(p)
        sel_buckets[key].add(won, prob, odds, edge)

    print()
    print("─" * 78)
    print("  BY MARKET / SELECTION")
    print("─" * 78)
    print(hdr)
    print(f"  {'─' * 74}")

    for sel, b in sorted(sel_buckets.items(), key=lambda x: -x[1].settled):
        _print_bucket_row(sel, b)
        csv_rows.append(_csv_row("market_selection", sel, b))

    # ---- CLV summary (Tier A only) ----
    if clv_clean:
        print()
        print("─" * 56)
        print("  CLEAN CLV SUMMARY  (Tier A: closingOddsCapturedAt present)")
        print("─" * 56)

        clv_values = [p["clvPct"] for p in clv_clean if p.get("clvPct") is not None]

        if clv_values:
            mean_clv = sum(clv_values) / len(clv_values)
            positive = sum(1 for v in clv_values if v > 0)

            print(f"  Records with Clean CLV:  {len(clv_values)}")
            print(f"  Mean CLV:                {mean_clv:+.2f}%")
            print(f"  Positive CLV:            {positive} / {len(clv_values)}")
            print(f"  Negative/zero CLV:       {len(clv_values) - positive} / {len(clv_values)}")

        print()
        print("  NOTE: CLV > 0 means tip-time odds were better than closing.")
        print("  Positive mean CLV is a necessary (not sufficient) condition")
        print("  for long-run edge. Sample is too small for statistical confidence.")

    # ---- Write CSV ----
    OUTPUT_CSV.parent.mkdir(parents=True, exist_ok=True)

    csv_cols = [
        "group_type",
        "group_value",
        "settled",
        "won",
        "lost",
        "hit_rate",
        "avg_model_prob",
        "avg_implied_prob",
        "avg_edge_pct",
        "avg_market_odds",
        "roi_n",
        "roi",
    ]

    with OUTPUT_CSV.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=csv_cols)
        writer.writeheader()
        writer.writerows(csv_rows)

    print()
    print("─" * 56)
    print(f"  Wrote {len(csv_rows)} rows to {OUTPUT_CSV}")
    print()
    print("  INTERPRETATION REMINDER")
    print("  ─────────────────────────────────────────────────")
    print("  Hit rate alone does not prove edge.")
    print("  Edge > 0 means model prob > market implied prob.")
    print("  ROI only includes rows with valid market odds.")
    print("  Positive ROI in these bands is directional only —")
    print("  sample sizes are too small for statistical claims.")
    print("  Requires odds comparison across many more picks.")
    print("─" * 56)

    return 0


if __name__ == "__main__":
    sys.exit(main())
