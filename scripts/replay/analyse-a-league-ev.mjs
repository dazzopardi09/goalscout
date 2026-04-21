import fs from 'fs';

const PREDICTIONS_FILE = './data/replay/replay-predictions.jsonl';
const RESULTS_FILE = './data/replay/replay-results.jsonl';
const ODDS_FILE = './data/a_league_odds.json';

function readJsonl(path) {
  return fs.readFileSync(path, 'utf8')
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean)
    .map(JSON.parse);
}

function normaliseTeam(name) {
  return String(name)
    .replace(/\bUtd\b/g, 'United')
    .replace(/\bFC\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function excelDateToYmd(excelSerial) {
  const excelEpoch = new Date(Date.UTC(1899, 11, 30));
  const ms = Number(excelSerial) * 24 * 60 * 60 * 1000;
  const d = new Date(excelEpoch.getTime() + ms);
  return d.toISOString().slice(0, 10);
}

function buildOddsKey(row) {
  return [
    excelDateToYmd(row.Date),
    normaliseTeam(row['Home Team']),
    normaliseTeam(row['Away Team']),
  ].join('|');
}

function devigTwoWay(overOdds, underOdds) {
  const overImp = 1 / overOdds;
  const underImp = 1 / underOdds;
  const sum = overImp + underImp;

  return {
    overProb: overImp / sum,
    underProb: underImp / sum,
    margin: sum - 1,
  };
}

function roi(stakes) {
  const totalStake = stakes.length;
  const totalProfit = stakes.reduce((a, b) => a + b, 0);
  return {
    bets: totalStake,
    profit: totalProfit,
    roiPct: totalStake ? (totalProfit / totalStake) * 100 : 0,
  };
}

const predictions = readJsonl(PREDICTIONS_FILE)
  .filter(p => p.leagueKey === 'a_league')
  .filter(p => p.market === 'over_2.5');

const seasons = [...new Set(predictions.map(p => {
  const y = p.predictionDate?.slice(0, 4);
  if (!y) return null;
  const year = Number(y);
  const nextShort = String(year + 1).slice(2);
  return `${year}-${nextShort}`;
}).filter(Boolean))];

console.log('\n=== Replay season context ===');
console.log(`Season(s): ${seasons.join(', ') || 'unknown'}`);

const dateRange = [...predictions.map(p => p.predictionDate)].sort();
if (dateRange.length) {
  console.log(`Prediction date range: ${dateRange[0]} → ${dateRange[dateRange.length - 1]}`);
}

const results = readJsonl(RESULTS_FILE);

const resultMap = new Map(
  results.map(r => [`${r.leagueKey}|${r.fixtureId}|${r.market}|${r.replayRunId}`, r])
);

const oddsRows = JSON.parse(fs.readFileSync(ODDS_FILE, 'utf8'));

const oddsMap = new Map();
for (const row of oddsRows) {
  if (!row.Date || !row['Home Team'] || !row['Away Team']) continue;
  if (!row['O. 2.5 Close'] || !row['U. 2.5 Close']) continue;
  oddsMap.set(buildOddsKey(row), row);
}

const matched = [];

for (const p of predictions) {
  const key = [
    p.predictionDate,
    normaliseTeam(p.homeTeam),
    normaliseTeam(p.awayTeam),
  ].join('|');

  const row = oddsMap.get(key);
  if (!row) continue;

  const overOdds = Number(row['O. 2.5 Close']);
  const underOdds = Number(row['U. 2.5 Close']);
  if (!Number.isFinite(overOdds) || !Number.isFinite(underOdds)) continue;

  const { overProb, margin } = devigTwoWay(overOdds, underOdds);
  const modelProb = Number(p.modelProbability);
  const resultKey = `${p.leagueKey}|${p.fixtureId}|${p.market}|${p.replayRunId}`;
  const r = resultMap.get(resultKey);
  if (!r) continue;

  const won = r.status === 'settled_won';

  matched.push({
    fixtureId: p.fixtureId,
    predictionDate: p.predictionDate,
    homeTeam: p.homeTeam,
    awayTeam: p.awayTeam,
    grade: p.grade,
    modelProb,
    marketProb: overProb,
    edgePct: (modelProb - overProb) * 100,
    overOdds,
    underOdds,
    marginPct: margin * 100,
    won,
    profit: won ? (overOdds - 1) : -1,
  });
}

const coverage = predictions.length ? (matched.length / predictions.length) * 100 : 0;

const positiveEdge = matched.filter(m => m.edgePct > 0);
const edgeOver5 = matched.filter(m => m.edgePct > 5);
const prob65 = matched.filter(m => m.modelProb >= 0.65);
const prob70 = matched.filter(m => m.modelProb >= 0.70);

console.log('\n=== A-League O2.5 odds join ===');
console.log(`Predictions: ${predictions.length}`);
console.log(`Matched odds: ${matched.length}`);
console.log(`Coverage: ${coverage.toFixed(1)}%`);

if (matched.length) {
  const avgEdge = matched.reduce((s, m) => s + m.edgePct, 0) / matched.length;
  const avgMargin = matched.reduce((s, m) => s + m.marginPct, 0) / matched.length;

  console.log(`Avg edge: ${avgEdge.toFixed(2)}%`);
  console.log(`Avg overround: ${avgMargin.toFixed(2)}%`);
}

function printRoi(label, rows) {
  const r = roi(rows.map(x => x.profit));
  console.log(`${label}: bets=${r.bets} profit=${r.profit.toFixed(2)} roi=${r.roiPct.toFixed(2)}%`);
}

console.log('\n=== Flat stake ROI ===');
printRoi('All matched', matched);
printRoi('Edge > 0%', positiveEdge);
printRoi('Edge > 5%', edgeOver5);
printRoi('Model prob >= 0.65', prob65);
printRoi('Model prob >= 0.70', prob70);

console.log('\n=== Sample matched rows ===');
console.log(matched.slice(0, 5));