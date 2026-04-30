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
  // 'btts' removed — the-odds-api.js only parses totals outcomes anyway,
  // so fetching btts was burning quota with no effect. history.js still
  // reads old btts records from predictions.jsonl for backwards compatibility.
  ODDS_MARKETS:   'totals',

  // ── Betfair API (phase 3) ─────────────────────────────────
  BETFAIR_APP_KEY: process.env.BETFAIR_APP_KEY || '',
  BETFAIR_SESSION: process.env.BETFAIR_SESSION || '',

  // ── Scraping ──────────────────────────────────────────────
  REQUEST_DELAY_MS:   3000,
  REQUEST_TIMEOUT_MS: 15000,
  USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',

  // ── Schedules ─────────────────────────────────────────────
  CRON_SCHEDULE:   '5 */6 * * *',
  PREKICKOFF_CRON: '*/30 * * * *',
  SETTLE_CRON:     '15 */3 * * *',
  CLOSE_CAPTURE_CRON: process.env.CLOSE_CAPTURE_CRON || '*/5 * * * *',

  // ── Shortlist scoring thresholds ──────────────────────────
  THRESHOLDS: {
    // Minimum games played to trust stats
    MIN_GP: 5,

    // avgTG floor for single-team TG flag (fallback when combined not available)
    TG_FLAG: 2.8,

    // PPG thresholds for mismatch signal
    PPG_STRONG: 2.0,
    PPG_WEAK:   1.0,

    // Minimum winning-direction score to appear on the shortlist.
    // Score of 4 requires genuine signal — two moderate flags or one strong one.
    // Expect ~6–10 shortlisted matches per cycle at this setting.
    // Raise to 5 for tighter filtering, lower to 3 for broader.
    MIN_WINNING_SCORE: 4,

    // Minimum model probability for the recommended direction.
    // Applied in orchestrator AFTER analysis, not in buildShortlist.
    // O2.5: requires P(O2.5) >= MIN_PROB
    // U2.5: requires 1 - P(O2.5) >= MIN_PROB
    MIN_PROB: 0.60,
  },

  // ── Server ────────────────────────────────────────────────
  PORT: process.env.PORT || 3030,
};