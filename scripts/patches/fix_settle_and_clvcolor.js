// scripts/patches/fix_settle_and_clvcolor.js
// ─────────────────────────────────────────────────────────────
// Two fixes:
//
// Fix 1 — app.js: clvColor is a global function but renderCtxPerfSection
// declares local `var clvColor = '#hex'` variables that shadow it, causing
// "clvColor is not a function" on line ~2023 when the settled table tries
// to call clvColor(p.clvPct).
// Solution: rename the local colour variables inside renderCtxPerfSection
// from clvColor → ctxClvCol (unique name that cannot clash).
//
// Fix 2 — routes.js: POST /api/settle and POST /api/pre-kickoff are
// documented endpoints but were never added to routes.js, causing 404.
//
// Run on Unraid:
//   node /mnt/user/appdata/goalscout/scripts/patches/fix_settle_and_clvcolor.js
// ─────────────────────────────────────────────────────────────

'use strict';
const fs = require('fs');

// ── Fix 1: app.js — rename local clvColor vars in renderCtxPerfSection ──

const APP = '/mnt/user/appdata/goalscout/public/app.js';
if (!fs.existsSync(APP)) { console.error('ERROR: app.js not found'); process.exit(1); }

let app = fs.readFileSync(APP, 'utf8');

// Find the renderCtxPerfSection function and only operate inside it.
// We do this by locating the function start and replacing only within that block.
const FN_START = 'function renderCtxPerfSection(statsData) {';
const fnIdx = app.indexOf(FN_START);
if (fnIdx === -1) { console.error('Fix 1 FAILED: renderCtxPerfSection not found'); process.exit(1); }

// Extract from function start to end of file, do replacements, splice back.
const before = app.slice(0, fnIdx);
let fnBlock  = app.slice(fnIdx);

// Count before
const localsBefore = (fnBlock.match(/var clvColor = /g) || []).length;

// Rename local var declarations: `var clvColor = ` → `var ctxClvCol = `
fnBlock = fnBlock.replace(/var clvColor = /g, 'var ctxClvCol = ');

// Rename usages in string concat that are NOT function calls:
// Pattern: + clvColor + (not followed by open paren)
// We use a negative lookahead for `(`
fnBlock = fnBlock.replace(/\bclvColor\b(?!\s*[\(=])/g, 'ctxClvCol');

// Verify global function definition is in `before` (not in fnBlock) — safety check
const globalFnInBefore = before.includes('function clvColor(');
const globalFnInBlock  = fnBlock.includes('function clvColor(');

console.log(`Fix 1: ${localsBefore} local clvColor declarations renamed`);
console.log(`  Global clvColor() function in header: ${globalFnInBefore} (should be true)`);
console.log(`  Global clvColor() function in renderCtxPerfSection: ${globalFnInBlock} (should be false)`);

if (!globalFnInBefore) {
  console.error('Fix 1 FAILED: global clvColor function not found before renderCtxPerfSection — aborting');
  process.exit(1);
}

app = before + fnBlock;

// Final check: no `var ctxClvCol` should appear outside the function (it shouldn't)
const globalLeaks = (before.match(/ctxClvCol/g) || []).length;
if (globalLeaks > 0) {
  console.error(`Fix 1 WARNING: ctxClvCol appears ${globalLeaks} times before renderCtxPerfSection — check manually`);
}

fs.copyFileSync(APP, APP + '.bak-fix2');
fs.writeFileSync(APP, app, 'utf8');
console.log(`Fix 1 done: written ${APP}`);

// ── Fix 2: routes.js — add missing POST /settle and POST /pre-kickoff ──

const ROUTES = '/mnt/user/appdata/goalscout/src/api/routes.js';
if (!fs.existsSync(ROUTES)) { console.error('ERROR: routes.js not found'); process.exit(1); }

let routes = fs.readFileSync(ROUTES, 'utf8');

if (routes.includes("router.post('/settle'")) {
  console.log('Fix 2: /settle route already exists — skipping');
} else {
  const INSERT_AFTER = `  res.json({ message: 'Refresh started', status: 'running' });
});`;

  if (!routes.includes(INSERT_AFTER)) {
    console.error('Fix 2 FAILED: refresh route end-marker not found in routes.js');
    process.exit(1);
  }

  const NEW_ROUTES = `
// ── Manual settlement sweep ─────────────────────────────────

router.post('/settle', async (req, res) => {
  try {
    const { fetchScoresAndSettle } = require('../engine/settler');
    const result = await fetchScoresAndSettle();
    res.json({ message: 'Settlement sweep complete', ...result });
  } catch (err) {
    console.error('[api] settlement error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Manual pre-kickoff odds capture ────────────────────────

router.post('/pre-kickoff', async (req, res) => {
  try {
    const { fetchCurrentOddsForPending } = require('../engine/settler');
    await fetchCurrentOddsForPending();
    res.json({ message: 'Pre-kickoff odds capture complete' });
  } catch (err) {
    console.error('[api] pre-kickoff error:', err);
    res.status(500).json({ error: err.message });
  }
});`;

  routes = routes.replace(INSERT_AFTER, INSERT_AFTER + NEW_ROUTES);
  fs.copyFileSync(ROUTES, ROUTES + '.bak-fix2');
  fs.writeFileSync(ROUTES, routes, 'utf8');
  console.log('Fix 2 done: POST /settle and POST /pre-kickoff added to routes.js');
}

console.log('\nAll fixes applied. Full redeploy required.');