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
// ── Quota management ───────────────────────────────────────
// ODDS_DAILY_LIMIT caps total API calls per UTC day.
// Tracked in-memory; resets at UTC midnight or container restart.
//
// ── In-play guard ──────────────────────────────────────────
// Odds are NOT fetched or stored for matches within
// INPLAY_BUFFER_MINS of kickoff (default 15 mins).
// This prevents corrupt in-play prices (e.g. 8.00 mid-game)
// from being stored as tip-time snapshots or skewing edge calcs.
//
// ── Bookmaker filtering ────────────────────────────────────
// ODDS_BOOKMAKERS allowlist controls which books compete for
// best price. Empty = all books eligible.
//
// ── Matching diagnostics ───────────────────────────────────
// When a match fails to find odds, the actual Odds API event
// names for that league are logged so you can identify the
// correct name mapping and add it to KNOWN_NAME_OVERRIDES.
// ─────────────────────────────────────────────────────────────

const { fetch } = require('undici');
const config = require('../config');

let currentKeyIndex = 0;

// ── In-play buffer ───────────────────────────────────────────
// Don't use odds for matches within this many minutes of kickoff.
// Prevents in-play garbage prices from corrupting tip-time data.
const INPLAY_BUFFER_MINS = 15;

function isInPlay(commenceTime) {
  if (!commenceTime) return false;
  const kickoff = new Date(commenceTime);
  const now = new Date();
  const minsToKickoff = (kickoff - now) / 60000;
  return minsToKickoff < INPLAY_BUFFER_MINS;
}

// ── Known name overrides ─────────────────────────────────────
// When The-Odds-API uses a completely different name to SoccerSTATS,
// add the mapping here: SoccerSTATS name (lowercase) → Odds API name (lowercase).
// Applied before normalisation during matching.
// Populate from the "[odds-api] event names in" diagnostic log lines.
const KNOWN_NAME_OVERRIDES = {
  // Argentina — Odds API uses full official names
  'gimnasia':      'gimnasia la plata',
  'e. rio cuarto': 'atletico de rio cuarto',
};

// ── Daily quota tracking ─────────────────────────────────────
const quotaTracker = {
  date: null,
  calls: 0,
};

function getTodayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function incrementQuota() {
  const today = getTodayUTC();
  if (quotaTracker.date !== today) {
    quotaTracker.date = today;
    quotaTracker.calls = 0;
  }
  quotaTracker.calls++;
}

function isQuotaExceeded() {
  const limit = config.ODDS_DAILY_LIMIT;
  if (!limit || limit <= 0) return false;
  const today = getTodayUTC();
  if (quotaTracker.date !== today) return false;
  if (quotaTracker.calls >= limit) {
    console.warn(`[odds-api] ⚠ Daily quota guard: ${quotaTracker.calls}/${limit} calls used today (UTC). Skipping request.`);
    return true;
  }
  return false;
}

// ── In-memory cache ──────────────────────────────────────────
const cache = {
  sports: { data: null, timestamp: 0 },
  odds: new Map(),
};

const SPORTS_CACHE_TTL = 6 * 60 * 60 * 1000;
const ODDS_CACHE_TTL   = 3 * 60 * 60 * 1000;

function isCacheValid(entry, ttl) {
  return entry && entry.data && (Date.now() - entry.timestamp) < ttl;
}

// ── API key rotation ─────────────────────────────────────────

function getApiKey() {
  const keys = config.ODDS_API_KEYS;
  if (!keys || keys.length === 0) return null;
  const key = keys[currentKeyIndex % keys.length];
  currentKeyIndex++;
  return key;
}

/**
 * Make a request to The-Odds-API.
 * Enforces daily quota guard before every live request.
 */
