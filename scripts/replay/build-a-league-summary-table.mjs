import fs from 'fs';

const PREDICTIONS_FILE = './data/replay/replay-predictions.jsonl';
const RESULTS_FILE = './data/replay/replay-results.jsonl';
const ODDS_FILE = './data/a_league_odds.json';

function readJsonl(path) {
  if (!fs.existsSync(path)) return [];
  return fs.readFileSync(path, 'utf8')
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean)
    .map(JSON.parse);
}

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

function logit(p) {
  const eps = 1e-6;
  const pp = Math.min(Math.max(p, eps), 1 - eps);
  return Math.log(pp / (1 - pp));
}

function fitPlattScaling(data) {
  let A = 1.0;
  let B = 0.0;
  const lr = 0.01;

  for (let iter = 0; iter < 5000; iter++) {
    let dA = 0;
    let dB = 0;

    for (const { p, y } of data) {
      const x = logit(p);
      const pred = sigmoid(A * x + B);
      const error = pred - y;
      dA += error * x;
      dB += error;
    }

    A -= (lr * dA) / data.length;
    B -= (lr * dB) / data.length;
  }

  return { A, B };
}

function inferSeason(date) {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const startYear = month >= 7 ? year : year - 1;
  const nextShort = String(startYear + 1).slice(2);
  return `${startYear}-${nextShort}`;
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

function devigProb(overOdds, underOdds) {
  const invOver = 1 / overOdds;
  const invUnder = 1 / underOdds;
  const sum = invOver + invUnder;
  return invOver / sum;
}

function run() {
  const predictions = readJsonl(PREDICTIONS_FILE)
    .filter(p => p.leagueKey === 'a_league')
    .filter(p => p.market === 'over_2.5');

  const results = readJsonl(RESULTS_FILE);
  const oddsRows = JSON.parse(fs.readFileSync(ODDS_FILE, 'utf8'));

  const resultMap = new Map(
    results.map(r => [`${r.leagueKey}|${r.fixtureId}|${r.market}|${r.replayRunId}`, r])
  );

  const oddsMap = new Map();
  for (const row of oddsRows) {
    if (!row.Date || !row['Home Team'] || !row['Away Team']) continue;
    if (!row['O. 2.5 Close'] || !row['U. 2.5 Close']) continue;
    oddsMap.set(buildOddsKey(row), row);
  }

  const rows = [];

  for (const p of predictions) {
    const resultKey = `${p.leagueKey}|${p.fixtureId}|${p.market}|${p.replayRunId}`;
    const r = resultMap.get(resultKey);
    if (!r) continue;

    const oddsKey = [
      p.predictionDate,
      normaliseTeam(p.homeTeam),
      normaliseTeam(p.awayTeam),
    ].join('|');

    const row = oddsMap.get(oddsKey);
    if (!row) continue;

    const overOdds = Number(row['O. 2.5 Close']);
    const underOdds = Number(row['U. 2.5 Close']);
    if (!Number.isFinite(overOdds) || !Number.isFinite(underOdds)) continue;

    const marketProb = devigProb(overOdds, underOdds);
    const edge = (p.modelProbability / marketProb - 1) * 100;

    rows.push({
      season: inferSeason(p.predictionDate),
      rawProb: p.rawModelProbability,
      modelProb: p.modelProbability,
      won: r.status === 'settled_won',
      edge,
      profit: r.status === 'settled_won' ? (overOdds - 1) : -1,
    });
  }

  const bySeason = {};
  for (const row of rows) {
    if (!bySeason[row.season]) bySeason[row.season] = [];
    bySeason[row.season].push(row);
  }

  const output = [];

  for (const season of Object.keys(bySeason).sort()) {
    const data = bySeason[season];

    const plattData = data
      .filter(d => typeof d.rawProb === 'number' && d.rawProb > 0 && d.rawProb < 1)
      .map(d => ({ p: d.rawProb, y: d.won ? 1 : 0 }));

    const { A } = fitPlattScaling(plattData);

    const allProfit = data.reduce((s, d) => s + d.profit, 0);
    const edge5Rows = data.filter(d => d.edge > 5);
    const edge5Profit = edge5Rows.reduce((s, d) => s + d.profit, 0);

    output.push({
      season,
      A: Number(A.toFixed(3)),
      bets: data.length,
      roi_all: Number(((allProfit / data.length) * 100).toFixed(2)),
      roi_edge5: edge5Rows.length
        ? Number(((edge5Profit / edge5Rows.length) * 100).toFixed(2))
        : 0,
      bets_edge5: edge5Rows.length,
    });
  }

  console.log('\n=== A-League Summary ===\n');
  console.table(output);
}

run();