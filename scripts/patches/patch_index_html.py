#!/usr/bin/env python3
"""
Patch public/index.html:
Add collapsible "Context Model" section below existing Performance content.
"""
import sys, shutil
from pathlib import Path

TARGET = Path('/Volumes/appdata/goalscout/public/index.html')
if not TARGET.exists():
    print(f"ERROR: {TARGET} not found."); sys.exit(1)

content = TARGET.read_text(encoding='utf-8')
original = content

# ── HTML: insert collapsible context section after phase-note, inside perfContent ──
# The phase-note is the last element before </div><!-- /perfContent -->
OLD_PERF_END = """      <!-- Phase note -->
      <div class="phase-note">
        <div class="phase-dot"></div>
        <div class="phase-text">
          <strong>Phase 1 — Calibration data collection.</strong>
          The model needs 200+ settled predictions before calibration metrics are meaningful.
          Current priority is pipeline accuracy (results source fix) and data collection.
          Hit rate at this sample size is highly variable — focus on mean edge and CLV trend instead.
        </div>
      </div>

    </div><!-- /perfContent -->"""

NEW_PERF_END = """      <!-- Phase note -->
      <div class="phase-note">
        <div class="phase-dot"></div>
        <div class="phase-text">
          <strong>Phase 1 — Calibration data collection.</strong>
          The model needs 200+ settled predictions before calibration metrics are meaningful.
          Current priority is pipeline accuracy (results source fix) and data collection.
          Hit rate at this sample size is highly variable — focus on mean edge and CLV trend instead.
        </div>
      </div>

      <!-- ── Context Model section ── -->
      <div style="margin-top:18px">
        <button id="ctxPerfToggle" onclick="toggleCtxPerfSection()"
          style="display:flex;align-items:center;gap:10px;background:rgba(129,140,248,.08);border:1px solid rgba(129,140,248,.2);border-radius:14px;padding:12px 18px;cursor:pointer;font-family:inherit;color:#818cf8;font-size:13px;font-weight:600;width:100%;text-align:left">
          <span id="ctxPerfChevron" style="transition:transform .2s;display:inline-block">▾</span>
          Context Model — Paper Tracking
          <span style="margin-left:auto;font-size:10px;font-weight:400;color:#4f5a8a;letter-spacing:.1em;text-transform:uppercase">England · Germany · Uncalibrated</span>
        </button>
        <div id="ctxPerfBody" style="display:block">

          <!-- Hero cards -->
          <div class="perf-hero-strip" id="ctxPerfCards" style="margin-top:10px"></div>

          <!-- CLV note -->
          <div style="font-size:11px;color:#66758c;padding:6px 4px 10px">
            CLV is the primary metric for context_raw. Hit rate and ROI are shown but interpret differently — model is uncalibrated and U2.5 signal is unvalidated. Accumulating paper predictions before any real-money use.
          </div>

          <!-- Agreement breakdown -->
          <div class="settled-wrap" style="margin-bottom:14px">
            <div style="padding:10px 14px;border-bottom:1px solid rgba(255,255,255,.08)">
              <div class="settled-title">Agreement with Current / Calibrated</div>
              <div class="settled-sub">How context_raw predictions relate to the other two models (direction-aware)</div>
            </div>
            <div id="ctxPerfAgreement" style="padding:14px"></div>
          </div>

          <!-- League + Grade breakdown -->
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px">
            <div class="settled-wrap">
              <div style="padding:10px 14px;border-bottom:1px solid rgba(255,255,255,.08)">
                <div class="settled-title">By League</div>
              </div>
              <div id="ctxPerfByLeague" style="padding:14px"></div>
            </div>
            <div class="settled-wrap">
              <div style="padding:10px 14px;border-bottom:1px solid rgba(255,255,255,.08)">
                <div class="settled-title">By Grade</div>
              </div>
              <div id="ctxPerfByGrade" style="padding:14px"></div>
            </div>
          </div>

          <!-- Market breakdown -->
          <div class="perf-mkt-grid" id="ctxPerfMarkets"></div>

          <!-- Settled table -->
          <div class="settled-wrap">
            <div style="padding:10px 14px;border-bottom:1px solid rgba(255,255,255,.08)">
              <div class="settled-title">Context Settled Predictions</div>
              <div class="settled-sub">CLV is primary — positive = beat closing line. U2.5 shown with unvalidated marker.</div>
            </div>
            <div class="perf-table-wrap">
              <table class="perf-table" id="ctxPerfTable">
                <thead><tr>
                  <th>Date</th><th>Match</th><th>Grade</th><th>Dir</th>
                  <th>Agreement</th>
                  <th style="text-align:right">Model%</th>
                  <th style="text-align:right">Tip Odds</th>
                  <th style="text-align:right">Edge</th>
                  <th style="text-align:right">Close</th>
                  <th style="text-align:right">CLV%</th>
                  <th style="text-align:center">Score</th>
                  <th style="text-align:center">Result</th>
                </tr></thead>
                <tbody id="ctxPerfTableBody"></tbody>
              </table>
            </div>
          </div>

          <div class="ctx-phase-note" style="margin-top:14px">
            <div class="ctx-phase-dot"></div>
            <div>
              <strong>context_raw — paper tracking only.</strong>
              Not for real-money decisions until Stage 12 (after Stage 11 calibration review with 200+ settled predictions per league).
              CLV accumulates from each settled prediction. Agreement type stored at prediction time — reflects shortlist state at the moment of each refresh.
            </div>
          </div>

        </div><!-- /ctxPerfBody -->
      </div><!-- /context model section -->

    </div><!-- /perfContent -->"""

