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

### Future modules (not yet built)
BTTS, Draw No Bet, Team Totals, First Half O/U — all will be built as add-on modules on top of the same core probability engine once the baseline is validated.

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
```

## Tech Stack
- Node.js 20 + Express
- Cheerio (HTML parsing)
- FlareSolverr (Cloudflare bypass, Unraid container at 192.168.178.5:8191)
- The-Odds-API (4 free keys, 500 req/month each, UK region only)
- Docker on Unraid, port 3030

## Key Environment Variables (in docker-compose.yml)
- `FLARESOLVERR_URL=http://192.168.178.5:8191/v1`
- `DISPLAY_TIMEZONE=Australia/Melbourne`
- `ODDS_API_KEYS=<4 comma-separated keys>`
- `ODDS_REGIONS=uk` — UK only. Gives Bet365, Pinnacle, William Hill, Betfair Exchange, Paddy Power etc. AU region dropped to save quota.
- `ODDS_BOOKMAKERS=` — empty, no allowlist. Best price wins across all UK books.
- `ODDS_DAILY_LIMIT=40` — quota guard, resets UTC midnight
- `SOCCERSTATS_COOKIE=<session cookies>`

## Why UK Region Only
- AU region doesn't offer O2.5 totals for EPL — our biggest league gap
- AU region doesn't offer BTTS for soccer at all
- UK region gives Pinnacle (sharpest book, best reference for true probability) and Bet365
- Dropping AU halves quota usage per call
- For model calibration, price accuracy matters more than jurisdiction

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

**Direction decision**: whichever score is higher wins. Ties go to O2.5.
A match only appears on the shortlist if the winning direction score meets MIN_SCORE.
The same match cannot appear as both O2.5 and U2.5.

## Three-Snapshot Odds Capture
Each shortlisted match captures odds at three points in time:

| Snapshot | When | How | Purpose |
|---|---|---|---|
| `tip_time` | At shortlist (6h refresh) | Batch league fetch | Baseline price, what you'd bet at immediately |
| `pre_kickoff` | 25-35 mins before kickoff | Event-level fetch by settler | Post-lineup price, best actionable pre-match price |
| `closing` | As close to kickoff as possible | Event-level fetch by settler | CLV reference |

Price movement between tip_time and pre_kickoff is itself a signal:
- Odds shorten (O2.5 price drops) → market agrees, lineup confirmed the model's view
- Odds drift out (O2.5 price rises) → something changed (likely lineup news), model was early
- No movement → market hasn't reacted, or there's nothing to react to

The Odds API event ID is stored at shortlist time so the settler can use the event-level endpoint for efficient pre-kickoff and closing captures.

## Prediction Record Structure
One record per match per direction. Market is `over_2.5` or `under_2.5`.

```json
{
  "fixtureId": "germany_union-berlin_wolfsburg",
  "predictionDate": "2026-04-19",
  "predictionTimestamp": "2026-04-19T08:00:00.000Z",
  "modelVersion": "baseline-v1",
  "league": "Germany - Bundesliga",
  "leagueSlug": "germany",
  "homeTeam": "Union Berlin",
  "awayTeam": "Wolfsburg",
  "commenceTime": "2026-04-19T13:30:00Z",
  "eventId": "abc123def456",
  "market": "over_2.5",
  "selection": "over",
  "direction": "o25",
  "modelProbability": 0.63,
  "fairOdds": 1.59,
  "marketOdds": 1.83,
  "bookmaker": "Pinnacle",
  "bookmakerKey": "pinnacle",
  "oddsSnapshotAt": "2026-04-19T08:00:00.000Z",
  "edge": 15.1,
  "inputs": { ... }
}
```

Closing odds file stores all three snapshot types:
```json
{ "fixtureId": "...", "market": "over_2.5", "snapshotType": "tip_time", "decimalOdds": 1.85, ... }
{ "fixtureId": "...", "market": "over_2.5", "snapshotType": "pre_kickoff", "decimalOdds": 1.78, ... }
{ "fixtureId": "...", "market": "over_2.5", "snapshotType": "closing", "decimalOdds": 1.75, ... }
```

