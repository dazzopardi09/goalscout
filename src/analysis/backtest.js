#!/usr/bin/env node
// src/analysis/backtest.js
// ─────────────────────────────────────────────────────────────
// GoalScout — Backtesting & Validation System
//
// Usage:
//   node src/analysis/backtest.js
//   node src/analysis/backtest.js --output data/backtest-report.json
//   node src/analysis/backtest.js --since 2026-01-01
//   node src/analysis/backtest.js --market over_2.5
//
// Schema facts confirmed from real data audit (2026-04-20):
//   - modelProbability = P(directional market) for ALL rows.
//     Confirmed: fairOdds === round(1/modelProbability) for every record.
//     i.e. over_2.5 rows store P(O2.5); under_2.5 rows store P(U2.5).
//     Do NOT derive P(U2.5) = 1 - modelProbability for under_2.5 rows.
//   - direction field only exists on newer rows. Inferred from market for old ones.
//   - grade lives in inputs.grade always; sometimes duplicated at top level.
//   - inputs.score (old era) and inputs.flagScore (new era) both mean winningScore.
//   - btts = legacy era rows — excluded from directional report, counted separately.
//   - results.jsonl: some entries have null scores (settler-timeout).
//     Two fixtures appear twice (same scores, ms apart) — safely deduped.
// ─────────────────────────────────────────────────────────────

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Config ────────────────────────────────────────────────────

const DATA_DIR         = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const PREDICTIONS_FILE = path.join(DATA_DIR, 'history', 'predictions.jsonl');
const RESULTS_FILE     = path.join(DATA_DIR, 'history', 'results.jsonl');

// ── CLI args ──────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(flag) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
}

const OUTPUT_FILE   = getArg('--output');
const FILTER_MARKET = getArg('--market');   // 'over_2.5' | 'under_2.5'
const FILTER_SINCE  = getArg('--since');    // ISO date e.g. '2026-01-01'

// ── I/O ───────────────────────────────────────────────────────

function readJSONL(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(`[backtest] file not found: ${filePath}`);
    return [];
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  const out = [];
  raw.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    try { out.push(JSON.parse(line)); }
    catch { console.error(`[backtest] parse error line ${i + 1} in ${path.basename(filePath)}`); }
  });
  return out;
}

// ── Math helpers ──────────────────────────────────────────────

function round(n, dp = 4) {
  if (n == null || !isFinite(n)) return null;
  return Math.round(n * Math.pow(10, dp)) / Math.pow(10, dp);
}

function pct(n, dp = 1) {
  if (n == null) return null;
  return round(n * 100, dp);
}

// ── Result deduplication ──────────────────────────────────────
// Prefer records with non-null scores; among ties, take latest settledAt.

function buildResultMap(rawResults) {
  const map = new Map();
  for (const r of rawResults) {
    const id = r.fixtureId;
    if (!id) continue;
    const existing = map.get(id);
    if (!existing) { map.set(id, r); continue; }

    const existingHasScore = existing.fullTimeHome != null;
    const newHasScore      = r.fullTimeHome != null;

    if (!existingHasScore && newHasScore)  { map.set(id, r); continue; }
    if (existingHasScore  && !newHasScore) continue;
    // Both have scores — prefer latest
    if ((r.settledAt || '') > (existing.settledAt || '')) map.set(id, r);
  }
  return map;
}

// ── Normalise prediction ──────────────────────────────────────
//
// Produces a consistent internal shape regardless of era.

