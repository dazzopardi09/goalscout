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
const { applyCalibration } = require('../engine/calibration');

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

function getCalibratedGrade(prob) {
  if (prob == null) return '-';
  if (prob >= 0.85) return 'A+';
  if (prob >= 0.70) return 'A';
  if (prob >= 0.60) return 'B';
  return '-';
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

        // ── Step 7: Probability engine + parallel current/calibrated models ────
    refreshState.progress = 'Calculating probabilities...';
    const minProb = config.THRESHOLDS?.MIN_PROB || 0;

    // analyse every scored match once, then derive both model paths
    for (const m of scored) {
      try {
        const currentAnalysis = analyseMatch(m, leagueStatsMap[m.leagueSlug] || {});
        const rawO25 = currentAnalysis?.o25?.probability;

        const calibratedO25 = rawO25 != null
          ? applyCalibration(rawO25, m.leagueSlug)
          : null;

        const calibratedU25 = calibratedO25 != null
          ? Math.round((1 - calibratedO25) * 10000) / 10000
          : null;

        const calibratedAnalysis = currentAnalysis ? {
          ...currentAnalysis,
          o25: {
            ...currentAnalysis.o25,
            probability: calibratedO25,
            fairOdds: calibratedO25 ? Math.round((1 / calibratedO25) * 100) / 100 : null,
          },
          u25: {
            ...currentAnalysis.u25,
            probability: calibratedU25,
            fairOdds: calibratedU25 ? Math.round((1 / calibratedU25) * 100) / 100 : null,
          },
        } : null;

        m.methodAnalyses = {
          current: currentAnalysis,
          calibrated: calibratedAnalysis,
        };
      } catch (e) {
        console.warn(`[orchestrator] probability failed for ${m.id}:`, e.message);
      }
    }

    // current model = existing direction from shortlist/scoring engine
    const currentShortlisted = scored
      .filter(m => m.direction != null)
      .map(m => ({
        ...m,
        analysis: m.methodAnalyses?.current || null,
        method: 'current',
      }))
      .filter(m => {
        const prob = m.direction === 'u25'
          ? m.analysis?.u25?.probability
          : m.analysis?.o25?.probability;
        return prob != null && prob >= minProb;
      });

    // calibrated model = independent direction + shortlist from calibrated probabilities
    const calibratedShortlisted = scored
      .map(m => {
        const analysis = m.methodAnalyses?.calibrated;
        const o25 = analysis?.o25?.probability;
        const u25 = analysis?.u25?.probability;

        if (o25 == null || u25 == null) return null;

        const direction = o25 >= u25 ? 'o25' : 'u25';
        const dirProb = direction === 'o25' ? o25 : u25;

        if (dirProb < minProb) return null;

        return {
          ...m,
          direction,
          grade: getCalibratedGrade(dirProb),
          analysis,
          method: 'calibrated',
        };
      })
      .filter(Boolean);

    const currentIds = new Set(currentShortlisted.map(m => m.id));
    const calibratedIds = new Set(calibratedShortlisted.map(m => m.id));

    const assignSelectionType = (m, method) => {
      const inCurrent = currentIds.has(m.id);
      const inCalibrated = calibratedIds.has(m.id);
      if (inCurrent && inCalibrated) return 'both';
      return method === 'current' ? 'current_only' : 'calibrated_only';
    };

    currentShortlisted.forEach(m => { m.selectionType = assignSelectionType(m, 'current'); });
    calibratedShortlisted.forEach(m => { m.selectionType = assignSelectionType(m, 'calibrated'); });

    for (const m of currentShortlisted) {
      try {
        logPrediction(m, m.analysis, 'current', m.selectionType);
      } catch (e) {
        console.warn(`[orchestrator] logPrediction failed for ${m.id}/current:`, e.message);
      }
    }

    for (const m of calibratedShortlisted) {
      try {
        logPrediction(m, m.analysis, 'calibrated', m.selectionType);
      } catch (e) {
        console.warn(`[orchestrator] logPrediction failed for ${m.id}/calibrated:`, e.message);
      }
    }

    const shortlistForDetails = [...currentShortlisted, ...calibratedShortlisted]
      .filter((m, i, arr) => arr.findIndex(x => x.id === m.id && x.method === m.method) === i);

    console.log(`[orchestrator] current shortlist: ${currentShortlisted.length}, calibrated shortlist: ${calibratedShortlisted.length}, floor ${minProb * 100}%`);

    // ── Step 8: Match details for top shortlisted ─────────
        if (scrapeDetails && shortlistForDetails.length > 0) {
      const toDetail = shortlistForDetails.slice(0, 20);
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
    writeJSON(config.SHORTLIST_FILE, {
      current: currentShortlisted,
      calibrated: calibratedShortlisted,
      comparison: {
        overlapIds: [...currentIds].filter(id => calibratedIds.has(id)),
        currentOnlyIds: [...currentIds].filter(id => !calibratedIds.has(id)),
        calibratedOnlyIds: [...calibratedIds].filter(id => !currentIds.has(id)),
      },
    });
    writeJSON(config.META_FILE, {
      lastRefresh:      new Date().toISOString(),
      totalScraped:     allMatches.length,
      bettableCount:    matchesToScore.length,
      scoredCount:      scored.length,
      shortlistCount:   shortlistForDetails.length,
      currentShortlistCount: currentShortlisted.length,
      calibratedShortlistCount: calibratedShortlisted.length,
      bettableLeagues:  bettableSlugs.length,
      leaguesOnPage:    todaySlugs.length,
      leagueStatsFound: Object.keys(leagueStatsMap).length,
    });

    refreshState.status        = 'done';
    refreshState.lastRefresh   = new Date().toISOString();
    refreshState.matchCount    = scored.length;
    refreshState.shortlistCount = shortlistForDetails.length;
    refreshState.bettableCount = matchesToScore.length;
    refreshState.progress      = 'Complete';
    refreshState.lastError     = null;

    console.log(`[orchestrator] done. ${allMatches.length} scraped → ${matchesToScore.length} bettable → ${shortlistForDetails.length} unique shortlisted (${currentShortlisted.length} current, ${calibratedShortlisted.length} calibrated)`);
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