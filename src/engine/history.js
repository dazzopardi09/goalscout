// src/engine/history.js
// ─────────────────────────────────────────────────────────────
// Historical prediction logger and performance evaluator.
//
// Files managed (all JSONL, append-only, never overwritten):
//   predictions.jsonl  — one line per market per match
//   results.jsonl      — one line per settled fixture
//   closing-odds.jsonl — one line per closing odds capture
//
// Core principle: prediction records are immutable once written.
// Settlement and evaluation are derived by joining the files at
// read time — no mutation of source records ever.
// ─────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const config = require('../config');

// ── File helpers ─────────────────────────────────────────────

function ensureHistoryDir() {
  const dir = config.HISTORY_DIR;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function appendJSONL(filePath, obj) {
  ensureHistoryDir();
  const line = JSON.stringify(obj) + '\n';
  fs.appendFileSync(filePath, line, 'utf8');
}

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

// ── Prediction logging ────────────────────────────────────────

/**
 * Log a prediction for a match.
 * Deduplicates by fixtureId alone — once a fixture is logged, it is never
 * logged again even if it appears on subsequent refresh cycles (e.g. a
 * "tomorrow" match that rolls into "today"). This ensures each real-world
 * match counts exactly once in performance metrics.
 */
function logPrediction(match, analysis) {
  const today = new Date().toISOString().slice(0, 10);
  const fixtureId = match.id;

  const existing = readJSONL(config.PREDICTIONS_FILE);
  const alreadyLogged = existing.some(p => p.fixtureId === fixtureId);
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

// ── Result logging ────────────────────────────────────────────

/**
 * Log a match result. Called by settler.js when scores are confirmed.
 *
 * matchStatus values:
 *   'completed'  — full time score confirmed, used in metrics
 *   'postponed'  — fixture postponed, treated as void
 *   'cancelled'  — fixture cancelled before KO, treated as void
 *   'abandoned'  — abandoned mid-match, treated as void
 *   'unknown'    — >36h with no result found, treated as void
 */
function logResult(fixtureId, result) {
  const status = result.matchStatus || 'completed';
  const isCompleted = status === 'completed';

  appendJSONL(config.RESULTS_FILE, {
    fixtureId,
    settledAt: new Date().toISOString(),
    matchStatus: status,
    source: result.source || 'manual',
    fullTimeHome: isCompleted ? result.homeGoals : null,
    fullTimeAway: isCompleted ? result.awayGoals : null,
    totalGoals: isCompleted ? result.homeGoals + result.awayGoals : null,
    over25: isCompleted ? (result.homeGoals + result.awayGoals) > 2.5 : null,
    bttsYes: isCompleted ? result.homeGoals > 0 && result.awayGoals > 0 : null,
    halfTimeHome: result.htHome ?? null,
    halfTimeAway: result.htAway ?? null,
  });
}

// ── Performance evaluation ────────────────────────────────────

/**
 * Compute comprehensive prediction performance statistics.
 * Joins predictions, results, and closing odds at read time.
 * Immutable source files are never touched.
 */
function getPredictionStats() {
  const predictions = readJSONL(config.PREDICTIONS_FILE);
  const results = readJSONL(config.RESULTS_FILE);
  const closingOdds = readJSONL(config.CLOSING_ODDS_FILE);

  const now = new Date();

  // Build lookup maps
  const resultMap = new Map();
  for (const r of results) {
    if (!resultMap.has(r.fixtureId)) resultMap.set(r.fixtureId, r);
  }

  const closingMap = new Map();
  for (const c of closingOdds) {
    closingMap.set(`${c.fixtureId}__${c.market}`, c.decimalOdds);
  }

  // Deduplicate predictions by fixtureId + market — keep the earliest entry.
  // Duplicates arise when a fixture appears across multiple refresh cycles
  // (e.g. logged as "tomorrow" then again as "today"). Each real match
  // should count exactly once in performance metrics.
  const dedupedPredictions = [];
  const seenFixtureMarket = new Set();
  for (const p of predictions) {
    const key = `${p.fixtureId}__${p.market}`;
    if (!seenFixtureMarket.has(key)) {
      seenFixtureMarket.add(key);
      dedupedPredictions.push(p);
    }
  }

  // Classify each prediction
  const classified = dedupedPredictions.map(p => {
    const result = resultMap.get(p.fixtureId) || null;
    const closingKey = `${p.fixtureId}__${p.market}`;
    const closingPrice = closingMap.get(closingKey) || null;

    let status;
    if (!result) {
      const kickoff = estimateKickoffDate(p);
      if (kickoff && (now - kickoff) / 60000 > 120) {
        status = 'awaiting_result';
      } else {
        status = 'pending';
      }
    } else if (result.matchStatus !== 'completed') {
      status = 'void';
    } else {
      const actual = getActualOutcome(p, result);
      status = actual === null ? 'settled_unknown'
             : actual ? 'settled_won' : 'settled_lost';
    }

    // CLV: positive = beat the close (value captured)
    let clvPct = null;
    if (p.marketOdds && closingPrice) {
      const raw = (closingPrice / p.marketOdds - 1) * 100;
      clvPct = Math.round(-raw * 100) / 100;
    }

    // Brier score contribution
    let brierContrib = null;
    if ((status === 'settled_won' || status === 'settled_lost') && p.modelProbability != null) {
      const outcome = status === 'settled_won' ? 1 : 0;
      brierContrib = Math.pow(p.modelProbability - outcome, 2);
    }

    return { ...p, status, result, closingPrice, clvPct, brierContrib };
  });

  // Aggregate totals
  const total = classified.length;
  const pending = classified.filter(p => p.status === 'pending').length;
  const awaiting = classified.filter(p => p.status === 'awaiting_result').length;
  const voidCount = classified.filter(p => p.status === 'void').length;
  const settled = classified.filter(p => p.status === 'settled_won' || p.status === 'settled_lost');
  const won = settled.filter(p => p.status === 'settled_won').length;
  const voidRate = (voidCount + settled.length) > 0
    ? Math.round(voidCount / (voidCount + settled.length) * 1000) / 10
    : null;

  // Per-market metrics
  const markets = {};
  for (const market of ['over_2.5', 'btts']) {
    const mPreds = classified.filter(p => p.market === market);
    const mSettled = mPreds.filter(p => p.status === 'settled_won' || p.status === 'settled_lost');
    const mWon = mSettled.filter(p => p.status === 'settled_won');

    const brierValues = mSettled.map(p => p.brierContrib).filter(v => v != null);
    const brierScore = brierValues.length > 0
      ? Math.round(brierValues.reduce((s, v) => s + v, 0) / brierValues.length * 10000) / 10000
      : null;

    const edgeValues = mPreds.filter(p => p.edge != null).map(p => p.edge);
    const meanEdge = edgeValues.length > 0
      ? Math.round(edgeValues.reduce((s, v) => s + v, 0) / edgeValues.length * 100) / 100
      : null;

    const clvValues = mSettled.filter(p => p.clvPct != null).map(p => p.clvPct);
    const meanCLV = clvValues.length > 0
      ? Math.round(clvValues.reduce((s, v) => s + v, 0) / clvValues.length * 100) / 100
      : null;

    const probValues = mPreds.map(p => p.modelProbability).filter(v => v != null);
    const meanModelProb = probValues.length > 0
      ? Math.round(probValues.reduce((s, v) => s + v, 0) / probValues.length * 1000) / 10
      : null;

    markets[market] = {
      total: mPreds.length,
      pending: mPreds.filter(p => p.status === 'pending').length,
      awaiting: mPreds.filter(p => p.status === 'awaiting_result').length,
      void: mPreds.filter(p => p.status === 'void').length,
      settled: mSettled.length,
      won: mWon.length,
      hitRate: mSettled.length > 0
        ? Math.round(mWon.length / mSettled.length * 1000) / 10 : null,
      brierScore,
      meanEdgePct: meanEdge,
      meanCLVPct: meanCLV,
      clvSampleSize: clvValues.length,
      meanModelProb,
    };
  }

  // Model version breakdown
  const versionCounts = {};
  for (const p of classified) {
    const v = p.modelVersion || 'unknown';
    if (!versionCounts[v]) versionCounts[v] = { total: 0, settled: 0, won: 0 };
    versionCounts[v].total++;
    if (p.status === 'settled_won' || p.status === 'settled_lost') {
      versionCounts[v].settled++;
      if (p.status === 'settled_won') versionCounts[v].won++;
    }
  }
  const byModelVersion = Object.entries(versionCounts).map(([version, counts]) => ({
    version,
    total: counts.total,
    settled: counts.settled,
    hitRate: counts.settled > 0
      ? Math.round(counts.won / counts.settled * 1000) / 10 : null,
  }));

  // Recent settled predictions for UI table
  const recentSettled = classified
    .filter(p => p.status === 'settled_won' || p.status === 'settled_lost')
    .sort((a, b) => new Date(b.predictionTimestamp) - new Date(a.predictionTimestamp))
    .slice(0, 20)
    .map(p => ({
      fixtureId: p.fixtureId,
      predictionDate: p.predictionDate,
      homeTeam: p.homeTeam,
      awayTeam: p.awayTeam,
      league: p.league,
      market: p.market,
      modelProbability: p.modelProbability,
      fairOdds: p.fairOdds,
      marketOdds: p.marketOdds,
      edge: p.edge,
      closingOdds: p.closingPrice,
      clvPct: p.clvPct,
      status: p.status,
      score: p.result ? `${p.result.fullTimeHome}–${p.result.fullTimeAway}` : null,
      modelVersion: p.modelVersion,
    }));

  return {
    generatedAt: now.toISOString(),
    summary: { total, pending, awaiting, void: voidCount, settled: settled.length, won, voidRatePct: voidRate },
    markets,
    byModelVersion,
    recentSettled,
  };
}

// ── Internal helpers ──────────────────────────────────────────

function getActualOutcome(prediction, result) {
  if (result.matchStatus !== 'completed') return null;
  if (prediction.market === 'over_2.5') return result.over25 ?? null;
  if (prediction.market === 'btts') return result.bttsYes ?? null;
  return null;
}

function estimateKickoffDate(prediction) {
  if (prediction.commenceTime) return new Date(prediction.commenceTime);
  if (!prediction.predictionDate || !prediction.kickoff) return null;
  try {
    const [hh, mm] = prediction.kickoff.split(':').map(Number);
    return new Date(`${prediction.predictionDate}T${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}:00+10:00`);
  } catch { return null; }
}

module.exports = { logPrediction, logResult, readJSONL, getPredictionStats };