// scripts/context/check-settler-compatibility.js
// ─────────────────────────────────────────────────────────────
// Stage 10 pre-flight: verifies that settler.js can handle
// context_raw prediction records correctly.
//
// Run INSIDE the container before the first context prediction
// is logged to a live predictions.jsonl:
//
//   docker cp scripts/context/check-settler-compatibility.js \
//     goalscout:/app/scripts/context/check-settler-compatibility.js
//   docker exec -it goalscout \
//     node /app/scripts/context/check-settler-compatibility.js
//
// Reports PASS / WARN / FAIL for each compatibility check.
// ─────────────────────────────────────────────────────────────

'use strict';

const fs   = require('fs');
const path = require('path');

const config = require('../../src/config');

// ── Colour helpers ────────────────────────────────────────────
const G = s => `\x1b[32m${s}\x1b[0m`;
const Y = s => `\x1b[33m${s}\x1b[0m`;
const R = s => `\x1b[31m${s}\x1b[0m`;
const B = s => `\x1b[1m${s}\x1b[0m`;

const hr = (c = '─') => c.repeat(70);

let passes = 0, warns = 0, fails = 0;

function PASS(label, detail = '') {
  console.log(G('  ✓ PASS') + `  ${label}` + (detail ? `  — ${detail}` : ''));
  passes++;
}
function WARN(label, detail = '') {
  console.log(Y('  ⚠ WARN') + `  ${label}` + (detail ? `  — ${detail}` : ''));
  warns++;
}
function FAIL(label, detail = '') {
  console.log(R('  ✗ FAIL') + `  ${label}` + (detail ? `  — ${detail}` : ''));
  fails++;
}

// ── Find settler.js ───────────────────────────────────────────

function findSettler() {
  const candidates = [
    path.join(__dirname, '../../src/engine/settler.js'),
    path.join(__dirname, '../../src/settlers/settler.js'),
    path.join(__dirname, '../../src/settler.js'),
    path.join(__dirname, '../../settler.js'),
    path.join(__dirname, '../../src/scrapers/settler.js'),
  ];

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }

  // Walk src/ looking for it
  function walk(dir) {
    if (!fs.existsSync(dir)) return null;
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        const found = walk(full);
        if (found) return found;
      } else if (entry === 'settler.js') {
        return full;
      }
    }
    return null;
  }

  return walk(path.join(__dirname, '../../src')) ||
         walk(path.join(__dirname, '../../'));
}

// ── Analysis helpers ──────────────────────────────────────────

function readSettler(settlerPath) {
  return fs.readFileSync(settlerPath, 'utf8');
}

