export function getHistoricalSlice(fixtures, cutoffUtc) {
  return fixtures.filter(f =>
    f.status === 'completed' &&
    new Date(f.kickoffUtc) < new Date(cutoffUtc)
  );
}

export function getTeamMatches(fixtures, teamName, limit = 5) {
  return fixtures
    .filter(f => f.homeTeam === teamName || f.awayTeam === teamName)
    .sort((a, b) => new Date(b.kickoffUtc) - new Date(a.kickoffUtc))
    .slice(0, limit);
}

export function getTeamMetrics(matches, teamName) {
  if (!matches.length) {
    return {
      played: 0,
      o25Pct: null,
      avgTG: null,
      csPct: null,
      ftsPct: null,
      goalsForAvg: null,
      goalsAgainstAvg: null,
    };
  }

  let over25 = 0;
  let totalGoalsSum = 0;
  let cleanSheets = 0;
  let failedToScore = 0;
  let goalsForSum = 0;
  let goalsAgainstSum = 0;

  for (const m of matches) {
    const isHome = m.homeTeam === teamName;
    const gf = isHome ? m.homeGoals : m.awayGoals;
    const ga = isHome ? m.awayGoals : m.homeGoals;
    const tg = (m.homeGoals ?? 0) + (m.awayGoals ?? 0);

    if (tg > 2.5) over25 += 1;
    totalGoalsSum += tg;
    if (ga === 0) cleanSheets += 1;
    if (gf === 0) failedToScore += 1;

    goalsForSum += gf ?? 0;
    goalsAgainstSum += ga ?? 0;
  }

  const played = matches.length;

  return {
    played,
    o25Pct: Math.round((over25 / played) * 100),
    avgTG: Math.round((totalGoalsSum / played) * 100) / 100,
    csPct: Math.round((cleanSheets / played) * 100),
    ftsPct: Math.round((failedToScore / played) * 100),
    goalsForAvg: Math.round((goalsForSum / played) * 100) / 100,
    goalsAgainstAvg: Math.round((goalsAgainstSum / played) * 100) / 100,
  };
}

export function buildFixtureFeatures(fixtures, targetFixture, limit = 5) {
  const hist = getHistoricalSlice(fixtures, targetFixture.kickoffUtc);

  const homeMatches = getTeamMatches(hist, targetFixture.homeTeam, limit);
  const awayMatches = getTeamMatches(hist, targetFixture.awayTeam, limit);

  return {
    home: getTeamMetrics(homeMatches, targetFixture.homeTeam),
    away: getTeamMetrics(awayMatches, targetFixture.awayTeam),
    sampleSizes: {
      home: homeMatches.length,
      away: awayMatches.length,
    },
  };
}