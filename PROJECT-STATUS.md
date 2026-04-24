# GoalScout — Project Status & Continuation Guide

## Current State — 24 Apr 2026

GoalScout is a local Unraid Docker app for identifying pre-match O2.5 and U2.5 football betting opportunities.

- Running on Unraid at port `3030`
- SoccerSTATS paid account active
- FlareSolverr at `192.168.178.5:8191`
- The Odds API paid key active (1 key in docker-compose.yml, daily limit 600)
- Football-Data.org token stored in docker-compose.yml (for future results use)
- Live refresh: **today-only**
- League-page scraping: intersection of SoccerSTATS slugs + active Odds API soccer competitions
- O2.5 and U2.5 markets live
- Current and Calibrated model streams live with independent performance tracking
- Settlement working via `getOddsKey()` (stale `mapLeagueSlugToSportKey` references removed)
- Prediction deduplication: one record per `fixtureId + method + direction`
- Existing predictions.jsonl deduped: 174 → 120 rows
- Shortlist sorted by kickoff ascending by default
- Away stats column offset fixed: all away fields now read correct columns

---

## Recently Completed

### Away stats column offset fix (Apr 2026)
The SoccerSTATS matches.asp scraper was reading all away-side stats one column early. Cell [13] is the text "away" (scope indicator), not a stat. All eight away fields (`gp`, `ppg`, `avgTG`, `winPct`, `csPct`, `ftsPct`, `btsPct`, `o25pct`) were offset by -1, meaning every prediction logged before this fix has corrupted away stats. A 23-cell structural guard was also added.

Files: `src/scrapers/match-discovery.js`

### Shared team-name normaliser (Apr 2026)
`src/utils/team-names.js` created as single source of truth for team name matching. `normalise()`, `applyAlias()`, `singleTeamMatch()`, and `teamsMatch()` are now shared across `the-odds-api.js` and `settler.js`. Aliases for Argentina, Australia, Netherlands, Germany, France, Denmark live here.

### Odds API sports-list cleanup
`/v4/sports` filtered to `soccer_` active competitions only. Count is now ~53 active soccer competitions.

### Expanded SLUG_TO_ODDS_MAP
Added/corrected: `england2–4`, `germany3`, `sweden2`, `brazil`, `brazil2`, `chile`, `china`, `saudiarabia`, `ireland`, `usa`. Removed incorrect `usa6 → MLS` mapping (`usa6` is NWSL on SoccerSTATS).

### Today-only refresh
Live shortlist now scrapes today's SoccerSTATS matches only. League-page fetching scoped to leagues present in current run AND mapped to an active Odds API soccer competition.

### Settler repaired
Replaced all `mapLeagueSlugToSportKey` references with `getOddsKey()`. Settlement cron successfully settled 50 predictions in one run after fix.

### Prediction deduplication fixed
Forward dedup rule: `fixtureId + method + direction`. One-off cleanup: 174 → 120 rows. Backup at `data/history/predictions.backup-before-dedupe.jsonl`.

### CLAUDE.md added
Repo-root conventions file: always provide full files, deploy sequence, run commands in temp Docker containers.

---

## Architecture

```
SoccerSTATS today matches
  ↓
League slugs found in current scrape
  ↓
Intersect with mapped active Odds API soccer competitions
  ↓
Fetch SoccerSTATS league stats only for eligible leagues
  ↓
Score eligible matches (O2.5 vs U2.5, directional)
  ↓
Build Current + Calibrated shortlists independently
  ↓
Fetch O/U 2.5 odds for shortlisted competitions
  ↓
Log predictions (one per fixtureId + method + direction)
  ↓
Settle completed predictions via Odds API /scores
  ↓
Performance tab (per method, per market)
```

---

## Model Architecture

### Current model
Direction from scoring system (O2.5 vs U2.5 signals). Grade A+/A/B from winning score. Only shortlisted if: direction won, score ≥ MIN_WINNING_SCORE, probability ≥ MIN_PROB, and odds exist for the recommended direction.

### Calibrated model
Direction from calibrated probability (from `calibration.js`). Grade from probability thresholds. Same odds requirement. Runs independently — does not depend on current shortlist.

Both models operate on identical match inputs and are logged/evaluated separately.

---

## Known Issues

### Priority 1 — Results source reliability
The Odds API `/scores` is still the settler's primary source. It previously returned at least one wrong score (Bielefeld 2-0, actual 1-1). All historical predictions settled via `/scores` may have corrupted outcomes. Football-Data.org token is in docker-compose.yml but not yet wired into `settler.js`. Fix this before trusting calibration or ROI.

### Priority 2 — Current and Calibrated returning identical shortlists
After the away stats fix, both models are returning the same 10 matches. This may be a coincidence given today's fixture set, or it may indicate that the calibration map (`data/calibration/league-calibration.json`) is empty/missing, making `applyCalibration()` a no-op and leaving calibrated probabilities identical to raw ones. Worth checking the calibration data file.

