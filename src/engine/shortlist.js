// src/engine/shortlist.js
// ─────────────────────────────────────────────────────────────
// Shortlist scoring engine — TIGHTENED v2
//
// Changes from v1:
//   - Raised all flag thresholds (55% not 50%)
//   - Minimum 5 games played or stats are untrusted
//   - Harsher negative flags (FTS/CS at 35% not 40%)
//   - Dual-category gate: need BOTH O2.5 and BTTS signals,
//     or 4+ in a single category, to make the shortlist
//   - MIN_SCORE raised to 5 (was 3)
//   - Negative flags now penalise harder (-2 not -1)
//
// Scoring philosophy (from research):
//   - Both teams must be attacking AND leaky for BTTS
//   - "Mirror rule": BTTS needs similar attacking profiles
//   - FTS >30% or CS >35% are strong BTTS-No signals
//   - High TG only matters if both sides contribute
// ─────────────────────────────────────────────────────────────

const { THRESHOLDS } = require('../config');

function scoreMatch(match, leagueStats = {}) {
  const flags = [];
  const h = match.home || {};
  const a = match.away || {};

  // Skip matches with no stats at all
  if (h.o25pct == null && h.btsPct == null && a.o25pct == null && a.btsPct == null) {
    return { score: 0, grade: '-', flags: ['No stats available'], categories: { o25: 0, btts: 0 } };
  }

  // Skip teams with too few games (stats unreliable)
  const minGP = THRESHOLDS.MIN_GP || 5;
  if ((h.gp != null && h.gp < minGP) || (a.gp != null && a.gp < minGP)) {
    const lowGP = Math.min(h.gp || 0, a.gp || 0);
    return { score: 0, grade: '-', flags: [`Too few games (${lowGP} < ${minGP})`], categories: { o25: 0, btts: 0 } };
  }

  let o25score = 0;
  let bttsScore = 0;

  // ── O2.5 flags ──────────────────────────────────────────
  // Require genuinely high percentages. 50% is a coin flip.

  if (h.o25pct != null) {
    if (h.o25pct >= 75) {
      o25score += 3;
      flags.push(`🔥 Home O2.5 ${h.o25pct}%`);
    } else if (h.o25pct >= 65) {
      o25score += 2;
      flags.push(`📈 Home O2.5 ${h.o25pct}%`);
    } else if (h.o25pct >= 55) {
      o25score += 1;
      flags.push(`Home O2.5 ${h.o25pct}%`);
    }
  }

  if (a.o25pct != null) {
    if (a.o25pct >= 75) {
      o25score += 3;
      flags.push(`🔥 Away O2.5 ${a.o25pct}%`);
    } else if (a.o25pct >= 65) {
      o25score += 2;
      flags.push(`📈 Away O2.5 ${a.o25pct}%`);
    } else if (a.o25pct >= 55) {
      o25score += 1;
      flags.push(`Away O2.5 ${a.o25pct}%`);
    }
  }

  // Both teams need to be in goal-heavy matches
  if (h.avgTG != null && a.avgTG != null) {
    const combined = h.avgTG + a.avgTG;
    if (combined >= 6.0) {
      o25score += 2;
      flags.push(`🔥 Combined TG ${combined.toFixed(2)}`);
    } else if (combined >= 5.0) {
      o25score += 1;
      flags.push(`Combined TG ${combined.toFixed(2)}`);
    }
  } else {
    // Single team high TG
    if (h.avgTG != null && h.avgTG >= 2.8) {
      o25score += 1;
      flags.push(`Home avg TG ${h.avgTG}`);
    }
    if (a.avgTG != null && a.avgTG >= 2.8) {
      o25score += 1;
      flags.push(`Away avg TG ${a.avgTG}`);
    }
  }

  // ── BTTS flags ──────────────────────────────────────────
  // "Mirror rule": BTTS needs BOTH teams scoring regularly

  if (h.btsPct != null) {
    if (h.btsPct >= 75) {
      bttsScore += 3;
      flags.push(`🔥 Home BTTS ${h.btsPct}%`);
    } else if (h.btsPct >= 65) {
      bttsScore += 2;
      flags.push(`📈 Home BTTS ${h.btsPct}%`);
    } else if (h.btsPct >= 55) {
      bttsScore += 1;
      flags.push(`Home BTTS ${h.btsPct}%`);
    }
  }

  if (a.btsPct != null) {
    if (a.btsPct >= 75) {
      bttsScore += 3;
      flags.push(`🔥 Away BTTS ${a.btsPct}%`);
    } else if (a.btsPct >= 65) {
      bttsScore += 2;
      flags.push(`📈 Away BTTS ${a.btsPct}%`);
    } else if (a.btsPct >= 55) {
      bttsScore += 1;
      flags.push(`Away BTTS ${a.btsPct}%`);
    }
  }

  // ── League context (only strong leagues) ────────────────

  if (leagueStats.o25pct != null && leagueStats.o25pct >= 55) {
    o25score += 1;
    flags.push(`League O2.5 ${leagueStats.o25pct}%`);
  }

  if (leagueStats.btsPct != null && leagueStats.btsPct >= 55) {
    bttsScore += 1;
    flags.push(`League BTTS ${leagueStats.btsPct}%`);
  }

  if (leagueStats.avgGoals != null && leagueStats.avgGoals >= 3.0) {
    o25score += 1;
    flags.push(`League avg goals ${leagueStats.avgGoals}`);
  }

  // ── PPG mismatch — goals context ────────────────────────

  if (h.ppg != null && a.ppg != null) {
    if (h.ppg >= THRESHOLDS.PPG_STRONG && a.ppg <= THRESHOLDS.PPG_WEAK) {
      o25score += 1;
      flags.push(`PPG mismatch: Home ${h.ppg} vs Away ${a.ppg}`);
    } else if (a.ppg >= THRESHOLDS.PPG_STRONG && h.ppg <= THRESHOLDS.PPG_WEAK) {
      o25score += 1;
      flags.push(`PPG mismatch: Away ${a.ppg} vs Home ${h.ppg}`);
    }
  }

  // ── Negative flags (harsher) ────────────────────────────
  // These are strong BTTS-No and Under signals.
  // -2 penalty makes them properly punishing.

  if (h.ftsPct != null && h.ftsPct >= THRESHOLDS.FTS_HIGH) {
    bttsScore -= 2;
    flags.push(`⚠ Home FTS ${h.ftsPct}% (often blank)`);
  }

  if (a.ftsPct != null && a.ftsPct >= THRESHOLDS.FTS_HIGH) {
    bttsScore -= 2;
    flags.push(`⚠ Away FTS ${a.ftsPct}% (often blank)`);
  }

  if (h.csPct != null && h.csPct >= THRESHOLDS.CS_HIGH) {
    bttsScore -= 2;
    o25score -= 1;
    flags.push(`⚠ Home CS ${h.csPct}% (defensive)`);
  }

  if (a.csPct != null && a.csPct >= THRESHOLDS.CS_HIGH) {
    bttsScore -= 2;
    o25score -= 1;
    flags.push(`⚠ Away CS ${a.csPct}% (defensive)`);
  }

  // ── Low win rate for both = cagey match ─────────────────
  if (h.winPct != null && a.winPct != null && h.winPct <= 25 && a.winPct <= 25) {
    o25score -= 1;
    bttsScore -= 1;
    flags.push(`⚠ Both teams low W% (${h.winPct}% / ${a.winPct}%)`);
  }

  // ── Composite score ─────────────────────────────────────

  const score = o25score + bttsScore;

  // Grade bands (raised)
  let grade;
  if (score >= 10) grade = 'A+';
  else if (score >= 7) grade = 'A';
  else if (score >= 5) grade = 'B';
  else if (score >= THRESHOLDS.MIN_SCORE) grade = 'C';
  else grade = '-';

  return {
    score,
    grade,
    flags,
    categories: {
      o25: o25score,
      btts: bttsScore,
    },
  };
}

