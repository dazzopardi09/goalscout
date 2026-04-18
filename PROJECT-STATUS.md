# GoalScout — Project Status & Continuation Guide

## What This Is
A local Unraid Docker app that identifies football matches worth investigating for Over 2.5 goals and BTTS (Both Teams To Score) betting markets.

## Current State (v2 — April 2026)
- **Working and deployed** on Unraid at port 3030
- **Bettable-first flow**: queries The-Odds-API for leagues with active AU betting markets, then only scrapes/scores matches in those leagues
- **Data source**: SoccerSTATS.com (paid membership, uses FlareSolverr for Cloudflare bypass)
- **Odds display**: Shows best Over 2.5 odds from AU/UK bookmakers via The-Odds-API
- **Auto-refresh**: Every 6 hours via cron
- **Current output**: ~960 matches scraped → ~94 bettable → ~10 shortlisted

## Architecture
```
SoccerSTATS.com ──→ FlareSolverr ──→ GoalScout scraper
The-Odds-API ──→ League filtering + odds overlay
                        ↓
              Shortlist Engine (scoring)
                        ↓
              Express API + HTML Dashboard
                        ↓
              Local JSON files (data/)
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
├── public/index.html              # Dashboard UI
├── src/
│   ├── index.js                   # Express server + cron
│   ├── config.js                  # All config/thresholds
│   ├── api/routes.js              # REST API endpoints
│   ├── engine/shortlist.js        # Scoring algorithm
│   ├── odds/the-odds-api.js       # Odds API integration
│   ├── scrapers/
│   │   ├── orchestrator.js        # Main refresh workflow (v3 bettable-first)
│   │   ├── match-discovery.js     # SoccerSTATS HTML parser
│   │   └── league-discovery.js    # League slug discovery
│   └── utils/
│       ├── fetcher.js             # HTTP client (FlareSolverr + fallback)
│       └── storage.js             # JSON file read/write
└── data/                          # Runtime JSON cache (not in repo)
```

## Known Issues To Fix
1. **Timezone wrong**: SoccerSTATS times are already AEST (tz=600 cookie) but showing wrong. Newcastle v Bournemouth shows 01:00 but should be 00:00.
2. **League names too short**: Shows "ENG" / "TUR" — need full league name like "England - Premier League"
3. **Stats bar too busy**: Only need Shortlisted count and Last Updated, rest is noise
4. **Tooltips show '?' cursor but no text**: Native title tooltips may not be rendering properly on hover
5. **Day column**: Should show actual date (e.g. "Sat 19 Apr") not just "Today/Tomorrow"
6. **Odds missing for some matches**: Team name fuzzy matching between SoccerSTATS and Odds API needs improvement

## Future Plans (not yet built)
- **Phase 2**: xG data from FBref for smarter scoring
- **Phase 2**: Value detection (fair probability vs market odds)
- **Phase 3**: Betfair Exchange API integration (account created, API key pending)
- **Phase 3**: Automated bet placement via Betfair

## User Details
- Location: Melbourne, Australia (AEST UTC+10 / AEDT UTC+11)
- Bookmakers: Bet365, Sportsbet, open to others
- Betfair account created, developer app "goalscout" registered
- SoccerSTATS paid membership active

## How to Deploy Changes
```bash
cd /mnt/user/appdata/goalscout
# Copy updated files to their paths
docker compose down
docker rmi $(docker images -q goalscout*) 2>/dev/null
docker builder prune -af
docker build --no-cache -t goalscout .
docker compose up -d
docker logs -f goalscout
```

## SoccerSTATS Cookie Refresh
The ASPSESSIONID cookie expires periodically. To refresh:
1. Log into soccerstats.com in browser
2. Open DevTools console, run: document.cookie
3. Update SOCCERSTATS_COOKIE in docker-compose.yml
4. Restart: docker compose down && docker compose up -d
