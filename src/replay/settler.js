// src/replay/settler.js
// ─────────────────────────────────────────────────────────────
// Historical Replay v1 — Settler
//
// Resolves outcomes for replay predictions by joining
// replay-predictions.jsonl against epl_2025_26_fixtures.json
// using fixtureId.
//
// Writes to:
//   data/replay/replay-results.jsonl   ← results only
//
// Does NOT modify:
//   data/replay/replay-predictions.jsonl   ← preserved for auditability
//   data/history/predictions.jsonl         ← live system untouched
//   data/history/results.jsonl             ← live system untouched
//
// Settlement rules (identical to live settler):
//   over_2.5  → totalGoals > 2.5  → won
//   under_2.5 → totalGoals < 2.5  → won  (note: exactly 2.5 = lost for under)
//
// Usage:
//   node src/replay/settler.js
//   node src/replay/settler.js --dry-run
//   node src/replay/settler.js --run-id replay_2026-04-20T10:30:00Z
//
// Options:
//   --dry-run     print results to stdout, do not write file
//   --run-id ID   only settle predictions from a specific replayRunId
// ─────────────────────────────────────────────────────────────

'use strict';

const fs   = require('fs');
const path = require('path');
const { loadHistoricalFixtures } = require('./load-historical-fixtures');

// ── CLI args ──────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(flag, defaultVal = null) {
  const i = args.indexOf(flag);
  if (i !== -1 && args[i + 1]) return args[i + 1];
  return defaultVal;
}

const DRY_RUN = args.includes('--dry-run');
const RUN_ID_FILTER = getArg('--run-id');

// ── Paths ─────────────────────────────────────────────────────

const DATA_DIR           = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const REPLAY_DIR         = path.join(DATA_DIR, 'replay');
const PREDICTIONS_FILE   = path.join(REPLAY_DIR, 'replay-predictions.jsonl');
const RESULTS_FILE       = path.join(REPLAY_DIR, 'replay-results.jsonl');

// ── I/O ───────────────────────────────────────────────────────

function readJSONL(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(l => l.trim())
    .map((l, i) => {
      try { return JSON.parse(l); }
      catch { console.error(`  [warn] parse error at line ${i + 1} in ${path.basename(filePath)}`); return null; }
    })
    .filter(Boolean);
}

function appendJSONL(filePath, obj) {
  fs.appendFileSync(filePath, JSON.stringify(obj) + '\n', 'utf8');
}

function ensureReplayDir() {
  if (!fs.existsSync(REPLAY_DIR)) {
    fs.mkdirSync(REPLAY_DIR, { recursive: true });
  }
}

// ── Settlement logic ──────────────────────────────────────────

/**
 * Determine win/loss for a given market and total goals.
 * Returns 'won' | 'lost' | null (null = unsettleable).
 * Note: under_2.5 with exactly 2 goals = won (2 < 2.5).
 *       under_2.5 with exactly 3 goals = lost (3 > 2.5).
 *       This mirrors the live settler exactly.
 */
function resolveOutcome(market, homeGoals, awayGoals) {
  if (homeGoals == null || awayGoals == null) return null;
  const totalGoals = homeGoals + awayGoals;
  if (market === 'over_2.5')  return totalGoals >  2.5 ? 'won' : 'lost';
  if (market === 'under_2.5') return totalGoals <  2.5 ? 'won' : 'lost';
  return null;
}

// ── Main ──────────────────────────────────────────────────────

