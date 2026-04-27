# Incident — context_raw Performance Tab Deploy

**Date:** 27 April 2026
**Duration:** ~2 hours of churn before resolution
**Severity:** Refresh pipeline broken — `runFullRefresh` threw `ReferenceError: item is not defined`, no shortlist update, no new predictions logged after the first one
**Resolved by:** Direct host-file edit of `orchestrator.js` followed by full redeploy

---

## Summary

A planned three-file patch (orchestrator.js, context-predictions.js, history.js + index.html) added selectionType tracking to the context_raw model so the Performance tab could group settled predictions by agreement with current/calibrated. The patches landed as authored, but two latent bugs were not caught before deploy:

1. **A scope bug in orchestrator.js** — `item.selectionType` was referenced inside a `.map()` callback that destructured its argument, so `item` was not in scope. Threw `ReferenceError` at runtime.
2. **A missing field in context-predictions.js** — the record schema stored `context_direction` but not `direction`, even though `history.js` aggregation and the selectionType comparison key both read `direction`.

The first bug caused the refresh pipeline to crash on every cron tick. The second silently broke the new Performance tab section (every aggregation returned zeros).

Compounding both issues was a **misunderstanding about the Docker mount layout** that caused multiple "fix" attempts to land inside the running container's ephemeral image rather than on the host source, which made the bug appear to come back on every redeploy.

---

## Timeline

**T+0** — Patches reported as applied. Validation requested.

**T+10** — Static review identified the `item.selectionType` scope bug in `orchestrator.js`. A `hotfix_orchestrator.py` file existed in Project Files showing the correct fix (build `ctxSelectionTypeMap` before `.map()`, read from it inside). Validation report flagged: *"the hotfix wasn't confirmed applied — `require()` syntax check passing does NOT confirm a runtime ReferenceError is fixed."*

**T+20** — Live data (3 records pulled from `predictions.jsonl`) showed `selectionType` and `direction` both missing from all records. Two issues identified:
- `direction` field never written by `context-predictions.js` (separate from the patch chain)
- `selectionType` blocked by dedup — older records were already in the file and the dedup key (`fixtureId+predictionDate+modelVersion`) prevented re-logging

**T+30** — Two-part fix produced: source change in `context-predictions.js` to add `direction` field, plus backfill script for the 3 existing records. Backfill ran successfully. Verification confirmed all 3 records had `direction` and `selectionType` keys.

**T+45** — Redeploy ran. Container started cleanly. First refresh logged a single context_raw prediction successfully, then **`ReferenceError: item is not defined at orchestrator.js:537:30`** crashed the refresh.

**T+60** — Multiple failed fix attempts:
- First attempt wrote a Node fix script targeting `/app/src/scrapers/orchestrator.js` and ran it via `docker exec goalscout node /app/data/fix.js`. Script reported success but the bug persisted after redeploy.
- Diagnosis: `/app/src` is **baked into the image**, not mounted from the host. The fix wrote to a copy-on-write layer in the running container, which was discarded on redeploy.
- Second attempt used `sed -i` directly on the host file but the replacement included shell metacharacters that mangled the inserted code. Verification showed line 537 was rewritten but the `Map` declaration was missing.
- Third attempt used inline `node -e "..."` on the host. Bash history expansion (`!`) mangled the script. Reported "Done" but the file was unchanged because the corrupted check passed and the corrupted replacement was identical to the original.

**T+90** — Used a heredoc with quoted `'EOF'` (disables bash expansion entirely) to write the fix script to `/tmp/fix_host.js`, then ran `node /tmp/fix_host.js` directly on the host. Verified 3 grep hits at lines 500, 503, 544.

**T+95** — Full redeploy. Logs showed `[orchestrator] context_raw shortlist: 1 matches` cleanly with no ReferenceError.

---

## Root causes

### 1. Patch wrote a broken `.map()` reference

`patch_orchestrator.py` Change 2 introduced this line into the `contextShortlisted` mapping:

```javascript
contextShortlisted = contextItems
  .filter(i => !i.scored.skip)
  .map(({ match, scored: ctxScored, homeRolling, awayRolling }) => {
    return {
      ...
      selectionType: item.selectionType || null,   // ← item is not defined
    };
  });
```

The destructuring pattern `({ match, scored, ... })` does not bind `item` — there is no parameter by that name. The variable existed in the assignment loop above (`for (const item of contextItems) { item.selectionType = ... }`) but went out of scope at the loop boundary.

A `hotfix_orchestrator.py` was authored to correct this by building `ctxSelectionTypeMap` before the `.map()`, but the hotfix was not confirmed applied to the host source before the deploy that triggered the failure.

### 2. `node -e "require('./module')"` does not catch runtime bugs

The validation step `docker exec goalscout node -e "require('./src/scrapers/orchestrator')"` returned cleanly, which was reported as "no syntax errors, no missing modules". This is true but insufficient — `require()` only executes the module's top-level code. The `.map()` callback containing `item.selectionType` does not run until `runFullRefresh()` is called by the cron, which is after the syntax check passes.

A clean `require()` confirms the file parses and loads. It does not confirm that any function inside it can run.

### 3. Source schema missing `direction` field

`context-predictions.js` stored:

```javascript
context_direction: direction,   // present
// no plain `direction` field
```

But every consumer downstream of `predictions.jsonl` reads `p.direction`, not `p.context_direction`:
- `history.js` `aggregateContextRaw()` filters by `p.direction` for market splits
- The new selectionType comparison key uses `id + '__' + p.direction`
- `index.html` settled-table render uses `p.direction || (p.market === 'under_2.5' ? 'u25' : 'o25')` — falls back, but only because the absence was masked by `market`

This was a pre-existing schema gap that the new aggregation logic happened to expose.

