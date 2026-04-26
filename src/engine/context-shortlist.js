// src/engine/context-shortlist.js
// ─────────────────────────────────────────────────────────────
// Standalone context_raw scoring engine — Stage 2.
//
// ARCHITECTURAL RULES (from CONTEXT-RAW-SPEC.md §3):
//   ✗ Does NOT import from shortlist.js or probability.js
//   ✗ Does NOT read SoccerSTATS season aggregates
//   ✗ Does NOT reuse league-calibration.json parameters
//   ✓ Uses only rolling per-team goals stats (last 6 matches)
//   ✓ Produces its own probability estimate (uncalibrated)
//
// Entry point: scoreContext(homeRolling, awayRolling, fixtureOdds)
// Where homeRolling/awayRolling come from rolling-stats.js
// And fixtureOdds = { oddsHomeOpen, oddsAwayOpen } from the CSV (optional)
//
// Returns a result object — see scoreContext() for full shape.
// ─────────────────────────────────────────────────────────────

'use strict';

// ── Constants ────────────────────────────────────────────────

const MIN_GAMES_REQUIRED = 4;   // below this → skip (insufficient_recent_data)
const MIN_O25_SCORE      = 3;   // O2.5 threshold — score=3 O2.5 hits at 60.0% (Stage 5 analysis)
const MIN_U25_SCORE      = 4;   // U2.5 threshold — score=3 U2.5 hits at 30.8%, keep stricter filter

// Odds ratio threshold to define a "clear mismatch" between favourite and underdog.
// e.g. 1.5 vs 4.5 = ratio 3.0 → clear mismatch
//      1.9 vs 2.1 = ratio 1.1 → NOT a clear mismatch
const CLEAR_MISMATCH_ODDS_RATIO = 2.0;

// PPG proxy threshold when odds are unavailable
// A gap of >= 1.0 goals/game in gf_avg is treated as a clear mismatch
const CLEAR_MISMATCH_GF_GAP = 1.0;

// ── Favourite / underdog determination ───────────────────────

/**
 * Determine which team is the favourite using 1X2 opening odds (preferred)
 * or gf_avg as a PPG proxy (fallback).
 *
 * Returns:
 *   favouriteIsHome {boolean|null}  true=home fav, false=away fav, null=unknown
 *   isClearMismatch {boolean}       true if gap is large enough for asymmetric CDO rule
 *   oddsSource      {string}        'odds' | 'gf_avg_proxy' | 'unknown'
 */
function determineFavourite(home, away, fixtureOdds) {
  const { oddsHomeOpen, oddsAwayOpen } = fixtureOdds || {};

  if (oddsHomeOpen && oddsAwayOpen && oddsHomeOpen > 0 && oddsAwayOpen > 0) {
    const favouriteIsHome = oddsHomeOpen < oddsAwayOpen;
    const ratio = Math.max(oddsHomeOpen, oddsAwayOpen) / Math.min(oddsHomeOpen, oddsAwayOpen);
    return {
      favouriteIsHome,
      isClearMismatch: ratio >= CLEAR_MISMATCH_ODDS_RATIO,
      oddsSource: 'odds',
    };
  }

  // Fallback: use gf_avg as PPG proxy
  if (home.gf_avg != null && away.gf_avg != null) {
    const gap = Math.abs(home.gf_avg - away.gf_avg);
    if (gap < 0.01) {
      // Too close to call
      return { favouriteIsHome: null, isClearMismatch: false, oddsSource: 'gf_avg_proxy' };
    }
    return {
      favouriteIsHome: home.gf_avg > away.gf_avg,
      isClearMismatch: gap >= CLEAR_MISMATCH_GF_GAP,
      oddsSource: 'gf_avg_proxy',
    };
  }

  return { favouriteIsHome: null, isClearMismatch: false, oddsSource: 'unknown' };
}

// ── Per-team CDO evaluation ───────────────────────────────────

/**
 * concede_driven_over (per team):
 * This team's recent O2.5 rate is driven by defensive collapse, not attacking output.
 *
 * o25_count >= 3  AND  scored2plus_count <= 1  AND  conceded2plus_count >= 2
 */
function cdoPerTeam(rolling) {
  return (
    rolling.o25_count >= 3 &&
    rolling.scored2plus_count <= 1 &&
    rolling.conceded2plus_count >= 2
  );
}

/**
 * Evaluate CDO at fixture level.
 * Returns the score adjustment (effect) and a diagnostic label (type).
 *
 * Rules (from spec §6, concede_driven_over):
 *   1. If !is_clear_mismatch (or favourite unknown): symmetric -1 if any CDO fires
 *   2. If is_clear_mismatch AND CDO fires on both teams: -1
 *   3. If is_clear_mismatch AND CDO fires on underdog only: -2
 *   4. If is_clear_mismatch AND CDO fires on favourite only: 0 (log only)
 */
