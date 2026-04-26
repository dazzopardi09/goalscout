# GoalScout — Project Status & Continuation Guide

## What This Is
A private local Unraid Docker app (port 3030) that scrapes football matches, overlays bookmaker odds, scores them directionally for Over 2.5 / Under 2.5 goals, and tracks prediction performance. Data sources: SoccerSTATS (via FlareSolverr), The Odds API (paid key), Football-Data.org (validator).

---

## Current State (v3 — April 2026)

- **Deployed** on Unraid at `/mnt/user/appdata/goalscout`, port 3030
- **Branch**: `feature/context-raw-backtest` (active work branch)
- **Three parallel models**: Current (scoring-based), Calibrated (probability-based, wider pool), Context (context_raw — paper tracking, England + Germany only)
- **Directional shortlist**: O2.5 vs U2.5 per match, not just "goals expected"
- **Settlement**: Dual-source (Odds API primary + Football-Data validator where supported)
- **Performance tracking**: Per-method, per-market hit rate, Brier score, edge, Move%, CLV (where genuine close captured)

---

## Architecture

```
SoccerSTATS today matches
  ↓ (FlareSolverr bypass)
match-discovery.js — parse teams, stats, kickoff
  ↓
orchestrator.js — score all matches, build three-model shortlist
  ↓
the-odds-api.js — fetch odds for all scored matches with direction
  ↓
Current shortlist (score >= 4, P >= 60%, has odds)
Calibrated shortlist (calibrated P >= 60%, has odds) — INDEPENDENT pool
Context shortlist (context_raw score >= threshold, England+Germany only) — PAPER TRACKING
  ↓
logPrediction() — current/calibrated → predictions.jsonl (deduped by fixtureId+method+direction)
logContextPrediction() — context_raw → predictions.jsonl (deduped by fixtureId+predictionDate+modelVersion)
  ↓
Settlement pipeline (see below)
  ↓
Performance tab — per method, per market stats
```

---

## Three-Model Architecture

### Current model
- Source: SoccerSTATS season aggregates (O2.5%, avg TG, CS%, FTS%)
- Scoring: directional score >= 4, calibrated P >= 60%, must have odds
- Grade: score-based (A+/A/B)
- Calibration: `applyCalibration()` via `league-calibration.json` (Platt per league)

### Calibrated model
- Same features as Current but draws from a wider candidate pool (all scored matches with odds, not just score >= 4)
- Grade: probability-based (`getCalibratedGrade()`)
- Direction: re-derived from calibrated O2.5 vs U2.5 probabilities

### Context model (context_raw — paper tracking)
- Source: Football-Data.org last-6-match rolling stats (gf_avg, ga_avg, o25_count, fts_count, etc.)
- Leagues: England (PL) and Germany (BL1) only — validated Stage 8 signals
- Scoring: `scoreContext()` in `context-shortlist.js` — independent of SoccerSTATS aggregates
- Calibration: Germany O2.5 A/A+ uses Platt v1 (A=0.817704, B=0.037095); all others raw
- Logged to `predictions.jsonl` with `method: 'context_raw'`
- Included in `shortlist.json` as own `context_raw` array — does NOT affect current/calibrated
- Displayed in Shortlist tab under Model filter: **Context** chip
- Paper tracking only — not for real-money decisions until Stage 12

### All-mode display merge (frontend only, no backend effect)
- current + calibrated + context_raw agree (same fixture + direction) → one row, `Cur Cal Ctx` badges
- current + calibrated agree, context_raw differs → merged cur/cal row + separate ctx row
- current + calibrated disagree → separate rows (disagreement is meaningful)
- context_raw only → own row with `Ctx` badge

---

## Cron Jobs (src/index.js)

| Cron | Schedule | Function |
|---|---|---|
| Full refresh | `5 */6 * * *` | `runFullRefresh()` — scrape + score + odds + context_raw |
| Settlement sweep | `*/30 * * * *` | `fetchScoresAndSettle()` — settle eligible predictions |
| Pre-KO odds capture | `*/30 * * * *` | `fetchCurrentOddsForPending()` — capture pre-KO price |
| Close odds capture | `*/5 * * * *` | `captureClosingOdds()` — capture near-close price (3–15 min before KO) |

---

## Settlement Pipeline (src/engine/settler.js)

### Eligibility guards (applied before any API call)
- `commenceTime` must be known
- Kickoff must be **at least 135 minutes ago** (match likely complete)
- Kickoff must be **less than 3 days ago** (within Odds API /scores window)
- Predictions without `commenceTime` are attempted regardless

