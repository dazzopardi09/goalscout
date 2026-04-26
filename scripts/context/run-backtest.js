// scripts/context/run-backtest.js
// ─────────────────────────────────────────────────────────────
// Stage 3 — context_raw historical backtest runner.
//
// Loops over every fixture in a historical CSV, computes rolling
// stats and context_raw scores, compares against actual results,
// and writes a JSONL output file + summary stats.
//
// Run inside the GoalScout container:
//   docker cp scripts/context/run-backtest.js goalscout:/app/scripts/context/run-backtest.js
//   docker exec -it goalscout node /app/scripts/context/run-backtest.js
//
// Optional args:
//   --league england     (default: england)
//   --season 2024_25     (default: 2024_25)
//
// Output:
//   data/backtests/context_raw/england_2024_25.jsonl
//   data/backtests/context_raw/_index.json
//
// Prerequisites:
//   data/historical/england/2024_25.csv  (downloaded in Stage 1)
// ─────────────────────────────────────────────────────────────

'use strict';

const fs   = require('fs');
const path = require('path');

const config = require('../../src/config');
const { loadMatches, inferGameweek, SLUG_TO_FDC_DIV } = require('../../src/engine/historical-data');
const { computeRollingStats }                          = require('../../src/engine/rolling-stats');
const { scoreContext }                                 = require('../../src/engine/context-shortlist');

// ── CLI args ──────────────────────────────────────────────────

function getArg(args, flag) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
}

const args       = process.argv.slice(2);
const leagueSlug = getArg(args, '--league')  || 'england';
const season     = getArg(args, '--season')  || '2024_25';

// ── Paths ─────────────────────────────────────────────────────

const BACKTEST_DIR = path.join(config.DATA_DIR, 'backtests', 'context_raw');
const OUT_FILE     = path.join(BACKTEST_DIR, `${leagueSlug}_${season}.jsonl`);
const INDEX_FILE   = path.join(BACKTEST_DIR, '_index.json');

// ── Versioning ────────────────────────────────────────────────
// Bump MODEL_VERSION when scoring logic or flags change.
// Bump FEATURE_SET_VERSION when rolling-stats computation changes
// (window size, weighting, new fields, etc.).
// Both are recorded on every row and in _index.json so we can trace
// which code produced which rows — matters once we have multiple seasons.

const MODEL_VERSION       = 'context_raw_v1.2';  // v1.2: direction-aware thresholds (O2.5=3, U2.5=4)
const FEATURE_SET_VERSION = 'pre_match_v1';

// ── Helpers ───────────────────────────────────────────────────

function round2(n)  { return Math.round(n * 100) / 100; }
function round4(n)  { return Math.round(n * 10000) / 10000; }
function pct(n, d)  { return d > 0 ? Math.round((n / d) * 1000) / 10 : null; }

function seasonFriendly(s) {
  // '2024_25' → '2024-25'
  return s.replace('_', '-');
}

// Deterministic fixture identifier — stable join key across all models.
// Format: {leagueCode}_{YYYYMMDD}_{homeSlug}_{awaySlug}
// Example: E0_20241109_arsenal_newcastle-united
// Must be computed the same way in every model's runner.
function makeFixtureId(leagueCode, date, homeTeam, awayTeam) {
  const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '');
  const slug    = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  return `${leagueCode}_${dateStr}_${slug(homeTeam)}_${slug(awayTeam)}`;
}

// Strip the heavy matches[] array from rolling stats before storing
function compactRolling(r) {
  if (!r) return null;
  return {
    teamName:             r.teamName,
    gf_avg:               r.gf_avg,
    ga_avg:               r.ga_avg,
    fts_count:            r.fts_count,
    scored2plus_count:    r.scored2plus_count,
    conceded2plus_count:  r.conceded2plus_count,
    o25_count:            r.o25_count,
    btts_count:           r.btts_count,
    games_available:      r.games_available,
    insufficient:         r.insufficient,
  };
}