function normalisePrediction(raw) {
  const market = raw.market || '';
  const inp    = raw.inputs || {};

  const isLegacyBTTS     = market === 'btts';
  const isDirectionalO25 = market === 'over_2.5';
  const isDirectionalU25 = market === 'under_2.5';
  const isDirectional    = isDirectionalO25 || isDirectionalU25;

  // Direction: explicit field first, then infer from market
  const direction = raw.direction
    || (isDirectionalO25 ? 'o25' : isDirectionalU25 ? 'u25' : null);

  // Grade: top level preferred (newer rows), fall back to inputs.grade
  const grade = raw.grade || inp.grade || null;

  // winningScore: inputs.score (old) or inputs.flagScore (new) — both mean signal score
  const winningScore = inp.score      != null ? inp.score
                     : inp.flagScore  != null ? inp.flagScore
                     : null;

  // modelProbability = P(directional market) for all rows.
  // dirProb is the probability that should be used for Brier, calibration etc.
  const dirProb = raw.modelProbability != null ? raw.modelProbability : null;

  return {
    // Identity
    fixtureId:      raw.fixtureId,
    predictionDate: raw.predictionDate || null,
    predictionTs:   raw.predictionTimestamp || null,
    modelVersion:   raw.modelVersion || 'unknown',

    // Match info
    league:     raw.league     || null,
    leagueSlug: raw.leagueSlug || null,
    homeTeam:   raw.homeTeam   || null,
    awayTeam:   raw.awayTeam   || null,

    // Classification
    market,
    direction,
    isLegacyBTTS,
    isDirectional,

    // Model probabilities
    dirProb,
    modelProbability: raw.modelProbability,
    fairOdds:    raw.fairOdds    || null,
    marketOdds:  raw.marketOdds  || null,
    bookmaker:   raw.bookmaker   || null,
    edge:        raw.edge        != null ? raw.edge : null,

    // CLV / price movement
    preKickoffOdds:    raw.preKickoffOdds    || null,
    preKickoffMovePct: raw.preKickoffMovePct || null,
    closingOdds:       raw.closingOdds       || null,
    clvPct:            raw.clvPct            || null,

    // Signal metadata
    grade,
    winningScore,

    // Raw inputs preserved (for future enhanced-model fields)
    inputs: inp,

    // Settlement state (inline for new-era records)
    status:    raw.status    || 'pending',
    result:    raw.result    || null,
    settledAt: raw.settledAt || null,
  };
}

// ── Join prediction to result ─────────────────────────────────
//
// New-era records have inline status — use it directly.
// Old-era pending records resolved via results.jsonl lookup.

function joinResult(pred, resultMap) {
  // Inline settled status — authoritative
  if (['settled_won', 'settled_lost', 'void'].includes(pred.status)) {
    return {
      ...pred,
      resolvedStatus: pred.status,
      resolvedResult: pred.result,
    };
  }

  const r = resultMap.get(pred.fixtureId);
  if (!r || r.fullTimeHome == null || r.fullTimeAway == null) {
    return { ...pred, resolvedStatus: 'pending', resolvedResult: null };
  }

  const totalGoals = r.totalGoals != null
    ? r.totalGoals
    : (r.fullTimeHome + r.fullTimeAway);

  let won;
  if (pred.market === 'over_2.5')  won = totalGoals > 2.5;
  else if (pred.market === 'under_2.5') won = totalGoals < 2.5;
  else if (pred.market === 'btts')
    won = r.bttsYes != null ? r.bttsYes : (r.fullTimeHome > 0 && r.fullTimeAway > 0);
  else won = null;

  return {
    ...pred,
    resolvedStatus: won == null ? 'void' : won ? 'settled_won' : 'settled_lost',
    resolvedResult: `${r.fullTimeHome}-${r.fullTimeAway}`,
  };
}

// ── Classifiers ───────────────────────────────────────────────

function confidenceTier(prob) {
  if (prob == null) return 'unknown';
  if (prob >= 0.80) return '80%+';
  if (prob >= 0.75) return '75-79%';
  if (prob >= 0.70) return '70-74%';
  if (prob >= 0.65) return '65-69%';
  if (prob >= 0.60) return '60-64%';
  if (prob >= 0.55) return '55-59%';
  if (prob >= 0.50) return '50-54%';
  return '<50%';
}

function oddsBand(odds) {
  if (odds == null) return null;
  if (odds < 1.30) return '<1.30';
  if (odds < 1.50) return '1.30-1.49';
  if (odds < 1.70) return '1.50-1.69';
  if (odds < 2.00) return '1.70-1.99';
  if (odds < 2.50) return '2.00-2.49';
  return '2.50+';
}

function edgeBand(edge) {
  if (edge == null) return null;
  if (edge < 0)    return 'negative';
  if (edge < 5)    return '0-4%';
  if (edge < 10)   return '5-9%';
  if (edge < 20)   return '10-19%';
  return '20%+';
}

// ── Segment accumulator ───────────────────────────────────────

