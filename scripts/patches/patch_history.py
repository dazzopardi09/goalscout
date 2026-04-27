#!/usr/bin/env python3
"""
Patch history.js: add context_raw method group to getPredictionStats().
Adds byLeague, byGrade, byAgreement sub-groupings.
CLV is the primary metric; U2.5 shown with 'unvalidated' marker.
"""
import sys, shutil
from pathlib import Path

TARGET = Path('/Volumes/appdata/goalscout/src/engine/history.js')
if not TARGET.exists():
    print(f"ERROR: {TARGET} not found."); sys.exit(1)

content = TARGET.read_text(encoding='utf-8')
original = content

# Find the methods object construction and add context_raw.
# Current:
#   const methods = {
#     current:    aggregateFor(annotated.filter(p => (p.method || 'current') === 'current')),
#     calibrated: aggregateFor(annotated.filter(p => (p.method || 'current') === 'calibrated')),
#   };

OLD_METHODS = """  const methods = {
    current:    aggregateFor(annotated.filter(p => (p.method || 'current') === 'current')),
    calibrated: aggregateFor(annotated.filter(p => (p.method || 'current') === 'calibrated')),
  };"""

NEW_METHODS = """  const methods = {
    current:    aggregateFor(annotated.filter(p => (p.method || 'current') === 'current')),
    calibrated: aggregateFor(annotated.filter(p => (p.method || 'current') === 'calibrated')),
    context_raw: aggregateContextRaw(annotated.filter(p => p.method === 'context_raw')),
  };"""

if OLD_METHODS in content:
    content = content.replace(OLD_METHODS, NEW_METHODS, 1)
    print("Change 1 applied: context_raw added to methods object")
else:
    print("Change 1 FAILED"); sys.exit(1)

