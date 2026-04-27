# GoalScout — Working Conventions for Claude

## Non-negotiable rules

1. **Always provide full updated files** — never snippets or diffs alone. If a file needs changing, output the complete replacement.
2. **Read before writing** — inspect the actual file (project knowledge, uploaded zip, or ask the user to paste it) before proposing changes.
3. **Research before implementing** — check ToS, API docs, and feasibility before writing scrapers or integrations.
4. **Verify after every deploy** — check logs and test endpoints before marking a task done.
5. **Do not touch model/shortlist/probability logic** unless explicitly asked.
6. **Never add UI labels that the user has removed** — specifically, the Context chip label is just `Context` with no sub-label (no "paper", no opacity span). Do not re-add these.

---

## Git workflow — always in this order

**NEVER commit before branching.** Committing first then creating a branch just moves the pointer — the original branch also contains the commit.

**Always: branch first, then commit.**
```bash
# 1. Check where you are
git status
git branch --show-current

# 2. Create branch BEFORE committing
git checkout -b feature/your-branch-name

# 3. Stage and commit
git add -A
git commit -m "feat: description"

# 4. Push
git push -u origin feature/your-branch-name
```

---

## Deploy sequence — always in this order

```bash
cd /mnt/user/appdata/goalscout
docker compose down
docker rmi goalscout goalscout-goalscout 2>/dev/null || true
docker builder prune -f
docker compose up --build -d
docker logs -f goalscout
```

**Always include `docker logs -f goalscout` at the end of every deploy sequence given to the user.**

**Never** run `docker build` separately. Compose builds its own image named `goalscout-goalscout`. A standalone image named `goalscout` is silently ignored by Compose and causes stale deploys.

**Verify:** `docker images | grep goalscout` — should show exactly one image (`goalscout-goalscout`).

---

## Docker mount — critical

Only `data/` is mounted from the host into the container:

```
/mnt/user/appdata/goalscout/data  →  /app/data   (read/write, survives redeploy)
```

`/app/src`, `/app/public`, and everything else is **baked into the image at build time**. Changes to source files on the host only take effect after a full redeploy.

**Consequences:**
- Scripts that need to run inside the container must be placed in `data/` to be reachable at `/app/data/script.js`
- Do NOT attempt `docker cp` to place scripts at `/app/fix.js` — the host has no mount there
- Do NOT attempt to edit `/app/src/...` from inside a running container — changes are lost on next redeploy
- Source fixes go to `/mnt/user/appdata/goalscout/src/...` on the host, then redeploy

**Running a one-off script inside the container:**
```bash
# Write script to the mounted data directory
cat > /mnt/user/appdata/goalscout/data/my-script.js << 'EOF'
... script content ...
EOF

# Run it inside the container (where it appears at /app/data/my-script.js)
docker exec goalscout node /app/data/my-script.js
```

---

## How files and scripts are delivered — the actual workflow

Daniel's Mac mounts the Unraid share at `/Volumes/appdata/goalscout`. Unraid sees the same share at `/mnt/user/appdata/goalscout`. Claude never has direct write access — all delivery uses one of two methods:

**Method A — Download + Finder copy (patch scripts, new files)**
Claude produces a file with `create_file` and presents it for download. Daniel downloads it to his Mac and moves it into the correct location via Finder or terminal:
- Patch scripts → `/Volumes/appdata/goalscout/scripts/patches/my-patch.js`
- Source files → `/Volumes/appdata/goalscout/src/...`
- Public files → `/Volumes/appdata/goalscout/public/index.html`

**Method B — VSCode paste (edits to existing files)**
Claude outputs the full updated file content. Daniel opens the file in VSCode and pastes over it.

**Running patch scripts on Unraid**
Patch scripts live in `scripts/patches/` and run directly on the Unraid host — no Docker needed, they edit host source files:
```bash
node /mnt/user/appdata/goalscout/scripts/patches/patch_something.js
```
Unraid has Node.js. Unraid does **not** have Python. All scripts must be `.js`.

**Running one-off scripts that need the container environment**
Place in `data/` (the only mounted volume) and run via `docker exec`:
```bash
docker exec goalscout node /app/data/my-script.js
```
Do NOT use `docker cp` to paths outside `data/`. Do NOT edit `/app/src/...` from inside a running container — changes are lost on next build.

