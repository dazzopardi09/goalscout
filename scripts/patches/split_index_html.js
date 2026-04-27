// scripts/patches/split_index_html.js
// ─────────────────────────────────────────────────────────────
// Refactor public/index.html into three separate files:
//
//   public/index.html   — pure HTML only (~300 lines)
//   public/app.js       — all JavaScript extracted from <script> block
//   public/styles.css   — existing CSS + inline <style> block appended
//
// The inline <style> block contains context-research CSS added after
// styles.css was last updated (ctx-panel, ctx-drawer, ctx-chip etc).
// It is appended to styles.css so there is still only one CSS file.
//
// index.html retains:
//   <link rel="stylesheet" href="styles.css">   (already present)
//   <script src="app.js"></script>               (replaces inline block)
//
// Run on Unraid:
//   node /mnt/user/appdata/goalscout/scripts/patches/split_index_html.js
// ─────────────────────────────────────────────────────────────

'use strict';

const fs   = require('fs');
const path = require('path');

const HTML_PATH = '/mnt/user/appdata/goalscout/public/index.html';
const CSS_PATH  = '/mnt/user/appdata/goalscout/public/styles.css';
const JS_PATH   = '/mnt/user/appdata/goalscout/public/app.js';

if (!fs.existsSync(HTML_PATH)) { console.error('ERROR: index.html not found'); process.exit(1); }
if (!fs.existsSync(CSS_PATH))  { console.error('ERROR: styles.css not found'); process.exit(1); }

let html = fs.readFileSync(HTML_PATH, 'utf8');
let css  = fs.readFileSync(CSS_PATH,  'utf8');

// ── Step 1: Extract inline <style> block ──────────────────────
// Matches everything between <style> and </style> inside <head>
const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
if (!styleMatch) {
  console.error('ERROR: no inline <style> block found in index.html');
  process.exit(1);
}
const inlineCSS = styleMatch[1];
console.log(`Extracted inline CSS: ${inlineCSS.split('\n').length} lines`);

// Remove the inline <style> block from html
html = html.replace(/<style>[\s\S]*?<\/style>\n?/, '');
console.log('Removed inline <style> block from index.html');

// ── Step 2: Extract <script> block ───────────────────────────
// Matches the final large <script>...</script> block
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);
if (!scriptMatch) {
  console.error('ERROR: no inline <script> block found before </body>');
  process.exit(1);
}
const inlineJS = scriptMatch[1];
console.log(`Extracted inline JS: ${inlineJS.split('\n').length} lines`);

// Replace the inline script with an external reference
html = html.replace(
  /<script>[\s\S]*?<\/script>(\s*<\/body>)/,
  '<script src="app.js"></script>$1'
);
console.log('Replaced inline <script> with <script src="app.js"></script>');

// ── Step 3: Write files ───────────────────────────────────────

// Backup originals
fs.copyFileSync(HTML_PATH, HTML_PATH + '.bak-split');
fs.copyFileSync(CSS_PATH,  CSS_PATH  + '.bak-split');
console.log('Backups written');

// Write updated index.html
fs.writeFileSync(HTML_PATH, html, 'utf8');
console.log(`Written: ${HTML_PATH} (${html.split('\n').length} lines)`);

// Append inline CSS to styles.css with a clear separator
const cssAppend =
  '\n\n/* ── Context Research — added inline, moved here ────────────── */\n' +
  inlineCSS.trim() + '\n';
fs.writeFileSync(CSS_PATH, css + cssAppend, 'utf8');
console.log(`Updated: ${CSS_PATH} (+${inlineCSS.split('\n').length} lines)`);

// Write app.js with header comment
const jsHeader =
  '// public/app.js\n' +
  '// ─────────────────────────────────────────────────────────────\n' +
  '// GoalScout v3 — all frontend JavaScript.\n' +
  '// Extracted from index.html inline <script> block.\n' +
  '//\n' +
  '// Sections:\n' +
  '//   State + helpers\n' +
  '//   Shortlist rendering\n' +
  '//   Performance tab (Current / Calibrated / Context)\n' +
  '//   Context Research tab (backtest viewer)\n' +
  '//   Init + polling\n' +
  '// ─────────────────────────────────────────────────────────────\n\n';

fs.writeFileSync(JS_PATH, jsHeader + inlineJS.trim() + '\n', 'utf8');
console.log(`Written: ${JS_PATH} (${inlineJS.split('\n').length} lines)`);

// ── Step 4: Verify index.html no longer has inline blocks ─────
const finalHtml = fs.readFileSync(HTML_PATH, 'utf8');
const hasInlineStyle  = /<style>/.test(finalHtml);
const hasInlineScript = /<script>(?![\s]*src)/.test(finalHtml);

if (hasInlineStyle)  console.warn('WARNING: inline <style> still present in index.html');
if (hasInlineScript) console.warn('WARNING: inline <script> still present in index.html');
if (!hasInlineStyle && !hasInlineScript) {
  console.log('Verified: index.html is clean — no inline style or script blocks');
}

console.log('\nDone. All three files written. Full redeploy required.');