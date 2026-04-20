// src/replay/runner.js
// ─────────────────────────────────────────────────────────────
// Historical Replay v1 — Runner
//
// Walks epl_2025_26_fixtures.json in chronological order.
// For each completed fixture, builds point-in-time features
// using only prior completed matches (no leakage), scores
// the match using the live shortlist and probability engines,
// and writes a prediction record to:
//   data/replay/replay-predictions.jsonl
//
// This file is SEPARATE from data/history/predictions.jsonl.
// It never touches the live prediction log.
//
// Settlement is handled separately by src/replay/settler.js.
// replay-predictions.jsonl contains status: "pending" only.
//
// Usage:
//   node src/replay/runner.js
//   node src/replay/runner.js --min-sample 5
//   node src/replay/runner.js --limit 10
//   node src/replay/runner.js --dry-run
//
// Options:
//   --min-sample N   minimum prior games required per team (default 3)
//   --limit N        only process first N eligible fixtures (for testing)
//   --dry-run        print predictions to stdout, do not write file
// ─────────────────────────────────────────────────────────────

'use strict';

const fs   = require('fs');
const path = require('path');

const { buildNormalisedFeatures } = require('./feature-builder');
const { scoreMatch }              = require('../engine/shortlist');
const { estimateO25, fairOdds }   = require('../engine/probability');

// ── CLI args ──────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(flag, defaultVal) {
  const i = args.indexOf(flag);
  if (i !== -1 && args[i + 1]) return args[i + 1];
  return defaultVal;
}

const MIN_SAMPLE = parseInt(getArg('--min-sample', '3'), 10);
const LIMIT      = parseInt(getArg('--limit', '0'), 10);   // 0 = no limit
const DRY_RUN    = args.includes('--dry-run');

// ── Paths ─────────────────────────────────────────────────────

const DATA_DIR         = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const FIXTURES_FILE    = path.join(DATA_DIR, 'historical', 'epl_2025_26_fixtures.json');
const REPLAY_DIR       = path.join(DATA_DIR, 'replay');
const PREDICTIONS_FILE = path.join(REPLAY_DIR, 'replay-predictions.jsonl');

// ── Helpers ───────────────────────────────────────────────────

function ensureReplayDir() {
  if (!fs.existsSync(REPLAY_DIR)) {
    fs.mkdirSync(REPLAY_DIR, { recursive: true });
  }
}

function appendJSONL(filePath, obj) {
  fs.appendFileSync(filePath, JSON.stringify(obj) + '\n', 'utf8');
}

function loadFixtures() {
  if (!fs.existsSync(FIXTURES_FILE)) {
    throw new Error(`Fixtures file not found: ${FIXTURES_FILE}`);
  }
  const raw = JSON.parse(fs.readFileSync(FIXTURES_FILE, 'utf8'));
  // Sort chronologically — transform script already does this, but enforce it here
  return raw.sort((a, b) => new Date(a.kickoffUtc) - new Date(b.kickoffUtc));
}

/**
 * Build the replay prediction object.
 * status is always "pending" — settlement is separate.
 * Matches live prediction schema with replay-only additions.
 */
function buildPrediction(fixture, features, scoreResult, o25prob, u25prob, replayRunId) {
  const isU25 = scoreResult.direction === 'u25';
  const dirProb = isU25 ? u25prob : o25prob;
  const fair    = dirProb != null ? fairOdds(dirProb) : null;

  return {
    // Identity — matches live schema
    fixtureId:           fixture.fixtureId,
    predictionDate:      fixture.kickoffUtc.slice(0, 10),
    predictionTimestamp: new Date().toISOString(),
    modelVersion:        'baseline-v1',

    // Match info
    league:    fixture.leagueName,
    leagueSlug: fixture.leagueKey,
    homeTeam:  fixture.homeTeam,
    awayTeam:  fixture.awayTeam,
    kickoffUtc: fixture.kickoffUtc,

    // Direction + scoring — matches live schema fields
    market:           isU25 ? 'under_2.5' : 'over_2.5',
    direction:        scoreResult.direction,
    grade:            scoreResult.grade,
    winningScore:     scoreResult.winningScore,
    baseO25Score:     scoreResult.o25score,
    baseU25Score:     scoreResult.u25score,

    // Probabilities
    modelProbability: dirProb   != null ? Math.round(dirProb * 10000) / 10000 : null,
    fairOdds:         fair,

    // Odds — not available in replay
    marketOdds:  null,
    bookmaker:   null,
    edge:        null,

    // CLV fields — not available in replay
    preKickoffOdds:    null,
    preKickoffMovePct: null,
    closingOdds:       null,
    clvPct:            null,

    // Settlement — pending until settler.js runs
    status:    'pending',
    result:    null,
    settledAt: null,

    // Feature inputs snapshot
    inputs: {
      homeO25pct: features.home.o25pct,
      awayO25pct: features.away.o25pct,
      homeCSpct:  features.home.csPct,
      awayCSpct:  features.away.csPct,
      homeFTSpct: features.home.ftsPct,
      awayFTSpct: features.away.ftsPct,
      homeAvgTG:  features.home.avgTG,
      awayAvgTG:  features.away.avgTG,
      homeSample: features.sampleSizes.home,
      awaySample: features.sampleSizes.away,
    },

    // Replay-only fields
    source:      'replay',
    replayRunId,
  };
}

