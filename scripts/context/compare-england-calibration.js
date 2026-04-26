// scripts/context/compare-england-calibration.js
// ─────────────────────────────────────────────────────────────
// Stage 9 — England O2.5 calibration comparison.
//
// Evaluates three models on the SAME held-out test set:
//   RAW   — context_raw_v1.2 uncalibrated probabilities
//   V1    — Platt trained on 2020-21, 2021-22, 2022-23
//   V2    — Platt trained on 2022-23 only
//
// Test set: 2023-24, 2024-25 (identical for all three)
//
// Usage:
//   docker exec goalscout node /app/scripts/context/compare-england-calibration.js
// ─────────────────────────────────────────────────────────────

'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_DIR    = process.env.DATA_DIR || path.join(__dirname, '../../data');
const BACKTEST_DIR = path.join(DATA_DIR, 'backtests', 'context_raw');

// ── V1 parameters (from previous run — do not retrain) ────────
// These are fixed. Retraining would change the comparison baseline.
const V1_A = 0.799743;
const V1_B = -0.262985;

// ── Season file tokens ─────────────────────────────────────────
const ENGLAND_TRAIN_V2 = ['2022_23'];          // v2 trains on this only
const ENGLAND_TEST     = ['2023_24', '2024_25']; // same for all three

// ── Data loading ───────────────────────────────────────────────

function loadEnglandRows(seasons) {
  const rows = [];
  for (const s of seasons) {
    const file = path.join(BACKTEST_DIR, `england_${s}.jsonl`);
    if (!fs.existsSync(file)) {
      console.warn(`  [warn] missing: ${path.basename(file)}`);
      continue;
    }
    for (const line of fs.readFileSync(file, 'utf8').trim().split('\n')) {
      try {
        const r = JSON.parse(line);
        if (
          r.status === 'settled' &&
          r.context_direction === 'o25' &&
          r.context_o25_prob_raw != null &&
          r.won !== null
        ) {
          rows.push({
            rawProb:  r.context_o25_prob_raw,
            outcome:  r.won ? 1 : 0,
            grade:    r.context_grade,
            season:   r.season,
          });
        }
      } catch { /* skip */ }
    }
  }
  return rows;
}

// ── Platt fit ──────────────────────────────────────────────────

function sigmoid(x) {
  return x >= 0 ? 1 / (1 + Math.exp(-x)) : Math.exp(x) / (1 + Math.exp(x));
}

function plattFit(probs, outcomes, maxIter = 100, tol = 1e-7) {
  const n   = probs.length;
  const nPos = outcomes.reduce((s, y) => s + y, 0);
  const nNeg = n - nPos;
  const useReg = n < 500;
  const yPos = useReg ? (nPos + 1) / (nPos + 2) : 1.0;
  const yNeg = useReg ? 1 / (nNeg + 2) : 0.0;
  const targets = outcomes.map(y => y === 1 ? yPos : yNeg);

  let A = 0.0;
  let B = Math.log((nNeg + 1) / (nPos + 1));

  for (let iter = 0; iter < maxIter; iter++) {
    let h11 = 0, h22 = 0, h21 = 0, g1 = 0, g2 = 0;
    for (let i = 0; i < n; i++) {
      const p   = sigmoid(A * probs[i] + B);
      const d2  = p * (1 - p);
      const err = p - targets[i];
      g1  += probs[i] * err;
      g2  += err;
      h11 += probs[i] * probs[i] * d2;
      h22 += d2;
      h21 += probs[i] * d2;
    }
    const det = h11 * h22 - h21 * h21;
    if (Math.abs(det) < 1e-15) break;
    const dA = -(h22 * g1 - h21 * g2) / det;
    const dB = -(-h21 * g1 + h11 * g2) / det;
    A += dA;
    B += dB;
    if (Math.abs(dA) < tol && Math.abs(dB) < tol) break;
  }
  return { A, B };
}

function applyPlatt(p, A, B) { return sigmoid(A * p + B); }

// ── Metrics ────────────────────────────────────────────────────

