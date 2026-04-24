# GoalScout — Project Status & Continuation Guide

## Current State — 24 Apr 2026

GoalScout is a local Unraid Docker app for identifying pre-match O2.5 and U2.5 football betting opportunities.

Current production state:

- Running on Unraid at port `3030`.
- SoccerSTATS paid account active.
- FlareSolverr available at `192.168.178.5:8191`.
- Paid The Odds API key active.
- Sports cache now filtered to active soccer competitions only.
- Active Odds API soccer universe currently around **53 competitions**.
- Live refresh now runs **today-only**, not today + tomorrow.
- League-page scraping now uses the intersection of:
  - SoccerSTATS leagues present in the current scrape,
  - valid `SLUG_TO_ODDS_MAP` entries,
  - active Odds API soccer competitions.
- O2.5 and U2.5 markets live.
- Current and Calibrated model streams live.
- Settlement is working again after replacing stale `mapLeagueSlugToSportKey` usage with `getOddsKey()`.
- Duplicate prediction logging fixed going forward.
- One-off prediction dedupe completed: `174 → 120`, removing `54` duplicate rows.
- Shortlist default sort changed to kickoff ascending.

## Important Recent Fixes

### 1. Odds API sports-list cleanup

Problem:

- `/v4/sports` was returning all active sports: AFL, NBA, MLB, politics, tennis, etc.
- GoalScout was counting them as “bettable competitions”.

Fix:

```js
const active = data.filter(s => s.active && s.key.startsWith('soccer_'));
```

Result:

- Odds API active list now reflects soccer only.
- Logged count became `53 active soccer competitions`.

### 2. Expanded and corrected `SLUG_TO_ODDS_MAP`

Problem:

- GoalScout was shrinking the Odds API soccer universe too aggressively because only mapped SoccerSTATS slugs could become bettable.
- Some mappings were wrong or missing.

Fixes included:

- `england2 → soccer_efl_champ`
- `england3 → soccer_england_league1`
- `england4 → soccer_england_league2`
- `germany3 → soccer_germany_liga3`
- `cup-germany1 → soccer_germany_dfb_pokal`
- `sweden2 → soccer_sweden_superettan`
- `brazil → soccer_brazil_campeonato`
- `brazil2 → soccer_brazil_serie_b`
- `chile → soccer_chile_campeonato`
- `china → soccer_china_superleague`
- `saudiarabia → soccer_saudi_arabia_pro_league`
- `ireland → soccer_league_of_ireland`
- `usa → soccer_usa_mls`

Important correction:

- `usa6` is **not MLS**. It is National Women's Soccer League on SoccerSTATS and must not be mapped to `soccer_usa_mls`.

### 3. Live shortlist changed to today-only

Problem:

- Today + tomorrow scraping made the shortlist noisy.
- League-page fetches looked wrong because they included tomorrow’s larger set of leagues.

Fix:

```js
const allScraped = [...todayMatches];
```

Result:

- Cleaner live shortlist.
- Fewer league-page fetches.
- Easier debugging.
- More actionable live board.

### 4. League-page fetch scope fixed

Correct logic:

```js
const scrapedSlugs = [...new Set(allMatches.map(m => m.leagueSlug))];
const slugsToScrape = bettableSlugs.length > 0
  ? scrapedSlugs.filter(slug => bettableSlugs.includes(slug))
  : scrapedSlugs;
```

This means GoalScout only fetches SoccerSTATS league pages for leagues that:

1. actually have matches in the current run, and
2. are mapped to an active Odds API soccer competition.

### 5. Settler repaired

Problem:

- `settler.js` still referenced removed/old `mapLeagueSlugToSportKey`.
- Manual settlement errored with `mapLeagueSlugToSportKey is not defined`.
- Scores were not being fetched/matched correctly for newer mapped leagues.

Fix:

- Import `getOddsKey` from `the-odds-api.js`.
- Use `getOddsKey(p.leagueSlug)` everywhere in settler.
- Ensure `sportKey` is defined before score and odds requests.
- Keep team-name normalisation for cases such as PSV/PEC Zwolle and Argentina abbreviations.

Proof after fix:

```text
[settler] fetched 215 score records from API
[settler] settled PSV Eindhoven vs PEC Zwolle [current] (over_2.5): 6-1
[settler] settled PSV Eindhoven vs PEC Zwolle [calibrated] (over_2.5): 6-1
[settler] done. settled=50 skipped=88 errors=0
```

### 6. Duplicate predictions fixed

Problem:

- `logPrediction()` deduped by `fixtureId + method + predictionDate`.
- Same fixture could be logged again across days.
- Performance showed duplicate settled rows.

Future fix:

```js
// one record per fixture + method + market/direction
if (existing.some(p =>
  p.fixtureId === match.id &&
  (p.method || 'current') === method &&
  (p.direction || null) === (match.direction || null)
)) {
  return;
}
```

One-off cleanup:

```text
original rows: 174
deduped rows: 120
removed: 54
```

A backup was made before dedupe:

```text
data/history/predictions.backup-before-dedupe.jsonl
```

### 7. Shortlist default sort changed

Shortlist should now default to kickoff time ascending, closest first, rather than score descending.

Recommended logic:

