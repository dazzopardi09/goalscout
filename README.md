# GoalScout v1.0

**Football match investigation tool — Over 2.5 & BTTS shortlisting from SoccerSTATS**

Phase 1: discovery → shortlist → investigate.

---

## Architecture overview

```
┌─────────────────────────────────────────────────────────────┐
│                        GoalScout                            │
├─────────────┬───────────────┬───────────────┬───────────────┤
│  Discovery  │  Shortlist    │  Enrichment   │  Presentation │
│  Layer      │  Engine       │  Layer        │  Layer        │
├─────────────┼───────────────┼───────────────┼───────────────┤
│ matches.asp │ scoring algo  │ pmatch.asp    │ Express API   │
│ leagues.asp │ flag system   │ league detail │ HTML dashboard│
│ latest.asp  │ grade bands   │ (future: h2h) │ JSON cache    │
├─────────────┴───────────────┴───────────────┴───────────────┤
│                    Local JSON Storage                       │
├─────────────────────────────────────────────────────────────┤
│  ┌─ FUTURE ──────────────────────────────────────────────┐  │
│  │  Phase 2: Odds ingestion → value detection            │  │
│  │  Phase 3: Bookmaker execution → automated placement   │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### Workflow

1. **Discover** — Scrape `matches.asp?listing=2` for today's matches
   with per-match stats (O2.5%, BTTS%, PPG, TG, CS, FTS, W%).
   Also scrape `matches.asp?matchday=2` for tomorrow.

2. **Supplement** — For each league found, scrape `latest.asp?league=xxx`
   for additional fixtures and league-level aggregate stats.

3. **Score** — Run every match through the shortlist engine.
   Generate positive flags (high O2.5%, high BTTS%, goal-heavy,
   PPG mismatch) and negative flags (high FTS%, high CS%).
   Assign grade: A+ / A / B / C.

4. **Enrich** — For the top 15 shortlisted matches, scrape the
   `pmatch.asp` detail page for head-to-head, form, and deeper stats.

5. **Store** — Write everything to local JSON files (overwrite).
   No database. No archive. Just the latest snapshot.

6. **Serve** — Express serves the cached JSON via API endpoints.
   The HTML dashboard reads the API. No live scraping on page load.

7. **Schedule** — Cron runs the full cycle every 6 hours.
   Manual refresh available via dashboard button.

---

## SoccerSTATS pages used

| Page | URL pattern | Purpose | Data extracted |
|------|------------|---------|----------------|
| Matches (Sortable #2) | `matches.asp?matchday=1&listing=2` | Primary match discovery | Per-match: O2.5%, BTTS%, FTS%, CS%, W%, TG, PPG, GP |
| Matches (tomorrow) | `matches.asp?matchday=2&listing=2` | Tomorrow's fixtures | Same as above |
| Leagues index | `leagues.asp` | Discover all league slugs | League names + URL slugs |
| League page | `latest.asp?league=xxx` | Supplementary fixtures + league stats | Fixtures, league-level O2.5/BTTS/avg goals |
| Match detail | `pmatch.asp?...` | Deep analysis for shortlisted matches | H2H, form, goal times, performance |

### Why Sortable #2?

The `listing=2` format gives columns: PPG, TG, W%, CS, FTS, BTS, 2.5+.
This is exactly the data needed for O2.5 and BTTS investigation scoring.
The `listing=1` format gives: PPG, TG, GF, GA, 1.5+, 2.5+, 3.5+ — also
useful but missing BTTS directly.

### Known limitation: 10-match cap

The public (non-member) version of matches.asp is limited to **10 matches
maximum**. This is a hard server-side limit from SoccerSTATS. A membership
removes this cap.

**Mitigation**: We also scrape individual league pages (`latest.asp?league=xxx`)
which show upcoming fixtures for that league without the 10-match limit.
However, the per-match stats from league pages are less structured than
the matches.asp sortable format.

**Recommendation**: If you're serious about this tool, a SoccerSTATS membership
is worthwhile. The app will automatically process more matches when more are
returned by the page.

---

## Shortlist scoring methodology

Each match is scored by additive flags:

### O2.5 flags
| Condition | Points | Why |
|-----------|--------|-----|
| Home O2.5% ≥ 70 | +3 | Very strong goals signal |
| Home O2.5% ≥ 60 | +2 | Strong goals signal |
| Home O2.5% ≥ 50 | +1 | Moderate goals signal |
| Away O2.5% ≥ 70 | +3 | Very strong goals signal |
| Away O2.5% ≥ 60 | +2 | Strong goals signal |
| Away O2.5% ≥ 50 | +1 | Moderate goals signal |
| Home avg TG ≥ 2.5 | +1 | Goal-heavy team |
| Away avg TG ≥ 2.5 | +1 | Goal-heavy team |
| Combined avg TG ≥ 5.0 | +1 | Both teams goal-heavy |
| League O2.5% ≥ 50 | +1 | High-scoring league |
| League avg goals ≥ 2.8 | +1 | High-scoring league |
| PPG mismatch | +1 | Dominant vs weak → goals |

### BTTS flags
| Condition | Points | Why |
|-----------|--------|-----|
| Home BTTS% ≥ 70 | +3 | Very strong BTTS signal |
| Home BTTS% ≥ 60 | +2 | Strong BTTS signal |
| Home BTTS% ≥ 50 | +1 | Moderate BTTS signal |
| Away BTTS% ≥ 70 | +3 | Very strong BTTS signal |
| Away BTTS% ≥ 60 | +2 | Strong BTTS signal |
| Away BTTS% ≥ 50 | +1 | Moderate BTTS signal |
| League BTTS% ≥ 50 | +1 | High-BTTS league |

### Negative flags
| Condition | Points | Why |
|-----------|--------|-----|
| Home FTS% ≥ 40 | -1 | Home often fails to score |
| Away FTS% ≥ 40 | -1 | Away often fails to score |
| Home CS% ≥ 40 | -1 | Home keeps clean sheets (less BTTS) |
| Away CS% ≥ 40 | -1 | Away keeps clean sheets (less BTTS) |

### Grade bands
| Grade | Score | Meaning |
|-------|-------|---------|
| A+ | ≥ 8 | Very strong investigation candidate |
| A | ≥ 6 | Strong candidate |
| B | ≥ 4 | Worth a look |
| C | ≥ 3 | Borderline — minimum for shortlist |

---

## Data storage

```
data/
├── discovered-matches.json   # All matches with scores
├── leagues.json              # All discovered league slugs
├── shortlist.json            # Only shortlisted matches
├── meta.json                 # Refresh metadata
└── match-details/
    └── <match-id>.json       # Deep analysis per match
