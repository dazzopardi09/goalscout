# GoalScout — Working Conventions for Claude

## Non-negotiable rules

1. **Always provide full updated files** — never snippets or diffs alone. If a file needs changing, output the complete replacement.
2. **Read before writing** — inspect the actual file (project knowledge, uploaded zip, or ask the user to paste it) before proposing changes.
3. **Research before implementing** — check ToS, API docs, and feasibility before writing scrapers or integrations.
4. **Verify after every deploy** — check logs and test endpoints before marking a task done.
5. **Do not touch model/shortlist/probability logic** unless explicitly asked.
6. **Never add UI labels that the user has removed** — specifically, the Context chip label is just `Context` with no sub-label (no "paper", no opacity span). Do not re-add these.

---

## Deploy sequence — always in this order

```bash
cd /mnt/user/appdata/goalscout
docker compose down
docker rmi goalscout goalscout-goalscout 2>/dev/null || true
docker builder prune -f
docker compose up --build -d
```

**Never** run `docker build` separately. Compose builds its own image named `goalscout-goalscout`. A standalone image named `goalscout` is silently ignored by Compose and causes stale deploys.

**Verify:** `docker images | grep goalscout` — should show exactly one image (`goalscout-goalscout`).

---

## Running scripts

The Docker image is **Node.js Alpine — no Python**. All scripts must use `node`, not `python3`.

**Preferred: run inside the already-running container** (env vars are already present):
```bash
docker cp /tmp/my-script.js goalscout:/app/my-script.js
docker exec -it goalscout node /app/my-script.js
```

**Alternative: temp container** (for scripts that need the source tree but no env):
```bash
docker run --rm -v "$(pwd)":/app -w /app goalscout-goalscout node scripts/my-script.js
```

**Do not** use `docker exec` with env vars from `docker-compose.yml` — they won't be present in a temp container unless explicitly passed.

---

## Syntax checking modules

```bash
docker exec -it goalscout node -e "require('./src/engine/module')"
```

`MODULE_NOT_FOUND` for `undici` or other built-in deps is safe to ignore. Real syntax errors surface first.

---

## Writing multi-line scripts for the host

Avoid bash heredocs when the script contains backticks, template literals, single quotes, or special characters. Instead:
- Create the file with `create_file` tool and present it to the user for download
- Or write it via `python3 -c "open(...).write(...)"` on the host
- Multi-line JS edits in existing files: use Python3 `content.replace(old, new)` — more reliable than `sed` or shell heredocs

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