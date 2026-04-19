#!/usr/bin/env node
// fix-predictions-final.js
// Fixes fixtureId mismatches + applies settled status from results.jsonl
// Run: node fix-predictions-final.js
// Then: mv predictions.jsonl.fixed predictions.jsonl

const fs = require('fs');

const PRED_FILE    = '/mnt/user/appdata/goalscout/data/history/predictions.jsonl';
const RESULTS_FILE = '/mnt/user/appdata/goalscout/data/history/results.jsonl';
const OUT_FILE     = PRED_FILE + '.fixed';

// ── Read files ─────────────────────────────────────────────
function readJSONL(file) {
  try {
    return fs.readFileSync(file, 'utf8')
      .split('\n').filter(l => l.trim())
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

const predictions = readJSONL(PRED_FILE);
const results     = readJSONL(RESULTS_FILE);

console.log(`Predictions: ${predictions.length}`);
console.log(`Results: ${results.length}`);

// ── Build result map ───────────────────────────────────────
const resultMap = new Map();
for (const r of results) resultMap.set(r.fixtureId, r);

// ── Manual fixtureId remaps ────────────────────────────────
// Where prediction fixtureId doesn't match result fixtureId
// Format: predictionId -> resultId
const REMAP = {
  // SC Bastia was in france2 (Ligue 2) not france (Ligue 1)
  'france_sc_bastia_saint-etienne': 'france2_sc_bastia_saint-etienne',
};

// ── Step 1: Deduplicate ────────────────────────────────────
// Key: fixtureId + market + predictionDate — keep LAST (most complete)
const seen = new Map();
for (const p of predictions) {
  const key = `${p.fixtureId}|${p.market}|${p.predictionDate}`;
  seen.set(key, p);
}
const deduped = Array.from(seen.values());
console.log(`After dedup: ${deduped.length} (removed ${predictions.length - deduped.length})`);

// ── Step 2: Apply remaps + resolve status ──────────────────
let settled = 0, alreadySettled = 0, stillPending = 0;

const fixed = deduped.map(p => {
  // Already settled with inline status — leave alone
  if (p.status === 'settled_won' || p.status === 'settled_lost' || p.status === 'void') {
    alreadySettled++;
    return p;
  }

  // Apply fixtureId remap if needed
  const lookupId = REMAP[p.fixtureId] || p.fixtureId;
  const r = resultMap.get(lookupId);

  if (!r || r.matchStatus !== 'completed' || r.fullTimeHome == null) {
    stillPending++;
    return { ...p, status: p.status || 'pending' };
  }

  // Determine win/loss
  const totalGoals = r.totalGoals ?? (r.fullTimeHome + r.fullTimeAway);
  let won;
  if (p.market === 'over_2.5') {
    won = totalGoals > 2.5;
  } else if (p.market === 'under_2.5') {
    won = totalGoals <= 2.5;
  } else if (p.market === 'btts') {
    won = r.bttsYes ?? (r.fullTimeHome > 0 && r.fullTimeAway > 0);
  } else {
    stillPending++;
    return { ...p, status: p.status || 'pending' };
  }

  settled++;
  return {
    ...p,
    fixtureId:  p.fixtureId, // keep original in predictions (remap only for lookup)
    status:     won ? 'settled_won' : 'settled_lost',
    result:     `${r.fullTimeHome}-${r.fullTimeAway}`,
    settledAt:  r.settledAt,
    // CLV fields stay null until pre-KO/closing odds are captured
  };
});

// ── Step 3: Report ─────────────────────────────────────────
const byMarket = {};
const byStatus = {};
for (const p of fixed) {
  byMarket[p.market] = (byMarket[p.market] || 0) + 1;
  byStatus[p.status] = (byStatus[p.status] || 0) + 1;
}

console.log('\nBy market:', byMarket);
console.log('By status:', byStatus);
console.log(`\nSettled now: ${settled}`);
console.log(`Already settled: ${alreadySettled}`);
console.log(`Still pending: ${stillPending}`);

// Show settled U2.5 specifically
const u25settled = fixed.filter(p => p.market === 'under_2.5' && (p.status === 'settled_won' || p.status === 'settled_lost'));
console.log(`\nU2.5 settled records (${u25settled.length}):`);
for (const p of u25settled) {
  console.log(`  ${p.status === 'settled_won' ? '✓' : '✗'} ${p.homeTeam} vs ${p.awayTeam} | ${p.result} | model: ${Math.round(p.modelProbability*100)}%`);
}

// ── Step 4: Write ──────────────────────────────────────────
fs.writeFileSync(OUT_FILE, fixed.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
console.log(`\nWritten: ${OUT_FILE}`);
console.log(`Apply:   mv "${OUT_FILE}" "${PRED_FILE}"`);