```

All files are **overwritten** on each refresh. No history.
JSON format, human-readable.

---

## API endpoints

| Method | Path | Returns |
|--------|------|---------|
| GET | `/api/status` | Refresh state + metadata |
| GET | `/api/shortlist` | Shortlisted matches array |
| GET | `/api/matches` | All discovered matches |
| GET | `/api/leagues` | All discovered leagues |
| GET | `/api/match/:id` | Detail for one match |
| POST | `/api/refresh` | Trigger manual refresh |

### Future endpoints (not yet implemented)
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/odds/:id` | Bookmaker odds for a match |
| GET | `/api/value` | Value-flagged matches |
| POST | `/api/execute` | Place a bet (phase 3) |

---

## Setup on Unraid

### Option A: Docker Compose (recommended for first setup)

1. Copy the entire `goalscout/` folder to your Unraid server:
   ```
   scp -r goalscout/ root@<unraid-ip>:/mnt/user/appdata/goalscout/
   ```

2. SSH into Unraid:
   ```
   ssh root@<unraid-ip>
   cd /mnt/user/appdata/goalscout
   docker compose up -d
   ```

3. Access the dashboard at `http://<unraid-ip>:3000`

### Option B: Manual Docker build

1. Copy files to Unraid as above.

2. Build the image:
   ```
   cd /mnt/user/appdata/goalscout
   docker build -t goalscout .
   ```

3. Run the container:
   ```
   docker run -d \
     --name goalscout \
     --restart unless-stopped \
     -p 3000:3000 \
     -v /mnt/user/appdata/goalscout/data:/app/data \
     goalscout
   ```

### Option C: Unraid Community Applications template

Create a template in Unraid's Docker UI:

| Field | Value |
|-------|-------|
| Name | GoalScout |
| Repository | (use local build path) |
| Network Type | Bridge |
| Port Mapping | Host: 3000 → Container: 3000 |
| Volume Mapping | Host: /mnt/user/appdata/goalscout/data → Container: /app/data |
| Extra Parameters | --restart unless-stopped |

### Verify it's working

1. Visit `http://<unraid-ip>:3000`
2. The dashboard should show "Refreshing..." on first load
3. After 1-2 minutes, matches should appear
4. Check logs: `docker logs goalscout`

### Persistent data

The `/app/data` volume contains all cached JSON files.
Map this to `/mnt/user/appdata/goalscout/data` on Unraid
so data survives container restarts.

---

## Assumptions and limitations

### Assumptions
1. SoccerSTATS uses server-rendered HTML tables (not client-side JS).
   Verified: the site uses classic ASP with HTML tables.