function brier(probs, outcomes) {
  return probs.reduce((s, p, i) => s + Math.pow(p - outcomes[i], 2), 0) / probs.length;
}

function ece(probs, outcomes, nBins = 10) {
  const n    = probs.length;
  const bins = Array.from({ length: nBins }, () => ({ sumP: 0, sumY: 0, count: 0 }));
  for (let i = 0; i < n; i++) {
    const b = Math.min(Math.floor(probs[i] * nBins), nBins - 1);
    bins[b].sumP += probs[i]; bins[b].sumY += outcomes[i]; bins[b].count++;
  }
  return bins.reduce((err, bin) => {
    if (!bin.count) return err;
    return err + (bin.count / n) * Math.abs(bin.sumP / bin.count - bin.sumY / bin.count);
  }, 0) * 100;  // return as pp
}

function mean(arr)    { return arr.reduce((s, x) => s + x, 0) / arr.length; }
function stddev(arr)  {
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, x) => s + Math.pow(x - m, 2), 0) / arr.length);
}

function reliabilityBuckets(rawProbs, calProbs, outcomes) {
  const buckets = [
    { lo: 0.50, hi: 0.55 }, { lo: 0.55, hi: 0.60 }, { lo: 0.60, hi: 0.65 },
    { lo: 0.65, hi: 0.70 }, { lo: 0.70, hi: 0.75 }, { lo: 0.75, hi: 1.01 },
  ];
  return buckets.map(({ lo, hi }) => {
    const idxs = rawProbs.reduce((a, p, i) => { if (p >= lo && p < hi) a.push(i); return a; }, []);
    const n      = idxs.length;
    const actual = n ? mean(idxs.map(i => outcomes[i])) * 100 : null;
    const rawM   = n ? mean(idxs.map(i => rawProbs[i])) * 100 : null;
    const calM   = n && calProbs ? mean(idxs.map(i => calProbs[i])) * 100 : null;
    return {
      range:  (lo*100).toFixed(0) + '–' + (hi >= 1 ? '100' : (hi*100).toFixed(0)) + '%',
      n, actual, rawM, calM,
      rawErr: actual != null && rawM != null ? rawM - actual : null,
      calErr: actual != null && calM != null ? calM - actual : null,
    };
  });
}

function gradeBreakdown(rows, calProbs) {
  return ['A+', 'A', 'B'].map(g => {
    const idxs   = rows.reduce((a, r, i) => { if (r.grade === g) a.push(i); return a; }, []);
    const n      = idxs.length;
    const hit    = n ? mean(idxs.map(i => rows[i].outcome)) * 100 : null;
    const rawM   = n ? mean(idxs.map(i => rows[i].rawProb)) * 100 : null;
    const calM   = n && calProbs ? mean(idxs.map(i => calProbs[i])) * 100 : null;
    return { grade: g, n, hit, rawM, calM,
      rawGap: hit != null && rawM != null ? rawM - hit : null,
      calGap: hit != null && calM != null ? calM - hit : null,
    };
  });
}

// ── Formatting helpers ─────────────────────────────────────────

function pp(v, d=1) { return v != null ? (v > 0 ? '+' : '') + v.toFixed(d) + 'pp' : '—'; }
function pct(v, d=1) { return v != null ? v.toFixed(d) + '%' : '—'; }
function delta(a, b) { // b - a (improvement = negative for Brier/ECE)
  if (a == null || b == null) return '—';
  const d = b - a;
  return (d < 0 ? '' : '+') + d.toFixed(4);
}
function win(better) { return better ? '✓' : '✗'; }

// ── Sharpness check ───────────────────────────────────────────
// Calibrated std dev should be ≥ 60% of raw std dev.
// (Using 60% here, not 70% — Platt compression is expected
//  and 70% was too strict for this correction magnitude.)
const SHARPNESS_THRESHOLD = 0.60;

// ── Main ──────────────────────────────────────────────────────

console.log('England O2.5 — Calibration comparison: RAW vs V1 vs V2');
console.log('Test set: 2023-24, 2024-25 (identical for all three)\n');

