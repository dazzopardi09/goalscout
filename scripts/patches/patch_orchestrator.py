#!/usr/bin/env python3
"""
Patch orchestrator.js for context_raw Performance support.
Three changes in sequence.
"""
import sys, shutil
from pathlib import Path

TARGET = Path('/Volumes/appdata/goalscout/src/scrapers/orchestrator.js')

if not TARGET.exists():
    print(f"ERROR: {TARGET} not found.")
    sys.exit(1)

content = TARGET.read_text(encoding='utf-8')
original = content

# Change 1: assign selectionType to contextItems BEFORE logContextPredictions()
OLD1 = "          // Logs predictions with calibration fields, deduplication, and status:'pending'.\n          // Filters to England/Germany internally; skips scored.skip === true.\n          logContextPredictions(contextItems);"
NEW1 = """          // Assign selectionType BEFORE logging so it is stored in predictions.jsonl.
          // Direction-aware: key = match.id + '__' + ctxScored.direction.
          // Stored at log time so Performance can group settled results without
          // recomputing historical shortlist state.
          {
            const curDirKeys = new Set(currentShortlisted.map(m => m.id + '__' + (m.direction || 'none')));
            const calDirKeys = new Set(calibratedShortlisted.map(m => m.id + '__' + (m.direction || 'none')));
            const curIds = new Set(currentShortlisted.map(m => m.id));
            const calIds = new Set(calibratedShortlisted.map(m => m.id));
            for (const item of contextItems) {
              if (item.scored.skip) continue;
              const dir = item.scored.direction || 'none';
              const sameKey = item.match.id + '__' + dir;
              if (curDirKeys.has(sameKey) || calDirKeys.has(sameKey)) {
                item.selectionType = 'context_confirms';
              } else if (curIds.has(item.match.id) || calIds.has(item.match.id)) {
                item.selectionType = 'context_disagrees';
              } else {
                item.selectionType = 'context_only';
              }
            }
          }
          // Logs predictions with calibration fields, deduplication, status:'pending',
          // and selectionType. Filters to England/Germany; skips scored.skip === true.
          logContextPredictions(contextItems);"""

if OLD1 in content:
    content = content.replace(OLD1, NEW1, 1)
    print("Change 1 applied: selectionType on contextItems before logContextPredictions()")
else:
    print("Change 1 FAILED - dumping search target for inspection:")
    idx = content.find("logContextPredictions(contextItems)")
    print(repr(content[max(0,idx-200):idx+50]))
    sys.exit(1)

# Change 2: carry selectionType into contextShortlisted .map()
OLD2 = "              awayRollingSnap: awayRolling,\n            };\n          });\n\n        console.log(`[orchestrator] context_raw shortlist: ${contextShortlisted.length} matches`);"
NEW2 = "              awayRollingSnap: awayRolling,\n              selectionType: item.selectionType || null,\n            };\n          });\n\n        console.log(`[orchestrator] context_raw shortlist: ${contextShortlisted.length} matches`);"

if OLD2 in content:
    content = content.replace(OLD2, NEW2, 1)
    print("Change 2 applied: selectionType in contextShortlisted map")
else:
    print("Change 2 FAILED - searching for contextShortlisted map end...")
    idx = content.find("awayRollingSnap: awayRolling")
    print(repr(content[idx:idx+200]))
    sys.exit(1)

# Change 3: extend comparison object
OLD3 = """      comparison: {
        overlapIds: [...currentIds].filter(id => calibratedIds.has(id)),
        currentOnlyIds: [...currentIds].filter(id => !calibratedIds.has(id)),
        calibratedOnlyIds: [...calibratedIds].filter(id => !currentIds.has(id)),
      },"""
NEW3 = """      comparison: {
        overlapIds: [...currentIds].filter(id => calibratedIds.has(id)),
        currentOnlyIds: [...currentIds].filter(id => !calibratedIds.has(id)),
        calibratedOnlyIds: [...calibratedIds].filter(id => !currentIds.has(id)),
        // context_raw overlap fields — direction-aware (key = id + '__' + direction).
        allThreeOverlapIds: contextShortlisted
          .filter(c => {
            const key = c.id + '__' + (c.direction || 'none');
            return currentShortlisted.some(m => m.id + '__' + (m.direction || 'none') === key) &&
                   calibratedShortlisted.some(m => m.id + '__' + (m.direction || 'none') === key);
          })
          .map(c => c.id + '__' + (c.direction || 'none')),
        currentContextOverlapIds: contextShortlisted
          .filter(c => {
            const key = c.id + '__' + (c.direction || 'none');
            return currentShortlisted.some(m => m.id + '__' + (m.direction || 'none') === key);
          })
          .map(c => c.id + '__' + (c.direction || 'none')),
        calibratedContextOverlapIds: contextShortlisted
          .filter(c => {
            const key = c.id + '__' + (c.direction || 'none');
            return calibratedShortlisted.some(m => m.id + '__' + (m.direction || 'none') === key);
          })
          .map(c => c.id + '__' + (c.direction || 'none')),
        contextOnlyIds: contextShortlisted
          .filter(c => c.selectionType === 'context_only')
          .map(c => c.id + '__' + (c.direction || 'none')),
        contextDisagreementIds: contextShortlisted
          .filter(c => c.selectionType === 'context_disagrees')
          .map(c => c.id + '__' + (c.direction || 'none')),
      },"""

if OLD3 in content:
    content = content.replace(OLD3, NEW3, 1)
    print("Change 3 applied: comparison object extended")
else:
    print("Change 3 FAILED")
    sys.exit(1)

if content != original:
    backup = str(TARGET) + '.bak-ctx-perf'
    shutil.copy(TARGET, backup)
    print(f"Backup: {backup}")
    TARGET.write_text(content, encoding='utf-8')
    print(f"Written: {TARGET}")
