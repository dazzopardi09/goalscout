// src/engine/history.js
// ─────────────────────────────────────────────────────────────
// Historical prediction logger and performance evaluator.
//
// Files managed (all JSONL, append-only, never overwritten):
//   predictions.jsonl  — one line per market per match
//   results.jsonl      — one line per settled fixture
//   closing-odds.jsonl — one line per closing odds capture
//
// Core principle: prediction records are immutable once written
// WITH complete data. The one exception: if a prediction was
// written without market odds (odds matching failed on first
// refresh), a second write is permitted when odds become
// available. The dedup logic at read time keeps the LAST
// complete record (i.e. the one with odds populated).
//
// Dedup key at READ time: fixtureId + market → keep last record
// where marketOdds is not null; fall back to first if none have odds.
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
 *
 * Deduplication logic:
 *   - If this fixtureId+market has NEVER been logged → write it.
 *   - If it was logged WITHOUT marketOdds (odds matching failed) AND
 *     we now have odds → write again (the read-time dedup will prefer
 *     the record with odds populated).
 *   - If it was already logged WITH marketOdds → skip (immutable).
 *
 * This ensures every real-world match counts exactly once in
 * performance metrics, while allowing one odds-update pass when
 * the first write was incomplete due to a matching failure.
 */
function logPrediction(match, analysis) {
  const today = new Date().toISOString().slice(0, 10);
  const fixtureId = match.id;

  const existing = readJSONL(config.PREDICTIONS_FILE);

  // Check completion status of each market for this fixture
  const o25Existing = existing.find(p => p.fixtureId === fixtureId && p.market === 'over_2.5');
  const bttsExisting = existing.find(p => p.fixtureId === fixtureId && p.market === 'btts');

  const o25Complete = o25Existing?.marketOdds != null;
  const bttsComplete = bttsExisting != null; // BTTS never has odds, so presence = complete

  // If both markets are fully logged, nothing to do
  if (o25Complete && bttsComplete) return;

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

  // ── O2.5 prediction ────────────────────────────────────────
  // Write if: not yet logged, OR logged but without odds and we now have them
  const shouldWriteO25 = !o25Complete && analysis.o25.probability != null;
  if (shouldWriteO25) {
    const hasOdds = analysis.o25.marketOdds != null;
    appendJSONL(config.PREDICTIONS_FILE, {
      ...base,
      market: 'over_2.5',
      selection: 'over',
      modelProbability: analysis.o25.probability,
      fairOdds: analysis.o25.fairOdds,
      // Odds snapshot at tip time — stored once, never recalculated
      marketOdds: analysis.o25.marketOdds,
      bookmaker: analysis.o25.bookmaker,
      bookmakerKey: analysis.o25.bookmakerKey || null,
      oddsSnapshotAt: hasOdds ? new Date().toISOString() : null,
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

  // ── BTTS prediction ────────────────────────────────────────
  // BTTS is only written once — odds are not available for this market
  if (!bttsExisting && analysis.btts.probability != null) {
    appendJSONL(config.PREDICTIONS_FILE, {
      ...base,
      market: 'btts',
      selection: 'yes',
      modelProbability: analysis.btts.probability,
      fairOdds: analysis.btts.fairOdds,
      marketOdds: null,   // BTTS not available from AU region Odds API
      bookmaker: null,
      bookmakerKey: null,
      oddsSnapshotAt: null,
      edge: null,
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
 *   'unknown'    — >72h with no result found, treated as void
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
 *
 * Dedup strategy for predictions:
 *   Per fixtureId+market, keep the record with marketOdds populated
 *   if one exists; otherwise keep the most recent record.
 *   This handles the case where a fixture was logged twice (once
 *   without odds, once with odds after a second refresh cycle).
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

  // Deduplicate predictions by fixtureId + market.
  // Prefer: records WITH marketOdds over those without.
  // Among equals: keep the most recent (last written).
  const dedupMap = new Map(); // key → best record
  for (const p of predictions) {
    const key = `${p.fixtureId}__${p.market}`;
    const existing = dedupMap.get(key);
    if (!existing) {
      dedupMap.set(key, p);
    } else {
      // Prefer the record with odds populated
      const existingHasOdds = existing.marketOdds != null;
      const pHasOdds = p.marketOdds != null;
      if (pHasOdds && !existingHasOdds) {
        // New record has odds, existing doesn't — upgrade
        dedupMap.set(key, p);
      } else if (pHasOdds === existingHasOdds) {
        // Same odds status — keep the more recent one
        dedupMap.set(key, p);
      }
      // If existing has odds and new doesn't — keep existing (no change)
    }
  }

  const dedupedPredictions = Array.from(dedupMap.values());

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
      bookmaker: p.bookmaker,
      bookmakerKey: p.bookmakerKey,
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