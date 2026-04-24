#!/usr/bin/env python3
# apply-index-patches.py
# Run this on the Unraid server to patch public/index.html
# Usage: python3 apply-index-patches.py
# Run from: /mnt/user/appdata/goalscout

import re, sys, shutil
from pathlib import Path

TARGET = Path('public/index.html')

if not TARGET.exists():
    print(f"ERROR: {TARGET} not found. Run this from /mnt/user/appdata/goalscout")
    sys.exit(1)

content = TARGET.read_text(encoding='utf-8')
original = content

# ── Patch 1: Default sort → kickoff ascending ─────────────────
# Changes the initial sort from "probability descending" to
# "kickoff ascending" so the shortlist shows soonest matches first.

OLD_SORT = "let currentSort = { key: 'prob', dir: 'desc' };"
NEW_SORT = "let currentSort = { key: 'kickoff', dir: 'asc' };"

if OLD_SORT in content:
    content = content.replace(OLD_SORT, NEW_SORT, 1)
    print("✓ Patch 1 applied: default sort is now kickoff ascending")
else:
    print("⚠ Patch 1 skipped: target string not found (may already be patched)")

# ── Patch 2: getActiveShortlist() — show both rows when models disagree ──
# When viewing "All" models, if current says O2.5 and calibrated says U2.5
# for the same match, both rows now appear instead of only one.

OLD_ACTIVE = """function getActiveShortlist() {
  if (filters.method === 'current') return shortlistData.current || [];
  if (filters.method === 'calibrated') return shortlistData.calibrated || [];

  const map = new Map();

  const combined = [
    ...(shortlistData.current || []),
    ...(shortlistData.calibrated || [])
  ];

  combined.forEach(m => {
    const existing = map.get(m.id);

    // Prefer version WITH odds
    const hasOdds = m.odds && (m.odds.o25 || m.odds.u25);
    const existingHasOdds = existing?.odds && (existing.odds.o25 || existing.odds.u25);

    if (!existing || (!existingHasOdds && hasOdds)) {
      map.set(m.id, m);
    }
  });

  return Array.from(map.values());
}"""

NEW_ACTIVE = """function getActiveShortlist() {
  if (filters.method === 'current') return shortlistData.current || [];
  if (filters.method === 'calibrated') return shortlistData.calibrated || [];

  // Key by fixture+direction so BOTH rows show when models disagree on direction.
  // If both models agree on direction (same fixture+direction), show once,
  // preferring whichever has odds data.
  const map = new Map();

  const combined = [
    ...(shortlistData.current || []),
    ...(shortlistData.calibrated || [])
  ];

  combined.forEach(m => {
    const key = `${m.id}__${m.direction || 'unknown'}`;
    const existing = map.get(key);

    if (!existing) {
      map.set(key, m);
    } else {
      // Same fixture+direction from both models — prefer the one with odds
      const hasOdds = m.odds && (m.odds.o25 || m.odds.u25);
      const existingHasOdds = existing.odds && (existing.odds.o25 || existing.odds.u25);
      if (!existingHasOdds && hasOdds) {
        map.set(key, m);
      }
    }
  });

  return Array.from(map.values());
}"""

if OLD_ACTIVE in content:
    content = content.replace(OLD_ACTIVE, NEW_ACTIVE, 1)
    print("✓ Patch 2 applied: 'All' view now shows separate rows for direction disagreements")
else:
    print("⚠ Patch 2 skipped: target function not found (may already be patched)")
    print("  Check that index.html matches the expected version")

# ── Write result ─────────────────────────────────────────────
if content == original:
    print("\nNo changes written — all patches were already applied or targets not found.")
else:
    backup = TARGET.with_suffix('.html.bak')
    shutil.copy(TARGET, backup)
    print(f"\nBackup saved: {backup}")
    TARGET.write_text(content, encoding='utf-8')
    print(f"Written: {TARGET}")
    print("\nRemember: index.html is baked into the Docker image.")
    print("You must redeploy for changes to take effect:")
    print("  docker compose down")
    print("  docker rmi goalscout goalscout-goalscout 2>/dev/null || true")
    print("  docker builder prune -f")
    print("  docker compose up --build -d")