function makeSegment() {
  return {
    _total: 0, _settled: 0, _won: 0, _pending: 0, _void: 0,
    _brierSum: 0, _probSum: 0, _probCount: 0,
    _stakes: 0, _returns: 0,
    _edgeSum: 0, _edgeCount: 0,

    add(row) {
      this._total++;
      const status = row.resolvedStatus;
      if (status === 'pending') { this._pending++; return; }
      if (status === 'void')    { this._void++;    return; }
      const won = status === 'settled_won';
      this._settled++;
      if (won) this._won++;

      if (row.dirProb != null) {
        this._brierSum += Math.pow(row.dirProb - (won ? 1 : 0), 2);
        this._probSum  += row.dirProb;
        this._probCount++;
      }

      // ROI: flat 1 unit staked each bet
      // Returns: marketOdds for a win (includes stake back), 0 for loss
      // If no odds available, count win as 1.0 return (break-even) — conservative
      this._stakes++;
      if (won) {
        this._returns += row.marketOdds != null ? row.marketOdds : 1.0;
      }

      if (row.edge != null) { this._edgeSum += row.edge; this._edgeCount++; }
    },

    finalise(label) {
      const hitRate  = this._settled > 0 ? round(this._won / this._settled, 4) : null;
      const brier    = this._settled > 0 ? round(this._brierSum / this._settled, 4) : null;
      const meanProb = this._probCount > 0 ? round(this._probSum / this._probCount, 4) : null;
      const meanEdge = this._edgeCount > 0 ? round(this._edgeSum / this._edgeCount, 2) : null;
      const roi      = this._stakes > 0
        ? round((this._returns - this._stakes) / this._stakes, 4) : null;
      const smallSample = this._settled < 30;

      return {
        label,
        total: this._total, settled: this._settled, won: this._won,
        pending: this._pending, void: this._void,
        hitRate,       hitRatePct:  pct(hitRate),
        brier,
        meanProb,      meanProbPct: pct(meanProb),
        meanEdge,
        roi,           roiPct:      pct(roi),
        smallSample,
        warning: smallSample && this._settled > 0
          ? `⚠ Only ${this._settled} settled — statistically unreliable`
          : this._settled === 0 ? '⚠ No settled predictions' : null,
      };
    },
  };
}

// ── Group-by helper ───────────────────────────────────────────

function groupBy(rows, keyFn) {
  const groups = {};
  for (const row of rows) {
    const key = keyFn(row);
    if (key == null) continue;
    if (!groups[key]) groups[key] = makeSegment();
    groups[key].add(row);
  }
  const result = {};
  for (const [k, seg] of Object.entries(groups)) result[k] = seg.finalise(k);
  return result;
}

// ── Calibration ───────────────────────────────────────────────

function buildCalibration(settledRows) {
  const BUCKETS = [
    { label: '<50%',   lo: 0,    hi: 0.50 },
    { label: '50-54%', lo: 0.50, hi: 0.55 },
    { label: '55-59%', lo: 0.55, hi: 0.60 },
    { label: '60-64%', lo: 0.60, hi: 0.65 },
    { label: '65-69%', lo: 0.65, hi: 0.70 },
    { label: '70-74%', lo: 0.70, hi: 0.75 },
    { label: '75-79%', lo: 0.75, hi: 0.80 },
    { label: '80%+',   lo: 0.80, hi: 1.01 },
  ];
  return BUCKETS.map(b => {
    const rows = settledRows.filter(r =>
      r.dirProb != null && r.dirProb >= b.lo && r.dirProb < b.hi
    );
    const won        = rows.filter(r => r.resolvedStatus === 'settled_won').length;
    const midpoint   = round((b.lo + Math.min(b.hi, 1.0)) / 2, 4);
    const actualRate = rows.length > 0 ? round(won / rows.length, 4) : null;
    return {
      bucket:        b.label,
      predicted:     midpoint,
      count:         rows.length,
      won,
      actualRate,
      actualRatePct: pct(actualRate),
      gap:           actualRate != null ? round(actualRate - midpoint, 4) : null,
      note:          actualRate != null
        ? (actualRate > midpoint + 0.05 ? 'underconfident'
           : actualRate < midpoint - 0.05 ? 'overconfident' : 'well-calibrated')
        : null,
    };
  }).filter(b => b.count > 0);
}

