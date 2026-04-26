// scripts/context/train-calibration.js
// ─────────────────────────────────────────────────────────────
// Stage 9 — Backtest calibration training + validation.
//
// Fits Platt scaling (logistic sigmoid) on context_raw probability
// outputs vs actual binary outcomes, per league.
//
// Design:
//   - England and Germany only (see ARCHITECTURE.md Stage 9 rationale)
//   - Exclude 2019-20 (COVID anomaly — irregular conditions)
//   - Train set:  2020-21, 2021-22, 2022-23
//   - Test set:   2023-24, 2024-25 (held-out, newer seasons)
//   - One Platt calibrator per league per direction
//   - Outputs calibration parameters + validation metrics to:
//       data/calibration/{league}_{direction}_v1.json
//       scripts/context/CALIBRATION-REPORT.md
//
// Usage:
//   docker exec goalscout node /app/scripts/context/train-calibration.js
//
// Platt scaling:
//   Fit a logistic regression f(p) = 1 / (1 + exp(A*p + B))
//   where p = raw model probability (context_o25_prob_raw or 1-p for u25)
//   and the target is the binary outcome (won = 1, lost = 0).
//
//   Optimised via Newton-Raphson on the log-likelihood.
//
// References:
//   Platt (1999) "Probabilistic Outputs for Support Vector Machines"
//   Niculescu-Mizil & Caruana (2005) "Predicting Good Probabilities"
// ─────────────────────────────────────────────────────────────

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Path resolution — works both inside Docker and from host ──
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../../data');
const BACKTEST_DIR = path.join(DATA_DIR, 'backtests', 'context_raw');
const CALIB_DIR    = path.join(DATA_DIR, 'calibration');
const REPORT_PATH  = path.join(__dirname, 'CALIBRATION-REPORT.md');

// ── Configuration ─────────────────────────────────────────────
const LEAGUES = ['england', 'germany'];
const DIRECTION = 'o25';  // primary validated signal

// Season filename tokens per league
const SEASON_TOKENS = {
  england: {
    train: ['2020_21', '2021_22', '2022_23'],
    test:  ['2023_24', '2024_25'],
    excluded: ['2019_20'],  // COVID
  },
  germany: {
    train: ['20_21', '21_22', '22_23'],
    test:  ['23_24', '24_25'],
    excluded: ['19_20'],    // COVID — same rationale
  },
};

const CALIB_VERSION = 'v1';
const BACKTEST_MODEL_VERSION = 'context_raw_v1.2';

// ── Data loading ──────────────────────────────────────────────

function loadRows(league, seasons) {
  const rows = [];
  for (const s of seasons) {
    const file = path.join(BACKTEST_DIR, `${league}_${s}.jsonl`);
    if (!fs.existsSync(file)) {
      console.warn(`  [warn] missing: ${path.basename(file)}`);
      continue;
    }
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    for (const line of lines) {
      try {
        const r = JSON.parse(line);
        // Only use settled O2.5 predictions with valid probability and outcome
        if (
          r.status === 'settled' &&
          r.context_direction === DIRECTION &&
          r.context_o25_prob_raw != null &&
          r.won !== null
        ) {
          rows.push({
            prob:   r.context_o25_prob_raw,      // raw model probability
            outcome: r.won ? 1 : 0,              // binary outcome
            grade:  r.context_grade,
            fairOdds: r.context_fair_odds,
            marketOdds: r.marketOdds,
            season: r.season,
          });
        }
      } catch { /* skip malformed lines */ }
    }
  }
  return rows;
}

// ── Platt scaling — Newton-Raphson MLE ───────────────────────
//
// Maximise log-likelihood:
//   L(A,B) = Σ [ y_i * log(p_i) + (1 - y_i) * log(1 - p_i) ]
//   where p_i = sigmoid(A * rawProb_i + B)
//
// Platt (1999) uses a modified target to regularise small samples:
//   y_pos = (N_pos + 1) / (N_pos + 2)
//   y_neg = 1 / (N_neg + 2)
// We use this when N < 500; skip for larger samples.

function sigmoid(x) {
  // Numerically stable sigmoid
  if (x >= 0) return 1 / (1 + Math.exp(-x));
  const ex = Math.exp(x);
  return ex / (1 + ex);
}

