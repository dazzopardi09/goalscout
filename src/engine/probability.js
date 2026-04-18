// src/engine/probability.js
// ─────────────────────────────────────────────────────────────
// Probability estimation engine.
//
// Converts raw SoccerSTATS percentages into calibrated
// probability estimates for Over 2.5 and BTTS markets.
//
// This is the BASELINE model. It uses weighted averages of
// available indicators. Future versions will add xG-based
// Poisson modelling, but this baseline must exist first so
// we can measure whether xG actually improves things.
//
// ── Methodology ────────────────────────────────────────────
//
// P(Over 2.5):
//   Weighted average of:
//     - Home team home O2.5% (weight 0.35)
//     - Away team away O2.5% (weight 0.35)
//     - League average O2.5% (weight 0.10)
//     - Combined avg TG signal (weight 0.20)
//       → converted: if combined TG >= 2.5, boost probability
//
// P(BTTS):
//   Weighted average of:
//     - Home team home BTTS% (weight 0.30)
//     - Away team away BTTS% (weight 0.30)
//     - League average BTTS% (weight 0.10)
//     - FTS/CS penalty (weight 0.30)
//       → if either team has high FTS% or opponent has high CS%,
//         this drags BTTS probability down
//
// Fair odds = 1 / probability
// Edge = (fair odds - market odds) / market odds
//   Positive edge = model thinks bet is underpriced (value)
//   Negative edge = model thinks bet is overpriced (avoid)
//
// ── Calibration notes ──────────────────────────────────────
//
// These weights are starting estimates. Once we have 200+
// logged predictions with results, we can check calibration
// and adjust weights to minimize Brier score.
//
// The model version string tracks which weights/logic was used
// so we can compare v1 vs v2 etc.
// ─────────────────────────────────────────────────────────────

const MODEL_VERSION = 'baseline-v1';

/**
 * Estimate P(Over 2.5) for a match.
 * Returns a value between 0 and 1, or null if insufficient data.
 */
function estimateO25(match, leagueStats = {}) {
  const h = match.home || {};
  const a = match.away || {};

  const inputs = [];
  const weights = [];

  // Home team home O2.5%
  if (h.o25pct != null) {
    inputs.push(h.o25pct / 100);
    weights.push(0.35);
  }

  // Away team away O2.5%
  if (a.o25pct != null) {
    inputs.push(a.o25pct / 100);
    weights.push(0.35);
  }

  // League average O2.5
  if (leagueStats.o25pct != null) {
    inputs.push(leagueStats.o25pct / 100);
    weights.push(0.10);
  }

  // Combined TG signal
  if (h.avgTG != null && a.avgTG != null) {
    // Convert combined TG to a probability-like signal
    // TG of 5.0+ → strong O2.5 signal (~0.75)
    // TG of 3.5 → moderate signal (~0.55)
    // TG of 2.0 → weak signal (~0.30)
    const combined = h.avgTG + a.avgTG;
    const tgSignal = Math.min(0.95, Math.max(0.10, (combined - 1.5) / 5.0));
    inputs.push(tgSignal);
    weights.push(0.20);
  }

  if (inputs.length < 2) return null; // insufficient data

  // Weighted average
  const totalWeight = weights.reduce((s, w) => s + w, 0);
  const prob = inputs.reduce((s, v, i) => s + v * weights[i], 0) / totalWeight;

  // Clamp to reasonable range
  return Math.min(0.95, Math.max(0.05, prob));
}

/**
 * Estimate P(BTTS Yes) for a match.
 * Returns a value between 0 and 1, or null if insufficient data.
 */
function estimateBTTS(match, leagueStats = {}) {
  const h = match.home || {};
  const a = match.away || {};

  const inputs = [];
  const weights = [];

  // Home team home BTTS%
  if (h.btsPct != null) {
    inputs.push(h.btsPct / 100);
    weights.push(0.30);
  }

  // Away team away BTTS%
  if (a.btsPct != null) {
    inputs.push(a.btsPct / 100);
    weights.push(0.30);
  }

  // League average BTTS
  if (leagueStats.btsPct != null) {
    inputs.push(leagueStats.btsPct / 100);
    weights.push(0.10);
  }

  // FTS/CS penalty — the "mirror rule" check
  // If either team often fails to score OR the opponent keeps clean sheets,
  // BTTS probability drops significantly
  if (h.ftsPct != null || a.ftsPct != null || h.csPct != null || a.csPct != null) {
    // Average of "ability to be shut out"
    const homeFTS = (h.ftsPct || 0) / 100;   // home team fails to score
    const awayFTS = (a.ftsPct || 0) / 100;   // away team fails to score
    const homeCS  = (h.csPct || 0) / 100;    // home keeps clean sheets
    const awayCS  = (a.csPct || 0) / 100;    // away keeps clean sheets

    // Probability both teams score is reduced by:
    // P(home scores) ≈ 1 - max(homeFTS, awayCS)
    // P(away scores) ≈ 1 - max(awayFTS, homeCS)
    const pHomeScores = 1 - Math.max(homeFTS, awayCS);
    const pAwayScores = 1 - Math.max(awayFTS, homeCS);
    const bttsFromDefense = pHomeScores * pAwayScores;

    inputs.push(bttsFromDefense);
    weights.push(0.30);
  }

  if (inputs.length < 2) return null;

  const totalWeight = weights.reduce((s, w) => s + w, 0);
  const prob = inputs.reduce((s, v, i) => s + v * weights[i], 0) / totalWeight;

  return Math.min(0.95, Math.max(0.05, prob));
}

/**
 * Calculate fair decimal odds from a probability.
 * Fair odds = 1 / probability
 */
function fairOdds(prob) {
  if (!prob || prob <= 0) return null;
  return Math.round((1 / prob) * 100) / 100;
}

/**
 * Calculate edge percentage.
 * edge = (market_odds / fair_odds - 1) * 100
 *
 * Positive edge = market is offering more than fair price (value bet)
 * Negative edge = market is offering less than fair price (avoid)
 */
function calcEdge(marketOdds, fairOddsVal) {
  if (!marketOdds || !fairOddsVal) return null;
  return Math.round(((marketOdds / fairOddsVal) - 1) * 10000) / 100;
}

/**
 * Full probability analysis for a match.
 * Returns all model outputs needed for the pricing engine.
 */
function analyseMatch(match, leagueStats = {}) {
  const o25prob = estimateO25(match, leagueStats);
  const bttsProb = estimateBTTS(match, leagueStats);

  const o25fair = fairOdds(o25prob);
  const bttsFair = fairOdds(bttsProb);

  // Calculate edge against market odds if available
  let o25edge = null;
  let bttsEdge = null;

  if (match.odds && match.odds.o25 && o25fair) {
    o25edge = calcEdge(match.odds.o25.price, o25fair);
  }

  return {
    modelVersion: MODEL_VERSION,
    timestamp: new Date().toISOString(),

    o25: {
      probability: o25prob,
      fairOdds: o25fair,
      marketOdds: match.odds?.o25?.price || null,
      bookmaker: match.odds?.o25?.bookmaker || null,
      edge: o25edge,
    },

    btts: {
      probability: bttsProb,
      fairOdds: bttsFair,
      marketOdds: null,  // BTTS market odds not yet available from API
      bookmaker: null,
      edge: bttsEdge,
    },
  };
}

module.exports = {
  estimateO25,
  estimateBTTS,
  fairOdds,
  calcEdge,
  analyseMatch,
  MODEL_VERSION,
};
