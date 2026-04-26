// scripts/context/verify-rolling-stats.js
// ─────────────────────────────────────────────────────────────
// Stage 1 verification — MUST PASS before Stage 2 begins.
//
// Prints rolling stats for 5 spread fixtures across EPL 2024-25
// and confirms no leakage (no match on or after fixture date
// appears in any team's rolling window).
//
// Also prints a full dataset summary: how many fixtures would
// generate predictions vs be skipped due to insufficient data.
//
// Run inside the GoalScout container:
//   docker exec -it goalscout node /app/scripts/context/verify-rolling-stats.js
//
// Prerequisites:
//   mkdir -p data/historical/england
//   curl -L -o data/historical/england/2024_25.csv \
//     "https://www.football-data.co.uk/mmz4281/2425/E0.csv"
// ─────────────────────────────────────────────────────────────

'use strict';

const { loadMatches, inferGameweek } = require('../../src/engine/historical-data');
const { computeFixtureRolling, MIN_GAMES_REQUIRED } = require('../../src/engine/rolling-stats');

// ── Formatting helpers ─────────────────────────────────────────

const W = 70;

function hr(char = '─') { return char.repeat(W); }

function pad(str, len) {
  const s = String(str);
  return s.length >= len ? s.slice(0, len) : s + ' '.repeat(len - s.length);
}

function rpad(str, len) {
  const s = String(str);
  return s.length >= len ? s.slice(0, len) : ' '.repeat(len - s.length) + s;
}

// ── Team window printer ────────────────────────────────────────

/**
 * Print the rolling window for one team.
 * Returns true if leakage was detected.
 */
function printTeamWindow(label, rolling, fixtureDateMs) {
  console.log(`\n    ${label}  (${rolling.games_available} matches in window)`);

  if (rolling.games_available === 0) {
    console.log('      (no prior matches found)');
    return false;
  }

  let leakFound = false;

  for (const m of rolling.matches) {
    const dStr = m.date.toISOString().slice(0, 10);
    const isLeak = m.date.getTime() >= fixtureDateMs;
    if (isLeak) leakFound = true;

    const o25  = m.o25  ? '✓' : '✗';
    const btts = m.btts ? '✓' : '✗';
    const leak = isLeak ? '  ⚠ LEAKAGE' : '';

    console.log(
      `      ${dStr}  ${m.venue}  ${pad(m.opponent, 20)}` +
      `  ${rpad(m.scoreDisplay, 5)}` +
      `  gf:${m.gf} ga:${m.ga}  o25:${o25} btts:${btts}${leak}`
    );
  }

  // Feature summary
  const r = rolling;
  console.log(
    `\n      gf_avg: ${rpad(r.gf_avg, 4)}` +
    `  ga_avg: ${rpad(r.ga_avg, 4)}` +
    `  fts: ${r.fts_count}` +
    `  s2+: ${r.scored2plus_count}` +
    `  c2+: ${r.conceded2plus_count}` +
    `  o25: ${r.o25_count}` +
    `  btts: ${r.btts_count}` +
    `  games: ${r.games_available}`
  );

  if (leakFound) {
    console.log('      ⚠⚠⚠  LEAKAGE DETECTED — date on or after fixture found in window');
  } else {
    console.log('      ✓  No leakage');
  }

  return leakFound;
}

// ── Main ───────────────────────────────────────────────────────