// Strip diagnostic-only flag fields from the output
function compactFlags(f) {
  if (!f) return null;
  return {
    both_weak_attack:            f.both_weak_attack,
    one_sided_over_risk:         f.one_sided_over_risk,
    concede_driven_over_home:    f.concede_driven_over_home,
    concede_driven_over_away:    f.concede_driven_over_away,
    concede_driven_over_fixture: f.concede_driven_over_fixture,
    concede_driven_over_effect:  f.concede_driven_over_effect,
    both_leaky_defence:          f.both_leaky_defence,
    strong_two_sided_over:       f.strong_two_sided_over,
    low_attack_under_support:    f.low_attack_under_support,
    favouriteIsHome:             f.favouriteIsHome,
    isClearMismatch:             f.isClearMismatch,
    oddsSource:                  f.oddsSource,
  };
}

// ── Row builder ───────────────────────────────────────────────

function buildRow(fixture, scored, homeR, awayR, seasonStart) {
  const dir      = scored.direction;
  const isO25    = dir === 'o25';
  const isU25    = dir === 'u25';

  // Market odds for the predicted direction
  const marketOdds = !scored.skip && dir
    ? (isO25 ? fixture.oddsO25Open : fixture.oddsU25Open)
    : null;

  // Closing odds for the predicted direction (CLV)
  const closingOdds = !scored.skip && dir
    ? (isO25 ? fixture.oddsO25Close : fixture.oddsU25Close)
    : null;

  // Did the prediction win?
  let won = null;
  if (!scored.skip && dir) {
    won = isO25 ? fixture.result_o25 : fixture.result_u25;
  }

  // Edge: (marketOdds / fairOdds - 1) * 100
  let edge_pct = null;
  if (marketOdds && scored.fairOdds) {
    edge_pct = round2(((marketOdds / scored.fairOdds) - 1) * 100);
  }

  // CLV: (marketOdds / closingOdds - 1) * 100
  let clv_pct = null;
  if (marketOdds && closingOdds) {
    clv_pct = round2(((marketOdds / closingOdds) - 1) * 100);
  }

  return {
    // Identity — stable join key across all models (see ARCHITECTURE.md)
    fixtureId:        makeFixtureId(SLUG_TO_FDC_DIV[leagueSlug] || leagueSlug, fixture.date, fixture.homeTeam, fixture.awayTeam),
    modelVersion:     MODEL_VERSION,
    featureSetVersion: FEATURE_SET_VERSION,
    status:           scored.skip ? 'skipped' : 'settled',

    season:       seasonFriendly(season),
    league:       leagueSlug,
    leagueCode:   SLUG_TO_FDC_DIV[leagueSlug] || leagueSlug,
    gameweek:     inferGameweek(fixture.date, seasonStart),
    fixtureDate:  fixture.date.toISOString().slice(0, 10),
    homeTeam:     fixture.homeTeam,
    awayTeam:     fixture.awayTeam,

    fullTimeHome: fixture.homeGoals,
    fullTimeAway: fixture.awayGoals,
    totalGoals:   fixture.totalGoals,
    result_o25:   fixture.result_o25,
    result_u25:   fixture.result_u25,
    result_btts:  fixture.result_btts,

    skipped:    scored.skip,
    skipReason: scored.skipReason,

    context_direction:      scored.direction,
    context_o25_score:      scored.o25Score,
    context_u25_score:      scored.u25Score,
    context_winning_score:  scored.winningScore,
    context_grade:          scored.grade,
    context_o25_prob_raw:   scored.context_o25_prob_raw,
    context_u25_prob_raw:   scored.context_u25_prob_raw,
    context_fair_odds:      scored.fairOdds,

    flags: compactFlags(scored.flags),

    homeRolling: compactRolling(homeR),
    awayRolling: compactRolling(awayR),

    // Opening O/U odds (for edge and ROI calculation)
    marketOddsO25: fixture.oddsO25Open,
    marketOddsU25: fixture.oddsU25Open,

    // Closing O/U odds (for CLV)
    closingOddsO25: fixture.oddsO25Close,
    closingOddsU25: fixture.oddsU25Close,

    // Derived fields
    marketOdds,
    closingOdds,
    won,
    edge_pct,
    clv_pct,
  };
}

