#!/usr/bin/env python3
# scripts/patches/patch_shortlist_stage2a.py
# ─────────────────────────────────────────────────────────────────────────────
# Stage 2A: Rescale avgTG scoring in shortlist.js from sumTG to meanTG.
#
# SCOPE (Stage 2A only):
#   1. O2.5 TG signal:     sumTG >= 6.0/5.0  →  meanTG >= 3.0/2.5  (equivalent)
#   2. U2.5 high-TG penalty: sumTG >= 5.0 → u25 -= 1  →  meanTG >= 2.5 → u25 -= 1
#   3. Flag label: "Combined TG" → "Mean TG profile" (in addFlag calls)
#   4. Variable rename: combined → meanTG within the TG block
#
# DEFERRED (Stage 2B, pending wider backtest):
#   - Positive U2.5 TG support (old: sumTG <= 2.0/2.5, never fired in practice)
#     These are commented out with a clear note so they're not silently lost.
#
# WHY THIS IS SAFE:
#   The what-if report (2026-04-29) on 10 matches confirmed:
#   - O2.5 TG signal: old fires ≡ new fires on 100% of current population
#   - U2.5 TG penalty: old fires ≡ new fires on 100% of current population
#   - 0 direction changes, 0 grade changes, 0 pass/fail changes
#   - U2.5 positive: fired 0 times under old AND would fire 0 times under new
#     thresholds on this population (all meanTG > 2.5)
#
# DOES NOT TOUCH:
#   - probability.js (already patched as baseline-v1.1)
#   - context_raw model
#   - odds, settlement, suspicious-row logging, team-name matching
#   - public/app.js (already patched)
#   - U2.5 positive TG threshold logic (deferred to Stage 2B)
#
# Run on Unraid:
#   python3 /mnt/user/appdata/goalscout/scripts/patches/patch_shortlist_stage2a.py
# ─────────────────────────────────────────────────────────────────────────────

import sys, shutil
from pathlib import Path

CANDIDATES = [
    Path('/Volumes/appdata/goalscout/src/engine/shortlist.js'),
    Path('/mnt/user/appdata/goalscout/src/engine/shortlist.js'),
]
TARGET = next((p for p in CANDIDATES if p.exists()), None)
if not TARGET:
    print('ERROR: shortlist.js not found. Tried:')
    for p in CANDIDATES: print(f'  {p}')
    sys.exit(1)

print(f'Target: {TARGET}')
content = TARGET.read_text(encoding='utf-8')
original = content
changes = 0

# ── Idempotency guard ─────────────────────────────────────────────────────────
if 'meanTG >= 3.0' in content and 'meanTG >= 2.5' in content:
    print('shortlist.js already patched (meanTG thresholds found) — exiting.')
    sys.exit(0)

# ─────────────────────────────────────────────────────────────────────────────
# Change 1 — O2.5 TG block
#
# OLD (sumTG scale):
#   if (h.avgTG != null && a.avgTG != null) {
#     const combined = h.avgTG + a.avgTG;
#     if      (combined >= 6.0) { o25score += 2; }
#     else if (combined >= 5.0) { o25score += 1; }
#   } else {
#     if (h.avgTG != null && h.avgTG >= 2.8) { o25score += 1; }
#     if (a.avgTG != null && a.avgTG >= 2.8) { o25score += 1; }
#   }
#
# NEW (meanTG scale — equivalent thresholds):
#   if (h.avgTG != null && a.avgTG != null) {
#     // meanTG: average total-goals profile across both teams.
#     // Using mean (not sum) — both avgTG values estimate the same fixture-level
#     // quantity, so summing them double-counts. See baseline-v1.1 notes.
#     const meanTG = (h.avgTG + a.avgTG) / 2;
#     if      (meanTG >= 3.0) { o25score += 2; }  // was sumTG >= 6.0
#     else if (meanTG >= 2.5) { o25score += 1; }  // was sumTG >= 5.0
#   } else {
#     if (h.avgTG != null && h.avgTG >= 2.8) { o25score += 1; }
#     if (a.avgTG != null && a.avgTG >= 2.8) { o25score += 1; }
#   }
# ─────────────────────────────────────────────────────────────────────────────

