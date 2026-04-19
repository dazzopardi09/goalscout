// src/engine/shortlist.js
// ─────────────────────────────────────────────────────────────
// Shortlist scoring engine — Directional O2.5 / U2.5
//
// Each match is scored independently in two directions:
//   - O2.5 score: signals that the match will have 3+ goals
//   - U2.5 score: signals that the match will have 2 or fewer goals
//
// The direction with the higher score wins.
// Ties go to O2.5 as the default.
// A match only appears on the shortlist if the WINNING direction
// score meets MIN_SCORE. The same match cannot be both.
//
// ── Threshold design ───────────────────────────────────────
//
// O2.5 negative flags (CS%, FTS%):
//   Threshold 40% — only fires when genuinely very defensive.
//   Using 35% caused overlap with U2.5 positives, which created
//   a double-penalty that sent most matches to U2.5.
//
// U2.5 positive flags (CS%, FTS%):
//   Entry at 35% (moderate signal +1), strong at 45% (+2).
//   This requires real defensive evidence, not just average stats.
//   CS 30% is typical for most Bundesliga/EPL teams — not a signal.
//
// U2.5 negatives (O2.5%, TG):
//   High attacking stats clearly undermine an Under call.
//   O2.5 ≥65% = -2, combined TG ≥4.5 = -1.
// ─────────────────────────────────────────────────────────────

const { THRESHOLDS } = require('../config');

/**
 * Score a single match in both directions.
 */