### daysFrom=3 is the maximum valid value for The Odds API /scores endpoint
Values above 3 return `INVALID_SCORES_DAYS_FROM`. Predictions older than 3 days cannot be settled via Odds API and are logged as `outside_odds_api_window`. Football-Data.org covers the top ~10 leagues as a fallback for those.

### Skip-reason counters (logged per sweep)
```
future_fixture               kickoff hasn't happened yet
not_old_enough               kicked off < 135 min ago
outside_odds_api_window      kicked off > 3 days ago — scores dropped
no_key                       league slug not in SLUG_TO_ODDS_MAP
api_error                    scores fetch failed for this sport key
no_completed_scores_for_sport sport returned no completed records
no_score_candidate           completed scores exist but no team match found
conflict                     Odds API and Football-Data returned different scores
matched                      settled successfully
```

### Dual-source validation
- **Odds API + Football-Data agree** → settle, `resultSource: 'verified'`
- **Odds API only** (FD not covering league) → settle, `resultSource: 'odds-api'`
- **FD only** (Odds API missed) → settle, `resultSource: 'football-data'`
- **Sources disagree** → mark `status: 'conflict'`, log to `settlement-conflicts.jsonl`, do not settle

### Football-Data.org coverage
Covers: EPL, Championship, Bundesliga, Serie A, La Liga, Ligue 1, Eredivisie, Champions League, Liga Portugal, Brasileirão.
Does NOT cover: Turkey, Poland, Russia, Saudi Arabia, Korea, Argentina, Switzerland, lower divisions.
Paid tiers required for Serie B, Bundesliga 2 — not enabled.

### Orphaned predictions
Predictions from leagues not covered by Football-Data AND older than 3 days are permanently unsettleable via automation. Settle manually in `predictions.jsonl` or accept as data loss.

---

## Pre-KO / Close / CLV Tracking

### Field definitions
| Field | Captured by | When | Meaning |
|---|---|---|---|
| `marketOdds` | `logPrediction()` | At tip time | Odds when prediction was logged |
| `preKickoffOdds` | `fetchCurrentOddsForPending()` | Up to 2h before KO | Early pre-match market snapshot |
| `preKickoffMovePct` | Calculated with preKO | Same | `(preKO / tipOdds - 1) * 100` |
| `closingOdds` | `captureClosingOdds()` | 3–15 min before KO | Near-close price snapshot |
| `closingOddsCapturedAt` | `captureClosingOdds()` | Same | Timestamp of capture |
| `clvPct` | `settlePrediction()` | At settlement | `(tipOdds / closingOdds - 1) * 100` |

### Important caveats
- **`preKickoffOdds` is NOT a closing line.** It is captured up to 2 hours before kickoff, before lineups are confirmed (~60-75 min before KO). It is a useful early market snapshot, not a true CLV baseline.
- **`closingOdds` is only populated when `captureClosingOdds()` successfully finds a clean market match in the 3–15 minute window.** If missed, it stays null.
- **`clvPct` is only meaningful when `closingOdds` was genuinely captured** (i.e. `closingOddsCapturedAt` is not null). Legacy rows may have `closingOdds` copied from `preKickoffOdds` — these are not true CLV values.
- **`closingOdds` is never overwritten** once set. Never written after kickoff.
- **`closingOdds` is no longer copied from `preKickoffOdds`** (fixed April 2026). Prior to this fix, all Close/CLV figures were effectively pre-KO values mislabelled as closing.

### Legacy records
Records settled before April 25 2026 may have `closingOdds` = `preKickoffOdds` (the old behaviour). They will show CLV figures in the UI but these are not true CLV. `resultSource` may also be `undefined` on very old records (pre-validation-layer).

---

## API Endpoints (src/api/routes.js)

| Method | Path | Description |
|---|---|---|
| GET | `/api/status` | Refresh state, meta, `lastRefresh`, `lastSettlementChange` |
| GET | `/api/shortlist` | `{ current, calibrated, context_raw, comparison }` |
| GET | `/api/stats` | Performance stats (per method, per market) |
| GET | `/api/predictions` | Raw prediction history (last 100) |
| GET | `/api/conflicts` | Settlement conflicts log |
| GET | `/api/match/:id` | Match detail (if scraped) |
| GET | `/api/context/index` | Backtest index (`_index.json`) — season metadata |
| GET | `/api/context/backtest?league=&season=` | Backtest JSONL as JSON array (path-traversal safe) |
| POST | `/api/refresh` | Trigger manual full refresh |
| POST | `/api/settle` | Trigger manual settlement sweep |
| POST | `/api/pre-kickoff` | Trigger manual pre-KO odds capture |