// ── Summary printer ───────────────────────────────────────────

function printSummary(rows) {
  const W = 70;
  const hr = (c = '─') => c.repeat(W);
  const pad = (s, n) => { s = String(s); return s + ' '.repeat(Math.max(0, n - s.length)); };
  const rpad = (s, n) => { s = String(s); return ' '.repeat(Math.max(0, n - s.length)) + s; };

  console.log('\n' + hr('═'));
  console.log(`CONTEXT_RAW BACKTEST — ${leagueSlug.toUpperCase()}  ${seasonFriendly(season)}`);
  console.log(hr('═'));

  // ── Volume ───────────────────────────────────────────────────
  const total   = rows.length;
  const skipped = rows.filter(r => r.skipped);
  const preds   = rows.filter(r => !r.skipped);

  const skipCounts = {};
  skipped.forEach(r => {
    skipCounts[r.skipReason] = (skipCounts[r.skipReason] || 0) + 1;
  });

  console.log(`\nTotal fixtures:               ${total}`);
  console.log(`Predictions generated:        ${preds.length}  (${pct(preds.length, total)}%)`);
  console.log(`Skipped:                      ${skipped.length}`);
  Object.entries(skipCounts).sort((a, b) => b[1] - a[1]).forEach(([reason, n]) => {
    console.log(`  ${pad(reason + ':', 34)} ${n}`);
  });

  if (preds.length === 0) {
    console.log('\n⚠  No predictions generated — check data and thresholds.');
    return;
  }

  // ── Hit rate by direction ────────────────────────────────────
  const o25preds = preds.filter(r => r.context_direction === 'o25');
  const u25preds = preds.filter(r => r.context_direction === 'u25');
  const o25won   = o25preds.filter(r => r.won);
  const u25won   = u25preds.filter(r => r.won);
  const allWon   = preds.filter(r => r.won);

  console.log(`\n${hr()}`);
  console.log('DIRECTION BREAKDOWN');
  console.log(hr('─'));
  console.log(`${'Direction'.padEnd(10)} ${'Preds'.padStart(6)} ${'Won'.padStart(6)} ${'Hit %'.padStart(7)}`);
  console.log(hr('─'));
  [
    ['O2.5',  o25preds.length, o25won.length],
    ['U2.5',  u25preds.length, u25won.length],
    ['TOTAL', preds.length,    allWon.length],
  ].forEach(([label, count, won]) => {
    const hitStr = count > 0 ? `${pct(won, count)}%` : '—';
    console.log(`${label.padEnd(10)} ${rpad(count, 6)} ${rpad(won, 6)} ${rpad(hitStr, 7)}`);
  });

  // ── Hit rate by grade ────────────────────────────────────────
  console.log(`\n${hr()}`);
  console.log('GRADE BREAKDOWN');
  console.log(hr('─'));
  console.log(`${'Grade'.padEnd(8)} ${'Preds'.padStart(6)} ${'Won'.padStart(6)} ${'Hit %'.padStart(7)}`);
  console.log(hr('─'));
  ['A+', 'A', 'B'].forEach(g => {
    const gp = preds.filter(r => r.context_grade === g);
    const gw = gp.filter(r => r.won);
    const hitStr = gp.length > 0 ? `${pct(gw.length, gp.length)}%` : '—';
    console.log(`${g.padEnd(8)} ${rpad(gp.length, 6)} ${rpad(gw.length, 6)} ${rpad(hitStr, 7)}`);
  });

  // ── Flag analysis ─────────────────────────────────────────────
  console.log(`\n${hr()}`);
  console.log('FLAG ANALYSIS  (fired → hit rate for O2.5 preds only, then U2.5 preds only)');
  console.log(hr('─'));

  const flagKeys = [
    ['both_weak_attack',         'both_weak_attack'],
    ['one_sided_over_risk',      'one_sided_over_risk'],
    ['concede_driven_over',      'concede_driven_over_home'],  // either team
    ['both_leaky_defence',       'both_leaky_defence'],
    ['strong_two_sided_over',    'strong_two_sided_over'],
    ['low_attack_under_support', 'low_attack_under_support'],
  ];

  // For CDO we want to check either home or away fired
  const predsWithFlags = preds.filter(r => r.flags);

  flagKeys.forEach(([label, key]) => {
    let fired;
    if (key === 'concede_driven_over_home') {
      fired = predsWithFlags.filter(r => r.flags.concede_driven_over_home || r.flags.concede_driven_over_away);
    } else {
      fired = predsWithFlags.filter(r => r.flags[key]);
    }

    const notFired = predsWithFlags.filter(r => !fired.includes(r));

    if (fired.length === 0) {
      console.log(`  ${pad(label + ':', 30)}  0 fired`);
      return;
    }

    const o25fired    = fired.filter(r => r.context_direction === 'o25');
    const o25firedWon = o25fired.filter(r => r.won);
    const u25fired    = fired.filter(r => r.context_direction === 'u25');
    const u25firedWon = u25fired.filter(r => r.won);

    const o25notFired    = notFired.filter(r => r.context_direction === 'o25');
    const o25notFiredWon = o25notFired.filter(r => r.won);

    const o25HitFired   = o25fired.length    > 0 ? `${pct(o25firedWon.length, o25fired.length)}%`       : '—  ';
    const o25HitNoFired = o25notFired.length > 0 ? `${pct(o25notFiredWon.length, o25notFired.length)}%` : '—  ';

    console.log(
      `  ${pad(label + ':', 30)}` +
      `  ${rpad(fired.length, 3)} fired` +
      (o25fired.length > 0
        ? `  |  O2.5: ${o25HitFired} when fired vs ${o25HitNoFired} when not`
        : '')
    );
  });

  // ── CDO specific: underdog effect ────────────────────────────
  const cdoUnderdog = predsWithFlags.filter(r =>
    r.flags?.concede_driven_over_fixture === 'underdog' &&
    r.context_direction === 'o25'
  );
  if (cdoUnderdog.length > 0) {
    const cdoUnderdogWon = cdoUnderdog.filter(r => r.won);
    console.log(
      `\n  CDO underdog→O2.5: ${cdoUnderdog.length} predictions, ` +
      `hit rate ${pct(cdoUnderdogWon.length, cdoUnderdog.length)}%` +
      `  (spec predicts this should be low)`
    );
  }

  // ── Odds & ROI ────────────────────────────────────────────────
  const predsWithOdds = preds.filter(r => r.marketOdds != null && r.won !== null);
  if (predsWithOdds.length > 0) {
    console.log(`\n${hr()}`);
    console.log(`ODDS & ROI  (${predsWithOdds.length} of ${preds.length} predictions have opening O/U odds)`);
    console.log(hr('─'));

    const totalPnL = predsWithOdds.reduce((sum, r) => {
      return sum + (r.won ? (r.marketOdds - 1) : -1);
    }, 0);
    const roi = pct(totalPnL, predsWithOdds.length);

    const edgePreds   = predsWithOdds.filter(r => r.edge_pct != null);
    const meanEdge    = edgePreds.length > 0
      ? round2(edgePreds.reduce((s, r) => s + r.edge_pct, 0) / edgePreds.length)
      : null;

    const clvPreds    = predsWithOdds.filter(r => r.clv_pct != null);
    const meanCLV     = clvPreds.length > 0
      ? round2(clvPreds.reduce((s, r) => s + r.clv_pct, 0) / clvPreds.length)
      : null;

    console.log(`Mean edge:       ${meanEdge != null ? (meanEdge > 0 ? '+' : '') + meanEdge + '%' : '—'}`);
    console.log(`Mean CLV:        ${meanCLV  != null ? (meanCLV  > 0 ? '+' : '') + meanCLV  + '%  (' + clvPreds.length + ' of ' + predsWithOdds.length + ' with closing odds)' : '—  (no closing odds available)'}`);
    console.log(`Total P&L:       ${(totalPnL > 0 ? '+' : '') + round2(totalPnL)}u  (${predsWithOdds.length} bets × 1u stake)`);
    console.log(`ROI:             ${(roi >= 0 ? '+' : '') + roi}%`);
  }

  // ── Output ────────────────────────────────────────────────────
  console.log(`\n${hr('═')}`);
  console.log(`Output:  ${OUT_FILE}`);
  console.log(`Index:   ${INDEX_FILE}`);
  console.log(hr('═') + '\n');
}