function evaluateCDOFixture(cdoHome, cdoAway, isClearMismatch, favouriteIsHome) {
  if (!cdoHome && !cdoAway) {
    return { cdoEffect: 0, cdoType: null };
  }

  // No clear mismatch or unknown favourite — symmetric rule
  if (!isClearMismatch || favouriteIsHome === null) {
    return { cdoEffect: -1, cdoType: 'no_clear_mismatch' };
  }

  // Both teams have CDO
  if (cdoHome && cdoAway) {
    return { cdoEffect: -1, cdoType: 'both' };
  }

  // One team has CDO — check if it's the underdog
  const cdoIsOnHome     = cdoHome;           // the team with the CDO flag
  const cdoTeamIsHome   = cdoIsOnHome;
  const cdoTeamIsUnderdog = cdoTeamIsHome
    ? !favouriteIsHome   // home has CDO; home is underdog if away is favourite
    : favouriteIsHome;   // away has CDO; away is underdog if home is favourite

  if (cdoTeamIsUnderdog) {
    return { cdoEffect: -2, cdoType: 'underdog' };
  } else {
    return { cdoEffect: 0, cdoType: 'favourite_only' };
  }
}

// ── Flag computation ─────────────────────────────────────────

/**
 * Compute all v1 context flags for a fixture.
 * All flags are deterministic — same inputs always produce same outputs.
 *
 * @param {object} home         Rolling stats for home team
 * @param {object} away         Rolling stats for away team
 * @param {object} fixtureOdds  { oddsHomeOpen, oddsAwayOpen } (optional)
 * @returns {object}            All flag values + diagnostic fields
 */
function computeFlags(home, away, fixtureOdds) {
  const { favouriteIsHome, isClearMismatch, oddsSource } = determineFavourite(home, away, fixtureOdds);

  const cdoHome = cdoPerTeam(home);
  const cdoAway = cdoPerTeam(away);
  const { cdoEffect, cdoType } = evaluateCDOFixture(cdoHome, cdoAway, isClearMismatch, favouriteIsHome);

  return {
    // ── Core flags ──────────────────────────────────────────────
    both_weak_attack:
      home.gf_avg < 1.0 && away.gf_avg < 1.0,

    one_sided_over_risk:
      (home.scored2plus_count >= 3 && away.scored2plus_count <= 1) ||
      (away.scored2plus_count >= 3 && home.scored2plus_count <= 1),

    // Per-team CDO (diagnostic)
    concede_driven_over_home:    cdoHome,
    concede_driven_over_away:    cdoAway,
    // Fixture-level CDO result
    concede_driven_over_fixture: cdoType,    // null | 'underdog' | 'both' | 'favourite_only' | 'no_clear_mismatch'
    concede_driven_over_effect:  cdoEffect,  // 0 | -1 | -2

    both_leaky_defence:
      home.ga_avg >= 1.8 && away.ga_avg >= 1.8 &&
      home.gf_avg >= 1.0 && away.gf_avg >= 1.0,

    strong_two_sided_over:
      home.scored2plus_count >= 3 && away.scored2plus_count >= 3 &&
      home.gf_avg >= 1.5 && away.gf_avg >= 1.5,

    low_attack_under_support:
      home.gf_avg < 1.2 && away.gf_avg < 1.2 &&
      (home.fts_count + away.fts_count) >= 4,

    insufficient_recent_data:
      home.games_available < MIN_GAMES_REQUIRED ||
      away.games_available < MIN_GAMES_REQUIRED,

    // ── Diagnostic (not used in scoring) ───────────────────────
    favouriteIsHome,
    isClearMismatch,
    oddsSource,
  };
}

// ── O2.5 scorer ──────────────────────────────────────────────

/**
 * Score a fixture for O2.5 goals.
 * Returns { score, signals[] } where each signal records what fired and why.
 */