// ── Error log ─────────────────────────────────────────────────
// Sorted by dirProb desc — highest-confidence failures first.

function buildErrorLog(settledRows) {
  return settledRows
    .filter(r => r.resolvedStatus === 'settled_lost')
    .map(r => ({
      match:       `${r.homeTeam} vs ${r.awayTeam}`,
      date:        r.predictionDate,
      league:      r.league,
      direction:   r.direction,
      market:      r.market,
      grade:       r.grade,
      winningScore: r.winningScore,
      dirProb:     round(r.dirProb, 4),
      fairOdds:    r.fairOdds,
      marketOdds:  r.marketOdds,
      edge:        r.edge,
      result:      r.resolvedResult,
      // Input signals for diagnosis
      homeO25pct:  r.inputs?.homeO25pct ?? null,
      awayO25pct:  r.inputs?.awayO25pct ?? null,
      homeCSpct:   r.inputs?.homeCSpct  ?? null,
      awayCSpct:   r.inputs?.awayCSpct  ?? null,
      homeFTSpct:  r.inputs?.homeFTSpct ?? null,
      awayFTSpct:  r.inputs?.awayFTSpct ?? null,
      // Future enhanced fields (null until available)
      xG:          r.inputs?.xG        ?? null,
      matchType:   r.inputs?.matchType  ?? null,
    }))
    .sort((a, b) => (b.dirProb ?? 0) - (a.dirProb ?? 0));
}

// ── Main ──────────────────────────────────────────────────────

