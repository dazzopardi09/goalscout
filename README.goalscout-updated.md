# GoalScout v3

**Football betting probability engine — Over 2.5 and Under 2.5 goals**

GoalScout identifies pre-match football betting opportunities in the O2.5 and U2.5 goals markets by estimating true match probabilities, comparing them against bookmaker prices, and surfacing edge.

---

## Current State — 24 Apr 2026

GoalScout is now running as a local Unraid Docker app with:

- **Today-only refresh mode** for the live shortlist.
- **Bettable-first league selection** using SoccerSTATS leagues that have a mapped active Odds API soccer competition.
- **Expanded Odds API soccer map** after filtering `/v4/sports` down to active `soccer_` competitions.
- **Paid Odds API subscription active** with roughly 20,000 monthly requests.
- **O2.5 / U2.5 directional model live**.
- **Current + Calibrated model streams live**.
- **Settlement working again** after replacing stale `mapLeagueSlugToSportKey` references with `getOddsKey()`.
- **Prediction duplicate logging fixed** so future rows are one per `fixtureId + method + direction`.
- **One-off prediction dedupe completed**: `174 → 120` rows, `54` duplicates removed.
- **Shortlist default sort changed to kickoff ascending**.

Known current limitation:

- The settler still uses The Odds API `/scores`. This is now functioning again, but it previously showed at least one incorrect result, so a more reliable results source remains a priority before trusting calibration/ROI fully.

---

## What It Does

For each shortlisted match, GoalScout:

1. **Makes a directional call** — Over 2.5 *or* Under 2.5. Never both for the same model row.
2. **Estimates probability** — P(O2.5) from weighted team and league stats. P(U2.5) = 1 − P(O2.5).
3. **Calculates fair odds** — 1 / probability, no margin applied.
4. **Measures edge** — how much the bookmaker price exceeds fair odds. Positive = potential value.
5. **Captures odds** at shortlist time and attempts pre-kickoff / closing snapshots via settler.
6. **Settles results** and tracks performance independently by market and model method.

---

## Live Refresh Flow

Current production refresh flow:

```text
1. Fetch active Odds API sports list
2. Keep only active soccer competitions: key starts with soccer_
3. Build bettable SoccerSTATS slug map from SLUG_TO_ODDS_MAP
4. Scrape SoccerSTATS today page only
5. Keep only matches from SoccerSTATS leagues that are mapped to active Odds API competitions
6. Fetch SoccerSTATS league pages only for those eligible leagues
7. Score all eligible matches
8. Build Current and Calibrated shortlists
9. Fetch O/U 2.5 odds only for shortlisted competitions
10. Write shortlist, discovered matches, and metadata
```

Why today-only:

- Lower noise.
- Fewer league-page fetches.
- Fewer odds calls.
- Easier debugging.
- Live shortlist now reflects actionable matches rather than mixing today/tomorrow pools.

---

## Architecture

```text
SoccerSTATS.com
  └─ FlareSolverr
       └─ Match scraper

The-Odds-API
  └─ Active soccer competition list
  └─ O/U 2.5 odds fetches

SLUG_TO_ODDS_MAP
  └─ Maps SoccerSTATS league slugs to Odds API soccer keys

Shortlist Engine
  └─ Directional scoring: O2.5 signals vs U2.5 signals
  └─ One direction per match per method

Probability Engine
  └─ P(O2.5), P(U2.5), fair odds, edge

Settlement Engine
  └─ Fetches completed scores
  └─ Matches scores back to pending predictions
  └─ Updates predictions.jsonl + appends results.jsonl

Express API + HTML Dashboard
  └─ Shortlist tab
  └─ Performance tab
```

---

## Model Architecture

GoalScout runs two model streams on the same eligible match pool.

### Current model

- Uses directional scoring system.
- Direction comes from stronger O2.5 or U2.5 score.
- Baseline production model.

### Calibrated model

- Uses calibrated probabilities.
- Selects direction from calibrated O2.5 / U2.5 probability.
- Runs independently from the current model.

Both models:

- evaluate the same bettable input pool,
- produce separate shortlist rows,
- are logged with `method: "current"` or `method: "calibrated"`,
- are evaluated separately in performance.

---

## Directional Scoring

Each match is scored in both directions. The higher score determines the recommendation.

### O2.5 signals

| Signal | Effect |
|---|---|
| High home/away O2.5% | Positive |
| High combined average total goals | Positive |
| High league O2.5% | Positive |
| PPG mismatch | Positive |
| High clean-sheet / failed-to-score rates | Negative |

### U2.5 signals

| Signal | Effect |
|---|---|
| High clean-sheet rates | Positive |
| High failed-to-score rates | Positive |
| Low combined total goals | Positive |
| Low team O2.5% | Positive |
| High team O2.5% / high TG | Negative |

Ties are excluded as ambiguous rather than forced to O2.5.

---

## Probability Model

**P(Over 2.5)** is a weighted estimate from:

- home team O2.5 rate,
- away team O2.5 rate,
- league O2.5 rate,
- combined total-goals signal.

**P(Under 2.5)** = `1 - P(Over 2.5)`

**Fair odds** = `1 / probability`

