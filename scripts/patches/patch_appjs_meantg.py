#!/usr/bin/env python3
# scripts/patches/patch_appjs_meantg.py
# ─────────────────────────────────────────────────────────────
# Stage 1: Fix AvgTG display in public/app.js.
#
# Change 1: combinedTG calculation sum → mean (var, not const)
# Change 2: Model Inputs label "Avg TG ×0.20" → "Mean TG profile ×0.20"
# Change 3: O2.5 Context label "Combined TG" → "Mean TG profile", hit >= 2.7 → >= 1.5
# Change 4: Progress bar scaling tgRaw/5 → tgRaw/3.5
#
# Note: Change 1 already applied. Script is idempotent — safe to re-run.
# ─────────────────────────────────────────────────────────────

import sys, shutil
from pathlib import Path

CANDIDATES = [
    Path('/Volumes/appdata/goalscout/public/app.js'),
    Path('/mnt/user/appdata/goalscout/public/app.js'),
]
TARGET = next((p for p in CANDIDATES if p.exists()), None)
if not TARGET:
    print('ERROR: app.js not found'); sys.exit(1)

print(f'Target: {TARGET}')
content = TARGET.read_text(encoding='utf-8')
original = content
changes = 0

# ── Change 1: combinedTG sum → mean (var) ────────────────────
OLD1 = (
    "  var combinedTG = (m.home?.avgTG != null && m.away?.avgTG != null)\n"
    "    ? (m.home.avgTG + m.away.avgTG).toFixed(2) : null;"
)
NEW1 = (
    "  var combinedTG = (m.home?.avgTG != null && m.away?.avgTG != null)\n"
    "    ? ((m.home.avgTG + m.away.avgTG) / 2).toFixed(2) : null;"
)
if OLD1 in content:
    content = content.replace(OLD1, NEW1, 1); changes += 1
    print('Change 1 applied: combinedTG → mean TG')
elif NEW1 in content:
    print('Change 1 skipped: already using mean TG')
else:
    print('ERROR: Change 1 not found'); sys.exit(1)

# ── Change 2: Model Inputs label (inside multi-line template literal) ──
OLD2 = '          <div class="inp-name">Avg TG <span class="inp-weight">\xd70.20</span></div>'
NEW2 = '          <div class="inp-name">Mean TG profile <span class="inp-weight">\xd70.20</span></div>'
if OLD2 in content:
    content = content.replace(OLD2, NEW2, 1); changes += 1
    print('Change 2 applied: label → "Mean TG profile ×0.20"')
elif NEW2 in content:
    print('Change 2 skipped: label already updated')
else:
    print('ERROR: Change 2 — label not found')
    idx = content.find('Avg TG')
    if idx >= 0:
        print('  Context:', repr(content[max(0,idx-20):idx+120]))
    sys.exit(1)

# ── Change 3: O2.5 context panel label + hit threshold ───────
OLD3 = (
    "${combinedTG ? `<div class=\"ctx-row\"><div class=\"ctx-name\">Combined TG</div>"
    "<div class=\"ctx-val ${parseFloat(combinedTG) >= 2.7 ? 'hit' : 'plain'}\">"
    "${combinedTG}</div></div>` : ''}"
)
NEW3 = (
    "${combinedTG ? `<div class=\"ctx-row\"><div class=\"ctx-name\">Mean TG profile</div>"
    "<div class=\"ctx-val ${parseFloat(combinedTG) >= 1.5 ? 'hit' : 'plain'}\">"
    "${combinedTG}</div></div>` : ''}"
)
if OLD3 in content:
    content = content.replace(OLD3, NEW3, 1); changes += 1
    print('Change 3 applied: context → "Mean TG profile", hit threshold >= 1.5')
elif NEW3 in content:
    print('Change 3 skipped: context panel already updated')
else:
    print('ERROR: Change 3 — Combined TG row not found')
    idx = content.find('Combined TG')
    if idx >= 0:
        print('  Context:', repr(content[max(0,idx-30):idx+200]))
    sys.exit(1)

# ── Change 4: Progress bar scaling tgRaw/5 → tgRaw/3.5 ───────
OLD4 = '          <div class="inp-track"><div class="inp-fill" style="width:${Math.min(tgRaw/5*100,100)}%"></div></div>'
NEW4 = '          <div class="inp-track"><div class="inp-fill" style="width:${Math.min(tgRaw/3.5*100,100)}%"></div></div>'
if OLD4 in content:
    content = content.replace(OLD4, NEW4, 1); changes += 1
    print('Change 4 applied: progress bar → tgRaw/3.5')
elif 'tgRaw/3.5' in content:
    print('Change 4 skipped: already uses /3.5')
else:
    print('WARNING: Change 4 — tgRaw/5 not found (cosmetic, continuing)')
    idx = content.find('tgRaw')
    if idx >= 0:
        print('  Context:', repr(content[max(0,idx-30):idx+100]))

# ── Write ─────────────────────────────────────────────────────
if content == original:
    print('No changes written — all already applied.')
else:
    backup = TARGET.with_suffix('.js.bak-meantg')
    shutil.copy(TARGET, backup)
    TARGET.write_text(content, encoding='utf-8')
    print(f'Written: {TARGET}  (backup: {backup.name})')
    print(f'Total changes applied: {changes}')