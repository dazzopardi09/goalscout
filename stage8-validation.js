const fs = require('fs'), path = require('path');
const dir = '/app/data/backtests/context_raw';

// Season definitions per league — handles the two filename formats
const LEAGUE_SEASONS = {
  england:     ['2019_20','2020_21','2021_22','2022_23','2023_24','2024_25'],
  germany:     ['19_20','20_21','21_22','22_23','23_24','24_25'],
  italy:       ['19_20','20_21','21_22','22_23','23_24','24_25'],
  spain:       ['19_20','20_21','21_22','22_23','23_24','24_25'],
  france:      ['19_20','20_21','21_22','22_23','23_24','24_25'],
  netherlands: ['19_20','20_21','21_22','22_23','23_24','24_25'],
};

function resolveFile(league, season) {
  // Try the exact format first, then the alternative
  const candidates = [
    path.join(dir, `${league}_${season}.jsonl`),
  ];
  // For england, also try short format in case of future rename
  if (league === 'england') {
    const short = season.replace(/^20(\d{2})_(\d{2})$/, '$1_$2');
    candidates.push(path.join(dir, `${league}_${short}.jsonl`));
  }
  return candidates.find(f => fs.existsSync(f)) || null;
}

function loadSeason(league, season) {
  const file = resolveFile(league, season);
  if (!file) return null;
  return fs.readFileSync(file, 'utf8').trim().split('\n')
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(r => r && r.status === 'settled');
}

// Friendly season label (19_20 or 2019_20 → 2019-20)
function seasonLabel(s) {
  return s.length === 5
    ? '20' + s.replace('_', '-')
    : s.replace('_', '-');
}