function scoreO25(home, away, flags) {
  const h = home;
  const a = away;
  let score = 0;
  const signals = [];

  function add(pts, desc) { score += pts; signals.push({ pts, desc }); }

  // ── Positive signals ────────────────────────────────────────
  if (h.gf_avg >= 2.0)                       add(+2, `Home gf_avg ${h.gf_avg} ≥ 2.0`);
  if (a.gf_avg >= 2.0)                       add(+2, `Away gf_avg ${a.gf_avg} ≥ 2.0`);
  if (h.gf_avg >= 1.5 && a.gf_avg >= 1.5)   add(+1, `Both gf_avg ≥ 1.5`);
  if (h.scored2plus_count >= 3)              add(+2, `Home s2+ ${h.scored2plus_count} ≥ 3`);
  if (a.scored2plus_count >= 3)              add(+2, `Away s2+ ${a.scored2plus_count} ≥ 3`);
  if (h.o25_count >= 4)                      add(+1, `Home o25_count ${h.o25_count} ≥ 4`);
  if (a.o25_count >= 4)                      add(+1, `Away o25_count ${a.o25_count} ≥ 4`);
  if (flags.strong_two_sided_over)           add(+3, `strong_two_sided_over`);
  if (flags.both_leaky_defence)              add(+2, `both_leaky_defence`);
  if (h.ga_avg >= 1.8)                       add(+1, `Home ga_avg ${h.ga_avg} ≥ 1.8`);
  if (a.ga_avg >= 1.8)                       add(+1, `Away ga_avg ${a.ga_avg} ≥ 1.8`);

  // ── Negative signals ────────────────────────────────────────
  if (flags.both_weak_attack)                add(-3, `both_weak_attack`);
  if (flags.one_sided_over_risk)             add(-1, `one_sided_over_risk`);
  if (flags.concede_driven_over_effect !== 0)
    add(flags.concede_driven_over_effect,    `concede_driven_over (${flags.concede_driven_over_fixture})`);
  if (h.fts_count >= 3)                      add(-2, `Home fts_count ${h.fts_count} ≥ 3`);
  if (a.fts_count >= 3)                      add(-2, `Away fts_count ${a.fts_count} ≥ 3`);
  if (flags.low_attack_under_support)        add(-2, `low_attack_under_support`);

  return { score, signals };
}

// ── U2.5 scorer ──────────────────────────────────────────────

/**
 * Score a fixture for U2.5 goals.
 * Returns { score, signals[] }.
 */
function scoreU25(home, away, flags) {
  const h = home;
  const a = away;
  let score = 0;
  const signals = [];

  function add(pts, desc) { score += pts; signals.push({ pts, desc }); }

  // ── Positive signals ────────────────────────────────────────
  if (flags.low_attack_under_support)              add(+3, `low_attack_under_support`);
  if (h.gf_avg < 1.2 && a.gf_avg < 1.2)           add(+2, `Both gf_avg < 1.2`);
  if (h.fts_count >= 3)                            add(+2, `Home fts_count ${h.fts_count} ≥ 3`);
  if (a.fts_count >= 3)                            add(+2, `Away fts_count ${a.fts_count} ≥ 3`);
  if (h.o25_count <= 2 && a.o25_count <= 2)        add(+2, `Both o25_count ≤ 2`);
  if (h.conceded2plus_count <= 1)                  add(+1, `Home c2+ ${h.conceded2plus_count} ≤ 1`);
  if (a.conceded2plus_count <= 1)                  add(+1, `Away c2+ ${a.conceded2plus_count} ≤ 1`);

  // ── Negative signals ────────────────────────────────────────
  if (h.gf_avg >= 2.0 || a.gf_avg >= 2.0)         add(-2, `Dangerous attack present (gf_avg ≥ 2.0)`);
  if (h.o25_count >= 4 && a.o25_count >= 4)        add(-2, `Both o25_count ≥ 4`);
  if (flags.strong_two_sided_over)                 add(-2, `strong_two_sided_over`);
  if (flags.both_leaky_defence)                    add(-2, `both_leaky_defence`);

  return { score, signals };
}

// ── Raw probability ───────────────────────────────────────────

/**
 * Compute the uncalibrated raw probability estimate for O2.5.
 *
 * ⚠ This is NOT a calibrated probability. The _raw suffix is the safety mark.
 * Do not use in any decision logic or display without an "uncalibrated" indicator.
 * See CONTEXT-RAW-SPEC.md §8.
 *
 * @returns {{ context_o25_prob_raw, context_u25_prob_raw }}
 */
function computeRawProbability(home, away, flags) {
  const totalGames      = home.games_available + away.games_available;
  const recent_o25_rate = (home.o25_count + away.o25_count) / totalGames;

  const combinedGF    = home.gf_avg + away.gf_avg;
  const attack_signal = Math.min(0.95, Math.max(0.05, (combinedGF - 1.5) / 3.5));

  let prob = (recent_o25_rate * 0.6) + (attack_signal * 0.4);

  // Flag-based micro-adjustments (bounded)
  if (flags.both_weak_attack)                  prob -= 0.10;
  if (flags.strong_two_sided_over)             prob += 0.05;
  if (flags.concede_driven_over_type === 'underdog') prob -= 0.08;

  // Clamp to [0.10, 0.90] — see spec §8
  prob = Math.min(0.90, Math.max(0.10, prob));

  return {
    context_o25_prob_raw: round4(prob),
    context_u25_prob_raw: round4(1 - prob),
  };
}

