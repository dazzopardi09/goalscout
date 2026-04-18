// src/scrapers/orchestrator.js
// ─────────────────────────────────────────────────────────────
// Orchestrator v3 — BETTABLE-FIRST flow
//
// WORKFLOW:
//   1. Query The-Odds-API for active soccer competitions
//   2. Map those to SoccerSTATS league slugs
//   3. Scrape SoccerSTATS matches page for bettable leagues only
//   4. Score and shortlist bettable matches
//   5. Fetch real odds for shortlisted matches
//   6. Run probability engine + log predictions (with odds snapshot)
//   7. Scrape match details for top shortlisted
//   8. Write results to disk
//
// Odds snapshot integrity:
//   Odds are fetched and matched BEFORE logPrediction is called.
//   If matching fails, the prediction is logged without odds and
//   history.js will allow one update on the next refresh cycle
//   when odds become available.
// ─────────────────────────────────────────────────────────────

const { scrapeMatchesPage, scrapeLeaguePage, scrapeMatchDetail } = require('./match-discovery');
const { buildShortlist } = require('../engine/shortlist');
const { analyseMatch } = require('../engine/probability');
const { logPrediction } = require('../engine/history');
const {
  buildBettableLeagueMap,
  isBettableLeague,
  getOddsKey,
  fetchOddsForShortlist,
  matchOddsToMatch,
  SLUG_TO_ODDS_MAP,
} = require('../odds/the-odds-api');
const { writeJSON, writeMatchDetail } = require('../utils/storage');
const config = require('../config');

let refreshState = {
  status: 'idle',
  lastRefresh: null,
  lastError: null,
  matchCount: 0,
  shortlistCount: 0,
  bettableCount: 0,
  progress: '',
};

function getRefreshState() {
  return { ...refreshState };
}