OLD1 = (
    "  if (h.avgTG != null && a.avgTG != null) {\n"
    "    const combined = h.avgTG + a.avgTG;\n"
    "    if      (combined >= 6.0) { o25score += 2; }\n"
    "    else if (combined >= 5.0) { o25score += 1; }\n"
    "  } else {\n"
    "    if (h.avgTG != null && h.avgTG >= 2.8) { o25score += 1; }\n"
    "    if (a.avgTG != null && a.avgTG >= 2.8) { o25score += 1; }\n"
    "  }"
)

NEW1 = (
    "  if (h.avgTG != null && a.avgTG != null) {\n"
    "    // meanTG: average total-goals profile across both teams.\n"
    "    // Using mean (not sum) — both avgTG values estimate the same fixture-level\n"
    "    // quantity, so summing them double-counts. See baseline-v1.1 notes.\n"
    "    const meanTG = (h.avgTG + a.avgTG) / 2;\n"
    "    if      (meanTG >= 3.0) { o25score += 2; }  // was sumTG >= 6.0\n"
    "    else if (meanTG >= 2.5) { o25score += 1; }  // was sumTG >= 5.0\n"
    "  } else {\n"
    "    if (h.avgTG != null && h.avgTG >= 2.8) { o25score += 1; }\n"
    "    if (a.avgTG != null && a.avgTG >= 2.8) { o25score += 1; }\n"
    "  }"
)

if OLD1 in content:
    content = content.replace(OLD1, NEW1, 1)
    changes += 1
    print('Change 1 applied: O2.5 TG block → meanTG scale (3.0/2.5)')
elif 'meanTG >= 3.0' in content:
    print('Change 1 skipped: O2.5 TG block already uses meanTG')
else:
    print('ERROR: Change 1 — O2.5 TG block not found.')
    print('  Expected block starting with:')
    print('    const combined = h.avgTG + a.avgTG;')
    print('    if      (combined >= 6.0) ...')
    idx = content.find('h.avgTG + a.avgTG')
    if idx >= 0:
        print(f'  Found "h.avgTG + a.avgTG" at char {idx}. Context:')
        print(repr(content[max(0, idx-60):idx+300]))
    else:
        print('  "h.avgTG + a.avgTG" not found in file at all.')
        # Try to locate combined-based scoring
        idx2 = content.find('combined >= 6.0')
        if idx2 >= 0:
            print(f'  Found "combined >= 6.0" at char {idx2}. Context:')
            print(repr(content[max(0, idx2-120):idx2+200]))
    sys.exit(1)

# ─────────────────────────────────────────────────────────────────────────────
# Change 2 — U2.5 positive TG block (comment out — deferred to Stage 2B)
#
# OLD (sumTG scale — fired 0 times in practice, thresholds broken for European football):
#   if (h.avgTG != null && a.avgTG != null) {
#     if      (combined <= 2.0) { u25score += 2; }
#     else if (combined <= 2.5) { u25score += 1; }
#   }
#
# NEW (commented out — Stage 2B pending broader discovered-matches backtest):
#   // STAGE 2B DEFERRED — positive U2.5 meanTG thresholds not yet validated.
#   // Old thresholds (sumTG <= 2.0/2.5) never fired for European football because
#   // sumTG for any top-flight team pair is ~4.4–6.8, well above 2.5.
#   // Proposed meanTG <= 1.9/2.2 needs testing against a multi-league sample
#   // before enabling. See CHECKLIST.html t42.
#   // if (h.avgTG != null && a.avgTG != null) {
#   //   if      (meanTG <= 1.9) { u25score += 2; }  // proposed — NOT YET ACTIVE
#   //   else if (meanTG <= 2.2) { u25score += 1; }  // proposed — NOT YET ACTIVE
#   // }
# ─────────────────────────────────────────────────────────────────────────────

