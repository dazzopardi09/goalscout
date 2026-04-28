#!/usr/bin/env python3
# scripts/patches/patch_rolling_lookup.py
# ─────────────────────────────────────────────────────────────
# Fixes context_raw team mapping bug: lookupRolling() could
# return a wrong team (e.g. Leeds United FC for Manchester Utd)
# because a single noise token like "united" passed the 0.40
# overlap threshold and the first passing candidate was returned.
#
# Changes:
#   src/utils/team-names.js
#     1A. Add alias 'manchester utd' → 'manchester united'
#     1B. Add and export ROLLING_NOISE_TOKENS constant
#
#   src/scrapers/orchestrator.js
#     2A. Import ROLLING_NOISE_TOKENS from team-names
#     2B. Replace lookupRolling() with confidence-guarded version
#         that iterates all candidates and returns the first with
#         at least one meaningful (non-noise) common token
#
# Run on Mac:
#   python3 /Volumes/appdata/goalscout/scripts/patches/patch_rolling_lookup.py
#
# Run on Unraid:
#   python3 /mnt/user/appdata/goalscout/scripts/patches/patch_rolling_lookup.py
# ─────────────────────────────────────────────────────────────

import sys
import shutil
from pathlib import Path

# ── Resolve repo root ─────────────────────────────────────────
CANDIDATES = [
    Path('/Volumes/appdata/goalscout'),
    Path('/mnt/user/appdata/goalscout'),
]
ROOT = next((p for p in CANDIDATES if p.exists()), None)
if not ROOT:
    print('ERROR: could not find repo root. Tried:')
    for p in CANDIDATES:
        print(f'  {p}')
    sys.exit(1)

print(f'Repo root: {ROOT}')

TEAM_NAMES = ROOT / 'src' / 'utils' / 'team-names.js'
ORCHESTRATOR = ROOT / 'src' / 'scrapers' / 'orchestrator.js'

for f in (TEAM_NAMES, ORCHESTRATOR):
    if not f.exists():
        print(f'ERROR: {f} not found')
        sys.exit(1)

errors = 0


def apply(path, old, new, label):
    global errors
    content = path.read_text(encoding='utf-8')
    count = content.count(old)
    if count == 0:
        print(f'  SKIP  {label} — target not found (already patched?)')
        return content
    if count > 1:
        print(f'  ERROR {label} — target found {count} times, aborting')
        errors += 1
        return content
    result = content.replace(old, new, 1)
    print(f'  OK    {label}')
    return result


# ══════════════════════════════════════════════════════════════
# FILE 1: src/utils/team-names.js
# ══════════════════════════════════════════════════════════════
print(f'\nPatching {TEAM_NAMES.relative_to(ROOT)}')

tn = TEAM_NAMES.read_text(encoding='utf-8')

# ── Change 1A: add 'manchester utd' alias ─────────────────────
tn = apply(
    TEAM_NAMES,
    "  'man utd':              'manchester united',",
    "  'man utd':              'manchester united',\n"
    "  'manchester utd':       'manchester united',",
    "1A: add 'manchester utd' alias",
)

# ── Change 1B: add ROLLING_NOISE_TOKENS before module.exports ─
tn = tn.replace(
    "module.exports = { normalise, applyAlias, singleTeamMatch, teamsMatch };",
    ""
)  # temporarily remove to re-add with the constant above it

NOISE_BLOCK = (
    "\n"
    "// Tokens that appear in multiple club names and carry no discriminating\n"
    "// power on their own. A rolling lookup match driven solely by these tokens\n"
    "// is not confident enough to use — see lookupRolling() in orchestrator.js.\n"
    "const ROLLING_NOISE_TOKENS = new Set([\n"
    "  'united', 'city', 'saint', 'sporting', 'athletic', 'atletico',\n"
    "  'real', 'sport', 'borussia', 'inter', 'western', 'wanderers',\n"
    "]);\n"
    "\n"
    "module.exports = { normalise, applyAlias, singleTeamMatch, teamsMatch, ROLLING_NOISE_TOKENS };\n"
)

if "module.exports = { normalise, applyAlias, singleTeamMatch, teamsMatch };" in tn:
    # Was not removed above — means 1A target was not found (already patched path)
    tn = apply(
        TEAM_NAMES,
        "module.exports = { normalise, applyAlias, singleTeamMatch, teamsMatch };",
        NOISE_BLOCK.lstrip('\n'),
        "1B: add ROLLING_NOISE_TOKENS and update exports",
    )
else:
    # 1A succeeded and we cleared the export line — just append
    if "ROLLING_NOISE_TOKENS" not in tn:
        tn = tn.rstrip() + '\n' + NOISE_BLOCK
        print("  OK    1B: add ROLLING_NOISE_TOKENS and update exports")
    else:
        print("  SKIP  1B: ROLLING_NOISE_TOKENS already present")

# Write team-names.js
if errors == 0:
    backup = TEAM_NAMES.with_suffix('.js.bak-rolling-guard')
    shutil.copy(TEAM_NAMES, backup)
    TEAM_NAMES.write_text(tn, encoding='utf-8')
    print(f'  Written: {TEAM_NAMES.relative_to(ROOT)}  (backup: {backup.name})')


# ══════════════════════════════════════════════════════════════
# FILE 2: src/scrapers/orchestrator.js
# ══════════════════════════════════════════════════════════════
print(f'\nPatching {ORCHESTRATOR.relative_to(ROOT)}')

orch = ORCHESTRATOR.read_text(encoding='utf-8')

# ── Change 2A: add ROLLING_NOISE_TOKENS to import ─────────────
orch = apply(
    ORCHESTRATOR,
    "const { singleTeamMatch }       = require('../utils/team-names');",
    "const { singleTeamMatch, ROLLING_NOISE_TOKENS } = require('../utils/team-names');",
    "2A: import ROLLING_NOISE_TOKENS",
)

