#!/usr/bin/env python3
# scripts/patches/patch_probability_meantg.py
# ─────────────────────────────────────────────────────────────
# Stage 1: Fix double-counted AvgTG in probability.js.
#
# Problem:
#   SoccerSTATS avgTG is each team's average total goals per match.
#   The old formula used h.avgTG + a.avgTG (summed), treating two
#   estimates of the same quantity as additive. This inflated the
#   TG signal for all matches — most visibly for high-scoring Saudi
#   league teams where sumTG = 5.14 despite an average match
#   producing ~2.5 total goals.
#
# Fix (Option C):
#   Use mean TG: (h.avgTG + a.avgTG) / 2
#   Recalibrated formula with new anchors:
#     meanTG = 1.8  →  tgSignal ≈ 0.10 (floor — defensive profile)
#     meanTG = 2.5  →  tgSignal ≈ 0.50 (neutral — market-implied O2.5)
#     meanTG = 3.0  →  tgSignal ≈ 0.79 (strong positive)
#     meanTG = 3.5+ →  tgSignal = 0.95 (cap)
#   Formula: clamp((meanTG - 1.625) / 1.75, 0.10, 0.95)
#
# Also bumps MODEL_VERSION from baseline-v1 to baseline-v1.1.
#
# Does NOT touch:
#   - shortlist.js scoring thresholds
#   - context_raw
#   - probability weights
#   - leagueStats weighting
#   - odds, settlement, CLV, team matching
#
# Run on Mac:
#   python3 /Volumes/appdata/goalscout/scripts/patches/patch_probability_meantg.py
#
# Run on Unraid:
#   python3 /mnt/user/appdata/goalscout/scripts/patches/patch_probability_meantg.py
# ─────────────────────────────────────────────────────────────

import sys, shutil
from pathlib import Path

CANDIDATES = [
    Path('/Volumes/appdata/goalscout/src/engine/probability.js'),
    Path('/mnt/user/appdata/goalscout/src/engine/probability.js'),
]
TARGET = next((p for p in CANDIDATES if p.exists()), None)
if not TARGET:
    print('ERROR: probability.js not found. Tried:')
    for p in CANDIDATES:
        print(f'  {p}')
    sys.exit(1)

print(f'Target: {TARGET}')
content = TARGET.read_text(encoding='utf-8')
original = content
changes = 0

# ── Change 1: MODEL_VERSION bump ─────────────────────────────
OLD1 = "const MODEL_VERSION = 'baseline-v1';"
NEW1 = "const MODEL_VERSION = 'baseline-v1.1';"

if OLD1 in content:
    content = content.replace(OLD1, NEW1, 1)
    changes += 1
    print('Change 1 applied: MODEL_VERSION → baseline-v1.1')
elif NEW1 in content:
    print('Change 1 skipped: MODEL_VERSION already baseline-v1.1')
else:
    print('ERROR: Change 1 — MODEL_VERSION line not found')
    sys.exit(1)

# ── Change 2: TG formula — sum → mean with recalibrated formula ──
OLD2 = (
    "  if (h.avgTG != null && a.avgTG != null) {\n"
    "    const combined = h.avgTG + a.avgTG;\n"
    "    // Maps combined TG to a probability signal:\n"
    "    // 5.0+ → ~0.73, 3.5 → ~0.50, 2.0 → ~0.25\n"
    "    const tgSignal = Math.min(0.95, Math.max(0.10, (combined - 1.5) / 5.0));\n"
    "    inputs.push(tgSignal);\n"
    "    weights.push(0.20);\n"
    "  }"
)

NEW2 = (
    "  if (h.avgTG != null && a.avgTG != null) {\n"
    "    // meanTG: average total-goals profile across both teams.\n"
    "    // Using mean (not sum) because both avgTG values are estimates\n"
    "    // of the same fixture-level quantity — adding them double-counts.\n"
    "    // Anchors: meanTG 1.8 → 0.10 (floor), 2.5 → 0.50 (neutral), 3.0 → 0.79, 3.5 → 0.95 (cap)\n"
    "    const meanTG = (h.avgTG + a.avgTG) / 2;\n"
    "    const tgSignal = Math.min(0.95, Math.max(0.10, (meanTG - 1.625) / 1.75));\n"
    "    inputs.push(tgSignal);\n"
    "    weights.push(0.20);\n"
    "  }"
)

if OLD2 in content:
    content = content.replace(OLD2, NEW2, 1)
    changes += 1
    print('Change 2 applied: TG formula → meanTG with recalibrated anchors')
elif 'meanTG' in content and '1.625' in content:
    print('Change 2 skipped: meanTG formula already present')
else:
    print('ERROR: Change 2 — TG formula block not found')
    print('  Expected to find the block containing:')
    print('    const combined = h.avgTG + a.avgTG;')
    # Try to find approximate location for diagnosis
    idx = content.find('h.avgTG != null && a.avgTG != null')
    if idx >= 0:
        print(f'  Found "h.avgTG != null" at char {idx}. Surrounding context:')
        print(repr(content[max(0,idx-10):idx+300]))
    sys.exit(1)

# ── Verify no other summed TG references remain ───────────────
if 'h.avgTG + a.avgTG' in content:
    # Check it's not in a comment or the shortlist.js context panel
    lines_with_sum = [
        (i+1, line) for i, line in enumerate(content.splitlines())
        if 'h.avgTG + a.avgTG' in line
    ]
    if lines_with_sum:
        print('WARNING: h.avgTG + a.avgTG still appears in probability.js:')
        for lineno, line in lines_with_sum:
            print(f'  line {lineno}: {line.strip()}')
        print('  Review manually — may be a comment or unrelated reference.')

# ── Write ─────────────────────────────────────────────────────
if changes == 0:
    print('No changes written — already patched.')
elif content == original:
    print('ERROR: content unchanged despite finding replacements — abort')
    sys.exit(1)
else:
    backup = TARGET.with_suffix('.js.bak-meantg')
    shutil.copy(TARGET, backup)
    TARGET.write_text(content, encoding='utf-8')
    print(f'Written: {TARGET}')
    print(f'Backup:  {backup.name}')
    print(f'Total changes applied: {changes}/2')
