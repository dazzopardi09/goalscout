// src/scrapers/match-discovery.js
// ─────────────────────────────────────────────────────────────
// Discovers today's matches from SoccerSTATS.
//
// STRATEGY — TWO-PHASE DISCOVERY:
//
// Phase A: Scrape the matches.asp?listing=2 page (Sortable #2).
//   This page shows PPG, TG, W%, CS, FTS, BTS, 2.5+ for each
//   match — exactly the data we need for shortlisting.
//   ⚠ PUBLIC LIMITATION: Only shows max 10 matches.
//   Members get all matches; public gets a truncated list.
//
// Phase B: For each league discovered on the page, also scrape
//   the individual latest.asp?league=xxx page, which shows
//   upcoming fixtures for that league (not limited to 10).
//   These pages have different data layouts (team-level stats
//   in tables, not per-match rows), so we extract what we can.
//
// This dual approach means:
//   - We always get the rich per-match stats from matches.asp
//   - We supplement with additional matches from league pages
//   - We are NOT limited to a hand-picked league list
//
// KNOWN HTML STRUCTURE (matches.asp?listing=2):
//   Each match row contains exactly 23 <td> cells:
//
//   [0]  country/league cell (link to latest.asp?league=xxx)
//   [1]  home O2.5%    [2]  home BTS%   [3]  home FTS%
//   [4]  home CS%      [5]  home W%     [6]  home avg TG
//   [7]  home PPG      [8]  home GP     [9]  scope "home"
//   [10] home team     [11] kickoff     [12] away team
//   [13] scope "away"  [14] away GP     [15] away PPG
//   [16] away avg TG   [17] away W%     [18] away CS%
//   [19] away FTS%     [20] away BTS%   [21] away O2.5%
//   [22] stats icon (empty text)
//
//   timeIdx is always 11. Away offsets from timeIdx:
//     GP=+3  PPG=+4  TG=+5  W%=+6  CS=+7  FTS=+8  BTS=+9  O25=+10
//   NOTE: +2 is scope("away") — a text cell, not a stat.
//
//   Every match row also has the country/league link in cell [0],
//   so league detection and match detection both fire on the same row.
//
// LIMITATIONS:
//   - If layout changes, the 23-cell guard will log a warning.
//   - Public 10-match cap on matches.asp is real. League pages
//     supplement but may have less structured per-match data.
//   - Cup matches often lack stats. Handled gracefully.
// ─────────────────────────────────────────────────────────────

const cheerio = require('cheerio');
const { fetchPage } = require('../utils/fetcher');
const { BASE_URL } = require('../config');

/**
 * Parse a percentage string like "67%" → 67, or "" → null
 */
function pct(str) {
  if (!str) return null;
  const n = parseFloat(str);
  return isNaN(n) ? null : n;
}

/**
 * Parse a decimal string like "2.53" → 2.53, or "" → null
 */
function dec(str) {
  if (!str) return null;
  const n = parseFloat(str);
  return isNaN(n) ? null : n;
}

/**
 * Scrape matches.asp with Sortable #2 format.
 * Returns { matches: [...], leagueSlugs: [...] }
 */
