const fs = require('fs');
const path = require('path');
const config = require('../config');

let cache = null;

function loadCalibrationMap() {
  if (cache) return cache;

  const file = path.join(config.DATA_DIR, 'calibration', 'league-calibration.json');

  if (!fs.existsSync(file)) {
    cache = {};
    return cache;
  }

  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));

  // convert array → map by leagueKey
  cache = Object.fromEntries(raw.map(r => [r.leagueKey, r]));
  return cache;
}

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

function logit(p) {
  const eps = 1e-6;
  const pp = Math.min(Math.max(p, eps), 1 - eps);
  return Math.log(pp / (1 - pp));
}

function applyCalibration(rawProb, leagueKey) {
  if (typeof rawProb !== 'number') return rawProb;

  const maps = loadCalibrationMap();
  const cfg = maps[leagueKey];

  if (!cfg) return rawProb;

  return Math.round(
    sigmoid((cfg.A * logit(rawProb)) + cfg.B) * 10000
  ) / 10000;
}

module.exports = {
  applyCalibration,
};