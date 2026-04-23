// src/odds/the-odds-api.js
// ─────────────────────────────────────────────────────────────
// Integration with The-Odds-API (the-odds-api.com)
//
// Region: UK only (Bet365, Pinnacle, William Hill, Betfair Exchange etc)
// Markets: totals (Over/Under 2.5) — both sides captured per event
//
// ── Cache strategy ─────────────────────────────────────────
//
// Two-layer cache:
//   1. In-memory: fast lookups during a single refresh cycle
//   2. Disk (data/odds-cache.json): survives container restarts
//
// On startup, disk cache is loaded into memory if entries are
// still within their TTL. A redeploy mid-cycle costs 0 extra
// API calls as long as the data/ volume is mounted (it always is).
//
// Cache TTLs:
//   Sports list:  6 hours (changes rarely)
//   Odds per key: 3 hours (prices move slowly pre-match)
//
// ── Quota management ───────────────────────────────────────
//
// ODDS_DAILY_LIMIT caps calls per UTC day (resets at midnight).
// Daily counter is in-memory only — resets on restart, which is
// acceptable since a restart also resets our call pattern.
//
// ── In-play guard ──────────────────────────────────────────
//
// Events within INPLAY_BUFFER_MINS of kickoff are skipped.
// Prevents corrupt in-game prices from being stored as
// tip-time snapshots.
// ─────────────────────────────────────────────────────────────

const { fetch } = require('undici');
const fs = require('fs');
const path = require('path');
const config = require('../config');

let currentKeyIndex = 0;

// ── In-play buffer ───────────────────────────────────────────
const INPLAY_BUFFER_MINS = 15;

function isInPlay(commenceTime) {
  if (!commenceTime) return false;
  return (new Date(commenceTime) - new Date()) / 60000 < INPLAY_BUFFER_MINS;
}

// ── Known name overrides ─────────────────────────────────────
const KNOWN_NAME_OVERRIDES = {
  'gimnasia': 'gimnasia la plata',
  'e. rio cuarto': 'estudiantes rio cuarto',
  'e rio cuarto': 'estudiantes rio quarto',
  'd. riestra': 'deportivo riestra',
  'd riestra': 'deportivo riestra',
};

// ── Daily quota tracking ─────────────────────────────────────
const quotaTracker = { date: null, calls: 0 };

function getTodayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function incrementQuota() {
  const today = getTodayUTC();
  if (quotaTracker.date !== today) { quotaTracker.date = today; quotaTracker.calls = 0; }
  quotaTracker.calls++;
}

function isQuotaExceeded() {
  const limit = config.ODDS_DAILY_LIMIT;
  if (!limit || limit <= 0) return false;
  if (quotaTracker.date !== getTodayUTC()) return false;
  if (quotaTracker.calls >= limit) {
    console.warn(`[odds-api] ⚠ Daily quota guard: ${quotaTracker.calls}/${limit} calls today. Skipping.`);
    return true;
  }
  return false;
}

// ── Disk cache ───────────────────────────────────────────────
// Persists the in-memory cache to data/odds-cache.json so that
// container restarts don't burn quota re-fetching fresh data.

const CACHE_FILE = path.join(config.DATA_DIR, 'odds-cache.json');

const SPORTS_CACHE_TTL = 6 * 60 * 60 * 1000;  // 6 hours
const ODDS_CACHE_TTL   = 3 * 60 * 60 * 1000;  // 3 hours

// In-memory cache — loaded from disk on startup
const cache = {
  sports: { data: null, timestamp: 0 },
  odds: new Map(),  // cacheKey → { data, timestamp }
};

/**
 * Load disk cache into memory on startup.
 * Only entries still within their TTL are kept.
 */
function loadDiskCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    const now = Date.now();

    if (raw.sports && raw.sports.data && (now - raw.sports.timestamp) < SPORTS_CACHE_TTL) {
      cache.sports = raw.sports;
      console.log(`[odds-api] loaded sports cache from disk (${cache.sports.data.length} competitions, age ${Math.round((now - cache.sports.timestamp) / 60000)}min)`);
    }

    let oddsLoaded = 0;
    for (const [key, entry] of Object.entries(raw.odds || {})) {
      if ((now - entry.timestamp) < ODDS_CACHE_TTL) {
        cache.odds.set(key, entry);
        oddsLoaded++;
      }
    }
    if (oddsLoaded > 0) {
      console.log(`[odds-api] loaded ${oddsLoaded} odds entries from disk cache`);
    }
  } catch (err) {
    console.warn(`[odds-api] could not load disk cache: ${err.message}`);
  }
}