### 4. Docker mount layout misunderstanding

The container's volume layout:

```
/mnt/user/appdata/goalscout/data → /app/data    (mounted, persistent)
/app/src                          (baked into image, NOT mounted)
/app/public                       (baked into image, NOT mounted)
```

Several "fix" attempts tried to edit `/app/src/scrapers/orchestrator.js` from inside the running container via `docker exec`. The writes succeeded against the container's writable layer but were discarded on the next `docker compose up --build`, which rebuilt the image from the host source. The host source was untouched, so the bug came back.

This was documented in `CLAUDE.md` after the fact, but was the cause of three consecutive "fixed but bug returned" cycles.

### 5. Bash history expansion mangled inline scripts

Two attempts used `node -e "..."` with embedded `!` characters (logical NOT operators in JavaScript). Bash interpreted `!c.includes(...)` and `!i.scored.skip` as history expansions, printed `event not found` warnings, but **continued execution with the malformed script**. The result:

- The `if (!c.includes(OLD))` check became `if (c.includes(OLD))` — passed when it should have failed
- The replacement string also had `!` characters mangled, but in a way that produced text identical to OLD
- `console.log('Done')` ran. The file was not changed.

The user saw `Done` and no errors, then `grep` showed no change, looking like a tooling failure when it was a silent data-corruption.

---

## How it was fixed

**Final working sequence:**

1. **Disable history expansion** for safety: `set +H`
2. **Write fix script to a file** using a heredoc with quoted terminator (`<< 'EOF'`) which disables all bash expansion:
   ```bash
   cat > /tmp/fix_host.js << 'EOF'
   ... node script targeting /mnt/user/appdata/goalscout/src/scrapers/orchestrator.js ...
   EOF
   ```
3. **Run on the host directly**: `node /tmp/fix_host.js` — Unraid has Node.js available without Docker
4. **Verify against the host file**, not the container: `grep -n "ctxSelectionTypeMap" /mnt/user/appdata/goalscout/src/scrapers/orchestrator.js`
5. **Standard redeploy** which now picks up the corrected source

The fix itself: build a `Map` keyed on `fixtureId+direction` from `contextItems` before the `.map()`, then read from the Map inside the callback.

---

## Lessons learned (now in CLAUDE.md)

1. **Only `data/` is mounted.** Source fixes must go to `/mnt/user/appdata/goalscout/src/...` on the host. Editing `/app/src` from inside a running container has no persistent effect.

2. **`require()` is a syntax check, not a runtime check.** Logic that lives inside callbacks, conditional branches, or async paths is not exercised. Verify with real data after deploy, not just module load.

3. **Avoid `node -e "..."` and `sed -i` for any script containing `!`, backticks, or template literals.** Use a heredoc with quoted `'EOF'` or a `create_file` artefact.

4. **Heredoc with quoted `'EOF'` disables expansion. Heredoc with bare `EOF` does not.** Default to quoted unless you genuinely need variable substitution.

5. **`set +H` disables bash history expansion** for the current shell. Useful as a safety net.

6. **Verify on the host after every "fix"** — `grep` the host file path, not the container path. If the change isn't visible there, it won't survive a redeploy.

7. **Docker scripts go in `data/`**, not in the repo root or `src/`. Place at `/mnt/user/appdata/goalscout/data/script.js`, run via `docker exec goalscout node /app/data/script.js`.

8. **Always include `docker logs -f goalscout`** at the end of every deploy command sequence so the user sees startup output immediately and crashes are caught in the same pipeline.

9. **`context_raw` records must store both `direction` and `context_direction`.** Downstream consumers read `direction`. This is documented in CLAUDE.md.

10. **Patches that mutate shared scope (loop assignment) and then expect a destructured callback to read from it will fail.** When passing per-item data into a `.map()` whose callback destructures, build a `Map` lookup keyed on something that is in scope inside the callback (e.g. `match.id + direction`).

---

## What this incident did not break

- No data corruption beyond the 3 records that were already in `predictions.jsonl` without `direction`/`selectionType`. Those 3 were backfilled with `direction` from `context_direction` and `selectionType: null` (honest — we cannot reconstruct the original shortlist state).
- No settled predictions were lost or mis-settled. The settler runs against `predictions.jsonl` and was unaffected.
- No frontend regressions. The Performance tab's new context section just rendered zeros until the `selectionType` field started flowing on new records.
- Current and calibrated models continued to log predictions normally throughout. The crash was inside the context_raw shortlist-building block only, which was wrapped in a context-only code path.

---

## Files touched (final state)

- `src/scrapers/orchestrator.js` — `ctxSelectionTypeMap` lookup added before the `contextShortlisted .map()`; `selectionType` value sourced from the Map
- `src/engine/context-predictions.js` — `direction` field added to the prediction record alongside `context_direction`
- `data/history/predictions.jsonl` — 3 existing context_raw records backfilled with `direction` (from `context_direction`) and `selectionType: null`
- `CLAUDE.md` — new sections on Docker mount layout, scripts in `data/`, runtime verification, deploy log streaming, context_raw schema requirements
- `data/fix_direction.js`, `data/fix_orchestrator_item.js`, `data/fix2.js` — one-off fix scripts (can be deleted; backups already taken)

---

## Backup files left on disk

- `src/engine/context-predictions.js.bak-dir`
- `src/scrapers/orchestrator.js.bak-host`
- `src/scrapers/orchestrator.js.bak2` (created by the failed in-container fix; safe to delete)
- `src/scrapers/orchestrator.js.bak-hotfix-item` (same — safe to delete)
- `data/history/predictions.jsonl.bak-dir`

Once the fix is confirmed stable for a refresh cycle or two, the `.bak*` files can be removed.