// ── Main ──────────────────────────────────────────────────────

async function run() {
  const replayRunId = `replay_${new Date().toISOString()}`;

  console.log('');
  console.log('══════════════════════════════════════════════════');
  console.log('  GoalScout — Historical Replay v1');
  console.log('══════════════════════════════════════════════════');
  console.log(`  Run ID:     ${replayRunId}`);
  console.log(`  Min sample: ${MIN_SAMPLE} games per team`);
  console.log(`  Limit:      ${LIMIT > 0 ? LIMIT : 'none'}`);
  console.log(`  Dry run:    ${DRY_RUN}`);
  console.log(`  Output:     ${DRY_RUN ? 'stdout only' : PREDICTIONS_FILE}`);
  console.log('');

  const fixtures = loadFixtures();
  const completed = fixtures.filter(f => f.status === 'completed');
  console.log(`  Fixtures total:    ${fixtures.length}`);
  console.log(`  Completed:         ${completed.length}`);
  console.log('');

  if (!DRY_RUN) ensureReplayDir();

  // Counters
  let processed = 0;
  let written   = 0;
  let skippedSample  = 0;
  let skippedTied    = 0;
  let skippedNoProb  = 0;

  const toProcess = LIMIT > 0 ? completed.slice(0, LIMIT) : completed;

  for (const fixture of toProcess) {
    processed++;

    // Build point-in-time features (no-leakage guaranteed by replay-metrics)
    let features;
    try {
      features = await buildNormalisedFeatures(fixtures, fixture, 5);
    } catch (err) {
      console.error(`  [skip] ${fixture.homeTeam} vs ${fixture.awayTeam}: feature build failed — ${err.message}`);
      continue;
    }

    // Skip if either team has insufficient prior sample
    if (
      features.sampleSizes.home < MIN_SAMPLE ||
      features.sampleSizes.away < MIN_SAMPLE
    ) {
      skippedSample++;
      continue;
    }

    // Build the match object in the shape scoreMatch expects
    const matchObj = {
      home: features.home,
      away: features.away,
    };

    // Score match using the live directional scorer
    const scoreResult = scoreMatch(matchObj, {});

    // Skip tied direction — same logic as live shortlist
    if (scoreResult.direction === null) {
      skippedTied++;
      continue;
    }

    // Estimate probabilities using the live probability engine
    const o25prob = estimateO25(matchObj, {});
    if (o25prob == null) {
      skippedNoProb++;
      continue;
    }
    const u25prob = Math.round((1 - o25prob) * 10000) / 10000;

    // Assemble prediction
    const prediction = buildPrediction(
      fixture,
      features,
      scoreResult,
      o25prob,
      u25prob,
      replayRunId
    );

    if (DRY_RUN) {
      console.log(JSON.stringify(prediction));
    } else {
      appendJSONL(PREDICTIONS_FILE, prediction);
    }

    written++;
  }

  // Summary
  console.log('');
  console.log('  ── Run summary ──────────────────────────────');
  console.log(`  Completed fixtures processed : ${processed}`);
  console.log(`  Predictions written          : ${written}`);
  console.log(`  Skipped (sample < ${MIN_SAMPLE})         : ${skippedSample}`);
  console.log(`  Skipped (tied O2.5/U2.5)     : ${skippedTied}`);
  console.log(`  Skipped (no probability)     : ${skippedNoProb}`);

  if (!DRY_RUN && written > 0) {
    // Direction split for validation
    const lines = fs.readFileSync(PREDICTIONS_FILE, 'utf8')
      .split('\n').filter(l => l.trim())
      .map(l => JSON.parse(l))
      .filter(p => p.replayRunId === replayRunId);

    const o25count = lines.filter(p => p.direction === 'o25').length;
    const u25count = lines.filter(p => p.direction === 'u25').length;
    console.log(`  Direction split              : ${o25count} O2.5, ${u25count} U2.5`);

    // Grade split
    const grades = {};
    for (const p of lines) grades[p.grade] = (grades[p.grade] || 0) + 1;
    const gradeStr = Object.entries(grades).sort().map(([g, n]) => `${g}:${n}`).join('  ');
    console.log(`  Grade split                  : ${gradeStr}`);
  }

  console.log('');
  console.log('  Next step: run src/replay/settler.js to resolve outcomes.');
  console.log('══════════════════════════════════════════════════');
  console.log('');
}

run().catch(err => {
  console.error('[replay/runner] fatal error:', err);
  process.exit(1);
});
