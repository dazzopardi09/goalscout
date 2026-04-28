#!/usr/bin/env python3
# scripts/patches/patch_docs_stage2a.py
# ─────────────────────────────────────────────────────────────────────────────
# Stage 2A docs update.
# Updates PROJECT-STATUS.md and CHECKLIST.html to record the shortlist.js
# O2.5 TG rescaling and the deferred U2.5 positive threshold task.
#
# Does NOT touch any source code.
# ─────────────────────────────────────────────────────────────────────────────

import sys, shutil
from pathlib import Path

CANDIDATES_BASE = [
    Path('/Volumes/appdata/goalscout'),
    Path('/mnt/user/appdata/goalscout'),
]
ROOT = next((p for p in CANDIDATES_BASE if p.exists()), None)
if not ROOT:
    print('ERROR: repo root not found'); sys.exit(1)

print(f'Repo root: {ROOT}')

# ── PROJECT-STATUS.md ─────────────────────────────────────────────────────────
STATUS = ROOT / 'PROJECT-STATUS.md'
if not STATUS.exists():
    print(f'ERROR: {STATUS} not found'); sys.exit(1)

status = STATUS.read_text(encoding='utf-8')

NEW_SECTION = """
### shortlist.js TG scoring — Stage 2A (meanTG rescaling, April 2026)

**Problem:** `shortlist.js` used `combined = h.avgTG + a.avgTG` (sumTG scale) for
TG-based scoring signals. The O2.5 thresholds (`>= 6.0` / `>= 5.0`) were calibrated
to sumTG values that will never be reached on the meanTG scale, and the U2.5 positive
thresholds (`<= 2.0` / `<= 2.5`) never fired in practice for European football
(would require each team to average only ~1.25 total goals/match).

**Stage 2A fix:**
- O2.5 TG signal: `sumTG >= 6.0/5.0` → `meanTG >= 3.0/2.5` (algebraically equivalent)
- U2.5 high-TG penalty: `sumTG >= 5.0 → u25 -= 1` → `meanTG >= 2.5 → u25 -= 1` (equivalent)
- U2.5 positive support: commented out with Stage 2B note (was never firing anyway)
- Flag label: "Combined TG" → "Mean TG profile"

**Verified behaviour:** What-if report (2026-04-29) on 10 matches confirmed
0 direction changes, 0 grade changes, 0 pass/fail changes on Stage 2A.

**Stage 2B deferred:** Positive U2.5 meanTG thresholds (proposed: `<= 1.9` strong,
`<= 2.2` mild) need validation against a broader sample including Serie A,
La Liga, Championship, and other defensive leagues before enabling. See CHECKLIST t42.

"""

ANCHOR = '## Known Issues / Limitations'
ANCHOR2 = '## Recent Fixes'

if 'Stage 2A' in status:
    print('PROJECT-STATUS.md: Stage 2A section already present — skipping')
elif ANCHOR in status:
    status = status.replace(ANCHOR, '## shortlist.js TG Rescaling (April 2026)\n' + NEW_SECTION + '\n---\n\n' + ANCHOR, 1)
    print('PROJECT-STATUS.md: Stage 2A section inserted before Known Issues')
elif ANCHOR2 in status:
    # Append after the most recent Recent Fixes section
    idx = status.rfind(ANCHOR2)
    # Find the end of that section (next ## heading)
    next_h2 = status.find('\n## ', idx + 4)
    if next_h2 > 0:
        status = status[:next_h2] + '\n\n### shortlist.js TG Rescaling (Stage 2A)\n' + NEW_SECTION + status[next_h2:]
    else:
        status = status.rstrip() + '\n\n## shortlist.js TG Rescaling (Stage 2A)\n' + NEW_SECTION
    print('PROJECT-STATUS.md: Stage 2A section inserted in Recent Fixes')
else:
    status = status.rstrip() + '\n\n## shortlist.js TG Rescaling (Stage 2A, April 2026)\n' + NEW_SECTION
    print('PROJECT-STATUS.md: Stage 2A section appended')

backup_s = STATUS.with_suffix('.md.bak-stage2a')
shutil.copy(STATUS, backup_s)
STATUS.write_text(status, encoding='utf-8')
print(f'Written: {STATUS}')

