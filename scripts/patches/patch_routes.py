#!/usr/bin/env python3
"""
Patch 5 of 5: src/api/routes.js
Add GET /api/suspicious-rows endpoint returning last 50 snapshots.
"""
import sys

TARGET = '/mnt/user/appdata/goalscout/src/api/routes.js'

content = open(TARGET).read()

if '/api/suspicious-rows' in content:
    print('[routes] already patched — skipping')
    sys.exit(0)

# Insert the new endpoint just before module.exports = router;
OLD_EXPORTS = "module.exports = router;"

NEW_ENDPOINT = """// ── Suspicious row snapshots ────────────────────────────────
//
// Returns the last 50 entries from data/history/suspicious-rows.jsonl.
// Each entry is a raw-cell snapshot of a scraper row that triggered one
// or more data-integrity checks. Returns [] if the file does not exist yet.

router.get('/suspicious-rows', (req, res) => {
  if (!fs.existsSync(config.SUSPICIOUS_ROWS_FILE)) {
    return res.json([]);
  }
  try {
    const raw   = fs.readFileSync(config.SUSPICIOUS_ROWS_FILE, 'utf8');
    const lines = raw.split('\\n').filter(l => l.trim());
    const rows  = lines.map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
    // Return last 50 entries (most recent)
    res.json(rows.slice(-50));
  } catch (err) {
    console.error('[api] suspicious-rows read error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;"""

if OLD_EXPORTS not in content:
    print('[routes] ERROR: module.exports anchor not found')
    sys.exit(1)
content = content.replace(OLD_EXPORTS, NEW_ENDPOINT, 1)

open(TARGET, 'w').write(content)
print('[routes] /api/suspicious-rows endpoint added OK')
