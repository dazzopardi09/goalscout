// src/engine/probability.js
// ─────────────────────────────────────────────────────────────
// Probability estimation engine — O2.5 and U2.5.
//
// P(Over 2.5) is estimated from weighted team/league stats.
// P(Under 2.5) = 1 - P(Over 2.5).
//
// ── Edge calculation ───────────────────────────────────────
//
// Edge is calculated as:
//
//   edge = (marketOdds / fairOdds - 1) * 100
//        = (modelProbability * marketOdds - 1) * 100
//
// Positive edge = available odds exceed model fair odds → value bet
// Negative edge = available odds are below model fair odds → avoid
//
// This is the operationally correct formula for betting decisions
// because it directly answers: "does the price I can actually get
// exceed what my model says it's worth?"
//
// ── Why devigging is NOT used for the main edge field ──────
//
// removeMargin() (below) can strip bookmaker margin from a two-way
// market to produce "true" market probabilities. However, this is
// only valid when BOTH the Over AND Under prices come from the
// SAME bookmaker at the SAME moment.
//
// GoalScout currently stores the BEST Over price across all books
// and the BEST Under price across all books. These may come from
// completely different bookmakers (e.g. Over from William Hill,
// Under from Matchbook). Devigging a synthetic cross-book market
// produces a meaningless "true probability" and therefore a
// misleading edge figure.
//
// removeMargin() is preserved for future use when same-bookmaker
// both-sides prices are available (e.g. Betfair Exchange, or a
// single-book odds fetch).
//
// ── Calibration ────────────────────────────────────────────
//
// Weights are starting estimates. At 200+ settled predictions,
// compare mean model probability to actual hit rate per direction
// and minimise Brier score independently for O2.5 and U2.5.
// ─────────────────────────────────────────────────────────────

const MODEL_VERSION = 'baseline-v1.1';

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
    // meanTG: average total-goals profile across both teams.
    // Using mean (not sum) because both avgTG values are estimates
    // of the same fixture-level quantity — adding them double-counts.
    // Anchors: meanTG 1.8 → 0.10 (floor), 2.5 → 0.50 (neutral), 3.0 → 0.79, 3.5 → 0.95 (cap)
    const meanTG = (h.avgTG + a.avgTG) / 2;
    const tgSignal = Math.min(0.95, Math.max(0.10, (meanTG - 1.625) / 1.75));
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
 * ⚠ IMPORTANT: Only valid when BOTH prices are from the SAME bookmaker
 * at the SAME time. Do NOT use with cross-book best prices (best Over
 * from one book, best Under from another) — the result is meaningless.
 *
 * Preserved for future use with same-bookmaker or exchange data.
 *
 * Returns:
 *   trueOver  — market's margin-free probability for Over 2.5
 *   trueUnder — market's margin-free probability for Under 2.5
 *   margin    — bookmaker's margin as a percentage (e.g. 2.9%)
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
    margin:    Math.round((total - 1) * 10000) / 100,
  };
}

/**
 * Calculate actionable edge percentage.
 *
 * edge = (marketOdds / fairOdds - 1) * 100
 *
 * Positive = available odds exceed model fair odds → value bet
 * Negative = available odds are below model fair odds → avoid
 *
 * fairOdds = 1 / modelProbability, so this is equivalent to:
 *   edge = (modelProbability * marketOdds - 1) * 100
 *
 * Uses the actual available price — not a devigged cross-book
 * synthetic probability. See module comment for why.
 */
function calcEdge(marketOdds, fairOddsVal) {
  if (!marketOdds || !fairOddsVal) return null;
  return Math.round(((marketOdds / fairOddsVal) - 1) * 10000) / 100;
}

/**
 * Full probability analysis for a match.
 *
 * Uses match.direction ('o25' or 'u25', set by shortlist.js) to
 * determine which market side to measure edge against.
 *
 * Both sides of the market are always captured. removeMargin() is
 * called for transparency (margin is stored) but is NOT used for
 * the main edge field — see module comment.
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

  // Margin stored for transparency — NOT used for edge (cross-book prices)
  const { margin } = removeMargin(overPrice, underPrice);

  // Edge: available price vs model fair odds (actionable, consistent with UI)
  const o25edge = (overPrice  != null && o25fair != null)
    ? calcEdge(overPrice,  o25fair)
    : null;

  const u25edge = (underPrice != null && u25fair != null)
    ? calcEdge(underPrice, u25fair)
    : null;

  return {
    modelVersion: MODEL_VERSION,
    timestamp: new Date().toISOString(),
    direction,
    marketMarginPct: margin,

    o25: {
      probability:    o25prob,
      fairOdds:       o25fair,
      marketOdds:     overPrice,
      bookmaker:      match.odds?.o25?.bookmaker    || null,
      bookmakerKey:   match.odds?.o25?.bookmakerKey || null,
      edge:           o25edge,
    },

    u25: {
      probability:    u25prob,
      fairOdds:       u25fair,
      marketOdds:     underPrice,
      bookmaker:      match.odds?.u25?.bookmaker    || null,
      bookmakerKey:   match.odds?.u25?.bookmakerKey || null,
      edge:           u25edge,
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