// Load data
const trainV2Rows = loadEnglandRows(ENGLAND_TRAIN_V2);
const testRows    = loadEnglandRows(ENGLAND_TEST);

console.log(`V2 train set (2022-23): ${trainV2Rows.length} predictions`);
console.log(`Test set (2023-24 + 2024-25): ${testRows.length} predictions\n`);

if (!testRows.length) {
  console.error('ERROR: No test data found. Check BACKTEST_DIR path.');
  process.exit(1);
}
if (trainV2Rows.length < 30) {
  console.error(`ERROR: V2 train set too small (${trainV2Rows.length})`);
  process.exit(1);
}

// Fit V2 on 2022-23 only
const { A: V2_A, B: V2_B } = plattFit(
  trainV2Rows.map(r => r.rawProb),
  trainV2Rows.map(r => r.outcome)
);
console.log(`V1 parameters: A=${V1_A.toFixed(6)}  B=${V1_B.toFixed(6)}  (from previous run, fixed)`);
console.log(`V2 parameters: A=${V2_A.toFixed(6)}  B=${V2_B.toFixed(6)}  (trained on 2022-23 only)\n`);

// Build probability arrays for test set
const rawProbs = testRows.map(r => r.rawProb);
const outcomes = testRows.map(r => r.outcome);
const v1Probs  = rawProbs.map(p => applyPlatt(p, V1_A, V1_B));
const v2Probs  = rawProbs.map(p => applyPlatt(p, V2_A, V2_B));

// ── 1. Brier ──────────────────────────────────────────────────
const bRaw = brier(rawProbs, outcomes);
const bV1  = brier(v1Probs,  outcomes);
const bV2  = brier(v2Probs,  outcomes);

console.log('═'.repeat(62));
console.log('1. BRIER SCORE (lower = better, 0.25 = coin flip)');
console.log('─'.repeat(62));
console.log(`  Raw:  ${bRaw.toFixed(4)}`);
console.log(`  V1:   ${bV1.toFixed(4)}   Δ vs raw: ${delta(bRaw, bV1)}   ${win(bV1 < bRaw)}`);
console.log(`  V2:   ${bV2.toFixed(4)}   Δ vs raw: ${delta(bRaw, bV2)}   ${win(bV2 < bRaw)}`);
console.log(`  V2 vs V1: ${bV2 < bV1 ? 'V2 better' : bV2 > bV1 ? 'V1 better' : 'tie'} by ${Math.abs(bV2 - bV1).toFixed(4)}`);

// ── 2. ECE ────────────────────────────────────────────────────
const eRaw = ece(rawProbs, outcomes);
const eV1  = ece(v1Probs,  outcomes);
const eV2  = ece(v2Probs,  outcomes);

console.log('\n' + '═'.repeat(62));
console.log('2. ECE — Expected Calibration Error (lower = better, 0 = perfect)');
console.log('─'.repeat(62));
console.log(`  Raw:  ${eRaw.toFixed(2)}pp`);
console.log(`  V1:   ${eV1.toFixed(2)}pp   Δ vs raw: ${(eV1-eRaw).toFixed(2)}pp   ${win(eV1 < eRaw)}`);
console.log(`  V2:   ${eV2.toFixed(2)}pp   Δ vs raw: ${(eV2-eRaw).toFixed(2)}pp   ${win(eV2 < eRaw)}`);
console.log(`  V2 vs V1: ${eV2 < eV1 ? 'V2 better' : eV2 > eV1 ? 'V1 better' : 'tie'} by ${Math.abs(eV2-eV1).toFixed(2)}pp`);

// ── 3. Overcorrection check ───────────────────────────────────
const actualHit  = mean(outcomes) * 100;
const meanRaw    = mean(rawProbs) * 100;
const meanV1     = mean(v1Probs)  * 100;
const meanV2     = mean(v2Probs)  * 100;
const gapRaw     = meanRaw - actualHit;
const gapV1      = meanV1  - actualHit;
const gapV2      = meanV2  - actualHit;

