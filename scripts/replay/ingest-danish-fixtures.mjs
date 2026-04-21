import fs from 'fs';
import path from 'path';

const API_KEY = process.env.API_FOOTBALL_KEY;
const BASE_URL = 'https://v3.football.api-sports.io';

if (!API_KEY) {
  throw new Error('Missing API_FOOTBALL_KEY');
}

const SEASON = process.argv[2] || '2025';
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const OUT_FILE = path.join(DATA_DIR, 'historical', 'danish_superliga_2024_25_fixtures.json');

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

async function resolveDanishLeague() {
  const leagues = await apiGet('/leagues', {
    country: 'Denmark',
    season: SEASON,
  });

  const match = leagues.find(l => {
    const name = l.league?.name?.toLowerCase() || '';
    const country = l.country?.name;

    return (
      country === 'Denmark' &&
      (name.includes('superliga') || name.includes('superligaen'))
    );
  });

  if (!match) {
    throw new Error(`Could not resolve superliga for Danish season ${SEASON}`);
  }

  return {
    leagueId: match.league.id,
    leagueName: `Denmark - ${match.league.name}`,
  };
}

async function main() {
  const { leagueId, leagueName } = await resolveDanishLeague();

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
      fixtureId: buildFixtureId('danish_superliga', kickoffUtc, homeTeam, awayTeam),
      leagueKey: 'danish_superliga',
      leagueName,
      season: '2024-25',
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