if OLD_PERF_END in content:
    content = content.replace(OLD_PERF_END, NEW_PERF_END, 1)
    print("HTML change applied: context section inserted into perfPanel")
else:
    print("HTML change FAILED"); sys.exit(1)

# ── JS: insert toggle function and renderCtxPerf() into script block ──
# Insert before the closing </script> tag (the last one in the file)
# Find the last </script> occurrence.

JS_TO_INSERT = """
// ─── Context Performance section ──────────────────────────────────────────────

function toggleCtxPerfSection() {
  var body = document.getElementById('ctxPerfBody');
  var chevron = document.getElementById('ctxPerfChevron');
  if (!body) return;
  var open = body.style.display !== 'none';
  body.style.display = open ? 'none' : 'block';
  if (chevron) chevron.style.transform = open ? 'rotate(-90deg)' : 'rotate(0deg)';
}

function renderCtxPerfSection(statsData) {
  if (!statsData || !statsData.methods || !statsData.methods.context_raw) return;
  var ctx = statsData.methods.context_raw;
  if (!ctx) return;

  // ── Hero cards ──────────────────────────────────────────────
  var summary = ctx.summary || {};
  var clv = summary.meanCLV;
  var clvColor = clv == null ? '#66758c' : clv > 1 ? '#6ee7b7' : clv >= 0 ? '#bef264' : '#fbbf24';
  var hitColor = summary.hitRate == null ? '#66758c' : summary.hitRate >= 57 ? '#6ee7b7' : summary.hitRate >= 52 ? '#fbbf24' : '#f87171';

  var cards = [
    { label: 'Context Settled', val: summary.settled != null ? summary.settled : '—', sub: (summary.pending || 0) + ' pending' },
    { label: 'Hit Rate', val: summary.hitRate != null ? summary.hitRate + '%' : '—', sub: (summary.won || 0) + ' / ' + (summary.settled || 0), color: hitColor },
    { label: 'Mean CLV', val: clv != null ? (clv >= 0 ? '+' : '') + clv + '%' : '—',
      sub: 'primary metric', color: clvColor,
      tip: 'CLV = how much tip-time odds beat closing line. Positive = finding value before market moves.' },
    { label: 'O2.5', val: (function() {
        var o = ctx.markets && ctx.markets['over_2.5'];
        return o && o.hitRate != null ? o.hitRate + '%' : '—';
      })(), sub: (function() {
        var o = ctx.markets && ctx.markets['over_2.5'];
        return o ? (o.won || 0) + ' / ' + (o.settled || 0) : '—';
      })() },
  ];

  document.getElementById('ctxPerfCards').innerHTML = cards.map(function(c) {
    return '<div class="perf-hero-cell">' +
      '<div class="ph-label">' + c.label + (c.tip ? ' <span class="ctx-tip" title="' + c.tip + '" style="cursor:help;font-size:10px">ⓘ</span>' : '') + '</div>' +
      '<div class="ph-val" style="' + (c.color ? 'color:' + c.color : '') + '">' + c.val + '</div>' +
      '<div class="ph-sub">' + c.sub + '</div>' +
    '</div>';
  }).join('');

  // ── Agreement breakdown ─────────────────────────────────────
  var agr = ctx.byAgreement || {};
  var agrTypes = [
    { key: 'context_confirms',  label: 'Confirms',  desc: 'Same fixture + direction as Current or Calibrated', color: '#6ee7b7' },
    { key: 'context_disagrees', label: 'Disagrees', desc: 'Same fixture, opposite direction to Current/Calibrated', color: '#fbbf24' },
    { key: 'context_only',      label: 'Context only', desc: 'No Current/Calibrated for this fixture', color: '#818cf8' },
  ];
  document.getElementById('ctxPerfAgreement').innerHTML = agrTypes.map(function(t) {
    var d = agr[t.key] || {};
    var hr = d.hitRate != null ? d.hitRate + '%' : '—';
    var clv = d.meanCLV != null ? (d.meanCLV >= 0 ? '+' : '') + d.meanCLV + '%' : '—';
    var clvColor = d.meanCLV == null ? '#66758c' : d.meanCLV > 1 ? '#6ee7b7' : d.meanCLV >= 0 ? '#bef264' : '#f87171';
    return '<div style="display:flex;align-items:center;gap:16px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.05)">' +
      '<div style="width:10px;height:10px;border-radius:50%;background:' + t.color + ';flex-shrink:0"></div>' +
      '<div style="flex:1">' +
        '<div style="font-size:13px;font-weight:600;color:#e2e8f0">' + t.label + '</div>' +
        '<div style="font-size:11px;color:#66758c;margin-top:2px">' + t.desc + '</div>' +
      '</div>' +
      '<div style="text-align:right;min-width:80px">' +
        '<div style="font-size:12px;color:#94a3b8">' + (d.settled || 0) + ' settled · ' + hr + '</div>' +
        '<div style="font-size:11px;color:' + clvColor + '">CLV ' + clv + '</div>' +
      '</div>' +
    '</div>';
  }).join('');

  // ── By league ───────────────────────────────────────────────
  var byLeague = ctx.byLeague || {};
  var LEAGUE_NAMES = { england: 'England (EPL)', germany: 'Germany (BL1)' };
  document.getElementById('ctxPerfByLeague').innerHTML = Object.entries(byLeague).map(function(entry) {
    var slug = entry[0], d = entry[1];
    var hr = d.hitRate != null ? d.hitRate + '%' : '—';
    var clv = d.meanCLV != null ? (d.meanCLV >= 0 ? '+' : '') + d.meanCLV + '%' : '—';
    var clvColor = d.meanCLV == null ? '#66758c' : d.meanCLV > 1 ? '#6ee7b7' : d.meanCLV >= 0 ? '#bef264' : '#f87171';
    return '<div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid rgba(255,255,255,.05)">' +
      '<div style="font-size:13px;color:#e2e8f0">' + (LEAGUE_NAMES[slug] || slug) + '</div>' +
      '<div style="text-align:right">' +
        '<div style="font-size:12px;color:#94a3b8">' + (d.settled || 0) + ' · ' + hr + '</div>' +
        '<div style="font-size:11px;color:' + clvColor + '">CLV ' + clv + '</div>' +
      '</div>' +
    '</div>';
  }).join('') || '<div style="color:#66758c;font-size:12px">No data yet</div>';

  // ── By grade ────────────────────────────────────────────────
  var byGrade = ctx.byGrade || {};
  document.getElementById('ctxPerfByGrade').innerHTML = ['A+', 'A', 'B'].map(function(g) {
    var d = byGrade[g] || {};
    var hr = d.hitRate != null ? d.hitRate + '%' : '—';
    var clv = d.meanCLV != null ? (d.meanCLV >= 0 ? '+' : '') + d.meanCLV + '%' : '—';
    var clvColor = d.meanCLV == null ? '#66758c' : d.meanCLV > 1 ? '#6ee7b7' : d.meanCLV >= 0 ? '#bef264' : '#f87171';
    return '<div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid rgba(255,255,255,.05)">' +
      '<div><span class="badge ' + gradeClass(g) + '" style="font-size:11px;padding:3px 9px">' + g + '</span></div>' +
      '<div style="text-align:right">' +
        '<div style="font-size:12px;color:#94a3b8">' + (d.settled || 0) + ' · ' + hr + '</div>' +
        '<div style="font-size:11px;color:' + clvColor + '">CLV ' + clv + '</div>' +
      '</div>' +
    '</div>';
  }).join('');

  // ── Market panels ───────────────────────────────────────────
  var markets = ctx.markets || {};
  function ctxMktPanel(label, m, isUnvalidated) {
    var hitCls = m.hitRate >= 55 ? 'green' : m.hitRate >= 45 ? 'amber' : 'red';
    var hitColor = m.hitRate >= 55 ? '#6ee7b7' : m.hitRate >= 45 ? '#fbbf24' : '#f87171';
    return '<div class="pmc-head">' +
        '<div class="pmc-title">' + label + ' <em>' + (m.total || 0) + ' predictions</em>' +
          (isUnvalidated ? ' <span style="font-size:10px;color:#fbbf24;font-weight:600">UNVALIDATED</span>' : '') +
        '</div>' +
        '<div class="pmc-pending">' + (m.pending || 0) + ' pending</div>' +
      '</div>' +
      '<div class="pmc-body">' +
        '<div class="pmc-stat">' +
          '<div class="pmc-stat-lbl">Hit Rate</div>' +
          '<div class="pmc-stat-val ' + (m.hitRate != null ? hitCls : '') + '">' + (m.hitRate != null ? m.hitRate + '%' : '—') + '</div>' +
          '<div class="hit-bar"><div class="hit-fill" style="width:' + (m.hitRate || 0) + '%;background:' + hitColor + '"></div></div>' +
          '<div class="pmc-stat-sub">' + (m.won || 0) + ' of ' + (m.settled || 0) + ' settled</div>' +
        '</div>' +
        '<div class="pmc-rows">' +
          '<div class="pmc-row"><div class="pmc-row-lbl">Mean CLV</div><div class="pmc-row-val ' + (m.meanCLV > 0 ? 'g' : '') + '">' + (m.meanCLV != null ? (m.meanCLV > 0 ? '+' : '') + m.meanCLV + '%' : '—') + '</div></div>' +
          '<div class="pmc-row"><div class="pmc-row-lbl">Mean edge</div><div class="pmc-row-val">' + (m.meanEdge != null ? (m.meanEdge > 0 ? '+' : '') + m.meanEdge + '%' : '—') + '</div></div>' +
          '<div class="pmc-row"><div class="pmc-row-lbl">Brier score</div><div class="pmc-row-val ' + (m.brierScore != null ? (m.brierScore < 0.22 ? 'g' : m.brierScore < 0.26 ? '' : 'r') : '') + '">' + (m.brierScore != null ? m.brierScore : '—') + '</div></div>' +
          '<div class="pmc-row"><div class="pmc-row-lbl">ROI</div><div class="pmc-row-val ' + ((m.roi || 0) >= 0 ? 'g' : 'r') + '">' + (m.roi != null ? (m.roi > 0 ? '+' : '') + m.roi + '%' : '—') + '</div></div>' +
        '</div>' +
      '</div>' +
      (isUnvalidated ? '<div class="pmc-warn">⚠ U2.5 signal not validated — see Stage 8 report. Track CLV only at this stage.</div>' : '') +
      ((m.settled || 0) < 20 ? '<div class="pmc-warn">⚠ Only ' + (m.settled || 0) + ' settled. Sample too small — CLV trend over hit rate.</div>' : '');
  }

  var mktGrid = document.getElementById('ctxPerfMarkets');
  if (mktGrid) {
    mktGrid.innerHTML =
      '<div class="perf-mkt-card">' + ctxMktPanel('Over 2.5 Goals',  markets['over_2.5']  || {}, false) + '</div>' +
      '<div class="perf-mkt-card">' + ctxMktPanel('Under 2.5 Goals', markets['under_2.5'] || {}, true)  + '</div>';
  }

  // ── Settled table ───────────────────────────────────────────
  var rows = ctx.recentSettled || [];
  var tbody = document.getElementById('ctxPerfTableBody');
  if (!tbody) return;

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="12" style="text-align:center;padding:2rem;color:#8b9ab0;font-size:13px">No settled context predictions yet.</td></tr>';
    return;
  }

  var AGR_LABELS = { context_confirms: 'Confirms', context_disagrees: 'Disagrees', context_only: 'Only' };
  var AGR_COLORS = { context_confirms: '#6ee7b7', context_disagrees: '#fbbf24', context_only: '#818cf8' };

  tbody.innerHTML = rows.map(function(p) {
    var grade = p.context_grade || '—';
    var dir = p.direction || (p.market === 'under_2.5' ? 'u25' : 'o25');
    var isU25 = dir === 'u25';
    var edgeStr = p.edge != null ? '<span style="color:' + edgeColor(p.edge) + '">' + (p.edge > 0 ? '+' : '') + p.edge.toFixed(1) + '%</span>' : '—';
    var clvStr  = p.clvPct != null ? '<span style="color:' + clvColor(p.clvPct) + '">' + (p.clvPct > 0 ? '+' : '') + p.clvPct.toFixed(1) + '%</span>' : '—';
    var agrLabel = AGR_LABELS[p.selectionType] || '—';
    var agrCol   = AGR_COLORS[p.selectionType] || '#66758c';
    var resultBadge = p.status === 'settled_won'
      ? '<span style="color:#6ee7b7;font-weight:700">✓ Won</span>'
      : p.status === 'settled_lost'
        ? '<span style="color:#f87171;font-weight:700">✗ Lost</span>'
        : '—';

    return '<tr>' +
      '<td style="color:#66758c;font-size:11px">' + (p.predictionDate || '—') + '</td>' +
      '<td>' + (p.homeTeam || '') + ' vs ' + (p.awayTeam || '') + '</td>' +
      '<td><span class="badge ' + gradeClass(grade) + '" style="font-size:10px;padding:3px 7px">' + grade + '</span></td>' +
      '<td><span class="dir-badge ' + (isU25 ? 'dir-u25' : 'dir-o25') + '" style="font-size:10px;padding:3px 7px">' + (isU25 ? 'U2.5' : 'O2.5') + '</span>' + (isU25 ? ' <span style="font-size:9px;color:#fbbf24" title="U2.5 unvalidated">⚠</span>' : '') + '</td>' +
      '<td><span style="font-size:11px;color:' + agrCol + ';font-weight:600">' + agrLabel + '</span></td>' +
      '<td style="text-align:right;font-weight:700">' + fmtProbPct(p.modelProbability) + '</td>' +
      '<td style="text-align:right;color:#c4b5fd">' + fmtVal(p.marketOdds) + '</td>' +
      '<td style="text-align:right">' + edgeStr + '</td>' +
      '<td style="text-align:right;color:#66758c">' + fmtVal(p.closingOdds) + '</td>' +
      '<td style="text-align:right">' + clvStr + '</td>' +
      '<td style="text-align:center;color:#67e8f9;font-weight:700">' + (p.result || '—') + '</td>' +
      '<td style="text-align:center">' + resultBadge + '</td>' +
    '</tr>';
  }).join('');
}

"""

# Insert just before the final </script>
last_script_end = content.rfind('</script>')
if last_script_end == -1:
    print("JS change FAILED: no </script> found")
    sys.exit(1)

content = content[:last_script_end] + JS_TO_INSERT + content[last_script_end:]
print("JS change applied: renderCtxPerfSection() inserted")

# ── Hook renderCtxPerfSection into loadPerformance() ──────────
# After renderPerformance(statsData) is called in loadPerformance(),
# also call renderCtxPerfSection(statsData).
OLD_RENDER = "    renderPerformance(statsData);\n  } catch (e) {"
NEW_RENDER = "    renderPerformance(statsData);\n    renderCtxPerfSection(statsData);\n  } catch (e) {"

if OLD_RENDER in content:
    content = content.replace(OLD_RENDER, NEW_RENDER, 1)
    print("JS hook applied: renderCtxPerfSection() called in loadPerformance()")
else:
    print("JS hook FAILED"); sys.exit(1)

if content != original:
    backup = str(TARGET) + '.bak-ctx-perf'
    shutil.copy(TARGET, backup)
    print(f"Backup: {backup}")
    TARGET.write_text(content, encoding='utf-8')
    print(f"Written: {TARGET}")
