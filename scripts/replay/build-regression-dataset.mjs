import fs from 'fs';

const PREDICTIONS_FILE = './data/replay/replay-predictions.jsonl';
const RESULTS_FILE = './data/replay/replay-results.jsonl';

function readJsonl(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(JSON.parse);
}

const preds = readJsonl(PREDICTIONS_FILE);
const results = readJsonl(RESULTS_FILE);

const resultMap = new Map(
  results.map(r => [`${r.leagueKey}|${r.fixtureId}|${r.market}|${r.replayRunId}`, r])
);

const rows = [];

for (const p of preds) {
  const key = `${p.leagueKey}|${p.fixtureId}|${p.market}|${p.replayRunId}`;
  const r = resultMap.get(key);
  if (!r) continue;

  rows.push({
    fixtureId: p.fixtureId,
    leagueKey: p.leagueKey,
    direction: p.direction,

    homeO25: p.inputs.homeO25pct,
    awayO25: p.inputs.awayO25pct,

    homeCS: p.inputs.homeCSpct,
    awayCS: p.inputs.awayCSpct,

    homeFTS: p.inputs.homeFTSpct,
    awayFTS: p.inputs.awayFTSpct,

    homeTG: p.inputs.homeAvgTG,
    awayTG: p.inputs.awayAvgTG,

    combinedTG: (p.inputs.homeAvgTG || 0) + (p.inputs.awayAvgTG || 0),

    result: r.status === 'settled_won' ? 1 : 0,
  });
}

fs.writeFileSync(
  './data/replay/regression-dataset.json',
  JSON.stringify(rows, null, 2)
);

console.log(`Wrote ${rows.length} rows`);
