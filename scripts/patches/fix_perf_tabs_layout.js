// scripts/patches/fix_perf_tabs_layout.js
// ─────────────────────────────────────────────────────────────
// Two surgical fixes to public/index.html:
//
// 1. Move the Current | Calibrated | Context tab strip OUT of
//    #perfContent so it stays visible when switching to Context
//    (which hides #perfContent).
//
// 2. Restructure #ctxPerfContent so its top matches the
//    Current/Calibrated layout — hero strip → market panels →
//    settled table — with the agreement/league/grade panels
//    moved below as "extras". Context tab now feels consistent
//    with the other two model tabs.
//
// Run on Unraid:  node /mnt/user/appdata/goalscout/scripts/patches/fix_perf_tabs_layout.js
// ─────────────────────────────────────────────────────────────

'use strict';

const fs = require('fs');
const path = '/mnt/user/appdata/goalscout/public/index.html';

if (!fs.existsSync(path)) {
  console.error('ERROR: index.html not found at ' + path);
  process.exit(1);
}

let c = fs.readFileSync(path, 'utf8');
const original = c;

// ── Fix 1: move tab strip out of perfContent ──────────────────
// Currently the tab strip lives inside <div id="perfContent">.
// We remove it from there and insert it just before perfContent
// so it's always visible whenever Performance tab is open.

const TAB_STRIP =
`      <div class="market-tabs" style="margin-bottom:14px">
        <button class="market-tab active" id="perfMethodCurrent" onclick="switchPerfMethod('current')">Current</button>
        <button class="market-tab" id="perfMethodCalibrated" onclick="switchPerfMethod('calibrated')">Calibrated</button>
        <button class="market-tab" id="perfMethodContext" onclick="switchPerfMethod('context_raw')">Context</button>
      </div>`;

// Remove the tab strip from inside perfContent
if (!c.includes(TAB_STRIP)) {
  console.error('Fix 1 FAILED: tab strip not found at expected location');
  process.exit(1);
}
c = c.replace(TAB_STRIP + '\n\n      ', '      ');  // remove and tidy whitespace

// Also remove the hero summary from inside perfContent — it was Current/Calibrated only
// We'll move both the hero strip AND the tab strip outside so they're shared
const HERO_STRIP =
`      <!-- Hero strip -->
      <div class="perf-hero-strip" id="perfSummaryCards"></div>`;

if (!c.includes(HERO_STRIP)) {
  console.error('Fix 1 FAILED: hero strip not found');
  process.exit(1);
}
c = c.replace(HERO_STRIP + '\n\n', '');

// Insert hero + tabs BEFORE <div id="perfContent">
const PERF_CONTENT_OPEN = `    <div id="perfContent" style="display:none">`;
const NEW_HEADER =
`    <!-- Hero strip — shared across all three model tabs -->
    <div class="perf-hero-strip" id="perfSummaryCards"></div>

    <div class="market-tabs" style="margin-bottom:14px">
      <button class="market-tab active" id="perfMethodCurrent" onclick="switchPerfMethod('current')">Current</button>
      <button class="market-tab" id="perfMethodCalibrated" onclick="switchPerfMethod('calibrated')">Calibrated</button>
      <button class="market-tab" id="perfMethodContext" onclick="switchPerfMethod('context_raw')">Context</button>
    </div>

    <div id="perfContent" style="display:none">`;

if (!c.includes(PERF_CONTENT_OPEN)) {
  console.error('Fix 1 FAILED: perfContent open tag not found');
  process.exit(1);
}
c = c.replace(PERF_CONTENT_OPEN, NEW_HEADER);
console.log('Fix 1 done: hero strip + tab strip moved outside perfContent');

// ── Fix 2: restructure ctxPerfContent ─────────────────────────
// New order matches Current/Calibrated layout:
//   1. Market panels (O2.5 / U2.5)            ← was at bottom
//   2. Settled predictions table              ← keep
//   3. Extras: Agreement, By League, By Grade ← was at top
//   4. Footer note                            ← keep

const OLD_CTX =
`      <div id="ctxPerfContent" style="display:none">

          <!-- Hero cards -->
          <div class="perf-hero-strip" id="ctxPerfCards" style="margin-top:10px"></div>

          <!-- CLV note -->
          <div style="font-size:11px;color:#66758c;padding:6px 4px 10px">
            CLV is the primary metric. Hit rate and ROI are shown but interpret with caution — model is uncalibrated and U2.5 signal is unvalidated. England · Germany only.
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
              <strong>context_raw — research model.</strong>
              U2.5 signal unvalidated. CLV accumulates from each settled prediction.
              Agreement type stored at prediction time — reflects shortlist state at the moment of each refresh.
            </div>
          </div>

      </div><!-- /ctxPerfContent -->`;

