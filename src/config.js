// src/config.js
// ─────────────────────────────────────────────────────────────
// All tunable constants in one place.
// ─────────────────────────────────────────────────────────────

const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

module.exports = {
  // ── Paths ──────────────────────────────────────────────────
  DATA_DIR,
  DISCOVERED_FILE:  path.join(DATA_DIR, 'discovered-matches.json'),
  LEAGUES_FILE:     path.join(DATA_DIR, 'leagues.json'),
  SHORTLIST_FILE:   path.join(DATA_DIR, 'shortlist.json'),
  META_FILE:        path.join(DATA_DIR, 'meta.json'),
  DETAILS_DIR:      path.join(DATA_DIR, 'match-details'),
  ODDS_FILE:        path.join(DATA_DIR, 'odds.json'),

  // ── Historical logging ─────────────────────────────────────
  // Append-only JSONL files — never overwritten on refresh.
  HISTORY_DIR:      path.join(DATA_DIR, 'history'),
  PREDICTIONS_FILE: path.join(DATA_DIR, 'history', 'predictions.jsonl'),
  RESULTS_FILE:     path.join(DATA_DIR, 'history', 'results.jsonl'),
  CLOSING_ODDS_FILE: path.join(DATA_DIR, 'history', 'closing-odds.jsonl'),

  // ── SoccerSTATS ────────────────────────────────────────────
  SOCCERSTATS_COOKIE: process.env.SOCCERSTATS_COOKIE || '',
  BASE_URL: 'https://www.soccerstats.com',

  // ── Timezone ───────────────────────────────────────────────
  DISPLAY_TIMEZONE: process.env.DISPLAY_TIMEZONE || 'Australia/Melbourne',

  // ── The Odds API ───────────────────────────────────────────
  // Multiple keys (comma-separated) rotated round-robin.
  ODDS_API_KEYS: (process.env.ODDS_API_KEYS || '').split(',').filter(Boolean),

  // Region: 'uk' for Bet365, Pinnacle, William Hill, Betfair Exchange etc.
  // AU dropped — doesn't offer EPL O2.5 totals, doubles quota cost.
  ODDS_REGIONS: (process.env.ODDS_REGIONS || 'uk')
    .split(',').map(r => r.trim().toLowerCase()).filter(Boolean).join(','),

  // Optional bookmaker allowlist. Empty = all books eligible (best price wins).
  // Set to comma-separated keys to restrict (e.g. 'bet365,pinnacle').
  ODDS_BOOKMAKERS: (process.env.ODDS_BOOKMAKERS || '')
    .split(',').map(b => b.trim().toLowerCase()).filter(Boolean),

  // Daily call limit across all keys. Resets at UTC midnight.
  // 4 keys × 500/month ≈ 65/day. 40 is comfortable with UK-only.
  ODDS_DAILY_LIMIT: parseInt(process.env.ODDS_DAILY_LIMIT || '40', 10),

  // Markets to fetch (totals = Over/Under, captures both sides)
  ODDS_MARKETS: 'totals',

  // ── Betfair (Phase 3) ──────────────────────────────────────
  BETFAIR_APP_KEY: process.env.BETFAIR_APP_KEY || '',
  BETFAIR_SESSION: process.env.BETFAIR_SESSION || '',

  // ── Scraping ───────────────────────────────────────────────
  REQUEST_DELAY_MS:   3000,
  REQUEST_TIMEOUT_MS: 15000,
  USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',

  // ── Refresh schedule ───────────────────────────────────────
  CRON_SCHEDULE: '5 */6 * * *',

  // ── Shortlist scoring thresholds ──────────────────────────
  //
  // Used by shortlist.js for both O2.5 and U2.5 directional scoring.
  // A match is shortlisted based on its best direction only.
  //
  THRESHOLDS: {
    // ── Shared ──────────────────────────────────────────────
    PPG_STRONG: 2.0,   // PPG threshold for "dominant" team
    PPG_WEAK:   1.0,   // PPG threshold for "weak" team
    MIN_GP:     5,     // Minimum games played to trust stats

    // ── O2.5 signals ────────────────────────────────────────
    // Positive flags use hardcoded thresholds in shortlist.js
    // (75/65/55 for O2.5%; 6.0/5.0 for combined TG; 55% league)

    // Negative flags for O2.5 (defensive teams hurt the Over)
    CS_HIGH:  35,  // CS% above this → strong O2.5 negative signal
    FTS_HIGH: 35,  // FTS% above this → strong O2.5 negative signal

    // ── U2.5 signals ────────────────────────────────────────
    // Positive flags use hardcoded thresholds in shortlist.js
    // (40/30 for CS%; 40 for FTS%; ≤40 for O2.5%; ≤2.2 combined TG)

    // ── Shortlist gate ──────────────────────────────────────
    // A match must reach MIN_SCORE in its winning direction.
    MIN_SCORE: 5,
  },

  // ── Server ─────────────────────────────────────────────────
  PORT: process.env.PORT || 3030,
};
