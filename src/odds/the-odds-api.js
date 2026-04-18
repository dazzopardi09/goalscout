// src/odds/the-odds-api.js
// ─────────────────────────────────────────────────────────────
// Integration with The-Odds-API (the-odds-api.com)
//
// Purpose:
//   1. Discover which soccer leagues have active betting markets
//   2. Fetch O2.5 and BTTS odds for shortlisted matches
//   3. Filter shortlist to only "bettable" matches
//
// API docs: https://the-odds-api.com/liveapi/guides/v4/
//
// Free tier: 500 requests/month per key.
// We rotate across multiple keys to conserve usage.
//
// Key endpoints:
//   GET /v4/sports?group=soccer  → list all soccer competitions
//   GET /v4/sports/{key}/odds    → odds for a specific competition
// ─────────────────────────────────────────────────────────────

const { fetch } = require('undici');
const config = require('../config');

let currentKeyIndex = 0;

// ── In-memory cache to avoid burning API quota ──────────────
// Sports list: refreshed once per 6 hours (changes rarely)
// Odds data: refreshed once per 3 hours (prices move slowly pre-match)
const cache = {
  sports: { data: null, timestamp: 0 },
  odds: new Map(), // sportKey → { data, timestamp }
};

const SPORTS_CACHE_TTL = 6 * 60 * 60 * 1000;  // 6 hours
const ODDS_CACHE_TTL = 3 * 60 * 60 * 1000;    // 3 hours

function isCacheValid(entry, ttl) {
  return entry && entry.data && (Date.now() - entry.timestamp) < ttl;
}

/**
 * Get the next API key (round-robin rotation)
 */
function getApiKey() {
  const keys = config.ODDS_API_KEYS;
  if (!keys || keys.length === 0) return null;
  const key = keys[currentKeyIndex % keys.length];
  currentKeyIndex++;
  return key;
}

/**
 * Make a request to The-Odds-API
 */
