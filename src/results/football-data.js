// src/results/football-data.js
// ─────────────────────────────────────────────────────────────
// Football-Data.org result fetcher.
// Used as a validator/fallback for settlement — not a replacement
// for The Odds API /scores pipeline.
//
// Coverage (free tier):
//   PL   → england       (Premier League)
//   ELC  → england2      (Championship)
//   BL1  → germany       (Bundesliga)
//   SA   → italy         (Serie A)
//   PD   → spain         (La Liga)
//   FL1  → france        (Ligue 1)
//   DED  → netherlands   (Eredivisie)
//   CL   → cleague       (Champions League)
//   PPL  → portugal      (Liga Portugal)
//   BSA  → brazil        (Brasileirão)
//   BL2  → germany2      (2. Bundesliga)
//   SB   → italy2        (Serie B)
//
// Rate limit: 10 requests/minute on free tier.
// We cache per competition per day to stay well within limits.
// ─────────────────────────────────────────────────────────────

const config = require('../config');

const BASE_URL = 'https://api.football-data.org/v4';

// SoccerSTATS slug → Football-Data competition code
const SLUG_TO_FD_CODE = {
  england:     'PL',
  england2:    'ELC',
  germany:     'BL1',
  germany2:    'BL2',
  italy:       'SA',
  italy2:      'SB',
  spain:       'PD',
  france:      'FL1',
  netherlands: 'DED',
  cleague:     'CL',
  portugal:    'PPL',
  brazil:      'BSA',
};

// In-memory cache: competitionCode → { data: [...matches], fetchedAt: timestamp }
// Keyed by code+date so we re-fetch after midnight
const cache = new Map();
const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours

function getCacheKey(code, dateStr) {
  return `${code}__${dateStr}`;
}

function getTodayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function getDateRange() {
  // Fetch results from 4 days ago through today to catch all recent matches
  const from = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const to   = new Date().toISOString().slice(0, 10);
  return { from, to };
}

/**
 * Fetch finished matches for a competition from Football-Data.org.
 * Returns array of { homeTeam, awayTeam, homeGoals, awayGoals, utcDate }
 * or null if the request fails.
 */
async function fetchResults(competitionCode) {
  const cacheKey = getCacheKey(competitionCode, getTodayUTC());
  const cached = cache.get(cacheKey);
  if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL) {
    return cached.data;
  }

  const token = config.FOOTBALL_DATA_API_KEY;
  if (!token) {
    console.warn('[football-data] FOOTBALL_DATA_API_KEY not configured');
    return null;
  }

  const { from, to } = getDateRange();
  const url = `${BASE_URL}/competitions/${competitionCode}/matches?status=FINISHED&dateFrom=${from}&dateTo=${to}`;

  try {
    const res = await fetch(url, {
      headers: { 'X-Auth-Token': token },
      signal: AbortSignal.timeout(10000),
    });

    if (res.status === 429) {
      console.warn(`[football-data] rate limited for ${competitionCode} — skipping`);
      return null;
    }

    if (!res.ok) {
      console.warn(`[football-data] HTTP ${res.status} for ${competitionCode}`);
      return null;
    }

    const data = await res.json();
    const matches = (data.matches || []).map(m => ({
      homeTeam:   m.homeTeam?.name || '',
      awayTeam:   m.awayTeam?.name || '',
      homeGoals:  m.score?.fullTime?.home ?? null,
      awayGoals:  m.score?.fullTime?.away ?? null,
      utcDate:    m.utcDate || null,
    })).filter(m => m.homeGoals !== null && m.awayGoals !== null);

    console.log(`[football-data] fetched ${matches.length} finished matches for ${competitionCode}`);
    cache.set(cacheKey, { data: matches, fetchedAt: Date.now() });
    return matches;

  } catch (err) {
    console.warn(`[football-data] fetch failed for ${competitionCode}: ${err.message}`);
    return null;
  }
}

/**
 * Look up a specific match result from Football-Data.org.
 * Returns { homeGoals, awayGoals, source: 'football-data' } or null.
 *
 * @param {string} leagueSlug   - SoccerSTATS slug (e.g. 'england')
 * @param {string} homeTeam     - prediction home team name
 * @param {string} awayTeam     - prediction away team name
 * @param {string} commenceTime - ISO string of kickoff time
 */
