'use strict';
// Moves context_raw from a collapsible section at the bottom of Performance
// into a third tab in the model switcher: Current | Calibrated | Context
//
// Three changes:
//   1. HTML: add Context button to the perfMethod tab strip
//   2. HTML: replace the collapsible ctxPerfToggle+ctxPerfBody with a plain
//            ctxPerfContent div (hidden by default, shown when Context tab active)
//   3. JS:   update switchPerfMethod() to handle 'context_raw' and show/hide
//            perfContent vs ctxPerfContent

const fs   = require('fs');
const path = '/mnt/user/appdata/goalscout/public/index.html';

if (!fs.existsSync(path)) {
  console.error('ERROR: index.html not found at ' + path);
  process.exit(1);
}

let c = fs.readFileSync(path, 'utf8');
const original = c;

// ── Change 1: add Context button to the tab strip ─────────────
const OLD1 =
`        <button class="market-tab active" id="perfMethodCurrent" onclick="switchPerfMethod('current')">Current</button>
        <button class="market-tab" id="perfMethodCalibrated" onclick="switchPerfMethod('calibrated')">Calibrated</button>`;

const NEW1 =
`        <button class="market-tab active" id="perfMethodCurrent" onclick="switchPerfMethod('current')">Current</button>
        <button class="market-tab" id="perfMethodCalibrated" onclick="switchPerfMethod('calibrated')">Calibrated</button>
        <button class="market-tab" id="perfMethodContext" onclick="switchPerfMethod('context_raw')">Context</button>`;

if (!c.includes(OLD1)) { console.error('Change 1 FAILED: tab strip not found'); process.exit(1); }
c = c.replace(OLD1, NEW1);
console.log('Change 1 applied: Context tab button added');

// ── Change 2: replace collapsible wrapper with plain div ──────
// Remove the toggle button and ctxPerfBody wrapper.
// Replace with a simple ctxPerfContent div that starts hidden.
const OLD2 =
`      <!-- ── Context Model section ── -->
      <div style="margin-top:18px">
        <button id="ctxPerfToggle" onclick="toggleCtxPerfSection()"
          style="display:flex;align-items:center;gap:10px;background:rgba(129,140,248,.08);border:1px solid rgba(129,140,248,.2);border-radius:14px;padding:12px 18px;cursor:pointer;font-family:inherit;color:#818cf8;font-size:13px;font-weight:600;width:100%;text-align:left">
          <span id="ctxPerfChevron" style="transition:transform .2s;display:inline-block">▾</span>
          Context Model — Paper Tracking
          <span style="margin-left:auto;font-size:10px;font-weight:400;color:#4f5a8a;letter-spacing:.1em;text-transform:uppercase">England · Germany · Uncalibrated</span>
        </button>
        <div id="ctxPerfBody" style="display:block">`;

const NEW2 =
`      <!-- ── Context Model tab content ── -->
      <div id="ctxPerfContent" style="display:none">`;

if (!c.includes(OLD2)) { console.error('Change 2 FAILED: collapsible header not found'); process.exit(1); }
c = c.replace(OLD2, NEW2);
console.log('Change 2a applied: collapsible header replaced with plain div');

// Close the wrapper — remove the extra closing divs that belonged to the collapsible
const OLD2B =
`        </div><!-- /ctxPerfBody -->
      </div><!-- /context model section -->`;

const NEW2B = `      </div><!-- /ctxPerfContent -->`;

if (!c.includes(OLD2B)) { console.error('Change 2b FAILED: closing divs not found'); process.exit(1); }
c = c.replace(OLD2B, NEW2B);
console.log('Change 2b applied: closing divs cleaned up');

// Remove "CLV is the primary metric..." note that referenced paper tracking
const OLD2C =
`          <!-- CLV note -->
          <div style="font-size:11px;color:#66758c;padding:6px 4px 10px">
            CLV is the primary metric for context_raw. Hit rate and ROI are shown but interpret differently — model is uncalibrated and U2.5 signal is unvalidated. Accumulating paper predictions before any real-money use.
          </div>`;

