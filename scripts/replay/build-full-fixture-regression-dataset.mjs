import fs from 'fs';
import { buildFixtureFeatures } from './lib/replay-metrics.mjs';

const FIXTURES_FILE = './data/historical/epl_2025_26_fixtures.json';
const OUTPUT_FILE = './data/replay/full-fixture-regression-dataset.json';

const fixtures = JSON.parse(fs.readFileSync(FIXTURES_FILE, 'utf8'));

const completed = fixtures.filter(f => f.status === 'completed');

const rows = [];

for (const fixture of completed) {
  const features = buildFixtureFeatures(fixtures, fixture, 5);

  const homeSample = features?.sampleSizes?.home ?? 0;
  const awaySample = features?.sampleSizes?.away ?? 0;

  // keep same minimum sample discipline as replay
  if (homeSample < 3 || awaySample < 3) continue;

  const totalGoals = (fixture.homeGoals ?? 0) + (fixture.awayGoals ?? 0);

  rows.push({
    fixtureId: fixture.fixtureId,
    kickoffUtc: fixture.kickoffUtc,
    homeTeam: fixture.homeTeam,
    awayTeam: fixture.awayTeam,

    homeO25: features.home.o25Pct,
    awayO25: features.away.o25Pct,

    homeCS: features.home.csPct,
    awayCS: features.away.csPct,

    homeFTS: features.home.ftsPct,
    awayFTS: features.away.ftsPct,

    homeTG: features.home.avgTG,
    awayTG: features.away.avgTG,
    combinedTG: (features.home.avgTG ?? 0) + (features.away.avgTG ?? 0),

    homeAttack: features.home.goalsForAvg,
    homeDefence: features.home.goalsAgainstAvg,
    awayAttack: features.away.goalsForAvg,
    awayDefence: features.away.goalsAgainstAvg,

    homeSample,
    awaySample,

    totalGoals,
    over25: totalGoals > 2.5 ? 1 : 0,
    under25: totalGoals < 2.5 ? 1 : 0
  });
}

fs.writeFileSync(OUTPUT_FILE, JSON.stringify(rows, null, 2));

console.log(`Wrote ${rows.length} rows to ${OUTPUT_FILE}`);