### /api/shortlist shape (updated)
```json
{
  "current":     [...],
  "calibrated":  [...],
  "context_raw": [...],
  "comparison":  { "overlapIds": [...], "currentOnlyIds": [...], "calibratedOnlyIds": [...] }
}
```
`context_raw` is always its own array — never mixed into current or calibrated.

---

## Dashboard Auto-Refresh (public/index.html)

Frontend polls `/api/status` every **30 seconds**.

| Condition | Action |
|---|---|
| `lastRefresh` changed | Reload shortlist + performance data |
| `lastSettlementChange` changed | Reload performance data only |
| Neither changed | No reload (status bar only) |

No websockets, no SSE, no full page reload.

---

## Data Files

| File | Description |
|---|---|
| `data/history/predictions.jsonl` | Append-only prediction log. Deduped by `fixtureId+method+direction` (current/calibrated) or `fixtureId+predictionDate+modelVersion` (context_raw). |
| `data/history/results.jsonl` | One entry per settled fixture. Deduped by `fixtureId`. |
| `data/history/settlement-conflicts.jsonl` | Append-only. Written when Odds API and Football-Data disagree on a score. |
| `data/calibration/league-calibration.json` | Platt scaling parameters for current/calibrated model. Needs ~200+ settled predictions. |
| `data/calibration/germany_o25_v1.json` | Context_raw Platt params for Germany O2.5 A/A+. Gitignored — lives in data/ only. |
| `data/rolling-results/{league}.json` | 8-week rolling results cache from Football-Data.org. Used by context_raw pipeline. |
| `data/backtests/context_raw/` | Historical backtest JSONL files by league/season. Served by `/api/context/backtest`. |
| `data/odds-cache.json` | Disk-persistent odds cache. Survives restarts. TTL: sports 6h, odds 3h. |

---

## Key Source Files

| File | Purpose |
|---|---|
| `src/scrapers/orchestrator.js` | Main refresh — three-model pipeline, context_raw in Step 7.5 |
| `src/scrapers/match-discovery.js` | SoccerSTATS parser — away stats offsets fixed |
| `src/engine/shortlist.js` | Directional scoring (O2.5 vs U2.5) for current/calibrated |
| `src/engine/probability.js` | P(O2.5), margin removal, edge |
| `src/engine/calibration.js` | `applyCalibration()` via league-calibration.json (current/calibrated) |
| `src/engine/context-shortlist.js` | `scoreContext()` — context_raw scoring engine (rolling stats only) |
| `src/engine/context-predictions.js` | `logContextPredictions()` — context_raw prediction logger |
| `src/engine/context-calibration.js` | `getCalibratedProb()` — Platt loader for context_raw (Germany O2.5) |
| `src/engine/rolling-stats.js` | `computeRollingStats()` — per-team last-6-match stat aggregation |
| `src/engine/history.js` | Prediction logging, dedupe, reconcile(), perf stats |
| `src/engine/settler.js` | Score fetching, settlement, pre-KO odds, close capture |
| `src/results/football-data.js` | Football-Data.org fetcher + league map + cache |
| `src/odds/the-odds-api.js` | SLUG_TO_ODDS_MAP, sports list, odds fetch, disk cache |
| `src/utils/team-names.js` | Shared normaliser + alias map |
| `public/index.html` | v3 UI — All/Current/Calibrated/Context tabs, smart All-mode merge, Research tab |

---

## Deploy Sequence

```bash
cd /mnt/user/appdata/goalscout
docker compose down
docker rmi goalscout goalscout-goalscout 2>/dev/null || true
docker builder prune -f
docker compose up --build -d
```

**Never** run `docker build` separately. Compose builds its own image named `goalscout-goalscout`. A standalone `goalscout` image is silently ignored.

**Verify:** `docker images | grep goalscout` — should show exactly one image.

**Run scripts inside the running container** (not on the host — host has no Node):
```bash
docker exec -it goalscout node /app/scripts/my-script.js
# OR for one-off scripts:
docker cp /tmp/script.js goalscout:/app/script.js
docker exec -it goalscout node /app/script.js
```

---

## Operational Checks

