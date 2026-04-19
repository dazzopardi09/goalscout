// src/engine/history.js
// ─────────────────────────────────────────────────────────────
// Historical prediction logger and performance evaluator.
//
// Files managed (all JSONL, append-only, never overwritten):
//   predictions.jsonl  — one record per match
//                        market = 'over_2.5' or 'under_2.5'
//                        based on the match's direction field
//   results.jsonl      — one record per settled fixture
//   closing-odds.jsonl — price snapshots (tip_time, pre_kickoff, closing)
//
// ── Dedup logic ────────────────────────────────────────────
// A prediction is skipped if fixtureId already exists WITH
// marketOdds populated (complete record). If first write had
// null odds (matching failure), one re-write is allowed when
// odds become available on the next cycle.
//
// At read time, per fixtureId, prefer the record with
// marketOdds populated; among equals keep most recent.
//
// ── Three odds snapshots ───────────────────────────────────
// closing-odds.jsonl stores all three price points per match:
//   snapshotType: 'tip_time'    → at shortlist time
//   snapshotType: 'pre_kickoff' → 25-35 mins before kickoff
//   snapshotType: 'closing'     → as close to KO as possible
//
// Price movement tip_time → pre_kickoff tracks lineup impact.
// CLV is measured tip_time → closing.
// ─────────────────────────────────────────────────────────────

const fs = require('fs');
const config = require('../config');

// ── File helpers ─────────────────────────────────────────────