/**
 * Persist current in-memory cache to disk.
 * Called after every successful API fetch.
 */
function saveDiskCache() {
  try {
    if (!fs.existsSync(config.DATA_DIR)) {
      fs.mkdirSync(config.DATA_DIR, { recursive: true });
    }
    const serialisable = {
      savedAt: new Date().toISOString(),
      sports: cache.sports,
      odds: Object.fromEntries(cache.odds),
    };
    fs.writeFileSync(CACHE_FILE, JSON.stringify(serialisable), 'utf8');
  } catch (err) {
    console.warn(`[odds-api] could not save disk cache: ${err.message}`);
  }
}

// Load disk cache immediately on module load
loadDiskCache();

// ── Cache validity ───────────────────────────────────────────

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

async function oddsRequest(path, params = {}) {
  if (isQuotaExceeded()) return null;

  const key = getApiKey();
  if (!key) { console.warn('[odds-api] no API keys configured'); return null; }

  const url = new URL(`https://api.the-odds-api.com${path}`);
  url.searchParams.set('apiKey', key);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  try {
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(15000) });

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

// ── Sports list ──────────────────────────────────────────────

async function fetchAvailableSports() {
  if (isCacheValid(cache.sports, SPORTS_CACHE_TTL)) {
    console.log(`[odds-api] using cached sports list (${cache.sports.data.length} competitions, from ${cache.sports.data === null ? 'none' : 'cache'})`);
    return cache.sports.data;
  }

  console.log('[odds-api] fetching available soccer competitions...');
  const data = await oddsRequest('/v4/sports', { group: 'soccer' });
  if (!data) return cache.sports.data || [];

  const active = data.filter(s => s.active);
  console.log(`[odds-api] ${active.length} active soccer competitions`);
  cache.sports = { data: active, timestamp: Date.now() };
  saveDiskCache();
  return active;
}

// ── League-level odds fetch ──────────────────────────────────