async function scrapeMatchesPage(matchday = 1) {
  // listing=2 gives: PPG / TG / W% / CS / FTS / BTS / 2.5+
  const url = `${BASE_URL}/matches.asp?matchday=${matchday}&matchdayn=1&listing=2`;
  console.log(`[matches] fetching ${url}`);

  const html = await fetchPage(url);
  const $ = cheerio.load(html);

  const matches = [];
  const leagueSlugs = new Set();
  let currentLeague = null;
  let currentLeagueSlug = null;

  // The data is in table rows. We walk all <tr> elements
  // and detect league headers vs match rows.
  $('tr').each((_, tr) => {
    const $tr = $(tr);
    const cells = $tr.find('td');
    const cellTexts = [];
    cells.each((__, td) => cellTexts.push($(td).text().trim()));

    // Detect league header: first cell has a link to latest.asp or leagueview.asp
    const firstLink = cells.first().find('a[href]').attr('href') || '';
    const leagueMatch = firstLink.match(/(?:latest|leagueview)\.asp\?league=([a-zA-Z0-9_-]+)/);

    if (leagueMatch) {
      currentLeagueSlug = leagueMatch[1].toLowerCase();

      // Use a lookup table for clean league names since HTML parsing is fragile
      const LEAGUE_NAMES = {
        'england': 'England - Premier League',
        'england2': 'England - Championship',
        'england3': 'England - League One',
        'england4': 'England - League Two',
        'england5': 'England - National League',
        'germany': 'Germany - Bundesliga',
        'germany2': 'Germany - 2. Bundesliga',
        'germany3': 'Germany - 3. Liga',
        'italy': 'Italy - Serie A',
        'italy2': 'Italy - Serie B',
        'spain': 'Spain - La Liga',
        'spain2': 'Spain - La Liga 2',
        'france': 'France - Ligue 1',
        'france2': 'France - Ligue 2',
        'netherlands': 'Netherlands - Eredivisie',
        'netherlands2': 'Netherlands - Eerste Divisie',
        'portugal': 'Portugal - Liga Portugal',
        'portugal2': 'Portugal - Liga Portugal 2',
        'belgium': 'Belgium - Pro League',
        'austria': 'Austria - Bundesliga',
        'switzerland': 'Switzerland - Super League',
        'turkey': 'Turkey - Süper Lig',
        'greece': 'Greece - Super League',
        'scotland': 'Scotland - Premiership',
        'scotland2': 'Scotland - Championship',
        'denmark': 'Denmark - Superliga',
        'sweden': 'Sweden - Allsvenskan',
        'norway': 'Norway - Eliteserien',
        'finland': 'Finland - Veikkausliiga',
        'poland': 'Poland - Ekstraklasa',
        'czechrepublic': 'Czech Republic - First League',
        'russia': 'Russia - Premier League',
        'ukraine': 'Ukraine - Premier League',
        'argentina': 'Argentina - Primera División',
        'brazil': 'Brazil - Série A',
        'australia': 'Australia - A-League',
        'japan': 'Japan - J1 League',
        'southkorea': 'South Korea - K League 1',
        'usa': 'USA - MLS',
        'cleague': 'UEFA Champions League',
        'uefa': 'UEFA Europa League',
        'uefaconference': 'UEFA Conference League',
      };

      currentLeague = LEAGUE_NAMES[currentLeagueSlug] || cellTexts[0]?.replace(/\s+/g, ' ').trim() || currentLeagueSlug;
      leagueSlugs.add(currentLeagueSlug);
    }

    // Detect match row: look for a time pattern (HH:MM) in the cells
    // and pmatch.asp links
    const pmatchLink = $tr.find('a[href*="pmatch.asp"]').attr('href') || '';
    const timeCell = cellTexts.find(t => /^\d{1,2}:\d{2}$/.test(t));

    if (timeCell && currentLeague) {
      // Guard against unexpected table structures
      if (cellTexts.length !== 23) {
        console.warn(`[matches] unexpected cell count ${cellTexts.length} at time ${timeCell} — skipping row`);
        return;
      }

      // Find the time index
      const timeIdx = cellTexts.indexOf(timeCell);
      if (timeIdx < 2) return; // malformed row

      // Home team is in the cell before time, away team after
      const homeTeam = cellTexts[timeIdx - 1] || '';
      const awayTeam = cellTexts[timeIdx + 1] || '';

      if (!homeTeam || !awayTeam) return;

      // Column layout (verified against live DOM, April 2026):
      // [0]  country   [1]  O25h  [2]  BTSh  [3]  FTSh  [4]  CSh
      // [5]  W%h       [6]  TGh   [7]  PPGh  [8]  GPh   [9]  "home"
      // [10] home team [11] time  [12] away  [13] "away" [14] GPa
      // [15] PPGa      [16] TGa   [17] W%a   [18] CSa   [19] FTSa
      // [20] BTSa      [21] O25a  [22] icon
      //
      // Away offsets from timeIdx (=11):
      //   +2 = "away" (text, skip)  +3 = GP   +4 = PPG  +5 = TG
      //   +6 = W%  +7 = CS  +8 = FTS  +9 = BTS  +10 = O25
      const match = {
        id: `${currentLeagueSlug}_${homeTeam}_${awayTeam}`.replace(/\s+/g, '_').toLowerCase(),
        league: currentLeague,
        leagueSlug: currentLeagueSlug,
        kickoff: timeCell,
        homeTeam,
        awayTeam,
        matchUrl: pmatchLink ? `${BASE_URL}/${pmatchLink}` : null,
        leagueUrl: `${BASE_URL}/latest.asp?league=${currentLeagueSlug}`,

        home: {
          o25pct: pct(cellTexts[1]),
          btsPct: pct(cellTexts[2]),
          ftsPct: pct(cellTexts[3]),
          csPct:  pct(cellTexts[4]),
          winPct: pct(cellTexts[5]),
          avgTG:  dec(cellTexts[6]),
          ppg:    dec(cellTexts[7]),
          gp:     parseInt(cellTexts[8]) || null,
        },

        away: {
          gp:     parseInt(cellTexts[timeIdx + 3]) || null,
          ppg:    dec(cellTexts[timeIdx + 4]),
          avgTG:  dec(cellTexts[timeIdx + 5]),
          winPct: pct(cellTexts[timeIdx + 6]),
          csPct:  pct(cellTexts[timeIdx + 7]),
          ftsPct: pct(cellTexts[timeIdx + 8]),
          btsPct: pct(cellTexts[timeIdx + 9]),
          o25pct: pct(cellTexts[timeIdx + 10]),
        },

        source: 'matches-page',
        scrapedAt: new Date().toISOString(),
      };

      // Only add if we got at least some stats
      const hasStats = match.home.o25pct !== null || match.home.btsPct !== null;
      match.hasStats = hasStats;

      matches.push(match);
    }
  });

  console.log(`[matches] parsed ${matches.length} matches from matches.asp`);
  console.log(`[matches] discovered ${leagueSlugs.size} league slugs from page`);

  return { matches, leagueSlugs: Array.from(leagueSlugs) };
}


