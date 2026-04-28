#!/usr/bin/env python3
"""
patch_hero_history.py  (fix/performance-hero-metrics branch)
─────────────────────────────────────────────────────────────
Adds model-level summary.meanCLVPct and summary.hitRate to aggregateFor()
so the hero strip can read CLV consistently across all model paths.
Also adds summary.meanCLVPct as a canonical alias in aggregateContextRaw(),
keeping summary.meanCLV for backwards compatibility.

Three targeted string replacements, all in src/engine/history.js.
No calculation changes. No model behaviour changes.

docker run --rm \
  -v /mnt/user/appdata/goalscout:/work \
  python:3.11-slim \
  python /work/scripts/patches/patch_hero_history.py
"""

import sys, os

CANDIDATES = [
    '/work/src/engine/history.js',
    '/mnt/user/appdata/goalscout/src/engine/history.js',
]
TARGET = next((p for p in CANDIDATES if os.path.isfile(p)), None)
if not TARGET:
    print('ERROR: history.js not found'); sys.exit(1)
print('Target: ' + TARGET)

with open(TARGET) as f:
    content = f.read()

changes = 0

# ── Change 1: aggregateFor() — add hitRate + meanCLVPct to summary ────────
# The aggregateFor() summary currently has only counts (total/settled/won/
# pending/awaiting/void/conflicts/voidRatePct). The hero currently recomputes
# hitRate inline from won/settled. We add both fields here so the frontend
# can read them directly from summary without recalculating.

OLD1 = """    return {
      summary: {
        total:        preds.length,
        settled:      settled.length,
        won:          won.length,
        pending:      pending.length,
        awaiting:     voided.length,
        void:         voided.length,
        conflicts:    conflicts.length,
        voidRatePct:  preds.length > 0 ? Math.round((voided.length / preds.length) * 1000) / 10 : 0,
      },"""

NEW1 = """    // Model-level CLV and hit rate for the hero strip.
    // null means no data yet — do not use 0 as a placeholder.
    const clvPredsAll = preds.filter(p => p.clvPct != null);
    const meanCLVPct = clvPredsAll.length > 0
      ? Math.round((clvPredsAll.reduce((s, p) => s + p.clvPct, 0) / clvPredsAll.length) * 10) / 10
      : null;
    const allSettledPreds = preds.filter(p => p.status === 'settled_won' || p.status === 'settled_lost');
    const hitRate = allSettledPreds.length > 0
      ? Math.round((allSettledPreds.filter(p => p.status === 'settled_won').length / allSettledPreds.length) * 1000) / 10
      : null;

    return {
      summary: {
        total:        preds.length,
        settled:      settled.length,
        won:          won.length,
        pending:      pending.length,
        awaiting:     voided.length,
        void:         voided.length,
        conflicts:    conflicts.length,
        voidRatePct:  preds.length > 0 ? Math.round((voided.length / preds.length) * 1000) / 10 : 0,
        hitRate,
        meanCLVPct,
      },"""

if content.count(OLD1) != 1:
    print('ERROR: Change 1 OLD not found uniquely (count={})'.format(content.count(OLD1)))
    sys.exit(1)
content = content.replace(OLD1, NEW1)
changes += 1
print('Change 1 applied: aggregateFor() summary + hitRate + meanCLVPct')

# ── Change 2: aggregateContextRaw() main return — add meanCLVPct alias ───
# meanCLV already exists. Add meanCLVPct pointing to the same value so the
# hero can read the canonical key. Keep meanCLV — existing context UI reads it.

OLD2 = """    summary: {
      total: preds.length, settled: settled.length, won: won.length, pending: pending.length,
      hitRate: settled.length > 0 ? Math.round((won.length / settled.length) * 1000) / 10 : null,
      meanCLV,
    },"""

NEW2 = """    summary: {
      total: preds.length, settled: settled.length, won: won.length, pending: pending.length,
      hitRate: settled.length > 0 ? Math.round((won.length / settled.length) * 1000) / 10 : null,
      meanCLV,
      meanCLVPct: meanCLV, // canonical alias — hero reads this; meanCLV kept for context UI compat
    },"""

if content.count(OLD2) != 1:
    print('ERROR: Change 2 OLD not found uniquely (count={})'.format(content.count(OLD2)))
    sys.exit(1)
content = content.replace(OLD2, NEW2)
changes += 1
print('Change 2 applied: aggregateContextRaw() main return + meanCLVPct alias')

# ── Change 3: aggregateContextRaw() empty-case return — add null fields ──
# The empty-case returns a bare summary. Add meanCLVPct: null and hitRate: null
# so callers never get undefined on the canonical keys.

OLD3 = """      summary: { total: 0, settled: 0, won: 0, pending: 0 },"""

NEW3 = """      summary: { total: 0, settled: 0, won: 0, pending: 0, hitRate: null, meanCLV: null, meanCLVPct: null },"""

if content.count(OLD3) != 1:
    print('ERROR: Change 3 OLD not found uniquely (count={})'.format(content.count(OLD3)))
    sys.exit(1)
content = content.replace(OLD3, NEW3)
changes += 1
print('Change 3 applied: aggregateContextRaw() empty-case + null canonical fields')

with open(TARGET, 'w') as f:
    f.write(content)

print('')
print('{} changes applied to {}'.format(changes, TARGET))
print('')
print('Verify with:')
print('  grep -n "meanCLVPct" ' + TARGET)
print('  # expect 4 lines: Change 1 compute, Change 1 summary, Change 2, Change 3')
