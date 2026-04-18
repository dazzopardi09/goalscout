# GoalScout — Project Status & Continuation Guide

## What This Is
A local Unraid Docker app that identifies football matches worth investigating for Over 2.5 goals and BTTS (Both Teams To Score) betting markets.

## Current State (v2 — April 2026)
- **Working and deployed** on Unraid at port 3030
- **Bettable-first flow**: queries The-Odds-API for leagues with active AU betting markets, then only scrapes/scores matches in those leagues
- **Data source**: SoccerSTATS.com (paid membership, uses FlareSolverr for Cloudflare bypass)
- **Odds display**: Shows best Over 2.5 odds from AU bookmakers via The-Odds-API, filtered to a confirmed allowlist of AU-licensed books
- **Auto-refresh**: Every 6 hours via cron
- **Settlement**: Every 2 hours via cron — fetches results and closing odds automatically
- **Performance tab**: Tracks hit rate, Brier score, mean edge, CLV per market
- **Current output**: ~960 matches scraped → ~121 bettable → ~9 shortlisted

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
- The-Odds-API (4 free keys, 500 req/month each — see quota notes below)
- Docker on Unraid, port 3030

## Key Environment Variables (in docker-compose.yml)
- `FLARESOLVERR_URL=http://192.168.178.5:8191/v1`
- `DISPLAY_TIMEZONE=Australia/Melbourne`
- `ODDS_API_KEYS=<4 comma-separated keys>`
- `ODDS_REGIONS=au` — AU only. Adding `uk` doubles quota cost per call — not worth it
- `ODDS_BOOKMAKERS=sportsbet,tab,tabtouch,unibet,neds,ladbrokes_au,pointsbetau,betright,betr_au,playup`
- `ODDS_DAILY_LIMIT=50` — quota guard, resets at UTC midnight
- `SOCCERSTATS_COOKIE=<session cookies — ASPSESSIONID changes, steady-token is long-lived>`

## Bookmaker Configuration Notes
The-Odds-API uses specific internal key names. Confirmed from live API responses (April 2026):

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
| Betfair Exchange | `betfair_ex_au` — excluded (exchange, not fixed-odds) |

**Bet365** is not in The-Odds-API's AU region feed. Adding `uk` to `ODDS_REGIONS` gets Bet365 but doubles quota usage per call — quota was burned doing this today. Not worth it at the free tier.

**BTTS market** is not available from AU-region bookmakers on The-Odds-API. This is an API limitation, not a code issue. BTTS odds will always show `—` with the current setup.

## Quota Management
- 4 keys × 500 req/month = 2,000/month ≈ 65/day
- `ODDS_DAILY_LIMIT=50` guard in `the-odds-api.js` prevents runaway usage
- Daily counter resets at UTC midnight (in-memory — also resets on container restart)
- Every API call logs: `quota: X used, Y remaining | daily: N/50`
- Each refresh cycle uses roughly 6-10 calls depending on competitions shortlisted
- Settler (2h cron) uses additional calls for closing odds — factor this in during active debugging sessions

## File Structure
```
goalscout/
├── Dockerfile
├── docker-compose.yml
├── package.json
├── public/index.html              # Dashboard UI (Shortlist + Performance tabs)
├── src/
│   ├── index.js                   # Express server + cron (refresh 6h, settle 2h)
│   ├── config.js                  # All config/thresholds — ODDS_BOOKMAKERS, ODDS_DAILY_LIMIT
│   ├── api/routes.js              # REST API endpoints
│   ├── engine/
│   │   ├── shortlist.js           # Scoring algorithm
│   │   ├── probability.js         # P(O2.5) and P(BTTS) — propagates bookmakerKey
│   │   ├── history.js             # Prediction logging + performance stats
│   │   └── settler.js             # Result fetcher + closing odds capture
│   ├── odds/the-odds-api.js       # Odds API — quota guard, in-play guard, bookmaker filter, name overrides
│   ├── scrapers/
│   │   ├── orchestrator.js        # Main refresh workflow — logs unmatched fixtures
│   │   ├── match-discovery.js     # SoccerSTATS HTML parser
│   │   └── league-discovery.js    # League slug discovery
│   └── utils/
│       ├── fetcher.js             # HTTP client (FlareSolverr + fallback)
│       └── storage.js             # JSON file read/write
└── data/                          # Volume-mounted — persists across rebuilds
    ├── discovered-matches.json
    ├── shortlist.json
    ├── meta.json
    ├── match-details/
    └── history/                   # Append-only JSONL — never overwritten
        ├── predictions.jsonl
        ├── results.jsonl
        └── closing-odds.jsonl
```

## Prediction Record Structure
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

**Dedup logic**: Skip write if fixtureId+market already has `marketOdds` populated. If first write had null odds (matching failure), one re-write is allowed on next cycle. At read time, prefer record with odds populated.

## Odds Matching — Known Issues and Overrides
Most team names match via partial/substring normalisation. Hard cases use explicit overrides in `KNOWN_NAME_OVERRIDES` in `the-odds-api.js`:

```js
const KNOWN_NAME_OVERRIDES = {
  'gimnasia':      'gimnasia la plata',
  'e. rio cuarto': 'atletico de rio cuarto',
};
```

When a match fails, the log shows exactly what the API returned for that league:
```
[odds-api] no match for "Team A" vs "Team B" (leagueSlug)
[odds-api] available in soccer_xxx: Name1 vs Name2 | Name3 vs Name4 | ...
```
Add the correct mapping to `KNOWN_NAME_OVERRIDES` and redeploy. Completed/past-kickoff matches are silently suppressed — they're expected to be absent from the live odds feed.

