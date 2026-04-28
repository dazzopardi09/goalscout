#!/usr/bin/env python3
"""
Patch 3 of 5: src/scrapers/orchestrator.js
- Destructure suspiciousRows from scrapeMatchesPage()
- Add suspiciousRowsFound to META_FILE write
"""
import sys

TARGET = '/mnt/user/appdata/goalscout/src/scrapers/orchestrator.js'

content = open(TARGET).read()

if 'suspiciousRowsFound' in content:
    print('[orchestrator] already patched — skipping')
    sys.exit(0)

# ── Step 1: Destructure suspiciousRows from scrapeMatchesPage ────
OLD_SCRAPE = "    const { matches: todayMatches, leagueSlugs: todaySlugs } = await scrapeMatchesPage(1);"
NEW_SCRAPE = "    const { matches: todayMatches, leagueSlugs: todaySlugs, suspiciousRows: suspiciousRowsFound } = await scrapeMatchesPage(1);"

if OLD_SCRAPE not in content:
    print('[orchestrator] ERROR: scrapeMatchesPage destructure anchor not found')
    sys.exit(1)
content = content.replace(OLD_SCRAPE, NEW_SCRAPE, 1)

# ── Step 2: Add suspiciousRowsFound to META_FILE write ───────────
OLD_META = """      leagueStatsFound:             Object.keys(leagueStatsMap).length,
    });"""
NEW_META = """      leagueStatsFound:             Object.keys(leagueStatsMap).length,
      suspiciousRowsFound:          suspiciousRowsFound || 0,
    });"""

if OLD_META not in content:
    print('[orchestrator] ERROR: META_FILE write anchor not found')
    sys.exit(1)
content = content.replace(OLD_META, NEW_META, 1)

open(TARGET, 'w').write(content)
print('[orchestrator] all changes applied OK')
