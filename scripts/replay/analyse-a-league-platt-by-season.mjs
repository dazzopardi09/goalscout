import fs from 'fs';

const PREDICTIONS_FILE = './data/replay/replay-predictions.jsonl';
const RESULTS_FILE = './data/replay/replay-results.jsonl';

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

    if (!Number.isFinite(A) || !Number.isFinite(B)) {
      throw new Error('Calibration diverged');
    }
  }

  return { A, B };
}

function inferSeason(predictionDate) {
  const year = Number(String(predictionDate).slice(0, 4));
  const month = Number(String(predictionDate).slice(5, 7));
  // A-League season rolls across years; Jul-Dec belongs to current-start year, Jan-Jun belongs to previous-start year
  const startYear = month >= 7 ? year : year - 1;
  const nextShort = String(startYear + 1).slice(2);
  return `${startYear}-${nextShort}`;
}

const predictions = readJsonl(PREDICTIONS_FILE)
  .filter(p => p.leagueKey === 'a_league')
  .filter(p => p.market === 'over_2.5')
  .filter(p => typeof p.rawModelProbability === 'number')
  .filter(p => p.rawModelProbability > 0 && p.rawModelProbability < 1);

const results = readJsonl(RESULTS_FILE);

const resultMap = new Map(
  results.map(r => [`${r.leagueKey}|${r.fixtureId}|${r.market}|${r.replayRunId}`, r])
);

const bySeason = {};

for (const p of predictions) {
  const key = `${p.leagueKey}|${p.fixtureId}|${p.market}|${p.replayRunId}`;
  const r = resultMap.get(key);
  if (!r) continue;

  const season = inferSeason(p.predictionDate);
  if (!bySeason[season]) bySeason[season] = [];

  bySeason[season].push({
    p: p.rawModelProbability,
    y: r.status === 'settled_won' ? 1 : 0,
  });
}

console.log('\n=== A-League Platt scaling by season ===');

for (const season of Object.keys(bySeason).sort()) {
  const rows = bySeason[season];
  if (rows.length < 20) {
    console.log(`${season}: skipped (n=${rows.length})`);
    continue;
  }

  const { A, B } = fitPlattScaling(rows);
  console.log(
    `${season}: A=${A.toFixed(3)} B=${B.toFixed(3)} n=${rows.length}`
  );
}