2. The Sortable #2 column order (PPG/TG/W%/CS/FTS/BTS/2.5+) is stable.
   If SoccerSTATS reorders columns, the parser will extract wrong data.
   The code logs warnings when expected patterns don't match.

3. League slugs in URLs (e.g., `league=italy`, `league=germany2`) are
   stable identifiers. If they change, league discovery still works
   but existing cached data may not correlate.

4. SoccerSTATS tolerates polite scraping (1.5s delay between requests).
   The app makes ~15-30 requests per refresh cycle, spread over minutes.

### Known limitations

1. **10-match cap** on the public matches.asp page. Members get all matches.
   League-page scraping partially mitigates this but with less structured data.

2. **Cup matches often lack stats**. When SoccerSTATS doesn't have enough
   season data for a cup tie, stat columns are empty. The app handles this
   gracefully (shows "No stats available").

3. **League page parsing is best-effort**. The `latest.asp` pages have
   inconsistent layouts across leagues. The parser uses heuristics
   (pmatch links, time patterns, team name patterns) that may miss some
   fixtures in unusual layouts.

4. **Match detail parsing is regex-based**. The `pmatch.asp` pages contain
   rich data in complex table layouts. The current parser extracts text
   blocks and searches for patterns. It will miss some structured data.
   This is intentionally kept simple for phase 1.

5. **No odds data**. Phase 1 has no bookmaker integration. The shortlist
   answers "worth investigating?" not "is there value?".

6. **Selector fragility**. If SoccerSTATS changes their HTML structure,
   the parsers will break. The code is designed to degrade gracefully
   (return empty data, log warnings) rather than crash.

---

## Future extension path

### Phase 2: Odds ingestion + value detection

**Architecture additions:**
```
src/
├── odds/
│   ├── provider.js        # Abstract odds provider interface
│   ├── oddschecker.js     # Scrape OddsChecker (or similar)
│   ├── betfair.js         # Betfair Exchange API
│   └── odds-cache.js      # Local odds cache
├── engine/
│   ├── shortlist.js       # (existing)
│   ├── fair-price.js      # Calculate implied probability
│   └── value-engine.js    # Compare fair prob vs market odds
```

**New data files:**
```
data/
├── odds.json              # Latest odds snapshot
├── value-flags.json       # Matches with identified value
```

**New API endpoints:**
- `GET /api/odds/:id` — odds for a match
- `GET /api/value` — value-flagged matches

**Value calculation:**
1. Convert shortlist score → estimated fair probability for O2.5 / BTTS
2. Ingest bookmaker odds → implied probability
3. If fair prob > implied prob + margin threshold → flag as value

### Phase 3: Bookmaker execution

**Architecture additions:**
```
src/
├── execution/
│   ├── executor.js        # Abstract bet placement interface
│   ├── betfair-exec.js    # Betfair API execution
│   ├── bookmaker-exec.js  # Generic bookmaker execution
│   ├── watchlist.js       # Match watchlist with alerts
│   └── stake-engine.js    # Kelly criterion / flat staking
```

**New data files:**
```
data/
├── watchlist.json          # Tracked matches awaiting execution
├── execution-log.json     # Placed bet history
├── bankroll.json          # Bankroll tracking
```

**New API endpoints:**
- `POST /api/watch/:id` — add match to watchlist
- `POST /api/execute` — place a bet
- `GET /api/history` — execution history

The current code structure (discovery → engine → API → UI) is designed
so these layers can be added alongside without restructuring.

---

## Tuning the shortlist

Edit `src/config.js` → `THRESHOLDS` to adjust:

- `O25_FLAG`: minimum O2.5% to generate a flag (default 50)
- `BTTS_FLAG`: minimum BTTS% to generate a flag (default 50)
- `TG_FLAG`: minimum avg total goals for a flag (default 2.5)
- `PPG_STRONG`: PPG threshold for "dominant" team (default 2.0)
- `PPG_WEAK`: PPG threshold for "weak" team (default 1.0)
- `FTS_HIGH`: FTS% threshold for negative flag (default 40)
- `CS_HIGH`: CS% threshold for negative flag (default 40)
- `MIN_SCORE`: minimum composite score for shortlist (default 3)

Lower `MIN_SCORE` to see more matches; raise it for tighter filtering.

---

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| No matches shown | First refresh still running | Wait 1-2 minutes, check `docker logs` |
| Only 10 matches | Public SoccerSTATS limit | Get membership, or rely on league page supplements |
| Stats all show "—" | Cup matches or early-season | Normal — cup ties often lack season stats |
| Refresh errors | SoccerSTATS down or blocking | Check logs; increase `REQUEST_DELAY_MS` in config |
| Empty shortlist | No matches meet threshold | Lower `MIN_SCORE` in config, or no matches today |