/**
 * Scrape a single league page (latest.asp?league=xxx) for
 * upcoming fixtures. This supplements the matches.asp data.
 *
 * The league page has a different layout — it shows the full
 * league table plus upcoming fixtures. We look for fixture
 * rows that contain match links and kickoff times.
 *
 * ⚠ The per-match stats on this page are LESS structured than
 *   the matches.asp sortable view. We extract what we can,
 *   but the primary stats source remains matches.asp.
 */
async function scrapeLeaguePage(slug) {
  const url = `${BASE_URL}/latest.asp?league=${slug}`;
  console.log(`[league-page] fetching ${url}`);

  try {
    const html = await fetchPage(url);
    const $ = cheerio.load(html);

    const matches = [];
    const leagueName = $('title').text().split('|')[0]?.trim() || slug;

    // Look for upcoming match rows with pmatch links
    $('a[href*="pmatch.asp"]').each((_, el) => {
      const $link = $(el);
      const href = $link.attr('href') || '';
      const $row = $link.closest('tr');

      if (!$row.length) return;

      const cells = [];
      $row.find('td').each((__, td) => cells.push($(td).text().trim()));

      // Try to find team names and time
      const timeCell = cells.find(t => /^\d{1,2}:\d{2}$/.test(t));
      const linkText = $link.text().trim();

      // The pmatch link text often contains "team1 - team2"
      const teamsFromLink = linkText.match(/^(.+?)\s*[-–]\s*(.+)$/);

      if (teamsFromLink) {
        const match = {
          id: `${slug}_${teamsFromLink[1]}_${teamsFromLink[2]}`.replace(/\s+/g, '_').toLowerCase(),
          league: leagueName,
          leagueSlug: slug,
          kickoff: timeCell || null,
          homeTeam: teamsFromLink[1].trim(),
          awayTeam: teamsFromLink[2].trim(),
          matchUrl: `${BASE_URL}/${href}`,
          leagueUrl: url,
          home: {},
          away: {},
          hasStats: false,
          source: 'league-page',
          scrapedAt: new Date().toISOString(),
        };

        matches.push(match);
      }
    });

    // Extract league-level stats from the consolidated stats block.
    //
    // The page contains a <tr> whose first <td> starts with
    // "<League> stats ... <N> matches played / <M> ... <X>% completed"
    // and embeds all season-aggregate stats as "Label:\nValue" pairs.
    //
    // We scope extraction to that cell to avoid matching menu link text
    // or per-team table columns that also appear on the page.
    //
    // Patterns use [\s\S]*? so newlines between label and value are
    // bridged without needing the dotAll flag (Node <16 compat).
    let leagueStats = {};

    let statsBlockText = null;
    $('tr').each((_, tr) => {
      const firstCell = $(tr).find('td').first().text();
      // The stats block cell always contains "matches played /" and
      // "completed" and "Over 2.5 goals".
      // Confirmed stable across england + germany (2026-04-27).
      if (/matches\s+played\s+\//.test(firstCell) &&
          /completed/.test(firstCell) &&
          /Over 2\.5 goals/.test(firstCell)) {
        statsBlockText = firstCell;
        return false; // break .each()
      }
    });

    if (statsBlockText) {
      const grab = (re) => {
        const m = statsBlockText.match(re);
        return m ? parseFloat(m[1]) : null;
      };

      // -- Active fields (consumed by probability.js and shortlist.js) --
      const o25pct   = grab(/Over 2\.5 goals:[\s\S]*?([\d.]+)\s*%/i);
      const btsPct   = grab(/Both teams scored:[\s\S]*?([\d.]+)\s*%/i);
      const avgGoals = grab(/(?:^|[\r\n])\s*Goals per match:\s*([\d.]+)/i);

      if (o25pct   != null) leagueStats.o25pct   = o25pct;
      if (btsPct   != null) leagueStats.btsPct   = btsPct;
      if (avgGoals != null) leagueStats.avgGoals = avgGoals;

      // -- Passive fields -- for future analysis only, NOT used in scoring --
      // These are captured at zero extra cost from the same block and will
      // be available when feature logging (Task 2) lands.  Do not read
      // leagueStats.passive inside probability.js or shortlist.js.
      const passive = {};
      const o15pct     = grab(/Over 1\.5 goals:[\s\S]*?([\d.]+)\s*%/i);
      const o35pct     = grab(/Over 3\.5 goals:[\s\S]*?([\d.]+)\s*%/i);
      const homeWinPct = grab(/Home wins:[\s\S]*?([\d.]+)\s*%/i);
      const drawPct    = grab(/Draws:[\s\S]*?([\d.]+)\s*%/i);
      const awayWinPct = grab(/Away wins:[\s\S]*?([\d.]+)\s*%/i);

      if (o15pct     != null) passive.o15pct     = o15pct;
      if (o35pct     != null) passive.o35pct     = o35pct;
      if (homeWinPct != null) passive.homeWinPct = homeWinPct;
      if (drawPct    != null) passive.drawPct    = drawPct;
      if (awayWinPct != null) passive.awayWinPct = awayWinPct;

      if (Object.keys(passive).length > 0) leagueStats.passive = passive;

      // -- Provenance metadata --
      if (Object.keys(leagueStats).length > 0) {
        leagueStats.source    = 'soccerstats_league_page';
        leagueStats.isProxy   = false;
        leagueStats.scrapedAt = new Date().toISOString();
      }

      console.log(
        '[league-page] ' + slug + ' stats ->' +
        ' o25=' + (o25pct != null ? o25pct + '%' : 'missing') +
        ' btts=' + (btsPct != null ? btsPct + '%' : 'missing') +
        ' avgGoals=' + (avgGoals != null ? avgGoals : 'missing') +
        ' passive fields=' + Object.keys(passive).length
      );
    } else {
      console.warn('[league-page] ' + slug + ': stats block not found -- leagueStats will be empty');
    }

    return { matches, leagueStats, slug, name: leagueName };
  } catch (err) {
    console.warn(`[league-page] failed to scrape ${slug}: ${err.message}`);
    return { matches: [], leagueStats: {}, slug, name: slug };
  }
}