## Performance Tracking
Two independent market tabs in the Performance panel:

**Over 2.5 tab** tracks:
- Hit rate (did the match have 3+ goals?)
- Mean model probability vs actual frequency (calibration)
- Brier score
- Mean edge at tip-time
- Mean CLV (tip-time vs closing)
- Price movement (tip-time vs pre-kickoff drift)

**Under 2.5 tab** tracks the same metrics for the Under direction.

This allows independent calibration of each direction. Historically, Under models and Over models have different calibration needs — Over is more dependent on form and TG, Under is more dependent on defensive structure and CS%.

## File Structure
```
goalscout/
├── Dockerfile
├── docker-compose.yml
├── package.json
├── public/index.html              # Dashboard — Shortlist + Performance (O2.5 + U2.5 tabs)
├── src/
│   ├── index.js                   # Express server + cron
│   ├── config.js                  # All config — ODDS_REGIONS, ODDS_DAILY_LIMIT etc
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
        ├── predictions.jsonl      # One record per match, market = over_2.5 or under_2.5
        ├── results.jsonl          # Settled results
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
git commit -m "description"
git push
```

To continue in a new session: "I'm continuing the GoalScout project. Repo is at https://github.com/dazzopardi09/goalscout — PROJECT-STATUS.md has full context."

## SoccerSTATS Cookie Refresh
1. Log into soccerstats.com in browser
2. DevTools console → `document.cookie`
3. Update `SOCCERSTATS_COOKIE` in docker-compose.yml
4. `docker compose down && docker compose up -d`

## Known Issues / Next Session Work

**Priority 1 — Results source fix**
The-Odds-API `/scores` endpoint is unreliable (returned 2-0 for Bielefeld vs Nurnberg, actual was 1-1). Corrupts Brier score and hit rate. Switch settler to Football-Data.org or API-Football for match results. This must be fixed before calibration data is meaningful.

**Priority 2 — Full scope change implementation (next session)**
The following changes are planned and documented but not yet built:

1. **`shortlist.js`** — Add U2.5 scoring flags, directional call logic, `direction` field per match
2. **`the-odds-api.js`** — Capture both Over and Under prices, store event ID, switch to UK region only
3. **`probability.js`** — Add U2.5 fair odds and edge (P(U2.5) = 1 - P(O2.5))
4. **`history.js`** — Log `over_2.5` or `under_2.5` per match direction, drop BTTS
5. **`settler.js`** — Three-snapshot capture (tip_time already done, add pre_kickoff + closing), use event ID for efficient event-level fetches
6. **`orchestrator.js`** — Pass direction through, attach correct odds (Over or Under) per match
7. **`docker-compose.yml`** — `ODDS_REGIONS=uk`, remove `ODDS_BOOKMAKERS`
8. **`public/index.html`** — Replace BTTS column with U2.5 stats (CS%/FTS%), show direction badge per row, rename Performance tabs to O2.5 and U2.5

**Priority 3 — Tooltip hover fix**
Add `position:relative` to `.table-shell` and `z-index:9999` on tooltip. Small CSS-only fix.

## Recently Completed (April 2026)
- ✅ Bookmaker region config — env-driven, no hardcodes
- ✅ Bookmaker allowlist with correct API key names
- ✅ Daily quota guard (ODDS_DAILY_LIMIT)
- ✅ In-play guard — skips events within 15 mins of kickoff
- ✅ Odds snapshot integrity — bookmakerKey + oddsSnapshotAt in predictions
- ✅ Prediction dedup — allows one odds-update write if first write had null odds
- ✅ Matching diagnostics — logs actual API names when fuzzy match fails
- ✅ KNOWN_NAME_OVERRIDES for Argentina teams
- ✅ Performance tab with O2.5 / BTTS market tabs (BTTS tab will become U2.5)
- ✅ Settlement cron + manual settle button
- ✅ Prediction deduplication by fixtureId+market
- ✅ estimateKickoffUTC timezone fix
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