async function lookupResult(leagueSlug, homeTeam, awayTeam, commenceTime) {
  const code = SLUG_TO_FD_CODE[leagueSlug];
  if (!code) return null; // league not covered

  const matches = await fetchResults(code);
  if (!matches) return null;

  const { teamsMatch } = require('../utils/team-names');

  // Kickoff proximity window: ±36 hours
  const KO_WINDOW_MS = 36 * 60 * 60 * 1000;
  const koMs = commenceTime ? new Date(commenceTime).getTime() : null;

  const found = matches.find(m => {
    if (koMs && m.utcDate) {
      const diff = Math.abs(new Date(m.utcDate).getTime() - koMs);
      if (diff > KO_WINDOW_MS) return false;
    }
    return teamsMatch(m.homeTeam, m.awayTeam, homeTeam, awayTeam);
  });

  if (!found) return null;

  return {
    homeGoals: found.homeGoals,
    awayGoals: found.awayGoals,
    source: 'football-data',
  };
}

/**
 * Returns true if this league has Football-Data.org coverage.
 */
function hasCoverage(leagueSlug) {
  return !!SLUG_TO_FD_CODE[leagueSlug];
}

// Separate cache for rolling results — wider date range, separate TTL
const rollingCache = new Map();
const ROLLING_CACHE_TTL = 4 * 60 * 60 * 1000; // 4 hours
 
/**
 * Fetch the last 56 days of FINISHED matches for a competition.
 * Used by context_raw paper-tracking (rolling last-6 stats per team).
 * This is SEPARATE from fetchResults() which only covers 4 days for settlement.
 *
 * Returns [{ homeTeam, awayTeam, homeGoals, awayGoals, utcDate }] or null.
 * Return format is identical to fetchResults() — callers can treat them
 * the same way.
 *
 * Cache TTL: 4h per competition per calendar day.
 * Rate impact: 2 additional API calls per 6h refresh cycle (England + Germany).
 * Free-tier budget: 10 req/min — no issue.
 *
 * @param {string} competitionCode - FD.org competition code e.g. 'PL', 'BL1'
 */
async function fetchRollingResults(competitionCode) {
  const cacheKey = `rolling__${competitionCode}__${getTodayUTC()}`;
  const cached = rollingCache.get(cacheKey);
  if (cached && (Date.now() - cached.fetchedAt) < ROLLING_CACHE_TTL) {
    return cached.data;
  }
 
  const token = config.FOOTBALL_DATA_API_KEY;
  if (!token) {
    console.warn('[football-data] FOOTBALL_DATA_API_KEY not configured — cannot fetch rolling results');
    return null;
  }
 
  // 56-day lookback: enough for every team to have played at least 6-8 matches
  const from = new Date(Date.now() - 56 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const to   = new Date().toISOString().slice(0, 10);
  const url  = `${BASE_URL}/competitions/${competitionCode}/matches?status=FINISHED&dateFrom=${from}&dateTo=${to}`;
 
  try {
    const resp = await fetch(url, {
      headers: { 'X-Auth-Token': token },
      signal: AbortSignal.timeout(10000),
    });
 
    if (!resp.ok) {
      console.warn(`[football-data] rolling fetch ${competitionCode}: HTTP ${resp.status}`);
      return null;
    }
 
    const raw = await resp.json();
    const matches = (raw.matches || [])
      .filter(m => m.score?.fullTime?.home != null && m.score?.fullTime?.away != null)
      .map(m => ({
        homeTeam:  m.homeTeam.name,
        awayTeam:  m.awayTeam.name,
        homeGoals: m.score.fullTime.home,
        awayGoals: m.score.fullTime.away,
        utcDate:   m.utcDate,
      }));
 
    console.log(`[football-data] rolling: ${matches.length} matches loaded for ${competitionCode} (${from} → ${to})`);
    rollingCache.set(cacheKey, { data: matches, fetchedAt: Date.now() });
    return matches;
 
  } catch (err) {
    console.warn(`[football-data] rolling fetch ${competitionCode}: ${err.message}`);
    return null;
  }
}

module.exports = { lookupResult, hasCoverage, SLUG_TO_FD_CODE, fetchRollingResults };
