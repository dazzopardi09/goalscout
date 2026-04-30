// src/engine/history.js
// ─────────────────────────────────────────────────────────────
// Historical prediction logger + stats engine.
// Backwards compatible: handles both old records (no status field,
// settlement tracked in results.jsonl) and new records (status inline).
//
// CLV note:
//   closingOdds is captured separately by captureClosingOdds() (settler.js)
//   3-15 minutes before kickoff. updatePreKickoffOdds() only writes
//   preKickoffOdds and preKickoffMovePct — it does not touch closingOdds.
//   settlePrediction() uses resolvedClosingOdds = closingOdds ?? p.closingOdds
//   so an existing clean capture is never overwritten by the settlement-time
//   odds fetch (which usually returns null for completed events).
//
// preKickoffMovePct sign convention:
//   positive = pre-KO price drifted longer than tip (market moved against us)
//   negative = pre-KO price shortened (market agrees with our pick)
//   Matches UI color logic: positive → red, negative → green.
// ─────────────────────────────────────────────────────────────

const fs     = require('fs');
const config = require('../config');

function ensureHistoryDir() {
  if (!fs.existsSync(config.HISTORY_DIR)) {
    fs.mkdirSync(config.HISTORY_DIR, { recursive: true });
  }
}

function appendJSONL(filePath, obj) {
  ensureHistoryDir();
  fs.appendFileSync(filePath, JSON.stringify(obj) + '\n', 'utf8');
}

