# `context_raw` — Standalone Recent-Form Diagnostic Model

**Version:** 1.1
**Status:** Approved for implementation, Stage 1
**Owner:** GoalScout
**Last updated:** April 2026

---

## Purpose of this document

This is the grounded, scope-locked specification for the `context_raw` diagnostic model. It exists so we can come back to it any time scope creep, drift, or architectural temptation appears. Anything not described here is out of scope for v1.

The shorthand summary is:

> Build a standalone recent-form-only model that disagrees with the current season-aggregate model on purpose, run it as a historical backtest across multiple completed seasons (offline, not live), surface the results in a dedicated Performance tab research section with filters, and use that data to learn whether recent goals context has signal worth integrating into a future blended production model.

This is a **diagnostic experiment**, not the next production model.

---

## Table of contents

1. Why this exists
2. The Arsenal vs Newcastle motivating example
3. Final model architecture
4. Data source decision
5. v1 feature set
6. Flag definitions
7. Standalone scoring logic
8. Raw probability estimate
9. Historical snapshot method (leakage prevention)
10. Gameweek/matchweek handling
11. Backtest output file shape
12. Performance tab research section UI
13. Evaluation metrics
14. What comparisons are valid
15. Implementation stages
16. Validation questions
17. Out of scope for v1
18. Glossary

---

## 1. Why this exists

GoalScout's current models (`current` and `calibrated`) score matches using SoccerSTATS season-level aggregates: O2.5%, average total goals, clean sheet %, failed-to-score %. These are stable but blind to recent form. A team's season O2.5% can be high for very different reasons — they score and concede regularly, OR they get hammered by strong attacking teams, OR they recently played a string of high-scoring opponents.

The `context_raw` model is built to test whether replacing season aggregates with **rolling per-team goals data from the last 6 completed matches** produces meaningfully different predictions, and whether those differences correlate with actual outcomes.

**Critical framing:** This is not a future production model. It is deliberately recent-only to maximise disagreement with the existing model. Disagreement cases are the diagnostic data we want. The eventual production model is likely a **blend** of season aggregates, recent context, opponent quality, and xG — but we cannot design that blend until we know what each component contributes. `context_raw` is the experiment that tells us the recent-form weight.

---

## 2. Motivating example: Arsenal vs Newcastle

The fixture that triggered this whole investigation. The setup looked like an O2.5 candidate by season aggregates:

- Arsenal: strong attack, high season O2.5%
- Newcastle: high season O2.5% (driven by frequent losses)
- Combined avgTG looked good

But recent context told a different story:
- Newcastle had lost their last several games and scored very few goals
- Newcastle's high O2.5 rate was driven by **conceding heavily**, not contributing goals
- Arsenal were under title pressure after losing their lead over Man City
- Arsenal had not been free-scoring recently
- The over depended on Arsenal scoring 3 alone
- That is a **fragile O2.5 setup**, not a strong two-sided over

The `context_raw` model is explicitly designed to flag this archetype via the `concede_driven_over` and `one_sided_over_risk` flags. If it does not catch this case in backtesting, the model has failed at its primary job.

---

## 3. Final model architecture

GoalScout will eventually run **three parallel, independently-tracked models** on the same fixture pool:

| Model | Inputs | Probability source | Status |
|---|---|---|---|
| `current` | SoccerSTATS season aggregates | `probability.js` weighted average | Live |
| `calibrated` | Same as Current | Current output, Platt-scaled per league | Live |
| `context_raw` | Rolling per-team goals stats from last 6 completed matches | `context-shortlist.js` raw estimate | **Backtest only in v1, live deferred to Stage 8** |
| `context_calibrated` | Same as `context_raw` | `context_raw` output, Platt-scaled using `context_raw` settled predictions only | Future, deferred to Stage 9 |

### Architectural rules (non-negotiable)