# The U2.5 positive block re-uses `combined` which was declared in the O2.5 block above.
# After Change 1, `combined` no longer exists in that scope, so the U2.5 block
# (which references `combined`) must also be updated. We comment it out entirely.

OLD2 = (
    "  if (h.avgTG != null && a.avgTG != null) {\n"
    "    if      (combined <= 2.0) { u25score += 2; }\n"
    "    else if (combined <= 2.5) { u25score += 1; }\n"
    "  }"
)

NEW2 = (
    "  // STAGE 2B DEFERRED — positive U2.5 meanTG thresholds not yet validated.\n"
    "  // Old thresholds (sumTG <= 2.0/2.5) never fired for European football because\n"
    "  // sumTG for any top-flight team pair is ~4.4–6.8, well above 2.5.\n"
    "  // Proposed meanTG <= 1.9/2.2 needs testing against a multi-league sample\n"
    "  // (Serie A, La Liga, Championship) before enabling. See CHECKLIST.html t42.\n"
    "  // if (h.avgTG != null && a.avgTG != null) {\n"
    "  //   if      (meanTG <= 1.9) { u25score += 2; }  // proposed — NOT YET ACTIVE\n"
    "  //   else if (meanTG <= 2.2) { u25score += 1; }  // proposed — NOT YET ACTIVE\n"
    "  // }"
)

if OLD2 in content:
    content = content.replace(OLD2, NEW2, 1)
    changes += 1
    print('Change 2 applied: U2.5 positive TG block commented out (Stage 2B deferred)')
elif 'STAGE 2B DEFERRED' in content:
    print('Change 2 skipped: U2.5 positive TG block already deferred')
else:
    print('ERROR: Change 2 — U2.5 positive TG block not found.')
    idx = content.find('combined <= 2.0')
    if idx >= 0:
        print(f'  Found "combined <= 2.0" at char {idx}. Context:')
        print(repr(content[max(0, idx-80):idx+200]))
    else:
        print('  "combined <= 2.0" not found.')
        print('  This block may already be absent or structured differently.')
        print('  Continuing (non-fatal if block was already removed).')
        # Non-fatal — if this block doesn't exist, scoring is already correct

# ─────────────────────────────────────────────────────────────────────────────
# Change 3 — U2.5 high-TG penalty
#
# OLD: if (combined >= 5.0) { u25score -= 1; }
# NEW: if (meanTG  >= 2.5) { u25score -= 1; }   // was sumTG >= 5.0
#
# Note: The `meanTG` variable is not in scope here (it was declared in the O2.5
# block). We need to recalculate it inline, OR declare meanTG at function scope.
# The safest approach is to recalculate inline — identical to what the O2.5
# block already computes, so this is a small duplication but correct.
# ─────────────────────────────────────────────────────────────────────────────

# The penalty appears in a separate block, likely structured as:
#   if (h.avgTG != null && a.avgTG != null && (h.avgTG + a.avgTG) >= 5.0) {
#     u25score -= 1;
#   }
# OR as a standalone line using `combined` from outer scope.
# We handle both patterns.

# Pattern A: inline combined check in the penalty
OLD3A = "    if (combined >= 5.0) { u25score -= 1; }"
NEW3A = "    if (meanTG  >= 2.5)  { u25score -= 1; }  // was combined >= 5.0"

# Pattern B: standalone block with its own avgTG check
OLD3B = (
    "  if (h.avgTG != null && a.avgTG != null) {\n"
    "    if (combined >= 5.0) { u25score -= 1; }\n"
    "  }"
)
NEW3B = (
    "  if (h.avgTG != null && a.avgTG != null) {\n"
    "    const meanTG_pen = (h.avgTG + a.avgTG) / 2;\n"
    "    if (meanTG_pen >= 2.5) { u25score -= 1; }  // was sumTG >= 5.0\n"
    "  }"
)

# Pattern C: combined check recalculated inline without separate block
OLD3C = "if (combined >= 5.0) { u25score -= 1; }"
NEW3C = "if ((h.avgTG + a.avgTG) / 2 >= 2.5) { u25score -= 1; }  // was sumTG >= 5.0"