function ensureHistoryDir() {
  const dir = config.HISTORY_DIR;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function appendJSONL(filePath, obj) {
  ensureHistoryDir();
  fs.appendFileSync(filePath, JSON.stringify(obj) + '\n', 'utf8');
}

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

// ── Prediction logging ────────────────────────────────────────

/**
 * Log a prediction for a shortlisted match.
 *
 * One record per match — market is 'over_2.5' or 'under_2.5'
 * based on match.direction (set by shortlist.js).
 *
 * Also writes a tip_time snapshot to closing-odds.jsonl so
 * CLV can be calculated later against pre_kickoff and closing.
 */
function logPrediction(match, analysis) {
  const today = new Date().toISOString().slice(0, 10);
  const fixtureId = match.id;
  const direction = match.direction || 'o25';
  const market = direction === 'u25' ? 'under_2.5' : 'over_2.5';
  const marketAnalysis = direction === 'u25' ? analysis.u25 : analysis.o25;

  const existing = readJSONL(config.PREDICTIONS_FILE);

  // Skip if already logged WITH odds — immutable once complete
  const alreadyComplete = existing.some(
    p => p.fixtureId === fixtureId && p.marketOdds != null
  );
  if (alreadyComplete) return;

  const hasOdds = marketAnalysis.marketOdds != null;

  const record = {
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
    eventId: match.odds?.eventId || null,
    market,
    selection: direction === 'u25' ? 'under' : 'over',
    direction,
    modelProbability: marketAnalysis.probability,
    fairOdds: marketAnalysis.fairOdds,
    marketOdds: marketAnalysis.marketOdds,
    bookmaker: marketAnalysis.bookmaker,
    bookmakerKey: marketAnalysis.bookmakerKey || null,
    oddsSnapshotAt: hasOdds ? new Date().toISOString() : null,
    edge: marketAnalysis.edge,
    inputs: direction === 'u25' ? {
      homeCSpct: match.home?.csPct,
      awayCSpct: match.away?.csPct,
      homeFTSpct: match.home?.ftsPct,
      awayFTSpct: match.away?.ftsPct,
      homeO25pct: match.home?.o25pct,
      awayO25pct: match.away?.o25pct,
      score: match.score,
      grade: match.grade,
    } : {
      homeO25pct: match.home?.o25pct,
      awayO25pct: match.away?.o25pct,
      homeAvgTG: match.home?.avgTG,
      awayAvgTG: match.away?.avgTG,
      score: match.score,
      grade: match.grade,
    },
  };

  appendJSONL(config.PREDICTIONS_FILE, record);

  // Write tip_time snapshot to closing-odds.jsonl so CLV can
  // be measured later against pre_kickoff and closing snapshots
  if (hasOdds) {
    logOddsSnapshot(
      fixtureId,
      market,
      marketAnalysis.marketOdds,
      marketAnalysis.bookmaker,
      'tip_time'
    );
  }
}

// ── Result logging ────────────────────────────────────────────

/**
 * Log a match result.
 *
 * matchStatus values:
 *   'completed'  — full-time score confirmed, used in metrics
 *   'postponed'  — treated as void
 *   'cancelled'  — treated as void
 *   'abandoned'  — treated as void
 *   'unknown'    — >72h with no result, treated as void
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
    under25: isCompleted ? (result.homeGoals + result.awayGoals) < 2.5 : null,
    // exactly 2.5 is impossible in football, but guard against it
    push: isCompleted ? (result.homeGoals + result.awayGoals) === 2.5 : null,
    halfTimeHome: result.htHome ?? null,
    halfTimeAway: result.htAway ?? null,
  });
}

// ── Odds snapshot logging ────────────────────────────────────

/**
 * Log an odds snapshot.
 * snapshotType: 'tip_time' | 'pre_kickoff' | 'closing'
 *
 * tip_time is written by logPrediction automatically.
 * pre_kickoff and closing are written by settler.js.
 */
function logOddsSnapshot(fixtureId, market, price, bookmaker, snapshotType) {
  ensureHistoryDir();
  appendJSONL(config.CLOSING_ODDS_FILE, {
    fixtureId,
    market,
    capturedAt: new Date().toISOString(),
    snapshotType,
    decimalOdds: price,
    bookmaker,
  });
}

// ── Performance evaluation ────────────────────────────────────

/**
 * Compute performance statistics for O2.5 and U2.5 independently.
 *
 * Dedup: per fixtureId, keep the record with marketOdds populated;
 * if none have odds, keep the most recent.
 *
 * CLV uses tip_time vs closing snapshots.
 * Price movement uses tip_time vs pre_kickoff snapshots.
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

  // Group snapshots by fixtureId+market+type
  const snapshotMap = new Map();
  for (const s of closingOdds) {
    const key = `${s.fixtureId}__${s.market}__${s.snapshotType}`;
    snapshotMap.set(key, s.decimalOdds);
  }

  // Deduplicate predictions: per fixtureId prefer records with odds
  const dedupMap = new Map();
  for (const p of predictions) {
    const existing = dedupMap.get(p.fixtureId);
    if (!existing) {
      dedupMap.set(p.fixtureId, p);
    } else {
      const existingHasOdds = existing.marketOdds != null;
      const pHasOdds = p.marketOdds != null;
      if (pHasOdds && !existingHasOdds) {
        dedupMap.set(p.fixtureId, p);
      } else if (pHasOdds === existingHasOdds) {
        // Both same odds status — keep most recent
        dedupMap.set(p.fixtureId, p);
      }
    }
  }

  const dedupedPredictions = Array.from(dedupMap.values());

  // Classify each prediction
  const classified = dedupedPredictions.map(p => {
    const result = resultMap.get(p.fixtureId) || null;

    // CLV: tip_time vs closing
    const closingKey = `${p.fixtureId}__${p.market}__closing`;
    const closingPrice = snapshotMap.get(closingKey) || null;

    // Price movement: tip_time vs pre_kickoff
    const preKickoffKey = `${p.fixtureId}__${p.market}__pre_kickoff`;
    const preKickoffPrice = snapshotMap.get(preKickoffKey) || null;

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
      clvPct = Math.round((closingPrice / p.marketOdds - 1) * -10000) / 100;
    }

    // Price movement from tip to pre-kickoff
    let preKickoffMovePct = null;
    if (p.marketOdds && preKickoffPrice) {
      // Positive = odds shortened (market agrees), Negative = drifted out
      preKickoffMovePct = Math.round((p.marketOdds / preKickoffPrice - 1) * 10000) / 100;
    }

    // Brier score contribution
    let brierContrib = null;
    if ((status === 'settled_won' || status === 'settled_lost') && p.modelProbability != null) {
      const outcome = status === 'settled_won' ? 1 : 0;
      brierContrib = Math.pow(p.modelProbability - outcome, 2);
    }

    return {
      ...p,
      status,
      result,
      closingPrice,
      preKickoffPrice,
      clvPct,
      preKickoffMovePct,
      brierContrib,
    };
  });

  // Aggregate summary
  const total = classified.length;
  const pending = classified.filter(p => p.status === 'pending').length;
  const awaiting = classified.filter(p => p.status === 'awaiting_result').length;
  const voidCount = classified.filter(p => p.status === 'void').length;
  const settled = classified.filter(p => p.status === 'settled_won' || p.status === 'settled_lost');
  const won = settled.filter(p => p.status === 'settled_won').length;
  const voidRate = (voidCount + settled.length) > 0
    ? Math.round(voidCount / (voidCount + settled.length) * 1000) / 10
    : null;

  // Per-market metrics — now 'over_2.5' and 'under_2.5'
  const markets = {};
  for (const market of ['over_2.5', 'under_2.5']) {
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

    const moveValues = mPreds.filter(p => p.preKickoffMovePct != null).map(p => p.preKickoffMovePct);
    const meanPreKickoffMove = moveValues.length > 0
      ? Math.round(moveValues.reduce((s, v) => s + v, 0) / moveValues.length * 100) / 100
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
      meanPreKickoffMovePct: meanPreKickoffMove,
      preKickoffSampleSize: moveValues.length,
      meanModelProb,
    };
  }

  // Recent settled predictions for the performance UI table
  const recentSettled = classified
    .filter(p => p.status === 'settled_won' || p.status === 'settled_lost')
    .sort((a, b) => new Date(b.predictionTimestamp) - new Date(a.predictionTimestamp))
    .slice(0, 30)
    .map(p => ({
      fixtureId: p.fixtureId,
      predictionDate: p.predictionDate,
      homeTeam: p.homeTeam,
      awayTeam: p.awayTeam,
      league: p.league,
      market: p.market,
      direction: p.direction,
      modelProbability: p.modelProbability,
      fairOdds: p.fairOdds,
      marketOdds: p.marketOdds,
      bookmaker: p.bookmaker,
      edge: p.edge,
      preKickoffOdds: p.preKickoffPrice,
      preKickoffMovePct: p.preKickoffMovePct,
      closingOdds: p.closingPrice,
      clvPct: p.clvPct,
      status: p.status,
      score: p.result
        ? `${p.result.fullTimeHome}–${p.result.fullTimeAway}`
        : null,
      modelVersion: p.modelVersion,
    }));

  return {
    generatedAt: now.toISOString(),
    summary: {
      total, pending, awaiting,
      void: voidCount,
      settled: settled.length,
      won,
      voidRatePct: voidRate,
    },
    markets,
    recentSettled,
  };
}

// ── Internal helpers ──────────────────────────────────────────

function getActualOutcome(prediction, result) {
  if (result.matchStatus !== 'completed') return null;
  if (prediction.market === 'over_2.5') return result.over25 ?? null;
  if (prediction.market === 'under_2.5') return result.under25 ?? null;
  return null;
}

function estimateKickoffDate(prediction) {
  if (prediction.commenceTime) return new Date(prediction.commenceTime);
  if (!prediction.predictionDate || !prediction.kickoff) return null;
  try {
    const [hh, mm] = prediction.kickoff.split(':').map(Number);
    return new Date(
      `${prediction.predictionDate}T${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}:00+10:00`
    );
  } catch { return null; }
}

module.exports = {
  logPrediction,
  logResult,
  logOddsSnapshot,
  readJSONL,
  getPredictionStats,
};
