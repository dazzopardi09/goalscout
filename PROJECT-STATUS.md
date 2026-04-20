# GoalScout — Project Status & Continuation Guide

## What This Is
A local Unraid Docker app that identifies football matches worth betting on for Over 2.5 or Under 2.5 goals markets, using a probability pricing engine to find edge against bookmaker prices.

## Current State (v2 — April 2026)
- **Working and deployed** on Unraid at port 3030
- **Bettable-first flow**: queries The-Odds-API for leagues with active betting markets, scrapes/scores only those leagues
- **Data source**: SoccerSTATS.com (paid membership, uses FlareSolverr for Cloudflare bypass)
- **Odds**: UK region bookmakers via The-Odds-API (Bet365, Pinnacle, William Hill, Betfair Exchange etc)
- **Markets**: Over 2.5 Goals and Under 2.5 Goals — one directional call per match, never both
- **Auto-refresh**: Every 6 hours via cron
- **Settlement**: Every 2 hours via cron
- **Performance tab**: O2.5 and U2.5 tabs independently tracking hit rate, Brier score, mean edge, CLV
- **Backtesting system**: `src/analysis/backtest.js` — runs offline against predictions.jsonl + results.jsonl
- **Current output**: ~960 matches scraped → ~121 bettable → ~9 shortlisted

## Scope — What This App Does and Doesn't Do

### In scope (current)
- O2.5 and U2.5 goals markets only
- One directional call per match — either Over or Under, never both
- Pre-match only (Australian regulatory context)
- UK bookmaker prices as the reference market
- Three odds snapshots per match: tip-time, pre-kickoff (30 mins before), closing

### Deliberately out of scope (for now)
- BTTS — removed as a market. Will be added as a separate module later once xG layer exists and O2.5/U2.5 model is calibrated
- In-play betting
- Asian handicap, correct score, other markets
- ML models — baseline must be validated first
- Automated bet placement — Phase 3

## Architecture
```
SoccerSTATS.com ──→ FlareSolverr ──→ GoalScout scraper
The-Odds-API (UK region) ──→ League filtering + odds overlay
                        ↓
              Shortlist Engine — directional scoring
              (O2.5 signals vs U2.5 signals → one direction per match)
                        ↓
              Probability Engine
              (P(O2.5), P(U2.5)=1-P(O2.5), fair odds, edge)
                        ↓
              Three-snapshot odds capture
              (tip-time → pre-kickoff 30min → closing)
                        ↓
              Express API + HTML Dashboard (Shortlist + Performance tabs)
                        ↓
              Local JSON + JSONL history (data/history/)
                        ↓
              Backtesting system (src/analysis/backtest.js)
```

## Tech Stack
- Node.js 20 + Express
- Cheerio (HTML parsing)
- FlareSolverr (Cloudflare bypass, Unraid container at 192.168.178.5:8191)
- The-Odds-API (2 active keys, 500 req/month each, UK region only)
- Docker on Unraid, port 3030

## Key Environment Variables (in docker-compose.yml)
- `FLARESOLVERR_URL=http://192.168.178.5:8191/v1`
- `DISPLAY_TIMEZONE=Australia/Melbourne`
- `ODDS_API_KEYS=<2 active comma-separated keys>`
- `ODDS_REGIONS=uk` — UK only. Gives Bet365, Pinnacle, William Hill, Betfair Exchange, Paddy Power etc.
- `ODDS_BOOKMAKERS=` — empty, no allowlist. Best price wins across all UK books.
- `ODDS_DAILY_LIMIT=25` — quota guard, resets UTC midnight
- `FOOTBALL_DATA_API_KEY=<key>` — Football-Data.org free key for reliable results settlement
- `SOCCERSTATS_COOKIE=<session cookies>`

## Directional Call Logic
Each shortlisted match gets scored in two directions independently:

**O2.5 signals** (high-scoring match indicators):
- High home/away O2.5% → positive
- High combined average TG → positive
- High league O2.5% → positive
- PPG mismatch (dominant vs weak) → positive
- High CS% or FTS% → negative (undermines O2.5)

