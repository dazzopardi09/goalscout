// src/engine/shortlist.js
// ─────────────────────────────────────────────────────────────
// Shortlist scoring engine — v3 directional
//
// Two completely independent scorers — O2.5 and U2.5.
// No BTTS. No composite. No category gates.
//
// Each match is scored for both directions independently.
// The direction with the strictly HIGHER score wins.
// Ties are treated as ambiguous and filtered out entirely —
// they are not defaulted to O2.5. (Ties may indicate draw
// candidates, reserved for a future draw market module.)
//
// Grade and shortlist gate use the winning score only.
//
// O2.5 scorer — offensive signals
//   Positive: high o25pct, high avgTG, high-scoring league, PPG mismatch
//   Penalty:  high csPct or ftsPct (reduces O2.5 probability)
//
// U2.5 scorer — defensive signals
//   Positive: high csPct, high ftsPct, low o25pct, low avgTG, low-scoring league
//   Penalty:  high o25pct, high mean TG profile (undermines U2.5)
//
// Shortlist gate: winning score >= MIN_WINNING_SCORE (default 4)
// Grade (winning score only): A+ >= 9, A >= 6, B >= 4
// ─────────────────────────────────────────────────────────────

const { THRESHOLDS } = require('../config');

function scoreMatch(match, leagueStats = {}) {
  const h = match.home || {};
  const a = match.away || {};

  // No usable stats at all
  if (h.o25pct == null && h.csPct == null && h.ftsPct == null &&
      a.o25pct == null && a.csPct == null && a.ftsPct == null) {
    return { winningScore: 0, grade: '-', flags: ['No stats available'], o25score: 0, u25score: 0, direction: null };
  }

  // Too few games — stats unreliable
  const minGP = THRESHOLDS.MIN_GP || 5;
  if ((h.gp != null && h.gp < minGP) || (a.gp != null && a.gp < minGP)) {
    const lowGP = Math.min(h.gp ?? 99, a.gp ?? 99);
    return { winningScore: 0, grade: '-', flags: [`Too few games (${lowGP} < ${minGP})`], o25score: 0, u25score: 0, direction: null };
  }

  const o25flags = [];
  const u25flags = [];
  let o25score = 0;
  let u25score = 0;

  // ── O2.5 scorer ───────────────────────────────────────────

  // Positive: high home o25pct
  if (h.o25pct != null) {
    if      (h.o25pct >= 75) { o25score += 3; o25flags.push(`🔥 Home O2.5 ${h.o25pct}%`); }
    else if (h.o25pct >= 65) { o25score += 2; o25flags.push(`📈 Home O2.5 ${h.o25pct}%`); }
    else if (h.o25pct >= 55) { o25score += 1; o25flags.push(`Home O2.5 ${h.o25pct}%`); }
  }

  // Positive: high away o25pct
  if (a.o25pct != null) {
    if      (a.o25pct >= 75) { o25score += 3; o25flags.push(`🔥 Away O2.5 ${a.o25pct}%`); }
    else if (a.o25pct >= 65) { o25score += 2; o25flags.push(`📈 Away O2.5 ${a.o25pct}%`); }
    else if (a.o25pct >= 55) { o25score += 1; o25flags.push(`Away O2.5 ${a.o25pct}%`); }
  }

  // Positive: high mean TG profile
  if (h.avgTG != null && a.avgTG != null) {
    const meanTG = (h.avgTG + a.avgTG) / 2;
    if      (meanTG >= 3.0) { o25score += 2; o25flags.push(`🔥 Mean TG profile ${meanTG.toFixed(2)}`); }
    else if (meanTG >= 2.5) { o25score += 1; o25flags.push(`Mean TG profile ${meanTG.toFixed(2)}`); }
  } else {
    if (h.avgTG != null && h.avgTG >= THRESHOLDS.TG_FLAG) { o25score += 1; o25flags.push(`Home TG ${h.avgTG}`); }
    if (a.avgTG != null && a.avgTG >= THRESHOLDS.TG_FLAG) { o25score += 1; o25flags.push(`Away TG ${a.avgTG}`); }
  }

  // Positive: high-scoring league context
  if (leagueStats.o25pct != null && leagueStats.o25pct >= 55) {
    o25score += 1; o25flags.push(`League O2.5 ${leagueStats.o25pct}%`);
  }
  if (leagueStats.avgGoals != null && leagueStats.avgGoals >= 2.8) {
    o25score += 1; o25flags.push(`League avg goals ${leagueStats.avgGoals}`);
  }

  // Positive: PPG mismatch (dominant vs weak → open game)
  if (h.ppg != null && a.ppg != null) {
    const gap = Math.abs(h.ppg - a.ppg);
    if (gap >= (THRESHOLDS.PPG_STRONG - THRESHOLDS.PPG_WEAK) &&
        (h.ppg >= THRESHOLDS.PPG_STRONG || a.ppg >= THRESHOLDS.PPG_STRONG)) {
      o25score += 1; o25flags.push(`PPG mismatch ${h.ppg} / ${a.ppg}`);
    }
  }

  // Penalty: high csPct reduces O2.5 probability
  if (h.csPct != null && h.csPct >= 40) { o25score -= 1; o25flags.push(`⚠ Home CS ${h.csPct}%`); }
  if (a.csPct != null && a.csPct >= 40) { o25score -= 1; o25flags.push(`⚠ Away CS ${a.csPct}%`); }

  // Penalty: high ftsPct means fewer goals overall
  if (h.ftsPct != null && h.ftsPct >= 40) { o25score -= 1; o25flags.push(`⚠ Home FTS ${h.ftsPct}%`); }
  if (a.ftsPct != null && a.ftsPct >= 40) { o25score -= 1; o25flags.push(`⚠ Away FTS ${a.ftsPct}%`); }

  // ── U2.5 scorer ───────────────────────────────────────────

  // Positive: high home csPct
  if (h.csPct != null) {
    if      (h.csPct >= 50) { u25score += 3; u25flags.push(`🔥 Home CS ${h.csPct}%`); }
    else if (h.csPct >= 40) { u25score += 2; u25flags.push(`📈 Home CS ${h.csPct}%`); }
    else if (h.csPct >= 30) { u25score += 1; u25flags.push(`Home CS ${h.csPct}%`); }
  }

  // Positive: high away csPct
  if (a.csPct != null) {
    if      (a.csPct >= 50) { u25score += 3; u25flags.push(`🔥 Away CS ${a.csPct}%`); }
    else if (a.csPct >= 40) { u25score += 2; u25flags.push(`📈 Away CS ${a.csPct}%`); }
    else if (a.csPct >= 30) { u25score += 1; u25flags.push(`Away CS ${a.csPct}%`); }
  }

  // Positive: high home ftsPct
  if (h.ftsPct != null) {
    if      (h.ftsPct >= 40) { u25score += 2; u25flags.push(`🔥 Home FTS ${h.ftsPct}%`); }
    else if (h.ftsPct >= 30) { u25score += 1; u25flags.push(`Home FTS ${h.ftsPct}%`); }
  }

  // Positive: high away ftsPct
  if (a.ftsPct != null) {
    if      (a.ftsPct >= 40) { u25score += 2; u25flags.push(`🔥 Away FTS ${a.ftsPct}%`); }
    else if (a.ftsPct >= 30) { u25score += 1; u25flags.push(`Away FTS ${a.ftsPct}%`); }
  }

  // Positive: low o25pct directly signals low-scoring matches
  if (h.o25pct != null) {
    if      (h.o25pct <= 35) { u25score += 2; u25flags.push(`🔥 Home O2.5 only ${h.o25pct}%`); }
    else if (h.o25pct <= 45) { u25score += 1; u25flags.push(`Home O2.5 ${h.o25pct}%`); }
  }
  if (a.o25pct != null) {
    if      (a.o25pct <= 35) { u25score += 2; u25flags.push(`🔥 Away O2.5 only ${a.o25pct}%`); }
    else if (a.o25pct <= 45) { u25score += 1; u25flags.push(`Away O2.5 ${a.o25pct}%`); }
  }

  // STAGE 2B deferred: positive U2.5 mean TG support intentionally disabled.
  // Historical what-if testing did not justify enabling this yet.
  // Candidate thresholds for future research only:
  //   meanTG <= 1.9 -> +2 U2.5
  //   meanTG <= 2.2 -> +1 U2.5

  // Positive: low-scoring league
  if (leagueStats.avgGoals != null && leagueStats.avgGoals <= 2.3) {
    u25score += 1; u25flags.push(`League avg goals ${leagueStats.avgGoals}`);
  }

  // Penalty: high o25pct undermines U2.5
  if (h.o25pct != null && h.o25pct >= 65) { u25score -= 2; u25flags.push(`⚠ Home O2.5 ${h.o25pct}%`); }
  if (a.o25pct != null && a.o25pct >= 65) { u25score -= 2; u25flags.push(`⚠ Away O2.5 ${a.o25pct}%`); }

  // Penalty: high mean TG profile undermines U2.5
  if (h.avgTG != null && a.avgTG != null) {
    const meanTG = (h.avgTG + a.avgTG) / 2;
    if (meanTG >= 2.5) {
      u25score -= 1; u25flags.push(`⚠ Mean TG profile ${meanTG.toFixed(2)}`);
    }
  }

  // ── Direction ─────────────────────────────────────────────
  // Ties are ambiguous — filtered out in buildShortlist.
  // A strict win is required for a direction to be assigned.
  let direction, winningScore, flags;
  if (o25score > u25score) {
    direction    = 'o25';
    winningScore = o25score;
    flags        = o25flags;
  } else if (u25score > o25score) {
    direction    = 'u25';
    winningScore = u25score;
    flags        = u25flags;
  } else {
    // Tied — no clear direction, will be excluded from shortlist
    direction    = null;
    winningScore = o25score; // both equal, value doesn't matter
    flags        = [`Tied O2.5/U2.5 (${o25score}/${u25score}) — ambiguous`];
  }

  // ── Grade from winning score only ─────────────────────────
  // Tied matches get '-' — no grade should be inferred for ambiguous results.
  let grade;
  if (direction === null) {
    grade = '-';
  } else if (winningScore >= 9) {
    grade = 'A+';
  } else if (winningScore >= 6) {
    grade = 'A';
  } else if (winningScore >= 4) {
    grade = 'B';
  } else {
    grade = '-';
  }

  return { winningScore, grade, flags, o25score, u25score, direction };
}

function buildShortlist(matches, leagueStatsMap = {}) {
  const minWinning = THRESHOLDS.MIN_WINNING_SCORE || 4;

  const scored = matches.map(m => {
    const leagueStats = leagueStatsMap[m.leagueSlug] || {};
    const result = scoreMatch(m, leagueStats);
    return {
      ...m,
      score:     result.winningScore,
      grade:     result.grade,
      flags:     result.flags,
      o25score:  result.o25score,
      u25score:  result.u25score,
      direction: result.direction,
    };
  });

  const shortlisted = scored
    .filter(m =>
      m.direction != null &&        // ties excluded
      m.score >= minWinning          // must meet threshold in winning direction
    )
    .sort((a, b) => {
      const at = a.commenceTime ? new Date(a.commenceTime).getTime() : Number.MAX_SAFE_INTEGER;
      const bt = b.commenceTime ? new Date(b.commenceTime).getTime() : Number.MAX_SAFE_INTEGER;
      return at - bt;
    });

  return { all: scored, shortlisted };
}

module.exports = { scoreMatch, buildShortlist };