function plattFit(probs, outcomes, maxIter = 100, tol = 1e-7) {
  const n = probs.length;
  const nPos = outcomes.reduce((s, y) => s + y, 0);
  const nNeg = n - nPos;

  // Platt regularised targets (applies when sample is small-ish)
  const useRegularised = n < 500;
  const yPos = useRegularised ? (nPos + 1) / (nPos + 2) : 1.0;
  const yNeg = useRegularised ? 1 / (nNeg + 2) : 0.0;
  const targets = outcomes.map(y => y === 1 ? yPos : yNeg);

  let A = 0.0;
  let B = Math.log((nNeg + 1) / (nPos + 1)); // sensible initialisation

  for (let iter = 0; iter < maxIter; iter++) {
    // Compute gradient and Hessian
    let h11 = 0, h22 = 0, h21 = 0;  // Hessian
    let g1  = 0, g2  = 0;            // gradient

    for (let i = 0; i < n; i++) {
      const fApB   = A * probs[i] + B;
      const p      = sigmoid(fApB);
      const q      = 1 - p;
      const d2     = p * q;
      const t      = targets[i];

      g1  += probs[i] * (p - t);
      g2  += (p - t);
      h11 += probs[i] * probs[i] * d2;
      h22 += d2;
      h21 += probs[i] * d2;
    }

    // Newton step — solve 2×2 system
    const det = h11 * h22 - h21 * h21;
    if (Math.abs(det) < 1e-15) break;  // singular — shouldn't happen with real data

    const dA = -(h22 * g1 - h21 * g2) / det;
    const dB = -(-h21 * g1 + h11 * g2) / det;

    A += dA;
    B += dB;

    if (Math.abs(dA) < tol && Math.abs(dB) < tol) break;
  }

  return { A, B };
}

function applyPlatt(rawProb, A, B) {
  return sigmoid(A * rawProb + B);
}

// ── Evaluation metrics ────────────────────────────────────────

function brier(probs, outcomes) {
  if (!probs.length) return null;
  const ss = probs.reduce((s, p, i) => s + Math.pow(p - outcomes[i], 2), 0);
  return ss / probs.length;
}

// Expected Calibration Error — 10 equal-width bins
function ece(probs, outcomes, nBins = 10) {
  const n   = probs.length;
  const bins = Array.from({ length: nBins }, () => ({ sumP: 0, sumY: 0, count: 0 }));

  for (let i = 0; i < n; i++) {
    const b = Math.min(Math.floor(probs[i] * nBins), nBins - 1);
    bins[b].sumP  += probs[i];
    bins[b].sumY  += outcomes[i];
    bins[b].count += 1;
  }

  let err = 0;
  for (const bin of bins) {
    if (!bin.count) continue;
    const avgP = bin.sumP / bin.count;
    const avgY = bin.sumY / bin.count;
    err += (bin.count / n) * Math.abs(avgP - avgY);
  }
  return err;
}

// Reliability table — fixed-width probability buckets for the report
function reliabilityTable(rawProbs, calProbs, outcomes) {
  const buckets = [
    { lo: 0.50, hi: 0.55 },
    { lo: 0.55, hi: 0.60 },
    { lo: 0.60, hi: 0.65 },
    { lo: 0.65, hi: 0.70 },
    { lo: 0.70, hi: 0.75 },
    { lo: 0.75, hi: 1.01 },
  ];

  return buckets.map(({ lo, hi }) => {
    // Rows that fall in this bucket by RAW probability
    const idxs = rawProbs.reduce((a, p, i) => {
      if (p >= lo && p < hi) a.push(i);
      return a;
    }, []);

    const n      = idxs.length;
    const actual = idxs.length ? idxs.reduce((s, i) => s + outcomes[i], 0) / n * 100 : null;
    const rawMid = idxs.length ? idxs.reduce((s, i) => s + rawProbs[i], 0) / n * 100 : null;
    const calMid = idxs.length ? idxs.reduce((s, i) => s + calProbs[i], 0) / n * 100 : null;
    const rawErr = actual != null && rawMid != null ? rawMid - actual : null;
    const calErr = actual != null && calMid != null ? calMid - actual : null;

    return { lo, hi, n, actual, rawMid, calMid, rawErr, calErr };
  });
}

