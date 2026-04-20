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

const sample = data.find(f => f.status === 'scheduled');
const hist = getHistoricalSlice(data, sample.kickoffUtc);

console.log('Target match:', sample.homeTeam, 'vs', sample.awayTeam);
console.log('Kickoff:', sample.kickoffUtc);
console.log('Historical matches available:', hist.length);