- `context_raw` does **not** import from `shortlist.js` or `probability.js`
- `context_raw` does **not** reuse `league-calibration.json` parameters (they were derived from Current's distribution)
- `context_raw` does **not** read SoccerSTATS season aggregates as inputs
- `context_raw` predictions are logged with `method: 'context_raw'` via the existing `logPrediction()` function
- Settlement and stats aggregation work unchanged — the existing infrastructure already handles arbitrary method strings
- A single fixture can have separate `current`, `calibrated`, and `context_raw` predictions in `predictions.jsonl` (deduplication key remains `fixtureId + method + direction`)

---

## 4. Data source decision

**Primary source: Football-Data.co.uk** (note: NOT football-data.org).

### Why this source

The current GoalScout repo uses football-data.org for live result settlement, but its **free tier does not provide multi-season historical data** — the historical access is locked behind a €29/mo plan. This was confirmed via documentation review.

Football-Data.co.uk is a different, free, non-API source providing:

- 30+ years of completed historical results as CSV downloads
- Big 5 European leagues (EPL, La Liga, Bundesliga, Serie A, Ligue 1) plus Championship, Eredivisie, Bundesliga 2, Liga Portugal, and others
- Match-level data: home/away teams, full-time score, half-time score, date, matchday inferable from date sequence
- **Pre-match opening and closing odds from multiple bookmakers** for major markets including over/under 2.5 — meaning historical ROI can be computed in the backtest
- One-time CSV download per league per season, stored locally as `data/historical/{league}/{season}.csv`
- No rate limits, no API key, no quota concerns

### What this changes

This is materially better for offline backtesting than the football-data.org API would have been. Multi-season backtesting becomes straightforward — download once, query forever. Including historical odds in the backtest unlocks ROI metrics from day one without any odds API quota usage.

### Coverage starting point

EPL CSV files from Football-Data.co.uk go back to 1993. For v1 backtesting, **5–10 completed seasons** of EPL data is more than enough to establish whether `context_raw` has signal. The actual smoke test starts smaller (see Stage 1).

### Live deployment data source (later, Stage 8)

If `context_raw` validates in backtesting and we proceed to live deployment, the live source remains football-data.org (already integrated in `src/results/football-data.js`) for the 12 covered leagues. The CSV historical source is **backtest-only**.

---

## 5. v1 feature set

### Per team, last 6 completed matches before kickoff

| Feature | Definition |
|---|---|
| `gf_avg` | Goals scored per game |
| `ga_avg` | Goals conceded per game |
| `fts_count` | Games where team scored 0 |
| `scored2plus_count` | Games where team scored ≥ 2 |
| `conceded2plus_count` | Games where team conceded ≥ 2 |
| `o25_count` | Games where total goals > 2.5 |
| `games_available` | Number of completed matches found (may be < 6 early season) |

### Passive logging (collected, not used in scoring)

| Feature | Definition |
|---|---|
| `btts_count` | Games where both teams scored |

### Why last 6, not last 5

With N=5, discrete counts collapse to coarse buckets (e.g., `fts_count >= 3` covers 3–5 of 5, splitting the spectrum across only 4 values). Single-match shifts cause flag flicker between refreshes.

With N=6, you get 7 possible values per count and thresholds sit on more stable footing. `fts_count >= 3` cleanly means "half or more of recent games scoreless". Better noise behaviour for the same data cost.

A secondary point: 6 matches better captures both home and away venue mix for most teams (typical 3:3 split vs N=5's forced 3:2). Not decisive but points the same way.

---

## 6. Flag definitions

All flags are computed at fixture level from the per-team rolling stats. Subscripts H = home, A = away.

### `both_weak_attack`
**Formula:** `gf_avg_H < 1.0 AND gf_avg_A < 1.0`
**Meaning:** Neither team has been scoring recently. Combined output too low for a confident over.
**Effect:** O2.5 score: −3. U2.5 score: +2.

### `one_sided_over_risk`
**Formula:** `(scored2plus_count_H >= 3 AND scored2plus_count_A <= 1) OR (scored2plus_count_A >= 3 AND scored2plus_count_H <= 1)`
**Meaning:** One team scoring well, other not. Over depends on the strong team carrying it alone.
**Effect:** O2.5 score: −1. Logging-only for U2.5.

### `concede_driven_over` (per team, then evaluated at fixture level)
**Formula (per team):** `o25_count >= 3 AND scored2plus_count <= 1 AND conceded2plus_count >= 2`
**Meaning:** Team's recent O2.5 record reflects defensive collapse, not attacking output.

**Favourite/underdog determination (deterministic):**

```
If 1X2 closing odds available (Football-Data.co.uk B365H/B365A or equivalent):
  favourite = team with lower of (home_win_odds, away_win_odds)
  underdog  = the other team
  is_clear_mismatch = max(home_win_odds, away_win_odds) / min(home_win_odds, away_win_odds) >= 2.0

Fallback when 1X2 odds are not in the dataset:
  favourite = team with higher rolling avg PPG over their last 6 matches
  is_clear_mismatch = (PPG gap) >= 1.0
```

**Fixture-level effect:**
- If `!is_clear_mismatch`: apply the "both teams" rule below regardless of which team(s) have the per-team flag — without a clear favourite, the asymmetric treatment doesn't apply
- If flag fires for **underdog only** AND `is_clear_mismatch`: O2.5 score −2
- If flag fires for **both teams**: O2.5 score −1, log for human review
- If flag fires for **favourite only**: log but no score change (favourite's O2.5 is still legitimate threat)
- Does **not** affect U2.5 scoring

This rule is deterministic. Repeated runs on the same fixture will produce identical flag values. No subjectivity.

### `both_leaky_defence`
**Formula:** `ga_avg_H >= 1.8 AND ga_avg_A >= 1.8 AND gf_avg_H >= 1.0 AND gf_avg_A >= 1.0`
**Meaning:** Both teams have genuinely leaky defences AND both can at least contribute goals (not just getting battered). Goals come from defensive weakness on both sides; this is a legitimate over candidate distinct from `strong_two_sided_over`. The `gf_avg >= 1.0` floor on both teams is critical — without it, this would overlap with `concede_driven_over × 2` (the false-over case where one or both teams are getting hammered without contributing). The floor confirms both teams can score.
**Effect:** O2.5 score: +2. U2.5 score: −2.

### `strong_two_sided_over`
**Formula:** `scored2plus_count_H >= 3 AND scored2plus_count_A >= 3 AND gf_avg_H >= 1.5 AND gf_avg_A >= 1.5`
**Meaning:** Both teams genuinely producing goals. Clean two-sided over candidate.
**Effect:** O2.5 score: +3. U2.5 score: −2.

### `low_attack_under_support`
**Formula:** `gf_avg_H < 1.2 AND gf_avg_A < 1.2 AND (fts_count_H + fts_count_A) >= 4`
**Meaning:** Both teams struggling to score. Combined fts incidents support a structural under case.
**Effect:** U2.5 score: +3. O2.5 score: −2.

### `insufficient_recent_data`
**Formula:** `games_available_H < 4 OR games_available_A < 4`
**Meaning:** Not enough completed matches to compute reliable rolling stats (early season, mid-season break, newly promoted).
**Effect:** **Skip prediction entirely.** Do not generate a `context_raw` row. Log the skip reason in the backtest output for traceability. A missing prediction is honest; a low-confidence prediction contaminates metrics.

---

## 7. Standalone scoring logic

A new module `src/engine/context-shortlist.js`. **Imports nothing from `shortlist.js` or `probability.js`.**

Score the fixture for both directions, take the strictly higher. Ties excluded as ambiguous.

### O2.5 scoring (positive signals)

| Signal | Score |
|---|---|
| `gf_avg_H >= 2.0` | +2 |
| `gf_avg_A >= 2.0` | +2 |
| `gf_avg_H >= 1.5 AND gf_avg_A >= 1.5` | +1 |
| `scored2plus_count_H >= 3` | +2 |
| `scored2plus_count_A >= 3` | +2 |
| `o25_count_H >= 4` | +1 |
| `o25_count_A >= 4` | +1 |
| `strong_two_sided_over` flag | +3 |
| `both_leaky_defence` flag | +2 |
| `ga_avg_H >= 1.8` | +1 |
| `ga_avg_A >= 1.8` | +1 |

### O2.5 scoring (negative signals)

| Signal | Score |
|---|---|
| `both_weak_attack` flag | −3 |
| `one_sided_over_risk` flag | −1 |
| `concede_driven_over` per fixture rules | −1 or −2 |
| `fts_count_H >= 3` | −2 |
| `fts_count_A >= 3` | −2 |
| `low_attack_under_support` flag | −2 |

### U2.5 scoring (positive signals)

| Signal | Score |
|---|---|
| `low_attack_under_support` flag | +3 |
| `gf_avg_H < 1.2 AND gf_avg_A < 1.2` | +2 |
| `fts_count_H >= 3` | +2 |
| `fts_count_A >= 3` | +2 |
| `o25_count_H <= 2 AND o25_count_A <= 2` | +2 |
| `conceded2plus_count_H <= 1` | +1 |
| `conceded2plus_count_A <= 1` | +1 |

### U2.5 scoring (negative signals)

| Signal | Score |
|---|---|
| `gf_avg_H >= 2.0 OR gf_avg_A >= 2.0` | −2 |
| `o25_count_H >= 4 AND o25_count_A >= 4` | −2 |
| `strong_two_sided_over` flag | −2 |
| `both_leaky_defence` flag | −2 |

### Direction selection and shortlist gate

- Direction: `o25_score > u25_score` → `o25`; `u25_score > o25_score` → `u25`; tie → exclude
- Shortlist threshold: winning_score `>= 4` (matches Current's threshold for early comparison consistency — tune after Stage 6)
- Grade bands: `>= 9` → A+; `>= 6` → A; `>= 4` → B

### Pseudocode

```
function scoreContext(rollingH, rollingA):
  if rollingH.games_available < 4 or rollingA.games_available < 4:
    return { skip: true, reason: 'insufficient_recent_data' }

  flags = computeFlags(rollingH, rollingA)
  o25_score = applyO25Signals(rollingH, rollingA, flags)
  u25_score = applyU25Signals(rollingH, rollingA, flags)

  if o25_score == u25_score:
    return { skip: true, reason: 'tied_direction' }

  direction = o25_score > u25_score ? 'o25' : 'u25'
  winning_score = max(o25_score, u25_score)

  if winning_score < 4:
    return { skip: true, reason: 'below_threshold' }

  return {
    direction,
    winning_score,
    grade: gradeFor(winning_score),
    o25_score,
    u25_score,
    flags,
    inputs: { rollingH, rollingA }
  }
```

---

## 8. Raw probability estimate

> **⚠ This is an uncalibrated experimental output.** It is named `context_o25_prob_raw` because the `_raw` suffix is the explicit safety mark — this output is not a true probability and should not be treated as one in any decision logic, UI display, or downstream computation until backtest validation is complete. Brier evaluation requires that we treat it as a probability *for measurement purposes only* — that does not imply it is well-calibrated. Any UI rendering of this value MUST include an "uncalibrated" or "experimental" indicator.

### Formula

```
recent_o25_rate = (o25_count_H + o25_count_A) / (games_available_H + games_available_A)
attack_signal   = clamp((gf_avg_H + gf_avg_A - 1.5) / 3.5, 0.05, 0.95)

context_o25_prob_raw = (recent_o25_rate * 0.6) + (attack_signal * 0.4)
```

Then apply small bounded flag adjustments:

```
if both_weak_attack:                 context_o25_prob_raw -= 0.10
if strong_two_sided_over:            context_o25_prob_raw += 0.05
if concede_driven_over (mismatch):   context_o25_prob_raw -= 0.08
```

Clamp final result to `[0.10, 0.90]`. `context_u25_prob_raw = 1 - context_o25_prob_raw`.

### Assumptions

- `recent_o25_rate` treats each team's recent O2.5 rate as a noisy estimate of fixture-level over tendency, averaged across both teams. Coarse — ignores opponent variation.
- `attack_signal` maps combined recent goals-for to a probability-like signal.
- The 60/40 weighting is a starting estimate. Real signal will likely require re-weighting, but until settled data exists, anything is a guess.

### Limits

- No opponent quality adjustment in v1 (Phase 3 concern)
- Small-sample noise: at 6 matches per team, single-match shifts move `recent_o25_rate` by ~0.08
- Floor/ceiling clamps prevent pathological extremes but mean very high confidence cannot be expressed
- Acceptable for v1 because the goal is signal detection, not perfect calibration

### Brier evaluation

After ~50 settled `context_raw` predictions in the backtest:

1. Compute Brier per direction (O2.5 and U2.5 separately)
2. Compare to Current and Calibrated Brier at the same sample size
3. Plot calibration buckets (predicted prob deciles vs actual hit rate) — does Context systematically over- or under-predict in any band?

If Context Brier is worse than Current after 100+ backtested predictions, the raw probability formula needs revision before any calibration layer is meaningful.

---

## 9. Historical snapshot method (leakage prevention)

For every historical fixture in the backtest dataset, simulate the pre-match state.

### Procedure per fixture

1. Identify fixture date `D` and kickoff time if available
2. For home team: query all completed matches in this league and team's history with `date < D` — take last 6
3. For away team: same procedure
4. Compute v1 feature set (Section 5) from those last-6 matches
5. Run `scoreContext()` (Section 7) and `rawProbability()` (Section 8)
6. Compare `context_o25_prob_raw` and `direction` against actual full-time result

### Leakage prevention rules (strict)

- A match is **only included** in rolling stats if its date is **strictly before** the target fixture's date
- If the target fixture has no kickoff time, treat date comparison as `before` (not `on or before`) — never include same-day matches even if technically earlier in the day
- Cross-competition matches (e.g. cup matches between league fixtures) are **excluded** from rolling stats in v1 — too noisy and asymmetric. Only league matches in the same competition count toward rolling.
- The team's own future fixtures and the target fixture itself must never appear in their own rolling window
- This is a one-shot offline calculation — no streaming risk, no caching collision risk

### Verification step (Stage 1 must include this)

Pick 5 random historical EPL fixtures from the dataset. For each:
- Print the home team's last 6 matches as they would have been seen pre-kickoff
- Print the away team's last 6 matches as they would have been seen pre-kickoff
- Print the computed feature set
- Manually verify: no match dated >= the target fixture's date appears in either window

This must pass before Stage 2 begins.

---

## 10. Gameweek/matchweek handling

### Football-Data.co.uk source format

Football-Data.co.uk CSVs do not have an explicit matchday/gameweek column. Matches are listed by date.

### Gameweek inference

For a season, group all fixtures by 7-day windows starting from the first fixture date. The first 7-day window is "GW1", the second is "GW2", and so on. This handles the typical case but is imperfect for:

- **Postponed fixtures** played later in the season — they fall into a later GW window than they "should". Accept this as noise; the rolling stats are still computed correctly because the date logic is correct.
- **Mid-week fixtures** during congested periods — multiple fixtures per team within a single 7-day window. Acceptable; the GW grouping is for **display**, not for any model logic.
- **Cup-week breaks** — some 7-day windows have no league fixtures. The grouping still works; a GW with zero fixtures simply doesn't appear.

### Why this is acceptable for v1

The model logic does not use gameweek as an input. Gameweek is **only** used for grouping and filtering in the Performance tab UI. Whether a postponed fixture appears in "its proper" gameweek or a later one doesn't affect prediction accuracy — only display.

### Alternative considered and rejected

Querying official matchday from a paid API was rejected because it adds API dependency and cost for no model benefit.

### Future enhancement (not v1)

If matchday accuracy becomes important for analysis, consider switching to a paid data source that provides explicit matchday fields, or layering matchday data onto the CSV via a separate scrape. Out of scope for v1.

---

## 11. Backtest output file shape

### File layout

```
data/backtests/context_raw/
  ├── england_2023_24.jsonl
  ├── england_2024_25.jsonl
  ├── germany_2024_25.jsonl       (Stage 7 onwards)
  ├── ...
  └── _index.json                  (metadata: which seasons/leagues are loaded)
```

One JSONL file per (league, season) combination. Append-only during a single backtest run, overwritten on rerun.

### Row schema

```
{
  "season": "2024-25",
  "league": "england",
  "leagueCode": "PL",
  "gameweek": 12,                          // inferred 7-day window
  "fixtureDate": "2024-11-09",
  "homeTeam": "Arsenal",
  "awayTeam": "Newcastle",

  "fullTimeHome": 1,
  "fullTimeAway": 0,
  "totalGoals": 1,
  "result_o25": false,
  "result_u25": true,
  "result_btts": false,

  "skipped": false,
  "skipReason": null,                      // one of: insufficient_recent_data, tied_direction, below_threshold

  "context_direction": "o25",              // null if skipped
  "context_o25_score": 7,
  "context_u25_score": 4,
  "context_winning_score": 7,
  "context_grade": "A",
  "context_prob_raw": 0.62,
  "context_fair_odds": 1.61,

  "flags": {
    "both_weak_attack": false,
    "one_sided_over_risk": true,
    "concede_driven_over_home": false,
    "concede_driven_over_away": true,
    "concede_driven_over_fixture": "underdog",   // null | "underdog" | "both" | "favourite_only"
    "strong_two_sided_over": false,
    "low_attack_under_support": false,
    "insufficient_recent_data": false
  },

  "homeRolling": {
    "gf_avg": 1.83,
    "ga_avg": 0.83,
    "fts_count": 1,
    "scored2plus_count": 4,
    "conceded2plus_count": 1,
    "o25_count": 4,
    "btts_count": 3,
    "games_available": 6
  },
  "awayRolling": { /* same shape */ },

  "marketOddsO25": 1.83,                   // from CSV if available
  "marketOddsU25": 1.95,
  "closingOddsO25": 1.78,
  "closingOddsU25": 2.00,

  "edge_pct": null,                         // computed when displayed; not stored
  "won": null,                              // null if skipped, else true/false based on direction + result
  "stakeUnits": 1,
  "returnUnits": null                       // null if skipped, else profit/loss in units
}
```

### Notes on the schema

- **One row per fixture** including skipped ones — preserves the full denominator for "what fraction of fixtures generated predictions"
- **Result fields populated for every row** — even skipped fixtures have results, useful for cross-checking that skip logic isn't biased toward easy fixtures
- **Edge and won fields computed at display time** in the UI — not stored, since they depend on the prediction having been generated. Reduces the chance of stale-data bugs.
- **Odds fields nullable** — Football-Data.co.uk has odds for major leagues but not all leagues/seasons. Handle gracefully.

---

## 12. Performance tab research section UI

### Section name

**"Context Research — Historical Backtest"**

Distinct from the live Current/Calibrated/Context performance section (which won't exist until Stage 8 anyway). The research section makes it clear this is offline analysis, not live tracking.

### Placement

A new tab on the Performance page, alongside the existing Current/Calibrated tabs. Or a new sub-section below the existing performance content. Layout choice can be made during implementation; the priority is that it's clearly **separated** from live performance so a reader cannot mistake backtest hit rate for live hit rate.

### Filter bar (top of section)

Horizontal filter strip with these controls:

- **Season** — multi-select dropdown (e.g. 2022-23, 2023-24, 2024-25). Default: all loaded seasons.
- **League** — multi-select dropdown. Default: all loaded leagues.
- **Gameweek range** — two number inputs (from, to). Default: 1 to max.
- **Market** — radio: All / O2.5 only / U2.5 only. Default: All.
- **Result** — multi-select chips: Won / Lost / Skipped. Default: Won + Lost (skipped excluded).
- **Flag filters** — multi-select chips:
  - `concede_driven_over`
  - `one_sided_over_risk`
  - `both_weak_attack`
  - `strong_two_sided_over`
  - `low_attack_under_support`
  - Each chip in three states: any / required / excluded

All filters compose with AND logic. Selection updates the views below in real time.

### View 1 — Summary cards (top row, after filter bar)

Four cards, similar to the existing Performance hero strip:

| Card | Value | Subtitle |
|---|---|---|
| Predictions | count | "X skipped of Y total" |
| Hit rate | % | "won / settled" |
| Brier | 0.xxxx | "lower = better" |
| ROI | +/-X% | "if odds available" |

### View 2 — Hit rate by season (bar chart or table)

Simple bars, one per season, height = hit rate. Tooltip: prediction count, won count, ROI.

If multiple leagues selected, group bars by league within each season.

### View 3 — Hit rate by gameweek (line or bar)

X-axis: gameweek 1–38 (or whatever the season length is).
Y-axis: hit rate.
Tooltip: prediction count, ROI.

If multiple seasons selected, average across seasons or show one line per season (toggle).

### View 4 — O2.5 vs U2.5 split

Two side-by-side mini-cards showing O2.5 and U2.5 separately:
- Predictions, hit rate, Brier, ROI for each market

### View 5 — Flag performance table

Table with one row per flag, columns:

| Flag | Predictions where flag fired | Hit rate | Brier | ROI | Avg edge |
|---|---|---|---|---|---|

This is the most important analytical view — it directly answers "does `concede_driven_over` actually identify bad O2.5 candidates?"

Add a second table below for **flag interaction effects** — pairs of flags that frequently co-occur and their combined hit rates. Lower priority for v1.

### View 6 — Fixture list

Below the views above, a paginated table listing every fixture matching the current filters:

| Date | GW | League | Match | Direction | Score | Prob | Odds | Result | Flags |
|---|---|---|---|---|---|---|---|---|---|

Click a row to expand and show the full rolling inputs (homeRolling and awayRolling JSON) for that fixture. This is essential for sanity-checking — if a backtested prediction looks wrong, you need to see exactly what data the model saw.

### View 7 — Inspect rolling inputs

Inline expansion or modal. Shows for the selected fixture:
- Home team last-6 match list with dates and scores
- Away team last-6 match list with dates and scores
- Computed feature set side by side
- All flag values
- Score breakdown (which signals fired and contributed how much)

### Design notes

- No fancy charts in v1. Plain bars, plain tables, plain numbers. Visual readability over chart polish.
- All counts and percentages should round consistently.
- Use existing GoalScout colour scheme (greens for wins, reds for losses, ambers for warnings).
- Keep the existing live Performance content unchanged — Context Research lives below or beside, never replacing.

---

## 13. Evaluation metrics

For the historical backtest:

### Volume
- Total fixtures processed
- Predictions generated
- Skipped (with breakdown by skip reason)
- O2.5 predictions, U2.5 predictions

### Accuracy
- Overall hit rate
- Brier score
- Hit rate by O2.5 / U2.5 separately
- Hit rate by season
- Hit rate by gameweek
- Hit rate by league (when multi-league)

### Probability quality
- Average raw probability
- Calibration plot (predicted decile vs actual hit rate)
- Brier decomposition: reliability + resolution + uncertainty (Stage 6)

### Profitability (when odds are available)
- Total stake units
- Total return units
- ROI %
- Mean edge at tip-time
- Mean edge at closing
- CLV (closing line value) per prediction

### Flag-specific
- Performance where each flag is present
- Performance where each flag is absent
- Difference — does the flag actually predict what we expect?

### Combined comparisons (Stage 5)
- Performance of `context_only` picks (where Current and Calibrated didn't shortlist) — this requires reconstructed Current predictions, see Section 14
- Performance where Current + Context agree on direction
- Performance where they disagree

---

## 14. What comparisons are valid

### Valid: Context standalone historical performance

Hit rate, Brier, ROI, flag analysis on the Context backtest dataset. This is the primary output and is fully valid.

### Limited: Context vs Current historical comparison

GoalScout does **not** have stored historical SoccerSTATS season aggregates for past seasons. The current `current` model uses live SoccerSTATS data which changes every refresh. We cannot perfectly reconstruct what `current` would have predicted on November 9, 2024 because we don't have a snapshot of November 9, 2024's SoccerSTATS aggregates.

What we **can** do:
- Use the Football-Data.co.uk match-by-match results to compute season-aggregate stats *as they would have been* on each historical fixture date (totals up to that point in the season)
- Run those reconstructed aggregates through `probability.js` to get a reconstructed Current prediction
- Compare to Context

This reconstruction is **approximate** — SoccerSTATS uses some data points (like league-wide O2.5%) that have specific scraping logic we'd need to replicate. Document the approximation clearly when comparison results are presented.

If Context outperforms reconstructed Current significantly in backtesting, that's strong signal. If they're close, the reconstruction noise might be drowning out the comparison. Treat Context vs reconstructed-Current as **directional, not definitive**.

### Future: Live Current vs Calibrated vs Context

Once Stage 8 is reached and `context_raw` runs live, all three models log predictions in real time and the comparison becomes fully apples-to-apples. This is the gold-standard comparison and is the goal of the whole exercise.

---

## 15. Implementation stages

### Stage 1 — Smoke test on EPL 2024-25 only

- Download Football-Data.co.uk EPL 2024-25 CSV to `data/historical/england/2024_25.csv`
- Build `src/engine/historical-data.js` to parse the CSV and provide `getMatches(league, season, before)` returning all matches before a given date
- Build `src/engine/rolling-stats.js` with `computeRollingStats(team, league, beforeDate, n=6)` that returns the v1 feature set with strict leakage prevention
- **Verification step:** Print rolling stats for 5 random EPL fixtures from late 2024-25, manually verify no leakage
- Commit the verification output (sanity-checked) before proceeding
- **Smoke test only — do not yet build the Context model**

### Stage 2 — Build standalone `context_raw` model (offline)

- Create `src/engine/context-shortlist.js` with `scoreContext()` and `rawProbability()` (Sections 7 and 8)
- No imports from `shortlist.js` or `probability.js`
- Unit-test the scoring logic with hand-crafted feature sets to verify score calculations match the spec
- Unit-test the flag computation against the Arsenal/Newcastle archetype: synthetic rolling stats matching that scenario should produce `concede_driven_over` for the underdog and reduce O2.5 score

### Stage 3 — Offline `context_raw` runner

- Build `scripts/run-context-backtest.js` (run inside the goalscout container per CLAUDE.md conventions)
- For each fixture in EPL 2024-25:
  - Compute home and away rolling stats as of fixture date
  - Run `scoreContext()` and `rawProbability()`
  - Capture flags, scores, prediction
  - Read result from CSV
  - Compute won/lost based on direction + result
  - Compute ROI if odds present
  - Write row to `data/backtests/context_raw/england_2024_25.jsonl`
- Print summary: predictions generated, skipped, hit rate, Brier, ROI

### Stage 4 — Backtest output files

Stage 3 already produces these. This stage is about freezing the schema and committing example output files to source control (or to a clearly-marked location not in `.gitignore`) so the Performance tab implementation has a known-shape input to develop against.

### Stage 5 — Performance tab research section

- Build the UI from Section 12 against the Stage 3 backtest output
- Filter logic, summary cards, hit rate by season/gameweek, flag performance table, fixture list with rolling-input inspection
- All views must work with a single league/season at first (EPL 2024-25)
- Plan for multi-league/multi-season but don't optimise for it yet

### Stage 6 — Expand to multiple EPL seasons

- Download EPL 2020-21, 2021-22, 2022-23, 2023-24 from Football-Data.co.uk
- Run `scripts/run-context-backtest.js` for each
- Verify the Performance tab handles the larger dataset
- This is where flag validation actually starts to mean something — 5 seasons × ~250 prediction-eligible fixtures per season ≈ 1,000+ backtested predictions

### Stage 7 — Expand to other leagues (if Stage 6 results are promising)

- Download Bundesliga, La Liga, Serie A, Ligue 1, Eredivisie historical CSVs
- Same backtest pipeline
- Watch carefully for team-name normalisation issues — Football-Data.co.uk team names will differ from FD.org team names. Add aliases to `team-names.js` as needed.
- Be honest about per-league signal — different leagues may behave differently. Document.

### Stage 8 — Live `context_raw` deployment (only after backtesting validates)

If and only if Stages 6–7 show clear signal:
- Switch from CSV historical to FD.org live for the rolling-stats source
- Add `context_raw` to the live orchestrator pass in `orchestrator.js`
- Predictions flow through `logPrediction(m, contextAnalysis, 'context_raw', selectionType)`
- The existing settlement and stats pipeline handles it
- Add Context tab to the live Performance section

### Stage 9 — `context_calibrated` and blended production model (future)

After 150+ live `context_raw` settled predictions:
- Derive Platt scaling parameters from `context_raw` data only (not reusing `current` parameters)
- Add `context_calibrated` as a fourth method
- Begin design work on a blended production model that combines season aggregates, recent context, opponent quality, and (later) xG. The blended model is not `context_raw` extended — it's a separate model informed by what we learned from `context_raw`.

---

## 16. Validation questions

These are the specific questions Stage 6 backtest data should answer. If the data does not answer them clearly, the model needs revision before Stage 7.

### Flag validity
- Does `concede_driven_over = true` predict O2.5 hit rate **below** the overall O2.5 baseline? (Primary success criterion — if no, the flag is broken or the model premise is wrong.)
- Do teams with `o25_count >= 4` AND `scored2plus_count <= 1` underperform for O2.5 when they're the underdog?
- Does `one_sided_over_risk` reduce O2.5 hit rate as expected, or is favourite-carrying-the-over actually viable?
- Does `both_weak_attack` predict U2.5 wins more reliably than the broader Context U2.5 picks?
- Does `strong_two_sided_over` outperform the broader Context O2.5 picks?

### The Arsenal/Newcastle archetype
- For fixtures matching the archetype (favourite vs declining underdog, `concede_driven_over` on underdog), what is the actual O2.5 hit rate? Is it meaningfully below the unfiltered Context O2.5 hit rate?

### Probability quality
- Is Context Brier better, worse, or similar to **reconstructed** Current at the same sample size? (Limited comparison — see Section 14.)
- Does Context find U2.5 candidates with hit rate above market-implied U2.5 probability?
- Does miscalibration vary by `games_available`? Is Context worse when N is below 6?
- Does miscalibration vary by competition stage (early/mid/late season)?

### Profitability
- Is Context CLV positive? (Critical — if odds drift unfavourably after Context tips, picks aren't finding genuine value.)
- Does ROI hold positive across multiple seasons or is it season-specific noise?
- What is ROI on `strong_two_sided_over` picks specifically vs the broader O2.5 set?
- What is ROI on `both_weak_attack` U2.5 picks specifically?

### Cross-model
- For fixtures where reconstructed Current and Context agree on direction, is hit rate higher than either alone?
- For Context-only picks (where reconstructed Current didn't shortlist), are they profitable as a subset?
- Do disagreement cases (reconstructed Current says O2.5, Context says U2.5) skew toward Context being right? If so, that's the strongest evidence that recent context provides genuine new signal.

---

## 17. Out of scope for v1

These have been considered and explicitly excluded. Adding them is scope creep until v1 validates.

- **Playing style / tactical profile inputs** (possession-based vs counter-attacking, low-block vs high-press, style-vs-style matchup effects). Real football phenomenon and well-supported in the analytics literature, but it is a structural team-identity signal, not recent form. Belongs to a separate future model class (`style_match` or part of a blended production model). Adding it to `context_raw` would defeat the diagnostic purpose of running a recent-only model. Also blocked at the data layer — neither SoccerSTATS nor Football-Data.co.uk exposes tactical profiles; would require FBref or StatsBomb integration.
- Opponent quality adjustment (Phase 3)
- xG inputs (separate Phase 2 work, parallel to this)
- Lineup adjustments
- Venue-specific splits (home_last6_home_only, etc.)
- BTTS market predictions (logged passively, not predicted)
- Team form streaks (W/L/D sequences) — not implied by goal totals
- Manager change adjustments
- Fixture congestion adjustments
- Weather adjustments
- Injury data
- Live `context_raw` deployment before backtest validation
- `context_calibrated` before 150+ settled `context_raw` predictions
- Blended production model design before backtest validation
- Cross-competition matches (cup matches) included in rolling
- Multi-source data fusion (FD.co.uk + FD.org + SoccerSTATS combined)
- Renaming `context_o25_prob_raw` to `context_confidence_raw` or similar — the `_raw` suffix is the safety mark; the alternatives introduce statistical-terminology ambiguity (see v1.1 document history)

---

## 18. Glossary

- **`context_raw`** — the standalone recent-form-only diagnostic model defined by this spec
- **`context_calibrated`** — future variant with Platt scaling derived from `context_raw` settled predictions
- **Rolling stats** — per-team statistics computed from the last N completed matches strictly before a target fixture date
- **Leakage** — accidentally including post-kickoff information in pre-match feature computation
- **Flag** — a boolean diagnostic computed from rolling stats, used to adjust scoring and to filter analysis
- **Backtest** — offline simulation of model predictions on historical fixtures with known outcomes
- **Archetype** — a recognisable pattern of features the model is specifically designed to handle (e.g., the Arsenal/Newcastle case)
- **Reconstructed Current** — an approximate replay of what the `current` model would have predicted on a historical fixture, computed by reconstructing season aggregates from the historical match record. Approximation, not exact.

---

## Document history

| Date | Version | Change |
|---|---|---|
| April 2026 | 1.0 | Initial consolidated spec, post Arsenal/Newcastle motivation, post historical-backtest pivot, post Football-Data.co.uk source decision |
| April 2026 | 1.1 | Added `both_leaky_defence` flag (legitimate over from defensive weakness with attacking floor). Replaced loose favourite/underdog wording with deterministic 1X2-odds-based rule plus PPG fallback. Strengthened experimental warning on `context_o25_prob_raw` per concern about treating it as a true probability — kept the name (rejected `context_confidence_raw`/`context_probability_estimate` as either statistically ambiguous or merely verbose) and addressed the underlying concern via stronger documentation and a UI-display requirement. Explicitly marked playing style / tactical profile as out of scope with rationale. |

---

## Quick reference for future implementation prompts

When kicking off implementation work, point to specific sections:

- **Stage 1 implementation:** Sections 4, 5, 9, 15-Stage-1
- **Stage 2 implementation:** Sections 6, 7, 8, 15-Stage-2
- **Stage 3 implementation:** Sections 11, 13, 15-Stage-3
- **Stage 5 implementation:** Sections 12, 13, 15-Stage-5
- **Stage 8 implementation:** Sections 3, 14, 15-Stage-8

When in doubt about scope, refer to Section 17.
