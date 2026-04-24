#!/usr/bin/env python3
# apply-date-fix-v2.py
# Restores the -1 hour SoccerSTATS timezone correction that was incorrectly
# removed in the previous patch, while keeping the improved 3-hour threshold
# day-shifting so in-progress matches stay on today's date.
#
# SoccerSTATS shows kickoff times in AEDT (UTC+11) regardless of daylight
# saving state. Subtracting 1 converts to current AEST (UTC+10).
#
# Run from /mnt/user/appdata/goalscout:
#   docker run --rm -v "$(pwd)":/app -w /app python:3-alpine python3 scripts/apply-date-fix-v2.py

import sys, shutil
from pathlib import Path

TARGET = Path('public/index.html')

if not TARGET.exists():
    print(f"ERROR: {TARGET} not found. Run from /mnt/user/appdata/goalscout")
    sys.exit(1)

content = TARGET.read_text(encoding='utf-8')
original = content

# ── What the previous patch left behind ──────────────────────
OLD_NO_OFFSET = """  // SoccerSTATS times are in Melbourne local time. No offset adjustment needed.
  var d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), kp.hour, kp.minute, 0, 0);"""

# ── Correct version: restore -1 with midnight safety ─────────
NEW_WITH_OFFSET = """  // SoccerSTATS displays kickoff times in AEDT (UTC+11) regardless of DST.
  // Subtract 1 hour to convert to current Melbourne time (AEST = UTC+10).
  // The % 24 handles the midnight edge case (00:xx → 23:xx previous hour).
  var h = (kp.hour - 1 + 24) % 24;
  var d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, kp.minute, 0, 0);"""

if OLD_NO_OFFSET in content:
    content = content.replace(OLD_NO_OFFSET, NEW_WITH_OFFSET, 1)
    print("✓ Patch applied: SoccerSTATS -1hr correction restored")
else:
    # Try the original pre-any-patch version as fallback
    OLD_ORIGINAL = "  var d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), kp.hour - 1, kp.minute, 0, 0);"
    if OLD_ORIGINAL in content:
        content = content.replace(OLD_ORIGINAL, NEW_WITH_OFFSET, 1)
        print("✓ Patch applied: replaced original -1 line with safer version")
    else:
        print("⚠ Could not find target line. Check index.html manually.")
        print("  Look for the line with 'kp.hour' inside deriveKickoffDate and")
        print("  replace it with:")
        print("    var h = (kp.hour - 1 + 24) % 24;")
        print("    var d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, kp.minute, 0, 0);")

if content == original:
    print("No changes written.")
else:
    backup = TARGET.with_suffix('.html.bak3')
    shutil.copy(TARGET, backup)
    print(f"Backup saved: {backup}")
    TARGET.write_text(content, encoding='utf-8')
    print(f"Written: {TARGET}")
    print("\nRedeploy required:")
    print("  docker compose down")
    print("  docker rmi goalscout goalscout-goalscout 2>/dev/null || true")
    print("  docker builder prune -f")
    print("  docker compose up --build -d")