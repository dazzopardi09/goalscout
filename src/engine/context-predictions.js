// src/engine/context-predictions.js
// ─────────────────────────────────────────────────────────────
// Stage 10 — context_raw live paper-tracking.
//
// Logs context_raw predictions to predictions.jsonl alongside
// (but explicitly separate from) current/calibrated_current
// predictions.
//
// Per-league probability decisions (Stage 9 calibration):
//
//   England O2.5:
//     Calibration REJECTED (global Platt overcorrected 60–75% range).
//     context_o25_prob_calibrated = null
//     context_prob_used = context_o25_prob_raw
//     context_prob_source = 'raw'
//     context_prob_overstated = true  when rawProb > 0.75
//
//   Germany O2.5, grade A or A+:
//     Calibration ACCEPTED (Platt v1: A=0.817704, B=0.037095).
//     context_o25_prob_calibrated = Platt-adjusted value
//     context_prob_used = context_o25_prob_calibrated
//     context_prob_source = 'calibrated_platt_v1'
//
//   Germany O2.5, grade B:
//     Calibrated B overshoots actual by +9.2pp — do NOT use calibrated.
//     context_o25_prob_calibrated stored as informational reference only
//     context_prob_used = context_o25_prob_raw
//     context_prob_source = 'raw_b_grade'
//
//   Netherlands and all other leagues:
//     Always raw. Diagnostic/paper-track only.
//
// Deduplication:
//   Keyed on fixtureId + predictionDate + modelVersion.
//   This is DIFFERENT from logPrediction() which keys on
//   fixtureId + predictionDate only. Context and current/calibrated
//   records can coexist in the same file for the same fixture.
//
// Settlement:
//   Records use modelProbability = context_prob_used so that
//   existing settler logic (modelProbability > 0.5) works correctly.
//   VERIFY: settler.js must use fixtureId from predictions.jsonl
//   (match.id / SoccerSTATS ID) when looking up results.
//   Run the compatibility check below before deploying.
// ─────────────────────────────────────────────────────────────

'use strict';

const fs   = require('fs');
const path = require('path');

const config             = require('../config');
const { getCalibratedProb } = require('./context-calibration');

// ── Constants ─────────────────────────────────────────────────

const MODEL_VERSION = 'context_raw_v1.2';

// ── File helpers ──────────────────────────────────────────────

function readJSONL(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return content
      .split('\n')
      .filter(l => l.trim())
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function appendJSONL(filePath, record) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf8');
}

// ── Probability block builder ─────────────────────────────────

/**
 * Build the 5 required probability fields for a context prediction.
 *
 * @param {string} league        - 'england' | 'germany' | 'netherlands' | ...
 * @param {string} direction     - 'o25' | 'u25'
 * @param {string} grade         - 'A+' | 'A' | 'B'
 * @param {number} rawProb       - raw context_raw probability (0–1)
 *
 * @returns {{
 *   context_o25_prob_raw:        number,
 *   context_o25_prob_calibrated: number|null,
 *   context_prob_used:           number,
 *   context_prob_source:         string,
 *   context_prob_overstated:     boolean
 * }}
 */
function buildProbabilityBlock(league, direction, grade, rawProb) {
  const calResult = getCalibratedProb({ league, direction, grade, rawProb });

  // context_o25_prob_calibrated is always populated where calibration exists,
  // even for Germany B (stored for reference, not used for decisions).
  let calibratedForStorage = null;

  if (league === 'germany' && direction === 'o25') {
    // For Germany, always compute the Platt output for the record,
    // regardless of whether it's the "used" value.
    // getCalibratedProb returns the raw value for grade B, so we need
    // to separately compute what the calibrated value would be.
    const { getParams } = require('./context-calibration');
    const params = getParams('germany', 'o25');
    if (params) {
      // Apply Platt sigmoid directly for storage
      const A = params.A, B = params.B;
      const sigmoid = x => x >= 0 ? 1 / (1 + Math.exp(-x)) : Math.exp(x) / (1 + Math.exp(x));
      calibratedForStorage = Math.round(sigmoid(A * rawProb + B) * 10000) / 10000;
    }
  }

  return {
    context_o25_prob_raw:         rawProb,
    context_o25_prob_calibrated:  calibratedForStorage,
    context_prob_used:            Math.round(calResult.prob * 10000) / 10000,
    context_prob_source:          calResult.source,
    context_prob_overstated:      calResult.isOverstated,
  };
}

// ── Main logging function ─────────────────────────────────────

/**
 * Log a context_raw prediction to predictions.jsonl.
 *
 * Called once per match per refresh cycle, for England and Germany
 * fixtures where context_raw generates a prediction.
 *
 * Deduplication is keyed on fixtureId + predictionDate + modelVersion,
 * so context predictions coexist cleanly with current/calibrated ones.
 *
 * @param {object} match       - live match object (from shortlist pipeline)
 * @param {object} scored      - result of scoreContext(homeRolling, awayRolling, ...)
 * @param {object} homeRolling - rolling stats for home team (from rolling-stats.js)
 * @param {object} awayRolling - rolling stats for away team (from rolling-stats.js)
 */