```js
.sort((a, b) => {
  const at = a.commenceTime ? new Date(a.commenceTime).getTime() : Number.MAX_SAFE_INTEGER;
  const bt = b.commenceTime ? new Date(b.commenceTime).getTime() : Number.MAX_SAFE_INTEGER;
  return at - bt;
});
```

---

## Current Architecture

```text
SoccerSTATS today matches
  ↓
League slugs found in current scrape
  ↓
Intersect with mapped active Odds API soccer competitions
  ↓
Fetch SoccerSTATS league stats only for eligible leagues
  ↓
Score eligible matches
  ↓
Build Current + Calibrated shortlists
  ↓
Fetch O/U 2.5 odds for shortlisted competitions
  ↓
Log predictions
  ↓
Settle completed predictions via Odds API /scores
  ↓
Performance tab
```

---

## Current Known Issues

### Priority 1 — Results-source reliability

The Odds API `/scores` endpoint is now working again, but it previously produced at least one wrong score. This remains the biggest risk to calibration quality.

Next action:

- Investigate Football-Data.org, API-Football, Sportmonks, or another reliable results source.
- Consider cross-checking results before writing final settled outcomes.

### Priority 2 — Performance view cleanup

Still worth checking:

- Current tab should only show current method.
- Calibrated tab should only show calibrated method.
- Overlap analysis should be explicitly separated from Current/Calibrated rows.
- Legacy BTTS rows should be filtered out or archived separately.

### Priority 3 — Shared team-name matcher

Currently team normalisation exists in more than one place.

Needed later:

- shared matcher module,
- shared alias map,
- no duplicated regex fixes across odds fetch and settlement.

### Priority 4 — Results/history cleanup

Already completed:

- `predictions.jsonl` deduped.

Still optional:

- dedupe `results.jsonl` if duplicate results become visible or distort reports.

---

## Tech Stack

- Node.js 20 + Express
- Cheerio
- FlareSolverr
- The Odds API paid plan
- Docker on Unraid
- Local JSON/JSONL storage

---

## Key Runtime Files

```text
data/
├── shortlist.json
├── discovered-matches.json
├── meta.json
├── odds-cache.json
├── match-details/
└── history/
    ├── predictions.jsonl
    ├── predictions.backup-before-dedupe.jsonl
    ├── results.jsonl
    └── closing-odds.jsonl
```

---

## Key Source Files

```text
src/odds/the-odds-api.js
  - Odds API integration
  - active soccer filtering
  - SLUG_TO_ODDS_MAP
  - team matching for odds

src/scrapers/orchestrator.js
  - main refresh workflow
  - today-only scrape
  - league intersection logic
  - current/calibrated shortlist creation

src/engine/shortlist.js
  - directional scoring
  - shortlist filtering
  - kickoff sort

src/engine/history.js
  - prediction logging
  - dedupe logic
  - performance stats

src/engine/settler.js
  - score fetching
  - pending prediction settlement
  - pre-KO odds update

public/index.html
  - dashboard UI
  - shortlist and performance display
```

---

## Deploy Commands

Normal deploy:

```bash
cd /mnt/user/appdata/goalscout
docker compose down
docker compose up --build -d
docker logs -f goalscout
```

Hard reset deploy:

```bash
cd /mnt/user/appdata/goalscout
docker compose down
docker rm -f goalscout 2>/dev/null || true
docker rmi goalscout goalscout-goalscout 2>/dev/null || true
docker builder prune -f
docker compose up --build -d
docker logs -f goalscout
```

Clear only current shortlist state:

```bash
rm -f data/shortlist.json data/meta.json data/discovered-matches.json
docker compose down
docker compose up --build -d
```

Do **not** delete `data/history/` unless intentionally resetting performance.

---

## Useful Checks

Settlement counts:

```bash
grep -c '"status":"settled_won"' data/history/predictions.jsonl
grep -c '"status":"settled_lost"' data/history/predictions.jsonl
grep -c '"status":"pending"' data/history/predictions.jsonl
```

Find specific prediction/result:

```bash
grep -i "psv" data/history/predictions.jsonl
grep -i "psv" data/history/results.jsonl
```

Syntax checks:

```bash
node -c src/engine/settler.js
node -c src/engine/history.js
node -c src/odds/the-odds-api.js
node -c src/scrapers/orchestrator.js
```

---

## Strategic Direction

Keep GoalScout focused on:

1. clean pre-match probability estimates,
2. price/edge comparison,
3. reliable settlement,
4. calibration,
5. then xG/extra markets.

Do not add more markets until the O2.5/U2.5 baseline is trustworthy.

---

## Next Session Prompt

Use this to continue:

```text
I’m continuing the GoalScout project. Latest state:
- Today-only live shortlist is active.
- Odds API sports list is filtered to active soccer competitions only.
- SLUG_TO_ODDS_MAP has been expanded and corrected.
- Settler now uses getOddsKey() and successfully settled 50 predictions in cron.
- Prediction duplicates were fixed in history.js and existing predictions.jsonl was deduped from 174 to 120 rows.
- Shortlist should default sort by kickoff ascending.
- Main next task: verify performance method filtering and plan reliable results-source replacement.
Repo is at /mnt/user/appdata/goalscout on Unraid.
Start from PROJECT-STATUS.md.
```
