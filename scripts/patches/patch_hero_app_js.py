#!/usr/bin/env python3
"""
patch_hero_app_js.py  (fix/performance-hero-metrics branch)
────────────────────────────────────────────────────────────
Updates the Performance hero strip in public/app.js:
  - Current/Calibrated cards: CLV as primary metric, hit rate as secondary
  - Reads summary.meanCLVPct (added by patch_hero_history.py)
  - Null CLV shows as "— CLV" — never 0
  - Overlap and Active View cards unchanged
  - No other app.js lines touched

Run AFTER patch_hero_history.py.

docker run --rm \
  -v /mnt/user/appdata/goalscout:/work \
  python:3.11-slim \
  python /work/scripts/patches/patch_hero_app_js.py
"""

import sys, os

CANDIDATES = [
    '/work/public/app.js',
    '/mnt/user/appdata/goalscout/public/app.js',
]
TARGET = next((p for p in CANDIDATES if os.path.isfile(p)), None)
if not TARGET:
    print('ERROR: app.js not found'); sys.exit(1)
print('Target: ' + TARGET)

with open(TARGET) as f:
    content = f.read()


OLD = '  const summaryCards = [\n    {\n      label: \'Current\',\n      val: current.summary?.settled > 0\n        ? `${Math.round((current.summary.won / current.summary.settled) * 1000) / 10}%`\n        : \'—\',\n      sub: `${current.summary?.settled || 0} settled`\n    },\n    {\n      label: \'Calibrated\',\n      val: calibrated.summary?.settled > 0\n        ? `${Math.round((calibrated.summary.won / calibrated.summary.settled) * 1000) / 10}%`\n        : \'—\',\n      sub: `${calibrated.summary?.settled || 0} settled`\n    },\n    {\n      label: \'Overlap\',\n      val: `${comparison.both || 0}`,\n      sub: `${comparison.current_only || 0} current-only · ${comparison.calibrated_only || 0} calibrated-only`\n    },\n    {\n      label: \'Active View\',\n      val: statsMethod === \'current\' ? \'Current\' : \'Calibrated\',\n      sub: `${methodData.summary?.pending || 0} pending`\n    }\n  ];\n\n  document.getElementById(\'perfSummaryCards\').innerHTML = summaryCards.map(c =>\n    `<div class="perf-hero-cell">\n      <div class="ph-label">${c.label}</div>\n      <div class="ph-val">${c.val}</div>\n      <div class="ph-sub">${c.sub}</div>\n    </div>`\n  ).join(\'\');\n'

NEW = '  // Hero CLV helper — colour thresholds per ARCHITECTURE.md:\n  //   > +1.5% convincingly positive, 0–1.5% marginal, < 0% negative.\n  // null CLV (no closing odds yet) shows as "— CLV" — never use 0 as placeholder.\n  function heroCLV(s) {\n    const clv = s?.meanCLVPct ?? null;\n    const val = clv != null\n      ? (clv >= 0 ? \'+\' : \'\') + clv.toFixed(1) + \'% CLV\'\n      : \'\\u2014 CLV\';\n    const col = clv == null  ? \'#66758c\'\n      : clv >  1.5           ? \'#6ee7b7\'\n      : clv >= 0             ? \'#fbbf24\'\n      :                        \'#f87171\';\n    const hitRate = s?.hitRate != null ? s.hitRate + \'%\' : \'\\u2014\';\n    const settled = s?.settled || 0;\n    return { val, col, sub: hitRate + \' hit \\u00b7 \' + settled + \' settled\' };\n  }\n\n  const curHero = heroCLV(current.summary);\n  const calHero = heroCLV(calibrated.summary);\n\n  const summaryCards = [\n    {\n      label:   \'CURRENT\',\n      val:     curHero.val,\n      col:     curHero.col,\n      sub:     curHero.sub,\n      tooltip: \'Mean CLV \\u2014 how much tip-time odds beat the closing line. Positive = finding value before the market moves.\',\n    },\n    {\n      label:   \'CALIBRATED\',\n      val:     calHero.val,\n      col:     calHero.col,\n      sub:     calHero.sub,\n      tooltip: \'Mean CLV \\u2014 how much tip-time odds beat the closing line. Positive = finding value before the market moves.\',\n    },\n    {\n      label:   \'OVERLAP\',\n      val:     String(comparison.both || 0),\n      col:     null,\n      sub:     (comparison.current_only || 0) + \' cur-only \\u00b7 \' + (comparison.calibrated_only || 0) + \' cal-only\',\n      tooltip: null,\n    },\n    {\n      label:   \'ACTIVE VIEW\',\n      val:     statsMethod === \'current\' ? \'Current\' : \'Calibrated\',\n      col:     null,\n      sub:     (methodData.summary?.pending || 0) + \' pending\',\n      tooltip: null,\n    },\n  ];\n\n  document.getElementById(\'perfSummaryCards\').innerHTML = summaryCards.map(c =>\n    \'<div class="perf-hero-cell">\' +\n      \'<div class="ph-label">\' + c.label + (c.tooltip ? \' <span class="ctx-tip" title="\' + c.tooltip + \'" style="cursor:help;font-size:10px;opacity:.7">\\u24d8</span>\' : \'\') + \'</div>\' +\n      \'<div class="ph-val" style="\' + (c.col ? \'color:\' + c.col : \'\') + \'">\' + c.val + \'</div>\' +\n      \'<div class="ph-sub">\' + c.sub + \'</div>\' +\n    \'</div>\'\n  ).join(\'\');\n'

count = content.count(OLD)
if count == 0:
    print('ERROR: OLD block not found. Already patched or file drifted.')
    for i, line in enumerate(content.splitlines()):
        if 'const summaryCards' in line:
            print('  line {}: {}'.format(i+1, line[:80]))
    sys.exit(1)
if count > 1:
    print('ERROR: OLD block found {} times. Aborting.'.format(count))
    sys.exit(1)

content = content.replace(OLD, NEW)

with open(TARGET, 'w') as f:
    f.write(content)

print('Patch applied successfully.')
print('')
print('Verify with:')
print('  grep -n "heroCLV\\|meanCLVPct\\|CURRENT\\|CALIBRATED" ' + TARGET + ' | head -12')
print('  grep -c "won / current.summary.settled" ' + TARGET)
print('  # last grep should return 0 (old inline hit-rate calc removed)')
