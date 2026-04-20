import fs from 'fs';

const data = JSON.parse(
  fs.readFileSync('./data/historical/epl_2025_26_fixtures.json', 'utf8')
);

function getHistoricalSlice(fixtures, cutoffUtc) {
  return fixtures.filter(f =>
    f.status === 'completed' &&
    new Date(f.kickoffUtc) < new Date(cutoffUtc)
  );
}

function getTeamMatches(fixtures, teamName, limit = 5) {
  return fixtures
    .filter(f => f.homeTeam === teamName || f.awayTeam === teamName)
    .sort((a, b) => new Date(b.kickoffUtc) - new Date(a.kickoffUtc))
    .slice(0, limit);
}

const sample = data.find(
  f => f.homeTeam === 'Aston Villa' &&
       f.awayTeam === 'Sunderland' &&
       f.kickoffUtc === '2026-04-19T13:00:00Z'
);

const hist = getHistoricalSlice(data, sample.kickoffUtc);

const villa = getTeamMatches(hist, 'Aston Villa', 5);
const sunderland = getTeamMatches(hist, 'Sunderland', 5);

console.log('Target:', sample.homeTeam, 'vs', sample.awayTeam);
console.log('\nAston Villa last 5:');
console.log(villa);

console.log('\nSunderland last 5:');
console.log(sunderland);