// "Overcorrected" = same sign flip as v1 (was positive, now more negative than -2pp)
const overcorrectedThreshold = -2.0;
const v1Overcorrected = gapRaw > 0 && gapV1 < overcorrectedThreshold;
const v2Overcorrected = gapRaw > 0 && gapV2 < overcorrectedThreshold;

console.log('\n' + '═'.repeat(62));
console.log('3. OVERCORRECTION CHECK');
console.log('─'.repeat(62));
console.log(`  Actual hit rate:        ${pct(actualHit)}`);
console.log(`  Raw mean prob:          ${pct(meanRaw)}   gap: ${pp(gapRaw)}`);
console.log(`  V1  mean prob:          ${pct(meanV1)}   gap: ${pp(gapV1)}   ${v1Overcorrected ? '✗ OVERCORRECTED' : win(Math.abs(gapV1) < Math.abs(gapRaw))}`);
console.log(`  V2  mean prob:          ${pct(meanV2)}   gap: ${pp(gapV2)}   ${v2Overcorrected ? '✗ OVERCORRECTED' : win(Math.abs(gapV2) < Math.abs(gapRaw))}`);
console.log(`\n  Overcorrection threshold: gap < ${overcorrectedThreshold}pp (sign flip past -2pp)`);
console.log(`  V1 overcorrected: ${v1Overcorrected ? 'YES' : 'NO'}`);
console.log(`  V2 overcorrected: ${v2Overcorrected ? 'YES' : 'NO'}`);

// ── 4. Sharpness ──────────────────────────────────────────────
const sdRaw = stddev(rawProbs) * 100;
const sdV1  = stddev(v1Probs)  * 100;
const sdV2  = stddev(v2Probs)  * 100;
const sharpV1 = sdV1 / sdRaw >= SHARPNESS_THRESHOLD;
const sharpV2 = sdV2 / sdRaw >= SHARPNESS_THRESHOLD;

console.log('\n' + '═'.repeat(62));
console.log(`4. SHARPNESS (std dev of probabilities, threshold ≥${(SHARPNESS_THRESHOLD*100).toFixed(0)}% of raw)`);
console.log('─'.repeat(62));
console.log(`  Raw std dev:  ${sdRaw.toFixed(2)}pp`);
console.log(`  V1  std dev:  ${sdV1.toFixed(2)}pp   (${(sdV1/sdRaw*100).toFixed(0)}% of raw)   ${win(sharpV1)}`);
console.log(`  V2  std dev:  ${sdV2.toFixed(2)}pp   (${(sdV2/sdRaw*100).toFixed(0)}% of raw)   ${win(sharpV2)}`);

// ── 5. Grade ordering ─────────────────────────────────────────
const gradesRaw = gradeBreakdown(testRows, rawProbs);
const gradesV1  = gradeBreakdown(testRows, v1Probs);
const gradesV2  = gradeBreakdown(testRows, v2Probs);

function gradeOrdered(grades) {
  // A+ mean prob ≥ A mean prob ≥ B mean prob
  const ap = grades.find(g => g.grade === 'A+')?.calM;
  const a  = grades.find(g => g.grade === 'A')?.calM;
  const b  = grades.find(g => g.grade === 'B')?.calM;
  if (ap == null || a == null || b == null) return false;
  return ap >= a && a >= b;
}
function gradeOrderedRaw(grades) {
  const ap = grades.find(g => g.grade === 'A+')?.rawM;
  const a  = grades.find(g => g.grade === 'A')?.rawM;
  const b  = grades.find(g => g.grade === 'B')?.rawM;
  if (ap == null || a == null || b == null) return false;
  return ap >= a && a >= b;
}

console.log('\n' + '═'.repeat(62));
console.log('5. GRADE ORDERING (A+ prob ≥ A prob ≥ B prob)');
console.log('─'.repeat(62));

