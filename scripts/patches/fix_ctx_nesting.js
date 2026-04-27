'use strict';
const fs = require('fs');
const path = '/mnt/user/appdata/goalscout/public/index.html';
let c = fs.readFileSync(path, 'utf8');

// The context content div is currently the last child of perfContent.
// We need to move it to be a sibling of perfContent (after it).
// Step 1: remove it from inside perfContent
// Step 2: insert it after the closing </div><!-- /perfContent -->

const CTX_BLOCK =
`\n      <!-- ── Context Model tab content ── -->\n      <div id="ctxPerfContent" style="display:none">`;

// Find the full ctxPerfContent block — from its opening div to its closing comment
const CTX_OPEN = '\n      <!-- ── Context Model tab content ── -->\n      <div id="ctxPerfContent" style="display:none">';
const CTX_CLOSE = '\n      </div><!-- /ctxPerfContent -->';

const OLD_PERF_CLOSE = '\n    </div><!-- /perfContent -->';

// Locate start and end of the context block within the file
const ctxStart = c.indexOf(CTX_OPEN);
const ctxEndTag = c.indexOf(CTX_CLOSE, ctxStart);

if (ctxStart === -1 || ctxEndTag === -1) {
  console.error('FAILED: could not find ctxPerfContent block');
  process.exit(1);
}

// Extract the full context block (including its closing tag)
const ctxBlock = c.slice(ctxStart, ctxEndTag + CTX_CLOSE.length);

// Remove the context block from inside perfContent
c = c.slice(0, ctxStart) + c.slice(ctxEndTag + CTX_CLOSE.length);

// Now insert it after </div><!-- /perfContent -->
if (!c.includes(OLD_PERF_CLOSE)) {
  console.error('FAILED: could not find perfContent closing div');
  process.exit(1);
}

c = c.replace(OLD_PERF_CLOSE, OLD_PERF_CLOSE + '\n' + ctxBlock.trimStart());

console.log('Fix applied: ctxPerfContent moved outside perfContent');

fs.copyFileSync(path, path + '.bak-ctx-nest');
fs.writeFileSync(path, c, 'utf8');
console.log('Written');