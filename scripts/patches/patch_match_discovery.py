#!/usr/bin/env python3
"""
Patch 2 of 5: src/scrapers/match-discovery.js
Add suspicious row detection after match object is built,
before matches.push(match).
Also add fs require at top, add suspiciousRowCount, and change return value.
"""
import sys

TARGET = '/mnt/user/appdata/goalscout/src/scrapers/match-discovery.js'

content = open(TARGET).read()

# ── Guard: already patched? ──────────────────────────────────────
if 'suspiciousRowCount' in content:
    print('[match-discovery] already patched — skipping')
    sys.exit(0)

# ── Step 1: Add fs and config requires at top ────────────────────
OLD_REQUIRES = """const cheerio = require('cheerio');
const { fetchPage } = require('../utils/fetcher');
const { BASE_URL } = require('../config');"""

NEW_REQUIRES = """const cheerio = require('cheerio');
const fs      = require('fs');
const path    = require('path');
const { fetchPage } = require('../utils/fetcher');
const { BASE_URL } = require('../config');
const config  = require('../config');"""

if OLD_REQUIRES not in content:
    print('[match-discovery] ERROR: require block anchor not found')
    sys.exit(1)
content = content.replace(OLD_REQUIRES, NEW_REQUIRES, 1)

# ── Step 2: Add suspiciousRowCount inside scrapeMatchesPage ─────
# Insert after the opening declarations of the function, before the
# $('tr').each block.
OLD_COUNT = """  const matches = [];
  const leagueSlugs = new Set();
  let currentLeague = null;
  let currentLeagueSlug = null;"""

NEW_COUNT = """  const matches = [];
  const leagueSlugs = new Set();
  let currentLeague = null;
  let currentLeagueSlug = null;
  let suspiciousRowCount = 0;"""

if OLD_COUNT not in content:
    print('[match-discovery] ERROR: declarations anchor not found')
    sys.exit(1)
content = content.replace(OLD_COUNT, NEW_COUNT, 1)

# ── Step 3: Insert the suspicious-row checks before matches.push ─
OLD_PUSH = """      // Only add if we got at least some stats
      const hasStats = match.home.o25pct !== null || match.home.btsPct !== null;
      match.hasStats = hasStats;

      matches.push(match);"""

NEW_PUSH = """      // Only add if we got at least some stats
      const hasStats = match.home.o25pct !== null || match.home.btsPct !== null;
      match.hasStats = hasStats;

      // ── Suspicious row detection ────────────────────────────────
      // Checks run after all stats are parsed, before push.
      // No scoring is changed. Suspicious rows are flagged and saved
      // for audit; they continue through the pipeline unchanged.
      {
        const reasons = [];

        // Individual field equality checks
        const o25Same = match.home.o25pct !== null && match.home.o25pct === match.away.o25pct;
        const tgSame  = match.home.avgTG  !== null && match.home.avgTG  === match.away.avgTG;

        if (o25Same) reasons.push('home_away_o25pct_identical');
        if (tgSame)  reasons.push('home_away_avgtg_identical');

        // Composite: both core fields match simultaneously (Cagliari/Atalanta pattern)
        if (o25Same && tgSame) reasons.push('duplicated_core_profile');

        // All non-null numeric fields identical across home/away
        const numFields = ['o25pct', 'avgTG', 'csPct', 'ftsPct', 'winPct'];
        const nonNullFields = numFields.filter(f =>
          match.home[f] !== null && match.away[f] !== null
        );
        if (nonNullFields.length >= 3 &&
            nonNullFields.every(f => match.home[f] === match.away[f])) {
          if (!reasons.includes('duplicated_core_profile')) {
            reasons.push('full_profile_identical');
          } else {
            reasons.push('full_profile_identical');
          }
        }

        // Missing key stats (o25pct or avgTG null — these drive probability)
        if (match.home.o25pct === null) reasons.push('missing_key_stat:homeO25pct');
        if (match.away.o25pct === null) reasons.push('missing_key_stat:awayO25pct');
        if (match.home.avgTG  === null) reasons.push('missing_key_stat:homeAvgTG');
        if (match.away.avgTG  === null) reasons.push('missing_key_stat:awayAvgTG');

        // Unexpected timeIdx (all away offsets would be wrong)
        if (timeIdx !== 11) reasons.push(`unexpected_timeidx:${timeIdx}`);

        if (reasons.length > 0) {
          // Determine severity
          const hasCritical = reasons.some(r =>
            r === 'full_profile_identical' || r.startsWith('unexpected_timeidx')
          );
          const hasHigh = reasons.some(r =>
            r === 'duplicated_core_profile' || r.startsWith('missing_key_stat')
          );
          const severity = hasCritical ? 'critical' : hasHigh ? 'high'
            : (reasons.includes('home_away_avgtg_identical') ? 'medium' : 'info');

          // Build fingerprint
          const fingerprint = [
            match.id,
            new Date().toISOString().slice(0, 10),
            ...reasons.slice().sort(),
          ].join('|');

          // Snapshot for debug file
          const snapshot = {
            timestamp:   new Date().toISOString(),
            league:      match.league,
            leagueSlug:  match.leagueSlug,
            fixtureId:   match.id,
            homeTeam:    match.homeTeam,
            awayTeam:    match.awayTeam,
            kickoff:     match.kickoff,
            reasons,
            severity,
            timeIdx,
            rawCells:    cellTexts.slice(),
            parsedHome:  { ...match.home },
            parsedAway:  { ...match.away },
            fingerprint,
          };

          // Append to suspicious-rows.jsonl (data/ is mounted, always writable)
          try {
            const dir = path.dirname(config.SUSPICIOUS_ROWS_FILE);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.appendFileSync(
              config.SUSPICIOUS_ROWS_FILE,
              JSON.stringify(snapshot) + '\\n',
              'utf8'
            );
          } catch (writeErr) {
            console.error('[matches] failed to write suspicious-rows snapshot:', writeErr.message);
          }

          // Tag the match object so it propagates to prediction log
          match.suspicious = true;
          match.suspiciousReasons = reasons;

          suspiciousRowCount++;

          console.warn(
            `[matches] SUSPICIOUS ROW [${severity}] ${match.homeTeam} v ${match.awayTeam}` +
            ` (${match.leagueSlug}) — ${reasons.join(', ')}`
          );
        }
      }
      // ── End suspicious row detection ────────────────────────────

      matches.push(match);"""

if OLD_PUSH not in content:
    print('[match-discovery] ERROR: matches.push anchor not found')
    sys.exit(1)
content = content.replace(OLD_PUSH, NEW_PUSH, 1)

# ── Step 4: Change the return value to include suspiciousRows ────
OLD_RETURN = "  return { matches, leagueSlugs: Array.from(leagueSlugs) };"
NEW_RETURN = "  return { matches, leagueSlugs: Array.from(leagueSlugs), suspiciousRows: suspiciousRowCount };"

if OLD_RETURN not in content:
    print('[match-discovery] ERROR: return anchor not found')
    sys.exit(1)
content = content.replace(OLD_RETURN, NEW_RETURN, 1)

open(TARGET, 'w').write(content)
print('[match-discovery] all changes applied OK')
