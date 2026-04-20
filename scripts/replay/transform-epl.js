const fs = require('fs');
const path = require('path');

const INPUT = path.resolve(__dirname, '../data/historical/epl_2025_26_raw.json');
const OUTPUT = path.resolve(__dirname, '../data/historical/epl_2025_26_fixtures.json');

function slugify(str) {
  return str
    .toLowerCase()
    .replace(/'/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

// Optional: normalize team names if you want consistency later
const TEAM_MAP = {
  "Spurs": "Tottenham",
  "Man Utd": "Manchester United",
  "Man City": "Manchester City",
  "Nott'm Forest": "Nottingham Forest",
  "Newcastle": "Newcastle United"
};

function normaliseTeam(name) {
  return TEAM_MAP[name] || name;
}

function buildFixtureId(date, home, away) {
  const d = new Date(date);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');

  return `epl_${yyyy}-${mm}-${dd}_${slugify(home)}_${slugify(away)}`;
}

function transform() {
  const raw = JSON.parse(fs.readFileSync(INPUT, 'utf8'));

  const fixtures = raw.map(m => {
    const homeTeam = normaliseTeam(m.HomeTeam);
    const awayTeam = normaliseTeam(m.AwayTeam);

    const homeGoals = m.HomeTeamScore;
    const awayGoals = m.AwayTeamScore;

    const completed = homeGoals !== null && awayGoals !== null;

    return {
      fixtureId: buildFixtureId(m.DateUtc, homeTeam, awayTeam),
      leagueKey: 'epl',
      leagueName: 'England - Premier League',
      season: '2025-26',
      kickoffUtc: m.DateUtc.replace(' ', 'T'),
      homeTeam,
      awayTeam,
      homeGoals,
      awayGoals,
      status: completed ? 'completed' : 'scheduled'
    };
  });

  // sort chronologically (CRITICAL for replay)
  fixtures.sort((a, b) => new Date(a.kickoffUtc) - new Date(b.kickoffUtc));

  fs.writeFileSync(OUTPUT, JSON.stringify(fixtures, null, 2));

  console.log(`Wrote ${fixtures.length} fixtures to ${OUTPUT}`);
}

transform();
