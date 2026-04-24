// src/utils/team-names.js
// ─────────────────────────────────────────────────────────────
// Canonical team name normalisation — single source of truth.
// Used by both src/odds/the-odds-api.js and src/engine/settler.js.
//
// To add a new alias: add ONE entry to KNOWN_ALIASES below.
// The key is what SoccerSTATS sends (lowercased, trimmed).
// The value is what brings it closest to the Odds API name.
// ─────────────────────────────────────────────────────────────

const KNOWN_ALIASES = {
  // ── England ───────────────────────────────────────────────
  'nottm forest':         'nottingham forest',
  'man utd':              'manchester united',
  'man city':             'manchester city',
  'qpr':                  'queens park rangers',
  'spurs':                'tottenham hotspur',

  // ── Netherlands ───────────────────────────────────────────
  'psv eindhoven':        'psv',
  'pec zwolle':           'zwolle',

  // ── Germany ───────────────────────────────────────────────
  'nurnberg':             'nuremberg',
  'mgladbach':            'borussia monchengladbach',
  'bor. monchengladbach': 'borussia monchengladbach',

  // ── France ────────────────────────────────────────────────
  'saint etienne':        'st etienne',
  'sc bastia':            'bastia',

  // ── Denmark ───────────────────────────────────────────────
  'kobenhavn':            'copenhagen',

  // ── Other Europe ─────────────────────────────────────────
  'mtjylland':            'midtjylland',

  // ── Australia ─────────────────────────────────────────────
  'ws wanderers':         'western sydney wanderers',
  'macarthur fc':         'macarthur',
  'wellington phoenix':   'wellington',

  // ── Argentina ─────────────────────────────────────────────
  'gimnasia':             'gimnasia la plata',
  'e. rio cuarto':        'estudiantes rio cuarto',
  'e rio cuarto':         'estudiantes rio cuarto',
  'estudiantes de rio cuarto': 'estudiantes rio cuarto',
  'd. riestra':           'deportivo riestra',
  'd riestra':            'deportivo riestra',
  'defensa y j':          'defensa y justicia',
};

function applyAlias(name) {
  const lower = (name || '').toLowerCase().trim();
  return KNOWN_ALIASES[lower] || name;
}

function stripDiacritics(str) {
  return (str || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Normalise a team name for fuzzy comparison.
 * Applies known aliases first, then strips diacritics and common
 * club suffixes so both sources land on the same token set.
 */
function normalise(name) {
  // Alias lookup before any stripping — must use the original casing
  const aliased = applyAlias(name);

  return stripDiacritics(aliased || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]/g, ' ')
    // Strip common club suffixes that vary between data sources
    .replace(/\b(fc|ac|cf|sc|bk|fk|if|ik|sk|nk|as|sv|cd|club)\b/g, ' ')
    .replace(/\butd\b/g, 'united')
    .replace(/\batl\b/g, 'atletico')
    .replace(/\bath\b/g, 'athletic')
    .replace(/\bint\b/g, 'inter')
    .replace(/\bws\b/g, 'western sydney')
    .replace(/\bbor\b/g, 'borussia')
    .replace(/\bst\b/g, 'saint')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Returns true if two team name strings refer to the same team.
 * Uses token overlap — more robust than exact match or simple includes.
 */
function singleTeamMatch(a, b) {
  const na = normalise(a);
  const nb = normalise(b);

  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;

  const ta = na.split(' ').filter(Boolean);
  const tb = nb.split(' ').filter(Boolean);
  const common = ta.filter(t => tb.includes(t));
  const overlap = common.length / Math.max(ta.length, tb.length);

  return common.length >= 1 && overlap >= 0.4;
}

/**
 * Returns true if an Odds API event (home/away) matches a prediction (home/away).
 * Also tries swapped order as a safety net.
 */
function teamsMatch(apiHome, apiAway, predHome, predAway) {
  if (
    singleTeamMatch(apiHome, predHome) &&
    singleTeamMatch(apiAway, predAway)
  ) return true;

  // Swapped — edge case safety net only
  return (
    singleTeamMatch(apiHome, predAway) &&
    singleTeamMatch(apiAway, predHome)
  );
}

module.exports = { normalise, applyAlias, singleTeamMatch, teamsMatch };