**Edge** = `(market odds / fair odds - 1) × 100%`

---

## Odds Source

GoalScout uses The Odds API with a paid key.

Current behaviour:

- sports list fetched from `/v4/sports`,
- filtered to active soccer competitions only,
- cached in `data/odds-cache.json`,
- odds fetched only for shortlisted competitions,
- O/U 2.5 totals market only.

The active soccer competition list is cached because it changes rarely. Clear `data/odds-cache.json` only when verifying plan/access changes.

---

## League Mapping

`SLUG_TO_ODDS_MAP` is the bridge between SoccerSTATS and The Odds API.

Example:

```js
england: 'soccer_epl',
spain: 'soccer_spain_la_liga',
netherlands: 'soccer_netherlands_eredivisie',
usa: 'soccer_usa_mls',
```

Important lessons from April 2026:

- `usa` = MLS on SoccerSTATS.
- `usa6` = National Women's Soccer League and must **not** be mapped to MLS.
- Not every SoccerSTATS league has Odds API coverage.
- Not every Odds API soccer competition has a clean SoccerSTATS equivalent.
- Only mapped active soccer competitions should become bettable.

---

## Settlement

Current settlement flow:

```text
1. Read pending predictions
2. Convert leagueSlug → Odds API sport key using getOddsKey()
3. Fetch /scores for each relevant sport key
4. Match completed API scores to predictions using team-name normalisation
5. Fetch current odds for closing/CLV if available
6. Call settlePrediction()
7. Update predictions.jsonl status to settled_won / settled_lost
8. Append result to results.jsonl
```

Recent fix:

- Removed broken `mapLeagueSlugToSportKey` references.
- Settler now uses `getOddsKey()`.
- Cron settlement successfully settled 50 predictions in one run after the fix.

Known limitation:

- The Odds API `/scores` has previously returned at least one incorrect result. This is still the main reliability risk for historical performance.

---

## Data Storage

```text
data/
├── shortlist.json              # Current shortlist, overwritten each refresh
├── discovered-matches.json     # Current scored/bettable pool, overwritten
├── meta.json                   # Refresh metadata
├── odds-cache.json             # Sports/odds cache
├── match-details/              # Per-match detail files
└── history/
    ├── predictions.jsonl       # Prediction log
    ├── predictions.backup-before-dedupe.jsonl
    ├── results.jsonl           # Settled results
    └── closing-odds.jsonl      # Odds snapshots if/when written
```

Prediction dedupe rule going forward:

```text
fixtureId + method + direction
```

Existing duplicate cleanup completed:

```text
original rows: 174
deduped rows: 120
removed: 54
```

---

## API Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/api/status` | Refresh state + metadata |
| GET | `/api/shortlist` | Current + calibrated shortlist payload |
| GET | `/api/matches` | Discovered/scored matches |
| GET | `/api/leagues` | Discovered leagues |
| GET | `/api/match/:id` | Match detail |
| GET | `/api/stats` | Performance stats |
| GET | `/api/predictions` | Raw prediction history |
| POST | `/api/refresh` | Trigger manual refresh |
| POST | `/api/settle` | Trigger manual settlement |

---

## Deploy

SSH:

```bash
ssh root@192.168.178.5
cd /mnt/user/appdata/goalscout
```

Normal deploy:

```bash
docker compose down
docker compose up --build -d
docker logs -f goalscout
```

Hard reset deploy:

```bash
docker compose down
docker rm -f goalscout 2>/dev/null || true
docker rmi goalscout goalscout-goalscout 2>/dev/null || true
docker builder prune -f
docker compose up --build -d
docker logs -f goalscout
```

Do not use `docker build` separately. Compose builds the image actually used by the service.

---

## Useful Commands

Clear only current shortlist state, keeping performance/history:

```bash
rm -f data/shortlist.json data/meta.json data/discovered-matches.json
docker compose down
docker compose up --build -d
```

Check prediction settlement counts:

```bash
grep -c '"status":"settled_won"' data/history/predictions.jsonl
grep -c '"status":"settled_lost"' data/history/predictions.jsonl
grep -c '"status":"pending"' data/history/predictions.jsonl
```

Run syntax checks:

```bash
node -c src/engine/settler.js
node -c src/engine/history.js
node -c src/odds/the-odds-api.js
node -c src/scrapers/orchestrator.js
```

---

## Roadmap

### Phase 1 — Current

- Keep O2.5 / U2.5 baseline stable.
- Keep today-only live shortlist clean.
- Collect reliable settled data.
- Fix result-source reliability before trusting calibration deeply.

### Phase 2 — Next

- Replace or cross-check The Odds API `/scores` with a more reliable results source.
- Cleanly separate Current performance, Calibrated performance, and overlap analysis.
- Wire calibration chart to method-specific stats.
- Continue mapping Odds API soccer competitions to SoccerSTATS slugs where valid.

### Phase 3 — Later

- xG layer from FBref.
- Probability weight tuning.
- BTTS as separate module.
- Betfair Exchange integration.

---

## What This Is Not

- Not an in-play tool.
- Not a guaranteed tipster.
- Not an automated betting bot yet.
- Not ML-driven yet.

GoalScout is currently a pricing and calibration engine.
