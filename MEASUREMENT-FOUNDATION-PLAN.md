# Measurement Foundation Plan — v1

**Date:** 30 April 2026
**Status:** Proposed — pending pre-flight verification before implementation
**Sprint type:** Measurement only. No new modelling. No new markets.
**Bounded scope:** 1–2 weekends.
**Branch:** `feature/measurement-foundation-v1`

---

## 0. Glossary and language conventions

Used consistently throughout this document and the implementation:

- **Pick-time odds** — the odds at which GoalScout logged a prediction. Recorded at the moment the pick was made.
- **Near-close odds snapshot** — odds captured at a defined time before scheduled kickoff (proposed 10–20 minutes; subject to pre-flight verification). This is a **closing proxy**, not a guaranteed true closing price. Bookmakers continue to update odds up to and during the event, and our snapshot is whatever the API returns at our query time.
- **Closing proxy** — synonym for near-close odds snapshot, used interchangeably.
- **CLV (Closing Line Value)** — percentage difference between pick-time odds and the near-close snapshot. **Calling it "CLV" is a convention; the value is technically CLV-vs-our-closing-proxy, not CLV-vs-true-close.** Acceptable for evaluation purposes provided the proxy is captured consistently.

This document never refers to the snapshot as "the closing odds" or "the true close." If those terms appear in code or UI, treat them as bugs.

---

## 1. Objective

Build a minimum-viable measurement foundation so that future GoalScout models can be judged against market movement, not just hit rate or ROI on small samples.

The sprint succeeds when:
- A near-close odds snapshot is captured reliably for >80% of eligible upcoming picks
- CLV is computed correctly on every settled pick where both pick-time odds and a near-close snapshot exist
- CLV is visible in the Performance tab alongside existing metrics, without breaking any existing functionality

The sprint is *not* trying to:
- Find an edge
- Beat any market
- Validate any model
- Prove or disprove any thesis about soccer or AFL

It is trying to make those things *measurable*. The measurement is the deliverable.

---

## 2. Scope (in)

- Capture near-close odds snapshots for picks already logged in the existing GoalScout pipeline
- Compute CLV for picks where both pick-time odds and a near-close snapshot exist
- Expose CLV in the Performance tab as:
  - A per-pick column on the settled/paper picks table
  - Aggregate summary cards: mean CLV, median CLV, positive CLV rate, sample size
  - A simple distribution/histogram if low-effort (acceptable to defer)
- Backfill CLV for past settled picks **only if** pre-flight confirms pick-time odds are reliably stored on existing prediction records. Otherwise, forward-only.
- Use The Odds API as the sole odds source for v1
- Soccer markets only for v1 (matches existing GoalScout focus). AFL is excluded from this sprint by design — adding AFL would expand fixture matching, bookmaker mapping, and timing logic beyond what 1–2 weekends can absorb.

## 3. Non-scope (out)

Explicit exclusions, listed because each has been considered and deliberately deferred:

- **No new modelling.** No threshold tuning, no new features, no hybrid model, no residual model.
- **No new markets.** No BTTS, O1.5, O3.5, Asian totals, line/spread, halftime markets — only the markets currently being picked.
- **No AFL totals work.** AFL line/spread v1 is closed; AFL totals is a separate future study and is not part of this sprint.
- **No soccer hybrid modelling** of any kind.
- **No Betfair / exchange data.** Daniel has a Betfair developer account, but exchange integration adds substantial complexity (different price semantics: back/lay, commission) and is out of v1.
- **No intraday line-movement tracking.** A single near-close snapshot per pick is the v1 ceiling.
- **No open / mid / close multi-snapshot capture.** Pick-time odds are our "open-ish" reference; near-close is our "close-ish" reference; that is two snapshots, not three.
- **No betting automation.** Nothing in this sprint places bets, simulates bet placement against live odds, or interacts with bookmaker accounts.
- **No production betting** of any kind.
- **No tick-level historical odds rebuilds** via paid APIs.
- **No calibration plots, Brier scores, or ROC curves** in v1. Those come after CLV exists and is trustworthy.
- **No pre-registration framework** for future studies. That is downstream of this work.