const NEW2C =
`          <!-- CLV note -->
          <div style="font-size:11px;color:#66758c;padding:6px 4px 10px">
            CLV is the primary metric. Hit rate and ROI are shown but interpret with caution — model is uncalibrated and U2.5 signal is unvalidated. England · Germany only.
          </div>`;

if (!c.includes(OLD2C)) {
  console.warn('Change 2c WARNING: CLV note not found — skipping (may already be updated)');
} else {
  c = c.replace(OLD2C, NEW2C);
  console.log('Change 2c applied: CLV note updated, paper tracking reference removed');
}

// Remove "paper tracking only" phase note at the bottom of the context section
const OLD2D =
`          <div class="ctx-phase-note" style="margin-top:14px">
            <div class="ctx-phase-dot"></div>
            <div>
              <strong>context_raw — paper tracking only.</strong>
              Not for real-money decisions until Stage 12 (after Stage 11 calibration review with 200+ settled predictions per league).
              CLV accumulates from each settled prediction. Agreement type stored at prediction time — reflects shortlist state at the moment of each refresh.
            </div>
          </div>`;

const NEW2D =
`          <div class="ctx-phase-note" style="margin-top:14px">
            <div class="ctx-phase-dot"></div>
            <div>
              <strong>context_raw — research model.</strong>
              U2.5 signal unvalidated. CLV accumulates from each settled prediction.
              Agreement type stored at prediction time — reflects shortlist state at the moment of each refresh.
            </div>
          </div>`;

if (!c.includes(OLD2D)) {
  console.warn('Change 2d WARNING: phase note not found — skipping');
} else {
  c = c.replace(OLD2D, NEW2D);
  console.log('Change 2d applied: phase note updated, paper tracking reference removed');
}

// ── Change 3: update switchPerfMethod() ───────────────────────
const OLD3 =
`function switchPerfMethod(method) {
  statsMethod = method;
  document.getElementById('perfMethodCurrent').className =
    'market-tab' + (method === 'current' ? ' active' : '');
  document.getElementById('perfMethodCalibrated').className =
    'market-tab' + (method === 'calibrated' ? ' active' : '');

  if (statsData) renderPerformance(statsData);
}`;

const NEW3 =
`function switchPerfMethod(method) {
  statsMethod = method;
  var isCtx = method === 'context_raw';
  document.getElementById('perfMethodCurrent').className =
    'market-tab' + (method === 'current' ? ' active' : '');
  document.getElementById('perfMethodCalibrated').className =
    'market-tab' + (method === 'calibrated' ? ' active' : '');
  document.getElementById('perfMethodContext').className =
    'market-tab' + (isCtx ? ' active' : '');

  // Show the correct content pane
  document.getElementById('perfContent').style.display    = isCtx ? 'none' : '';
  document.getElementById('ctxPerfContent').style.display = isCtx ? '' : 'none';

  if (statsData) {
    if (isCtx) renderCtxPerfSection(statsData);
    else renderPerformance(statsData);
  }
}`;

if (!c.includes(OLD3)) { console.error('Change 3 FAILED: switchPerfMethod not found'); process.exit(1); }
c = c.replace(OLD3, NEW3);
console.log('Change 3 applied: switchPerfMethod handles context_raw tab');

// ── Change 4: loadPerformance — remove duplicate renderCtxPerfSection call ──
// It's now called from switchPerfMethod when Context is active.
// On initial load we only need renderPerformance (Current tab is default).
// renderCtxPerfSection will fire when user clicks Context tab.
const OLD4 =
`    renderPerformance(statsData);
    renderCtxPerfSection(statsData);
  } catch (e) {`;

const NEW4 =
`    renderPerformance(statsData);
  } catch (e) {`;

if (!c.includes(OLD4)) {
  console.warn('Change 4 WARNING: renderCtxPerfSection hook not found in loadPerformance — skipping');
} else {
  c = c.replace(OLD4, NEW4);
  console.log('Change 4 applied: removed eager renderCtxPerfSection from loadPerformance');
}

// ── Write ──────────────────────────────────────────────────────
if (c === original) {
  console.error('ERROR: no changes were made — check targets above');
  process.exit(1);
}

fs.copyFileSync(path, path + '.bak-ctx-tab');
fs.writeFileSync(path, c, 'utf8');
console.log('Done — written to ' + path);
