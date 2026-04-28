#!/usr/bin/env python3
# scripts/patches/patch_docs_meantg.py
# ─────────────────────────────────────────────────────────────
# Stage 1 docs update: record meanTG probability fix.
#
# Changes PROJECT-STATUS.md and CHECKLIST.html only.
# Does not touch any source code.
#
# Run on Mac:
#   python3 /Volumes/appdata/goalscout/scripts/patches/patch_docs_meantg.py
# ─────────────────────────────────────────────────────────────

import sys, shutil, re
from pathlib import Path

CANDIDATES_BASE = [
    Path('/Volumes/appdata/goalscout'),
    Path('/mnt/user/appdata/goalscout'),
]
ROOT = next((p for p in CANDIDATES_BASE if p.exists()), None)
if not ROOT:
    print('ERROR: repo root not found'); sys.exit(1)

print(f'Repo root: {ROOT}')

# ── PROJECT-STATUS.md ─────────────────────────────────────────
STATUS = ROOT / 'PROJECT-STATUS.md'
if not STATUS.exists():
    print(f'ERROR: {STATUS} not found'); sys.exit(1)

status = STATUS.read_text(encoding='utf-8')

NEW_FIX_SECTION = """
### AvgTG probability correction — baseline-v1.1 (Stage 1, April 2026)

**Problem:** `probability.js` used `h.avgTG + a.avgTG` (summed) as the TG
signal input. SoccerSTATS `avgTG` is each team's average total goals per match —
both values estimate the same fixture-level quantity, so summing them
double-counted. For a typical Saudi Pro League match with both teams averaging
~2.5–2.6 total goals, this produced a sumTG of ~5.14 and an inflated tgSignal
of 0.73 that pushed marginal O2.5 picks over the 60% shortlist floor.

**Fix (Option C):** Use mean TG: `(h.avgTG + a.avgTG) / 2`. Recalibrated
formula with anchors: meanTG 1.8 → 0.10 (floor), 2.5 → 0.50 (neutral),
3.0 → 0.79, 3.5+ → 0.95 (cap).
Formula: `clamp((meanTG - 1.625) / 1.75, 0.10, 0.95)`

**MODEL_VERSION bumped:** `baseline-v1` → `baseline-v1.1`

**Compatibility note:** Predictions logged before this fix carry
`modelVersion: 'baseline-v1'` and used the summed TG input. Their
`modelProbability` values are not directly comparable to `baseline-v1.1`
values for matches where the TG signal differed meaningfully. Settlement,
odds, CLV, and `resultSource` fields are unaffected.

**context_raw not affected:** The context_raw model uses its own separate
rolling stats from Football-Data.org and does not read SoccerSTATS `avgTG`.

**Verified impact (what-if report, 2026-04-28):**
- Neom SC vs Al Hazm (saudiarabia): 62.61% → 58.85% (−3.76pp, drops below 60%)
- Al Taawon vs Al Ittihad (saudiarabia): no change (meanTG = 3.40 → hits cap)

**Stage 2 deferred:** `shortlist.js` scoring thresholds were written against
the summed TG scale. The O2.5 thresholds (≥6.0, ≥5.0) will never fire on the
mean scale. A broader what-if audit using `discovered-matches.json` is required
before touching `shortlist.js`. See CHECKLIST.html.

"""

# Insert before "## Known Issues / Limitations"
INSERT_BEFORE = '## Known Issues / Limitations'
if NEW_FIX_SECTION.strip() in status:
    print('PROJECT-STATUS.md: AvgTG fix section already present — skipping')
elif INSERT_BEFORE in status:
    status = status.replace(
        INSERT_BEFORE,
        '## Recent Fixes (April 2026 — continued)\n' + NEW_FIX_SECTION + '\n---\n\n' + INSERT_BEFORE,
        1
    )
    print('PROJECT-STATUS.md: AvgTG fix section inserted')