```bash
# All three models appearing in shortlist
curl -s http://localhost:3030/api/shortlist | node -e "
const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
console.log('current:', d.current.length, 'calibrated:', d.calibrated.length, 'context_raw:', (d.context_raw||[]).length);
"

# Context_raw pipeline working
docker logs goalscout | grep -E "context rolling|context_raw:"

# Settlement working
docker logs goalscout | grep settler

# Confirm lastSettlementChange is populated after matches settle
curl -s http://localhost:3030/api/status | jq '.lastSettlementChange'

# Inspect recent settled predictions
docker exec -it goalscout node -e "
const { readJSONL } = require('./src/engine/history');
const config = require('./src/config');
const preds = readJSONL(config.PREDICTIONS_FILE);
const settled = preds.filter(p => p.status === 'settled_won' || p.status === 'settled_lost').slice(-3);
settled.forEach(p => console.log(p.method, p.homeTeam,'vs',p.awayTeam, p.result, 'src:',p.resultSource));
"

# Check for conflicts
curl -s http://localhost:3030/api/conflicts | jq '.count'
```

---

## Known Issues / Limitations

| Issue | Status |
|---|---|
| 8 predictions from April 19-21 outside Odds API window, unsupported by FD | Orphaned — settle manually or accept data loss |
| Legacy records have `closingOdds` = `preKickoffOdds` (not true CLV) | Known, not backfilled. New records clean. |
| `resultSource: undefined` on records settled before validation layer | Known, not migrated. Default was Odds API. |
| `leagueStatsFound: 0` in meta — league O2.5% weight effectively zero | Investigate separately |
| Calibration data file sparse — needs 200+ settled predictions per league | Accept for now — accumulating |
| `preKickoffOdds` captured up to 2h before KO — misses lineup-driven moves | By design for now; `closingOdds` at 3-15min is the fix |
| Stuttgart vs Werder Bremen showed "No odds" in Context tab | Expected — Odds API had U2.5 odds but context_raw called O2.5; market disagreement, not a bug |

---

## Performance Snapshot (April 26 2026)

- Current model: 65.2% hit rate, 69 settled
- Calibrated model: 66.7% hit rate, 45 settled
- Context_raw: 2 live predictions (paper tracking, accumulating)
- Overlap current/calibrated: 90 (0 current-only, 35 calibrated-only)
- Pre-KO move (mean): -3.5% O2.5, -2.2% U2.5 (negative = market agrees, good)
- CLV figures in UI: partially reliable — see legacy caveat above
- Sample still small — Brier and edge are more meaningful than hit rate at this stage

---

## Stage 4 — Context Research UI
Completed: 2026-04-26

### Features shipped
- Research tab (🔬) added to GoalScout dashboard alongside Shortlist and Performance
- Season selector dropdown populated from `_index.json` — supports single season or aggregate mode
- Aggregate mode ("All seasons") loads all seasons in parallel, merges into one dataset
- Headline cards: Hit Rate, O2.5, U2.5, ROI, Mean CLV — all recompute on every filter change
- Filter bar: Direction, Grade, Result, Flags (AND logic), Gameweek range slider
- Flag performance table: slice-aware — respects direction/grade/result/gameweek filters, excludes flag filters to avoid circular analysis
- Flag tooltips: hover any flag abbreviation (STO, BLD, CDO, OSIR, LAUS, BWA) to see full name, meaning, and expected direction
- Gameweek hit-rate chart (SVG): bar per GW, coloured vs season average, volume strip
- Edge vs Outcome chart (SVG): bucket bars, upward slope = meaningful edge ranking
- Predictions table: paginated 50/page in Standard mode
- Gameweek mode: groups predictions by GW across seasons, hit rate per group, Season column replaces GW
- Season sort (Newest first / Oldest first): controls row order within each GW group in Gameweek mode
- Detail drawer: full fixture detail, rolling inputs, flags, market data, copy fixtureId
- Gameweek slider max set dynamically from data (EPL 2024-25 calendar weeks exceed 38)

### API endpoints added (src/api/routes.js)
- GET /api/context/index → serves _index.json (season metadata)
- GET /api/context/backtest?league=&season= → serves JSONL as JSON array (path-traversal safe)

---

## Stage 5 — Single-season analysis and model assessment
Completed: 2026-04-26

### Findings (EPL 2024-25, context_raw v1.1 → v1.2)
- O2.5 hit rate: 60.3% — above EPL base rate, consistent signal
- CDO flag: -14.7pp delta (46.7% when fired vs 61.4% when not) — strongest signal, working as designed
- `strong_two_sided_over`: -5.4pp delta (unexpected, flagged for multi-season review)
- U2.5 hit rate: 47.4% on 38 predictions — at base rate, no validated signal
- ROI: -3.4%, CLV: -0.34% — expected for uncalibrated model

### Targeted fix applied: direction-aware thresholds (context_raw v1.2)
- Score=3 O2.5 fixtures: 60.0% hit rate on 35 fixtures = same signal as passing predictions
- Score=3 U2.5 fixtures: 30.8% hit rate on 13 fixtures = below base rate, correctly filtered
- Change: MIN_O25_SCORE = 3, MIN_U25_SCORE = 4 (was flat 4 for both)

