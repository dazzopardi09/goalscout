#!/usr/bin/env python3
import sys, shutil
from pathlib import Path

TARGET = Path('/Volumes/appdata/goalscout/src/scrapers/orchestrator.js')
if not TARGET.exists():
    print(f"ERROR: {TARGET} not found."); sys.exit(1)

content = TARGET.read_text(encoding='utf-8')
original = content

# The broken line: item.selectionType doesn't exist in the .map() scope.
# Fix: build a lookup map before the .map() and read from it instead.

OLD = """        contextShortlisted = contextItems
          .filter(i => !i.scored.skip)
          .map(({ match, scored: ctxScored, homeRolling, awayRolling }) => {"""

NEW = """        // Build selectionType lookup keyed by fixtureId+direction for use inside .map()
        const ctxSelectionTypeMap = new Map();
        for (const i of contextItems) {
          if (!i.scored.skip && i.selectionType) {
            ctxSelectionTypeMap.set(i.match.id + '__' + (i.scored.direction || 'none'), i.selectionType);
          }
        }

        contextShortlisted = contextItems
          .filter(i => !i.scored.skip)
          .map(({ match, scored: ctxScored, homeRolling, awayRolling }) => {"""

if OLD in content:
    content = content.replace(OLD, NEW, 1)
    print("✓ Fix applied: ctxSelectionTypeMap built before .map()")
else:
    print("FAILED: target not found"); sys.exit(1)

# Now fix the broken item.selectionType reference inside the .map()
OLD2 = "              selectionType: item.selectionType || null,"
NEW2 = "              selectionType: ctxSelectionTypeMap.get(match.id + '__' + (ctxScored.direction || 'none')) || null,"

if OLD2 in content:
    content = content.replace(OLD2, NEW2, 1)
    print("✓ Fix applied: selectionType lookup from ctxSelectionTypeMap")
else:
    print("FAILED: item.selectionType reference not found"); sys.exit(1)

if content != original:
    backup = str(TARGET) + '.bak-hotfix1'
    shutil.copy(TARGET, backup)
    TARGET.write_text(content, encoding='utf-8')
    print(f"Written: {TARGET}")