// ── Hit rate and ROI helpers ──────────────────────────────────

function hitRateAndROI(rows) {
  const settled = rows.filter(r => r.outcome !== undefined);
  const won     = settled.filter(r => r.outcome === 1).length;
  const roiRows = settled.filter(r => r.marketOdds != null);
  const pnl     = roiRows.reduce((s, r) => s + (r.outcome === 1 ? r.marketOdds - 1 : -1), 0);
  return {
    n:      settled.length,
    won,
    hitRate: settled.length ? won / settled.length * 100 : null,
    roi:    roiRows.length  ? pnl / roiRows.length * 100  : null,
  };
}

// ── Main ──────────────────────────────────────────────────────

function runLeague(league) {
  const cfg = SEASON_TOKENS[league];
  console.log(`\n${'═'.repeat(62)}`);
  console.log(`  ${league.toUpperCase()}  —  Platt calibration  (${DIRECTION.toUpperCase()})`);
  console.log(`  Train: ${cfg.train.join(', ')}   Test: ${cfg.test.join(', ')}`);
  console.log('═'.repeat(62));

  // Load splits
  const trainRows = loadRows(league, cfg.train);
  const testRows  = loadRows(league, cfg.test);

  console.log(`\n  Train set: ${trainRows.length} predictions`);
  console.log(`  Test set:  ${testRows.length} predictions`);

  if (trainRows.length < 50) {
    console.error(`  [error] insufficient training data (${trainRows.length} < 50)`);
    return null;
  }

  // Fit Platt parameters on train set
  const trainProbs    = trainRows.map(r => r.prob);
  const trainOutcomes = trainRows.map(r => r.outcome);
  const { A, B }      = plattFit(trainProbs, trainOutcomes);

  console.log(`\n  Platt parameters:  A = ${A.toFixed(6)}   B = ${B.toFixed(6)}`);

  // Apply calibrator to both sets
  const trainCalProbs = trainProbs.map(p => applyPlatt(p, A, B));
  const testProbs     = testRows.map(r => r.prob);
  const testOutcomes  = testRows.map(r => r.outcome);
  const testCalProbs  = testProbs.map(p => applyPlatt(p, A, B));

  // ── Brier ──────────────────────────────────────────────────
  const brierTrainRaw = brier(trainProbs,    trainOutcomes);
  const brierTrainCal = brier(trainCalProbs, trainOutcomes);
  const brierTestRaw  = brier(testProbs,     testOutcomes);
  const brierTestCal  = brier(testCalProbs,  testOutcomes);

  // ── ECE ───────────────────────────────────────────────────
  const eceTrainRaw = ece(trainProbs,    trainOutcomes) * 100;
  const eceTrainCal = ece(trainCalProbs, trainOutcomes) * 100;
  const eceTestRaw  = ece(testProbs,     testOutcomes)  * 100;
  const eceTestCal  = ece(testCalProbs,  testOutcomes)  * 100;

  // ── Mean probability shift ────────────────────────────────
  const meanRawTest = testProbs.reduce((s, p) => s + p, 0) / testProbs.length * 100;
  const meanCalTest = testCalProbs.reduce((s, p) => s + p, 0) / testCalProbs.length * 100;
  const actualHit   = testOutcomes.reduce((s, y) => s + y, 0) / testOutcomes.length * 100;

  // ── Reliability table (test set) ─────────────────────────
  const relTable = reliabilityTable(testProbs, testCalProbs, testOutcomes);

  // ── Grade breakdown on test set ──────────────────────────
  const grades = ['A+', 'A', 'B'];
  const gradeStats = grades.map(g => {
    const gr  = testRows.filter(r => r.grade === g);
    const gRaw = gr.map(r => r.prob);
    const gCal = gRaw.map(p => applyPlatt(p, A, B));
    const gOut = gr.map(r => r.outcome);
    return {
      grade:   g,
      n:       gr.length,
      hitRate: gOut.length ? gOut.reduce((s, y) => s + y, 0) / gOut.length * 100 : null,
      meanRaw: gRaw.length ? gRaw.reduce((s, p) => s + p, 0) / gRaw.length * 100 : null,
      meanCal: gCal.length ? gCal.reduce((s, p) => s + p, 0) / gCal.length * 100 : null,
    };
  });

  // ── Console output ────────────────────────────────────────
  console.log(`\n── Brier Score ──`);
  console.log(`  Train  raw: ${brierTrainRaw.toFixed(4)}   calibrated: ${brierTrainCal.toFixed(4)}   Δ: ${(brierTrainCal - brierTrainRaw).toFixed(4)}`);
  console.log(`  Test   raw: ${brierTestRaw.toFixed(4)}   calibrated: ${brierTestCal.toFixed(4)}   Δ: ${(brierTestCal - brierTestRaw).toFixed(4)}`);
  const brierTestImproved = brierTestCal < brierTestRaw;
  console.log(`  Test improvement: ${brierTestImproved ? '✓ YES' : '✗ NO'} (${brierTestImproved ? '-' : '+'}${Math.abs((brierTestCal - brierTestRaw) * 1000).toFixed(1)} millibriers)`);

  console.log(`\n── Expected Calibration Error (ECE) ──`);
  console.log(`  Train  raw: ${eceTrainRaw.toFixed(2)}pp   calibrated: ${eceTrainCal.toFixed(2)}pp   Δ: ${(eceTrainCal - eceTrainRaw).toFixed(2)}pp`);
  console.log(`  Test   raw: ${eceTestRaw.toFixed(2)}pp   calibrated: ${eceTestCal.toFixed(2)}pp   Δ: ${(eceTestCal - eceTestRaw).toFixed(2)}pp`);
  const eceTestImproved = eceTestCal < eceTestRaw;
  console.log(`  Test improvement: ${eceTestImproved ? '✓ YES' : '✗ NO'}`);

  console.log(`\n── Mean probability shift (test set) ──`);
  console.log(`  Mean raw:         ${meanRawTest.toFixed(1)}%`);
  console.log(`  Mean calibrated:  ${meanCalTest.toFixed(1)}%`);
  console.log(`  Actual hit rate:  ${actualHit.toFixed(1)}%`);
  console.log(`  Raw gap:          ${(meanRawTest - actualHit).toFixed(1)}pp`);
  console.log(`  Calibrated gap:   ${(meanCalTest - actualHit).toFixed(1)}pp`);

  console.log(`\n── Reliability table (test set, binned by raw probability) ──`);
  console.log(`  ${'Range'.padEnd(10)} ${'n'.padStart(4)}  ${'Actual'.padStart(7)}  ${'Raw→'.padStart(7)}  ${'Cal→'.padStart(7)}  ${'RawErr'.padStart(8)}  ${'CalErr'.padStart(8)}`);
  console.log('  ' + '─'.repeat(66));
  for (const b of relTable) {
    if (!b.n) continue;
    const actual = b.actual != null ? b.actual.toFixed(1) + '%' : '—';
    const rawM   = b.rawMid != null ? b.rawMid.toFixed(1) + '%' : '—';
    const calM   = b.calMid != null ? b.calMid.toFixed(1) + '%' : '—';
    const rErr   = b.rawErr != null ? (b.rawErr > 0 ? '+' : '') + b.rawErr.toFixed(1) + 'pp' : '—';
    const cErr   = b.calErr != null ? (b.calErr > 0 ? '+' : '') + b.calErr.toFixed(1) + 'pp' : '—';
    const rangeStr = (b.lo * 100).toFixed(0) + '–' + (b.hi >= 1 ? '100' : (b.hi * 100).toFixed(0)) + '%';
    console.log(`  ${rangeStr.padEnd(10)} ${String(b.n).padStart(4)}  ${actual.padStart(7)}  ${rawM.padStart(7)}  ${calM.padStart(7)}  ${rErr.padStart(8)}  ${cErr.padStart(8)}`);
  }

  console.log(`\n── Grade breakdown (test set) ──`);
  console.log(`  ${'Grade'.padEnd(5)} ${'n'.padStart(4)}  ${'Hit%'.padStart(6)}  ${'MeanRaw'.padStart(8)}  ${'MeanCal'.padStart(8)}  ${'RawGap'.padStart(8)}  ${'CalGap'.padStart(8)}`);
  for (const g of gradeStats) {
    if (!g.n) continue;
    const hit    = g.hitRate != null ? g.hitRate.toFixed(1) + '%' : '—';
    const raw    = g.meanRaw != null ? g.meanRaw.toFixed(1) + '%' : '—';
    const cal    = g.meanCal != null ? g.meanCal.toFixed(1) + '%' : '—';
    const rGap   = g.meanRaw != null && g.hitRate != null ? ((g.meanRaw - g.hitRate) > 0 ? '+' : '') + (g.meanRaw - g.hitRate).toFixed(1) + 'pp' : '—';
    const cGap   = g.meanCal != null && g.hitRate != null ? ((g.meanCal - g.hitRate) > 0 ? '+' : '') + (g.meanCal - g.hitRate).toFixed(1) + 'pp' : '—';
    console.log(`  ${g.grade.padEnd(5)} ${String(g.n).padStart(4)}  ${hit.padStart(6)}  ${raw.padStart(8)}  ${cal.padStart(8)}  ${rGap.padStart(8)}  ${cGap.padStart(8)}`);
  }

  // ── Pass/fail ──────────────────────────────────────────────
  const testEceReduced = eceTestCal < eceTestRaw;
  const testBrierImpr  = brierTestCal <= brierTestRaw;
  const calibGapClosed = Math.abs(meanCalTest - actualHit) < Math.abs(meanRawTest - actualHit);
  const sharpnessOK    = (() => {
    const stdRaw = Math.sqrt(testProbs.reduce((s, p) => s + Math.pow(p - meanRawTest/100, 2), 0) / testProbs.length);
    const stdCal = Math.sqrt(testCalProbs.reduce((s, p) => s + Math.pow(p - meanCalTest/100, 2), 0) / testCalProbs.length);
    return stdCal >= stdRaw * 0.7; // calibration shouldn't collapse sharpness by >30%
  })();

  const passes = [testEceReduced, testBrierImpr, calibGapClosed, sharpnessOK];
  const nPass  = passes.filter(Boolean).length;

  console.log(`\n── Pass/fail ──`);
  console.log(`  ECE reduced on test set:           ${testEceReduced ? '✓ PASS' : '✗ FAIL'}`);
  console.log(`  Brier improved on test set:        ${testBrierImpr  ? '✓ PASS' : '✗ FAIL'}`);
  console.log(`  Calibration gap closed:            ${calibGapClosed ? '✓ PASS' : '✗ FAIL'}`);
  console.log(`  Sharpness preserved (≥70% of raw): ${sharpnessOK    ? '✓ PASS' : '✗ FAIL'}`);
  console.log(`\n  Overall: ${nPass}/4 — ${nPass === 4 ? '✓ CALIBRATION VALID' : nPass >= 3 ? '⚠ MOSTLY VALID (review failures)' : '✗ CALIBRATION UNRELIABLE'}`);

  // ── Save parameters ───────────────────────────────────────
  fs.mkdirSync(CALIB_DIR, { recursive: true });
  const outFile = path.join(CALIB_DIR, `${league}_${DIRECTION}_${CALIB_VERSION}.json`);
  const params = {
    league,
    direction:          DIRECTION,
    version:            CALIB_VERSION,
    method:             'platt_scaling',
    backtestModelVersion: BACKTEST_MODEL_VERSION,
    trainSeasons:       cfg.train,
    testSeasons:        cfg.test,
    excludedSeasons:    cfg.excluded,
    A:                  A,
    B:                  B,
    trainN:             trainRows.length,
    testN:              testRows.length,
    metrics: {
      train: { brierRaw: brierTrainRaw, brierCal: brierTrainCal, eceRaw: eceTrainRaw, eceCal: eceTrainCal },
      test:  {
        brierRaw: brierTestRaw, brierCal: brierTestCal,
        eceRaw: eceTestRaw, eceCal: eceTestCal,
        meanRawProb: meanRawTest, meanCalProb: meanCalTest, actualHitRate: actualHit,
        rawCalibGap: meanRawTest - actualHit,
        calCalibGap: meanCalTest - actualHit,
      },
    },
    passFail: {
      eceReduced:     testEceReduced,
      brierImproved:  testBrierImpr,
      calibGapClosed: calibGapClosed,
      sharpnessOK:    sharpnessOK,
      overall:        nPass === 4 ? 'VALID' : nPass >= 3 ? 'MOSTLY_VALID' : 'UNRELIABLE',
    },
    generatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(outFile, JSON.stringify(params, null, 2));
  console.log(`\n  Parameters saved → ${path.relative(process.cwd(), outFile)}`);

  return { league, params, relTable, gradeStats, brierTestRaw, brierTestCal, eceTestRaw, eceTestCal,
           meanRawTest, meanCalTest, actualHit, nPass };
}

// ── Markdown report ───────────────────────────────────────────

function writeReport(results) {
  const ts = new Date().toISOString().slice(0, 10);
  let md = `# Stage 9 — Calibration Training Report\n\n`;
  md += `Generated: ${ts}  \n`;
  md += `Model: ${BACKTEST_MODEL_VERSION}  \n`;
  md += `Method: Platt scaling (logistic sigmoid)  \n\n`;
  md += `---\n\n`;
  md += `## Train / Test split\n\n`;
  md += `| League | Train seasons | Test seasons | Excluded |\n`;
  md += `|--------|--------------|-------------|----------|\n`;
  for (const league of LEAGUES) {
    const cfg = SEASON_TOKENS[league];
    md += `| ${league} | ${cfg.train.join(', ')} | ${cfg.test.join(', ')} | ${cfg.excluded.join(', ')} (COVID) |\n`;
  }
  md += `\n---\n\n`;

  for (const r of results) {
    if (!r) continue;
    md += `## ${r.league.charAt(0).toUpperCase() + r.league.slice(1)} — O2.5\n\n`;
    md += `**Platt parameters:** A = \`${r.params.A.toFixed(6)}\`, B = \`${r.params.B.toFixed(6)}\`  \n`;
    md += `**Train N:** ${r.params.trainN}   **Test N:** ${r.params.testN}\n\n`;

    md += `### Key metrics (test set)\n\n`;
    md += `| Metric | Raw | Calibrated | Change | Verdict |\n`;
    md += `|--------|-----|-----------|--------|---------|\n`;
    md += `| Brier score | ${r.brierTestRaw.toFixed(4)} | ${r.brierTestCal.toFixed(4)} | ${(r.brierTestCal - r.brierTestRaw).toFixed(4)} | ${r.params.passFail.brierImproved ? '✓' : '✗'} |\n`;
    md += `| ECE | ${r.eceTestRaw.toFixed(2)}pp | ${r.eceTestCal.toFixed(2)}pp | ${(r.eceTestCal - r.eceTestRaw).toFixed(2)}pp | ${r.params.passFail.eceReduced ? '✓' : '✗'} |\n`;
    md += `| Mean prob | ${r.meanRawTest.toFixed(1)}% | ${r.meanCalTest.toFixed(1)}% | — | — |\n`;
    md += `| Actual hit rate | ${r.actualHit.toFixed(1)}% | — | — | — |\n`;
    md += `| Calibration gap | ${(r.meanRawTest - r.actualHit).toFixed(1)}pp | ${(r.meanCalTest - r.actualHit).toFixed(1)}pp | ${((r.meanCalTest - r.actualHit) - (r.meanRawTest - r.actualHit)).toFixed(1)}pp | ${r.params.passFail.calibGapClosed ? '✓' : '✗'} |\n\n`;

    md += `### Reliability table (test set)\n\n`;
    md += `Rows bucketed by **raw** probability. Raw→ and Cal→ show mean predicted probability for that bucket.\n\n`;
    md += `| Range | n | Actual | Raw→ | Cal→ | Raw error | Cal error |\n`;
    md += `|-------|---|--------|------|------|-----------|----------|\n`;
    for (const b of r.relTable) {
      if (!b.n) continue;
      const rangeStr = (b.lo * 100).toFixed(0) + '–' + (b.hi >= 1 ? '100' : (b.hi * 100).toFixed(0)) + '%';
      const actual = b.actual != null ? b.actual.toFixed(1) + '%' : '—';
      const rawM   = b.rawMid != null ? b.rawMid.toFixed(1) + '%' : '—';
      const calM   = b.calMid != null ? b.calMid.toFixed(1) + '%' : '—';
      const rErr   = b.rawErr != null ? (b.rawErr > 0 ? '+' : '') + b.rawErr.toFixed(1) + 'pp' : '—';
      const cErr   = b.calErr != null ? (b.calErr > 0 ? '+' : '') + b.calErr.toFixed(1) + 'pp' : '—';
      md += `| ${rangeStr} | ${b.n} | ${actual} | ${rawM} | ${calM} | ${rErr} | ${cErr} |\n`;
    }

    md += `\n### Grade breakdown (test set)\n\n`;
    md += `| Grade | n | Hit% | Mean raw | Mean cal | Raw gap | Cal gap |\n`;
    md += `|-------|---|------|----------|----------|---------|--------|\n`;
    for (const g of r.gradeStats) {
      if (!g.n) continue;
      const hit  = g.hitRate != null ? g.hitRate.toFixed(1) + '%' : '—';
      const raw  = g.meanRaw != null ? g.meanRaw.toFixed(1) + '%' : '—';
      const cal  = g.meanCal != null ? g.meanCal.toFixed(1) + '%' : '—';
      const rG   = g.meanRaw != null && g.hitRate != null ? (g.meanRaw - g.hitRate > 0 ? '+' : '') + (g.meanRaw - g.hitRate).toFixed(1) + 'pp' : '—';
      const cG   = g.meanCal != null && g.hitRate != null ? (g.meanCal - g.hitRate > 0 ? '+' : '') + (g.meanCal - g.hitRate).toFixed(1) + 'pp' : '—';
      md += `| ${g.grade} | ${g.n} | ${hit} | ${raw} | ${cal} | ${rG} | ${cG} |\n`;
    }

    md += `\n### Pass/fail\n\n`;
    md += `| Check | Result |\n|-------|--------|\n`;
    md += `| ECE reduced on test set | ${r.params.passFail.eceReduced ? '✓ PASS' : '✗ FAIL'} |\n`;
    md += `| Brier improved on test set | ${r.params.passFail.brierImproved ? '✓ PASS' : '✗ FAIL'} |\n`;
    md += `| Calibration gap closed | ${r.params.passFail.calibGapClosed ? '✓ PASS' : '✗ FAIL'} |\n`;
    md += `| Sharpness preserved (≥70% of raw) | ${r.params.passFail.sharpnessOK ? '✓ PASS' : '✗ FAIL'} |\n`;
    md += `\n**Overall: ${r.nPass}/4 — ${r.params.passFail.overall}**\n\n`;
    md += `---\n\n`;
  }

  md += `## Interpretation guide\n\n`;
  md += `- **Brier score**: Mean squared error between predicted probability and binary outcome. Lower = better. 0.25 = coin flip.\n`;
  md += `- **ECE (Expected Calibration Error)**: Mean absolute gap between predicted probability and actual hit rate, weighted by bucket size. Lower = better. 0pp = perfect calibration.\n`;
  md += `- **Calibration gap**: Mean predicted probability minus actual hit rate. Positive = model overstates confidence.\n`;
  md += `- **Sharpness**: Spread of predicted probabilities. Calibration should not collapse all predictions toward the mean — that destroys discriminative power.\n`;
  md += `- **VALID**: All 4 checks pass. Calibrated probabilities are ready for use in Stage 10 paper-tracking.\n`;
  md += `- **MOSTLY_VALID**: 3/4 pass. Review the failing check before Stage 10.\n`;
  md += `- **UNRELIABLE**: ≤2 pass. Do not proceed. Investigate calibration approach.\n\n`;
  md += `---\n\n`;
  md += `*Parameters saved to \`data/calibration/{league}_o25_v1.json\` — do not commit these files (data/ is gitignored).*\n`;

  fs.writeFileSync(REPORT_PATH, md);
  console.log(`\nReport saved → ${path.relative(process.cwd(), REPORT_PATH)}`);
}

// ── Entry point ───────────────────────────────────────────────

console.log('Stage 9 — Platt scaling calibration');
console.log(`Backtest dir: ${BACKTEST_DIR}`);
console.log(`Output dir:   ${CALIB_DIR}`);

const results = LEAGUES.map(runLeague);

writeReport(results);

console.log('\n' + '═'.repeat(62));
console.log('  Done.');
console.log('═'.repeat(62));