---

## 4. Pre-flight checks

This sprint cannot start coding until the following are answered. The pre-flight is the first deliverable; everything else is gated on it.

### 4.1 Predictions log audit

Inspect `data/history/predictions.jsonl` (or wherever predictions are currently logged — confirm exact path) and answer:

- Does each prediction record store, at minimum:
  - Fixture / event ID (which one — internal GoalScout ID, Odds API event ID, Football-Data ID, SoccerSTATS ID, or several)?
  - Scheduled commence time (in what timezone — UTC, AEST, league-local)?
  - Market (e.g. `over_under_2.5`, `btts`)?
  - Selection (e.g. `over`, `under`, `yes`, `no`)?
  - Bookmaker (which one provided the pick-time price)?
  - Pick-time odds (the actual decimal price at log time)?
  - Prediction timestamp (when the pick was logged)?
- For each missing field: is it derivable from another field, or genuinely absent?
- Sample 20 random records and 20 most recent records. Confirm consistency.
- Are there schema changes over time (early records missing fields newer ones have)?

**This audit decides backfill vs forward-only.** If pick-time odds are present and stable across the log, CLV is backfillable. If not, CLV is forward-only and we wait ~30 settled picks to accumulate signal.

### 4.2 Odds API availability near kickoff

For a sample of upcoming fixtures GoalScout has picked:

- Does The Odds API return the same fixture (matchable by team names + date + league) when queried 10–20 minutes before scheduled kickoff?
- Does it return the same market and selection?
- Does it return prices from the same bookmaker we used at pick time, or do we need bookmaker-flexible matching?
- How close to kickoff does the API still return a quote? (Some APIs drop fixtures from the active feed at kickoff or shortly before.)
- Is there a meaningful difference between odds at T-20 minutes vs T-10 minutes vs T-5 minutes? (Informs our chosen snapshot timing.)

### 4.3 Rate-limit / quota budget

- **Do not rely on old assumptions** about free-tier limits, 25/day caps, or previous key rotation. Recent AFL pre-flight work confirmed the current Odds API account has substantial remaining credits, so the picture has changed since earlier notes.
- **Action:** confirm the current Odds API quota, usage, and per-call credit cost before coding. The pre-flight must record:
  - Current remaining credits
  - Quota if exposed by the account dashboard or API response headers
  - Expected calls per matchday (typical fixture volume × markets × bookmakers per call)
  - Estimated weekly credit cost for one near-close snapshot per picked fixture
  - Whether the existing paid plan comfortably supports this volume with headroom for normal pipeline use
- **Decision (independent of plan tier):** v1 uses one near-close snapshot per picked fixture. Multiple-snapshot strategies (e.g. T-20 *and* T-5) remain out of scope, not because of credit constraints but because the v1 sprint is about establishing measurement, not optimising it.

### 4.4 Timezone handling

- `commence_time` from Odds API: confirmed UTC (per memory, primary source).
- Local server timezone (Unraid): document and lock.
- Scheduling logic timezone: must operate in UTC internally to avoid the `estimateKickoffUTC` early-AEST-mapping pitfall noted in memory.
- DST transitions: identify any leagues where DST shifts will land within the next 4–6 weeks of measurement.
- Snapshot scheduler must compute "10–20 min before commence_time" in UTC, then dispatch.

### 4.5 Fixture/event identity matching

Critical: the same fixture must be findable in both:
- The pick record (which references whatever ID GoalScout originally used)
- The Odds API near-close response (which uses Odds API event IDs)

Questions:
- Does the pick record store the Odds API event ID directly, or only an internal/external ID that requires a lookup?
- If lookup is required, is the lookup deterministic? (Team names + date + league → unique event.)
- What happens with team-name spelling drift (e.g. "Manchester United" vs "Man United" vs "Man Utd")?
- Are there cases where the same fixture appears under different IDs across days (rescheduling)?

A failed match means no near-close snapshot for that pick, even though the prediction exists. We need to estimate the failed-match rate before defining the >80% acceptance threshold.