## In-Play Guard
Events within 15 mins of kickoff (`INPLAY_BUFFER_MINS = 15`) are skipped entirely. Prevents in-game prices (e.g. 8.00 on a losing team) from being stored as tip-time snapshots or corrupting edge calculations.

## API Endpoints
```
GET  /api/status       → refresh state + meta
GET  /api/shortlist    → shortlisted matches with probabilities
GET  /api/matches      → all discovered matches
GET  /api/leagues      → all discovered leagues
GET  /api/match/:id    → match detail (if scraped)
GET  /api/stats        → prediction performance stats
GET  /api/predictions  → raw prediction history (last 100)
POST /api/refresh      → trigger manual refresh
POST /api/settle       → trigger manual settlement cycle
```

## How to Deploy Changes

> ⚠️ Docker image naming trap: `docker compose` builds `goalscout-goalscout`.
> `docker build` separately creates `goalscout` which compose ignores entirely.
> Always use `docker compose up --build`. Check with `docker images | grep goalscout` (one image only).

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

To continue in a new Claude session: "I'm continuing the GoalScout project. The repo is at https://github.com/dazzopardi09/goalscout and PROJECT-STATUS.md has full context."

## SoccerSTATS Cookie Refresh
1. Log into soccerstats.com in browser
2. DevTools console → `document.cookie`
3. Update `SOCCERSTATS_COOKIE` in docker-compose.yml
4. `docker compose down && docker compose up -d`

## Known Issues / Next To Fix

**1. Results source unreliable (highest priority)**
The-Odds-API `/scores` endpoint returned wrong result for Bielefeld vs FC Nurnberg (showed 2-0, actual 1-1). Corrupts Brier score and hit rate. Fix: switch settler to a dedicated results source. Candidates: Football-Data.org (free, reliable, top leagues) or API-Football (broader coverage). This should be the first thing done next session.

**2. EPL and some leagues have no O2.5 odds**
AU bookmakers don't offer O2.5 totals for EPL on The-Odds-API. Events exist in the feed but `o25` is null. Requires switching to a different API or adding UK region just for EPL — not worth the quota cost at free tier.

**3. BTTS odds always `—`**
AU region on The-Odds-API doesn't offer BTTS as a soccer market. Fundamental API limitation. Fix: migrate to API-Football (planned, not a quick patch).

**4. Tooltip hover states broken in UI**
`.tip:hover .tip-text` being clipped by table overflow. Fix: add `position:relative` to `.table-shell` in `public/index.html` CSS and change tooltip `z-index` to `9999`.

## Recently Fixed (April 2026)
- ✅ Bookmaker region config — fixed hardcoded `au,uk`, now uses `config.ODDS_REGIONS`
- ✅ Bookmaker allowlist — `ODDS_BOOKMAKERS` env var with correct API key names confirmed from live logs
- ✅ Daily quota guard — `ODDS_DAILY_LIMIT=50` stops calls when limit hit; logs daily usage on every call
- ✅ In-play guard — events within 15 mins of kickoff skipped to prevent corrupt price snapshots
- ✅ Odds snapshot integrity — `bookmakerKey` and `oddsSnapshotAt` stored in prediction records
- ✅ Missing market odds in history — allows one re-write if first write had null odds; read-time dedup prefers record with odds
- ✅ `bookmakerKey` propagated through `probability.js` → `history.js`
- ✅ Matching diagnostics — unmatched fixtures log actual API event names for the league
- ✅ No-match noise suppressed for completed/past-kickoff matches
- ✅ `KNOWN_NAME_OVERRIDES` map added for Argentina teams
- ✅ 4th API key added to rotation
- ✅ `config.js` — `ODDS_REGIONS`, `ODDS_BOOKMAKERS`, `ODDS_DAILY_LIMIT` all parsed and documented
- ✅ League names show full name ("England - Premier League") not short code
- ✅ Performance tab with hit rate, Brier score, mean edge, CLV
- ✅ Settlement cron (every 2h) with manual "Settle now" button
- ✅ Prediction deduplication by fixtureId+market
- ✅ estimateKickoffUTC timezone bug fixed
- ✅ ABANDON_AFTER_HOURS raised 36→72

## Odds API Alternatives — Research Done (April 2026)

**API-Football** — recommended for future migration
- Free: 100 calls/day. Paid: $19/month for 7,500/day
- Has BTTS market, EPL O2.5, Bet365 AU coverage, reliable results
- Different response schema (fixture-based, numeric IDs) — needs a new integration module
- Plan: replace The-Odds-API entirely, not run in parallel
- Timing: after 200+ settled predictions and calibration pass

**SportsGameOdds** — not suitable at current stage
- Free tier only covers 8 leagues (US sports + Champions League + MLS) — no EPL, Bundesliga
- Rookie plan $99/month for European leagues; Bet365 only at Pro ($299/month)

**Current setup (The-Odds-API)** — adequate for now
- Works well for Bundesliga, La Liga, Serie A, Danish SL, Swiss SL, etc.
- EPL totals and BTTS are known gaps — accepted for now

## Future Plans
- **Fix results source** — switch settler to Football-Data.org or API-Football (next session priority)
- **Phase 2** — xG data from FBref for smarter probability scoring
- **Phase 2** — Calibration pass once 200+ settled predictions exist
- **Phase 2** — API-Football migration for BTTS, Bet365, EPL totals
- **Phase 3** — Betfair Exchange API integration (account created, app "goalscout" registered)
- **Phase 3** — Automated pre-match bet placement via Betfair

## User Details
- Location: Melbourne, Australia (AEST UTC+10 / AEDT UTC+11)
- Bookmakers: Sportsbet primarily; Bet365 not currently in API feed
- Betfair account created, developer app "goalscout" registered
- SoccerSTATS paid membership active