# GoalScout — Project Status & Continuation Guide

## What This Is
A local Unraid Docker app that identifies football matches worth investigating for Over 2.5 goals and BTTS (Both Teams To Score) betting markets.

## Current State (v2 — April 2026)
- **Working and deployed** on Unraid at port 3030
- **Bettable-first flow**: queries The-Odds-API for leagues with active AU betting markets, then only scrapes/scores matches in those leagues
- **Data source**: SoccerSTATS.com (paid membership, uses FlareSolverr for Cloudflare bypass)
- **Odds display**: Shows best Over 2.5 odds from AU+UK bookmakers via The-Odds-API, filtered to a specific allowlist of AU-licensed books plus Bet365 (UK feed)
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
- `FLARESOLVERR_URL=http://192.168.178.5:8191/v1`
- `DISPLAY_TIMEZONE=Australia/Melbourne`
- `ODDS_API_KEYS=<3 comma-separated keys>`
- `ODDS_REGIONS=au,uk` — AU for AU-licensed books, UK to get Bet365
- `ODDS_BOOKMAKERS=sportsbet,tab,tabtouch,unibet,neds,ladbrokes_au,pointsbetau,betright,betr_au,playup,bet365`
- `SOCCERSTATS_COOKIE=<session cookies — ASPSESSIONID changes, steady-token is long-lived>`

## Bookmaker Configuration Notes
The-Odds-API uses specific internal key names that differ from display names:

| Display Name | API Key |
|---|---|
| SportsBet | `sportsbet` |
| TAB | `tab` |
| TABtouch | `tabtouch` |
| Unibet | `unibet` |
| Neds | `neds` |
| Ladbrokes | `ladbrokes_au` |
| PointsBet (AU) | `pointsbetau` |
| Bet Right | `betright` |
| Betr | `betr_au` |
| PlayUp | `playup` |
| Bet365 | `bet365` (UK feed — not available in AU region) |
| Betfair Exchange | `betfair_ex_au` (excluded — exchange, not fixed-odds) |

**Important**: Bet365 is not available in The-Odds-API's AU region feed. We include `uk` in `ODDS_REGIONS` solely to access Bet365 prices. UK Bet365 prices on European markets are effectively identical to AU.

**Important**: `ODDS_BOOKMAKERS` is an allowlist — if empty, all books in the API response are eligible. When set, only listed books compete for best price. The app always shows the single highest price across all allowed books, with the winning bookmaker name displayed.

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
│   │   ├── probability.js         # P(O2.5) and P(BTTS) estimation + edge calculation
│   │   ├── history.js             # Prediction logging + performance stats
│   │   └── settler.js             # Result fetcher + closing odds capture
│   ├── odds/the-odds-api.js       # Odds API integration (region + bookmaker filtering)
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
        ├── predictions.jsonl      # One line per market per match (deduped at read time)
        ├── results.jsonl          # One line per settled fixture
        └── closing-odds.jsonl     # One line per closing odds capture
```

## Prediction Record Structure
Each prediction in `predictions.jsonl` stores a full snapshot at tip time:
```json
{
  "fixtureId": "germany2_dynamo-dresden_bochum",
  "predictionDate": "2026-04-18",
  "predictionTimestamp": "2026-04-18T11:55:00.000Z",
  "modelVersion": "baseline-v1",
  "league": "Germany - 2. Bundesliga",
  "leagueSlug": "germany2",
  "homeTeam": "Dynamo Dresden",
  "awayTeam": "Bochum",
  "commenceTime": "2026-04-18T11:30:00Z",
  "market": "over_2.5",
  "selection": "over",
  "modelProbability": 0.67,
  "fairOdds": 1.49,
  "marketOdds": 1.89,
  "bookmaker": "Unibet",
  "bookmakerKey": "unibet",
  "oddsSnapshotAt": "2026-04-18T11:55:00.000Z",
  "edge": 26.8,
  "inputs": { ... }
}
```

**Dedup logic**: At write time, a prediction is skipped if the same fixtureId+market already exists WITH `marketOdds` populated. If the existing record has null odds (odds matching failed on first refresh), one update is permitted on the next cycle so the snapshot gets captured. At read time, the record with odds wins over the record without.

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

# 6. Watch logs
docker logs -f goalscout
```