async function fetchOddsForSport(sportKey, markets, regions) {
  const cacheKey = `${sportKey}|${markets}|${regions}`;
  const cached = cache.odds.get(cacheKey);
  if (isCacheValid(cached, ODDS_CACHE_TTL)) {
    const ageMin = Math.round((Date.now() - cached.timestamp) / 60000);
    console.log(`[odds-api] using cached odds for ${sportKey} (${cached.data.length} events, age ${ageMin}min)`);
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
  saveDiskCache();
  return data;
}

// ── Event-level odds fetch ───────────────────────────────────

/**
 * Fetch odds for a single event by Odds API event ID.
 * Used by settler.js for pre-kickoff and closing snapshots.
 * Costs 1 quota credit. Results are NOT cached (point-in-time).
 */
async function fetchEventOdds(sportKey, eventId, markets, regions) {
  if (!eventId) return null;
  console.log(`[odds-api] fetching event odds for ${eventId}...`);
  const data = await oddsRequest(`/v4/sports/${sportKey}/events/${eventId}/odds`, {
    regions: regions || config.ODDS_REGIONS,
    markets: markets || 'totals',
    oddsFormat: 'decimal',
  });
  return data || null;
}

// ── Bettable league map ──────────────────────────────────────

async function buildBettableLeagueMap() {
  const sports = await fetchAvailableSports();
  if (!sports || sports.length === 0) return new Map();
  const map = new Map();
  for (const s of sports) {
    map.set(s.key, { key: s.key, title: s.title, description: s.description || '' });
  }
  return map;
}

// ── Slug → Odds API key mapping ──────────────────────────────

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

// ── Name normalisation ───────────────────────────────────────

function normalise(name) {
  return (name || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\butd\b/g, 'united')
    .replace(/\batl\b/g, 'atletico')
    .replace(/\bath\b/g, 'athletic')
    .replace(/\bborussia\b/g, 'borussia')
    .replace(/\bint\b/g, 'inter')
    .replace(/\bws\b/g, 'western sydney')
    .replace(/\bfc\b/g, '').replace(/\bsc\b/g, '').replace(/\bsv\b/g, '')
    .replace(/\bcf\b/g, '').replace(/\bac\b/g, '').replace(/\bas\b/g, '')
    .replace(/\bsk\b/g, '').replace(/\bfk\b/g, '').replace(/\bif\b/g, '')
    .replace(/\bbk\b/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

function applyOverride(name) {
  const lower = (name || '').toLowerCase().trim();
  return KNOWN_NAME_OVERRIDES[lower] || name;
}

// ── Main shortlist odds fetch ────────────────────────────────

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

  console.log(`[odds-api] fetching odds for ${oddsKeys.length} competitions (UK region)...`);

  const allOddsData = new Map();
  const leagueEventNames = new Map();
  const allowedBookmakers = config.ODDS_BOOKMAKERS || [];

  for (const sportKey of oddsKeys) {
    try {
      const data = await fetchOddsForSport(sportKey, 'totals', config.ODDS_REGIONS);
      if (!data || !Array.isArray(data)) continue;

      const eventNamesInLeague = [];

      for (const event of data) {
        if (isInPlay(event.commence_time)) {
          console.log(`[odds-api] skipping in-play/imminent: ${event.home_team} vs ${event.away_team}`);
          continue;
        }

        const homeNorm = normalise(event.home_team);
        const awayNorm = normalise(event.away_team);
        const eventKey = `${homeNorm}__${awayNorm}`;

        eventNamesInLeague.push(`${event.home_team} vs ${event.away_team}`);

        const odds = {
          eventId: event.id,
          homeTeam: event.home_team,
          awayTeam: event.away_team,
          commenceTime: event.commence_time,
          o25: null,
          u25: null,
        };

        let bestOver  = null;
        let bestUnder = null;

        for (const bm of (event.bookmakers || [])) {
          if (allowedBookmakers.length > 0 && !allowedBookmakers.includes(bm.key.toLowerCase())) {
            continue;
          }
          for (const mkt of (bm.markets || [])) {
            if (mkt.key !== 'totals') continue;
            const over  = (mkt.outcomes || []).find(o => o.name === 'Over'  && o.point === 2.5);
            const under = (mkt.outcomes || []).find(o => o.name === 'Under' && o.point === 2.5);
            if (over  && (!bestOver  || over.price  > bestOver.price))  bestOver  = { price: over.price,  bookmaker: bm.title, bookmakerKey: bm.key };
            if (under && (!bestUnder || under.price > bestUnder.price)) bestUnder = { price: under.price, bookmaker: bm.title, bookmakerKey: bm.key };
          }
        }

        odds.o25 = bestOver;
        odds.u25 = bestUnder;
        allOddsData.set(eventKey, odds);
      }

      leagueEventNames.set(sportKey, eventNamesInLeague);

    } catch (e) {
      console.warn(`[odds-api] failed fetching odds for ${sportKey}:`, e.message);
    }
  }

  // Matching diagnostics — only for pre-kickoff matches
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
      const kickoff = m.commenceTime || (m.odds && m.odds.commenceTime) || null;
      if (kickoff && new Date(kickoff) < new Date()) continue;
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

// ── Match → odds lookup ──────────────────────────────────────

function matchOddsToMatch(match, oddsMap) {
  const homeNorm = normalise(applyOverride(match.homeTeam));
  const awayNorm = normalise(applyOverride(match.awayTeam));

  const exactKey = `${homeNorm}__${awayNorm}`;
  if (oddsMap.has(exactKey)) return oddsMap.get(exactKey);

  for (const [key, odds] of oddsMap) {
    const [oh, oa] = key.split('__');
    if ((oh.includes(homeNorm) || homeNorm.includes(oh)) &&
        (oa.includes(awayNorm) || awayNorm.includes(oa))) {
      return odds;
    }
  }

  const hf = homeNorm.substring(0, 6);
  const af = awayNorm.substring(0, 6);
  if (hf.length >= 4 && af.length >= 4) {
    for (const [key, odds] of oddsMap) {
      const [oh, oa] = key.split('__');
      if (oh.startsWith(hf) && oa.startsWith(af)) return odds;
    }
  }

  return null;
}

module.exports = {
  fetchAvailableSports,
  fetchOddsForSport,
  fetchEventOdds,
  buildBettableLeagueMap,
  isBettableLeague,
  getOddsKey,
  fetchOddsForShortlist,
  matchOddsToMatch,
  normalise,
  SLUG_TO_ODDS_MAP,
};