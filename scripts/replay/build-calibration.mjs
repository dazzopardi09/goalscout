import fs from 'fs';

const PREDICTIONS_FILE = './data/replay/replay-predictions.jsonl';
const RESULTS_FILE = './data/replay/replay-results.jsonl';
const OUT_FILE = './data/calibration/league-calibration.json';

function readJsonl(path) {
  if (!fs.existsSync(path)) return [];
  return fs.readFileSync(path, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l));
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

    A -= lr * dA / data.length;
    B -= lr * dB / data.length;

    if (!Number.isFinite(A) || !Number.isFinite(B)) {
      throw new Error('Calibration diverged');
    }
  }

  return { A, B };
}

function main() {
  const predictions = readJsonl(PREDICTIONS_FILE);
  const results = readJsonl(RESULTS_FILE);

  const resultMap = new Map(
    results.map(r => [`${r.leagueKey}|${r.fixtureId}|${r.market}|${r.replayRunId}`, r])
  );

  const byLeague = {};

  for (const p of predictions) {
    if (p.market !== 'over_2.5') continue;
    if (typeof p.modelProbability !== 'number') continue;
    if (p.modelProbability <= 0 || p.modelProbability >= 1) continue;

    const key = `${p.leagueKey}|${p.fixtureId}|${p.market}|${p.replayRunId}`;
    const r = resultMap.get(key);
    if (!r) continue;

    if (!byLeague[p.leagueKey]) byLeague[p.leagueKey] = [];

    byLeague[p.leagueKey].push({
      p: p.modelProbability,
      y: r.status === 'settled_won' ? 1 : 0,
    });
  }

  const output = [];

  for (const [leagueKey, data] of Object.entries(byLeague)) {
    if (data.length < 50) continue;

    const { A, B } = fitPlattScaling(data);

    output.push({
      leagueKey,
      A,
      B,
      sampleSize: data.length,
    });

    console.log(`Calibrated ${leagueKey}: A=${A.toFixed(3)} B=${B.toFixed(3)} n=${data.length}`);
  }

  fs.mkdirSync('./data/calibration', { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));
  console.log(`\nSaved → ${OUT_FILE}`);
}

main();