# ── Change 2B: replace lookupRolling() ────────────────────────
OLD_LOOKUP = (
    "function lookupRolling(ssTeamName, rollingMap) {\n"
    "  if (!ssTeamName || !rollingMap || rollingMap.size === 0) return null;\n"
    " \n"
    "  // Direct match (handles the few cases where names happen to be identical)\n"
    "  if (rollingMap.has(ssTeamName)) return rollingMap.get(ssTeamName);\n"
    " \n"
    "  // Fuzzy match: normalises both names (strip \"FC\", diacritics, aliases),\n"
    "  // then checks token overlap. Threshold ≥ 0.4 overlap OR one is a substring.\n"
    "  for (const [fdName, rolling] of rollingMap) {\n"
    "    if (singleTeamMatch(fdName, ssTeamName)) return rolling;\n"
    "  }\n"
    " \n"
    "  return null;\n"
    "}"
)

NEW_LOOKUP = (
    "function lookupRolling(ssTeamName, rollingMap) {\n"
    "  if (!ssTeamName || !rollingMap || rollingMap.size === 0) return null;\n"
    "\n"
    "  // Direct hit — map key exactly equals the SoccerSTATS name (rare).\n"
    "  if (rollingMap.has(ssTeamName)) return rollingMap.get(ssTeamName);\n"
    "\n"
    "  const { normalise } = require('../utils/team-names');\n"
    "  const ssNorm   = normalise(ssTeamName);\n"
    "  const ssTokens = ssNorm.split(' ').filter(Boolean);\n"
    "\n"
    "  // Collect all candidates that pass singleTeamMatch, scored by overlap.\n"
    "  const candidates = [];\n"
    "  for (const [fdName, rolling] of rollingMap) {\n"
    "    if (!singleTeamMatch(fdName, ssTeamName)) continue;\n"
    "    const fdNorm   = normalise(fdName);\n"
    "    const fdTokens = fdNorm.split(' ').filter(Boolean);\n"
    "    const common   = ssTokens.filter(t => fdTokens.includes(t));\n"
    "    const overlap  = common.length / Math.max(ssTokens.length, fdTokens.length);\n"
    "    candidates.push({ fdName, rolling, common, overlap });\n"
    "  }\n"
    "\n"
    "  if (candidates.length === 0) return null;\n"
    "\n"
    "  // Sort best overlap first so the most specific match is tried first.\n"
    "  candidates.sort((a, b) => b.overlap - a.overlap);\n"
    "\n"
    "  // Iterate candidates. Return the first one that has at least one\n"
    "  // meaningful (non-noise, length >= 4) common token. Log and skip\n"
    "  // candidates whose only common tokens are generic suffixes like\n"
    "  // 'united' or 'city' that appear across many different clubs.\n"
    "  for (const cand of candidates) {\n"
    "    const meaningfulCommon = cand.common.filter(\n"
    "      t => !ROLLING_NOISE_TOKENS.has(t) && t.length >= 4\n"
    "    );\n"
    "    if (meaningfulCommon.length > 0) {\n"
    "      return cand.rolling;\n"
    "    }\n"
    "    console.warn(\n"
    "      `[context] rolling lookup candidate REJECTED for \"${ssTeamName}\": ` +\n"
    "      `\"${cand.fdName}\" ` +\n"
    "      `(overlap ${cand.overlap.toFixed(2)}, common tokens: [${cand.common.join(', ')}]) ` +\n"
    "      `— all common tokens are noise words. Trying next candidate.`\n"
    "    );\n"
    "  }\n"
    "\n"
    "  // All candidates rejected.\n"
    "  console.warn(\n"
    "    `[context] rolling lookup REJECTED for \"${ssTeamName}\": ` +\n"
    "    `all ${candidates.length} candidate(s) had noise-only common tokens. ` +\n"
    "    `Skipping this fixture.`\n"
    "  );\n"
    "  return null;\n"
    "}"
)

orch = apply(ORCHESTRATOR, OLD_LOOKUP, NEW_LOOKUP, "2B: replace lookupRolling()")

# Write orchestrator.js
if errors == 0:
    backup = ORCHESTRATOR.with_suffix('.js.bak-rolling-guard')
    shutil.copy(ORCHESTRATOR, backup)
    ORCHESTRATOR.write_text(orch, encoding='utf-8')
    print(f'  Written: {ORCHESTRATOR.relative_to(ROOT)}  (backup: {backup.name})')


# ══════════════════════════════════════════════════════════════
# Summary
# ══════════════════════════════════════════════════════════════
print()
if errors:
    print(f'FAILED — {errors} error(s). No files were written.')
    sys.exit(1)
else:
    print('All patches applied.')
    print()
    print('Verify with:')
    print('  docker exec goalscout node -e "')
    print('    const tn = require(\'./src/utils/team-names\');')
    print('    console.log(\'ROLLING_NOISE_TOKENS:\', tn.ROLLING_NOISE_TOKENS instanceof Set);')
    print('    console.log(\'manchester utd alias:\', tn.applyAlias(\'Manchester Utd\'));')
    print('    console.log(\'normalise:\', tn.normalise(\'Manchester Utd\'));')
    print('  "')
    print('  docker exec goalscout node -e "require(\'./src/scrapers/orchestrator\')"')
    print()
    print('Then deploy:')
    print('  cd /mnt/user/appdata/goalscout')
    print('  docker compose down')
    print('  docker rmi goalscout goalscout-goalscout 2>/dev/null || true')
    print('  docker builder prune -f')
    print('  docker compose up --build -d')
    print('  docker logs -f goalscout')
