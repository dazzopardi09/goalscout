// src/config.js
// ─────────────────────────────────────────────────────────────
// All tunable constants in one place.
// ─────────────────────────────────────────────────────────────

const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

module.exports = {
  // ── Paths ──────────────────────────────────────────────────
  DATA_DIR,
  DISCOVERED_FILE: path.join(DATA_DIR, 'discovered-matches.json'),
  LEAGUES_FILE:    path.join(DATA_DIR, 'leagues.json'),
  SHORTLIST_FILE:  path.join(DATA_DIR, 'shortlist.json'),
  META_FILE:       path.join(DATA_DIR, 'meta.json'),
  DETAILS_DIR:     path.join(DATA_DIR, 'match-details'),
  ODDS_FILE:       path.join(DATA_DIR, 'odds.json'),

  // ── Historical logging (lean data model) ──────────────
  // These files ACCUMULATE — they are NOT overwritten on refresh.
  // This is the minimum history needed to evaluate model performance.
  HISTORY_DIR:      path.join(DATA_DIR, 'history'),
  PREDICTIONS_FILE: path.join(DATA_DIR, 'history', 'predictions.jsonl'),
  RESULTS_FILE:     path.join(DATA_DIR, 'history', 'results.jsonl'),
  CLOSING_ODDS_FILE: path.join(DATA_DIR, 'history', 'closing-odds.jsonl'),

  // ── SoccerSTATS authentication ─────────────────────────────
  SOCCERSTATS_COOKIE: process.env.SOCCERSTATS_COOKIE || '',

  // ── SoccerSTATS base URL ──────────────────────────────────
  BASE_URL: 'https://www.soccerstats.com',

  // ── Timezone ──────────────────────────────────────────────
  // IANA timezone for display. Melbourne = UTC+10 / UTC+11 DST
  DISPLAY_TIMEZONE: process.env.DISPLAY_TIMEZONE || 'Australia/Melbourne',

  // ── The Odds API ──────────────────────────────────────────
  // Multiple keys supported (comma-separated) for rotation
  ODDS_API_KEYS: (process.env.ODDS_API_KEYS || '').split(',').filter(Boolean),
  // Regions to fetch odds for (au = Australian bookmakers)
  ODDS_REGIONS: process.env.ODDS_REGIONS || 'au',
  // Markets to fetch
  ODDS_MARKETS: 'totals,btts',

  // ── Betfair API (phase 3) ─────────────────────────────────
  BETFAIR_APP_KEY: process.env.BETFAIR_APP_KEY || '',
  BETFAIR_SESSION:  process.env.BETFAIR_SESSION || '',

  // ── Scraping behaviour ────────────────────────────────────
  REQUEST_DELAY_MS: 3000,
  REQUEST_TIMEOUT_MS: 15000,
  USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',

  // ── Refresh schedule ──────────────────────────────────────
  CRON_SCHEDULE: '5 */6 * * *',

  // ── Shortlist scoring thresholds (TIGHTENED) ──────────────
  // 647/968 was way too loose. These thresholds now require
  // BOTH teams to show strong signals, not just one.
  THRESHOLDS: {
    // Minimum individual metric to generate a flag
    O25_FLAG:   55,   // was 50 — raised to filter noise
    BTTS_FLAG:  55,   // was 50
    TG_FLAG:    2.8,  // was 2.5 — need genuinely high-scoring
    PPG_STRONG: 2.0,
    PPG_WEAK:   1.0,

    // Negative flags — made harsher
    FTS_HIGH:   35,   // was 40 — catch more blankers
    CS_HIGH:    35,   // was 40 — catch more defensive teams

    // Minimum games played to trust the stats
    MIN_GP:     5,    // NEW — skip teams with <5 games

    // Minimum composite score for shortlist
    MIN_SCORE:  5,    // was 3 — much tighter

    // Require BOTH sides to contribute
    // A match needs at least 2 points from EACH category
    // or 4+ from one category to qualify
    MIN_SINGLE_CAT: 4,  // NEW — if only one cat strong, need 4+
    MIN_DUAL_CAT:   2,  // NEW — if both cats, need 2+ each
  },

  // ── Server ────────────────────────────────────────────────
  PORT: process.env.PORT || 3030,
};