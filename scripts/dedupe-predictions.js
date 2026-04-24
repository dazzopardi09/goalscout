const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '../data/history/predictions.jsonl');

function load() {
  return fs.readFileSync(FILE, 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
}

function score(p) {
  let s = 0;

  // prefer settled
  if (p.status && p.status.startsWith('settled')) s += 100;

  // prefer having odds
  if (p.marketOdds) s += 10;

  // prefer newer
  if (p.settledAt) s += new Date(p.settledAt).getTime() / 1e13;
  else if (p.predictionTimestamp) s += new Date(p.predictionTimestamp).getTime() / 1e13;

  return s;
}

function key(p) {
  return [
    p.fixtureId,
    p.method || 'current',
    p.market || p.direction || 'unknown'
  ].join('|');
}

function dedupe(rows) {
  const map = new Map();

  for (const row of rows) {
    const k = key(row);
    const existing = map.get(k);

    if (!existing || score(row) > score(existing)) {
      map.set(k, row);
    }
  }

  return Array.from(map.values());
}

function run() {
  const original = load();
  console.log(`original rows: ${original.length}`);

  const deduped = dedupe(original);
  console.log(`deduped rows: ${deduped.length}`);
  console.log(`removed: ${original.length - deduped.length}`);

  const output = deduped.map(r => JSON.stringify(r)).join('\n') + '\n';

  fs.writeFileSync(FILE, output, 'utf8');

  console.log('✅ predictions.jsonl deduped');
}

run();