### 4.6 Backfill feasibility

If pick-time odds *are* reliably stored, can we also retroactively retrieve a closing-proxy for already-settled picks? The Odds API free tier's historical odds endpoint (if any) may not be available, or may cost rate-limit budget we cannot spare. Likely outcome: forward-only is the realistic path, even if pick-time odds are fully stored. Confirm and document.

---

## 5. Data model

### 5.1 Storage location

Proposed: `data/history/odds-snapshots.jsonl` — append-only, one JSON object per snapshot, parallel to the existing predictions log.

Rationale: keeps prediction records immutable. CLV is computed at read time by joining predictions with snapshots on fixture/event ID + market + selection. No risk of corrupting historical prediction records.

Alternative considered and rejected: writing snapshot fields back into the prediction record. Rejected because (a) it mutates the historical log, (b) it complicates the dedup logic that already keys on `fixtureId`, (c) it makes it harder to capture multiple snapshots later if we ever want to.

### 5.2 Required fields per snapshot record

```
{
  "snapshot_timestamp": "ISO 8601 UTC, when the snapshot was captured",
  "snapshot_minutes_before_kickoff": "number, computed at capture time",
  "fixture_id": "the same identifier scheme used in predictions.jsonl",
  "odds_api_event_id": "Odds API native event ID, for traceability",
  "commence_time": "ISO 8601 UTC, the scheduled kickoff",
  "sport": "e.g. 'soccer'",
  "league": "e.g. 'soccer_epl'",
  "market": "e.g. 'totals_2.5'",
  "selection": "e.g. 'over'",
  "bookmaker": "actual bookmaker name whose price is recorded in close_proxy_odds",
  "bookmaker_match": "either 'same_bookmaker' or 'best_available' — see section 5.3",
  "close_proxy_odds": "decimal odds, the snapshot price from the recorded bookmaker",
  "all_bookmaker_prices": "optional: array of {bookmaker, price} for diagnostic value",
  "source": "constant: 'odds-api'"
}
```

Notes:
- `bookmaker` is always the literal bookmaker name (e.g. `"pinnacle"`, `"bet365"`); never a sentinel value
- `bookmaker_match` is the classification, separate from the bookmaker name itself, per section 5.3
- `snapshot_minutes_before_kickoff` lets us audit whether snapshots were actually taken at intended timing
- `all_bookmaker_prices` is optional but cheap (the API returns multiple bookmakers per call) and useful for diagnostics
- `source` exists so future v2 extensions (Betfair, scraped data) are distinguishable
- The original prediction record is **not modified**. CLV joins happen in the read layer.

### 5.3 Join key and bookmaker matching

**Preferred match (primary path):**
- Same fixture / event ID
- Same market
- Same selection
- **Same bookmaker** as the pick — when the pick bookmaker is known and a price from that bookmaker is present in the near-close snapshot

**Fallback (only when same-bookmaker is unavailable):**
- Same fixture / market / selection
- Best-available `close_proxy_odds` from any returned bookmaker
- Record **must** be flagged with `bookmaker_match: "best_available"` (vs `"same_bookmaker"` for primary path)

**Aggregation rules:**
- Performance tab summary cards must be capable of showing CLV with same-bookmaker matches only, best-available matches only, and combined. Default view: combined, with a small badge or footnote indicating the breakdown.
- Same-bookmaker and best-available CLV must remain separable in the underlying data and in the API response — never silently merged. A single mean-CLV figure that mixes them without disclosure is a bug.
- If a pick has no bookmaker recorded (i.e. pick-time bookmaker field is missing), the match is automatically classified as `bookmaker_match: "best_available"` — same-bookmaker is impossible without a known pick bookmaker.

**Why this matters:** same-bookmaker CLV measures "did *the price we actually got* drift relative to *that bookmaker's* close." Best-available CLV measures "did our pick price drift relative to *the market's* close at any bookmaker." These are different signals. Mixing them without disclosure can mask adverse selection at a specific bookmaker, or inflate apparent CLV when our pick bookmaker happened to price favourably and others tightened.

### 5.4 Backfill flag