# Insert aggregateContextRaw() function BEFORE getPredictionStats() starts.
# We insert it just before "function getPredictionStats() {".
AGGREGATE_CTX_FN = '''
// ── context_raw performance aggregation ──────────────────────
// Separate from aggregateFor() because context_raw has additional
// sub-groupings (byLeague, byGrade, byAgreement) and U2.5 is
// flagged as unvalidated. CLV is the primary metric.

function aggregateContextRaw(preds) {
  if (!preds.length) {
    return {
      summary: { total: 0, settled: 0, won: 0, pending: 0 },
      markets: {
        'over_2.5':  { total: 0, settled: 0, won: 0, hitRate: null, unvalidated: false },
        'under_2.5': { total: 0, settled: 0, won: 0, hitRate: null, unvalidated: true },
      },
      byLeague: {},
      byGrade: {},
      byAgreement: {
        context_confirms:  { settled: 0, won: 0, hitRate: null },
        context_disagrees: { settled: 0, won: 0, hitRate: null },
        context_only:      { settled: 0, won: 0, hitRate: null },
      },
      recentSettled: [],
    };
  }

  const settled   = preds.filter(p => p.status === 'settled_won' || p.status === 'settled_lost');
  const won       = settled.filter(p => p.status === 'settled_won');
  const pending   = preds.filter(p => p.status === 'pending');

  function mktStats(subset, unvalidated) {
    const s = subset.filter(p => p.status === 'settled_won' || p.status === 'settled_lost');
    const w = s.filter(p => p.status === 'settled_won');
    const hitRate = s.length > 0 ? Math.round((w.length / s.length) * 1000) / 10 : null;

    const clvRows = s.filter(p => p.clvPct != null);
    const meanCLV = clvRows.length > 0
      ? Math.round((clvRows.reduce((a, p) => a + p.clvPct, 0) / clvRows.length) * 10) / 10
      : null;

    const edgeRows = subset.filter(p => p.edge != null);
    const meanEdge = edgeRows.length > 0
      ? Math.round((edgeRows.reduce((a, p) => a + p.edge, 0) / edgeRows.length) * 10) / 10
      : null;

    const pending = subset.filter(p => p.status === 'pending').length;

    // Brier score
    let brierScore = null;
    if (s.length > 0) {
      const sum = s.reduce((acc, p) => {
        const actual = p.status === 'settled_won' ? 1 : 0;
        return acc + Math.pow((p.modelProbability || 0) - actual, 2);
      }, 0);
      brierScore = Math.round((sum / s.length) * 10000) / 10000;
    }

    // ROI
    const settledWithOdds = s.filter(p => p.marketOdds != null);
    const units = settledWithOdds.reduce((acc, p) => {
      return acc + (p.status === 'settled_won' ? (p.marketOdds - 1) : -1);
    }, 0);
    const roi = settledWithOdds.length > 0
      ? Math.round((units / settledWithOdds.length) * 1000) / 10
      : null;

    return {
      total: subset.length, settled: s.length, won: w.length,
      pending, hitRate, meanCLV, meanEdge, brierScore, roi, units,
      unvalidated: !!unvalidated,
    };
  }

  function groupStats(subset) {
    const s = subset.filter(p => p.status === 'settled_won' || p.status === 'settled_lost');
    const w = s.filter(p => p.status === 'settled_won');
    const clvRows = s.filter(p => p.clvPct != null);
    const meanCLV = clvRows.length > 0
      ? Math.round((clvRows.reduce((a, p) => a + p.clvPct, 0) / clvRows.length) * 10) / 10
      : null;
    return {
      settled: s.length, won: w.length,
      hitRate: s.length > 0 ? Math.round((w.length / s.length) * 1000) / 10 : null,
      meanCLV,
    };
  }

  // byLeague: england, germany only (paper-tracked leagues)
  const leagues = [...new Set(preds.map(p => p.leagueSlug).filter(Boolean))];
  const byLeague = {};
  for (const slug of leagues) {
    byLeague[slug] = groupStats(preds.filter(p => p.leagueSlug === slug));
  }

  // byGrade: A+, A, B
  const byGrade = {};
  for (const grade of ['A+', 'A', 'B']) {
    byGrade[grade] = groupStats(preds.filter(p => p.context_grade === grade));
  }

  // byAgreement: context_confirms / context_disagrees / context_only
  const agreementTypes = ['context_confirms', 'context_disagrees', 'context_only'];
  const byAgreement = {};
  for (const type of agreementTypes) {
    byAgreement[type] = groupStats(preds.filter(p => p.selectionType === type));
  }

  // Overall CLV (primary metric)
  const clvRows = settled.filter(p => p.clvPct != null);
  const meanCLV = clvRows.length > 0
    ? Math.round((clvRows.reduce((a, p) => a + p.clvPct, 0) / clvRows.length) * 10) / 10
    : null;

  return {
    summary: {
      total: preds.length, settled: settled.length, won: won.length, pending: pending.length,
      hitRate: settled.length > 0 ? Math.round((won.length / settled.length) * 1000) / 10 : null,
      meanCLV,
    },
    markets: {
      'over_2.5':  mktStats(preds.filter(p => p.market === 'over_2.5'),  false),
      'under_2.5': mktStats(preds.filter(p => p.market === 'under_2.5'), true),
    },
    byLeague,
    byGrade,
    byAgreement,
    recentSettled: settled
      .sort((a, b) => (b.settledAt || '').localeCompare(a.settledAt || ''))
      .slice(0, 50),
  };
}

'''

INSERT_BEFORE = "function getPredictionStats() {"
if INSERT_BEFORE in content:
    content = content.replace(INSERT_BEFORE, AGGREGATE_CTX_FN + INSERT_BEFORE, 1)
    print("Change 2 applied: aggregateContextRaw() function inserted")
else:
    print("Change 2 FAILED"); sys.exit(1)

if content != original:
    backup = str(TARGET) + '.bak-ctx-perf'
    shutil.copy(TARGET, backup)
    print(f"Backup: {backup}")
    TARGET.write_text(content, encoding='utf-8')
    print(f"Written: {TARGET}")