function run() {
  console.error('[backtest] reading data files...');

  const rawPredictions = readJSONL(PREDICTIONS_FILE);
  const rawResults     = readJSONL(RESULTS_FILE);

  console.error(`[backtest] raw: ${rawPredictions.length} predictions, ${rawResults.length} results`);

  const resultMap = buildResultMap(rawResults);
  console.error(`[backtest] unique result fixtures: ${resultMap.size}`);

  // Normalise all records
  const allNorm = rawPredictions.map(normalisePrediction);

  // Apply date filter
  const dateFiltered = FILTER_SINCE
    ? allNorm.filter(r => (r.predictionDate || '') >= FILTER_SINCE)
    : allNorm;

  // Separate legacy BTTS from directional rows
  const legacyRows     = dateFiltered.filter(r => r.isLegacyBTTS);
  const directionalAll = dateFiltered.filter(r => r.isDirectional);

  // Apply market filter
  const directional = FILTER_MARKET
    ? directionalAll.filter(r => r.market === FILTER_MARKET)
    : directionalAll;

  console.error(`[backtest] directional: ${directional.length}, legacy BTTS (excluded): ${legacyRows.length}`);

  // Join results
  const joined      = directional.map(p => joinResult(p, resultMap));
  const legacyJoined = legacyRows.map(p => joinResult(p, resultMap));

  // Partitions
  const settled = joined.filter(r => ['settled_won','settled_lost'].includes(r.resolvedStatus));
  const pending = joined.filter(r => r.resolvedStatus === 'pending');
  const voided  = joined.filter(r => r.resolvedStatus === 'void');

  const o25all     = joined.filter(r => r.market === 'over_2.5');
  const u25all     = joined.filter(r => r.market === 'under_2.5');
  const o25settled = settled.filter(r => r.market === 'over_2.5');
  const u25settled = settled.filter(r => r.market === 'under_2.5');

  console.error(`[backtest] settled: ${settled.length} (O2.5: ${o25settled.length}, U2.5: ${u25settled.length}), pending: ${pending.length}, void: ${voided.length}`);

  // ── Segments ─────────────────────────────────────────────────

  const overallSeg = makeSegment();
  const o25Seg     = makeSegment();
  const u25Seg     = makeSegment();

  for (const r of joined) {
    overallSeg.add(r);
    if (r.market === 'over_2.5')  o25Seg.add(r);
    if (r.market === 'under_2.5') u25Seg.add(r);
  }

  const byGrade      = groupBy(joined,   r => r.grade || 'unknown');
  const byConfidence = groupBy(joined,   r => confidenceTier(r.dirProb));
  const byLeague     = groupBy(settled,  r => r.league || r.leagueSlug || 'unknown');
  const byOddsBand   = groupBy(settled,  r => oddsBand(r.marketOdds));
  const byEdgeBand   = groupBy(settled,  r => edgeBand(r.edge));

  // Direction-split grade and confidence
  const o25byGrade      = groupBy(o25all,     r => r.grade || 'unknown');
  const u25byGrade      = groupBy(u25all,     r => r.grade || 'unknown');
  const o25byConfidence = groupBy(o25settled, r => confidenceTier(r.dirProb));
  const u25byConfidence = groupBy(u25settled, r => confidenceTier(r.dirProb));

  // ── Calibration ───────────────────────────────────────────────

  const calibAll = buildCalibration(settled);
  const calibO25 = buildCalibration(o25settled);
  const calibU25 = buildCalibration(u25settled);

  // ── Errors ────────────────────────────────────────────────────

  const errors = buildErrorLog(settled);

  // ── Legacy summary ────────────────────────────────────────────

  const legacySeg = makeSegment();
  for (const r of legacyJoined) legacySeg.add(r);

  // ── Sample-size warnings ──────────────────────────────────────

  const RELIABLE_THRESHOLD = 100;
  const sampleWarnings = [];

  if (settled.length === 0) {
    sampleWarnings.push('NO SETTLED PREDICTIONS — backtesting not yet possible. Run the settler first.');
  } else if (settled.length < 30) {
    sampleWarnings.push(`CRITICAL: Only ${settled.length} settled. All metrics are statistically meaningless. Do not draw model quality conclusions yet.`);
  } else if (settled.length < RELIABLE_THRESHOLD) {
    sampleWarnings.push(`CAUTION: ${settled.length} settled predictions. Directionally useful but high-variance. Calibration needs 200+.`);
  }

  if (o25settled.length > 0 && o25settled.length < 20) {
    sampleWarnings.push(`O2.5: only ${o25settled.length} settled — O2.5 split analysis is unreliable`);
  }
  if (u25settled.length > 0 && u25settled.length < 20) {
    sampleWarnings.push(`U2.5: only ${u25settled.length} settled — U2.5 split analysis is unreliable`);
  }

  const overallStats = overallSeg.finalise('overall');

  // ── Report ────────────────────────────────────────────────────

  const report = {
    generatedAt: new Date().toISOString(),
    dataFile:    PREDICTIONS_FILE,
    filters:     { since: FILTER_SINCE || null, market: FILTER_MARKET || null },

    sampleWarnings,

    summary: {
      totalDirectional: directional.length,
      settled:          settled.length,
      pending:          pending.length,
      void:             voided.length,
      legacyBTTSCount:  legacyRows.length,
      o25total:         o25all.length,
      u25total:         u25all.length,
      o25settled:       o25settled.length,
      u25settled:       u25settled.length,
      dateRange: {
        earliest: directional.map(r => r.predictionDate).filter(Boolean).sort()[0]            || null,
        latest:   directional.map(r => r.predictionDate).filter(Boolean).sort().slice(-1)[0]  || null,
      },
      overallAccuracy: overallStats.hitRate,
      overallROI:      overallStats.roi,
      overallBrier:    overallStats.brier,
      meanEdge:        overallStats.meanEdge,
    },

    byDirection: {
      over_2_5:  o25Seg.finalise('over_2.5'),
      under_2_5: u25Seg.finalise('under_2.5'),
    },

    byGrade,
    byGradeDirection: { over_2_5: o25byGrade, under_2_5: u25byGrade },

    byConfidenceTier: byConfidence,
    byConfidenceTierDirection: { over_2_5: o25byConfidence, under_2_5: u25byConfidence },

    // League / odds / edge — settled rows only (meaningful sample needed)
    byLeague,
    byOddsBand,
    byEdgeBand,

    calibration: {
      note: 'gap = actual - predicted. Positive = model underconfident; negative = overconfident.',
      all:       calibAll,
      over_2_5:  calibO25,
      under_2_5: calibU25,
    },

    errors: {
      count: errors.length,
      note:  'Sorted by dirProb desc — highest-confidence failures first. Most instructive for model diagnosis.',
      rows:  errors,
    },

    legacyBTTS: {
      note: 'Legacy BTTS records. Excluded from all directional metrics above.',
      ...legacySeg.finalise('legacy_btts'),
    },

    // Stub for future base-vs-enhanced comparison
    modelComparison: {
      available: false,
      note: 'Populate when context/xG/matchType fields exist. Fields: baseAccuracy, enhancedAccuracy, roiDelta, brierDelta, falsePosReduced, falseNegReduced.',
      base: {
        accuracy: overallStats.hitRate,
        roi:      overallStats.roi,
        brier:    overallStats.brier,
        settled:  settled.length,
      },
      enhanced: null,
    },
  };

  return report;
}

