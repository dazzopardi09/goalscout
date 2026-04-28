#!/usr/bin/env python3
"""
patch_shortlist_header.py  (fix/performance-hero-metrics branch)
────────────────────────────────────────────────────────────────
Two-file patch for the shortlist header count/label fix.

Changes:
  public/index.html
    - Add id="statShortlistedLabel" to the static label div

  public/app.js (3 changes)
    1. Add module-level vars: lastRawPickCount, lastUpdatedText
    2. loadStatus() writes to module vars instead of DOM elements
    3. renderShortlist() owns all three DOM writes:
         statShortlisted    — visible merged row count
         statShortlistedLabel — "MATCH SHORTLISTED" / "MATCHES SHORTLISTED"
         statUpdated        — "N model picks · Updated …" or "Updated …"

Rules:
  - No backend changes
  - No shortlist generation / merge / dedup changes
  - No model behaviour changes
  - rawPickCount = data.length for single-model views (no "model picks" shown)
  - rawPickCount = sum of all model arrays for All mode (shown only when != matchCount)

docker run --rm \
  -v /mnt/user/appdata/goalscout:/work \
  python:3.11-slim \
  python /work/scripts/patches/patch_shortlist_header.py
"""

import sys, os

def resolve(candidates):
    t = next((p for p in candidates if os.path.isfile(p)), None)
    if not t:
        print('ERROR: file not found at:')
        for p in candidates: print('  ' + p)
        sys.exit(1)
    return t

HTML = resolve(['/work/public/index.html',
                '/mnt/user/appdata/goalscout/public/index.html'])
JS   = resolve(['/work/public/app.js',
                '/mnt/user/appdata/goalscout/public/app.js'])

print('HTML: ' + HTML)
print('JS:   ' + JS)

with open(HTML) as f: html = f.read()
with open(JS)   as f: js   = f.read()

errors = 0

# ── HTML change: add id to label div ─────────────────────────────────────
OLD_HTML = '        <div class="stats-bar__label">Shortlisted</div>'
NEW_HTML = '        <div class="stats-bar__label" id="statShortlistedLabel">SHORTLISTED</div>'

if html.count(OLD_HTML) != 1:
    print('ERROR: HTML OLD not found uniquely (count={})'.format(html.count(OLD_HTML)))
    errors += 1
else:
    html = html.replace(OLD_HTML, NEW_HTML)
    print('HTML change applied: statShortlistedLabel id added')

# ── JS change 1: add module-level vars after statsMethod declaration ──────
OLD_JS1 = "let statsMethod = 'current';"
NEW_JS1 = """let statsMethod = 'current';
// Shortlist header state — owned by renderShortlist(), populated by loadStatus()
var lastRawPickCount = null;
var lastUpdatedText  = '\u2014';"""

if js.count(OLD_JS1) != 1:
    print('ERROR: JS OLD1 not found uniquely (count={})'.format(js.count(OLD_JS1)))
    errors += 1
else:
    js = js.replace(OLD_JS1, NEW_JS1)
    print('JS change 1 applied: module vars added')

# ── JS change 2: loadStatus() writes to module vars, not DOM ─────────────
OLD_JS2 = """    if (d.meta) {
      document.getElementById('statShortlisted').textContent = d.meta.shortlistCount || '\u2014';
      if (d.meta.lastRefresh) {
        var dt = new Date(d.meta.lastRefresh);
        document.getElementById('statUpdated').textContent =
          'Updated ' +
          dt.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', timeZone: 'Australia/Melbourne' }) +
          ' \u00b7 ' +
          dt.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', timeZone: 'Australia/Melbourne' }) +
          ' AEST';
      }
    }"""

NEW_JS2 = """    if (d.meta) {
      // Store raw backend pick count — renderShortlist() uses this for secondary text.
      // Do NOT write statShortlisted here: renderShortlist() owns that element and
      // knows the merged/filtered visible count. Writing here would overwrite the
      // correct merged count on every status poll.
      lastRawPickCount = d.meta.shortlistCount != null ? d.meta.shortlistCount : null;
      if (d.meta.lastRefresh) {
        var dt = new Date(d.meta.lastRefresh);
        lastUpdatedText =
          'Updated ' +
          dt.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', timeZone: 'Australia/Melbourne' }) +
          ' \u00b7 ' +
          dt.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', timeZone: 'Australia/Melbourne' }) +
          ' AEST';
        // Still write statUpdated immediately so it shows on first load before
        // renderShortlist() has run. renderShortlist() will recompose it with
        // the model-picks prefix when needed.
        document.getElementById('statUpdated').textContent = lastUpdatedText;
      }
    }"""

if js.count(OLD_JS2) != 1:
    print('ERROR: JS OLD2 not found uniquely (count={})'.format(js.count(OLD_JS2)))
    errors += 1
else:
    js = js.replace(OLD_JS2, NEW_JS2)
    print('JS change 2 applied: loadStatus() writes to module vars')

# ── JS change 3: renderShortlist() owns count + label + secondary ─────────
OLD_JS3 = "  document.getElementById('statShortlisted').textContent = data.length;"

NEW_JS3 = """  // Visible match count — merged rows after All-mode dedup and current filter.
  var matchCount = data.length;

  // Raw model pick count — only meaningful in All mode when the merge
  // collapses multiple model picks into fewer visible rows.
  // For single-model views, rawPickCount === matchCount so no secondary shown.
  var rawPickCount = filters.method === 'all'
    ? (shortlistData.current?.length     || 0) +
      (shortlistData.calibrated?.length  || 0) +
      (shortlistData.context_raw?.length || 0)
    : matchCount;

  document.getElementById('statShortlisted').textContent = matchCount;
  document.getElementById('statShortlistedLabel').textContent =
    matchCount === 1 ? 'MATCH SHORTLISTED' : 'MATCHES SHORTLISTED';

  // Secondary text: prepend model-picks count only in All mode when it
  // differs from visible count (i.e. merging collapsed some rows).
  var updatedEl = document.getElementById('statUpdated');
  if (filters.method === 'all' && rawPickCount !== matchCount && rawPickCount > 0) {
    updatedEl.textContent =
      rawPickCount + ' model pick' + (rawPickCount === 1 ? '' : 's') +
      ' \u00b7 ' + lastUpdatedText;
  } else {
    updatedEl.textContent = lastUpdatedText;
  }"""

if js.count(OLD_JS3) != 1:
    print('ERROR: JS OLD3 not found uniquely (count={})'.format(js.count(OLD_JS3)))
    errors += 1
else:
    js = js.replace(OLD_JS3, NEW_JS3)
    print('JS change 3 applied: renderShortlist() owns all header DOM writes')

if errors:
    print('\n{} error(s) — files NOT written'.format(errors))
    sys.exit(1)

with open(HTML, 'w') as f: f.write(html)
with open(JS,   'w') as f: f.write(js)

print('\nAll changes applied.')
print('')
print('Verify with:')
print('  grep -n "statShortlistedLabel" ' + HTML)
print('  grep -n "lastRawPickCount\\|lastUpdatedText\\|MATCH SHORTLISTED" ' + JS + ' | head -12')
print('  grep -n "statShortlisted.*shortlistCount" ' + JS)
print('  # last grep should return 0 (loadStatus no longer writes statShortlisted)')
