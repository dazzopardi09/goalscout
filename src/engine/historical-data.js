// src/engine/historical-data.js
// ─────────────────────────────────────────────────────────────
// Parses Football-Data.co.uk CSV files for the context_raw backtest.
//
// This is a SEPARATE data source from the live football-data.org API
// used in settler.js. These are one-time downloaded CSVs stored locally.
//
// Source:  https://www.football-data.co.uk
// Format:  CSV, one row per completed match
// Date:    dd/mm/yy  (2-digit year — e.g. 17/08/24 = Aug 17 2024)
//
// Key columns used:
//   Date, HomeTeam, AwayTeam, FTHG, FTAG, FTR
//   B365H, B365D, B365A       — Bet365 opening 1X2 odds
//   B365>2.5, B365<2.5        — Bet365 opening O/U 2.5 odds
//   Max>2.5, Max<2.5          — Market max O/U 2.5 (best available)
//   Avg>2.5, Avg<2.5          — Market average O/U 2.5
//   B365CH, B365CA            — Bet365 CLOSING 1X2 odds (for ROI/CLV later)
//
// Files live at:  data/historical/{leagueSlug}/{season}.csv
// e.g.            data/historical/england/2024_25.csv
//
// Do NOT import this module from any live production code.
// It is backtest-only.
// ─────────────────────────────────────────────────────────────

const fs   = require('fs');
const path = require('path');
const config = require('../config');

// Map leagueSlug → Football-Data.co.uk division code (for documentation)
const SLUG_TO_FDC_DIV = {
  england:     'E0',
  england2:    'E1',
  germany:     'D1',
  germany2:    'D2',
  italy:       'I1',
  spain:       'SP1',
  france:      'F1',
  netherlands: 'N1',
};

// Season slug → URL path segment (for download instructions)
// e.g. '2024_25' → 'mmz4281/2425'
function seasonToUrlPath(season) {
  const [y1, y2] = season.split('_');
  const a = y1.slice(-2);
  const b = y2.slice(-2);
  return `mmz4281/${a}${b}`;
}

// ── Date parsing ──────────────────────────────────────────────

/**
 * Parse a Football-Data.co.uk date string to a Date object.
 * Handles both dd/mm/yy and dd/mm/yyyy formats.
 * Returns null if unparseable.
 */
function parseDate(dateStr) {
  if (!dateStr) return null;
  const parts = dateStr.trim().split('/');
  if (parts.length !== 3) return null;

  const day   = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10) - 1; // 0-indexed
  let   year  = parseInt(parts[2], 10);

  if (isNaN(day) || isNaN(month) || isNaN(year)) return null;

  // Handle 2-digit years: 00–49 → 2000–2049, 50–99 → 1950–1999
  if (year < 100) {
    year += year < 50 ? 2000 : 1900;
  }

  const d = new Date(year, month, day);
  return isNaN(d.getTime()) ? null : d;
}

// ── CSV parsing ───────────────────────────────────────────────

/**
 * Parse a Football-Data.co.uk CSV into an array of match objects.
 * Unplayed fixtures (missing FTHG/FTAG) are silently skipped.
 * Rows with unparseable dates are skipped.
 * Returns matches sorted ascending by date.
 */
