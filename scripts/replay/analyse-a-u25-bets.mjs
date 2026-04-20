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

function avg(arr) {
  if (!arr.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function fmt(n) {
  return n == null ? 'n/a' : n.toFixed(2);
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
  .filter(Boolean)
  .filter(r => r.grade === 'A' && r.direction === 'u25');

console.log('\n=== A grade + U2.5 bets ===');
console.log('Count:', rows.length);
console.log('Won:', rows.filter(r => r.won).length);
console.log('Lost:', rows.filter(r => !r.won).length);

const homeO25 = rows.map(r => r.inputs.homeO25pct).filter(n => typeof n === 'number');
const awayO25 = rows.map(r => r.inputs.awayO25pct).filter(n => typeof n === 'number');
const homeCS = rows.map(r => r.inputs.homeCSpct).filter(n => typeof n === 'number');
const awayCS = rows.map(r => r.inputs.awayCSpct).filter(n => typeof n === 'number');
const homeFTS = rows.map(r => r.inputs.homeFTSpct).filter(n => typeof n === 'number');
const awayFTS = rows.map(r => r.inputs.awayFTSpct).filter(n => typeof n === 'number');
const homeAvgTG = rows.map(r => r.inputs.homeAvgTG).filter(n => typeof n === 'number');
const awayAvgTG = rows.map(r => r.inputs.awayAvgTG).filter(n => typeof n === 'number');

console.log('\n=== Average feature profile ===');
console.log('homeO25pct:', fmt(avg(homeO25)));
console.log('awayO25pct:', fmt(avg(awayO25)));
console.log('homeCSpct :', fmt(avg(homeCS)));
console.log('awayCSpct :', fmt(avg(awayCS)));
console.log('homeFTSpct:', fmt(avg(homeFTS)));
console.log('awayFTSpct:', fmt(avg(awayFTS)));
console.log('homeAvgTG :', fmt(avg(homeAvgTG)));
console.log('awayAvgTG :', fmt(avg(awayAvgTG)));

const winners = rows.filter(r => r.won);
const losers = rows.filter(r => !r.won);

function printGroup(label, items) {
  const vals = name => items.map(r => r.inputs[name]).filter(n => typeof n === 'number');
  console.log(`\n=== ${label} ===`);
  console.log('count      :', items.length);
  console.log('homeO25pct :', fmt(avg(vals('homeO25pct'))));
  console.log('awayO25pct :', fmt(avg(vals('awayO25pct'))));
  console.log('homeCSpct  :', fmt(avg(vals('homeCSpct'))));
  console.log('awayCSpct  :', fmt(avg(vals('awayCSpct'))));
  console.log('homeFTSpct :', fmt(avg(vals('homeFTSpct'))));
  console.log('awayFTSpct :', fmt(avg(vals('awayFTSpct'))));
  console.log('homeAvgTG  :', fmt(avg(vals('homeAvgTG'))));
  console.log('awayAvgTG  :', fmt(avg(vals('awayAvgTG'))));
}

printGroup('Winners', winners);
printGroup('Losers', losers);

console.log('\n=== Individual bets ===');
for (const r of rows) {
  console.log(
    `${r.won ? 'WIN ' : 'LOSS'} | ${r.fixtureId} | prob=${r.modelProbability} | ${r.homeTeam} vs ${r.awayTeam} | ` +
    `hO25=${r.inputs.homeO25pct} aO25=${r.inputs.awayO25pct} ` +
    `hCS=${r.inputs.homeCSpct} aCS=${r.inputs.awayCSpct} ` +
    `hFTS=${r.inputs.homeFTSpct} aFTS=${r.inputs.awayFTSpct} ` +
    `hTG=${r.inputs.homeAvgTG} aTG=${r.inputs.awayAvgTG}`
  );
}
