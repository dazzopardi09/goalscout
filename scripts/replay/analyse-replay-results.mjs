import fs from 'fs';

const PREDICTIONS_FILE = './data/replay/replay-predictions.jsonl';
const RESULTS_FILE = './data/replay/replay-results.jsonl';

function readJsonl(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function pct(n, d) {
  return d ? ((n / d) * 100).toFixed(1) + '%' : 'n/a';
}

function bucketForProb(p) {
  if (p == null) return 'null';
  if (p < 0.5) return '<0.50';
  if (p < 0.6) return '0.50-0.59';
  if (p < 0.7) return '0.60-0.69';
  if (p < 0.8) return '0.70-0.79';
  return '0.80+';
}

function summarise(label, items) {
  const wins = items.filter(r => r.won).length;
  const losses = items.length - wins;
  console.log(
    `${label.padEnd(28)} count=${String(items.length).padStart(3)}  won=${String(wins).padStart(3)}  lost=${String(losses).padStart(3)}  hit=${pct(wins, items.length)}`
  );
}

const predictions = readJsonl(PREDICTIONS_FILE);
const results = readJsonl(RESULTS_FILE);

const resultMap = new Map(
  results.map(r => [`${r.fixtureId}|${r.market}|${r.replayRunId}`, r])
);

const rows = predictions
  .map(p => {
    const key = `${p.fixtureId}|${p.market}|${p.replayRunId}`;
    const r = resultMap.get(key);
    if (!r) return null;
    return {
      ...p,
      settledStatus: r.status,
      won: r.status === 'settled_won',
    };
  })
  .filter(Boolean);

console.log('\n=== Replay overall ===');
summarise('All replay predictions', rows);

console.log('\n=== By grade ===');
for (const grade of ['A+', 'A', 'B', '-']) {
  summarise(`Grade ${grade}`, rows.filter(r => (r.grade ?? '-') === grade));
}

console.log('\n=== By direction ===');
for (const direction of ['o25', 'u25']) {
  summarise(`Direction ${direction}`, rows.filter(r => r.direction === direction));
}

console.log('\n=== By modelProbability bucket ===');
for (const bucket of ['<0.50', '0.50-0.59', '0.60-0.69', '0.70-0.79', '0.80+']) {
  summarise(
    `Prob ${bucket}`,
    rows.filter(r => bucketForProb(r.modelProbability) === bucket)
  );
}

const brierItems = rows.filter(r => typeof r.modelProbability === 'number');
if (brierItems.length) {
  const brier =
    brierItems.reduce((sum, r) => {
      const y = r.won ? 1 : 0;
      return sum + Math.pow(r.modelProbability - y, 2);
    }, 0) / brierItems.length;

  console.log('\n=== Calibration ===');
  console.log('Brier score:', brier.toFixed(4));
}

console.log('\n=== Filter tests ===');
const filters = [
  ['A only', r => r.grade === 'A'],
  ['A+ only', r => r.grade === 'A+'],
  ['A and A+', r => r.grade === 'A' || r.grade === 'A+'],
  ['B only', r => r.grade === 'B'],
  ['No "-" grades', r => r.grade !== '-'],
  ['O2.5 only', r => r.direction === 'o25'],
  ['U2.5 only', r => r.direction === 'u25'],
  ['A only + O2.5', r => r.grade === 'A' && r.direction === 'o25'],
  ['A and A+ + O2.5', r => (r.grade === 'A' || r.grade === 'A+') && r.direction === 'o25'],
  ['No "-" + O2.5', r => r.grade !== '-' && r.direction === 'o25'],
  ['A only + U2.5', r => r.grade === 'A' && r.direction === 'u25'],
  ['No "-" + U2.5', r => r.grade !== '-' && r.direction === 'u25'],
];

for (const [label, fn] of filters) {
  summarise(label, rows.filter(fn));
}

const confidentMisses = rows
  .filter(r => !r.won && typeof r.modelProbability === 'number')
  .sort((a, b) => b.modelProbability - a.modelProbability)
  .slice(0, 10);

console.log('\n=== Top 10 confident misses ===');
for (const r of confidentMisses) {
  console.log(
    `${r.fixtureId}  ${r.market}  prob=${r.modelProbability}  grade=${r.grade}  ${r.homeTeam} vs ${r.awayTeam}`
  );
}