### Priority 3 — Performance view method filtering
Verify that the Current tab shows only current-method rows and Calibrated shows only calibrated-method rows. Overlap analysis should be separate.

### Priority 4 — Calibration chart not wired
`perfContent` has calibration chart HTML but `renderPerformance()` never populates `calibBars`. Needs wiring to method-specific stats.

### Priority 5 — Closing odds rarely captured
The Odds API `/odds` endpoint drops completed events, so `closingOdds` from the settler is almost always null. `updatePreKickoffOdds()` stores pre-KO price as `closingOdds` as a fallback — this is working but CLV accuracy is limited to pre-KO vs tip-time comparison rather than true closing line.

---

## Tech Stack

- Node.js 20 + Express
- Cheerio (HTML parsing)
- FlareSolverr (`192.168.178.5:8191`)
- The Odds API (paid key, daily limit 600, UK+AU region)
- Football-Data.org (free tier, token in docker-compose.yml)
- Docker on Unraid, port 3030
- Local JSON/JSONL storage

---

## Key Source Files

```
src/
├── index.js                    Express server + cron (refresh 6h, settle 3h, pre-KO 30m)
├── config.js                   All config — thresholds, paths, env vars
├── api/routes.js               REST API endpoints
├── engine/
│   ├── shortlist.js            Directional scoring — O2.5 vs U2.5, ties excluded
│   ├── probability.js          P(O2.5), margin removal, edge vs true market prob
│   ├── calibration.js          applyCalibration() via league-calibration.json
│   ├── history.js              Prediction logging, dedupe, performance stats
│   └── settler.js              Score fetching, settlement, pre-KO odds
├── odds/the-odds-api.js        Odds API — SLUG_TO_ODDS_MAP, sports list, odds fetch
├── scrapers/
│   ├── orchestrator.js         Main refresh — dual model, bettable-first, today-only
│   ├── match-discovery.js      SoccerSTATS parser — away offset fixed Apr 2026
│   └── league-discovery.js     League slug discovery from leagues.asp
└── utils/
    ├── team-names.js           Shared normaliser + alias map (single source of truth)
    ├── fetcher.js              FlareSolverr + direct fallback HTTP client
    └── storage.js              JSON file read/write
```

---

## Data Files

```
data/
├── shortlist.json              { current: [...], calibrated: [...], comparison: {} }
├── discovered-matches.json     All scored matches this cycle
├── meta.json                   Refresh metadata
├── odds-cache.json             Sports + odds cache (sports TTL 6h, odds TTL 3h)
├── match-details/              Per-match detail JSON files
├── calibration/
│   └── league-calibration.json Calibration map (may be empty — check if calibrated model diverges)
└── history/
    ├── predictions.jsonl       Append-only, deduped by fixtureId + method + direction
    ├── predictions.backup-before-dedupe.jsonl
    ├── results.jsonl           Settled results
    └── closing-odds.jsonl      Odds snapshots
```

---

## Deploy Commands

Standard deploy:
```bash
cd /mnt/user/appdata/goalscout
docker compose down
docker rmi goalscout goalscout-goalscout 2>/dev/null || true
docker builder prune -f
docker compose up --build -d
docker logs -f goalscout
```

Never run `docker build` separately — Compose builds `goalscout-goalscout`. A standalone build creates a stale image that Compose silently ignores.

---

## Useful Checks

```bash
# Settlement counts
grep -c '"status":"settled_won"' data/history/predictions.jsonl
grep -c '"status":"settled_lost"' data/history/predictions.jsonl
grep -c '"status":"pending"' data/history/predictions.jsonl

# Check calibration data file exists and has content
cat data/calibration/league-calibration.json 2>/dev/null || echo "MISSING"

# Syntax checks
node -c src/engine/settler.js
node -c src/engine/history.js
node -c src/odds/the-odds-api.js
node -c src/scrapers/orchestrator.js
node -c src/scrapers/match-discovery.js
```

---

## API Endpoints

```
GET  /api/status       → refresh state + meta
GET  /api/shortlist    → { current: [...], calibrated: [...], comparison: {} }
GET  /api/matches      → all scored matches this cycle
GET  /api/leagues      → discovered leagues
GET  /api/match/:id    → match detail
GET  /api/stats        → performance stats (per method, per market)
GET  /api/predictions  → raw prediction history (last 100)
POST /api/refresh      → trigger manual refresh
POST /api/settle       → trigger manual settlement + pre-kickoff odds
POST /api/pre-kickoff  → fetch current odds for pending predictions
```

---

## Strategic Direction

1. Clean O2.5/U2.5 baseline
2. Reliable settlement (fix results source)
3. Calibration data collection (200+ settled needed)
4. Then: xG, more markets, Betfair Exchange

Do not add more markets until O2.5/U2.5 baseline is trustworthy.

---

## Continuation Prompt

```
I'm continuing the GoalScout project. Repo is at https://github.com/dazzopardi09/goalscout
PROJECT-STATUS.md in the repo has full context.
```