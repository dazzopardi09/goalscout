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

  // ── Historical logging (lean data model) ──────────────────
  // These files ACCUMULATE — they are NOT overwritten on refresh.
  HISTORY_DIR:      path.join(DATA_DIR, 'history'),
  PREDICTIONS_FILE: path.join(DATA_DIR, 'history', 'predictions.jsonl'),
  RESULTS_FILE:     path.join(DATA_DIR, 'history', 'results.jsonl'),

  // ── SoccerSTATS ───────────────────────────────────────────
  SOCCERSTATS_COOKIE: process.env.SOCCERSTATS_COOKIE || '',
  BASE_URL: 'https://www.soccerstats.com',

  // ── Timezone ──────────────────────────────────────────────
  DISPLAY_TIMEZONE: process.env.DISPLAY_TIMEZONE || 'Australia/Melbourne',

  // ── The Odds API ──────────────────────────────────────────
  ODDS_API_KEYS:  (process.env.ODDS_API_KEYS || '').split(',').filter(Boolean),
  ODDS_REGIONS:   process.env.ODDS_REGIONS || 'au',
  ODDS_MARKETS:   'totals,btts',

  // ── Betfair API (phase 3) ─────────────────────────────────
  BETFAIR_APP_KEY: process.env.BETFAIR_APP_KEY || '',
  BETFAIR_SESSION: process.env.BETFAIR_SESSION || '',

  // ── Scraping ──────────────────────────────────────────────
  REQUEST_DELAY_MS:   3000,
  REQUEST_TIMEOUT_MS: 15000,
  USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',

  // ── Schedules ─────────────────────────────────────────────
  CRON_SCHEDULE:    '5 */6 * * *',   // main refresh — every 6 hours
  PREKICKOFF_CRON:  '*/30 * * * *',  // pre-KO odds — every 30 minutes
  SETTLE_CRON:      '15 */3 * * *',  // settlement check — every 3 hours

  // ── Shortlist scoring thresholds ──────────────────────────
  THRESHOLDS: {
    // Minimum % to generate a flag
    O25_FLAG:   55,
    BTTS_FLAG:  55,
    TG_FLAG:    2.8,
    PPG_STRONG: 2.0,
    PPG_WEAK:   1.0,

    // Negative flag thresholds (harsher)
    FTS_HIGH:   35,
    CS_HIGH:    35,

    // Minimum games played to trust stats
    MIN_GP:     5,

    // Minimum composite score for shortlist
    MIN_SCORE:  5,

    // Category gate
    MIN_SINGLE_CAT: 4,
    MIN_DUAL_CAT:   2,

    // NEW: Minimum model probability for the recommended direction.
    // Matches below this are excluded from the shortlist even if
    // they pass the flag score gate. Removes the 47-56% noise.
    // Set to 0 to disable.
    MIN_PROB: 0.60,
  },

  // ── Server ────────────────────────────────────────────────
  PORT: process.env.PORT || 3030,
};