**U2.5 signals** (low-scoring match indicators):
- High home/away CS% → positive
- High home/away FTS% → positive
- Low combined TG → positive
- Low O2.5% for both teams → positive
- Low-scoring league → positive
- High O2.5% for either team → negative (undermines U2.5)

**Direction decision**: whichever score is strictly higher wins. Ties are ambiguous and filtered out entirely.
A match only appears on the shortlist if the winning direction score meets MIN_WINNING_SCORE (4).
The same match cannot appear as both O2.5 and U2.5.

## Prediction Logging Schema
One record per match (winning direction only). Key fields:

```json
{
  "fixtureId": "germany_union-berlin_wolfsburg",
  "predictionDate": "2026-04-19",
  "market": "over_2.5",
  "direction": "o25",
  "grade": "A",
  "modelProbability": 0.63,
  "fairOdds": 1.59,
  "marketOdds": 1.83,
  "edge": 15.1,
  "baseO25Score": 6,
  "baseU25Score": 2,
  "winningDirection": "o25",
  "winningScore": 6,
  "status": "pending"
}
```

Note: `modelProbability` is always P(directional market):
- `over_2.5` rows: P(O2.5)
- `under_2.5` rows: P(U2.5)

## Settlement Rules
```
over_2.5  → totalGoals > 2.5
under_2.5 → totalGoals < 2.5
btts      → homeGoals > 0 && awayGoals > 0  (legacy only)
```

## Backtesting System
```bash
npm run backtest                    # JSON report to stdout, summary to stderr
npm run backtest:save               # saves to data/history/backtest-report.json
npm run backtest -- --since 2026-04-19
npm run backtest -- --market over_2.5
```

Report covers: accuracy, ROI (priced bets only), Brier score, calibration buckets,
edge/grade/league/odds/confidence-tier segments, error log, legacy BTTS summary,
base-vs-enhanced model comparison stub.

**Current dataset (April 2026):** 35 directional predictions, 16 settled.
Sample size is too small for any conclusions — treat as pipeline validation only.

## File Structure
```
goalscout/
├── Dockerfile
├── docker-compose.yml
├── package.json
├── public/
│   ├── index.html                 # Dashboard — Shortlist + Performance (O2.5 + U2.5 tabs)
│   └── styles.css
├── src/
│   ├── index.js                   # Express server + cron
│   ├── config.js                  # All config — thresholds, paths, schedules
│   ├── analysis/
│   │   └── backtest.js            # Offline backtesting + validation system
│   ├── api/routes.js              # REST API endpoints
│   ├── engine/
│   │   ├── shortlist.js           # Directional scoring — O2.5 vs U2.5, one per match
│   │   ├── probability.js         # P(O2.5), P(U2.5)=1-P(O2.5), fair odds, edge
│   │   ├── history.js             # Prediction logging + performance stats (per direction)
│   │   └── settler.js             # Results + three-snapshot odds capture
│   ├── odds/the-odds-api.js       # Odds API — captures Over AND Under prices + event ID
│   ├── scrapers/
│   │   ├── orchestrator.js        # Main refresh — attaches direction + correct odds per match
│   │   ├── match-discovery.js     # SoccerSTATS HTML parser
│   │   └── league-discovery.js    # League slug discovery
│   └── utils/
│       ├── fetcher.js             # HTTP client (FlareSolverr + fallback)
│       └── storage.js             # JSON file read/write
└── data/
    ├── discovered-matches.json
    ├── shortlist.json
    ├── meta.json
    ├── match-details/
    └── history/
        ├── predictions.jsonl      # One record per match (winning direction only)
        ├── results.jsonl          # Settled results (includes over25, under25, bttsYes)
        └── closing-odds.jsonl     # All three snapshots: tip_time, pre_kickoff, closing
```

## API Endpoints
```
GET  /api/status       → refresh state + meta
GET  /api/shortlist    → shortlisted matches with direction + probabilities
GET  /api/matches      → all discovered matches
GET  /api/leagues      → all discovered leagues
GET  /api/match/:id    → match detail
GET  /api/stats        → performance stats (O2.5 + U2.5 independently)
GET  /api/predictions  → raw prediction history (last 100)
POST /api/refresh      → trigger manual refresh
POST /api/settle       → trigger manual settlement + pre-kickoff odds capture
```