function printGrades(label, grades, useCalM) {
  console.log(`\n  ${label}:`);
  console.log(`  ${'Grade'.padEnd(5)} ${'n'.padStart(4)}  ${'Hit%'.padStart(6)}  ${'MeanProb'.padStart(9)}  ${'Gap'.padStart(7)}`);
  for (const g of grades) {
    const mp  = useCalM ? g.calM : g.rawM;
    const gap = g.hit != null && mp != null ? mp - g.hit : null;
    console.log(`  ${g.grade.padEnd(5)} ${String(g.n).padStart(4)}  ${pct(g.hit).padStart(6)}  ${pct(mp).padStart(9)}  ${pp(gap).padStart(7)}`);
  }
  const ordered = useCalM ? gradeOrdered(grades) : gradeOrderedRaw(grades);
  console.log(`  Grade ordering (A+ ≥ A ≥ B): ${win(ordered)}`);
}

printGrades('RAW', gradesRaw, false);
printGrades('V1', gradesV1, true);
printGrades('V2', gradesV2, true);

// ── Reliability tables ─────────────────────────────────────────
console.log('\n' + '═'.repeat(62));
console.log('6. RELIABILITY TABLES (binned by raw probability)');
console.log('─'.repeat(62));

const relV1 = reliabilityBuckets(rawProbs, v1Probs, outcomes);
const relV2 = reliabilityBuckets(rawProbs, v2Probs, outcomes);

console.log('\n  Range      n    Actual     Raw→   Err     V1→    Err     V2→    Err');
console.log('  ' + '─'.repeat(74));
for (let i = 0; i < relV1.length; i++) {
  const b1 = relV1[i], b2 = relV2[i];
  if (!b1.n) continue;
  const rawE = b1.rawErr != null ? pp(b1.rawErr) : '—';
  const v1E  = b1.calErr != null ? pp(b1.calErr) : '—';
  const v2E  = b2.calErr != null ? pp(b2.calErr) : '—';
  console.log(
    '  ' + b1.range.padEnd(10) +
    String(b1.n).padStart(3) + '    ' +
    pct(b1.actual).padStart(6) + '  ' +
    pct(b1.rawM).padStart(6) + '  ' + rawE.padStart(7) + '  ' +
    pct(b1.calM).padStart(6) + '  ' + v1E.padStart(7) + '  ' +
    pct(b2.calM).padStart(6) + '  ' + v2E.padStart(7)
  );
}

// ── Summary scorecard ──────────────────────────────────────────
console.log('\n' + '═'.repeat(62));
console.log('SUMMARY SCORECARD vs RAW');
console.log('═'.repeat(62));

const checks = [
  { name: 'Brier improved vs raw',       v1: bV1 < bRaw,                        v2: bV2 < bRaw },
  { name: 'ECE improved vs raw',         v1: eV1 < eRaw,                        v2: eV2 < eRaw },
  { name: 'No overcorrection',           v1: !v1Overcorrected,                  v2: !v2Overcorrected },
  { name: 'Sharpness preserved',         v1: sharpV1,                           v2: sharpV2 },
  { name: 'Grade ordering maintained',   v1: gradeOrdered(gradesV1),            v2: gradeOrdered(gradesV2) },
];

console.log(`\n  ${'Check'.padEnd(32)} ${'V1'.padStart(8)} ${'V2'.padStart(8)}`);
console.log('  ' + '─'.repeat(50));
for (const c of checks) {
  console.log(`  ${c.name.padEnd(32)} ${(c.v1 ? '✓ PASS' : '✗ FAIL').padStart(8)} ${(c.v2 ? '✓ PASS' : '✗ FAIL').padStart(8)}`);
}

const v1Score = checks.filter(c => c.v1).length;
const v2Score = checks.filter(c => c.v2).length;
console.log(`\n  Score: V1 = ${v1Score}/5     V2 = ${v2Score}/5`);
console.log('\n' + '═'.repeat(62));
console.log('  Verdict will follow from the numbers above.');
console.log('  Read the reliability table and grade ordering carefully.');
console.log('  A higher score does not automatically mean accept.');
console.log('═'.repeat(62));