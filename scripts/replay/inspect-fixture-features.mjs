import fs from 'fs';
import { buildFixtureFeatures } from './lib/replay-metrics.mjs';

const data = JSON.parse(
  fs.readFileSync('./data/historical/epl_2025_26_fixtures.json', 'utf8')
);

const target = data.find(
  f => f.homeTeam === 'Aston Villa' &&
       f.awayTeam === 'Sunderland' &&
       f.kickoffUtc === '2026-04-19T13:00:00Z'
);

const features = buildFixtureFeatures(data, target, 5);

console.log('Target:', target.homeTeam, 'vs', target.awayTeam);
console.log(JSON.stringify(features, null, 2));
