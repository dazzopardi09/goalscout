#!/usr/bin/env python3
"""
Patch context-predictions.js:
1. logContextPrediction() accepts selectionType as a 5th parameter
2. selectionType is written to the prediction record
3. logContextPredictions() passes item.selectionType when calling logContextPrediction()
"""
import sys, shutil
from pathlib import Path

TARGET = Path('/Volumes/appdata/goalscout/src/engine/context-predictions.js')

if not TARGET.exists():
    print(f"ERROR: {TARGET} not found.")
    sys.exit(1)

content = TARGET.read_text(encoding='utf-8')
original = content

# Change 1: add selectionType parameter to logContextPrediction signature
OLD1 = "function logContextPrediction(match, scored, homeRolling, awayRolling) {"
NEW1 = "function logContextPrediction(match, scored, homeRolling, awayRolling, selectionType) {"

if OLD1 in content:
    content = content.replace(OLD1, NEW1, 1)
    print("Change 1 applied: selectionType parameter added")
else:
    print("Change 1 FAILED"); sys.exit(1)

# Change 2: write selectionType to the record.
# The record currently has method: 'context_raw' near the top.
# We add selectionType right after status: 'pending'.
OLD2 = "    status:               'pending',"
NEW2 = "    status:               'pending',\n    selectionType:        selectionType || null,"

if OLD2 in content:
    content = content.replace(OLD2, NEW2, 1)
    print("Change 2 applied: selectionType written to prediction record")
else:
    print("Change 2 FAILED"); sys.exit(1)

# Change 3: pass item.selectionType in logContextPredictions() batch call
OLD3 = "    logContextPrediction(match, scored, homeRolling, awayRolling);"
NEW3 = "    logContextPrediction(match, scored, homeRolling, awayRolling, item.selectionType || null);"

# But destructuring in the for-loop is: const { match, scored, homeRolling, awayRolling }
# We need to also destructure selectionType from item
OLD_LOOP = "  for (const { match, scored, homeRolling, awayRolling } of items) {"
NEW_LOOP = "  for (const item of items) {\n    const { match, scored, homeRolling, awayRolling } = item;"

if OLD_LOOP in content:
    content = content.replace(OLD_LOOP, NEW_LOOP, 1)
    print("Change 3a applied: loop now uses item destructuring")
else:
    print("Change 3a FAILED"); sys.exit(1)

if OLD3 in content:
    content = content.replace(OLD3, NEW3, 1)
    print("Change 3b applied: selectionType passed to logContextPrediction()")
else:
    print("Change 3b FAILED"); sys.exit(1)

if content != original:
    backup = str(TARGET) + '.bak-ctx-perf'
    shutil.copy(TARGET, backup)
    print(f"Backup: {backup}")
    TARGET.write_text(content, encoding='utf-8')
    print(f"Written: {TARGET}")
