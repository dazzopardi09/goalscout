#!/usr/bin/env python3
"""
patch_perf_tables.py  (fix/performance-hero-metrics branch)
See inline comments for what each change does.

docker run --rm \
  -v /mnt/user/appdata/goalscout:/work \
  python:3.11-slim \
  python /work/scripts/patches/patch_perf_tables.py
"""
import sys, os

def resolve(candidates):
    t = next((p for p in candidates if os.path.isfile(p)), None)
    if not t:
        print('ERROR: not found:')
        for p in candidates: print('  ' + p)
        sys.exit(1)
    return t

HIST = resolve(['/work/src/engine/history.js',
                '/mnt/user/appdata/goalscout/src/engine/history.js'])
JS   = resolve(['/work/public/app.js',
                '/mnt/user/appdata/goalscout/public/app.js'])
HTML = resolve(['/work/public/index.html',
                '/mnt/user/appdata/goalscout/public/index.html'])

print('HIST: ' + HIST)
print('JS:   ' + JS)
print('HTML: ' + HTML)

with open(HIST) as f: h = f.read()
with open(JS)   as f: j = f.read()
with open(HTML) as f: html = f.read()

errors = 0

def apply(content, old, new, label):
    global errors
    c = content.count(old)
    if c != 1:
        print('ERROR: {} OLD count={}'.format(label, c))
        errors += 1
        return content
    print('OK: ' + label)
    return content.replace(old, new)

OLD_H1 = "      recentSettled: settled\n        .sort((a, b) => (b.settledAt || '').localeCompare(a.settledAt || ''))\n        .slice(0, 50),\n      overlap: {"
NEW_H1 = "      recentSettled: settled\n        .sort((a, b) => (b.settledAt || '').localeCompare(a.settledAt || ''))\n        .slice(0, 50),\n      recentSettledO25: settled\n        .filter(p => p.market === 'over_2.5')\n        .sort((a, b) => (b.settledAt || '').localeCompare(a.settledAt || ''))\n        .slice(0, 50),\n      recentSettledU25: settled\n        .filter(p => p.market === 'under_2.5')\n        .sort((a, b) => (b.settledAt || '').localeCompare(a.settledAt || ''))\n        .slice(0, 50),\n      overlap: {"
h = apply(h, OLD_H1, NEW_H1, 'history aggregateFor recentSettled split')

OLD_H2 = "    recentSettled: settled\n      .sort((a, b) => (b.settledAt || '').localeCompare(a.settledAt || ''))\n      .slice(0, 50),\n  };\n}"
NEW_H2 = "    recentSettled: settled\n      .sort((a, b) => (b.settledAt || '').localeCompare(a.settledAt || ''))\n      .slice(0, 50),\n    recentSettledO25: settled\n      .filter(p => p.market === 'over_2.5')\n      .sort((a, b) => (b.settledAt || '').localeCompare(a.settledAt || ''))\n      .slice(0, 50),\n    recentSettledU25: settled\n      .filter(p => p.market === 'under_2.5')\n      .sort((a, b) => (b.settledAt || '').localeCompare(a.settledAt || ''))\n      .slice(0, 50),\n  };\n}"
h = apply(h, OLD_H2, NEW_H2, 'history aggregateContextRaw recentSettled split')

OLD_J3 = "let activePerfMarket = 'over_2.5';"
NEW_J3 = "let activePerfMarket = 'over_2.5';\nlet activeCtxMkt = 'over_2.5'; // context settled market tab"
j = apply(j, OLD_J3, NEW_J3, 'app.js activeCtxMkt module var')

OLD_J4 = '    renderPerfTable(methodData.recentSettled || []);\n  }\n}'
NEW_J4 = "    const arr = market === 'over_2.5'\n      ? (methodData.recentSettledO25 || methodData.recentSettled || [])\n      : (methodData.recentSettledU25 || methodData.recentSettled || []);\n    renderPerfTable(arr);\n  }\n}"
j = apply(j, OLD_J4, NEW_J4, 'app.js switchPerfMarketTab pre-split')

OLD_J5 = "  renderPerfTable(methodData.recentSettled || []);\n\n  document.getElementById('perfLoading')"
NEW_J5 = "  const initArr = activePerfMarket === 'over_2.5'\n    ? (methodData.recentSettledO25 || methodData.recentSettled || [])\n    : (methodData.recentSettledU25 || methodData.recentSettled || []);\n  renderPerfTable(initArr);\n\n  document.getElementById('perfLoading')"
j = apply(j, OLD_J5, NEW_J5, 'app.js loadPerformance initial pre-split')