## How to Deploy Changes

> ⚠️ Docker image naming trap: compose builds `goalscout-goalscout`, not `goalscout`.
> Always use `docker compose up --build`. Never `docker build` separately.

```bash
cd /mnt/user/appdata/goalscout
docker compose down
docker rmi goalscout goalscout-goalscout 2>/dev/null || true
docker builder prune -f
docker compose up --build -d
docker logs -f goalscout
```

## Git Workflow
```bash
cd /mnt/user/appdata/goalscout
git add -A
git commit -m "description of changes"
git push
```

To continue in a new session: "I'm continuing the GoalScout project. Repo is at https://github.com/dazzopardi09/goalscout — PROJECT-STATUS.md has full context."

## SoccerSTATS Cookie Refresh
1. Log into soccerstats.com in browser
2. DevTools console → `document.cookie`
3. Update `SOCCERSTATS_COOKIE` in docker-compose.yml
4. `docker compose down && docker compose up -d`

## Known Issues / Next Session Work

**Priority 1 — Results source reliability**
The-Odds-API `/scores` endpoint has returned incorrect scores in the past.
Football-Data.org key is configured and should be used as the primary results source in settler.js.
This must be wired correctly before calibration data is meaningful.

**Priority 2 — Pre-kickoff odds snapshot**
Three-snapshot system is designed (tip_time + pre_kickoff + closing). Pre_kickoff fetch
(25-35 mins before KO) using stored eventId is not fully wired. Needed for CLV tracking.

**Priority 3 — Backtesting: grow the dataset**
Currently 16 settled predictions — too small for any analysis. Priority is letting the
pipeline run cleanly and accumulate data. Target 100+ before reading any metrics.

**Priority 4 — Tooltip hover fix**
Add `position:relative` to `.table-shell` and `z-index:9999` on tooltip. Small CSS-only fix.

## Recently Completed (April 2026)
- ✅ Directional engine — O2.5 vs U2.5 only, one call per match
- ✅ BTTS removed from active model (legacy rows preserved in history)
- ✅ Probability engine — P(O2.5), P(U2.5)=1-P(O2.5), fair odds, margin removal, edge
- ✅ Settlement engine — handles over_2.5, under_2.5, btts (legacy)
- ✅ Prediction logging — direction + grade + baseO25Score + baseU25Score + winningScore at top level
- ✅ Deduplication — by fixtureId + market + date
- ✅ Backtesting system — accuracy, ROI (priced only), Brier, calibration, error log, segments
- ✅ ROI fix — no-odds rows excluded from ROI; pricedSettled + pricedCoveragePct added
- ✅ results.jsonl — includes over25, under25, bttsYes fields
- ✅ Performance tab — O2.5 and U2.5 independently tracked in dashboard
- ✅ Three-snapshot odds capture (tip_time working; pre_kickoff + closing partially wired)
- ✅ UK region odds only — Pinnacle + Bet365 as primary reference books
- ✅ Docker deploy trap documented

## Strategic Direction
GoalScout is being built as a **probability and pricing engine**, not a tip finder.

The goal is:
1. Estimate true match probabilities better than the market
2. Calibrate those probabilities properly (needs 200+ settled predictions)
3. Compare against bookmaker prices to find edge
4. Track CLV — not just win rate
5. Only add complexity (xG, lineups, ML) after the baseline is validated

**Roadmap:**
- Phase 1 (now): Clean O2.5/U2.5 model, accurate data pipeline, calibration data collection
- Phase 2: xG from FBref, calibration pass, improved probability weights
- Phase 3: BTTS as add-on module, more markets
- Phase 4: Betfair Exchange integration, pre-match automation

## User Details
- Location: Melbourne, Australia (AEST/AEDT)
- Bookmakers: Bet365 (UK feed), open to others
- Betfair account created, developer app "goalscout" registered
- SoccerSTATS paid membership active