function logContextPrediction(match, scored, homeRolling, awayRolling, selectionType) {
  if (scored.skip) return;  // model passed on this fixture — nothing to log

  const today      = new Date().toISOString().slice(0, 10);
  const fixtureId  = match.id;
  const league     = match.leagueSlug || match.league;  // normalised to slug
  const direction  = scored.direction;   // 'o25' | 'u25'
  const grade      = scored.grade;       // 'A+' | 'A' | 'B'
  const rawProb    = scored.context_o25_prob_raw;

  // ── Deduplication ──────────────────────────────────────────
  // Key: fixtureId + predictionDate + modelVersion.
  // This allows context and current model predictions to coexist.
  const existing      = readJSONL(config.PREDICTIONS_FILE);
  const alreadyLogged = existing.some(p =>
    p.fixtureId       === fixtureId   &&
    p.predictionDate  === today       &&
    p.modelVersion    === MODEL_VERSION
  );
  if (alreadyLogged) return;

  // ── Build probability block ────────────────────────────────
  const probBlock = buildProbabilityBlock(league, direction, grade, rawProb);

  // ── Build market odds snippet from match.odds if available ─
  // O2.5 odds come from The-Odds-API totals market.
  // These are tip-time odds — closing odds arrive at settlement.
  const oddsData = direction === 'o25'
    ? (match.odds?.o25 || null)
    : (match.odds?.u25 || null);
  const marketOdds = oddsData?.price  ?? null;
  const bookmaker  = oddsData?.bookmaker ?? null;
  const fairOdds   = scored.fairOdds;
  const edge       = (marketOdds && fairOdds)
    ? Math.round(((marketOdds / fairOdds) - 1) * 10000) / 100
    : null;

  // ── Settle-compatible fields ───────────────────────────────
  // modelProbability = context_prob_used so that settler's
  // "(modelProbability > 0.5 && result.over25)" check works correctly.
  // market = 'over_2.5' regardless of direction, because:
  //   - O2.5 predictions: modelProbability (= context_prob_used > 0.5) → settled as Over
  //   - U2.5 predictions: modelProbability (= context_u25_prob) may be < 0.5
  //     but we store market: 'under_2.5' explicitly for U2.5 so settlement
  //     code that handles 'under_2.5' can use it, and 'over_2.5' logic ignores it.
  const market    = direction === 'o25' ? 'over_2.5' : 'under_2.5';
  const selection = direction === 'o25' ? 'over'      : 'under';

  // For U2.5 predictions, context_prob_used is the U2.5 probability.
  // For O2.5 predictions, it's the O2.5 probability.
  const modelProbability = direction === 'o25'
    ? probBlock.context_prob_used
    : scored.context_u25_prob_raw;  // U2.5 always raw (no calibrator deployed)

  const record = {
    // ── Identity ────────────────────────────────────────────
    fixtureId,
    predictionDate:       today,
    predictionTimestamp:  new Date().toISOString(),
    modelVersion:         MODEL_VERSION,

    // method is used by settler.js as a join key alongside fixtureId + market.
    // Must be distinct from 'current' and 'calibrated' so context predictions
    // are settled separately from current-model predictions for the same fixture.
    // Settler calls: settlePrediction(p.fixtureId, p.market, p.method || 'current', {...})
    method:               'context_raw',

    // status:'pending' is required — settler filters predictions.filter(p => p.status === 'pending')
    status:               'pending',
    selectionType:        selectionType || null,

    league:               match.league,
    leagueSlug:           league,
    homeTeam:             match.homeTeam,
    awayTeam:             match.awayTeam,
    kickoff:              match.kickoff   ?? null,
    day:                  match.day       ?? null,
    commenceTime:         match.odds?.commenceTime ?? null,

    // ── Context model prediction ─────────────────────────────
    context_direction:       direction,
    direction:               direction,   // settlement-compatible alias (o25|u25)
    context_grade:           grade,
    context_o25_score:       scored.o25Score,
    context_u25_score:       scored.u25Score,
    context_winning_score:   scored.winningScore,

    // ── Probability fields (Stage 9 calibration) ─────────────
    // context_o25_prob_raw:        raw model output (always present)
    // context_o25_prob_calibrated: Platt-adjusted value (null for England)
    // context_prob_used:           the probability used for decisions
    // context_prob_source:         how context_prob_used was derived
    // context_prob_overstated:     flag for England rawProb > 0.75
    ...probBlock,

    context_fair_odds:       fairOdds,

    // ── Settlement-compatible fields ─────────────────────────
    // These match the schema that settler.js and getPredictionStats
    // already use. Do NOT rename without checking settler.js.
    market,
    selection,
    modelProbability,      // = context_prob_used (O2.5) or u25_raw (U2.5)
    fairOdds,
    marketOdds,            // tip-time odds (null if Odds API unavailable)
    bookmaker,
    edge,

    // ── Rolling inputs snapshot (for calibration review) ─────
    homeRolling: homeRolling ? {
      teamName:             homeRolling.teamName,
      gf_avg:               homeRolling.gf_avg,
      ga_avg:               homeRolling.ga_avg,
      fts_count:            homeRolling.fts_count,
      scored2plus_count:    homeRolling.scored2plus_count,
      conceded2plus_count:  homeRolling.conceded2plus_count,
      o25_count:            homeRolling.o25_count,
      games_available:      homeRolling.games_available,
    } : null,
    awayRolling: awayRolling ? {
      teamName:             awayRolling.teamName,
      gf_avg:               awayRolling.gf_avg,
      ga_avg:               awayRolling.ga_avg,
      fts_count:            awayRolling.fts_count,
      scored2plus_count:    awayRolling.scored2plus_count,
      conceded2plus_count:  awayRolling.conceded2plus_count,
      o25_count:            awayRolling.o25_count,
      games_available:      awayRolling.games_available,
    } : null,

    // features: structured input snapshot captured at decision time.
    // Added Task 2. New records only — old records simply lack this field.
    // Existing top-level fields (homeRolling, awayRolling, context_* probability
    // fields, context_grade, etc.) are preserved unchanged for compatibility.
    features: {
      source: 'football_data_org_rolling',

      homeRolling: homeRolling ? {
        teamName:            homeRolling.teamName,
        gf_avg:              homeRolling.gf_avg,
        ga_avg:              homeRolling.ga_avg,
        fts_count:           homeRolling.fts_count,
        scored2plus_count:   homeRolling.scored2plus_count,
        conceded2plus_count: homeRolling.conceded2plus_count,
        o25_count:           homeRolling.o25_count,
        games_available:     homeRolling.games_available,
      } : null,
      awayRolling: awayRolling ? {
        teamName:            awayRolling.teamName,
        gf_avg:              awayRolling.gf_avg,
        ga_avg:              awayRolling.ga_avg,
        fts_count:           awayRolling.fts_count,
        scored2plus_count:   awayRolling.scored2plus_count,
        conceded2plus_count: awayRolling.conceded2plus_count,
        o25_count:           awayRolling.o25_count,
        games_available:     awayRolling.games_available,
      } : null,

      o25Score:     scored.o25Score     ?? null,
      u25Score:     scored.u25Score     ?? null,
      winningScore: scored.winningScore ?? null,
      grade:        scored.grade        ?? null,
      flags:        scored.flags        ?? null,
      signals:      scored.signals      ?? null,

      contextO25ProbRaw:        scored.context_o25_prob_raw              ?? null,
      contextU25ProbRaw:        scored.context_u25_prob_raw              ?? null,
      contextO25ProbCalibrated: probBlock.context_o25_prob_calibrated    ?? null,
      contextProbUsed:          probBlock.context_prob_used              ?? null,
      contextProbSource:        probBlock.context_prob_source            ?? null,
      contextProbOverstated:    probBlock.context_prob_overstated        ?? null,
    },
  };

  appendJSONL(config.PREDICTIONS_FILE, record);

  console.log(
    `[context] logged ${direction.toUpperCase()} ${grade} prediction` +
    ` ${match.homeTeam} v ${match.awayTeam}` +
    ` prob_used=${(probBlock.context_prob_used * 100).toFixed(1)}%` +
    ` source=${probBlock.context_prob_source}` +
    (probBlock.context_prob_overstated ? ' [OVERSTATED]' : '')
  );
}

// ── Batch helper ──────────────────────────────────────────────

/**
 * Log context predictions for a batch of matches.
 * Filters to England and Germany only.
 * Logs nothing for skipped predictions (scored.skip === true).
 *
 * @param {Array<{match, scored, homeRolling, awayRolling}>} items
 */
function logContextPredictions(items) {
  const SUPPORTED = new Set(['england', 'germany']);
  let logged = 0;

  for (const item of items) {
    const { match, scored, homeRolling, awayRolling } = item;
    const slug = match.leagueSlug || match.league;
    if (!SUPPORTED.has(slug)) continue;
    if (scored.skip) continue;

    logContextPrediction(match, scored, homeRolling, awayRolling, item.selectionType || null);
    logged++;
  }

  if (logged > 0) {
    console.log(`[context] logged ${logged} predictions this refresh`);
  }
}

module.exports = {
  logContextPrediction,
  logContextPredictions,
  buildProbabilityBlock,
  MODEL_VERSION,
};