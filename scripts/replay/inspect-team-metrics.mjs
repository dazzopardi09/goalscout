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

function getTeamMetrics(matches, teamName) {
  if (!matches.length) {
    return {
      played: 0,
      o25Pct: null,
      avgTG: null,
      csPct: null,
      ftsPct: null,
    };
  }

  let over25 = 0;
  let totalGoalsSum = 0;
  let cleanSheets = 0;
  let failedToScore = 0;

  for (const m of matches) {
    const isHome = m.homeTeam === teamName;
    const gf = isHome ? m.homeGoals : m.awayGoals;
    const ga = isHome ? m.awayGoals : m.homeGoals;
    const tg = (m.homeGoals ?? 0) + (m.awayGoals ?? 0);

    if (tg > 2.5) over25 += 1;
    totalGoalsSum += tg;
    if (ga === 0) cleanSheets += 1;
    if (gf === 0) failedToScore += 1;
  }

  const played = matches.length;

  return {
    played,
    o25Pct: Math.round((over25 / played) * 100),
    avgTG: Math.round((totalGoalsSum / played) * 100) / 100,
    csPct: Math.round((cleanSheets / played) * 100),
    ftsPct: Math.round((failedToScore / played) * 100),
  };
}

const sample = data.find(
  f => f.homeTeam === 'Aston Villa' &&
       f.awayTeam === 'Sunderland' &&
       f.kickoffUtc === '2026-04-19T13:00:00Z'
);

const hist = getHistoricalSlice(data, sample.kickoffUtc);

const villaMatches = getTeamMatches(hist, 'Aston Villa', 5);
const sunderlandMatches = getTeamMatches(hist, 'Sunderland', 5);

const villaMetrics = getTeamMetrics(villaMatches, 'Aston Villa');
const sunderlandMetrics = getTeamMetrics(sunderlandMatches, 'Sunderland');

console.log('Target:', sample.homeTeam, 'vs', sample.awayTeam);
console.log('\nAston Villa metrics:', villaMetrics);
console.log('Sunderland metrics:', sunderlandMetrics);