function main() {
  console.log('\n' + hr('═'));
  console.log('GOALSCOUT  context_raw  —  Stage 1 Verification');
  console.log('EPL 2024-25  |  Rolling stats leakage check');
  console.log(hr('═'));

  // Load dataset
  let matches;
  try {
    matches = loadMatches('england', '2024_25');
  } catch (err) {
    console.error('\n✗ ERROR:', err.message);
    console.error('\nTo download the CSV, run on the host (not inside the container):');
    console.error('  mkdir -p /mnt/user/appdata/goalscout/data/historical/england');
    console.error('  curl -L -o /mnt/user/appdata/goalscout/data/historical/england/2024_25.csv \\');
    console.error('    "https://www.football-data.co.uk/mmz4281/2425/E0.csv"');
    process.exit(1);
  }

  if (matches.length === 0) {
    console.error('\n✗ No completed matches parsed. Check the CSV file.');
    process.exit(1);
  }

  const seasonStart = matches[0].date;
  const firstDate   = seasonStart.toISOString().slice(0, 10);
  const lastDate    = matches[matches.length - 1].date.toISOString().slice(0, 10);

  console.log(`\nDataset:    ${matches.length} completed matches`);
  console.log(`Date range: ${firstDate}  →  ${lastDate}`);

  // ── Pick 5 fixtures spread across the season ────────────────
  // Chosen deliberately: GW1 edge (early, expect skip), early-mid,
  // mid-season, late, and final few rounds.

  const size = matches.length;
  const picks = [
    3,                                    // Very early — expect insufficient data
    Math.floor(size * 0.15),              // ~GW6
    Math.floor(size * 0.40),             // ~GW15
    Math.floor(size * 0.70),             // ~GW27
    size - 4,                             // Late season
  ].map(i => Math.max(0, Math.min(i, size - 1)));

  // Deduplicate indices (could collapse if season is very short)
  const uniqueIdx = [...new Set(picks)];
  const samples   = uniqueIdx.map(i => matches[i]);

  let totalLeakFixtures = 0;

  // ── Print each sample ──────────────────────────────────────
  samples.forEach((fixture, idx) => {
    const fDate = fixture.date.toISOString().slice(0, 10);
    const gw    = inferGameweek(fixture.date, seasonStart);
    const res   = fixture.result_o25 ? 'O2.5 ✓' : 'U2.5 ✓';

    console.log('\n' + hr());
    console.log(
      `[${idx + 1}]  ${fixture.homeTeam}  vs  ${fixture.awayTeam}`
    );
    console.log(
      `     Date: ${fDate}  |  GW≈${gw}  |` +
      `  Result: ${fixture.homeGoals}-${fixture.awayGoals}  (${res})`
    );

    const { home, away } = computeFixtureRolling(fixture, matches);
    const fixtureDateMs  = fixture.date.getTime();

    const homeLeak = printTeamWindow(
      `Home: ${fixture.homeTeam}`, home, fixtureDateMs
    );
    const awayLeak = printTeamWindow(
      `Away: ${fixture.awayTeam}`, away, fixtureDateMs
    );

    if (homeLeak || awayLeak) totalLeakFixtures++;

    // Skip verdict
    const homeInsuf = home.games_available < MIN_GAMES_REQUIRED;
    const awayInsuf = away.games_available < MIN_GAMES_REQUIRED;

    if (homeInsuf || awayInsuf) {
      const who = homeInsuf && awayInsuf ? 'both teams'
        : homeInsuf ? `home (${fixture.homeTeam})`
        : `away (${fixture.awayTeam})`;
      console.log(`\n    ⚠  SKIP  —  insufficient data (${who} has < ${MIN_GAMES_REQUIRED} games)`);
      console.log('       (Expected for early-season fixtures — this is correct behaviour)');
    } else {
      console.log(`\n    ✓  ELIGIBLE  —  sufficient data for both teams`);
    }
  });

  // ── Full dataset summary ───────────────────────────────────
  console.log('\n' + hr('═'));
  console.log('FULL DATASET SUMMARY');
  console.log(hr('─'));

  let eligible = 0;
  let skipped  = 0;
  const skipByReason = { insufficient_recent_data: 0 };

  // Early-season boundary: once we've seen N games for every team
  // some fixtures will be skipped — this is correct and expected.
  for (const fixture of matches) {
    const { home, away } = computeFixtureRolling(fixture, matches);
    if (home.games_available < MIN_GAMES_REQUIRED || away.games_available < MIN_GAMES_REQUIRED) {
      skipped++;
      skipByReason.insufficient_recent_data++;
    } else {
      eligible++;
    }
  }

  console.log(`Total fixtures in dataset:          ${matches.length}`);
  console.log(`Would generate context_raw:         ${eligible}`);
  console.log(`Would be skipped:                   ${skipped}`);
  console.log(`  └─ insufficient_recent_data:      ${skipByReason.insufficient_recent_data}`);
  console.log(`\n(Early-season skips are expected — teams need ${MIN_GAMES_REQUIRED}+ games first)`);

  // ── Leakage verdict ────────────────────────────────────────
  console.log('\n' + hr('─'));
  if (totalLeakFixtures > 0) {
    console.log(`\n⚠⚠⚠  LEAKAGE DETECTED in ${totalLeakFixtures} sample fixture(s).`);
    console.log('    DO NOT proceed to Stage 2 until leakage is resolved.');
    process.exit(1);
  } else {
    console.log('\n✓  All leakage checks passed across all sample fixtures.');
    console.log('   Safe to proceed to Stage 2.\n');
  }
}

main();
