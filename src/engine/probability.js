// src/engine/probability.js
// ─────────────────────────────────────────────────────────────
// Probability estimation engine — O2.5 and U2.5.
//
// P(Over 2.5) is estimated from weighted team/league stats.
// P(Under 2.5) = 1 - P(Over 2.5).
//
// ── Margin removal (devigging) ─────────────────────────────
//
// Bookmakers build a profit margin (overround) into their odds.
// A soccer O2.5 two-way market typically carries 3-7% margin
// depending on the bookmaker (Pinnacle ~2-3%, Bet365 ~5-7%).
//
// Raw implied probabilities always sum to MORE than 100%,
// meaning they overstate the market's true view of each side.
//
// Before comparing your model probability to the market,
// the margin must be removed ("devigging"):
//
//   impliedOver  = 1 / oddsOver
//   impliedUnder = 1 / oddsUnder
//   total        = impliedOver + impliedUnder      (e.g. 1.029)
//   trueOver     = impliedOver / total             (normalised)
//   trueUnder    = impliedUnder / total
//
// Edge is then:
//   edge = (yourProbability / trueMarketProbability - 1) * 100
//
// This removes false edge caused by bookmaker margin and gives
// a clean measure of whether your model disagrees with the
// market AFTER costs are stripped out.
//
// ── Edge interpretation ────────────────────────────────────
//
//   Positive edge = your model thinks the true probability is
//     HIGHER than the market's margin-free view → potential value
//   Negative edge = model is below the market's true view → avoid
//   Edge of +5% means your model says 55% vs market's 50% true view
//
// ── Calibration ────────────────────────────────────────────
//
// Weights are starting estimates. At 200+ settled predictions,
// compare mean model probability to actual hit rate per direction
// and minimise Brier score independently for O2.5 and U2.5.
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

  if (h.o25pct != null) {
    inputs.push(h.o25pct / 100);
    weights.push(0.35);
  }

  if (a.o25pct != null) {
    inputs.push(a.o25pct / 100);
    weights.push(0.35);
  }

  if (leagueStats.o25pct != null) {
    inputs.push(leagueStats.o25pct / 100);
    weights.push(0.10);
  }

  if (h.avgTG != null && a.avgTG != null) {
    const combined = h.avgTG + a.avgTG;
    // Maps combined TG to a probability signal:
    // 5.0+ → ~0.73, 3.5 → ~0.50, 2.0 → ~0.25
    const tgSignal = Math.min(0.95, Math.max(0.10, (combined - 1.5) / 5.0));
    inputs.push(tgSignal);
    weights.push(0.20);
  }

  if (inputs.length < 2) return null;

  const totalWeight = weights.reduce((s, w) => s + w, 0);
  const prob = inputs.reduce((s, v, i) => s + v * weights[i], 0) / totalWeight;

  return Math.min(0.95, Math.max(0.05, prob));
}

/**
 * Calculate fair decimal odds from a probability.
 */
function fairOdds(prob) {
  if (!prob || prob <= 0) return null;
  return Math.round((1 / prob) * 100) / 100;
}

/**
 * Remove bookmaker margin from a two-way O2.5 / U2.5 market.
 *
 * Bookmakers inflate implied probabilities so they sum above 100%.
 * This function normalises both sides back to a true 100% market.
 *
 * Returns:
 *   trueOver  — market's margin-free probability for Over 2.5
 *   trueUnder — market's margin-free probability for Under 2.5
 *   margin    — bookmaker's margin as a percentage (e.g. 2.9%)
 *
 * Returns nulls if either price is missing.
 */
function removeMargin(overPrice, underPrice) {
  if (!overPrice || !underPrice) {
    return { trueOver: null, trueUnder: null, margin: null };
  }

  const impliedOver  = 1 / overPrice;
  const impliedUnder = 1 / underPrice;
  const total = impliedOver + impliedUnder;

  return {
    trueOver:  Math.round((impliedOver  / total) * 10000) / 10000,
    trueUnder: Math.round((impliedUnder / total) * 10000) / 10000,
    margin:    Math.round((total - 1) * 10000) / 100,  // e.g. 2.87
  };
}

/**
 * Calculate edge against the market's TRUE (margin-free) probability.
 *
 * edge = (modelProbability / trueMarketProbability - 1) * 100
 *
 * Positive = model is above the market's fair view → potential value
 * Negative = model is below the market's fair view → avoid
 *
 * This is cleaner than comparing model vs raw market odds, because
 * it strips out the bookmaker's margin before measuring disagreement.
 */
function calcEdge(modelProbability, trueMarketProbability) {
  if (!modelProbability || !trueMarketProbability) return null;
  return Math.round(((modelProbability / trueMarketProbability) - 1) * 10000) / 100;
}

/**
 * Full probability analysis for a match.
 *
 * Uses match.direction ('o25' or 'u25', set by shortlist.js) to
 * determine which market side to measure edge against.
 *
 * Both sides of the market are always captured. Margin removal
 * runs when both Over AND Under prices are available.
 */
function analyseMatch(match, leagueStats = {}) {
  const o25prob = estimateO25(match, leagueStats);
  const u25prob = o25prob != null
    ? Math.round((1 - o25prob) * 10000) / 10000
    : null;

  const o25fair = fairOdds(o25prob);
  const u25fair = fairOdds(u25prob);

  const direction = match.direction || 'o25';

  // Extract both market prices
  const overPrice  = match.odds?.o25?.price  || null;
  const underPrice = match.odds?.u25?.price  || null;

  // Remove bookmaker margin from the two-way market
  const { trueOver, trueUnder, margin } = removeMargin(overPrice, underPrice);

  // Edge: model vs TRUE market probability (margin-stripped)
  const o25edge = o25prob != null && trueOver  != null
    ? calcEdge(o25prob, trueOver)
    : null;

  const u25edge = u25prob != null && trueUnder != null
    ? calcEdge(u25prob, trueUnder)
    : null;

  return {
    modelVersion: MODEL_VERSION,
    timestamp: new Date().toISOString(),
    direction,
    marketMarginPct: margin,  // stored for transparency / tracking

    o25: {
      probability:         o25prob,
      fairOdds:            o25fair,
      marketOdds:          overPrice,
      trueMarketProb:      trueOver,   // margin-stripped market view
      bookmaker:           match.odds?.o25?.bookmaker    || null,
      bookmakerKey:        match.odds?.o25?.bookmakerKey || null,
      edge:                o25edge,
    },

    u25: {
      probability:         u25prob,
      fairOdds:            u25fair,
      marketOdds:          underPrice,
      trueMarketProb:      trueUnder,  // margin-stripped market view
      bookmaker:           match.odds?.u25?.bookmaker    || null,
      bookmakerKey:        match.odds?.u25?.bookmakerKey || null,
      edge:                u25edge,
    },
  };
}

module.exports = {
  estimateO25,
  fairOdds,
  removeMargin,
  calcEdge,
  analyseMatch,
  MODEL_VERSION,
};