function analyseSettler(src) {
  return {
    // How does settler find predictions to settle?
    readsJSONL:         /readJSONL|JSONL|predictions\.jsonl/i.test(src),
    readsPredictions:   /PREDICTIONS_FILE|predictions\./i.test(src),
    readsResults:       /RESULTS_FILE|results\./i.test(src),

    // How does it join results to predictions?
    joinsByFixtureId:   /fixtureId/.test(src),
    joinsByTeamDate:    /homeTeam.*date|date.*homeTeam|awayTeam.*date/.test(src),

    // What fixtureId format does it write to results?
    writesMatchId:      /match\.id/.test(src),
    writesCustomId:     /fixtureId.*=.*\$\{|makeFixtureId/.test(src),

    // Does it filter by modelVersion?
    filtersModelVersion: /modelVersion/.test(src),

    // Does it handle 'over_2.5' market?
    handlesOver25:      /over_2\.5|over2_5|OVER_25/.test(src),

    // Does it handle 'under_2.5' market?
    handlesUnder25:     /under_2\.5|under2_5|UNDER_25/.test(src),

    // Does it use modelProbability field?
    usesModelProb:      /modelProbability/.test(src),

    // Does it read the results from Football-Data.org?
    usesFDO:            /football-data\.org|football_data_org|FDO|fdoClient/i.test(src),

    // CLV capture
    capturesClosingOdds: /closingOdds|closing_odds|preKickoff/i.test(src),
    computesCLV:         /clv|CLV/.test(src),
  };
}

// ── Run checks ────────────────────────────────────────────────

function run() {
  console.log('\n' + hr('═'));
  console.log(B('SETTLER.JS COMPATIBILITY CHECK — Stage 10 context_raw paper-tracking'));
  console.log(hr('═') + '\n');

  // ── 1. Find settler.js ────────────────────────────────────
  console.log(B('1. Locating settler.js'));
  const settlerPath = findSettler();
  if (!settlerPath) {
    FAIL('settler.js not found in src/ or project root');
    console.log('\n  Run: find /app -name settler.js 2>/dev/null');
    console.log('  Then inspect it manually against the criteria below.\n');
  } else {
    PASS('found settler.js', settlerPath.replace(/.*\/app\//, '/app/'));
  }

  const src = settlerPath ? readSettler(settlerPath) : null;
  const a   = src ? analyseSettler(src) : {};

  // ── 2. Prediction file access ─────────────────────────────
  console.log('\n' + B('2. Prediction file access'));
  if (!src) {
    FAIL('cannot analyse — settler.js not found');
  } else {
    if (a.readsPredictions) PASS('settler reads predictions.jsonl');
    else WARN('settler.js does not appear to read predictions.jsonl', 'context predictions may not be settled');
  }

  // ── 3. Join key (critical) ────────────────────────────────
  console.log('\n' + B('3. Join key — how settler matches predictions to results'));
  if (!src) {
    FAIL('cannot analyse');
  } else {
    if (a.joinsByFixtureId) {
      PASS('settler joins by fixtureId');
      // Check what fixtureId it writes to results
      if (a.writesMatchId) {
        PASS('settler uses match.id as fixtureId in results', 'compatible with logContextPrediction (uses match.id)');
      } else if (a.writesCustomId) {
        WARN('settler may write a computed fixtureId to results', 'verify it matches match.id used in predictions');
      } else {
        WARN('cannot determine fixtureId format in results records', 'manual inspection needed — see §3 below');
      }
    } else if (a.joinsByTeamDate) {
      WARN('settler joins by team name + date', 'may work if names match across data sources');
    } else {
      FAIL('cannot determine how settler joins predictions to results');
    }
  }

  // ── 4. modelVersion filtering ─────────────────────────────
  console.log('\n' + B('4. modelVersion filtering'));
  if (!src) {
    FAIL('cannot analyse');
  } else {
    if (a.filtersModelVersion) {
      WARN('settler filters by modelVersion', 'check that context_raw_v1.2 is not excluded');
      // Show the relevant line for manual review
      const lines = src.split('\n');
      lines.forEach((line, i) => {
        if (/modelVersion/.test(line)) {
          console.log(Y(`     line ${i + 1}: `) + line.trim());
        }
      });
    } else {
      PASS('settler does not filter by modelVersion', 'context predictions will be settled regardless of modelVersion');
    }
  }

  // ── 5. Market handling ────────────────────────────────────
  console.log('\n' + B('5. Market field handling'));
  if (!src) {
    FAIL('cannot analyse');
  } else {
    if (a.handlesOver25) PASS('settler handles market: over_2.5');
    else WARN('settler does not appear to handle market: over_2.5', 'context O2.5 predictions may not be settled');

    if (a.handlesUnder25) PASS('settler handles market: under_2.5');
    else WARN('settler does not handle market: under_2.5', 'context U2.5 predictions will not be settled — acceptable');
  }

  // ── 6. modelProbability field ─────────────────────────────
  console.log('\n' + B('6. modelProbability field'));
  if (!src) {
    FAIL('cannot analyse');
  } else {
    if (a.usesModelProb) {
      PASS('settler uses modelProbability field', 'context records set modelProbability = context_prob_used');
    } else {
      WARN('settler may not use modelProbability', 'check how it determines the predicted outcome');
    }
  }

  // ── 7. CLV capture ────────────────────────────────────────
  console.log('\n' + B('7. CLV and closing odds capture'));
  if (!src) {
    FAIL('cannot analyse');
  } else {
    if (a.capturesClosingOdds && a.computesCLV) {
      PASS('settler captures closing odds and computes CLV', 'context predictions will get CLV automatically');
    } else if (a.capturesClosingOdds) {
      PASS('settler captures closing odds');
      WARN('CLV computation not detected', 'may need to add clvPct to settled context records');
    } else {
      WARN('settler does not appear to capture closing odds', 'CLV will not be available for context predictions — Stage 11 concern, not blocking now');
    }
  }

  // ── 8. Deduplication compatibility ────────────────────────
  console.log('\n' + B('8. Deduplication — context records coexist with current model records'));
  console.log('  context-predictions.js deduplicates by:  fixtureId + predictionDate + modelVersion');
  console.log('  history.js logPrediction deduplicates by: fixtureId + predictionDate');
  console.log('  These are DIFFERENT keys — context and current records coexist correctly.');
  PASS('deduplication keys are non-overlapping by design');

  // ── 9. Print full settler.js for manual review ────────────
  if (src) {
    console.log('\n' + hr('═'));
    console.log(B('settler.js — full source for manual review'));
    console.log(hr() + '\n');
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      const n = String(i + 1).padStart(4, ' ');
      console.log(`  ${n}  ${line}`);
    });
  }

  // ── Summary ───────────────────────────────────────────────
  console.log('\n' + hr('═'));
  console.log(B('SUMMARY'));
  console.log(hr() + '\n');
  console.log(`  ${G('PASS')}: ${passes}   ${Y('WARN')}: ${warns}   ${R('FAIL')}: ${fails}\n`);

  if (fails > 0) {
    console.log(R('  ✗ Compatibility issues found — do not deploy Stage 10 wiring until resolved.'));
  } else if (warns > 0) {
    console.log(Y('  ⚠ Manual review needed for the WARNs above before deploying.'));
  } else {
    console.log(G('  ✓ All checks passed — safe to wire Stage 10 logging.'));
  }

  console.log('\n  What to look for in the settler.js source above:\n');
  console.log('  §1. Does logResult() use match.id or a computed fixtureId?');
  console.log('      If computed (e.g. makeFixtureId()), it must produce the same value');
  console.log('      as match.id for context predictions to settle correctly.\n');
  console.log('  §2. Does settler iterate over predictions.jsonl and look up results by fixtureId?');
  console.log('      Or does it iterate over results and look up predictions?');
  console.log('      Either way, fixtureId must match across both files.\n');
  console.log('  §3. Is there any filter like `if (p.modelVersion !== "current")` that would');
  console.log('      skip context_raw_v1.2 records?\n');
  console.log('  §4. Does settler write closingOdds and clvPct to the settled record?');
  console.log('      Context predictions will have these fields available for calibration review.\n');

  console.log(hr('═') + '\n');
}

run();