// ── Index file ────────────────────────────────────────────────

function updateIndex(rows) {
  const preds   = rows.filter(r => !r.skipped);
  const won     = preds.filter(r => r.won);
  const o25     = preds.filter(r => r.context_direction === 'o25');
  const u25     = preds.filter(r => r.context_direction === 'u25');

  const entry = {
    league:           leagueSlug,
    season:           seasonFriendly(season),
    file:             path.basename(OUT_FILE),
    modelVersion:     MODEL_VERSION,
    featureSetVersion: FEATURE_SET_VERSION,
    generatedAt:      new Date().toISOString(),
    fixtures:         rows.length,
    predictions:      preds.length,
    skipped:          rows.length - preds.length,
    won:              won.length,
    hitRate:          preds.length > 0 ? round4(won.length / preds.length) : null,
    o25Predictions:   o25.length,
    u25Predictions:   u25.length,
    hasFullResults:   true,
  };

  let index = { leagues: [] };
  try {
    if (fs.existsSync(INDEX_FILE)) {
      index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    }
  } catch {}

  // Replace or add this league/season entry
  const key = `${leagueSlug}_${season}`;
  const existing = index.leagues.findIndex(e => `${e.league}_${e.season.replace('-', '_')}` === key);
  if (existing >= 0) {
    index.leagues[existing] = entry;
  } else {
    index.leagues.push(entry);
  }

  index.lastUpdated = new Date().toISOString();
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2), 'utf8');
}