Each snapshot record should carry an `is_backfilled` boolean. Forward-captured snapshots are `false`; any retrospectively retrieved snapshot is `true`. Aggregation can filter on this if backfilled data turns out to be qualitatively different.

---

## 6. CLV calculation

### 6.1 Formula (decimal odds, back bets)

```
clv_pct = (pick_odds / close_proxy_odds - 1) * 100
```

Sign convention: **positive CLV = good** (we picked at higher odds than the closing proxy, meaning the line moved against the value of our selection, meaning we got a better price than the closing market).

### 6.2 Worked examples

- Picked at 2.10, closing proxy 1.95 → `(2.10 / 1.95 - 1) * 100 = +7.69%` → **positive CLV**
- Picked at 1.80, closing proxy 1.90 → `(1.80 / 1.90 - 1) * 100 = -5.26%` → **negative CLV**
- Picked at 2.00, closing proxy 2.00 → `0.00%` → **neutral CLV**

### 6.3 Sign convention verification (mandatory before declaring CLV correct)

Apply the same three-layer check used in the AFL study:

1. **Symmetry / known-case assertion**: hard-code two test cases (one positive, one negative) in the CLV module's tests; assert exact percentage values.
2. **Aggregate sanity**: on a sample of ≥30 settled picks, the mean CLV across all picks should not be wildly biased without explanation. If mean CLV is +20% or -20%, something is wrong (either with the calculation or with our snapshot timing).
3. **Eyeball table**: pick 5 settled records, manually compute CLV, compare to module output. Confirm match.

Document the verification in the pre-flight results doc, not just in code comments.

### 6.4 Edge cases and how to handle them

| Case | Handling |
|---|---|
| Pick-time odds missing | Skip pick from CLV calculation. Count in a `clv_skipped_no_pick_odds` audit counter. |
| Near-close snapshot missing | Skip pick from CLV calculation. Count in a `clv_skipped_no_close_snapshot` counter. |
| Fixture postponed before snapshot taken | Snapshot scheduler skips; pick stays in predictions log. CLV is null for that pick; record reason if possible. |
| Fixture postponed after snapshot taken but before kickoff | CLV computed against the snapshot we have; flag the record with `fixture_postponed: true` so it can be filtered out of aggregates. |
| Match voided | Same as postponed: CLV computed but flagged. Aggregates filter out. |
| Market or selection changed between pick and close | Skip CLV; counter `clv_skipped_market_changed`. Should be rare; investigate if frequent. |
| Snapshot captured outside intended T-20→T-10 window (e.g. late dispatch) | CLV still computed; `snapshot_minutes_before_kickoff` field allows post-hoc filtering by timing. |
| Multiple bookmakers, no exact match | Use best-available price as `close_proxy_odds`; flag with `bookmaker_match: 'best_available'`. |
| Unmatched fixture (predictions has it, Odds API does not return it near kickoff) | No snapshot recorded; counter `snapshots_failed_unmatched_fixture`. Investigate if rate exceeds 20%. |

All counters surface in the Performance tab as a small "data health" panel below CLV stats. Without this, missing CLV looks like silent failure rather than diagnosable behaviour.

---

## 7. Implementation sequence

Strict order. Each step gates the next.

### Step 1 — Pre-flight script/doc

Deliverable: `MEASUREMENT-FOUNDATION-PREFLIGHT.md` documenting answers to all questions in section 4. May be supported by a small read-only audit script that inspects `predictions.jsonl` and reports field coverage; the script's output goes into the doc.

**Decision point at end of Step 1:** backfill possible, or forward-only? Document the decision and proceed accordingly.

### Step 2 — `src/engine/clv.js`

Pure function module:
- `computeClv(pickOdds, closeProxyOdds)` → percentage
- Edge-case handling per section 6.4
- Self-contained tests (no I/O, no external dependencies)
- Sign-convention verification baked in as runnable assertions

Tested in isolation before any I/O code is written.

### Step 3 — `src/engine/odds-snapshots.js`

