# GoalScout — Project Status & Continuation Guide

## What This Is
A local Unraid Docker app that identifies football matches worth investigating for Over 2.5 goals and BTTS (Both Teams To Score) betting markets.

## Current State (v2 — April 2026)
- **Working and deployed** on Unraid at port 3030
- **Bettable-first flow**: queries The-Odds-API for leagues with active AU betting markets, then only scrapes/scores matches in those leagues
- **Data source**: SoccerSTATS.com (paid membership, uses FlareSolverr for Cloudflare bypass)
- **Odds display**: Shows best Over 2.5 odds from AU/UK bookmakers via The-Odds-API
- **Auto-refresh**: Every 6 hours via cron
- **Settlement**: Every 2 hours via cron — fetches results and closing odds automatically
- **Performance tab**: Tracks hit rate, Brier score, mean edge, CLV per market
- **Current output**: ~960 matches scraped → ~94 bettable → ~9 shortlisted

## Architecture
```
SoccerSTATS.com ──→ FlareSolverr ──→ GoalScout scraper
The-Odds-API ──→ League filtering + odds overlay
                        ↓
              Shortlist Engine (scoring)
                        ↓
              Probability Engine (P(O2.5), P(BTTS), fair odds, edge)
                        ↓
              Express API + HTML Dashboard (Shortlist + Performance tabs)
                        ↓
              Local JSON files (data/) + JSONL history (data/history/)
```

## Tech Stack
- Node.js 20 + Express
- Cheerio (HTML parsing)
- FlareSolverr (Cloudflare bypass, runs as separate Unraid container on 192.168.178.5:8191)
- The-Odds-API (3 free keys, 500 req/month each)
- Docker on Unraid, port 3030

## Key Environment Variables (in docker-compose.yml)
- FLARESOLVERR_URL=http://192.168.178.5:8191/v1
- DISPLAY_TIMEZONE=Australia/Melbourne
- ODDS_API_KEYS=<3 comma-separated keys>
- ODDS_REGIONS=au
- SOCCERSTATS_COOKIE=<session cookies — ASPSESSIONID changes, steady-token is long-lived>

## File Structure
```
goalscout/
├── Dockerfile
├── docker-compose.yml
├── package.json
├── public/index.html              # Dashboard UI (Shortlist + Performance tabs)
├── src/
│   ├── index.js                   # Express server + cron (refresh every 6h, settle every 2h)
│   ├── config.js                  # All config/thresholds/paths
│   ├── api/routes.js              # REST API endpoints
│   ├── engine/
│   │   ├── shortlist.js           # Scoring algorithm
│   │   ├── probability.js         # P(O2.5) and P(BTTS) estimation
│   │   ├── history.js             # Prediction logging + performance stats
│   │   └── settler.js             # Result fetcher + closing odds capture
│   ├── odds/the-odds-api.js       # Odds API integration
│   ├── scrapers/
│   │   ├── orchestrator.js        # Main refresh workflow (v3 bettable-first)
│   │   ├── match-discovery.js     # SoccerSTATS HTML parser
│   │   └── league-discovery.js    # League slug discovery
│   └── utils/
│       ├── fetcher.js             # HTTP client (FlareSolverr + fallback)
│       └── storage.js             # JSON file read/write
└── data/                          # Volume-mounted — persists across rebuilds, never deleted
    ├── discovered-matches.json
    ├── shortlist.json
    ├── meta.json
    ├── match-details/
    └── history/                   # Append-only JSONL — never overwritten
        ├── predictions.jsonl      # One line per market per match (deduped by fixtureId)
        ├── results.jsonl          # One line per settled fixture
        └── closing-odds.jsonl     # One line per closing odds capture
```

## API Endpoints
```
GET  /api/status       → refresh state + meta
GET  /api/shortlist    → shortlisted matches with probabilities
GET  /api/matches      → all discovered matches
GET  /api/leagues      → all discovered leagues
GET  /api/match/:id    → match detail (if scraped)
GET  /api/stats        → prediction performance stats (hit rate, Brier, CLV, edge)
GET  /api/predictions  → raw prediction history (last 100)
POST /api/refresh      → trigger manual refresh
POST /api/settle       → trigger manual settlement cycle
```

## How to Deploy Changes

> ⚠️ IMPORTANT — Docker image naming trap
>
> `docker compose` builds its OWN image named `goalscout-goalscout`.
> Running `docker build` separately creates a DIFFERENT image named `goalscout`.
> Compose ignores the `goalscout` image entirely and uses `goalscout-goalscout`.
> Always use `docker compose up --build` — never `docker build` separately.
> Check for the trap with: `docker images | grep goalscout` (should show ONE image only)

```bash
cd /mnt/user/appdata/goalscout

# 1. Copy updated source files into place first

# 2. Stop container and remove BOTH possible image names
docker compose down
docker rmi goalscout goalscout-goalscout 2>/dev/null || true

# 3. Clear builder cache
docker builder prune -f

# 4. Let compose build and start in one step
docker compose up --build -d

# 5. Verify the right image is running (should show ONE image: goalscout-goalscout)
docker images | grep goalscout

# 6. Check a specific file made it into the container
docker run --rm goalscout-goalscout grep -c "someString" /app/public/index.html

# 7. Watch logs
docker logs -f goalscout
```

## SoccerSTATS Cookie Refresh
The ASPSESSIONID cookie expires periodically. To refresh:
1. Log into soccerstats.com in browser
2. Open DevTools console, run: document.cookie
3. Update SOCCERSTATS_COOKIE in docker-compose.yml
4. Restart: docker compose down && docker compose up -d

## Known Issues / Next To Fix
1. **Bookmakers showing UK books**: William Hill, Matchbook not available in AU — need to filter to AU-only bookmakers (Bet365, Sportsbet, TAB, Neds, Unibet AU)
2. **Settled predictions table shows duplicates**: The recentSettled list in getPredictionStats() needs the same fixtureId+market dedup applied to classified[] — UI shows 4 rows for Wellington when there should be 2
3. **Odds missing for some matches**: Team name fuzzy matching between SoccerSTATS and Odds API needs improvement (e.g. Turkey matches not matching)
4. **Chelsea vs Man Utd stuck as "not yet completed"**: Odds API returning unknown status — likely API lag, should resolve automatically

## Recently Fixed (April 2026)
- ✅ League names now show full name ("England - Premier League") not short code ("ENG")
- ✅ Performance tab added with hit rate, Brier score, mean edge, CLV tracking
- ✅ Settlement cron added (every 2h) with manual "Settle now" button
- ✅ Prediction deduplication fixed — fixtureId alone prevents cross-day duplicates
- ✅ estimateKickoffUTC timezone bug fixed — early AEST times no longer map to wrong UTC day
- ✅ ABANDON_AFTER_HOURS raised 36→72 to prevent premature unknown marking
- ✅ Docker deploy trap documented — always use docker compose up --build

## Future Plans (not yet built)
- **Phase 2**: xG data from FBref for smarter scoring
- **Phase 2**: Calibration pass on probability weights once 200+ settled predictions exist
- **Phase 3**: Betfair Exchange API integration (account created, API key pending)
- **Phase 3**: Automated bet placement via Betfair

## User Details
- Location: Melbourne, Australia (AEST UTC+10 / AEDT UTC+11)
- Bookmakers: Bet365, Sportsbet, open to others
- Betfair account created, developer app "goalscout" registered
- SoccerSTATS paid membership active