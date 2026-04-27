#!/usr/bin/env python3
"""
Two-part fix for context_raw prediction records:

Part 1 — Source fix:
  Add `direction` field to the record in context-predictions.js.
  It already stores `context_direction` but history.js, the Performance
  aggregation, and the UI all rely on `direction` for market grouping
  and the id+direction key used in selectionType comparisons.

Part 2 — Backfill:
  Rewrite all existing context_raw records in predictions.jsonl to add:
    - direction:      derived from context_direction
    - selectionType:  null (cannot be reconstructed — shortlist state at
                      original log time is gone for the 2 settled records;
                      the pending record is today but dedup blocked re-log)
  selectionType will be populated correctly on all FUTURE predictions
  once the source fix is deployed. The null backfill is honest — do not
  invent values we cannot verify.
"""
import sys, json, shutil
from pathlib import Path

# ── Part 1: context-predictions.js ────────────────────────────

SRC = Path('/mnt/user/appdata/goalscout/src/engine/context-predictions.js')
if not SRC.exists():
    print(f"ERROR: {SRC} not found")
    sys.exit(1)

content = SRC.read_text(encoding='utf-8')
original_src = content

# Insert `direction` right after `context_direction` in the record.
# Current line in record:
#     context_direction:       direction,
# We add immediately after it:
#     direction:               direction,   // settlement-compatible alias
OLD_DIR = "    context_direction:       direction,"
NEW_DIR = ("    context_direction:       direction,\n"
           "    direction:               direction,   // settlement-compatible alias (o25|u25)")

if OLD_DIR not in content:
    print("ERROR: could not find context_direction field in record — check source manually")
    sys.exit(1)

content = content.replace(OLD_DIR, NEW_DIR, 1)
print("Part 1: direction field added to record")

if content != original_src:
    backup = str(SRC) + '.bak-direction-fix'
    shutil.copy(SRC, backup)
    SRC.write_text(content, encoding='utf-8')
    print(f"  Written: {SRC}")
    print(f"  Backup:  {backup}")
else:
    print("  No change needed (already patched?)")

# ── Part 2: backfill predictions.jsonl ────────────────────────

PREDS = Path('/mnt/user/appdata/goalscout/data/history/predictions.jsonl')
if not PREDS.exists():
    print(f"\nERROR: {PREDS} not found")
    sys.exit(1)

lines = [l for l in PREDS.read_text(encoding='utf-8').splitlines() if l.strip()]
records = []
for i, line in enumerate(lines):
    try:
        records.append(json.loads(line))
    except json.JSONDecodeError as e:
        print(f"ERROR: JSON parse error on line {i+1}: {e}")
        sys.exit(1)

ctx_count   = 0
fixed_dir   = 0
fixed_st    = 0

for r in records:
    if r.get('method') != 'context_raw':
        continue
    ctx_count += 1

    # Fix direction: derive from context_direction if missing
    if r.get('direction') is None and r.get('context_direction'):
        r['direction'] = r['context_direction']
        fixed_dir += 1

    # Fix selectionType: set null if missing (honest — cannot reconstruct)
    if 'selectionType' not in r:
        r['selectionType'] = None
        fixed_st += 1

print(f"\nPart 2: backfill predictions.jsonl")
print(f"  context_raw records found: {ctx_count}")
print(f"  direction field added:     {fixed_dir}")
print(f"  selectionType set null:    {fixed_st}")

if fixed_dir > 0 or fixed_st > 0:
    backup_p = str(PREDS) + '.bak-direction-fix'
    shutil.copy(PREDS, backup_p)
    out = '\n'.join(json.dumps(r, separators=(',', ':')) for r in records) + '\n'
    PREDS.write_text(out, encoding='utf-8')
    print(f"  Written: {PREDS}")
    print(f"  Backup:  {backup_p}")
else:
    print("  No changes needed")

print("\nDone. Deploy sequence required for Part 1 (source change).")
print("Part 2 (backfill) takes effect immediately — no redeploy needed.")
