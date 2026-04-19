#!/usr/bin/env node
// fix-predictions.js
// Run from your server: node fix-predictions.js
// Creates a fixed copy at predictions.jsonl.fixed
// Review it, then: mv predictions.jsonl.fixed predictions.jsonl
//
// What this does:
// 1. Removes duplicate records (same fixtureId + market + predictionDate)
//    keeping the LAST one (most complete data)
// 2. Leaves all market values exactly as they are — does NOT remap
//    because the history.js getPredictionStats already handles:
//    - over_2.5 + btts → Over 2.5 Goals tab
//    - under_2.5       → Under 2.5 Goals tab
// 3. Reports what it found

const fs   = require('fs');
const path = require('path');

const FILE = '/mnt/user/appdata/goalscout/data/history/predictions.jsonl';
const OUT  = FILE + '.fixed';

const raw = fs.readFileSync(FILE, 'utf8');
const lines = raw.split('\n').filter(l => l.trim());

const records = lines.map((l, i) => {
  try { return JSON.parse(l); }
  catch(e) { console.error(`Line ${i+1} parse error: ${e.message}`); return null; }
}).filter(Boolean);

console.log(`Total records read: ${records.length}`);

// Count by market before
const before = {};
records.forEach(r => before[r.market] = (before[r.market] || 0) + 1);
console.log('Before:', before);

// Deduplicate: key = fixtureId + '|' + market + '|' + predictionDate
// Keep LAST occurrence (most complete — newer records have more fields)
const seen = new Map();
for (const r of records) {
  const key = `${r.fixtureId}|${r.market}|${r.predictionDate}`;
  seen.set(key, r); // overwrites with latest
}

const deduped = Array.from(seen.values());
console.log(`After dedup: ${deduped.length} records (removed ${records.length - deduped.length} duplicates)`);

// Count by market after
const after = {};
deduped.forEach(r => after[r.market] = (after[r.market] || 0) + 1);
console.log('After:', after);

// Write output
fs.writeFileSync(OUT, deduped.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
console.log(`\nWritten to: ${OUT}`);
console.log(`Review with: cat ${OUT} | python3 -m json.tool | head -50`);
console.log(`Apply with:  mv ${OUT} ${FILE}`);