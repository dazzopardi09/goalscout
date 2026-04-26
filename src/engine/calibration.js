// src/engine/calibration.js
// ─────────────────────────────────────────────────────────────
// Stage 9 — Calibration loader and probability adjuster.
//
// Applies trained Platt scaling parameters to raw context_raw
// probabilities. Returns calibrated probability where a valid
// calibrator exists, raw probability otherwise.
//
// Per-league decisions (Stage 9 analysis):
//
//   England O2.5:
//     No calibrator. Global Platt was rejected — it fixed the
//     75%+ bucket but destroyed accuracy in the 60-75% range.
//     Raw probabilities are used directly.
//     Predictions with rawProb > 0.75 are flagged as overstated.
//
//   Germany O2.5:
//     Calibrator v1 accepted for A+ and A grades only.
//     B grade: use raw — calibrated B overshoots actual by +9.2pp.
//
// Calibration parameter files live at:
//   data/calibration/{league}_{direction}_v1.json
//
// These files are gitignored (data/ is excluded).
// Parameters are also documented in scripts/context/CALIBRATION-REPORT.md.
// ─────────────────────────────────────────────────────────────

'use strict';

const fs   = require('fs');
const path = require('path');

const config = require('../config');

// ── Constants ─────────────────────────────────────────────────

// Probabilities above this threshold in England O2.5 are known
// to be systematically overstated (~25pp above actual hit rate
// in the 75%+ bucket on the 2023-24 and 2024-25 test set).
const ENGLAND_OVERSTATE_THRESHOLD = 0.75;

// Grades for which Germany calibration is applied.
// B grade calibrated probability overshoots actual by +9.2pp —
// worse than raw. Use raw for B.
const GERMANY_CALIBRATED_GRADES = new Set(['A+', 'A']);

// ── Parameter cache ───────────────────────────────────────────
// Loaded once per process, keyed by "{league}_{direction}_v1"

const _cache = {};

function loadParams(league, direction) {
  const key  = `${league}_${direction}_v1`;
  if (_cache[key]) return _cache[key];

  const file = path.join(config.DATA_DIR, 'calibration', `${key}.json`);
  if (!fs.existsSync(file)) return null;

  try {
    const params = JSON.parse(fs.readFileSync(file, 'utf8'));
    _cache[key]  = params;
    return params;
  } catch (e) {
    console.warn(`[calibration] failed to load ${file}: ${e.message}`);
    return null;
  }
}

// ── Platt sigmoid ─────────────────────────────────────────────

function sigmoid(x) {
  return x >= 0 ? 1 / (1 + Math.exp(-x)) : Math.exp(x) / (1 + Math.exp(x));
}

function applyPlatt(rawProb, A, B) {
  return sigmoid(A * rawProb + B);
}

// ── Public API ────────────────────────────────────────────────

/**
 * Get the calibrated probability for a prediction.
 *
 * @param {object} opts
 * @param {string}  opts.league     - e.g. 'england', 'germany'
 * @param {string}  opts.direction  - 'o25' or 'u25'
 * @param {string}  opts.grade      - 'A+', 'A', or 'B'
 * @param {number}  opts.rawProb    - raw model probability (0–1)
 *
 * @returns {object} {
 *   prob: number,           // probability to use (calibrated or raw)
 *   isCalibrated: boolean,  // true if Platt was applied
 *   isOverstated: boolean,  // true if raw prob > ENGLAND_OVERSTATE_THRESHOLD
 *   source: string,         // 'calibrated_platt_v1' | 'raw' | 'raw_b_grade'
 * }
 */
function getCalibratedProb({ league, direction, grade, rawProb }) {
  const isOverstated =
    league === 'england' &&
    direction === 'o25' &&
    rawProb > ENGLAND_OVERSTATE_THRESHOLD;

  // England O2.5 — always raw (calibration rejected at Stage 9)
  if (league === 'england') {
    return {
      prob:          rawProb,
      isCalibrated:  false,
      isOverstated,
      source:        'raw',
    };
  }

  // Germany O2.5 — calibrate A/A+ only
  if (league === 'germany' && direction === 'o25') {
    if (!GERMANY_CALIBRATED_GRADES.has(grade)) {
      // B grade: calibrated probability overshoots actual by +9.2pp
      // Use raw and tag it for separate monitoring
      return {
        prob:          rawProb,
        isCalibrated:  false,
        isOverstated:  false,
        source:        'raw_b_grade',
      };
    }

    const params = loadParams('germany', 'o25');
    if (!params) {
      console.warn('[calibration] germany_o25_v1.json not found — falling back to raw');
      return { prob: rawProb, isCalibrated: false, isOverstated: false, source: 'raw_fallback' };
    }

    const calibratedProb = applyPlatt(rawProb, params.A, params.B);
    return {
      prob:          calibratedProb,
      isCalibrated:  true,
      isOverstated:  false,
      source:        'calibrated_platt_v1',
    };
  }

  // All other leagues or directions — raw only (not validated at Stage 9)
  return {
    prob:          rawProb,
    isCalibrated:  false,
    isOverstated:  false,
    source:        'raw',
  };
}

/**
 * Whether a valid calibrator exists for this league + direction.
 * Useful for logging decisions.
 */
function hasCalibrator(league, direction) {
  if (league === 'england') return false;  // rejected
  const params = loadParams(league, direction);
  return params != null && params.passFail?.overall !== 'UNRELIABLE';
}

/**
 * Return the raw Platt parameters for a league + direction,
 * or null if no valid calibrator exists.
 */
function getParams(league, direction) {
  return loadParams(league, direction);
}

module.exports = {
  getCalibratedProb,
  hasCalibrator,
  getParams,
  ENGLAND_OVERSTATE_THRESHOLD,
  GERMANY_CALIBRATED_GRADES,
};