async function oddsRequest(path, params = {}) {
  if (isQuotaExceeded()) return null;

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

    incrementQuota();
    const remaining = res.headers.get('x-requests-remaining');
    const used = res.headers.get('x-requests-used');
    if (remaining) {
      console.log(`[odds-api] quota: ${used} used, ${remaining} remaining (key ...${key.slice(-6)}) | daily: ${quotaTracker.calls}/${config.ODDS_DAILY_LIMIT || '∞'}`);
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
 */
async function fetchAvailableSports() {
  if (isCacheValid(cache.sports, SPORTS_CACHE_TTL)) {
    console.log(`[odds-api] using cached sports list (${cache.sports.data.length} competitions)`);
    return cache.sports.data;
  }

  console.log('[odds-api] fetching available soccer competitions...');
  const data = await oddsRequest('/v4/sports', { group: 'soccer' });
  if (!data) return cache.sports.data || [];

  const active = data.filter(s => s.active);
  console.log(`[odds-api] ${active.length} active soccer competitions with markets`);
  cache.sports = { data: active, timestamp: Date.now() };
  return active;
}

/**
 * Fetch odds for a specific competition.
 */
async function fetchOddsForSport(sportKey, markets, regions) {
  const cacheKey = `${sportKey}|${markets}|${regions}`;
  const cached = cache.odds.get(cacheKey);
  if (isCacheValid(cached, ODDS_CACHE_TTL)) {
    console.log(`[odds-api] using cached odds for ${sportKey} (${cached.data.length} events)`);
    return cached.data;
  }

  console.log(`[odds-api] fetching odds for ${sportKey}...`);
  const data = await oddsRequest(`/v4/sports/${sportKey}/odds`, {
    regions: regions || config.ODDS_REGIONS,
    markets: markets || 'totals',
    oddsFormat: 'decimal',
  });

  if (!data) return cached?.data || [];
  cache.odds.set(cacheKey, { data, timestamp: Date.now() });
  return data;
}

/**
 * Build a mapping of bettable leagues.
 */
async function buildBettableLeagueMap() {
  const sports = await fetchAvailableSports();
  if (!sports || sports.length === 0) return new Map();

  const map = new Map();
  for (const s of sports) {
    map.set(s.key, { key: s.key, title: s.title, description: s.description || '' });
  }
  return map;
}

/**
 * SoccerSTATS slug → Odds-API sport key mapping.
 */
const SLUG_TO_ODDS_MAP = {
  'england':        'soccer_epl',
  'england2':       'soccer_england_efl_cup',
  'germany':        'soccer_germany_bundesliga',
  'germany2':       'soccer_germany_bundesliga2',
  'italy':          'soccer_italy_serie_a',
  'italy2':         'soccer_italy_serie_b',
  'spain':          'soccer_spain_la_liga',
  'spain2':         'soccer_spain_segunda_division',
  'france':         'soccer_france_ligue_one',
  'france2':        'soccer_france_ligue_two',
  'netherlands':    'soccer_netherlands_eredivisie',
  'portugal':       'soccer_portugal_primeira_liga',
  'belgium':        'soccer_belgium_first_div',
  'austria':        'soccer_austria_bundesliga',
  'denmark':        'soccer_denmark_superliga',
  'sweden':         'soccer_sweden_allsvenskan',
  'norway':         'soccer_norway_eliteserien',
  'finland':        'soccer_finland_veikkausliiga',
  'switzerland':    'soccer_switzerland_superleague',
  'turkey':         'soccer_turkey_super_league',
  'greece':         'soccer_greece_super_league',
  'poland':         'soccer_poland_ekstraklasa',
  'czechrepublic':  'soccer_czech_football_league',
  'scotland':       'soccer_spl',
  'australia':      'soccer_australia_aleague',
  'japan':          'soccer_japan_j_league',
  'southkorea':     'soccer_korea_kleague1',
  'brazil':         'soccer_brazil_serie_a',
  'argentina':      'soccer_argentina_primera_division',
  'russia':         'soccer_russia_premier_league',
  'ukraine':        'soccer_ukraine_premier_league',
  'cleague':        'soccer_uefa_champs_league',
  'uefa':           'soccer_uefa_europa_league',
  'uefaconference': 'soccer_uefa_europa_conference_league',
};

function isBettableLeague(slug, activeSportsMap) {
  const oddsKey = SLUG_TO_ODDS_MAP[slug];
  if (!oddsKey) return false;
  return activeSportsMap.has(oddsKey);
}

function getOddsKey(slug) {
  return SLUG_TO_ODDS_MAP[slug] || null;
}

/**
 * Normalise a team name for fuzzy matching.
 */
function normalise(name) {
  return (name || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\butd\b/g, 'united')
    .replace(/\bctiy\b/g, 'city')
    .replace(/\bwed\b/g, 'wednesday')
    .replace(/\batl\b/g, 'atletico')
    .replace(/\bath\b/g, 'athletic')
    .replace(/\bborussia\b/g, 'borussia')
    .replace(/\bint\b/g, 'inter')
    .replace(/\bws\b/g, 'western sydney')
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
 * Apply known name overrides before normalising.
 * Catches cases where Odds API uses a completely different name.
 */
function applyOverride(name) {
  const lower = (name || '').toLowerCase().trim();
  return KNOWN_NAME_OVERRIDES[lower] || name;
}

/**
 * Fetch odds for all shortlisted matches.
 *
 * In-play guard: skips any event within INPLAY_BUFFER_MINS of kickoff.
 * Diagnostic: logs Odds API event names for leagues where matches fail,
 *   so you can update KNOWN_NAME_OVERRIDES with the correct mapping.
 */
async function fetchOddsForShortlist(shortlistedMatches) {
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
  const leagueEventNames = new Map(); // sportKey → ["Home vs Away", ...]
  const allowedBookmakers = config.ODDS_BOOKMAKERS;

  for (const sportKey of oddsKeys) {
    try {
      const data = await fetchOddsForSport(sportKey, 'h2h,totals', config.ODDS_REGIONS);
      if (!data || !Array.isArray(data)) continue;

      const eventNamesInLeague = [];

      for (const event of data) {
        // ── In-play guard ────────────────────────────────
        // Skip events that have started or kick off within INPLAY_BUFFER_MINS.
        // Prevents in-game odds from corrupting tip-time snapshots.
        if (isInPlay(event.commence_time)) {
          console.log(`[odds-api] skipping in-play/imminent: ${event.home_team} vs ${event.away_team}`);
          continue;
        }

        const homeNorm = normalise(event.home_team);
        const awayNorm = normalise(event.away_team);
        const eventKey = `${homeNorm}__${awayNorm}`;

        eventNamesInLeague.push(`${event.home_team} vs ${event.away_team}`);

        const odds = {
          homeTeam: event.home_team,
          awayTeam: event.away_team,
          commenceTime: event.commence_time,
          h2h: null,
          o25: null,
        };

        let bestO25Over = null;
        let bestH2hHome = null;

        for (const bm of (event.bookmakers || [])) {
          if (allowedBookmakers.length > 0 && !allowedBookmakers.includes(bm.key.toLowerCase())) {
            continue;
          }

          for (const mkt of (bm.markets || [])) {
            if (mkt.key === 'totals') {
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

      leagueEventNames.set(sportKey, eventNamesInLeague);

    } catch (e) {
      console.warn(`[odds-api] failed fetching odds for ${sportKey}:`, e.message);
    }
  }

  // ── Matching diagnostic ─────────────────────────────────
  // Pre-check which shortlisted matches will fail, and log the
  // actual Odds API names for that league so KNOWN_NAME_OVERRIDES
  // can be updated with the correct mapping.
  for (const m of shortlistedMatches) {
    const sportKey = m.oddsKey || getOddsKey(m.leagueSlug);
    if (!sportKey) continue;

    const homeNorm = normalise(applyOverride(m.homeTeam));
    const awayNorm = normalise(applyOverride(m.awayTeam));

    let willMatch = allOddsData.has(`${homeNorm}__${awayNorm}`);
    if (!willMatch) {
      for (const [key] of allOddsData) {
        const [oh, oa] = key.split('__');
        if ((oh.includes(homeNorm) || homeNorm.includes(oh)) &&
            (oa.includes(awayNorm) || awayNorm.includes(oa))) {
          willMatch = true;
          break;
        }
      }
    }

    if (!willMatch) {
      // Suppress noise for matches that have already kicked off —
      // the Odds API removes completed events from /odds, so a no-match
      // for a past fixture is expected and not actionable.
      const kickoff = m.commenceTime || (m.odds && m.odds.commenceTime) || null;
      const alreadyStarted = kickoff && new Date(kickoff) < new Date();
      if (alreadyStarted) continue;

      const names = leagueEventNames.get(sportKey) || [];
      console.log(`[odds-api] no match for "${m.homeTeam}" vs "${m.awayTeam}" (${m.leagueSlug})`);
      if (names.length > 0) {
        console.log(`[odds-api] available in ${sportKey}: ${names.join(' | ')}`);
      } else {
        console.log(`[odds-api] no events in ${sportKey} — quota hit or API error`);
      }
    }
  }

  console.log(`[odds-api] got odds for ${allOddsData.size} events`);
  return allOddsData;
}

/**
 * Try to match a shortlisted match to odds data.
 * Applies KNOWN_NAME_OVERRIDES before normalising.
 */
function matchOddsToMatch(match, oddsMap) {
  const homeNorm = normalise(applyOverride(match.homeTeam));
  const awayNorm = normalise(applyOverride(match.awayTeam));

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

  // Strategy 3: First-6-chars prefix match
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