const NEW_CTX =
`      <div id="ctxPerfContent" style="display:none">

        <!-- Market panels (matches Current/Calibrated layout) -->
        <div class="perf-mkt-grid" id="ctxPerfMarkets"></div>

        <!-- Settled table -->
        <div class="settled-wrap">
          <div class="settled-head-row">
            <div>
              <div class="settled-title">Recent Settled — Context</div>
              <div class="settled-sub">CLV is primary — positive = beat closing line. U2.5 shown with unvalidated marker.</div>
            </div>
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
          <div class="settled-foot">
            CLV is the primary metric for context_raw. Hit rate and ROI shown but interpret with caution — model is uncalibrated, U2.5 signal unvalidated. England · Germany only.
          </div>
        </div>

        <!-- Extras: agreement / league / grade breakdowns -->
        <div class="settled-wrap" style="margin-top:14px">
          <div style="padding:10px 14px;border-bottom:1px solid rgba(255,255,255,.08)">
            <div class="settled-title">Agreement with Current / Calibrated</div>
            <div class="settled-sub">Direction-aware. Stored at prediction time.</div>
          </div>
          <div id="ctxPerfAgreement" style="padding:14px"></div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:14px">
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

        <!-- Hidden hero card placeholder (ctxPerfCards still referenced by JS — keep as no-op) -->
        <div id="ctxPerfCards" style="display:none"></div>

        <div class="ctx-phase-note" style="margin-top:14px">
          <div class="ctx-phase-dot"></div>
          <div>
            <strong>context_raw — research model.</strong>
            U2.5 signal unvalidated. CLV accumulates from each settled prediction.
            Agreement type stored at prediction time — reflects shortlist state at the moment of each refresh.
          </div>
        </div>

      </div><!-- /ctxPerfContent -->`;

if (!c.includes(OLD_CTX)) {
  console.error('Fix 2 FAILED: ctxPerfContent block not found');
  process.exit(1);
}
c = c.replace(OLD_CTX, NEW_CTX);
console.log('Fix 2 done: ctxPerfContent layout restructured');

// ── Fix 3: also need to update renderCtxPerfSection ───────────
// Hero cards used to render into #ctxPerfCards. We've hidden that div.
// Since the shared #perfSummaryCards now lives outside perfContent and
// is updated only by renderPerformance, we need renderCtxPerfSection to
// also update it with context-relevant cards.

const OLD_CTX_CARDS_RENDER =
`  document.getElementById('ctxPerfCards').innerHTML = cards.map(function(c) {
    return '<div class="perf-hero-cell">' +
      '<div class="ph-label">' + c.label + (c.tip ? ' <span class="ctx-tip" title="' + c.tip + '" style="cursor:help;font-size:10px">ⓘ</span>' : '') + '</div>' +
      '<div class="ph-val" style="' + (c.color ? 'color:' + c.color : '') + '">' + c.val + '</div>' +
      '<div class="ph-sub">' + c.sub + '</div>' +
    '</div>';
  }).join('');`;

const NEW_CTX_CARDS_RENDER =
`  // Render to the shared summary strip (perfSummaryCards) so the top
  // of the page looks consistent with Current/Calibrated.
  document.getElementById('perfSummaryCards').innerHTML = cards.map(function(c) {
    return '<div class="perf-hero-cell">' +
      '<div class="ph-label">' + c.label + (c.tip ? ' <span class="ctx-tip" title="' + c.tip + '" style="cursor:help;font-size:10px">ⓘ</span>' : '') + '</div>' +
      '<div class="ph-val" style="' + (c.color ? 'color:' + c.color : '') + '">' + c.val + '</div>' +
      '<div class="ph-sub">' + c.sub + '</div>' +
    '</div>';
  }).join('');`;

if (!c.includes(OLD_CTX_CARDS_RENDER)) {
  console.error('Fix 3 FAILED: ctxPerfCards render block not found');
  process.exit(1);
}
c = c.replace(OLD_CTX_CARDS_RENDER, NEW_CTX_CARDS_RENDER);
console.log('Fix 3 done: context hero cards now render into shared perfSummaryCards');

// ── Write ──────────────────────────────────────────────────────
if (c === original) {
  console.error('ERROR: no changes made');
  process.exit(1);
}

fs.copyFileSync(path, path + '.bak-perf-layout');
fs.writeFileSync(path, c, 'utf8');
console.log('Done — written. Backup: ' + path + '.bak-perf-layout');