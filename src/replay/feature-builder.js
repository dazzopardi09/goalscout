// src/replay/feature-builder.js
// ─────────────────────────────────────────────────────────────
// Replay feature builder.
//
// Wraps scripts/replay/lib/replay-metrics.mjs (ESM) and
// normalises its output to the exact field shape expected by:
//   - src/engine/shortlist.js  → scoreMatch(match, leagueStats)
//   - src/engine/probability.js → estimateO25(match, leagueStats)
//
// Field normalisation required:
//   replay-metrics returns: o25Pct (capital P)
//   live engine expects:    o25pct (lowercase p)
//   replay-metrics returns: played
//   live engine expects:    gp  (enables the too-few-games guard in scoreMatch)
//
// Fields NOT available from replay-metrics (set to null):
//   ppg  — not computed, PPG mismatch signal silently skips in scoreMatch
//
// No leakage guarantee:
//   buildFixtureFeatures() in replay-metrics.mjs filters to
//   status === "completed" && kickoffUtc < targetFixture.kickoffUtc
//   before computing any metrics. This file does not weaken that guarantee.
//
// Usage:
//   const { buildNormalisedFeatures } = require('./feature-builder');
//   const features = await buildNormalisedFeatures(allFixtures, targetFixture, 5);
//   // features.home and features.away are ready for scoreMatch / estimateO25
// ─────────────────────────────────────────────────────────────

'use strict';

// ESM interop — replay-metrics.mjs is an ES module; the live app is CJS.
let _metricsModule = null;

async function getMetrics() {
  if (_metricsModule) return _metricsModule;
  _metricsModule = await import('../../scripts/replay/lib/replay-metrics.mjs');
  return _metricsModule;
}

function normaliseTeamMetrics(metrics) {
  if (!metrics) return null;
  return {
    gp:     metrics.played ?? null,
    o25pct: metrics.o25Pct ?? null,
    avgTG:  metrics.avgTG  ?? null,
    csPct:  metrics.csPct  ?? null,
    ftsPct: metrics.ftsPct ?? null,
    ppg:    null,
  };
}

function buildLeagueStatsFromHistoricalSlice(fixtures, cutoffUtc) {
  const hist = fixtures.filter(f =>
    f.status === 'completed' &&
    new Date(f.kickoffUtc) < new Date(cutoffUtc)
  );

  if (!hist.length) {
    return {
      o25pct: null,
      avgGoals: null,
      gp: 0,
    };
  }

  let over25 = 0;
  let totalGoalsSum = 0;

  for (const f of hist) {
    const tg = (f.homeGoals ?? 0) + (f.awayGoals ?? 0);
    if (tg > 2.5) over25 += 1;
    totalGoalsSum += tg;
  }

  return {
    gp: hist.length,
    o25pct: Math.round((over25 / hist.length) * 100),
    avgGoals: Math.round((totalGoalsSum / hist.length) * 100) / 100,
  };
}

async function buildNormalisedFeatures(allFixtures, targetFixture, limit = 5) {
  const { buildFixtureFeatures } = await getMetrics();

  const raw = buildFixtureFeatures(allFixtures, targetFixture, limit);
  const leagueStats = buildLeagueStatsFromHistoricalSlice(allFixtures, targetFixture.kickoffUtc);

  return {
    home: normaliseTeamMetrics(raw.home),
    away: normaliseTeamMetrics(raw.away),
    sampleSizes: raw.sampleSizes,
    leagueStats,
  };
}

module.exports = { buildNormalisedFeatures };