function readJSONL(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8')
      .split('\n')
      .filter(l => l.trim())
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

// ── Prediction logging ────────────────────────────────────────

function logPrediction(match, analysis) {
  const today    = new Date().toISOString().slice(0, 10);
  const existing = readJSONL(config.PREDICTIONS_FILE);
  if (existing.some(p => p.fixtureId === match.id && p.predictionDate === today)) return;

  const base = {
    fixtureId:           match.id,
    predictionDate:      today,
    predictionTimestamp: new Date().toISOString(),
    modelVersion:        analysis.modelVersion,
    league:              match.league,
    leagueSlug:          match.leagueSlug,
    homeTeam:            match.homeTeam,
    awayTeam:            match.awayTeam,
    kickoff:             match.kickoff,
    day:                 match.day,
    commenceTime:        match.odds?.commenceTime || null,
    grade:               match.grade   || null,
    direction:           match.direction || null,
  };

  if (analysis.o25?.probability != null) {
    appendJSONL(config.PREDICTIONS_FILE, {
      ...base,
      market:            'over_2.5',
      selection:         'over',
      modelProbability:  analysis.o25.probability,
      fairOdds:          analysis.o25.fairOdds,
      marketOdds:        analysis.o25.marketOdds,
      bookmaker:         analysis.o25.bookmaker,
      edge:              analysis.o25.edge,
      preKickoffOdds:    null,
      preKickoffMovePct: null,
      closingOdds:       null,
      clvPct:            null,
      status:            'pending',
      result:            null,
      settledAt:         null,
      inputs: {
        homeO25pct: match.home?.o25pct,
        awayO25pct: match.away?.o25pct,
        homeAvgTG:  match.home?.avgTG,
        awayAvgTG:  match.away?.avgTG,
        flagScore:  match.score,
        grade:      match.grade,
      },
    });
  }

  if (analysis.btts?.probability != null) {
    appendJSONL(config.PREDICTIONS_FILE, {
      ...base,
      market:            'btts',
      selection:         'yes',
      modelProbability:  analysis.btts.probability,
      fairOdds:          analysis.btts.fairOdds,
      marketOdds:        analysis.btts.marketOdds,
      bookmaker:         analysis.btts.bookmaker,
      edge:              analysis.btts.edge,
      preKickoffOdds:    null,
      preKickoffMovePct: null,
      closingOdds:       null,
      clvPct:            null,
      status:            'pending',
      result:            null,
      settledAt:         null,
      inputs: {
        homeBTSpct: match.home?.btsPct,
        awayBTSpct: match.away?.btsPct,
        homeFTSpct: match.home?.ftsPct,
        awayFTSpct: match.away?.ftsPct,
        homeCSpct:  match.home?.csPct,
        awayCSpct:  match.away?.csPct,
        flagScore:  match.score,
        grade:      match.grade,
      },
    });
  }
}

// ── Pre-kickoff + settle ──────────────────────────────────────

function updatePreKickoffOdds(fixtureId, market, preKoPrice) {
  const predictions = readJSONL(config.PREDICTIONS_FILE);
  let updated = false;
  const newLines = predictions.map(p => {
    if (p.fixtureId !== fixtureId || p.market !== market) return p;
    if (p.preKickoffOdds != null) return p;
    // Sign convention: (preKoPrice / marketOdds - 1) × 100
    //   positive = pre-KO drifted longer than tip (market moved against pick) → red
    //   negative = pre-KO shortened vs tip (market agrees)                    → green
    // Verified empirically against live records (e.g. Sporting CP/Tondela: -2.26).
    const movePct = (p.marketOdds != null && preKoPrice != null)
      ? Math.round(((preKoPrice / p.marketOdds) - 1) * 10000) / 100 : null;
    updated = true;
    return { ...p, preKickoffOdds: preKoPrice, preKickoffMovePct: movePct };
  });
  if (updated) {
    fs.writeFileSync(config.PREDICTIONS_FILE, newLines.map(l => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  }
  return updated;
}

function settlePrediction(fixtureId, market, { homeGoals, awayGoals, closingOdds }) {
  const predictions = readJSONL(config.PREDICTIONS_FILE);
  let updated = false;
  const newLines = predictions.map(p => {
    if (p.fixtureId !== fixtureId || p.market !== market) return p;
    const isSettleable = p.status === 'pending' || p.status == null;
    if (!isSettleable) return p;
    const totalGoals = (homeGoals ?? 0) + (awayGoals ?? 0);
    const won = market === 'over_2.5' ? totalGoals > 2.5
              : market === 'btts'     ? homeGoals > 0 && awayGoals > 0
              : null;
    // Honor any closingOdds already written by captureClosingOdds() before
    // this settlement run. The /odds endpoint usually returns nothing for
    // completed events, so closingOdds from the settler is often null.
    // resolvedClosingOdds preserves a clean pre-KO capture over null.
    const resolvedClosingOdds = closingOdds ?? p.closingOdds ?? null;
    const clvPct = (p.marketOdds != null && resolvedClosingOdds != null)
      ? Math.round(((p.marketOdds / resolvedClosingOdds) - 1) * 10000) / 100 : null;
    updated = true;
    return {
      ...p,
      closingOdds:  resolvedClosingOdds,
      clvPct,
      status:    won == null ? 'void' : won ? 'settled_won' : 'settled_lost',
      result:    `${homeGoals}-${awayGoals}`,
      settledAt: new Date().toISOString(),
    };
  });
  if (updated) {
    fs.writeFileSync(config.PREDICTIONS_FILE, newLines.map(l => JSON.stringify(l)).join('\n') + '\n', 'utf8');
    appendJSONL(config.RESULTS_FILE, {
      fixtureId, settledAt: new Date().toISOString(),
      fullTimeHome: homeGoals, fullTimeAway: awayGoals,
      totalGoals: (homeGoals ?? 0) + (awayGoals ?? 0),
      over25:  ((homeGoals ?? 0) + (awayGoals ?? 0)) > 2.5,
      bttsYes: (homeGoals ?? 0) > 0 && (awayGoals ?? 0) > 0,
    });
  }
  return updated;
}

// ── Stats — backwards compatible with old + new records ───────

function getPredictionStats() {
  const predictions = readJSONL(config.PREDICTIONS_FILE);
  const results     = readJSONL(config.RESULTS_FILE);

  // Result lookup for old-style settlement (no status field)
  const resultMap = new Map();
  for (const r of results) resultMap.set(r.fixtureId, r);

  function resolveStatus(p) {
    // New records have an explicit status
    if (p.status === 'settled_won' || p.status === 'settled_lost' || p.status === 'void') return p.status;
    // Old records: look up in results.jsonl
    const r = resultMap.get(p.fixtureId);
    if (!r) return 'pending';
    const total = r.totalGoals ?? ((r.fullTimeHome ?? 0) + (r.fullTimeAway ?? 0));
    if (p.market === 'over_2.5') return total > 2.5 ? 'settled_won' : 'settled_lost';
    if (p.market === 'btts')     return (r.bttsYes || (r.fullTimeHome > 0 && r.fullTimeAway > 0)) ? 'settled_won' : 'settled_lost';
    return 'pending';
  }

  function resolveResult(p) {
    if (p.result) return p.result;
    const r = resultMap.get(p.fixtureId);
    return r ? `${r.fullTimeHome ?? '?'}-${r.fullTimeAway ?? '?'}` : null;
  }

  function resolveSettledAt(p) {
    if (p.settledAt) return p.settledAt;
    return resultMap.get(p.fixtureId)?.settledAt || null;
  }

  const annotated = predictions.map(p => ({
    ...p,
    status:    resolveStatus(p),
    result:    resolveResult(p),
    settledAt: resolveSettledAt(p),
    grade:     p.grade || p.inputs?.grade || '—',
    direction: p.direction || 'o25',
  }));

  function marketStats(preds) {
    const settled = preds.filter(p => p.status === 'settled_won' || p.status === 'settled_lost');
    const won     = settled.filter(p => p.status === 'settled_won');
    const pending = preds.filter(p => p.status === 'pending');
    const voided  = preds.filter(p => p.status === 'void');

    const hitRate = settled.length > 0 ? Math.round(won.length / settled.length * 1000) / 10 : null;

    const edgePreds = preds.filter(p => p.edge != null);
    const meanEdgePct = edgePreds.length > 0
      ? Math.round(edgePreds.reduce((s, p) => s + p.edge, 0) / edgePreds.length * 10) / 10 : null;

    const movePreds = preds.filter(p => p.preKickoffMovePct != null);
    const meanPreKickoffMovePct = movePreds.length > 0
      ? Math.round(movePreds.reduce((s, p) => s + p.preKickoffMovePct, 0) / movePreds.length * 10) / 10 : null;

    const clvPreds = preds.filter(p => p.clvPct != null);
    const meanCLVPct = clvPreds.length > 0
      ? Math.round(clvPreds.reduce((s, p) => s + p.clvPct, 0) / clvPreds.length * 10) / 10 : null;

    const meanModelProb = preds.length > 0
      ? Math.round(preds.reduce((s, p) => s + (p.modelProbability || 0), 0) / preds.length * 100) : null;

    let brierScore = null;
    if (settled.length > 0) {
      const sum = settled.reduce((s, p) => s + Math.pow((p.modelProbability || 0) - (p.status === 'settled_won' ? 1 : 0), 2), 0);
      brierScore = Math.round(sum / settled.length * 10000) / 10000;
    }

    return { total: preds.length, settled: settled.length, won: won.length, pending: pending.length, awaiting: voided.length, hitRate, meanModelProb, meanEdgePct, meanPreKickoffMovePct, meanCLVPct, brierScore };
  }

  // over_2.5 tab shows over_2.5 AND btts (all historical data)
  // under_2.5 tab shows under_2.5 only (future records)
  const o25preds = annotated.filter(p => p.market === 'over_2.5' || p.market === 'btts');
  const u25preds = annotated.filter(p => p.market === 'under_2.5');
  const allSettled = annotated.filter(p => p.status === 'settled_won' || p.status === 'settled_lost');
  const allWon     = annotated.filter(p => p.status === 'settled_won');
  const allVoid    = annotated.filter(p => p.status === 'void');

  const recentSettled = annotated
    .filter(p => p.status === 'settled_won' || p.status === 'settled_lost')
    .sort((a, b) => (b.settledAt || '').localeCompare(a.settledAt || ''))
    .slice(0, 50);

  return {
    summary: {
      total:       annotated.length,
      settled:     allSettled.length,
      won:         allWon.length,
      pending:     annotated.filter(p => p.status === 'pending').length,
      awaiting:    allVoid.length,
      void:        allVoid.length,
      voidRatePct: annotated.length > 0 ? Math.round(allVoid.length / annotated.length * 1000) / 10 : 0,
    },
    markets: {
      'over_2.5':  marketStats(o25preds),
      'under_2.5': marketStats(u25preds),
    },
    recentSettled,
  };
}

module.exports = { logPrediction, updatePreKickoffOdds, settlePrediction, readJSONL, getPredictionStats };