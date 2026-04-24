// src/engine/history.js
// ─────────────────────────────────────────────────────────────
// Historical prediction logger + stats engine.
// Supports parallel methods:
//   - current
//   - calibrated
//
// Logs one prediction per shortlisted selection, not legacy market fan-out.
// Backwards compatible with older records where possible.
// ─────────────────────────────────────────────────────────────

const fs = require('fs');
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
      .map(l => {
        try { return JSON.parse(l); }
        catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ── Prediction logging ────────────────────────────────────────

function logPrediction(match, analysis, method = 'current', selectionType = null) {
  if (!match || !analysis || !match.direction) return;

  const today = new Date().toISOString().slice(0, 10);
  const existing = readJSONL(config.PREDICTIONS_FILE);

// one record per fixture + method + market/direction
if (existing.some(p =>
  p.fixtureId === match.id &&
  (p.method || 'current') === method &&
  (p.direction || null) === (match.direction || null)
)) {
  return;
}

  const isU25 = match.direction === 'u25';
  const market = isU25 ? 'under_2.5' : 'over_2.5';
  const selection = isU25 ? 'under' : 'over';
  const dirPayload = isU25 ? analysis.u25 : analysis.o25;

  if (!dirPayload || dirPayload.probability == null) return;

  appendJSONL(config.PREDICTIONS_FILE, {
    fixtureId:           match.id,
    predictionDate:      today,
    predictionTimestamp: new Date().toISOString(),
    modelVersion:        analysis.modelVersion,
    method,
    selectionType,

    league:              match.league,
    leagueSlug:          match.leagueSlug,
    homeTeam:            match.homeTeam,
    awayTeam:            match.awayTeam,
    kickoff:             match.kickoff,
    day:                 match.day,
    commenceTime:        match.odds?.commenceTime || null,

    grade:               match.grade || null,
    direction:           match.direction || null,
    score:               match.score ?? null,

    market,
    selection,

    modelProbability:    dirPayload.probability,
    rawModelProbability: method === 'calibrated'
      ? (isU25
          ? match.methodAnalyses?.current?.u25?.probability ?? null
          : match.methodAnalyses?.current?.o25?.probability ?? null)
      : dirPayload.probability,

    fairOdds:            dirPayload.fairOdds,
    marketOdds:          dirPayload.marketOdds,
    bookmaker:           dirPayload.bookmaker,
    bookmakerKey:        dirPayload.bookmakerKey,
    edge:                dirPayload.edge,

    preKickoffOdds:      null,
    preKickoffMovePct:   null,
    closingOdds:         null,
    clvPct:              null,
    status:              'pending',
    result:              null,
    settledAt:           null,

    inputs: {
      homeO25pct: match.home?.o25pct,
      awayO25pct: match.away?.o25pct,
      homeAvgTG:  match.home?.avgTG,
      awayAvgTG:  match.away?.avgTG,
      flagScore:  match.score ?? null,
      grade:      match.grade ?? null,
    },
  });
}

// ── Pre-kickoff + settle ──────────────────────────────────────

function updatePreKickoffOdds(fixtureId, market, method, preKoPrice) {
  const predictions = readJSONL(config.PREDICTIONS_FILE);
  let updated = false;

  const newLines = predictions.map(p => {
    if (
      p.fixtureId !== fixtureId ||
      p.market !== market ||
      (p.method || 'current') !== method
    ) return p;
    if (p.preKickoffOdds != null) return p;

    const movePct = (p.marketOdds != null && preKoPrice != null)
      ? Math.round(((p.marketOdds / preKoPrice) - 1) * 10000) / 100
      : null;

    updated = true;
    return { ...p, preKickoffOdds: preKoPrice, preKickoffMovePct: movePct };
  });

  if (updated) {
    fs.writeFileSync(
      config.PREDICTIONS_FILE,
      newLines.map(l => JSON.stringify(l)).join('\n') + '\n',
      'utf8'
    );
  }

  return updated;
}

function settlePrediction(fixtureId, market, method, { homeGoals, awayGoals, closingOdds }) {
  const predictions = readJSONL(config.PREDICTIONS_FILE);
  let updated = false;

  const newLines = predictions.map(p => {
    if (
      p.fixtureId !== fixtureId ||
      p.market !== market ||
      (p.method || 'current') !== method
  ) return p;

    const isSettleable = p.status === 'pending' || p.status == null;
    if (!isSettleable) return p;

    const totalGoals = (homeGoals ?? 0) + (awayGoals ?? 0);

    const won =
      market === 'over_2.5'  ? totalGoals > 2.5 :
      market === 'under_2.5' ? totalGoals < 2.5 :
      market === 'btts'      ? homeGoals > 0 && awayGoals > 0 :
      null;

    const clvPct = (p.marketOdds != null && closingOdds != null)
      ? Math.round(((p.marketOdds / closingOdds) - 1) * 10000) / 100
      : null;
// one record per fixture + method + day
    updated = true;

    return {
      ...p,
      closingOdds: closingOdds ?? null,
      clvPct,
      status: won == null ? 'void' : won ? 'settled_won' : 'settled_lost',
      result: `${homeGoals}-${awayGoals}`,
      settledAt: new Date().toISOString(),
    };
  });

  if (updated) {
    fs.writeFileSync(
      config.PREDICTIONS_FILE,
      newLines.map(l => JSON.stringify(l)).join('\n') + '\n',
      'utf8'
    );

    appendJSONL(config.RESULTS_FILE, {
      fixtureId,
      settledAt: new Date().toISOString(),
      fullTimeHome: homeGoals,
      fullTimeAway: awayGoals,
      totalGoals: (homeGoals ?? 0) + (awayGoals ?? 0),
      over25: ((homeGoals ?? 0) + (awayGoals ?? 0)) > 2.5,
      under25: ((homeGoals ?? 0) + (awayGoals ?? 0)) < 2.5,
      bttsYes: (homeGoals ?? 0) > 0 && (awayGoals ?? 0) > 0,
    });
  }

  return updated;
}

// ── Stats ─────────────────────────────────────────────────────

function getPredictionStats() {
  const predictions = readJSONL(config.PREDICTIONS_FILE);
  const results = readJSONL(config.RESULTS_FILE);

  const resultMap = new Map();
  for (const r of results) resultMap.set(r.fixtureId, r);

  function resolveStatus(p) {
    if (p.status === 'settled_won' || p.status === 'settled_lost' || p.status === 'void') {
      return p.status;
    }

    const r = resultMap.get(p.fixtureId);
    if (!r) return 'pending';

    const total = r.totalGoals ?? ((r.fullTimeHome ?? 0) + (r.fullTimeAway ?? 0));

    if (p.market === 'over_2.5')  return total > 2.5 ? 'settled_won' : 'settled_lost';
    if (p.market === 'under_2.5') return total < 2.5 ? 'settled_won' : 'settled_lost';
    if (p.market === 'btts')      return (r.bttsYes || (r.fullTimeHome > 0 && r.fullTimeAway > 0)) ? 'settled_won' : 'settled_lost';

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
    status: resolveStatus(p),
    result: resolveResult(p),
    settledAt: resolveSettledAt(p),
    grade: p.grade || p.inputs?.grade || '—',
    direction: p.direction || (p.market === 'under_2.5' ? 'u25' : 'o25'),
    method: p.method || 'current',
    selectionType: p.selectionType || null,
  }));

  function marketStats(preds) {
    const settled = preds.filter(p => p.status === 'settled_won' || p.status === 'settled_lost');
    const won = settled.filter(p => p.status === 'settled_won');
    const pending = preds.filter(p => p.status === 'pending');
    const voided = preds.filter(p => p.status === 'void');

    const hitRate = settled.length > 0
      ? Math.round((won.length / settled.length) * 1000) / 10
      : null;

    const edgePreds = preds.filter(p => p.edge != null);
    const meanEdgePct = edgePreds.length > 0
      ? Math.round((edgePreds.reduce((s, p) => s + p.edge, 0) / edgePreds.length) * 10) / 10
      : null;

    const movePreds = preds.filter(p => p.preKickoffMovePct != null);
    const meanPreKickoffMovePct = movePreds.length > 0
      ? Math.round((movePreds.reduce((s, p) => s + p.preKickoffMovePct, 0) / movePreds.length) * 10) / 10
      : null;

    const clvPreds = preds.filter(p => p.clvPct != null);
    const meanCLVPct = clvPreds.length > 0
      ? Math.round((clvPreds.reduce((s, p) => s + p.clvPct, 0) / clvPreds.length) * 10) / 10
      : null;

    const meanModelProb = preds.length > 0
      ? Math.round((preds.reduce((s, p) => s + (p.modelProbability || 0), 0) / preds.length) * 100)
      : null;

    let brierScore = null;
    if (settled.length > 0) {
      const sum = settled.reduce((s, p) => {
        const actual = p.status === 'settled_won' ? 1 : 0;
        return s + Math.pow((p.modelProbability || 0) - actual, 2);
      }, 0);
      brierScore = Math.round((sum / settled.length) * 10000) / 10000;
    }

    return {
      total: preds.length,
      settled: settled.length,
      won: won.length,
      pending: pending.length,
      awaiting: voided.length,
      hitRate,
      meanModelProb,
      meanEdgePct,
      meanPreKickoffMovePct,
      meanCLVPct,
      brierScore,
      units: settled.reduce((s, p) => {
        if (p.status === 'settled_won') return s + ((p.marketOdds || 0) - 1);
        if (p.status === 'settled_lost') return s - 1;
        return s;
      }, 0),
      roi: settled.length > 0
        ? Math.round(
            (settled.reduce((s, p) => {
              if (p.status === 'settled_won') return s + ((p.marketOdds || 0) - 1);
              if (p.status === 'settled_lost') return s - 1;
              return s;
            }, 0) / settled.length) * 1000
          ) / 10
        : null,
    };
  }

  function aggregateFor(preds) {
    const overPreds = preds.filter(p => p.market === 'over_2.5');
    const underPreds = preds.filter(p => p.market === 'under_2.5');

    const settled = preds.filter(p => p.status === 'settled_won' || p.status === 'settled_lost');
    const won = settled.filter(p => p.status === 'settled_won');
    const pending = preds.filter(p => p.status === 'pending');
    const voided = preds.filter(p => p.status === 'void');

    return {
      summary: {
        total: preds.length,
        settled: settled.length,
        won: won.length,
        pending: pending.length,
        awaiting: voided.length,
        void: voided.length,
        voidRatePct: preds.length > 0 ? Math.round((voided.length / preds.length) * 1000) / 10 : 0,
      },
      markets: {
        'over_2.5': marketStats(overPreds),
        'under_2.5': marketStats(underPreds),
      },
      recentSettled: settled
        .sort((a, b) => (b.settledAt || '').localeCompare(a.settledAt || ''))
        .slice(0, 50),
      overlap: {
        both: preds.filter(p => p.selectionType === 'both').length,
        current_only: preds.filter(p => p.selectionType === 'current_only').length,
        calibrated_only: preds.filter(p => p.selectionType === 'calibrated_only').length,
      },
    };
  }

  const methods = {
    current: aggregateFor(annotated.filter(p => (p.method || 'current') === 'current')),
    calibrated: aggregateFor(annotated.filter(p => (p.method || 'current') === 'calibrated')),
  };

  const allSettled = annotated.filter(p => p.status === 'settled_won' || p.status === 'settled_lost');
  const allWon = annotated.filter(p => p.status === 'settled_won');
  const allVoid = annotated.filter(p => p.status === 'void');

  return {
    summary: {
      total: annotated.length,
      settled: allSettled.length,
      won: allWon.length,
      pending: annotated.filter(p => p.status === 'pending').length,
      awaiting: allVoid.length,
      void: allVoid.length,
      voidRatePct: annotated.length > 0 ? Math.round((allVoid.length / annotated.length) * 1000) / 10 : 0,
    },
    methods,
    comparison: {
      overlap: {
        both: annotated.filter(p => p.selectionType === 'both').length,
        current_only: annotated.filter(p => p.selectionType === 'current_only').length,
        calibrated_only: annotated.filter(p => p.selectionType === 'calibrated_only').length,
      },
    },
  };
}

module.exports = {
  logPrediction,
  updatePreKickoffOdds,
  settlePrediction,
  readJSONL,
  getPredictionStats,
};