- Snapshot capture function: given a list of upcoming picked fixtures, call Odds API and write snapshot records
- Scheduler integration: identify which fixtures need a snapshot in the next N minutes; dispatch at appropriate time
- Storage: append to `data/history/odds-snapshots.jsonl`
- Rate-limit-aware: never blow the daily budget; if budget exceeded, log loudly and skip
- Timezone-safe: all internal logic in UTC

### Step 4 — Server / history integration

- Extend `src/server/history.js` to read both `predictions.jsonl` and `odds-snapshots.jsonl`, join on fixture/market/selection, compute CLV per record
- Expose CLV in the existing settled-picks API response
- Add aggregate methods: mean, median, positive CLV rate, sample size, plus the data-health counters from section 6.4

### Step 5 — Performance tab UI

- CLV column added to settled picks table (new column to the right of existing columns; same accordion/card pattern as established UI conventions in memory)
- Summary cards row above the picks table:
  - Mean CLV (%)
  - Median CLV (%)
  - Positive CLV rate (%)
  - Sample size (n)
- Optional: simple histogram of CLV distribution. **Defer if it threatens the weekend-2 deadline.**
- Data-health panel (small, collapsible): missing-pick-odds count, missing-snapshot count, postponed/voided count, unmatched-fixture count
- Graceful degradation: when CLV is missing for a record, show "—" rather than 0 or NaN; when sample size is below a small threshold (say 10), show a "low-sample" caveat on the summary cards

### Step 6 — Sanity checks

Not formal tests, but mandatory before declaring done:

- Compute CLV manually on 5 settled picks; compare to UI display
- Confirm CLV column in UI degrades to "—" for picks where snapshot or pick odds are missing
- Confirm summary cards update when new picks settle
- Confirm no existing Performance tab metrics regressed
- Confirm settlement still works end-to-end (Football-Data primary, Odds API scores fallback unchanged)

### Step 7 — Deploy

Per the locked deploy sequence in memory:
```
docker compose down
docker rmi goalscout goalscout-goalscout 2>/dev/null || true
docker builder prune -f
docker compose up --build -d
```
Then verify: image count, log inspection, browser screenshot of Performance tab showing CLV. Do not move on without verification.

---

## 8. UI / Performance tab specifics

Match existing GoalScout UI conventions (per memory):

- No emoji
- No bullet-list-heavy display where prose works (UI text only — this plan uses lists for readability)
- Chip / badge styling consistent with existing Direction badge, Grade indicator, Model filter
- Accordion expansion for additional detail acceptable but not required — CLV is a primary metric and should be visible in the collapsed row

**CLV column placement:** Same row as the existing settled-pick stats. The collapsed-row philosophy from memory ("decision-critical data must be visible without interaction") applies. CLV is decision-critical for evaluating picks; it goes in the collapsed row, not behind expansion.

**Summary cards:** Existing Performance tab has summary cards. CLV cards live in the same row or directly below. Consistent visual weight with existing cards.

**Distribution histogram:** Optional. If implemented, simple SVG bars (5–10 buckets) showing CLV distribution. No interactivity required in v1. **Skip if it would push past weekend 2.**

---

## 9. Acceptance criteria

The sprint is accepted as complete when **all** of the following are true:

1. Near-close odds snapshots are captured for **>80%** of eligible upcoming picks across at least 3 sample matchdays. (Eligible = pick logged with required fields; fixture has a known kickoff; fixture is in a league The Odds API covers.)
2. CLV calculation passes sign-convention verification on hard-coded known cases and on at least 5 hand-checked records.
3. Performance tab displays CLV column on settled picks, with "—" graceful degradation when CLV is missing.
4. Summary cards display mean CLV, median CLV, positive CLV rate, and sample size.
5. No existing Performance tab metrics or settlement behaviour are broken (regression check on the same 5 sample picks pre- and post-deploy).
6. No raw API keys or secrets exposed in client-side code, logs sent to UI, or committed config files. (Existing `config.js` and `docker-compose.yml` patterns preserved.)
7. No new modelling logic introduced. The diff in `src/engine/` consists of additions, not modifications to scoring or shortlisting modules.
8. Deploy sequence completes cleanly per the memory-locked process; image count = 1; logs show no errors on startup.
9. `MEASUREMENT-FOUNDATION-PREFLIGHT.md` is committed alongside the implementation.