// ── Main ──────────────────────────────────────────────────────

function main() {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`GOALSCOUT  context_raw  —  Backtest Runner  (Stage 3)`);
  console.log(`League: ${leagueSlug}  |  Season: ${seasonFriendly(season)}`);
  console.log('═'.repeat(70));

  // ── Load historical data ──────────────────────────────────────
  let matches;
  try {
    matches = loadMatches(leagueSlug, season);
  } catch (err) {
    console.error('\n✗ Could not load CSV:', err.message);
    console.error('  Check data/historical/' + leagueSlug + '/' + season + '.csv exists.');
    process.exit(1);
  }

  console.log(`\nLoaded ${matches.length} completed fixtures from CSV.`);
  console.log(`Date range: ${matches[0].date.toISOString().slice(0, 10)} → ${matches[matches.length - 1].date.toISOString().slice(0, 10)}`);
  console.log('Processing...');

  const seasonStart = matches[0].date;

  // ── Prepare output directory ──────────────────────────────────
  fs.mkdirSync(BACKTEST_DIR, { recursive: true });
  // Clear existing file for this run
  fs.writeFileSync(OUT_FILE, '', 'utf8');

  // ── Process every fixture ─────────────────────────────────────
  const rows = [];

  for (const fixture of matches) {
    // Compute rolling stats for both teams (strictly before fixture date)
    const homeR = computeRollingStats(fixture.homeTeam, matches, fixture.date);
    const awayR = computeRollingStats(fixture.awayTeam, matches, fixture.date);

    // Score using context_raw model
    const scored = scoreContext(homeR, awayR, {
      oddsHomeOpen: fixture.oddsHomeOpen,
      oddsAwayOpen: fixture.oddsAwayOpen,
    });

    // Build and write output row
    const row = buildRow(fixture, scored, homeR, awayR, seasonStart);
    rows.push(row);
    fs.appendFileSync(OUT_FILE, JSON.stringify(row) + '\n', 'utf8');
  }

  // ── Summary ───────────────────────────────────────────────────
  printSummary(rows);

  // ── Update index ──────────────────────────────────────────────
  updateIndex(rows);

  console.log(`✓ Done. ${rows.filter(r => !r.skipped).length} predictions written to JSONL.\n`);
}

main();