---

## Stage 6 — Multi-season EPL expansion
Completed: 2026-04-26

### Results by season

| Season  | Preds | O2.5 Hit | U2.5 Hit | Overall | ROI   | CLV    |
|---------|-------|----------|----------|---------|-------|--------|
| 2024-25 | 237   | 60.3%    | 47.4%    | 58.2%   | -3.4% | -0.34% |
| 2023-24 | 265   | 64.7%    | 33.3%    | 61.5%   | -3.5% | -0.77% |
| 2022-23 | 233   | 55.0%    | 61.0%    | 57.1%   | -1.1% | +0.49% |
| 2021-22 | 221   | 56.9%    | 46.8%    | 53.4%   | -5.5% | -0.20% |
| 2020-21 | 219   | 54.3%    | 56.7%    | 55.3%   | -2.8% | -0.08% |
| 2019-20 | 211   | 57.7%    | 49.4%    | 54.5%   | -8.8% | +1.26% |
| **AGG** | **1,386** | **~58.3%** | **~50.0%** | **56.7%** | **-4.1%** | **-0.02%** |

Key findings: directional signal real, calibration is primary problem, CDO is core signal, strong_two_sided_over validated, U2.5 unvalidated.

---

## Stage 9 — Backtest calibration training + validation
Completed: 2026-04-26

### Germany O2.5 — ACCEPTED (v1, A/A+ only)
Parameters: A=0.817704, B=0.037095

| Metric | Raw | Calibrated | Change |
|--------|-----|-----------|--------|
| Brier | 0.2370 | 0.2309 | -0.0061 |
| ECE | 7.13pp | 1.41pp | -5.72pp |
| A+ calibration gap | +9.5pp | -1.4pp | near-perfect correction |
| B calibration gap | +1.7pp | +9.2pp | distorted — use raw |

### England O2.5 — REJECTED
Both V1 (3-season train) and V2 (1-season train) failed: overcorrected mean by 6–7pp, sharpness collapsed. Root cause: global Platt cannot fix isolated 75%+ bucket without destroying accurate 60–75% range. Stage 10 decision: use raw, flag `context_o25_prob_raw > 0.75` as overstated.

---

## Stage 10 — Context_raw live paper-tracking
Completed: 2026-04-26

### What was built
- `context-predictions.js` — `logContextPredictions()` logs context_raw predictions to `predictions.jsonl` with `method: 'context_raw'`, `status: 'pending'`, and full probability block (raw, calibrated, used, source, overstated flag)
- `context-calibration.js` — `getCalibratedProb()` applies Germany O2.5 Platt v1 for A/A+ grade; raw fallback for all other cases
- Orchestrator Step 7.5 — scores England + Germany fixtures with rolling stats, logs predictions, and builds `contextShortlisted` array
- `shortlist.json` — now has `context_raw` as own top-level key alongside `current` and `calibrated`
- `/api/shortlist` — passes `context_raw` through automatically (no routes.js change needed)

### Name collision fix (critical)
- `context-calibration.js` was initially named `calibration.js`, colliding with the existing current/calibrated model calibration file
- Fixed by renaming to `context-calibration.js` and restoring original `calibration.js`
- Both now coexist: `applyCalibration()` (current/calibrated) and `getCalibratedProb()` (context_raw)

### UI changes (public/index.html)
- Model filter: **All | Current | Calibrated | Context** (Context chip, no sub-labels)
- `getActiveShortlist()` returns `context_raw` array when `method === 'context_raw'`
- All-mode smart merge: dedupes by `fixtureId + direction + method`; merges rows across models where they agree; shows separate rows where they disagree; attaches `_models[]` array for badge rendering
- Model badges rendered under match name in All mode: `Cur` (cyan), `Cal` (green), `Ctx` (indigo)
- `loadShortlist()` reads `payload.context_raw` from API response

### Live pipeline log evidence (April 26 2026)
```
[football-data] rolling: 65 matches loaded for BL1
[orchestrator] context rolling: 18 teams loaded for germany
[context] logged 2 predictions this refresh
[orchestrator] context_raw: 2 predictions logged
[orchestrator] context_raw shortlist: 2 matches
[orchestrator] done. 579 scraped → 90 bettable → 26 unique shortlisted (10 current, 16 calibrated, 2 context_raw)
```

### Roadmap
- Stage 11 = forward calibration review at 200+ settled context_raw predictions per league
- Stage 12 = real-money decision gate (conditional on Stage 11)
- No real-money betting at any stage prior to Stage 12