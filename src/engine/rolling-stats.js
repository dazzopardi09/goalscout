// src/engine/rolling-stats.js
// ─────────────────────────────────────────────────────────────
// Computes per-team rolling goal statistics for context_raw.
//
// LEAKAGE RULES (non-negotiable):
//   1. Only matches with date STRICTLY BEFORE the target fixture date.
//   2. The target fixture is never included in its own rolling window.
//   3. Only same-competition matches (guaranteed because the source CSV
//      contains only one league — no cup matches mixed in).
//   4. Ordering is always most-recent-first before slicing to N.
//
// This module is backtest-only.
// Do NOT import from any live scoring/shortlist code.
// ─────────────────────────────────────────────────────────────

const { getTeamMatchesBefore } = require('./historical-data');

const DEFAULT_WINDOW   = 6;
const MIN_GAMES_REQUIRED = 4;  // below this → flag as insufficient_recent_data

/**
 * Compute rolling stats for a single team from their perspective.
 *
 * For each match in the window:
 *   - If the team is home: gf = homeGoals, ga = awayGoals
 *   - If the team is away: gf = awayGoals, ga = homeGoals
 *
 * @param {string}   teamName    Exact name as in the CSV
 * @param {object[]} allMatches  Full season match list from loadMatches()
 * @param {Date}     beforeDate  Target fixture date (strict cutoff)
 * @param {number}   n           Window size (default 6)
 *
 * @returns {object} Feature set — see v1 spec (Section 5 of CONTEXT-RAW-SPEC.md)
 */
function computeRollingStats(teamName, allMatches, beforeDate, n = DEFAULT_WINDOW) {
  // Get all matches for this team strictly before the fixture
  const prior = getTeamMatchesBefore(teamName, allMatches, beforeDate);

  // Sort descending (most recent first), take the last N
  const recent = prior
    .slice()
    .sort((a, b) => b.date - a.date)
    .slice(0, n);

  const games_available = recent.length;

  if (games_available === 0) {
    return emptyStats(teamName, games_available);
  }

  const norm = teamName.toLowerCase().trim();

  // Build per-match breakdown from this team's perspective
  const matchBreakdown = recent.map(m => {
    const isHome = m.homeTeam.toLowerCase().trim() === norm;
    const gf       = isHome ? m.homeGoals : m.awayGoals;
    const ga       = isHome ? m.awayGoals : m.homeGoals;
    const opponent = isHome ? m.awayTeam  : m.homeTeam;

    return {
      date:            m.date,
      dateStr:         m.dateStr,
      opponent,
      venue:           isHome ? 'H' : 'A',
      gf,
      ga,
      // Per-match flags
      fts:             gf === 0,
      scored2plus:     gf >= 2,
      conceded2plus:   ga >= 2,
      o25:             (gf + ga) > 2.5,
      btts:            gf > 0 && ga > 0,
      scoreDisplay:    `${gf}-${ga}`,  // from this team's perspective (GF-GA)
    };
  });

  // Aggregate
  const gf_total = matchBreakdown.reduce((s, m) => s + m.gf, 0);
  const ga_total = matchBreakdown.reduce((s, m) => s + m.ga, 0);

  const fts_count           = matchBreakdown.filter(m => m.fts).length;
  const scored2plus_count   = matchBreakdown.filter(m => m.scored2plus).length;
  const conceded2plus_count = matchBreakdown.filter(m => m.conceded2plus).length;
  const o25_count           = matchBreakdown.filter(m => m.o25).length;
  const btts_count          = matchBreakdown.filter(m => m.btts).length;

  return {
    teamName,
    gf_avg:               round2(gf_total / games_available),
    ga_avg:               round2(ga_total / games_available),
    fts_count,
    scored2plus_count,
    conceded2plus_count,
    o25_count,
    btts_count,           // passive logging — not used in v1 scoring
    games_available,
    insufficient:         games_available < MIN_GAMES_REQUIRED,
    // Full match detail for verification and UI inspection
    matches:              matchBreakdown,
  };
}

/**
 * Compute rolling stats for both teams in a fixture simultaneously.
 * Returns { home, away, combined, skip }.
 *
 * `combined` contains fixture-level derived values used in scoring.
 * `skip` is true if either team has insufficient data.
 *
 * @param {object}   fixture    Match object from loadMatches()
 * @param {object[]} allMatches Full season match list
 * @param {number}   n          Window size (default 6)
 */
function computeFixtureRolling(fixture, allMatches, n = DEFAULT_WINDOW) {
  const home = computeRollingStats(fixture.homeTeam, allMatches, fixture.date, n);
  const away = computeRollingStats(fixture.awayTeam, allMatches, fixture.date, n);

  const skip = home.insufficient || away.insufficient;

  const combined = skip ? { skip: true } : {
    skip:             false,
    combined_gf_avg:  round2(home.gf_avg + away.gf_avg),
    combined_ga_avg:  round2(home.ga_avg + away.ga_avg),
  };

  return { home, away, combined, skip };
}

// ── Helpers ───────────────────────────────────────────────────

function round2(n) {
  return Math.round(n * 100) / 100;
}

function emptyStats(teamName, games_available) {
  return {
    teamName,
    gf_avg:               null,
    ga_avg:               null,
    fts_count:            null,
    scored2plus_count:    null,
    conceded2plus_count:  null,
    o25_count:            null,
    btts_count:           null,
    games_available,
    insufficient:         true,
    matches:              [],
  };
}

module.exports = {
  computeRollingStats,
  computeFixtureRolling,
  DEFAULT_WINDOW,
  MIN_GAMES_REQUIRED,
};