async function runFullRefresh({ scrapeDetails = true } = {}) {
  if (refreshState.status === 'running') {
    console.log('[orchestrator] refresh already running, skipping');
    return refreshState;
  }

  refreshState.status = 'running';
  refreshState.progress = 'Starting refresh...';

  try {
    // ── Step 1: Discover bettable leagues ─────────────────
    let bettableMap = new Map();
    let bettableSlugs = [];

    if (config.ODDS_API_KEYS.length > 0) {
      refreshState.progress = 'Checking bettable leagues via Odds API...';
      try {
        bettableMap = await buildBettableLeagueMap();
        console.log(`[orchestrator] ${bettableMap.size} bettable competitions on Odds API`);

        for (const [slug, oddsKey] of Object.entries(SLUG_TO_ODDS_MAP)) {
          if (bettableMap.has(oddsKey)) {
            bettableSlugs.push(slug);
          }
        }
        console.log(`[orchestrator] ${bettableSlugs.length} SoccerSTATS leagues are bettable`);
      } catch (e) {
        console.warn('[orchestrator] odds API failed, falling back to all leagues:', e.message);
      }
    }

    // ── Step 2: Scrape SoccerSTATS matches page ───────────
    refreshState.progress = 'Scraping matches page...';
    const { matches: todayMatches, leagueSlugs: todaySlugs } = await scrapeMatchesPage(1);

    // Also tomorrow
    refreshState.progress = 'Scraping tomorrow...';
    let tomorrowMatches = [];
    try {
      const tmrw = await scrapeMatchesPage(2);
      tomorrowMatches = tmrw.matches;
    } catch (e) {
      console.warn('[orchestrator] tomorrow failed:', e.message);
    }

    // Merge and deduplicate all scraped matches
    const allScraped = [...todayMatches, ...tomorrowMatches];
    const deduped = new Map();
    for (const m of allScraped) {
      if (!deduped.has(m.id)) deduped.set(m.id, m);
    }
    let allMatches = Array.from(deduped.values());

    console.log(`[orchestrator] total scraped matches: ${allMatches.length}`);

    // ── Step 3: Filter to bettable only ───────────────────
    if (bettableSlugs.length > 0) {
      for (const m of allMatches) {
        m.bettable = bettableSlugs.includes(m.leagueSlug);
        m.oddsKey = getOddsKey(m.leagueSlug) || null;
      }

      const bettableMatches = allMatches.filter(m => m.bettable);
      const nonBettable = allMatches.length - bettableMatches.length;
      console.log(`[orchestrator] ${bettableMatches.length} bettable, ${nonBettable} skipped (no betting markets)`);

      refreshState.bettableCount = bettableMatches.length;
    } else {
      for (const m of allMatches) {
        m.bettable = null;
      }
    }

    // ── Step 4: Scrape league pages for bettable leagues ──
    const leagueStatsMap = {};
    const slugsToScrape = bettableSlugs.length > 0
      ? bettableSlugs.filter(s => todaySlugs.includes(s) || allMatches.some(m => m.leagueSlug === s))
      : todaySlugs.slice(0, 20);

    refreshState.progress = `Scraping ${slugsToScrape.length} league pages...`;

    for (const slug of slugsToScrape) {
      try {
        const result = await scrapeLeaguePage(slug);
        if (Object.keys(result.leagueStats).length > 0) {
          leagueStatsMap[slug] = result.leagueStats;
        }
      } catch (e) {
        console.warn(`[orchestrator] league ${slug} failed:`, e.message);
      }
    }

    // ── Step 5: Score and shortlist ───────────────────────
    refreshState.progress = 'Scoring matches...';

    const matchesToScore = bettableSlugs.length > 0
      ? allMatches.filter(m => m.bettable)
      : allMatches;

    const { all: scored, shortlisted } = buildShortlist(matchesToScore, leagueStatsMap);

    console.log(`[orchestrator] shortlisted: ${shortlisted.length} of ${scored.length} bettable matches`);

    // ── Step 5b: Tag matches with day (Today/Tomorrow) ────
    for (const m of [...scored, ...shortlisted]) {
      m.day = todayMatches.some(t => t.id === m.id) ? 'Today' : 'Tomorrow';
    }

    // ── Step 6: Fetch real odds for shortlisted matches ───
    if (config.ODDS_API_KEYS.length > 0 && shortlisted.length > 0) {
      refreshState.progress = 'Fetching betting odds...';
      try {
        const oddsMap = await fetchOddsForShortlist(shortlisted);
        let matched = 0;
        let unmatched = 0;

        for (const m of shortlisted) {
          const odds = matchOddsToMatch(m, oddsMap);
          if (odds) {
            m.odds = odds;
            matched++;
          } else {
            unmatched++;
            // Log so we can diagnose which team names are failing fuzzy match
            console.log(`[orchestrator] no odds match: "${m.homeTeam}" vs "${m.awayTeam}" (${m.leagueSlug})`);
          }
        }

        console.log(`[orchestrator] odds matched: ${matched} of ${shortlisted.length} (${unmatched} unmatched)`);
      } catch (e) {
        console.warn('[orchestrator] odds fetch failed:', e.message);
      }
    }

    // ── Step 6b: Run probability engine + log predictions ─
    // Odds must be attached to matches BEFORE this step runs,
    // so the snapshot captured in logPrediction is complete.
    refreshState.progress = 'Calculating probabilities...';

    for (const m of shortlisted) {
      try {
        const analysis = analyseMatch(m, leagueStatsMap[m.leagueSlug] || {});
        m.analysis = analysis;

        // Log prediction to history — odds snapshot included if matching succeeded.
        // If odds are null here, history.js will allow one update on the next cycle.
        logPrediction(m, analysis);
      } catch (e) {
        console.warn(`[orchestrator] probability analysis failed for ${m.id}:`, e.message);
      }
    }

    const withProbs = shortlisted.filter(m => m.analysis).length;
    const withOdds = shortlisted.filter(m => m.analysis?.o25?.marketOdds != null).length;
    const withEdge = shortlisted.filter(m => m.analysis?.o25?.edge != null).length;
    console.log(`[orchestrator] probabilities: ${withProbs} calculated, ${withOdds} with odds, ${withEdge} with edge`);

    // ── Step 7: Scrape match details for top shortlisted ──
    if (scrapeDetails && shortlisted.length > 0) {
      const toDetail = shortlisted.slice(0, 20);
      refreshState.progress = `Fetching details for ${toDetail.length} matches...`;

      for (const match of toDetail) {
        if (match.matchUrl) {
          try {
            const detail = await scrapeMatchDetail(match.matchUrl);
            if (detail) {
              writeMatchDetail(match.id, detail);
              match.hasDetail = true;
            }
          } catch (e) {
            console.warn(`[orchestrator] detail failed for ${match.id}:`, e.message);
          }
        }
      }
    }

    // ── Step 8: Write to disk ─────────────────────────────
    refreshState.progress = 'Writing data...';

    writeJSON(config.DISCOVERED_FILE, scored);
    writeJSON(config.SHORTLIST_FILE, shortlisted);
    writeJSON(config.META_FILE, {
      lastRefresh: new Date().toISOString(),
      totalScraped: allMatches.length,
      bettableCount: matchesToScore.length,
      scoredCount: scored.length,
      shortlistCount: shortlisted.length,
      bettableLeagues: bettableSlugs.length,
      leaguesOnPage: todaySlugs.length,
      leagueStatsFound: Object.keys(leagueStatsMap).length,
    });

    // Done
    refreshState.status = 'done';
    refreshState.lastRefresh = new Date().toISOString();
    refreshState.matchCount = scored.length;
    refreshState.shortlistCount = shortlisted.length;
    refreshState.bettableCount = matchesToScore.length;
    refreshState.progress = 'Complete';
    refreshState.lastError = null;

    console.log(`[orchestrator] done. ${allMatches.length} scraped → ${matchesToScore.length} bettable → ${shortlisted.length} shortlisted.`);

    return refreshState;

  } catch (err) {
    refreshState.status = 'error';
    refreshState.lastError = err.message;
    refreshState.progress = `Error: ${err.message}`;
    console.error('[orchestrator] refresh failed:', err);
    return refreshState;
  }
}

module.exports = { runFullRefresh, getRefreshState };