function analyse(league, direction) {
  const seasons = LEAGUE_SEASONS[league];
  const seasonRows = {};
  for (const s of seasons) {
    const rows = loadSeason(league, s);
    if (rows) seasonRows[s] = rows;
  }

  const allRows = Object.values(seasonRows).flat();
  const allTarget = allRows.filter(r => r.context_direction === direction);

  console.log(`\n${'═'.repeat(62)}`);
  console.log(`  ${league.toUpperCase()}  —  ${direction.toUpperCase()} validation`);
  console.log('═'.repeat(62));

  // ── 1. Stability ──────────────────────────────────────────
  console.log('\n── 1. Stability: hit rate by season ──');
  const seasonStats = [];
  for (const [s, rows] of Object.entries(seasonRows)) {
    const tgt = rows.filter(r => r.context_direction === direction);
    const won = tgt.filter(r => r.won).length;
    const hr  = tgt.length ? won / tgt.length * 100 : null;
    seasonStats.push({ season: s, n: tgt.length, won, hr });
    if (hr != null) {
      const bar = '█'.repeat(Math.round(hr / 5));
      console.log(`  ${seasonLabel(s)}  n=${String(tgt.length).padStart(3)}  ${hr.toFixed(1).padStart(5)}%  ${bar}`);
    }
  }

  const hrs   = seasonStats.filter(s => s.hr != null).map(s => s.hr);
  const mean  = hrs.reduce((a, b) => a + b, 0) / hrs.length;
  const stdDev = Math.sqrt(hrs.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / hrs.length);
  const worst  = Math.min(...hrs);
  const best   = Math.max(...hrs);
  const worstS = seasonStats.find(s => s.hr === worst);
  const bestS  = seasonStats.find(s => s.hr === best);
  console.log(`\n  Aggregate: ${mean.toFixed(1)}%  StdDev: ±${stdDev.toFixed(1)}pp`);
  console.log(`  Range: ${worst.toFixed(1)}% (${seasonLabel(worstS?.season)}) → ${best.toFixed(1)}% (${seasonLabel(bestS?.season)})`);
  console.log(`  Seasons ≥ 57%: ${hrs.filter(h => h >= 57).length}/${hrs.length}`);
  console.log(`  Seasons ≥ 55%: ${hrs.filter(h => h >= 55).length}/${hrs.length}`);
  console.log(`  Seasons < 55%: ${hrs.filter(h => h < 55).length}/${hrs.length}`);

  // ── 2. Grade segmentation ─────────────────────────────────
  console.log('\n── 2. Grade segmentation ──');
  const grades = ['A+', 'A', 'B'];
  for (const g of grades) {
    const gr   = allTarget.filter(r => r.context_grade === g);
    const gw   = gr.filter(r => r.won).length;
    const ghr  = gr.length ? (gw / gr.length * 100).toFixed(1) : '—';
    const roiR = gr.filter(r => r.marketOdds != null);
    const pnl  = roiR.reduce((s, r) => s + (r.won ? r.marketOdds - 1 : -1), 0);
    const roi  = roiR.length ? (pnl / roiR.length * 100).toFixed(1) : '—';
    console.log(`  ${g.padEnd(3)}  n=${String(gr.length).padStart(4)}  hit=${String(ghr).padStart(5)}%  ROI=${String(roi).padStart(7)}%`);
  }

  const ap   = allTarget.filter(r => r.context_grade === 'A+' || r.context_grade === 'A');
  const apw  = ap.filter(r => r.won).length;
  const aphr = ap.length ? (apw / ap.length * 100).toFixed(1) : '—';
  const apR  = ap.filter(r => r.marketOdds != null);
  const apPnl = apR.reduce((s, r) => s + (r.won ? r.marketOdds - 1 : -1), 0);
  const apRoi = apR.length ? (apPnl / apR.length * 100).toFixed(1) : '—';
  console.log(`  A/A+  n=${String(ap.length).padStart(4)}  hit=${String(aphr).padStart(5)}%  ROI=${String(apRoi).padStart(7)}%`);

  // A+ by season
  console.log('\n  A+ by season:');
  for (const [s, rows] of Object.entries(seasonRows)) {
    const r = rows.filter(r => r.context_direction === direction && r.context_grade === 'A+');
    const w = r.filter(r => r.won).length;
    const h = r.length ? (w / r.length * 100).toFixed(1) : '—';
    console.log(`    ${seasonLabel(s)}  n=${String(r.length).padStart(3)}  ${String(h).padStart(5)}%`);
  }

  // ── 3. Edge sanity check ──────────────────────────────────
  console.log('\n── 3. Edge sanity check ──');
  const edgeRows  = allTarget.filter(r => r.edge_pct != null && r.won !== null);
  const fairRows  = allTarget.filter(r => r.context_fair_odds != null && r.context_fair_odds > 0);
  const settledTarget = allTarget.filter(r => r.won !== null);
  const actualHR  = settledTarget.length
    ? allTarget.filter(r => r.won).length / settledTarget.length * 100
    : null;

  // Average 1/fair_odds per row (correct), not 1/avg(fair_odds)
  const meanImpliedProb = fairRows.length
    ? fairRows.reduce((s, r) => s + (1 / r.context_fair_odds) * 100, 0) / fairRows.length
    : null;

  const meanEdge = edgeRows.length
    ? edgeRows.reduce((s, r) => s + r.edge_pct, 0) / edgeRows.length
    : null;

  const avgOdds = allTarget.filter(r => r.marketOdds).reduce((s, r) => s + r.marketOdds, 0)
    / allTarget.filter(r => r.marketOdds).length;

  console.log(`  n with edge data:      ${edgeRows.length}`);
  console.log(`  Mean model prob:       ${meanImpliedProb != null ? meanImpliedProb.toFixed(1) + '%' : '—'}`);
  console.log(`  Actual hit rate:       ${actualHR != null ? actualHR.toFixed(1) + '%' : '—'}`);
  console.log(`  Calibration gap:       ${meanImpliedProb != null && actualHR != null ? (meanImpliedProb - actualHR).toFixed(1) + 'pp (model overstates by this much)' : '—'}`);
  console.log(`  Mean stated edge:      ${meanEdge != null ? '+' + meanEdge.toFixed(1) + '%' : '—'}`);
  console.log(`  Avg market odds:       ${avgOdds.toFixed(3)}`);
  console.log(`  Break-even hit rate:   ${(1 / avgOdds * 100).toFixed(1)}%`);
  console.log(`  Seasons above b/e:     ${seasonStats.filter(s => s.hr != null && s.hr > (1 / avgOdds * 100)).length}/${hrs.length}`);

  console.log('\n  Edge buckets vs actual hit rate:');
  const buckets = [
    { label: '< 0%',   min: -Infinity, max: 0  },
    { label: '0–5%',   min: 0,         max: 5  },
    { label: '5–10%',  min: 5,         max: 10 },
    { label: '10–15%', min: 10,        max: 15 },
    { label: '15%+',   min: 15,        max: Infinity },
  ];
  for (const b of buckets) {
    const br  = edgeRows.filter(r => r.edge_pct >= b.min && r.edge_pct < b.max);
    if (!br.length) continue;
    const bw  = br.filter(r => r.won).length;
    const bhr = (bw / br.length * 100).toFixed(1);
    const roiR = br.filter(r => r.marketOdds != null);
    const pnl  = roiR.reduce((s,r) => s + (r.won ? r.marketOdds - 1 : -1), 0);
    const roi  = roiR.length ? (pnl / roiR.length * 100).toFixed(1) : '—';
    console.log(`    ${b.label.padEnd(8)}  n=${String(br.length).padStart(4)}  hit=${bhr}%  ROI=${roi}%`);
  }

  // ── 4. Worst-case framing ─────────────────────────────────
  console.log('\n── 4. Worst-case framing ──');
  console.log(`  Worst season:      ${worst.toFixed(1)}%  (${seasonLabel(worstS?.season)})`);
  console.log(`  At worst, margin above 50%: +${(worst - 50).toFixed(1)}pp`);
  console.log(`  At worst, margin above b/e: ${(worst - (1/avgOdds*100)).toFixed(1)}pp`);

  // Simulated drawdown: how many consecutive losses at worst-season rate?
  const p = worst / 100;
  // Expected longest losing run in N trials ≈ log(N) / log(1/p)
  const N = worstS?.n || 100;
  const expectedRun = Math.log(N) / Math.log(1 / (1 - p));
  console.log(`  Expected longest losing run at worst-season rate (n=${N}): ~${expectedRun.toFixed(0)} consecutive`);
}

analyse('england', 'o25');
analyse('germany', 'o25');
analyse('netherlands', 'o25');