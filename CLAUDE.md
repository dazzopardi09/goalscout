# GoalScout — Working Conventions for Claude

## Non-negotiable rules

1. **Always provide full updated files** — never snippets or diffs alone. If a file needs changing, output the complete replacement.
2. **Read before writing** — inspect the actual file (project knowledge, uploaded zip, or ask the user to paste it) before proposing changes.
3. **Research before implementing** — check ToS, API docs, and feasibility before writing scrapers or integrations.
4. **Verify after every deploy** — check logs and test endpoints before marking a task done.
5. **Do not touch model/shortlist/probability logic** unless explicitly asked.

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

---

## Cron jobs (current)

| Cron | Schedule | Purpose |
|---|---|---|
| Full refresh | `5 */6 * * *` | Scrape SoccerSTATS + score + fetch odds |
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

## Data files

| File | Notes |
|---|---|
| `data/history/predictions.jsonl` | Append-only. Deduped by `fixtureId+method+direction`. |
| `data/history/results.jsonl` | One entry per fixture. Deduped by `fixtureId`. |
| `data/history/settlement-conflicts.jsonl` | Append-only. Written on source disagreements. |
| `data/calibration/league-calibration.json` | May be empty — needs 200+ settled predictions. |
| `data/odds-cache.json` | Disk-persistent. Survives restarts. |

---

## API surface

```
GET  /api/status          → lastRefresh, lastSettlementChange, meta
GET  /api/shortlist       → current + calibrated shortlist
GET  /api/stats           → performance (per method, per market)
GET  /api/predictions     → raw JSONL tail
GET  /api/conflicts       → settlement conflicts
POST /api/refresh         → trigger full refresh
POST /api/settle          → trigger settlement sweep
POST /api/pre-kickoff     → trigger pre-KO odds capture
```

`lastSettlementChange` in `/api/status` updates only when at least one prediction is written. Null if no settlements have occurred since container start.

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
- The pre-KO cron and settlement cron both run at `*/30`. They can fire simultaneously but target different prediction states (pre-KO targets pending near kickoff, settlement targets 135+ min post-kickoff) so race conditions are extremely unlikely.
- `teamsMatch()` uses token overlap with a 40% threshold. Home/away swap fallback exists — can cause silent wrong-result if teams are in wrong order. Watch for this.
- `ABANDON_AFTER_HOURS` is set to 72 as a safety net for the kickoff estimation logic.