OLD_J6 = "function renderCtxPerfSection("

NEW_J6 = "function switchCtxPerfMarketTab(market) {\n  activeCtxMkt = market;\n  var o25Btn = document.getElementById('ctxPerfTabO25');\n  var u25Btn = document.getElementById('ctxPerfTabU25');\n  if (o25Btn) o25Btn.className = 'market-tab' + (market === 'over_2.5' ? ' active' : '');\n  if (u25Btn) u25Btn.className = 'market-tab' + (market === 'under_2.5' ? ' active-u25' : '');\n  if (statsData) {\n    var ctx = statsData.methods && statsData.methods['context_raw'];\n    if (ctx) renderCtxPerfSection(ctx);\n  }\n}\n\nfunction renderCtxPerfSection("
j = apply(j, OLD_J6, NEW_J6, 'app.js switchCtxPerfMarketTab added')

OLD_J7 = '  // ── Settled table ───────────────────────────────────────────\n  var rows = ctx.recentSettled || [];\n  var tbody = document.getElementById(\'ctxPerfTableBody\');\n  if (!tbody) return;\n\n  if (!rows.length) {\n    tbody.innerHTML = \'<tr><td colspan="12" style="text-align:center;padding:2rem;color:#8b9ab0;font-size:13px">No settled context predictions yet.</td></tr>\';\n    return;\n  }\n'
NEW_J7 = '  // ── Settled table ─────────────────────────────────────────────\n  var allRows = activeCtxMkt === \'over_2.5\'\n    ? (ctx.recentSettledO25 || (ctx.recentSettled || []).filter(function(p){ return p.market === \'over_2.5\'; }))\n    : (ctx.recentSettledU25 || (ctx.recentSettled || []).filter(function(p){ return p.market === \'under_2.5\'; }));\n  var rows = allRows;\n  var tbody = document.getElementById(\'ctxPerfTableBody\');\n  if (!tbody) return;\n\n  if (!rows.length) {\n    tbody.innerHTML = \'<tr><td colspan="12" style="text-align:center;padding:2rem;color:#8b9ab0;font-size:13px">No settled context \' + (activeCtxMkt === \'over_2.5\' ? \'Over 2.5\' : \'Under 2.5\') + \' predictions yet.</td></tr>\';\n    return;\n  }\n'
j = apply(j, OLD_J7, NEW_J7, 'app.js renderCtxPerfSection market filter')

OLD_I8 = '          <div class="settled-head-row">\n            <div>\n              <div class="settled-title">Recent Settled — Context</div>\n              <div class="settled-sub">CLV is primary — positive = beat closing line. U2.5 shown with unvalidated marker.</div>\n            </div>\n          </div>'
NEW_I8 = '          <div class="settled-head-row">\n            <div>\n              <div class="settled-title">Recent Settled — Context</div>\n              <div class="settled-sub">CLV is primary — positive = beat closing line. U2.5 shown with unvalidated marker.</div>\n            </div>\n          </div>\n          <div class="market-tabs" style="margin-bottom:14px">\n            <button class="market-tab active" id="ctxPerfTabO25" onclick="switchCtxPerfMarketTab(\'over_2.5\')">Over 2.5 Goals</button>\n            <button class="market-tab" id="ctxPerfTabU25" onclick="switchCtxPerfMarketTab(\'under_2.5\')">Under 2.5 Goals</button>\n          </div>'
html = apply(html, OLD_I8, NEW_I8, 'index.html ctx market tabs')

if errors:
    print('\n{} error(s) — files NOT written'.format(errors))
    sys.exit(1)

with open(HIST, 'w') as f: f.write(h)
with open(JS,   'w') as f: f.write(j)
with open(HTML, 'w') as f: f.write(html)

print('\nAll 8 changes applied.')
print('')
print('Verify:')
print('  grep -n "recentSettledO25" ' + HIST)
print('  grep -n "activeCtxMkt\\|switchCtxPerfMarketTab\\|recentSettledO25" ' + JS + ' | head -12')
print('  grep -n "ctxPerfTabO25" ' + HTML)