# ── CHECKLIST.html ────────────────────────────────────────────────────────────
CHECKLIST = ROOT / 'CHECKLIST.html'
if not CHECKLIST.exists():
    print(f'ERROR: {CHECKLIST} not found'); sys.exit(1)

checklist = CHECKLIST.read_text(encoding='utf-8')
applied_cl = 0

# Mark t41 (shortlist audit) as DONE
if 't41' in checklist:
    # Replace the NOW tag with DONE tag and add checked attribute
    old_t41_open = '<input type="checkbox" id="t41"><label for="t41">'
    new_t41_open = '<input type="checkbox" checked id="t41"><label for="t41">'
    if old_t41_open in checklist:
        checklist = checklist.replace(old_t41_open, new_t41_open, 1)
        applied_cl += 1
        print('CHECKLIST.html: t41 marked as checked')
    old_tag_now = '<span class="tag tag-now">NOW</span>'
    new_tag_done = '<span class="tag tag-done">DONE</span>'
    # Only replace the t41 instance — find its position first
    t41_idx = checklist.find('id="t41"')
    if t41_idx >= 0:
        # Look for the NOW tag within the next 500 chars
        window = checklist[t41_idx:t41_idx+500]
        if old_tag_now in window:
            checklist = checklist[:t41_idx] + window.replace(old_tag_now, new_tag_done, 1) + checklist[t41_idx+500:]
            applied_cl += 1
            print('CHECKLIST.html: t41 tag → DONE')
else:
    print('CHECKLIST.html: t41 not found — may need manual update')

# Add t42: Stage 2B U2.5 positive threshold validation
NEW_T42 = """<div class="item">
  <input type="checkbox" id="t42"><label for="t42">
    Stage 2B — Validate positive U2.5 meanTG thresholds (Serie A, La Liga, Championship)
    <span class="tag tag-soon">SOON</span>
    <div class="warn">Do not enable until a broader discovered-matches sample is available.
    Proposed thresholds (meanTG &lt;= 1.9 strong, &lt;= 2.2 mild) are currently
    commented out in shortlist.js pending this backtest.</div>
    <div class="note">Run shortlist_tg_whatifreport.js on a week with 50+ matches across
    defensive leagues (Serie A, La Liga, Championship, Liga Portugal). The key question:
    does meanTG &lt;= 2.2 fire in &lt;5% of the European match population? If yes, patch.
    If it fires in &gt;10%, tighten further to &lt;= 2.0 / &lt;= 1.7 and retest.</div>
  </label>
</div>

"""

if 't42' in checklist:
    print('CHECKLIST.html: t42 already present — skipping')
else:
    # Insert before SOON section or before end of NOW section
    SOON_ANCHOR = '<!-- ── SOON ── -->'
    NOW_ANCHOR  = '<!-- ── NOW / OUTSTANDING ── -->'

    if SOON_ANCHOR in checklist:
        checklist = checklist.replace(SOON_ANCHOR, NEW_T42 + SOON_ANCHOR, 1)
        applied_cl += 1
        print('CHECKLIST.html: t42 Stage 2B item added before SOON section')
    elif NOW_ANCHOR in checklist:
        # Find the closing </div> before the SOON anchor equivalent
        # Put it at the end of the NOW section items
        idx_now = checklist.rfind('</div>', 0, checklist.find(NOW_ANCHOR) if NOW_ANCHOR in checklist else len(checklist))
        if idx_now > 0:
            checklist = checklist[:idx_now+6] + '\n\n' + NEW_T42 + checklist[idx_now+6:]
            applied_cl += 1
            print('CHECKLIST.html: t42 Stage 2B item appended to NOW section')
        else:
            print('CHECKLIST.html: could not locate insertion point for t42')
    else:
        # Fallback: append before </body>
        if '</body>' in checklist:
            checklist = checklist.replace('</body>', NEW_T42 + '</body>', 1)
            applied_cl += 1
            print('CHECKLIST.html: t42 appended before </body>')
        else:
            print('CHECKLIST.html: WARNING — no insertion point found for t42')

if applied_cl > 0:
    backup_c = CHECKLIST.with_suffix('.html.bak-stage2a')
    shutil.copy(CHECKLIST, backup_c)
    CHECKLIST.write_text(checklist, encoding='utf-8')
    print(f'Written: {CHECKLIST}')
else:
    print('CHECKLIST.html: no changes written')

print('\nDocs update complete.')