// ── Run and output ────────────────────────────────────────────

const report = run();
const json   = JSON.stringify(report, null, 2);

if (OUTPUT_FILE) {
  const dir = path.dirname(OUTPUT_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, json, 'utf8');
  console.error(`[backtest] report written to: ${OUTPUT_FILE}`);
} else {
  process.stdout.write(json + '\n');
}

// ── Human-readable summary → stderr ──────────────────────────

const s  = report.summary;
const d  = report.byDirection;
const o  = d.over_2_5;
const u  = d.under_2_5;

function fmt(v, suffix = '') {
  return v != null ? `${v}${suffix}` : 'n/a';
}

console.error('');
console.error('══════════════════════════════════════════════════');
console.error('  GoalScout Backtest Report');
console.error('══════════════════════════════════════════════════');
console.error('');

if (report.sampleWarnings.length) {
  report.sampleWarnings.forEach(w => console.error(`  ⚠  ${w}`));
  console.error('');
}

console.error(`  Directional predictions : ${s.totalDirectional}  (O2.5: ${s.o25total}, U2.5: ${s.u25total})`);
console.error(`  Settled                 : ${s.settled}  (O2.5: ${s.o25settled}, U2.5: ${s.u25settled})`);
console.error(`  Pending / Void          : ${s.pending} / ${s.void}`);
console.error(`  Legacy BTTS excluded    : ${s.legacyBTTSCount}`);
console.error(`  Date range              : ${s.dateRange.earliest} → ${s.dateRange.latest}`);
console.error('');
console.error(`  Overall accuracy        : ${fmt(pct(s.overallAccuracy), '%')}`);
console.error(`  Overall Brier score     : ${fmt(s.overallBrier)} (0.25 = coin flip)`);
console.error(`  Mean edge               : ${fmt(s.meanEdge, '%')}`);
console.error(`  ROI (flat stake)        : ${fmt(pct(s.overallROI), '%')}${s.overallROI != null && s.meanEdge == null ? '  [no odds — approximate]' : ''}`);
console.error('');
console.error('  Direction split (settled):');
console.error(`    O2.5  accuracy: ${fmt(o.hitRatePct, '%')}  brier: ${fmt(o.brier)}  edge: ${fmt(o.meanEdge, '%')}  roi: ${fmt(pct(o.roi), '%')}  n=${o.settled}`);
console.error(`    U2.5  accuracy: ${fmt(u.hitRatePct, '%')}  brier: ${fmt(u.brier)}  edge: ${fmt(u.meanEdge, '%')}  roi: ${fmt(pct(u.roi), '%')}  n=${u.settled}`);

if (report.byGrade && Object.keys(report.byGrade).length) {
  console.error('');
  console.error('  By grade (settled):');
  for (const [g, stats] of Object.entries(report.byGrade)) {
    if (stats.settled > 0) {
      console.error(`    Grade ${g}  accuracy: ${fmt(stats.hitRatePct, '%')}  n=${stats.settled}${stats.smallSample ? ' ⚠' : ''}`);
    }
  }
}

if (report.errors.rows.length) {
  console.error('');
  console.error(`  High-confidence losses (${Math.min(5, report.errors.count)} of ${report.errors.count}):`);
  report.errors.rows.slice(0, 5).forEach(e => {
    console.error(`    ${Math.round(e.dirProb * 100)}% ${e.direction?.toUpperCase() || e.market}  ${e.match}  [${e.result}]  ${e.league || ''}`);
  });
}

console.error('');
console.error('══════════════════════════════════════════════════');
console.error('');