// ── Main entry point ─────────────────────────────────────────

/**
 * Score a fixture using the context_raw model.
 *
 * @param {object} homeRolling  Output of computeRollingStats() for home team
 * @param {object} awayRolling  Output of computeRollingStats() for away team
 * @param {object} fixtureOdds  { oddsHomeOpen, oddsAwayOpen } from CSV (optional)
 *
 * @returns {object} Result with shape:
 *   { skip, skipReason, direction, o25Score, u25Score, winningScore,
 *     grade, context_o25_prob_raw, context_u25_prob_raw, modelProb,
 *     fairOdds, flags, signals }
 */
function scoreContext(homeRolling, awayRolling, fixtureOdds = {}) {

  // ── Guard: insufficient data ─────────────────────────────────
  if (!homeRolling || !awayRolling ||
      homeRolling.games_available < MIN_GAMES_REQUIRED ||
      awayRolling.games_available < MIN_GAMES_REQUIRED) {
    return {
      skip:       true,
      skipReason: 'insufficient_recent_data',
      direction:  null,
      o25Score:   null,
      u25Score:   null,
      winningScore: null,
      grade:      null,
      context_o25_prob_raw: null,
      context_u25_prob_raw: null,
      modelProb:  null,
      fairOdds:   null,
      flags:      null,
      signals:    null,
    };
  }

  // ── Flags ────────────────────────────────────────────────────
  const flags = computeFlags(homeRolling, awayRolling, fixtureOdds);

  // ── Score both directions ────────────────────────────────────
  const { score: o25Score, signals: o25Signals } = scoreO25(homeRolling, awayRolling, flags);
  const { score: u25Score, signals: u25Signals } = scoreU25(homeRolling, awayRolling, flags);

  // ── Direction selection ──────────────────────────────────────
  if (o25Score === u25Score) {
    return {
      skip: true, skipReason: 'tied_direction',
      direction: null, o25Score, u25Score,
      winningScore: o25Score, grade: null,
      context_o25_prob_raw: null, context_u25_prob_raw: null,
      modelProb: null, fairOdds: null, flags, signals: null,
    };
  }

  const direction    = o25Score > u25Score ? 'o25' : 'u25';
  const winningScore = Math.max(o25Score, u25Score);

  // Direction-aware threshold: O2.5 uses MIN_O25_SCORE (3), U2.5 uses MIN_U25_SCORE (4).
  // Stage 5 analysis on EPL 2024-25: score=3 O2.5 hits at 60.0% (35 fixtures) — same
  // signal as passing predictions. Score=3 U2.5 hits at 30.8% (13 fixtures) — below base
  // rate, threshold correctly filters these out.
  const minScore = direction === 'o25' ? MIN_O25_SCORE : MIN_U25_SCORE;

  if (winningScore < minScore) {
    return {
      skip: true, skipReason: 'below_threshold',
      direction, o25Score, u25Score,
      winningScore, grade: null,
      context_o25_prob_raw: null, context_u25_prob_raw: null,
      modelProb: null, fairOdds: null, flags, signals: null,
    };
  }

  // ── Grade ────────────────────────────────────────────────────
  const grade = winningScore >= 9 ? 'A+' : winningScore >= 6 ? 'A' : 'B';

  // ── Probability ──────────────────────────────────────────────
  const { context_o25_prob_raw, context_u25_prob_raw } = computeRawProbability(homeRolling, awayRolling, flags);

  const modelProb = direction === 'o25' ? context_o25_prob_raw : context_u25_prob_raw;
  const fairOdds  = modelProb > 0 ? round2(1 / modelProb) : null;

  // ── Return ───────────────────────────────────────────────────
  return {
    skip:      false,
    skipReason: null,
    direction,
    o25Score,
    u25Score,
    winningScore,
    grade,
    context_o25_prob_raw,
    context_u25_prob_raw,
    modelProb,
    fairOdds,
    flags,
    signals: direction === 'o25' ? o25Signals : u25Signals,
  };
}

// ── Helpers ───────────────────────────────────────────────────

function round2(n) { return Math.round(n * 100) / 100; }
function round4(n) { return Math.round(n * 10000) / 10000; }

function gradeFor(score) {
  if (score >= 9) return 'A+';
  if (score >= 6) return 'A';
  if (score >= 4) return 'B';
  return '-';
}

// ── Exports ───────────────────────────────────────────────────

module.exports = {
  scoreContext,
  computeFlags,
  cdoPerTeam,
  scoreO25,
  scoreU25,
  computeRawProbability,
  MIN_GAMES_REQUIRED,
  MIN_O25_SCORE,
  MIN_U25_SCORE,
};