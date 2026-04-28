#!/usr/bin/env python3
"""
Patch 4 of 5: src/engine/history.js
Add suspicious / suspiciousReasons to the inputs block in logPrediction().
These are only written when match.suspicious is truthy — no change to clean records.
"""
import sys

TARGET = '/mnt/user/appdata/goalscout/src/engine/history.js'

content = open(TARGET).read()

if 'suspiciousReasons' in content:
    print('[history] already patched — skipping')
    sys.exit(0)

# The inputs block ends at grade: match.grade ?? null,
# We add the conditional spread immediately after that line.
OLD_INPUTS = """    inputs: {
      homeO25pct: match.home?.o25pct,
      awayO25pct: match.away?.o25pct,
      homeAvgTG:  match.home?.avgTG,
      awayAvgTG:  match.away?.avgTG,
      flagScore:  match.score ?? null,
      grade:      match.grade ?? null,
    },"""

NEW_INPUTS = """    inputs: {
      homeO25pct: match.home?.o25pct,
      awayO25pct: match.away?.o25pct,
      homeAvgTG:  match.home?.avgTG,
      awayAvgTG:  match.away?.avgTG,
      flagScore:  match.score ?? null,
      grade:      match.grade ?? null,
      // Propagated from scraper when suspicious row detection fires.
      // Only present on flagged records — absent on clean records.
      ...(match.suspicious ? {
        suspicious:        true,
        suspiciousReasons: match.suspiciousReasons || [],
      } : {}),
    },"""

if OLD_INPUTS not in content:
    print('[history] ERROR: inputs block anchor not found')
    sys.exit(1)
content = content.replace(OLD_INPUTS, NEW_INPUTS, 1)

open(TARGET, 'w').write(content)
print('[history] suspicious fields added to inputs block OK')