/**
 * Scrape a match detail page (pmatch.asp?...) for deeper analysis.
 *
 * ⚠ Only called for shortlisted matches — not on every refresh.
 */
async function scrapeMatchDetail(matchUrl) {
  if (!matchUrl) return null;

  console.log(`[match-detail] fetching ${matchUrl}`);

  try {
    const html = await fetchPage(matchUrl);
    const $ = cheerio.load(html);

    const detail = {
      url: matchUrl,
      title: $('title').text().trim(),
      scrapedAt: new Date().toISOString(),
      sections: {},
    };

    $('table').each((_, table) => {
      const text = $(table).text().trim();
      if (text.includes('Head-to-Head') || text.includes('head to head')) {
        detail.sections.h2h = text.substring(0, 2000);
      }
      if (text.includes('Over 2.5') || text.includes('over 2.5')) {
        detail.sections.over25 = text.substring(0, 2000);
      }
      if (text.includes('Both teams') || text.includes('both teams') || text.includes('BTS')) {
        detail.sections.btts = text.substring(0, 2000);
      }
      if (text.includes('Performance') || text.includes('performance')) {
        detail.sections.performance = text.substring(0, 2000);
      }
      if (text.includes('Goal times') || text.includes('goal time')) {
        detail.sections.goalTimes = text.substring(0, 1000);
      }
    });

    const pageText = $.text();

    const h2hO25 = pageText.match(/head.*?over\s*2\.5.*?(\d+)\s*(?:of|\/)\s*(\d+)/i);
    if (h2hO25) {
      detail.h2hOver25 = { count: parseInt(h2hO25[1]), total: parseInt(h2hO25[2]) };
    }

    const h2hBtts = pageText.match(/head.*?both\s*teams?\s*scor.*?(\d+)\s*(?:of|\/)\s*(\d+)/i);
    if (h2hBtts) {
      detail.h2hBtts = { count: parseInt(h2hBtts[1]), total: parseInt(h2hBtts[2]) };
    }

    return detail;
  } catch (err) {
    console.warn(`[match-detail] failed: ${err.message}`);
    return null;
  }
}


module.exports = { scrapeMatchesPage, scrapeLeaguePage, scrapeMatchDetail };