function scoreMatch(match, leagueStats = {}) {
  const flags = [];
  const h = match.home || {};
  const a = match.away || {};

  // Skip matches with no usable stats
  if (h.o25pct == null && a.o25pct == null &&
      h.csPct == null && a.csPct == null) {
    return {
      score: 0, grade: '-', direction: null,
      flags: ['No stats available'],
      categories: { o25: 0, u25: 0 },
    };
  }

  // Skip teams with too few games (stats unreliable)
  const minGP = THRESHOLDS.MIN_GP || 5;
  if ((h.gp != null && h.gp < minGP) || (a.gp != null && a.gp < minGP)) {
    const lowGP = Math.min(h.gp ?? 99, a.gp ?? 99);
    return {
      score: 0, grade: '-', direction: null,
      flags: [`Too few games (${lowGP} < ${minGP})`],
      categories: { o25: 0, u25: 0 },
    };
  }

  let o25score = 0;
  let u25score = 0;

  // ── O2.5 positive signals ───────────────────────────────
  // High O2.5% → match likely to have 3+ goals

  if (h.o25pct != null) {
    if (h.o25pct >= 75)      { o25score += 3; flags.push(`🔥 Home O2.5 ${h.o25pct}%`); }
    else if (h.o25pct >= 65) { o25score += 2; flags.push(`📈 Home O2.5 ${h.o25pct}%`); }
    else if (h.o25pct >= 55) { o25score += 1; flags.push(`Home O2.5 ${h.o25pct}%`); }
  }

  if (a.o25pct != null) {
    if (a.o25pct >= 75)      { o25score += 3; flags.push(`🔥 Away O2.5 ${a.o25pct}%`); }
    else if (a.o25pct >= 65) { o25score += 2; flags.push(`📈 Away O2.5 ${a.o25pct}%`); }
    else if (a.o25pct >= 55) { o25score += 1; flags.push(`Away O2.5 ${a.o25pct}%`); }
  }

  // Combined TG → high-scoring environment
  if (h.avgTG != null && a.avgTG != null) {
    const combined = h.avgTG + a.avgTG;
    if (combined >= 6.0)      { o25score += 2; flags.push(`🔥 Combined TG ${combined.toFixed(2)}`); }
    else if (combined >= 5.0) { o25score += 1; flags.push(`Combined TG ${combined.toFixed(2)}`); }
  }

  // League context
  if (leagueStats.o25pct != null && leagueStats.o25pct >= 55) {
    o25score += 1; flags.push(`League O2.5 ${leagueStats.o25pct}%`);
  }
  if (leagueStats.avgGoals != null && leagueStats.avgGoals >= 3.0) {
    o25score += 1; flags.push(`League avg goals ${leagueStats.avgGoals}`);
  }

  // PPG mismatch → dominant team likely to run up the score
  if (h.ppg != null && a.ppg != null) {
    if (h.ppg >= THRESHOLDS.PPG_STRONG && a.ppg <= THRESHOLDS.PPG_WEAK) {
      o25score += 1; flags.push(`PPG mismatch: Home ${h.ppg} vs Away ${a.ppg}`);
    } else if (a.ppg >= THRESHOLDS.PPG_STRONG && h.ppg <= THRESHOLDS.PPG_WEAK) {
      o25score += 1; flags.push(`PPG mismatch: Away ${a.ppg} vs Home ${h.ppg}`);
    }
  }

  // ── O2.5 negative signals ───────────────────────────────
  // Threshold raised to 40% (was 35%) to avoid overlap with
  // U2.5 positives. Only genuinely defensive teams penalise Over.

  if (h.csPct != null && h.csPct >= 40) {
    o25score -= 2; flags.push(`⚠ Home CS ${h.csPct}% (very defensive)`);
  }
  if (a.csPct != null && a.csPct >= 40) {
    o25score -= 2; flags.push(`⚠ Away CS ${a.csPct}% (very defensive)`);
  }
  if (h.ftsPct != null && h.ftsPct >= 40) {
    o25score -= 2; flags.push(`⚠ Home FTS ${h.ftsPct}% (often blank)`);
  }
  if (a.ftsPct != null && a.ftsPct >= 40) {
    o25score -= 2; flags.push(`⚠ Away FTS ${a.ftsPct}% (often blank)`);
  }

  // Both teams low win rate → cagey, low-scoring match
  if (h.winPct != null && a.winPct != null && h.winPct <= 25 && a.winPct <= 25) {
    o25score -= 1; flags.push(`⚠ Both teams low W% (${h.winPct}% / ${a.winPct}%)`);
  }

  // ── U2.5 positive signals ───────────────────────────────
  // Requires stronger defensive evidence than before.
  // Entry threshold raised to 35% for CS (30% is average, not a signal).

  if (h.csPct != null) {
    if (h.csPct >= 45)      { u25score += 2; flags.push(`🔒 Home CS ${h.csPct}% (strong defence)`); }
    else if (h.csPct >= 35) { u25score += 1; flags.push(`Home CS ${h.csPct}%`); }
  }
  if (a.csPct != null) {
    if (a.csPct >= 45)      { u25score += 2; flags.push(`🔒 Away CS ${a.csPct}% (strong defence)`); }
    else if (a.csPct >= 35) { u25score += 1; flags.push(`Away CS ${a.csPct}%`); }
  }

  // High FTS → team often fails to score → fewer goals
  if (h.ftsPct != null) {
    if (h.ftsPct >= 45)      { u25score += 2; flags.push(`🔒 Home FTS ${h.ftsPct}% (blanks often)`); }
    else if (h.ftsPct >= 35) { u25score += 1; flags.push(`Home FTS ${h.ftsPct}%`); }
  }
  if (a.ftsPct != null) {
    if (a.ftsPct >= 45)      { u25score += 2; flags.push(`🔒 Away FTS ${a.ftsPct}% (blanks often)`); }
    else if (a.ftsPct >= 35) { u25score += 1; flags.push(`Away FTS ${a.ftsPct}%`); }
  }

  // Low O2.5% for both teams → neither plays in high-scoring games
  if (h.o25pct != null && h.o25pct <= 40) {
    u25score += 1; flags.push(`Low Home O2.5 ${h.o25pct}%`);
  }
  if (a.o25pct != null && a.o25pct <= 40) {
    u25score += 1; flags.push(`Low Away O2.5 ${a.o25pct}%`);
  }

  // Combined TG → genuinely low-scoring environment
  if (h.avgTG != null && a.avgTG != null) {
    const combined = h.avgTG + a.avgTG;
    if (combined <= 2.2) {
      u25score += 2; flags.push(`🔒 Combined TG ${combined.toFixed(2)} (low scoring)`);
    }
  }

  // Defensive league
  if (leagueStats.o25pct != null && leagueStats.o25pct <= 45) {
    u25score += 1; flags.push(`Defensive league O2.5 ${leagueStats.o25pct}%`);
  }

  // ── U2.5 negative signals ───────────────────────────────
  // Strong attacking profile clearly undermines an Under call

  if (h.o25pct != null && h.o25pct >= 65) u25score -= 2;
  if (a.o25pct != null && a.o25pct >= 65) u25score -= 2;
  if (h.avgTG != null && a.avgTG != null && (h.avgTG + a.avgTG) >= 4.5) u25score -= 1;

  // ── Direction decision ──────────────────────────────────
  // Higher score wins. Ties go to O2.5.

  const direction = u25score > o25score ? 'u25' : 'o25';
  const winningScore = direction === 'u25' ? u25score : o25score;

  let grade;
  if (winningScore >= 10)                    grade = 'A+';
  else if (winningScore >= 7)                grade = 'A';
  else if (winningScore >= 5)                grade = 'B';
  else if (winningScore >= THRESHOLDS.MIN_SCORE) grade = 'C';
  else                                       grade = '-';

  return {
    score: winningScore,
    grade,
    direction,
    flags,
    categories: { o25: o25score, u25: u25score },
  };
}

/**
 * Score all matches and return those meeting the shortlist threshold.
 * A match is shortlisted based on its best direction only.
 */
function buildShortlist(matches, leagueStatsMap = {}) {
  const scored = matches.map(m => {
    const leagueStats = leagueStatsMap[m.leagueSlug] || {};
    const result = scoreMatch(m, leagueStats);
    return {
      ...m,
      score:     result.score,
      grade:     result.grade,
      direction: result.direction,
      flags:     result.flags,
      o25score:  result.categories.o25,
      u25score:  result.categories.u25,
    };
  });

  const minScore = THRESHOLDS.MIN_SCORE || 5;

  const shortlisted = scored
    .filter(m => m.score >= minScore && m.direction != null)
    .sort((a, b) => b.score - a.score);

  return { all: scored, shortlisted };
}

module.exports = { scoreMatch, buildShortlist };