else:
    # Append at end of Recent Fixes section if anchor not found
    status = status.rstrip() + '\n\n' + '## AvgTG Probability Correction (April 2026)\n' + NEW_FIX_SECTION
    print('PROJECT-STATUS.md: AvgTG fix appended at end')

backup_s = STATUS.with_suffix('.md.bak-meantg')
shutil.copy(STATUS, backup_s)
STATUS.write_text(status, encoding='utf-8')
print(f'Written: {STATUS}')

# ── CHECKLIST.html ────────────────────────────────────────────
CHECKLIST = ROOT / 'CHECKLIST.html'
if not CHECKLIST.exists():
    print(f'ERROR: {CHECKLIST} not found'); sys.exit(1)

checklist = CHECKLIST.read_text(encoding='utf-8')

# 1. Add completed item for AvgTG fix — insert into Completed section
#    after the last existing completed item (t39)
COMPLETED_ANCHOR = '</div>\n\n<!-- ── NOW / OUTSTANDING ── -->'
NEW_COMPLETED_ITEM = """
<div class="item done">
  <input type="checkbox" checked id="t40"><label for="t40">
    AvgTG probability correction — baseline-v1.1
    <span class="tag tag-done">DONE</span>
    <div class="note">probability.js: changed TG input from sum (h.avgTG + a.avgTG) to mean ((h+a)/2). Recalibrated formula: clamp((meanTG - 1.625) / 1.75, 0.10, 0.95). Bumped MODEL_VERSION to baseline-v1.1. app.js: display now shows mean TG profile. Verified: Neom SC vs Al Hazm drops from 62.61% to 58.85%. April 2026.</div>
  </label>
</div>

"""

# 2. Add NOW item for shortlist.js audit
NOW_ANCHOR = '<!-- ── SOON ── -->'
NEW_NOW_ITEM = """<div class="item">
  <input type="checkbox" id="t41"><label for="t41">
    shortlist.js scoring-threshold audit — extend what-if to discovered-matches.json
    <span class="tag tag-now">NOW</span>
    <div class="warn">O2.5 thresholds (≥6.0, ≥5.0) will never fire on mean TG scale. U2.5 thresholds (≤2.0, ≤2.5) may over-fire. The current what-if script only covers shortlisted matches — extend to use discovered-matches.json for a full-population view before patching shortlist.js.</div>
    <div class="note">Script: data/whatifreport.js — add discovered-matches.json source to Section 3 U2.5 analysis. Target: 30+ rows across EPL/Bundesliga/Ligue 1 to see real threshold fire rates on the mean scale.</div>
  </label>
</div>

"""

applied = 0

if 't40' in checklist:
    print('CHECKLIST.html: t40 (AvgTG fix) already present — skipping')
elif COMPLETED_ANCHOR in checklist:
    checklist = checklist.replace(COMPLETED_ANCHOR, NEW_COMPLETED_ITEM + COMPLETED_ANCHOR, 1)
    applied += 1
    print('CHECKLIST.html: t40 completed item added')
else:
    print('WARNING: CHECKLIST.html completed anchor not found — skipping t40')

if 't41' in checklist:
    print('CHECKLIST.html: t41 (shortlist audit) already present — skipping')
elif NOW_ANCHOR in checklist:
    checklist = checklist.replace(NOW_ANCHOR, NEW_NOW_ITEM + NOW_ANCHOR, 1)
    applied += 1
    print('CHECKLIST.html: t41 shortlist audit NOW item added')
else:
    print('WARNING: CHECKLIST.html NOW anchor not found — skipping t41')

if applied > 0:
    backup_c = CHECKLIST.with_suffix('.html.bak-meantg')
    shutil.copy(CHECKLIST, backup_c)
    CHECKLIST.write_text(checklist, encoding='utf-8')
    print(f'Written: {CHECKLIST}')
else:
    print('CHECKLIST.html: no changes written')

print(f'\nAll docs updated.')