function run() {
  console.log('');
  console.log('══════════════════════════════════════════════════');
  console.log('  GoalScout — Historical Replay v1 Settler');
  console.log('══════════════════════════════════════════════════');
  console.log(`  Dry run:    ${DRY_RUN}`);
  if (RUN_ID_FILTER) console.log(`  Run filter: ${RUN_ID_FILTER}`);
  console.log('');

  // Load fixtures — keyed by fixtureId for O(1) lookup
  
  const fixtures = loadHistoricalFixtures();
  const fixtureMap = new Map(fixtures.map(f => [f.fixtureId, f]));
  console.log(`  Fixtures loaded: ${fixtures.length}`);

  // Load replay predictions
  if (!fs.existsSync(PREDICTIONS_FILE)) {
    throw new Error(`Replay predictions file not found: ${PREDICTIONS_FILE}\nRun src/replay/runner.js first.`);
  }
  const allPredictions = readJSONL(PREDICTIONS_FILE);
  console.log(`  Replay predictions loaded: ${allPredictions.length}`);

  // Apply run-id filter if specified
  const predictions = RUN_ID_FILTER
    ? allPredictions.filter(p => p.replayRunId === RUN_ID_FILTER)
    : allPredictions;

  if (RUN_ID_FILTER) {
    console.log(`  After run-id filter: ${predictions.length}`);
  }

  // Load already-settled results to avoid duplicates
  const existingResults = readJSONL(RESULTS_FILE);
  const alreadySettled  = new Set(
    existingResults.map(r => `${r.fixtureId}|${r.market}|${r.replayRunId || ''}`)
  );
  console.log(`  Already settled: ${existingResults.length}`);
  console.log('');

  if (!DRY_RUN) ensureReplayDir();

  // Counters
  let settled  = 0;
  let skippedDuplicate  = 0;
  let skippedNoFixture  = 0;
  let skippedNoGoals    = 0;
  let skippedBadMarket  = 0;
  let won  = 0;
  let lost = 0;

  const settledAt = new Date().toISOString();

  for (const pred of predictions) {
    const dedupeKey = `${pred.fixtureId}|${pred.market}|${pred.replayRunId || ''}`;

    // Skip if already settled
    if (alreadySettled.has(dedupeKey)) {
      skippedDuplicate++;
      continue;
    }

    // Look up the fixture result
    const fixture = fixtureMap.get(pred.fixtureId);
    if (!fixture) {
      skippedNoFixture++;
      continue;
    }

    // Fixture must be completed with goals recorded
    if (fixture.homeGoals == null || fixture.awayGoals == null) {
      skippedNoGoals++;
      continue;
    }

    // Determine outcome
    const outcome = resolveOutcome(pred.market, fixture.homeGoals, fixture.awayGoals);
    if (outcome === null) {
      skippedBadMarket++;
      continue;
    }

    const totalGoals = fixture.homeGoals + fixture.awayGoals;

    const result = {
      // Identity
      fixtureId:    pred.fixtureId,
      leagueKey:    pred.leagueKey || fixture.leagueKey,
      replayRunId:  pred.replayRunId || null,

      // Match info (for readability when inspecting the file)
      homeTeam:     fixture.homeTeam,
      awayTeam:     fixture.awayTeam,
      kickoffUtc:   fixture.kickoffUtc,
      league:       fixture.leagueName,

      // Market context
      market:       pred.market,
      direction:    pred.direction,

      // Actual result
      fullTimeHome: fixture.homeGoals,
      fullTimeAway: fixture.awayGoals,
      totalGoals,
      result:       `${fixture.homeGoals}-${fixture.awayGoals}`,
      over25:       totalGoals >  2.5,
      under25:      totalGoals <  2.5,

      // Outcome
      status:       outcome === 'won' ? 'settled_won' : 'settled_lost',
      settledAt,
    };

    if (DRY_RUN) {
      console.log(JSON.stringify(result));
    } else {
      appendJSONL(RESULTS_FILE, result);
    }

    settled++;
    if (outcome === 'won') won++;
    else lost++;
  }

  // Summary
  console.log('');
  console.log('  ── Settlement summary ───────────────────────');
  console.log(`  Settled                   : ${settled}`);
  console.log(`  Won                       : ${won}`);
  console.log(`  Lost                      : ${lost}`);
  if (settled > 0) {
    const hitRate = Math.round(won / settled * 1000) / 10;
    console.log(`  Hit rate                  : ${hitRate}%`);
  }
  console.log(`  Skipped (duplicate)       : ${skippedDuplicate}`);
  console.log(`  Skipped (fixture missing) : ${skippedNoFixture}`);
  console.log(`  Skipped (no goals data)   : ${skippedNoGoals}`);
  console.log(`  Skipped (bad market)      : ${skippedBadMarket}`);

  if (!DRY_RUN && settled > 0) {
    console.log('');
    console.log(`  Results written to: ${RESULTS_FILE}`);
    console.log(`  Predictions file unchanged: ${PREDICTIONS_FILE}`);
  }

  console.log('══════════════════════════════════════════════════');
  console.log('');
}

try {
  run();
} catch (err) {
  console.error('[replay/settler] fatal error:', err.message);
  process.exit(1);
}
