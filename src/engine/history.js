// src/engine/history.js
// ─────────────────────────────────────────────────────────────
// Historical prediction logger.
//
// This is the MINIMUM storage needed to evaluate whether the
// model is working, per the lean data model spec:
//
// Each prediction record contains:
//   - fixture identity (teams, league, date)
//   - timestamp of prediction
//   - market (o25 / btts)
//   - model probability
//   - fair odds
//   - market odds at prediction time
//   - bookmaker
//   - model version
//
// Results are logged separately when available.
//
// Format: JSONL (one JSON object per line) — append-only.
// This is NOT overwritten on refresh. It accumulates.
// ─────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const config = require('../config');

function ensureHistoryDir() {
  const dir = config.HISTORY_DIR;
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Append a line to a JSONL file.
 */
function appendJSONL(filePath, obj) {
  ensureHistoryDir();
  const line = JSON.stringify(obj) + '\n';
  fs.appendFileSync(filePath, line, 'utf8');
}

/**
 * Read all lines from a JSONL file.
 */
function readJSONL(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return content
      .split('\n')
      .filter(line => line.trim())
      .map(line => {
        try { return JSON.parse(line); }
        catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Log a prediction for a match.
 * Called once per match per market per refresh cycle.
 *
 * We deduplicate by fixture_id + market + date to avoid
 * logging the same prediction multiple times on the same day.
 */
function logPrediction(match, analysis) {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const fixtureId = match.id;

  // Check if we already logged this fixture today
  const existing = readJSONL(config.PREDICTIONS_FILE);
  const alreadyLogged = existing.some(p =>
    p.fixtureId === fixtureId &&
    p.predictionDate === today
  );

  if (alreadyLogged) return;

  const base = {
    fixtureId,
    predictionDate: today,
    predictionTimestamp: new Date().toISOString(),
    modelVersion: analysis.modelVersion,
    league: match.league,
    leagueSlug: match.leagueSlug,
    homeTeam: match.homeTeam,
    awayTeam: match.awayTeam,
    kickoff: match.kickoff,
    day: match.day,
    commenceTime: match.odds?.commenceTime || null,
  };

  // Log O2.5 prediction
  if (analysis.o25.probability != null) {
    appendJSONL(config.PREDICTIONS_FILE, {
      ...base,
      market: 'over_2.5',
      selection: 'over',
      modelProbability: analysis.o25.probability,
      fairOdds: analysis.o25.fairOdds,
      marketOdds: analysis.o25.marketOdds,
      bookmaker: analysis.o25.bookmaker,
      edge: analysis.o25.edge,

      // Snapshot of key inputs for debugging
      inputs: {
        homeO25pct: match.home?.o25pct,
        awayO25pct: match.away?.o25pct,
        homeAvgTG: match.home?.avgTG,
        awayAvgTG: match.away?.avgTG,
        score: match.score,
        grade: match.grade,
      },
    });
  }

  // Log BTTS prediction
  if (analysis.btts.probability != null) {
    appendJSONL(config.PREDICTIONS_FILE, {
      ...base,
      market: 'btts',
      selection: 'yes',
      modelProbability: analysis.btts.probability,
      fairOdds: analysis.btts.fairOdds,
      marketOdds: analysis.btts.marketOdds,
      bookmaker: analysis.btts.bookmaker,
      edge: analysis.btts.edge,

      inputs: {
        homeBTSpct: match.home?.btsPct,
        awayBTSpct: match.away?.btsPct,
        homeFTSpct: match.home?.ftsPct,
        awayFTSpct: match.away?.ftsPct,
        homeCSpct: match.home?.csPct,
        awayCSpct: match.away?.csPct,
        score: match.score,
        grade: match.grade,
      },
    });
  }
}

/**
 * Log a match result. Called when results become available.
 * (This will be triggered by a separate results-checker job
 * that runs after matches finish — not built yet but the
 * logging structure is ready.)
 */
function logResult(fixtureId, result) {
  appendJSONL(config.RESULTS_FILE, {
    fixtureId,
    settledAt: new Date().toISOString(),
    fullTimeHome: result.homeGoals,
    fullTimeAway: result.awayGoals,
    totalGoals: result.homeGoals + result.awayGoals,
    over25: (result.homeGoals + result.awayGoals) > 2.5,
    bttsYes: result.homeGoals > 0 && result.awayGoals > 0,
    halfTimeHome: result.htHome ?? null,
    halfTimeAway: result.htAway ?? null,
  });
}

/**
 * Get prediction summary stats for evaluation.
 */
function getPredictionStats() {
  const predictions = readJSONL(config.PREDICTIONS_FILE);
  const results = readJSONL(config.RESULTS_FILE);

  const resultMap = new Map();
  for (const r of results) {
    resultMap.set(r.fixtureId, r);
  }

  let total = 0;
  let withResults = 0;
  let o25correct = 0;
  let o25total = 0;
  let bttsCorrect = 0;
  let bttsTotal = 0;

  for (const p of predictions) {
    total++;
    const result = resultMap.get(p.fixtureId);
    if (!result) continue;
    withResults++;

    if (p.market === 'over_2.5') {
      o25total++;
      // Did we predict Over and was it Over?
      if (p.modelProbability > 0.5 && result.over25) o25correct++;
      if (p.modelProbability <= 0.5 && !result.over25) o25correct++;
    }

    if (p.market === 'btts') {
      bttsTotal++;
      if (p.modelProbability > 0.5 && result.bttsYes) bttsCorrect++;
      if (p.modelProbability <= 0.5 && !result.bttsYes) bttsCorrect++;
    }
  }

  return {
    totalPredictions: total,
    withResults,
    o25: {
      total: o25total,
      correct: o25correct,
      accuracy: o25total > 0 ? Math.round((o25correct / o25total) * 10000) / 100 : null,
    },
    btts: {
      total: bttsTotal,
      correct: bttsCorrect,
      accuracy: bttsTotal > 0 ? Math.round((bttsCorrect / bttsTotal) * 10000) / 100 : null,
    },
  };
}

module.exports = {
  logPrediction,
  logResult,
  readJSONL,
  getPredictionStats,
};