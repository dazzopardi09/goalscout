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

  // ── Historical logging ────────────────────────────────────
  HISTORY_DIR:          path.join(DATA_DIR, 'history'),
  PREDICTIONS_FILE:     path.join(DATA_DIR, 'history', 'predictions.jsonl'),
  RESULTS_FILE:         path.join(DATA_DIR, 'history', 'results.jsonl'),
  CONFLICTS_FILE:       path.join(DATA_DIR, 'history', 'settlement-conflicts.jsonl'),
  SUSPICIOUS_ROWS_FILE: path.join(DATA_DIR, 'history', 'suspicious-rows.jsonl'),

  // ── SoccerSTATS ───────────────────────────────────────────
  SOCCERSTATS_COOKIE: process.env.SOCCERSTATS_COOKIE || '',
  BASE_URL: 'https://www.soccerstats.com',

  // ── Timezone ──────────────────────────────────────────────
  DISPLAY_TIMEZONE: process.env.DISPLAY_TIMEZONE || 'Australia/Melbourne',

  // ── The Odds API ──────────────────────────────────────────
  ODDS_API_KEYS:  (process.env.ODDS_API_KEYS || '').split(',').filter(Boolean),
  ODDS_REGIONS:   process.env.ODDS_REGIONS || 'au',
  ODDS_MARKETS:   'totals',

  // ── Football-Data.org ─────────────────────────────────────
  // Used as a result validator/fallback alongside The Odds API /scores.
  // Free tier covers: EPL, Championship, Bundesliga, 2.Bundesliga, Serie A,
  // Serie B, La Liga, Ligue 1, Eredivisie, Champions League, Liga Portugal, Brasileirão.
  FOOTBALL_DATA_API_KEY: process.env.FOOTBALL_DATA_API_KEY || '',

  // ── Betfair API (phase 3) ─────────────────────────────────
  BETFAIR_APP_KEY: process.env.BETFAIR_APP_KEY || '',
  BETFAIR_SESSION: process.env.BETFAIR_SESSION || '',

  // ── Scraping ──────────────────────────────────────────────
  REQUEST_DELAY_MS:   3000,
  REQUEST_TIMEOUT_MS: 15000,
  USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',

  // ── Schedules ─────────────────────────────────────────────
  CRON_SCHEDULE:       '5 */6 * * *',
  PREKICKOFF_CRON:     '*/30 * * * *',
  CLOSE_CAPTURE_CRON:  process.env.CLOSE_CAPTURE_CRON || '*/5 * * * *',
  SETTLE_CRON:         '15 */3 * * *',

  // ── Shortlist scoring thresholds ──────────────────────────
  THRESHOLDS: {
    MIN_GP:           5,
    TG_FLAG:          2.8,
    PPG_STRONG:       2.0,
    PPG_WEAK:         1.0,
    MIN_WINNING_SCORE: 4,
    MIN_PROB:         0.60,
  },

  // ── Server ────────────────────────────────────────────────
  PORT: process.env.PORT || 3030,
};