async function oddsRequest(path, params = {}) {
  const key = getApiKey();
  if (!key) {
    console.warn('[odds-api] no API keys configured');
    return null;
  }

  const url = new URL(`https://api.the-odds-api.com${path}`);
  url.searchParams.set('apiKey', key);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  try {
    const res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(15000),
    });

    // Log remaining quota
    const remaining = res.headers.get('x-requests-remaining');
    const used = res.headers.get('x-requests-used');
    if (remaining) {
      console.log(`[odds-api] quota: ${used} used, ${remaining} remaining (key ...${key.slice(-6)})`);
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HTTP ${res.status}: ${body.substring(0, 200)}`);
    }

    return await res.json();
  } catch (err) {
    console.error(`[odds-api] request failed: ${err.message}`);
    return null;
  }
}

/**
 * Fetch all available soccer competitions with active markets.
 * Returns array of { key, title, description, active, ... }
 */
async function fetchAvailableSports() {
  // Check cache first
  if (isCacheValid(cache.sports, SPORTS_CACHE_TTL)) {
    console.log(`[odds-api] using cached sports list (${cache.sports.data.length} competitions)`);
    return cache.sports.data;
  }

  console.log('[odds-api] fetching available soccer competitions...');
  const data = await oddsRequest('/v4/sports', { group: 'soccer' });

  if (!data) return cache.sports.data || []; // return stale cache if request fails

  const active = data.filter(s => s.active);
  console.log(`[odds-api] ${active.length} active soccer competitions with markets`);

  cache.sports = { data: active, timestamp: Date.now() };
  return active;
}

/**
 * Fetch odds for a specific competition.
 *
 * @param {string} sportKey - e.g. 'soccer_epl', 'soccer_germany_bundesliga'
 * @param {string} markets - e.g. 'totals,btts' or 'h2h,totals'
 * @param {string} regions - e.g. 'au' for Australian bookmakers
 */
async function fetchOddsForSport(sportKey, markets, regions) {
  // Check cache first
  const cacheKey = `${sportKey}|${markets}|${regions}`;
  const cached = cache.odds.get(cacheKey);
  if (isCacheValid(cached, ODDS_CACHE_TTL)) {
    console.log(`[odds-api] using cached odds for ${sportKey} (${cached.data.length} events)`);
    return cached.data;
  }

  console.log(`[odds-api] fetching odds for ${sportKey}...`);

  const data = await oddsRequest(`/v4/sports/${sportKey}/odds`, {
    regions: regions || config.ODDS_REGIONS || 'au',
    markets: markets || 'totals',
    oddsFormat: 'decimal',
  });

  if (!data) return cached?.data || []; // return stale cache if request fails

  cache.odds.set(cacheKey, { data, timestamp: Date.now() });
  return data;
}

/**
 * Build a mapping of "bettable" leagues — leagues that have
 * active betting markets on The-Odds-API.
 *
 * Returns a Map: oddsApiKey → { key, title, description }
 */
async function buildBettableLeagueMap() {
  const sports = await fetchAvailableSports();
  if (!sports || sports.length === 0) return new Map();

  const map = new Map();
  for (const s of sports) {
    map.set(s.key, {
      key: s.key,
      title: s.title,
      description: s.description || '',
    });
  }

  return map;
}

/**
 * Attempt to match a SoccerSTATS league slug to an Odds-API sport key.
 *
 * SoccerSTATS uses slugs like: england, italy, germany2, spain, france
 * The-Odds-API uses keys like: soccer_epl, soccer_italy_serie_a, soccer_germany_bundesliga
 *
 * This is a fuzzy mapping — we try to match based on country names and division.
 */
const SLUG_TO_ODDS_MAP = {
  // England
  'england':   'soccer_epl',
  'england2':  'soccer_england_efl_cup', // Championship doesn't always have a separate key
  // Germany
  'germany':   'soccer_germany_bundesliga',
  'germany2':  'soccer_germany_bundesliga2',
  // Italy
  'italy':     'soccer_italy_serie_a',
  'italy2':    'soccer_italy_serie_b',
  // Spain
  'spain':     'soccer_spain_la_liga',
  'spain2':    'soccer_spain_segunda_division',
  // France
  'france':    'soccer_france_ligue_one',
  'france2':   'soccer_france_ligue_two',
  // Netherlands
  'netherlands': 'soccer_netherlands_eredivisie',
  // Portugal
  'portugal':  'soccer_portugal_primeira_liga',
  // Belgium
  'belgium':   'soccer_belgium_first_div',
  // Austria
  'austria':   'soccer_austria_bundesliga',
  // Denmark
  'denmark':   'soccer_denmark_superliga',
  // Sweden
  'sweden':    'soccer_sweden_allsvenskan',
  // Norway
  'norway':    'soccer_norway_eliteserien',
  // Finland
  'finland':   'soccer_finland_veikkausliiga',
  // Switzerland
  'switzerland': 'soccer_switzerland_superleague',
  // Turkey
  'turkey':    'soccer_turkey_super_league',
  // Greece
  'greece':    'soccer_greece_super_league',
  // Poland
  'poland':    'soccer_poland_ekstraklasa',
  // Czech Republic
  'czechrepublic': 'soccer_czech_football_league',
  // Scotland
  'scotland':  'soccer_spl',
  // Australia
  'australia': 'soccer_australia_aleague',
  // Japan
  'japan':     'soccer_japan_j_league',
  // South Korea
  'southkorea': 'soccer_korea_kleague1',
  // Brazil
  'brazil':    'soccer_brazil_serie_a',
  // Argentina
  'argentina': 'soccer_argentina_primera_division',
  // Russia
  'russia':    'soccer_russia_premier_league',
  // Ukraine
  'ukraine':   'soccer_ukraine_premier_league',
  // International
  'cleague':   'soccer_uefa_champs_league',
  'uefa':      'soccer_uefa_europa_league',
  'uefaconference': 'soccer_uefa_europa_conference_league',
};

/**
 * Check if a SoccerSTATS league slug has a known Odds-API mapping
 * AND is currently active with betting markets.
 */
function isBettableLeague(slug, activeSportsMap) {
  const oddsKey = SLUG_TO_ODDS_MAP[slug];
  if (!oddsKey) return false;
  return activeSportsMap.has(oddsKey);
}

/**
 * Get the Odds-API sport key for a SoccerSTATS slug
 */
function getOddsKey(slug) {
  return SLUG_TO_ODDS_MAP[slug] || null;
}

/**
 * Fetch odds for all bettable leagues that have shortlisted matches.
 * Returns a Map: matchKey → { o25: {over, under, bookmaker}, btts: {yes, no, bookmaker}, h2h: {...} }
 *
 * matchKey is "HomeTeam vs AwayTeam" normalised for fuzzy matching.
 *
 * We fetch h2h and totals markets. BTTS may not be available on AU region.
 * totals gives Over/Under with point (e.g. 2.5).
 */
async function fetchOddsForShortlist(shortlistedMatches) {
  // Group matches by their odds API sport key
  const byOddsKey = {};
  for (const m of shortlistedMatches) {
    const ok = m.oddsKey || getOddsKey(m.leagueSlug);
    if (ok) {
      if (!byOddsKey[ok]) byOddsKey[ok] = [];
      byOddsKey[ok].push(m);
    }
  }

  const oddsKeys = Object.keys(byOddsKey);
  if (oddsKeys.length === 0) {
    console.log('[odds-api] no odds keys for shortlisted matches');
    return new Map();
  }

  console.log(`[odds-api] fetching odds for ${oddsKeys.length} competitions...`);

  const allOddsData = new Map();

  for (const sportKey of oddsKeys) {
    try {
      // Fetch h2h and totals — use au,uk regions for broader coverage
      const data = await fetchOddsForSport(sportKey, 'h2h,totals', 'au,uk');
      if (!data || !Array.isArray(data)) continue;

      for (const event of data) {
        const homeNorm = normalise(event.home_team);
        const awayNorm = normalise(event.away_team);
        const eventKey = `${homeNorm}__${awayNorm}`;

        const odds = { 
          homeTeam: event.home_team,
          awayTeam: event.away_team,
          commenceTime: event.commence_time,
          h2h: null,
          o25: null,
        };

        // Find best O2.5 Over odds and best h2h across all bookmakers
        let bestO25Over = null;
        let bestH2hHome = null;

        for (const bm of (event.bookmakers || [])) {
          for (const mkt of (bm.markets || [])) {
            if (mkt.key === 'totals') {
              // Find the Over 2.5 outcome
              const over = (mkt.outcomes || []).find(o => 
                o.name === 'Over' && o.point === 2.5
              );
              if (over && (!bestO25Over || over.price > bestO25Over.price)) {
                bestO25Over = {
                  price: over.price,
                  bookmaker: bm.title,
                  bookmakerKey: bm.key,
                };
              }
            }

            if (mkt.key === 'h2h') {
              const home = (mkt.outcomes || []).find(o => o.name === event.home_team);
              if (home && (!bestH2hHome || home.price > bestH2hHome.price)) {
                bestH2hHome = {
                  price: home.price,
                  bookmaker: bm.title,
                  bookmakerKey: bm.key,
                };
              }
            }
          }
        }

        odds.o25 = bestO25Over;
        odds.h2h = bestH2hHome;

        allOddsData.set(eventKey, odds);
      }
    } catch (e) {
      console.warn(`[odds-api] failed fetching odds for ${sportKey}:`, e.message);
    }
  }

  console.log(`[odds-api] got odds for ${allOddsData.size} events`);
  return allOddsData;
}

/**
 * Normalise a team name for fuzzy matching between SoccerSTATS and Odds API.
 * Expands common abbreviations, strips suffixes, lowercases, removes accents.
 */
function normalise(name) {
  return (name || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    // Expand common abbreviations BEFORE stripping
    .replace(/\butd\b/g, 'united')
    .replace(/\bctiy\b/g, 'city')  // common typo
    .replace(/\bwed\b/g, 'wednesday')
    .replace(/\balbion\b/g, 'albion')
    .replace(/\batl\b/g, 'atletico')
    .replace(/\bath\b/g, 'athletic')
    .replace(/\bspt?\b/g, 'sport')
    .replace(/\bsporting\b/g, 'sporting')
    .replace(/\bborussia\b/g, 'borussia')
    .replace(/\bint\b/g, 'inter')
    .replace(/\bws\b/g, 'western sydney')
    // Strip common suffixes/prefixes
    .replace(/\bfc\b/g, '')
    .replace(/\bsc\b/g, '')
    .replace(/\bsv\b/g, '')
    .replace(/\bcf\b/g, '')
    .replace(/\bac\b/g, '')
    .replace(/\bas\b/g, '')
    .replace(/\bsk\b/g, '')
    .replace(/\bfk\b/g, '')
    .replace(/\bif\b/g, '')
    .replace(/\bbk\b/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

/**
 * Try to match a shortlisted match to odds data.
 * Uses multiple matching strategies.
 */
function matchOddsToMatch(match, oddsMap) {
  const homeNorm = normalise(match.homeTeam);
  const awayNorm = normalise(match.awayTeam);

  // Strategy 1: Exact normalised key
  const exactKey = `${homeNorm}__${awayNorm}`;
  if (oddsMap.has(exactKey)) return oddsMap.get(exactKey);

  // Strategy 2: Partial/substring match
  for (const [key, odds] of oddsMap) {
    const [oh, oa] = key.split('__');
    if ((oh.includes(homeNorm) || homeNorm.includes(oh)) &&
        (oa.includes(awayNorm) || awayNorm.includes(oa))) {
      return odds;
    }
  }

  // Strategy 3: First-word match (e.g. "Newcastle" matches "Newcastle United")
  const homeFirst = homeNorm.substring(0, Math.min(homeNorm.length, 6));
  const awayFirst = awayNorm.substring(0, Math.min(awayNorm.length, 6));

  if (homeFirst.length >= 4 && awayFirst.length >= 4) {
    for (const [key, odds] of oddsMap) {
      const [oh, oa] = key.split('__');
      if (oh.startsWith(homeFirst) && oa.startsWith(awayFirst)) {
        return odds;
      }
    }
  }

  return null;
}

module.exports = {
  fetchAvailableSports,
  fetchOddsForSport,
  buildBettableLeagueMap,
  isBettableLeague,
  getOddsKey,
  fetchOddsForShortlist,
  matchOddsToMatch,
  normalise,
  SLUG_TO_ODDS_MAP,
};