applied3 = False
if OLD3A in content:
    content = content.replace(OLD3A, NEW3A, 1)
    changes += 1
    applied3 = True
    print('Change 3 applied (Pattern A): U2.5 penalty → meanTG >= 2.5')
elif OLD3B in content:
    content = content.replace(OLD3B, NEW3B, 1)
    changes += 1
    applied3 = True
    print('Change 3 applied (Pattern B): U2.5 penalty block → meanTG_pen >= 2.5')
elif OLD3C in content:
    content = content.replace(OLD3C, NEW3C, 1)
    changes += 1
    applied3 = True
    print('Change 3 applied (Pattern C): U2.5 penalty inline → inline mean >= 2.5')
elif 'meanTG_pen' in content or 'meanTG  >= 2.5' in content or 'mean >= 2.5' in content:
    print('Change 3 skipped: U2.5 penalty already rescaled')
    applied3 = True
else:
    print('ERROR: Change 3 — U2.5 penalty pattern not found.')
    print('  Tried patterns: "combined >= 5.0" with u25score -= 1')
    idx = content.find('u25score -= 1')
    if idx >= 0:
        print(f'  Found "u25score -= 1" at char {idx}. Context:')
        print(repr(content[max(0, idx-120):idx+80]))
    else:
        print('  "u25score -= 1" not found in file at all.')
    sys.exit(1)

# ─────────────────────────────────────────────────────────────────────────────
# Change 4 — Flag labels: "Combined TG" → "Mean TG profile"
#
# shortlist.js uses addFlag() calls to build the signals/flags shown in the UI.
# Any call with 'Combined TG' or 'combined TG' string needs updating.
# ─────────────────────────────────────────────────────────────────────────────

flag_replacements = [
    ("'Combined TG'",    "'Mean TG profile'"),
    ('"Combined TG"',    '"Mean TG profile"'),
    ("'combined TG'",    "'Mean TG profile'"),
    ('"combined TG"',    '"Mean TG profile"'),
    ("'Avg TG'",         "'Mean TG profile'"),   # fallback for variant spelling
]
flag_changes = 0
for old_flag, new_flag in flag_replacements:
    if old_flag in content:
        count = content.count(old_flag)
        content = content.replace(old_flag, new_flag)
        flag_changes += count
        print(f'Change 4 applied: {count}× {old_flag} → {new_flag}')

if flag_changes == 0:
    # Check if already updated
    if 'Mean TG profile' in content:
        print('Change 4 skipped: flag labels already say "Mean TG profile"')
    else:
        print('Change 4 NOTE: No "Combined TG" flag labels found — may not be present or already absent.')
        print('  (Non-fatal: addFlag() calls may use a different string or may not exist for TG signals.)')
else:
    changes += 1

# ── Sanity check: confirm no remaining `combined` variable references ─────────
# After the patch, `combined` should only appear in comments (the OLD2 comment block)
remaining_combined = [
    (i+1, line.rstrip()) for i, line in enumerate(content.splitlines())
    if 'combined' in line and '//' not in line.lstrip()[:2]
    and not line.strip().startswith('//')
]
if remaining_combined:
    print('\nWARNING: Unreplaced `combined` references found (review manually):')
    for lineno, line in remaining_combined:
        print(f'  line {lineno}: {line}')
else:
    print('Sanity check: no active `combined` variable references remaining ✓')

# ── Write ─────────────────────────────────────────────────────────────────────
if changes == 0 and content == original:
    print('\nNo changes written — already fully patched.')
elif content == original:
    print('\nERROR: content unchanged despite finding replacements — aborting.')
    sys.exit(1)
else:
    backup = TARGET.with_suffix('.js.bak-stage2a')
    shutil.copy(TARGET, backup)
    TARGET.write_text(content, encoding='utf-8')
    print(f'\nWritten:  {TARGET}')
    print(f'Backup:   {backup.name}')
    print(f'Changes applied: {changes}')