function parseCSV(csvPath) {
  if (!fs.existsSync(csvPath)) {
    const relPath = path.relative(process.cwd(), csvPath);
    throw new Error(
      `CSV not found: ${relPath}\n` +
      `Download it first — see scripts/context/download-historical.sh`
    );
  }

  const raw = fs.readFileSync(csvPath, 'utf8')
    .replace(/^\uFEFF/, '')   // strip UTF-8 BOM if present
    .replace(/\r\n/g, '\n')   // normalise Windows line endings
    .replace(/\r/g, '\n');

  const lines = raw.split('\n').map(l => l.trimEnd()).filter(l => l.length > 0);

  if (lines.length < 2) return [];

  // Parse header
  const headers = lines[0].split(',').map(h => h.trim());

  const matches = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');

    // Build row object; handle rows shorter than header (trailing commas stripped)
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = idx < cols.length ? cols[idx].trim() : '';
    });

    // Skip rows with no team data (blank rows at end of file, etc.)
    if (!row.HomeTeam || !row.AwayTeam || !row.Date) continue;

    // Skip unplayed fixtures (FTHG/FTAG blank)
    if (row.FTHG === '' || row.FTAG === '') continue;

    const date = parseDate(row.Date);
    if (!date) continue;

    const homeGoals = parseInt(row.FTHG, 10);
    const awayGoals = parseInt(row.FTAG, 10);
    if (isNaN(homeGoals) || isNaN(awayGoals)) continue;

    const totalGoals = homeGoals + awayGoals;

    // O/U 2.5 opening odds — prefer Bet365, fall back to market average
    // Column names use literal > and < characters in the file
    const oddsO25Open = parseFloat(row['B365>2.5'] || row['Max>2.5'] || row['Avg>2.5']) || null;
    const oddsU25Open = parseFloat(row['B365<2.5'] || row['Max<2.5'] || row['Avg<2.5']) || null;

    // 1X2 opening odds — used for favourite/underdog determination
    const oddsHomeOpen = parseFloat(row.B365H || row.AvgH) || null;
    const oddsAwayOpen = parseFloat(row.B365A || row.AvgA) || null;
    const oddsDraw     = parseFloat(row.B365D || row.AvgD) || null;

    // Closing 1X2 odds (where available — used later for CLV computation)
    const oddsHomeClose = parseFloat(row.B365CH || row.PSH) || null;
    const oddsAwayClose = parseFloat(row.B365CA || row.PSA) || null;

    // Closing O/U 2.5 odds — used for CLV in the backtest
    // Column names: B365C>2.5, PC>2.5, AvgC>2.5 (C = closing)
    const oddsO25Close = parseFloat(row['B365C>2.5'] || row['PC>2.5'] || row['AvgC>2.5']) || null;
    const oddsU25Close = parseFloat(row['B365C<2.5'] || row['PC<2.5'] || row['AvgC<2.5']) || null;

    matches.push({
      date,
      dateStr:   row.Date,
      homeTeam:  row.HomeTeam,
      awayTeam:  row.AwayTeam,
      homeGoals,
      awayGoals,
      totalGoals,
      result_o25:  totalGoals > 2.5,
      result_u25:  totalGoals <= 2.5,
      result_btts: homeGoals > 0 && awayGoals > 0,
      ftr:         row.FTR || null,   // H / D / A

      // Odds (nullable — not all seasons/leagues have all columns)
      oddsO25Open,
      oddsU25Open,
      oddsHomeOpen,
      oddsAwayOpen,
      oddsDraw,
      oddsHomeClose,
      oddsAwayClose,
      oddsO25Close,
      oddsU25Close,
    });
  }

  // Guarantee ascending date order (source files are usually correct, but enforce it)
  matches.sort((a, b) => a.date - b.date);

  return matches;
}

// ── Public API ────────────────────────────────────────────────

/**
 * Load all completed matches for a given league and season.
 *
 * @param {string} leagueSlug  e.g. 'england'
 * @param {string} season      e.g. '2024_25'
 * @returns {object[]}         Array of match objects, ascending by date
 */
function loadMatches(leagueSlug, season) {
  const csvPath = path.join(
    config.DATA_DIR,
    'historical',
    leagueSlug,
    `${season}.csv`
  );
  return parseCSV(csvPath);
}

/**
 * Return all matches involving a specific team that occurred
 * strictly BEFORE the given cutoff date.
 *
 * LEAKAGE GUARD: Uses strict less-than comparison on date only.
 * The fixture itself is never included in its own rolling window.
 *
 * @param {string}   teamName   Exact name as in the CSV
 * @param {object[]} allMatches Full season match array
 * @param {Date}     beforeDate Cutoff — only matches with date < beforeDate
 * @returns {object[]}          Filtered matches, unsorted
 */
function getTeamMatchesBefore(teamName, allMatches, beforeDate) {
  const norm = teamName.toLowerCase().trim();

  return allMatches.filter(m => {
    const involved =
      m.homeTeam.toLowerCase().trim() === norm ||
      m.awayTeam.toLowerCase().trim() === norm;

    // Strict less-than: same-day matches are excluded
    const beforeCutoff = m.date < beforeDate;

    return involved && beforeCutoff;
  });
}

/**
 * Infer a 1-indexed gameweek number for a fixture.
 * Groups all season fixtures into 7-day rolling windows.
 * The window containing the first fixture is GW 1.
 * This is display-only — not used in any model logic.
 *
 * @param {Date}     fixtureDate
 * @param {Date}     seasonStartDate  Date of the first match in the season
 * @returns {number}
 */
function inferGameweek(fixtureDate, seasonStartDate) {
  const diffMs   = fixtureDate - seasonStartDate;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  return Math.floor(diffDays / 7) + 1;
}

module.exports = {
  loadMatches,
  getTeamMatchesBefore,
  inferGameweek,
  parseDate,
  SLUG_TO_FDC_DIV,
  seasonToUrlPath,
};