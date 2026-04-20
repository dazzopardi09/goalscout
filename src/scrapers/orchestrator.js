// src/scrapers/orchestrator.js
// ─────────────────────────────────────────────────────────────
// Orchestrator v4 — Directional O2.5 / U2.5
//
// Workflow:
//   1. Query The-Odds-API for active soccer competitions (UK region)
//   2. Scrape SoccerSTATS for matches in bettable leagues
//   3. Score each match in both directions (O2.5 and U2.5)
//      → direction with higher score wins → one call per match
//   4. Fetch Over AND Under odds for shortlisted matches
//   5. Attach correct odds based on match direction
//   6. Run probability engine, apply floor, THEN log predictions
//   7. Scrape match details for top shortlisted
//   8. Write to disk
// ─────────────────────────────────────────────────────────────

const { scrapeMatchesPage, scrapeLeaguePage, scrapeMatchDetail } = require('./match-discovery');
const { buildShortlist } = require('../engine/shortlist');
const { analyseMatch } = require('../engine/probability');
const { logPrediction } = require('../engine/history');
const {
  buildBettableLeagueMap,
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
          if (bettableMap.has(oddsKey)) bettableSlugs.push(slug);
        }
        console.log(`[orchestrator] ${bettableSlugs.length} SoccerSTATS leagues are bettable`);
      } catch (e) {
        console.warn('[orchestrator] odds API failed, falling back to all leagues:', e.message);
      }
    }

    // ── Step 2: Scrape SoccerSTATS ────────────────────────
    refreshState.progress = 'Scraping matches page...';
    const { matches: todayMatches, leagueSlugs: todaySlugs } = await scrapeMatchesPage(1);

    refreshState.progress = 'Scraping tomorrow...';
    let tomorrowMatches = [];
    try {
      const tmrw = await scrapeMatchesPage(2);
      tomorrowMatches = tmrw.matches;
    } catch (e) {
      console.warn('[orchestrator] tomorrow scrape failed:', e.message);
    }

    const allScraped = [...todayMatches, ...tomorrowMatches];
    const deduped = new Map();
    for (const m of allScraped) {
      if (!deduped.has(m.id)) deduped.set(m.id, m);
    }
    let allMatches = Array.from(deduped.values());
    console.log(`[orchestrator] total scraped matches: ${allMatches.length}`);

    // ── Step 3: Tag bettable matches ──────────────────────
    if (bettableSlugs.length > 0) {
      for (const m of allMatches) {
        m.bettable = bettableSlugs.includes(m.leagueSlug);
        m.oddsKey = getOddsKey(m.leagueSlug) || null;
      }
      const bettableCount = allMatches.filter(m => m.bettable).length;
      console.log(`[orchestrator] ${bettableCount} bettable, ${allMatches.length - bettableCount} skipped`);
      refreshState.bettableCount = bettableCount;
    } else {
      for (const m of allMatches) m.bettable = null;
    }

    // ── Step 4: League stats for bettable leagues ─────────
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

    // ── Step 5: Directional scoring ───────────────────────
    refreshState.progress = 'Scoring matches (O2.5 vs U2.5)...';

    const matchesToScore = bettableSlugs.length > 0
      ? allMatches.filter(m => m.bettable)
      : allMatches;

    const { all: scored, shortlisted } = buildShortlist(matchesToScore, leagueStatsMap);

    console.log(`[orchestrator] shortlisted before prob filter: ${shortlisted.length}`);

    for (const m of [...scored, ...shortlisted]) {
      m.day = todayMatches.some(t => t.id === m.id) ? 'Today' : 'Tomorrow';
    }

    // ── Step 6: Fetch odds (Over AND Under) ───────────────
    if (config.ODDS_API_KEYS.length > 0 && shortlisted.length > 0) {
      refreshState.progress = 'Fetching Over/Under odds...';
      try {
        const oddsMap = await fetchOddsForShortlist(shortlisted);
        let matched = 0, unmatched = 0;

        for (const m of shortlisted) {
          const odds = matchOddsToMatch(m, oddsMap);
          if (odds) {
            m.odds = odds;
            matched++;
            const relevantOdds = m.direction === 'u25' ? odds.u25 : odds.o25;
            if (relevantOdds) {
              console.log(`[orchestrator] ${m.direction.toUpperCase()} ${m.homeTeam} vs ${m.awayTeam}: ${relevantOdds.price} (${relevantOdds.bookmaker})`);
            }
          } else {
            unmatched++;
          }
        }
        console.log(`[orchestrator] odds matched: ${matched}/${shortlisted.length} (${unmatched} unmatched)`);
      } catch (e) {
        console.warn('[orchestrator] odds fetch failed:', e.message);
      }
    }

    // ── Step 7: Probability engine + probability floor ────
    // IMPORTANT: logPrediction is called AFTER the floor filter.
    // Only matches that survive to the final visible shortlist get logged.
    // Logging before the filter pollutes history with sub-threshold predictions.
    refreshState.progress = 'Calculating probabilities...';
    const minProb = config.THRESHOLDS?.MIN_PROB || 0;

    // First pass: attach analysis to all shortlisted matches
    for (const m of shortlisted) {
      try {
        const analysis = analyseMatch(m, leagueStatsMap[m.leagueSlug] || {});
        m.analysis = analysis;
      } catch (e) {
        console.warn(`[orchestrator] probability failed for ${m.id}:`, e.message);
      }
    }

    // Second pass: apply probability floor, splice out failures
    // O2.5: P(O2.5) >= MIN_PROB
    // U2.5: P(U2.5) = 1 - P(O2.5) >= MIN_PROB
    const beforeFilter = shortlisted.length;
    if (minProb > 0) {
      for (let i = shortlisted.length - 1; i >= 0; i--) {
        const m = shortlisted[i];
        const prob = m.analysis?.o25?.probability;
        if (prob == null) { shortlisted.splice(i, 1); continue; }
        const dirProb = m.direction === 'u25' ? (1 - prob) : prob;
        if (dirProb < minProb) shortlisted.splice(i, 1);
      }
    }

    // Third pass: log only final survivors
    for (const m of shortlisted) {
      if (!m.analysis) continue;
      try {
        logPrediction(m, m.analysis);
      } catch (e) {
        console.warn(`[orchestrator] logPrediction failed for ${m.id}:`, e.message);
      }
    }

    const withProbs = shortlisted.filter(m => m.analysis).length;
    const withOdds  = shortlisted.filter(m => {
      const a = m.analysis;
      return a && (
        (m.direction === 'o25' && a.o25?.marketOdds != null) ||
        (m.direction === 'u25' && a.u25?.marketOdds != null)
      );
    }).length;
    const withEdge  = shortlisted.filter(m => {
      const a = m.analysis;
      return a && (
        (m.direction === 'o25' && a.o25?.edge != null) ||
        (m.direction === 'u25' && a.u25?.edge != null)
      );
    }).length;

    console.log(`[orchestrator] probabilities: ${withProbs} calculated, ${withOdds} with odds, ${withEdge} with edge, ${beforeFilter - shortlisted.length} filtered below MIN_PROB (${minProb * 100}%)`);

    // Recalculate direction counts after the probability floor has been applied
    const o25Count = shortlisted.filter(m => m.direction === 'o25').length;
    const u25Count = shortlisted.filter(m => m.direction === 'u25').length;
    console.log(`[orchestrator] shortlisted: ${shortlisted.length} (${o25Count} O2.5, ${u25Count} U2.5)`);

    // ── Step 8: Match details for top shortlisted ─────────
    if (scrapeDetails && shortlisted.length > 0) {
      const toDetail = shortlisted.slice(0, 20);
      refreshState.progress = `Fetching details for ${toDetail.length} matches...`;
      for (const match of toDetail) {
        if (match.matchUrl) {
          try {
            const detail = await scrapeMatchDetail(match.matchUrl);
            if (detail) { writeMatchDetail(match.id, detail); match.hasDetail = true; }
          } catch (e) {
            console.warn(`[orchestrator] detail failed for ${match.id}:`, e.message);
          }
        }
      }
    }

    // ── Step 9: Write to disk ─────────────────────────────
    refreshState.progress = 'Writing data...';
    writeJSON(config.DISCOVERED_FILE, scored);
    writeJSON(config.SHORTLIST_FILE, shortlisted);
    writeJSON(config.META_FILE, {
      lastRefresh:      new Date().toISOString(),
      totalScraped:     allMatches.length,
      bettableCount:    matchesToScore.length,
      scoredCount:      scored.length,
      shortlistCount:   shortlisted.length,
      o25Count,
      u25Count,
      bettableLeagues:  bettableSlugs.length,
      leaguesOnPage:    todaySlugs.length,
      leagueStatsFound: Object.keys(leagueStatsMap).length,
    });

    refreshState.status        = 'done';
    refreshState.lastRefresh   = new Date().toISOString();
    refreshState.matchCount    = scored.length;
    refreshState.shortlistCount= shortlisted.length;
    refreshState.bettableCount = matchesToScore.length;
    refreshState.progress      = 'Complete';
    refreshState.lastError     = null;

    console.log(`[orchestrator] done. ${allMatches.length} scraped → ${matchesToScore.length} bettable → ${shortlisted.length} shortlisted (${o25Count} O2.5, ${u25Count} U2.5)`);
    return refreshState;

  } catch (err) {
    refreshState.status    = 'error';
    refreshState.lastError = err.message;
    refreshState.progress  = `Error: ${err.message}`;
    console.error('[orchestrator] refresh failed:', err);
    return refreshState;
  }
}

module.exports = { runFullRefresh, getRefreshState };