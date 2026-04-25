# GoalScout — Project Status & Continuation Guide

## What This Is
A private local Unraid Docker app (port 3030) that scrapes football matches, overlays bookmaker odds, scores them directionally for Over 2.5 / Under 2.5 goals, and tracks prediction performance. Data sources: SoccerSTATS (via FlareSolverr), The Odds API (paid key), Football-Data.org (validator).

---

## Current State (v3 — April 2026)

- **Deployed** on Unraid at `/mnt/user/appdata/goalscout`, port 3030
- **Branch**: `fix/settlement-validation` (active work branch)
- **Two parallel models**: Current (scoring-based) and Calibrated (probability-based, wider pool)
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
orchestrator.js — score all matches, build dual shortlist
  ↓
the-odds-api.js — fetch odds for all scored matches with direction
  ↓
Current shortlist (score >= 4, P >= 60%, has odds)
Calibrated shortlist (calibrated P >= 60%, has odds) — INDEPENDENT pool
  ↓
logPrediction() — append to predictions.jsonl (deduped by fixtureId+method+direction)
  ↓
Settlement pipeline (see below)
  ↓
Performance tab — per method, per market stats
```

---

## Cron Jobs (src/index.js)

| Cron | Schedule | Function |
|---|---|---|
| Full refresh | `5 */6 * * *` | `runFullRefresh()` — scrape + score + odds |
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
| GET | `/api/shortlist` | Current + calibrated shortlist |
| GET | `/api/stats` | Performance stats (per method, per market) |
| GET | `/api/predictions` | Raw prediction history (last 100) |
| GET | `/api/conflicts` | Settlement conflicts log |
| GET | `/api/match/:id` | Match detail (if scraped) |
| POST | `/api/refresh` | Trigger manual full refresh |
| POST | `/api/settle` | Trigger manual settlement sweep |
| POST | `/api/pre-kickoff` | Trigger manual pre-KO odds capture |

### lastSettlementChange
Added to `/api/status`. Only updates when at least one prediction is actually written during a settlement sweep. Stays null if the sweep matches nothing. Used by the frontend to detect when to reload performance data without a full page reload.

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
| `data/history/predictions.jsonl` | Append-only prediction log. Deduped by `fixtureId+method+direction`. |
| `data/history/results.jsonl` | One entry per settled fixture. Deduped by `fixtureId`. |
| `data/history/settlement-conflicts.jsonl` | Append-only. Written when Odds API and Football-Data disagree on a score. |
| `data/calibration/league-calibration.json` | Platt scaling parameters per league. Needs ~200+ settled predictions to be meaningful. |
| `data/odds-cache.json` | Disk-persistent odds cache. Survives restarts. TTL: sports 6h, odds 3h. |

---

## Key Source Files

| File | Purpose |
|---|---|
| `src/scrapers/orchestrator.js` | Main refresh — dual model, independent calibrated pool |
| `src/scrapers/match-discovery.js` | SoccerSTATS parser — away stats offsets fixed |
| `src/engine/shortlist.js` | Directional scoring (O2.5 vs U2.5) |
| `src/engine/probability.js` | P(O2.5), margin removal, edge |
| `src/engine/calibration.js` | `applyCalibration()` via league-calibration.json |
| `src/engine/history.js` | Prediction logging, dedupe, reconcile(), perf stats |
| `src/engine/settler.js` | Score fetching, settlement, pre-KO odds, close capture |
| `src/results/football-data.js` | Football-Data.org fetcher + league map + cache |
| `src/odds/the-odds-api.js` | SLUG_TO_ODDS_MAP, sports list, odds fetch, disk cache |
| `src/utils/team-names.js` | Shared normaliser + alias map |
| `public/index.html` | v3 UI — Current/Calibrated tabs, performance view |

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
# Settlement working
docker logs goalscout | grep settler

# Close capture working (will be silent until a match is 3-15 min from KO)
docker logs goalscout | grep close-capture

# Confirm lastSettlementChange is populated after matches settle
curl -s http://localhost:3030/api/status | jq '.lastSettlementChange'

# Inspect recent settled predictions
docker exec -it goalscout node -e "
const { readJSONL } = require('./src/engine/history');
const config = require('./src/config');
const preds = readJSONL(config.PREDICTIONS_FILE);
const settled = preds.filter(p => p.status === 'settled_won' || p.status === 'settled_lost').slice(-3);
settled.forEach(p => console.log(p.homeTeam,'vs',p.awayTeam, p.result, 'src:',p.resultSource, 'closeAt:',p.closingOddsCapturedAt));
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

---

## Performance Snapshot (April 25 2026)

- Current model: 65.2% hit rate, 69 settled
- Calibrated model: 66.7% hit rate, 45 settled
- Overlap: 90 (0 current-only, 35 calibrated-only)
- Pre-KO move (mean): -3.5% O2.5, -2.2% U2.5 (negative = market agrees, good)
- CLV figures in UI: partially reliable — see legacy caveat above
- Sample still small — Brier and edge are more meaningful than hit rate at this stage