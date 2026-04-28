#!/usr/bin/env python3
"""
Patch 1 of 5: src/config.js
Add SUSPICIOUS_ROWS_FILE path constant to the historical logging section.
"""
import sys

TARGET = '/mnt/user/appdata/goalscout/src/config.js'

OLD = "  CONFLICTS_FILE:       path.join(DATA_DIR, 'history', 'settlement-conflicts.jsonl'),"

NEW = """  CONFLICTS_FILE:       path.join(DATA_DIR, 'history', 'settlement-conflicts.jsonl'),
  SUSPICIOUS_ROWS_FILE: path.join(DATA_DIR, 'history', 'suspicious-rows.jsonl'),"""

content = open(TARGET).read()
if 'SUSPICIOUS_ROWS_FILE' in content:
    print('[config] SUSPICIOUS_ROWS_FILE already present — skipping')
    sys.exit(0)
if OLD not in content:
    print('[config] ERROR: anchor string not found in config.js')
    print('[config] Looking for:', repr(OLD))
    sys.exit(1)
content = content.replace(OLD, NEW, 1)
open(TARGET, 'w').write(content)
print('[config] SUSPICIOUS_ROWS_FILE added OK')
