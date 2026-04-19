// src/engine/shortlist.js
// ─────────────────────────────────────────────────────────────
// Shortlist scoring engine — unchanged gate logic from v2.
// Adds: direction field (u25 / o25) per match.
//
// NOTE: The probability floor (MIN_PROB) cannot be applied here
// because analysis hasn't run yet. It is applied in orchestrator.js
// AFTER analyseMatch() attaches probabilities.
// ─────────────────────────────────────────────────────────────

const { THRESHOLDS } = require('../config');

function scoreMatch(match, leagueStats = {}) {
  const flags = [];
  const h = match.home || {};
  const a = match.away || {};

  if (h.o25pct == null && h.btsPct == null && a.o25pct == null && a.btsPct == null) {
    return { score: 0, grade: '-', flags: ['No stats available'], categories: { o25: 0, btts: 0, u25: 0 }, direction: null };
  }

  const minGP = THRESHOLDS.MIN_GP || 5;
  if ((h.gp != null && h.gp < minGP) || (a.gp != null && a.gp < minGP)) {
    const lowGP = Math.min(h.gp || 0, a.gp || 0);
    return { score: 0, grade: '-', flags: [`Too few games (${lowGP} < ${minGP})`], categories: { o25: 0, btts: 0, u25: 0 }, direction: null };
  }

  let o25score = 0;
  let bttsScore = 0;

  // ── O2.5 flags ──────────────────────────────────────────────
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

  if (h.avgTG != null && a.avgTG != null) {
    const combined = h.avgTG + a.avgTG;
    if (combined >= 6.0)      { o25score += 2; flags.push(`🔥 Combined TG ${combined.toFixed(2)}`); }
    else if (combined >= 5.0) { o25score += 1; flags.push(`Combined TG ${combined.toFixed(2)}`); }
  } else {
    if (h.avgTG != null && h.avgTG >= THRESHOLDS.TG_FLAG) { o25score += 1; flags.push(`Home TG ${h.avgTG}`); }
    if (a.avgTG != null && a.avgTG >= THRESHOLDS.TG_FLAG) { o25score += 1; flags.push(`Away TG ${a.avgTG}`); }
  }

  if (leagueStats.o25pct != null && leagueStats.o25pct >= 55) {
    o25score += 1; flags.push(`League O2.5 ${leagueStats.o25pct}%`);
  }
  if (leagueStats.avgGoals != null && leagueStats.avgGoals >= 2.8) {
    o25score += 1; flags.push(`League avg goals ${leagueStats.avgGoals}`);
  }

  const homePPG = h.ppg, awayPPG = a.ppg;
  if (homePPG != null && awayPPG != null) {
    if (Math.abs(homePPG - awayPPG) >= (THRESHOLDS.PPG_STRONG - THRESHOLDS.PPG_WEAK)
        && (homePPG >= THRESHOLDS.PPG_STRONG || awayPPG >= THRESHOLDS.PPG_STRONG)) {
      o25score += 1; flags.push(`PPG mismatch: Away ${awayPPG} vs Home ${homePPG}`);
    }
  }

  // ── BTTS flags ───────────────────────────────────────────────
  if (h.btsPct != null) {
    if (h.btsPct >= 70)      { bttsScore += 3; flags.push(`🔥 Home BTTS ${h.btsPct}%`); }
    else if (h.btsPct >= 60) { bttsScore += 2; flags.push(`📈 Home BTTS ${h.btsPct}%`); }
    else if (h.btsPct >= 55) { bttsScore += 1; flags.push(`Home BTTS ${h.btsPct}%`); }
  }
  if (a.btsPct != null) {
    if (a.btsPct >= 70)      { bttsScore += 3; flags.push(`🔥 Away BTTS ${a.btsPct}%`); }
    else if (a.btsPct >= 60) { bttsScore += 2; flags.push(`📈 Away BTTS ${a.btsPct}%`); }
    else if (a.btsPct >= 55) { bttsScore += 1; flags.push(`Away BTTS ${a.btsPct}%`); }
  }
  if (leagueStats.bttsPct != null && leagueStats.bttsPct >= 50) {
    bttsScore += 1; flags.push(`League BTTS ${leagueStats.bttsPct}%`);
  }

  // ── U2.5 signal score (positive defensive signals) ───────────
  // Used for direction assignment only — does NOT affect grade/score.
  let u25score = 0;
  if (h.csPct  != null && h.csPct  >= 40) u25score += 2;
  if (a.csPct  != null && a.csPct  >= 40) u25score += 2;
  if (h.ftsPct != null && h.ftsPct >= 35) u25score += 1;
  if (a.ftsPct != null && a.ftsPct >= 35) u25score += 1;

  // ── Negative flags (penalise both o25 and btts) ──────────────
  if (h.ftsPct != null && h.ftsPct >= THRESHOLDS.FTS_HIGH) {
    bttsScore -= 2; flags.push(`⚠ Home FTS ${h.ftsPct}% (often blank)`);
  }
  if (a.ftsPct != null && a.ftsPct >= THRESHOLDS.FTS_HIGH) {
    bttsScore -= 2; flags.push(`⚠ Away FTS ${a.ftsPct}% (often blank)`);
  }
  if (h.csPct != null && h.csPct >= THRESHOLDS.CS_HIGH) {
    bttsScore -= 2; o25score -= 1; flags.push(`⚠ Home CS ${h.csPct}% (defensive)`);
  }
  if (a.csPct != null && a.csPct >= THRESHOLDS.CS_HIGH) {
    bttsScore -= 2; o25score -= 1; flags.push(`⚠ Away CS ${a.csPct}% (defensive)`);
  }
  if (h.winPct != null && a.winPct != null && h.winPct <= 25 && a.winPct <= 25) {
    o25score -= 1; bttsScore -= 1; flags.push(`⚠ Both teams low W% (${h.winPct}% / ${a.winPct}%)`);
  }

  const score = o25score + bttsScore;

  let grade;
  if (score >= 10)                        grade = 'A+';
  else if (score >= 7)                    grade = 'A';
  else if (score >= 5)                    grade = 'B';
  else if (score >= THRESHOLDS.MIN_SCORE) grade = 'C';
  else                                    grade = '-';

  // ── Direction: which market does the signal profile favour? ──
  // u25score > o25score AND u25 is strong enough → recommend U2.5
  // Otherwise → recommend O2.5 (our default market)
  // You asked: "Shouldn't O2.5 with low probability = U2.5?"
  // Answer: yes — the probability.js model gives P(O2.5). If that's
  // low (say 54%), then P(U2.5) = 46%, which is ALSO not confident.
  // Direction should be driven by signals, not just inverting a weak
  // O2.5 probability. A match only gets U2.5 direction if the defensive
  // signals (CS%, FTS%) are genuinely strong.
  let direction = 'o25';
  if (u25score >= 4 && u25score > o25score) direction = 'u25';

  return { score, grade, flags, categories: { o25: o25score, btts: bttsScore, u25: u25score }, direction };
}

function buildShortlist(matches, leagueStatsMap = {}) {
  const scored = matches.map(m => {
    const leagueStats = leagueStatsMap[m.leagueSlug] || {};
    const result      = scoreMatch(m, leagueStats);
    return {
      ...m,
      score:     result.score,
      grade:     result.grade,
      flags:     result.flags,
      o25score:  result.categories.o25,
      bttsScore: result.categories.btts,
      u25score:  result.categories.u25,
      direction: result.direction,
    };
  });

  const minScore  = THRESHOLDS.MIN_SCORE    || 5;
  const minSingle = THRESHOLDS.MIN_SINGLE_CAT || 4;
  const minDual   = THRESHOLDS.MIN_DUAL_CAT   || 2;

  const shortlisted = scored.filter(m => {
    if (m.score < minScore) return false;
    const strongO25  = m.o25score  >= minSingle;
    const strongBtts = m.bttsScore >= minSingle;
    const dualStrong = m.o25score  >= minDual && m.bttsScore >= minDual;
    return strongO25 || strongBtts || dualStrong;
  }).sort((a, b) => b.score - a.score);

  return { all: scored, shortlisted };
}

module.exports = { scoreMatch, buildShortlist };