/**
 * Score all matches and return only those meeting the tightened shortlist.
 *
 * Gate logic:
 *   score >= MIN_SCORE AND (
 *     o25score >= MIN_SINGLE_CAT OR
 *     bttsScore >= MIN_SINGLE_CAT OR
 *     (o25score >= MIN_DUAL_CAT AND bttsScore >= MIN_DUAL_CAT)
 *   )
 *
 * This prevents matches that squeak through on scattered weak signals.
 */
function buildShortlist(matches, leagueStatsMap = {}) {
  const scored = matches.map(m => {
    const leagueStats = leagueStatsMap[m.leagueSlug] || {};
    const result = scoreMatch(m, leagueStats);
    return {
      ...m,
      score: result.score,
      grade: result.grade,
      flags: result.flags,
      o25score: result.categories.o25,
      bttsScore: result.categories.btts,
    };
  });

  const minScore = THRESHOLDS.MIN_SCORE || 5;
  const minSingle = THRESHOLDS.MIN_SINGLE_CAT || 4;
  const minDual = THRESHOLDS.MIN_DUAL_CAT || 2;

  const shortlisted = scored.filter(m => {
    if (m.score < minScore) return false;

    // Category gate: need strength in at least one category
    const strongO25 = m.o25score >= minSingle;
    const strongBtts = m.bttsScore >= minSingle;
    const dualStrong = m.o25score >= minDual && m.bttsScore >= minDual;

    return strongO25 || strongBtts || dualStrong;
  }).sort((a, b) => b.score - a.score);

  return { all: scored, shortlisted };
}

module.exports = { scoreMatch, buildShortlist };