## SoccerSTATS Cookie Refresh
The ASPSESSIONID cookie expires periodically. To refresh:
1. Log into soccerstats.com in browser
2. Open DevTools console, run: `document.cookie`
3. Update `SOCCERSTATS_COOKIE` in docker-compose.yml
4. Restart: `docker compose down && docker compose up -d`

## Known Issues / Next To Fix
1. **Odds missing for some matches**: Team name fuzzy matching between SoccerSTATS and Odds API still fails for some fixtures (e.g. some Turkish and Argentine clubs). Unmatched matches are now logged by name so you can diagnose them: `docker logs goalscout 2>&1 | grep "no odds match"`
2. **Settled predictions table shows duplicates**: The recentSettled list in `getPredictionStats()` needs the same fixtureId+market dedup applied to `classified[]` — UI shows 4 rows for Wellington when there should be 2
3. **Chelsea vs Man Utd stuck as "not yet completed"**: Odds API returning unknown status — likely API lag, should resolve automatically

## Recently Fixed (April 2026)
- ✅ **Bookmaker region config**: Fixed hardcoded `au,uk` in `fetchOddsForShortlist` — now reads from `ODDS_REGIONS` env var
- ✅ **Bookmaker allowlist**: Added `ODDS_BOOKMAKERS` env var — only listed books compete for best price display. Correct API key names confirmed from live logs (e.g. `betr_au` not `betr`, `pointsbetau` not `pointsbet`)
- ✅ **Bet365 added**: Included UK region to get Bet365 prices (not available in AU feed)
- ✅ **Odds snapshot integrity**: `bookmakerKey` and `oddsSnapshotAt` now stored in prediction records
- ✅ **Missing market odds in history**: `history.js` now allows one odds-update write if first write had null odds (matching failure). Dedup at read time prefers records with odds populated
- ✅ **`bookmakerKey` propagated**: `probability.js` now passes `bookmakerKey` through analysis output so it reaches the prediction log
- ✅ **Odds matching diagnostics**: `orchestrator.js` now logs unmatched fixtures by team name for debugging
- ✅ **Settler hardcoded region fixed**: `settler.js` `fetchCurrentOddsForSport` now uses `config.ODDS_REGIONS` instead of hardcoded `au,uk`
- ✅ **League names now show full name** ("England - Premier League") not short code ("ENG")
- ✅ **Performance tab** added with hit rate, Brier score, mean edge, CLV tracking
- ✅ **Settlement cron** added (every 2h) with manual "Settle now" button
- ✅ **Prediction deduplication fixed** — fixtureId alone prevents cross-day duplicates
- ✅ **estimateKickoffUTC timezone bug fixed** — early AEST times no longer map to wrong UTC day
- ✅ **ABANDON_AFTER_HOURS raised** 36→72 to prevent premature unknown marking
- ✅ **Docker deploy trap documented** — always use `docker compose up --build`

## Future Plans (not yet built)
- **Phase 2**: xG data from FBref for smarter probability scoring
- **Phase 2**: Calibration pass on probability weights once 200+ settled predictions exist
- **Phase 2**: Improve team name fuzzy matching for Turkish, Argentine, and other non-European leagues
- **Phase 3**: Betfair Exchange API integration (account created, API key pending)
- **Phase 3**: Automated bet placement via Betfair

## User Details
- Location: Melbourne, Australia (AEST UTC+10 / AEDT UTC+11)
- Bookmakers: Bet365, Sportsbet, open to others
- Betfair account created, developer app "goalscout" registered
- SoccerSTATS paid membership active