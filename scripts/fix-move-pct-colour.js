#!/usr/bin/env node
// scripts/fix-move-pct-colour.js
// Fixes two bugs in public/index.html:
//   1. Move% colour is inverted — positive should be green (odds shortened = good)
//   2. Footnote text has the sign description backwards
//
// Run from /mnt/user/appdata/goalscout:
//   docker run --rm -v "$(pwd)":/app -w /app goalscout-goalscout node scripts/fix-move-pct-colour.js

const fs = require('fs');
const path = require('path');

const TARGET = path.join(__dirname, '..', 'public', 'index.html');

if (!fs.existsSync(TARGET)) {
  console.error(`ERROR: ${TARGET} not found. Run from /mnt/user/appdata/goalscout`);
  process.exit(1);
}

let content = fs.readFileSync(TARGET, 'utf8');
const original = content;

// ── Fix 1: Move% colour logic in renderPerfTable ─────────────
// Positive Move% = odds shortened = good = GREEN
// Negative Move% = odds drifted   = bad  = RED
const OLD_COLOUR = "p.preKickoffMovePct < 0 ? '#6ee7b7' : p.preKickoffMovePct > 0 ? '#f87171' : '#8b9ab0'";
const NEW_COLOUR = "p.preKickoffMovePct > 0 ? '#6ee7b7' : p.preKickoffMovePct < 0 ? '#f87171' : '#8b9ab0'";

if (content.includes(OLD_COLOUR)) {
  content = content.replace(OLD_COLOUR, NEW_COLOUR);
  console.log('✓ Fix 1 applied: Move% colour — positive now green, negative now red');
} else {
  console.log('⚠ Fix 1 skipped: colour target not found (may already be patched)');
}

// ── Fix 2: Footnote text ─────────────────────────────────────
const OLD_NOTE = 'Negative = odds shortened (market agrees).';
const NEW_NOTE = 'Positive = odds shortened (market agrees).';

if (content.includes(OLD_NOTE)) {
  content = content.replace(OLD_NOTE, NEW_NOTE);
  console.log('✓ Fix 2 applied: footnote text corrected');
} else {
  console.log('⚠ Fix 2 skipped: footnote target not found (may already be patched)');
}

// ── Write ─────────────────────────────────────────────────────
if (content === original) {
  console.log('\nNo changes written — already patched or targets not found.');
} else {
  const backup = TARGET + '.bak4';
  fs.copyFileSync(TARGET, backup);
  console.log(`\nBackup saved: ${backup}`);
  fs.writeFileSync(TARGET, content, 'utf8');
  console.log(`Written: ${TARGET}`);
  console.log('\nRedeploy required:');
  console.log('  docker compose down');
  console.log('  docker rmi goalscout goalscout-goalscout 2>/dev/null || true');
  console.log('  docker builder prune -f');
  console.log('  docker compose up --build -d');
}