---

## 10. Stop / go criteria

### Stop and reassess if:

- **Pick odds are not stored reliably.** If pre-flight reveals pick-time odds are missing on a substantial fraction of past records, decide between (a) accept forward-only CLV and proceed, (b) add pick-odds storage to the orchestrator first as a separate sub-sprint, (c) pause and rethink. Default is (a).
- **Fixture matching is unreliable.** If pre-flight finds that >20% of upcoming picked fixtures cannot be matched to Odds API events, snapshot coverage will be too low to produce useful aggregates. Diagnose root cause (team-name drift, league-key mismatches, API event-creation timing) before proceeding.
- **Odds API does not return markets near kickoff** for a substantial fraction of fixtures. If markets close on the API earlier than expected (e.g. T-30 minutes), shift the snapshot window earlier and document the change. If markets are unavailable for many fixtures regardless of timing, stop — v1 is not viable on The Odds API alone without changing source, timing, or scope.
- **Rate-limit budget cannot accommodate one snapshot per picked fixture per matchday.** Stop and decide: reduce capture coverage, reduce fixture scope, upgrade/adjust the plan, or choose a different odds source.
- **Sprint scope balloons past 2 weekends.** Hard rule: if at end of weekend 2 the Performance tab is not showing CLV on settled picks, freeze, write up what was built and what wasn't, and decide whether to continue or revert.

### Go (proceed with full sprint) if:

- Pre-flight confirms either: (a) pick-time odds are reliably stored (backfill possible), or (b) pick-time odds are stored from some recent date forward and we accept forward-only CLV from that date.
- Odds API returns matched fixtures and markets in the proposed snapshot window for >80% of test cases.
- Rate-limit budget has headroom for one snapshot per fixture per matchday across the typical fixture volume.
- Fixture matching by `fixture_id` or team-names + commence_time + league is deterministic on >80% of test cases.

### Definition of "useful answer" (downstream of this sprint, not part of acceptance):

Within 4–6 weeks of operation, the CLV distribution on settled soccer O/U2.5 picks has a clear sign — mean CLV ≥ +1% or ≤ −1% — on a sample of ≥100 picks. That is enough to know whether the existing soccer system is generating value, breaking even, or systematically losing to the market, independent of hit rate or ROI.

This is *not* a v1 acceptance criterion (we cannot wait 4–6 weeks before declaring v1 done). It is the criterion for the *next* decision: whether to invest in modelling improvements, narrow the market, or change direction entirely.

---

## 11. Suggested branch

`feature/measurement-foundation-v1`

---

## 12. First implementation step

**`MEASUREMENT-FOUNDATION-PREFLIGHT.md`** — a pre-flight document, supported by a small read-only audit script that inspects `data/history/predictions.jsonl` and produces:

- Field coverage report (which fields are present on what fraction of records)
- Sample of 20 records (random + 20 most recent)
- Schema-change history (when did each field first appear, when did any disappear)
- Initial answers to section 4 questions

Output of the pre-flight gates everything else. No `clv.js` work, no `odds-snapshots.js` work, no UI work happens before the pre-flight is complete and a backfill-vs-forward decision is documented.

---

## 13. Open questions for the implementer

These are not blocking but should be resolved as the work progresses. Document answers in the pre-flight or sprint retrospective:

- Should the snapshot scheduler run inside the existing GoalScout container or as a separate cron entry on Unraid? (Recommend: inside the container, using a lightweight scheduling library, to keep deployment unified.)
- Should we capture snapshots for *all* upcoming fixtures GoalScout has data on, or only those that have an associated pick? (Recommend: only those with a pick, to conserve rate-limit budget.)
- If a pick is updated/superseded after initial logging (does this happen?), which version's pick-time odds is canonical for CLV?
- Does the existing soccer pipeline have any concept of "paper" vs "real" picks that affects which records should be included in CLV aggregates?

---

**End of plan.**
