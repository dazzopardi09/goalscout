import fs from 'fs';
import path from 'path';

const API_KEY = process.env.API_FOOTBALL_KEY;
const BASE_URL = 'https://v3.football.api-sports.io';

if (!API_KEY) {
  throw new Error('Missing API_FOOTBALL_KEY');
}

const SEASON = process.argv[2] || '2024';
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');

const nextYearShort = String(Number(SEASON) + 1).slice(2);
const seasonLabelFile = `${SEASON}_${nextYearShort}`;
const seasonLabelDisplay = `${SEASON}-${nextYearShort}`;

const OUT_FILE = path.join(
  DATA_DIR,
  'historical',
  `a_league_${seasonLabelFile}_fixtures.json`
);

async function apiGet(endpoint, params = {}) {
  const url = new URL(`${BASE_URL}${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  const res = await fetch(url, {
    headers: {
      'x-apisports-key': API_KEY,
    },
  });

  if (!res.ok) {
    throw new Error(`API request failed: ${res.status} ${res.statusText} (${url})`);
  }

  const json = await res.json();

  if (json.errors && Object.keys(json.errors).length) {
    throw new Error(`API errors: ${JSON.stringify(json.errors)}`);
  }

  return json.response;
}

function slugifyTeam(name) {
  return String(name)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '_');
}

function mapStatus(statusShort) {
  if (['FT', 'AET', 'PEN'].includes(statusShort)) return 'completed';
  return 'scheduled';
}

function buildFixtureId(leagueKey, kickoffUtc, homeTeam, awayTeam) {
  const date = kickoffUtc.slice(0, 10);
  return `${leagueKey}_${date}_${slugifyTeam(homeTeam)}_${slugifyTeam(awayTeam)}`;
}

async function resolveALeague() {
  const leagues = await apiGet('/leagues', {
    country: 'Australia',
    season: SEASON,
  });

  const match = leagues.find(l => {
    const name = l.league?.name?.toLowerCase() || '';
    const country = l.country?.name;

    return (
      country === 'Australia' &&
      name.includes('a-league') &&
      !name.includes('women')
    );
  });

  if (!match) {
    throw new Error(`Could not resolve A-League for Australia season ${SEASON}`);
  }

  return {
    leagueId: match.league.id,
    leagueName: `Australia - ${match.league.name}`,
  };
}

async function main() {
  const { leagueId, leagueName } = await resolveALeague();

  const fixtures = await apiGet('/fixtures', {
    league: leagueId,
    season: SEASON,
  });

  const canonical = fixtures.map(f => {
    const kickoffUtc = f.fixture.date;
    const homeTeam = f.teams.home.name;
    const awayTeam = f.teams.away.name;
    const homeGoals = f.goals.home;
    const awayGoals = f.goals.away;

    return {
      fixtureId: buildFixtureId('a_league', kickoffUtc, homeTeam, awayTeam),
      leagueKey: 'a_league',
      leagueName,
      season: seasonLabelDisplay,
      kickoffUtc,
      homeTeam,
      awayTeam,
      homeGoals,
      awayGoals,
      status: mapStatus(f.fixture.status.short),
    };
  }).sort((a, b) => new Date(a.kickoffUtc) - new Date(b.kickoffUtc));

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(canonical, null, 2));

  console.log(`Wrote ${canonical.length} fixtures to ${OUT_FILE}`);
  console.log(`League ID: ${leagueId}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});