---

## Syntax checking modules

```bash
docker exec goalscout node -e "require('./src/engine/module')"
```

`MODULE_NOT_FOUND` for `undici` or other built-in deps is safe to ignore. Real syntax errors surface first.

**Important:** A clean `require()` check only confirms no syntax errors at module load time. It does NOT confirm runtime correctness — bugs that only trigger during execution (e.g. a variable referenced inside a `.map()` callback that isn't in scope) will not be caught. Always test with real data after deploying logic changes.

---

## File header convention — required on all source files

Every source file Claude produces must open with a comment block containing:
1. The file's path within the project
2. A separator line (`// ─────...`)
3. Plain-English description of what the file does
4. Any critical notes about what it must NOT be confused with or misused for

Example:
```javascript
// src/engine/context-predictions.js
// ─────────────────────────────────────────────────────────────
// Stage 10 — context_raw live paper-tracking.
//
// Logs context_raw predictions to predictions.jsonl alongside
// (but explicitly separate from) current/calibrated predictions.
//
// Deduplication keyed on fixtureId + predictionDate + modelVersion.
// Do NOT confuse with history.js which handles current/calibrated logging.
// ─────────────────────────────────────────────────────────────
```

Applies to: all `.js` files in `src/`, all patch scripts in `scripts/patches/`, any utility scripts.
Does NOT apply to `public/index.html`.

---

## Writing multi-line scripts for the host

Avoid bash heredocs when the script contains backticks, template literals, single quotes, or special characters. Options:
- Write the file using the `create_file` tool and present it for download, then the user copies it to the host
- Use `sed -i` for single-line substitutions on the host (no heredoc needed)
- Multi-line JS edits in existing files: `sed -i` with careful escaping, or deliver a full replacement file

---

## File naming — critical collision rule

`src/engine/calibration.js` is the **current/calibrated model** calibration file. It exports `applyCalibration()`.

`src/engine/context-calibration.js` is the **context_raw model** calibration file. It exports `getCalibratedProb()`.

**Never** name a context_raw calibration file `calibration.js`. These two files must remain separate. Overwriting `calibration.js` breaks the current and calibrated models silently.

---

## Cron jobs (current)

| Cron | Schedule | Purpose |
|---|---|---|
| Full refresh | `5 */6 * * *` | Scrape SoccerSTATS + score + fetch odds + context_raw rolling |
| Settlement sweep | `*/30 * * * *` | Settle eligible predictions via Odds API + FD |
| Pre-KO odds | `*/30 * * * *` | Capture odds up to 2h before kickoff |
| Close capture | `*/5 * * * *` | Capture closing odds 3–15 min before kickoff |

---

## Settlement rules

- Odds API `/scores` `daysFrom` must be 1–3. **Maximum is 3.** Values above 3 return `INVALID_SCORES_DAYS_FROM`.
- Settlement only attempts predictions where kickoff was **at least 135 minutes ago**.
- Predictions older than 3 days cannot be settled via Odds API and are marked `outside_odds_api_window`.
- Football-Data.org is a validator/fallback — not a replacement. Covers ~10 top leagues only.
- `resultSource` tags every settled record: `verified`, `odds-api`, `football-data`.
- Conflicts (sources disagree) are logged to `settlement-conflicts.jsonl` and marked `status: 'conflict'`. Not settled.

---

## Pre-KO / Close / CLV rules

- `preKickoffOdds` is captured up to 2h before kickoff. It is **not** a closing line.
- `closingOdds` is captured by the 5-minute close-capture cron, 3–15 min before kickoff only.
- **`closingOdds` must never be copied from `preKickoffOdds`** — this was a bug, now fixed.
- `closingOdds` is never written after kickoff. Never overwrites an existing value.
- `clvPct` is only calculated when `closingOdds` is genuinely present (not null).
- Legacy records (before April 25 2026) may have `closingOdds` = `preKickoffOdds`. These are not true CLV.

---

## Three-model architecture rules

### context_raw is isolated — do not mix with current/calibrated
- context_raw predictions use `logContextPrediction()` in `context-predictions.js`, NOT `logPrediction()` in `history.js`
- Dedup key for context_raw: `fixtureId + predictionDate + modelVersion` (allows coexistence with current/calibrated for same fixture)
- Dedup key for current/calibrated: `fixtureId + predictionDate` only
- `shortlist.json` has three top-level keys: `current`, `calibrated`, `context_raw` — never merge these arrays server-side
- All-mode display merging is **frontend only** — `getActiveShortlist()` in `index.html`

### context_raw shortlist in orchestrator
- Built in Step 7.5 as `contextShortlisted` — declared before the Step 7.5 block with `let contextShortlisted = []`
- Written to `shortlist.json` as `context_raw: contextShortlisted`
- Does NOT affect `currentShortlisted`, `calibratedShortlisted`, or `shortlistForDetails`
- England (PL) and Germany (BL1) only — `CONTEXT_SLUGS = new Set(['england', 'germany'])`

### context_raw calibration
- Germany O2.5 A/A+: Platt v1 (A=0.817704, B=0.037095) — ACCEPTED
- Germany O2.5 B: use raw (calibrated overshoots by +9.2pp)
- England O2.5: always raw (global Platt rejected — see Stage 9)
- All other leagues: always raw
- Parameters live in `data/calibration/germany_o25_v1.json` (gitignored — data/ only)

### context_raw record schema — required fields
The following fields **must** be present in every context_raw prediction record written to `predictions.jsonl`. Missing any of these will silently break Performance tab aggregation or the selectionType pipeline:

| Field | Value | Notes |
|---|---|---|
| `method` | `'context_raw'` | Required for all filtering |
| `direction` | `'o25'` or `'u25'` | **Must be stored explicitly** — `context_direction` alone is not sufficient. `history.js`, `aggregateContextRaw()`, and the selectionType comparison key all read `direction`, not `context_direction` |
| `context_direction` | `'o25'` or `'u25'` | Context-model alias — kept for compatibility |
| `context_grade` | `'A+'`, `'A'`, or `'B'` | Used by `byGrade` aggregation — must be `context_grade`, NOT `grade` |
| `selectionType` | `'context_confirms'`, `'context_disagrees'`, `'context_only'`, or `null` | Assigned in orchestrator before `logContextPredictions()` is called. Stored at log time — never recomputed. `null` is valid for backfilled records where shortlist state is unrecoverable |
| `market` | `'over_2.5'` or `'under_2.5'` | Used by `mktStats()` market split |
| `modelProbability` | number | Used by Brier score calculation — must not be null |
| `leagueSlug` | `'england'` or `'germany'` | Used by `byLeague` aggregation |

### selectionType assignment — dedup interaction hazard
`selectionType` is assigned to `contextItems` in orchestrator before `logContextPredictions()` is called. However, `logContextPrediction()` uses a dedup check keyed on `fixtureId + predictionDate + modelVersion`. If a record was already logged in an earlier refresh the same day (before the selectionType patch was deployed), the logger will silently skip re-logging it and `selectionType` will remain absent from that record.

**If selectionType is missing from existing records:** run a backfill script from `data/` — it cannot be recovered from the logger. See the April 2026 backfill incident.

### selectionType key is direction-aware
The comparison key for selectionType is `fixtureId + '__' + direction`, NOT `fixtureId` alone. A fixture where context says O2.5 but current says U2.5 is `context_disagrees`, not `context_confirms`. Always use the full key.

---

## Data files

| File | Notes |
|---|---|
| `data/history/predictions.jsonl` | Append-only. Current/calibrated deduped by `fixtureId+predictionDate`. Context_raw deduped by `fixtureId+predictionDate+modelVersion`. |
| `data/history/results.jsonl` | One entry per fixture. Deduped by `fixtureId`. |
| `data/history/settlement-conflicts.jsonl` | Append-only. Written on source disagreements. |
| `data/calibration/league-calibration.json` | Current/calibrated Platt params. May be sparse — needs 200+ settled preds. |
| `data/calibration/germany_o25_v1.json` | Context_raw Platt params. Gitignored. |
| `data/rolling-results/{league}.json` | 8-week FD.org rolling results cache. |
| `data/backtests/context_raw/` | Historical backtest files. Served by `/api/context/backtest`. |
| `data/odds-cache.json` | Disk-persistent. Survives restarts. TTL: sports 6h, odds 3h. |

---

## API surface

```
GET  /api/status          → lastRefresh, lastSettlementChange, meta
GET  /api/shortlist       → { current, calibrated, context_raw, comparison }
GET  /api/stats           → performance (per method, per market)
GET  /api/predictions     → raw JSONL tail
GET  /api/conflicts       → settlement conflicts
GET  /api/context/index   → backtest index (_index.json)
GET  /api/context/backtest?league=&season= → backtest JSONL as JSON array
POST /api/refresh         → trigger full refresh
POST /api/settle          → trigger settlement sweep
POST /api/pre-kickoff     → trigger pre-KO odds capture
```

`lastSettlementChange` in `/api/status` updates only when at least one prediction is written. Null if no settlements have occurred since container start.

---

## Frontend — index.html rules

- `public/index.html` is baked into the Docker image — **browser refresh alone does not pick up changes**. Full redeploy always required.
- Model filter chips: **All | Current | Calibrated | Context** — the Context chip has no sub-label. Do not add "paper", opacity spans, or any annotation to the chip text.
- `getActiveShortlist()` handles all four states: `current`, `calibrated`, `context_raw`, and `all` (smart merge)
- All-mode merge key: `fixtureId + direction + method` — same fixture can appear under multiple models in All mode if directions differ
- `_models[]` array attached to merged rows for badge rendering — `Cur` (cyan), `Cal` (green), `Ctx` (indigo)
- `shortlistData` state shape: `{ current: [], calibrated: [], context_raw: [], comparison: {} }`

---

## Frontend polling

- Polls `/api/status` every 30 seconds.
- If `lastRefresh` changes → reload shortlist + performance.
- If `lastSettlementChange` changes → reload performance only.
- No full page reload. No websockets.

---

## Key learnings (do not repeat these mistakes)

- `daysFrom=7` on Odds API `/scores` returns an error — max is 3.
- Unicode box-drawing characters in bash heredocs cause parse errors on some shells. Use plain ASCII in scripts or write files via tool.
- `docker build` creates a `goalscout` image that Compose ignores. Always use `docker compose up --build`.
- `public/index.html` is baked into the image — browser refresh alone does not pick up frontend changes. Full redeploy required.
- The pre-KO cron and settlement cron both run at `*/30`. They can fire simultaneously but target different prediction states so race conditions are extremely unlikely.
- `teamsMatch()` uses token overlap with a 40% threshold. Home/away swap fallback exists — can cause silent wrong-result if teams are in wrong order. Watch for this.
- `ABANDON_AFTER_HOURS` is set to 72 as a safety net for the kickoff estimation logic.
- **`calibration.js` vs `context-calibration.js`**: naming these the same breaks the current/calibrated model silently. The name collision was introduced in Stage 9 and required a hotfix. Never rename `calibration.js`.
- `context_raw` "No odds" for a fixture is not always a bug — it can mean the Odds API had odds for the opposite direction to what context_raw predicted (market disagrees with the model's direction call).
- `estimateKickoffUTC` pitfall: early-morning AEST times can map to the wrong UTC day. `ABANDON_AFTER_HOURS` set to 72 as safety net.
- **`context-predictions.js` must store `direction` explicitly** — `context_direction` alone is not enough. `history.js` and the selectionType key both read `direction`. This was missing from the original implementation and required a backfill in April 2026.
- **`require()` syntax check does not catch runtime bugs** — a variable out of scope inside a `.map()` callback passes the syntax check but throws at runtime. Always verify logic changes with real data, not just `node -e "require(...)"`.
- **Docker mount is `data/` only** — `/app/src` is baked into the image. Scripts for one-off fixes must be placed in `data/` to be reachable inside the container at `/app/data/`. Do not attempt `docker cp` to paths outside the mount.
- **Unraid has no `python3`** — all scripts must be Node.js. The Docker image is also Node.js Alpine with no Python.
- **Always append `docker logs -f goalscout` to every deploy command sequence** so the user can see startup output immediately.