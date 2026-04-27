// src/scrapers/orchestrator.js
// ─────────────────────────────────────────────────────────────
// Orchestrator v4 — Directional O2.5 / U2.5
//
// Workflow:
//   1. Query The-Odds-API for active soccer competitions (UK region)
//   2. Scrape SoccerSTATS for matches in bettable leagues (today only)
//   3. Score each match in both directions (O2.5 and U2.5)
//      → direction with higher score wins → one call per match
//   4. Fetch Over AND Under odds for ALL matches with a clear direction
//      (not just the scoring shortlist — calibrated needs its own pool)
//   5. Attach correct odds based on match direction
//   6. Run probability engine, apply floor, THEN log predictions
//   7. Scrape match details for top shortlisted
//   8. Write to disk
//
// KEY ARCHITECTURE NOTE:
//   Odds are fetched for ALL bettable matches that have a clear direction
//   (o25score != u25score), not just those that passed the scoring threshold.
//   This gives the calibrated model its own independent candidate pool
//   instead of being forced to choose only from the current shortlist.
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
const { writeJSON, readJSON, writeMatchDetail } = require('../utils/storage');
const config = require('../config');
const { applyCalibration } = require('../engine/calibration');
const { scoreContext }          = require('../engine/context-shortlist');
const { computeRollingStats }   = require('../engine/rolling-stats');
const { logContextPredictions } = require('../engine/context-predictions');
const { fetchRollingResults }   = require('../results/football-data');
const { singleTeamMatch }       = require('../utils/team-names');

// ── Context_raw rolling stats helpers ────────────────────────────────────────
//
// Football-Data.org competition codes for the two paper-tracked leagues.
// England (PL) and Germany (BL1) are the only leagues with validated
// backtest signals from Stage 8. Netherlands and others remain
// research-only in the Research tab.
const CONTEXT_FD_CODES = { england: 'PL', germany: 'BL1' };
 
/**
 * Fetch the last 8 weeks of finished matches from Football-Data.org
 * for a league and compute per-team rolling last-6 stats.
 *
 * Returns Map<fdOrgTeamName, rollingStats>.
 * Returns empty Map if FD.org data is unavailable (API error, no token, etc.)
 *
 * @param {string} leagueSlug - 'england' | 'germany'
 */
async function buildRollingMap(leagueSlug) {
  const code = CONTEXT_FD_CODES[leagueSlug];
  if (!code) return new Map();
 
  const fdMatches = await fetchRollingResults(code);
  if (!fdMatches || fdMatches.length === 0) return new Map();
 
  // Convert FD.org format to what computeRollingStats expects.
  // date must be a Date object; other derived boolean fields are required.
  const adapted = fdMatches.map(m => ({
    date:        new Date(m.utcDate),
    homeTeam:    m.homeTeam,
    awayTeam:    m.awayTeam,
    homeGoals:   m.homeGoals,
    awayGoals:   m.awayGoals,
    totalGoals:  m.homeGoals + m.awayGoals,
    result_o25:  (m.homeGoals + m.awayGoals) > 2.5,
    result_u25:  (m.homeGoals + m.awayGoals) <= 2.5,
    result_btts: m.homeGoals > 0 && m.awayGoals > 0,
  }));
 
  // Collect every unique team in the FD.org dataset
  const teams = new Set();
  adapted.forEach(m => { teams.add(m.homeTeam); teams.add(m.awayTeam); });
 
  // cutoff = now: all adapted matches are completed, so "before now" includes all of them
  const now = new Date();
  const rollingMap = new Map();
  for (const team of teams) {
    rollingMap.set(team, computeRollingStats(team, adapted, now));
  }
 
  return rollingMap;
}
 
/**
 * Find rolling stats for a SoccerSTATS team name in an FD.org-keyed rolling map.
 *
 * FD.org uses full legal names ("Arsenal FC", "Manchester City FC") while
 * SoccerSTATS uses shorter display names ("Arsenal", "Man City"). This function
 * bridges the gap using singleTeamMatch() — the same normalisation/alias logic
 * used by teamsMatch() in settler.js.
 *
 * Returns the rolling stats object, or null if no match found.
 *
 * @param {string} ssTeamName - SoccerSTATS display team name
 * @param {Map}    rollingMap - Map<fdOrgTeamName, rollingStats> from buildRollingMap()
 */
function lookupRolling(ssTeamName, rollingMap) {
  if (!ssTeamName || !rollingMap || rollingMap.size === 0) return null;
 
  // Direct match (handles the few cases where names happen to be identical)
  if (rollingMap.has(ssTeamName)) return rollingMap.get(ssTeamName);
 
  // Fuzzy match: normalises both names (strip "FC", diacritics, aliases),
  // then checks token overlap. Threshold ≥ 0.4 overlap OR one is a substring.
  for (const [fdName, rolling] of rollingMap) {
    if (singleTeamMatch(fdName, ssTeamName)) return rolling;
  }
 
  return null;
}

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

    // ── Step 2: Scrape SoccerSTATS today only ─────────────
    refreshState.progress = 'Scraping today\'s matches...';
    const { matches: todayMatches, leagueSlugs: todaySlugs } = await scrapeMatchesPage(1);
    console.log('[debug] leagues on SoccerSTATS today:', todaySlugs.length, todaySlugs);

    const deduped = new Map();
    for (const m of todayMatches) {
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
    const scrapedSlugs = [...new Set(allMatches.map(m => m.leagueSlug))];
    const slugsToScrape = bettableSlugs.length > 0
      ? scrapedSlugs.filter(slug => bettableSlugs.includes(slug))
      : scrapedSlugs;

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

    for (const m of scored) {
      m.day = 'Today';
    }

    // ── Step 6: Fetch odds for ALL matches with a clear direction ──
    //
    // IMPORTANT: odds are fetched for every scored match that has a
    // clear direction (not a tie), NOT just the scoring shortlist.
    // This is what allows the calibrated model to independently
    // shortlist matches that the scoring system's threshold excluded.
    // Without this, calibrated can only choose from the current
    // shortlist and the two models are guaranteed to converge.
    if (config.ODDS_API_KEYS.length > 0) {
      // All scored matches with a clear direction are odds candidates.
      // The scoring shortlist is a strict subset of this.
      const oddsCandidates = scored.filter(m => m.direction != null);

      if (oddsCandidates.length > 0) {
        refreshState.progress = 'Fetching Over/Under odds...';
        try {
          const oddsMap = await fetchOddsForShortlist(oddsCandidates);
          let matched = 0, unmatched = 0;

          for (const m of oddsCandidates) {
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

          console.log(`[orchestrator] odds matched: ${matched}/${oddsCandidates.length} (${unmatched} unmatched)`);
        } catch (e) {
          console.warn('[orchestrator] odds fetch failed:', e.message);
        }
      }
    }

    // ── Step 7: Probability engine + parallel current/calibrated models ────
    refreshState.progress = 'Calculating probabilities...';
    const minProb = config.THRESHOLDS?.MIN_PROB || 0;

    // Analyse every scored match once, then derive both model paths.
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

    // Current model: uses direction from the scoring engine.
    // Only includes matches that passed the scoring threshold (via shortlisted).
    const currentShortlisted = shortlisted
      .map(m => ({
        ...m,
        analysis: m.methodAnalyses?.current || null,
        method: 'current',
      }))
      .filter(m => {
        const prob = m.direction === 'u25'
          ? m.analysis?.u25?.probability
          : m.analysis?.o25?.probability;
        if (prob == null || prob < minProb) return false;
        // Require odds for the recommended direction.
        const relevantOdds = m.direction === 'u25' ? m.odds?.u25 : m.odds?.o25;
        return relevantOdds?.price != null;
      });

    // Calibrated model: direction from calibrated probabilities, independent of
    // the scoring engine's threshold. Draws from ALL scored matches that have
    // a clear direction AND odds — not just the scoring shortlist.
    const calibratedShortlisted = scored
      .filter(m => m.direction != null) // must have a clear direction
      .map(m => {
        const analysis = m.methodAnalyses?.calibrated;
        const o25 = analysis?.o25?.probability;
        const u25 = analysis?.u25?.probability;

        if (o25 == null || u25 == null) return null;

        const direction = o25 >= u25 ? 'o25' : 'u25';
        const dirProb = direction === 'o25' ? o25 : u25;

        if (dirProb < minProb) return null;

        // Require odds for the calibrated direction.
        const relevantOdds = direction === 'u25' ? m.odds?.u25 : m.odds?.o25;
        if (!relevantOdds?.price) return null;

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

    // ── Step 7.5: context_raw paper-tracking — England + Germany only ─────────
    //
    // Scores today's scored matches with the context_raw model (per-team last-6
    // rolling stats from Football-Data.org) and logs predictions to
    // predictions.jsonl alongside the current/calibrated predictions.
    //
    // Architecture constraints:
    //   - Does NOT modify scored[], shortlisted, or either shortlist array.
    //   - Runs silently if FD.org data is unavailable (API error, no token).
    //   - Only England and Germany are paper-tracked (validated Stage 8 signals).
    //   - 1X2 odds not available in live pipeline — CDO flag uses gf_avg fallback.
    //   - Prediction records carry method:'context_raw' and status:'pending'
    //     so settler.js handles them independently of current/calibrated records.
    //
    // contextShortlisted is populated here and written to shortlist.json so the
    // frontend can show context_raw predictions alongside current/calibrated.
    // It is strictly read-only from the current/calibrated perspective.
    let contextShortlisted = [];
    {
      const CONTEXT_SLUGS = new Set(['england', 'germany']);
      const contextCandidates = scored.filter(m => CONTEXT_SLUGS.has(m.leagueSlug));
 
      if (contextCandidates.length > 0) {
        refreshState.progress = 'Scoring context_raw predictions...';
 
        // One FD.org API call per paper-tracked league, result cached for 4h.
        const rollingByLeague = new Map();
        for (const slug of CONTEXT_SLUGS) {
          if (!contextCandidates.some(m => m.leagueSlug === slug)) continue;
          try {
            const map = await buildRollingMap(slug);
            rollingByLeague.set(slug, map);
            console.log(`[orchestrator] context rolling: ${map.size} teams loaded for ${slug}`);
          } catch (e) {
            console.warn(`[orchestrator] context rolling failed for ${slug}:`, e.message);
          }
        }
 
        // Score every candidate with context_raw and collect results
        const contextItems = [];
        let noRollingCount = 0;
 
        for (const m of contextCandidates) {
          const rollingMap = rollingByLeague.get(m.leagueSlug);
          if (!rollingMap) continue;
 
          const homeRolling = lookupRolling(m.homeTeam, rollingMap);
          const awayRolling = lookupRolling(m.awayTeam, rollingMap);
 
          if (!homeRolling || !awayRolling) {
            // Team not found in FD.org data: too early in season, or name mismatch.
            // Log at debug level — expected for first few GWs of a new season.
            console.log(`[orchestrator] context: no rolling data for ${m.homeTeam} vs ${m.awayTeam} (${m.leagueSlug})`);
            noRollingCount++;
            continue;
          }
 
          // 1X2 odds not available — scoreContext falls back to gf_avg proxy
          // for favourite/underdog determination (CDO flag).
          const ctxScored = scoreContext(homeRolling, awayRolling, {
            oddsHomeOpen: null,
            oddsAwayOpen: null,
          });
 
          contextItems.push({ match: m, scored: ctxScored, homeRolling, awayRolling });
        }
 
        if (contextItems.length > 0) {
          // Assign selectionType BEFORE logging so it is stored in predictions.jsonl.
          // Direction-aware: key = match.id + '__' + ctxScored.direction.
          // Stored at log time so Performance can group settled results without
          // recomputing historical shortlist state.
          {
            const curDirKeys = new Set(currentShortlisted.map(m => m.id + '__' + (m.direction || 'none')));
            const calDirKeys = new Set(calibratedShortlisted.map(m => m.id + '__' + (m.direction || 'none')));
            const curIds = new Set(currentShortlisted.map(m => m.id));
            const calIds = new Set(calibratedShortlisted.map(m => m.id));
            for (const item of contextItems) {
              if (item.scored.skip) continue;
              const dir = item.scored.direction || 'none';
              const sameKey = item.match.id + '__' + dir;
              if (curDirKeys.has(sameKey) || calDirKeys.has(sameKey)) {
                item.selectionType = 'context_confirms';
              } else if (curIds.has(item.match.id) || calIds.has(item.match.id)) {
                item.selectionType = 'context_disagrees';
              } else {
                item.selectionType = 'context_only';
              }
            }
          }
          // Logs predictions with calibration fields, deduplication, status:'pending',
          // and selectionType. Filters to England/Germany; skips scored.skip === true.
          logContextPredictions(contextItems);
        }
 
        const active = contextItems.filter(i => !i.scored.skip).length;
        console.log(
          `[orchestrator] context_raw: ${active} predictions logged` +
          ` (${contextItems.length - active} model-skipped,` +
          ` ${noRollingCount} no-rolling-data,` +
          ` ${contextCandidates.length} candidates in ${[...CONTEXT_SLUGS].join('/')})`
        );

        // Build contextShortlisted for the shortlist API response.
        // Only active (non-skipped) predictions with odds are included.
        // This array is independent of current/calibrated — it is read-only
        // from their perspective and does not affect their shortlists.
        const ctxSelectionTypeMap = new Map();
        for (const i of contextItems) {
          if (!i.scored.skip && i.selectionType) {
            ctxSelectionTypeMap.set(i.match.id + '__' + (i.scored.direction || 'none'), i.selectionType);
          }
        }

        contextShortlisted = contextItems
          .filter(i => !i.scored.skip)
          .map(({ match, scored: ctxScored, homeRolling, awayRolling }) => {
            const direction  = ctxScored.direction;
            const oddsData   = direction === 'o25' ? match.odds?.o25 : match.odds?.u25;
            const modelProb  = direction === 'o25'
              ? ctxScored.context_o25_prob_raw
              : ctxScored.context_u25_prob_raw;
            const fairOdds   = ctxScored.fairOdds;
            const marketOdds = oddsData?.price ?? null;
            const edge       = (marketOdds && fairOdds)
              ? Math.round(((marketOdds / fairOdds) - 1) * 10000) / 100
              : null;

            return {
              ...match,
              method:    'context_raw',
              direction,
              grade:     ctxScored.grade,
              // analysis-compatible shape so the Shortlist accordion renders correctly
              analysis: {
                o25: {
                  probability: ctxScored.context_o25_prob_raw,
                  fairOdds:    direction === 'o25' ? fairOdds : (ctxScored.context_o25_prob_raw > 0 ? Math.round((1 / ctxScored.context_o25_prob_raw) * 100) / 100 : null),
                  edge:        direction === 'o25' ? edge : null,
                  marketOdds:  direction === 'o25' ? marketOdds : null,
                },
                u25: {
                  probability: ctxScored.context_u25_prob_raw,
                  fairOdds:    direction === 'u25' ? fairOdds : (ctxScored.context_u25_prob_raw > 0 ? Math.round((1 / ctxScored.context_u25_prob_raw) * 100) / 100 : null),
                  edge:        direction === 'u25' ? edge : null,
                  marketOdds:  direction === 'u25' ? marketOdds : null,
                },
              },
              contextScored:   ctxScored,
              homeRollingSnap: homeRolling,
              awayRollingSnap: awayRolling,
              selectionType: ctxSelectionTypeMap.get(match.id + '__' + (ctxScored.direction || 'none')) || null,
            };
          });

        console.log(`[orchestrator] context_raw shortlist: ${contextShortlisted.length} matches`);
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

    // ── Step 9: Preserve in-progress matches from previous shortlist ──
    try {
      const prevShortlist = readJSON(config.SHORTLIST_FILE) || {};
      const nowMs = Date.now();
      const THREE_HOURS_MS = 3 * 60 * 60 * 1000;

      function isInProgress(m) {
        if (!m.commenceTime) return false;
        const ko = new Date(m.commenceTime).getTime();
        return ko < nowMs && (nowMs - ko) < THREE_HOURS_MS;
      }

      const newCurrentIds = new Set(currentShortlisted.map(m => m.id));
      const carried = (prevShortlist.current || [])
        .filter(m => isInProgress(m) && !newCurrentIds.has(m.id));
      if (carried.length > 0) {
        console.log(`[orchestrator] carrying ${carried.length} in-progress match(es) from previous shortlist`);
        currentShortlisted.push(...carried);
      }

      const newCalibratedIds = new Set(calibratedShortlisted.map(m => m.id));
      const carriedCalibrated = (prevShortlist.calibrated || [])
        .filter(m => isInProgress(m) && !newCalibratedIds.has(m.id));
      if (carriedCalibrated.length > 0) {
        calibratedShortlisted.push(...carriedCalibrated);
      }
    } catch (e) {
      console.warn('[orchestrator] in-progress carry-forward failed:', e.message);
    }

    // ── Step 10: Write to disk ─────────────────────────────
    refreshState.progress = 'Writing data...';
    writeJSON(config.DISCOVERED_FILE, scored);
    writeJSON(config.SHORTLIST_FILE, {
      current: currentShortlisted,
      calibrated: calibratedShortlisted,
      context_raw: contextShortlisted,
      comparison: {
        overlapIds: [...currentIds].filter(id => calibratedIds.has(id)),
        currentOnlyIds: [...currentIds].filter(id => !calibratedIds.has(id)),
        calibratedOnlyIds: [...calibratedIds].filter(id => !currentIds.has(id)),
        // context_raw overlap fields — direction-aware (key = id + '__' + direction).
        allThreeOverlapIds: contextShortlisted
          .filter(c => {
            const key = c.id + '__' + (c.direction || 'none');
            return currentShortlisted.some(m => m.id + '__' + (m.direction || 'none') === key) &&
                   calibratedShortlisted.some(m => m.id + '__' + (m.direction || 'none') === key);
          })
          .map(c => c.id + '__' + (c.direction || 'none')),
        currentContextOverlapIds: contextShortlisted
          .filter(c => {
            const key = c.id + '__' + (c.direction || 'none');
            return currentShortlisted.some(m => m.id + '__' + (m.direction || 'none') === key);
          })
          .map(c => c.id + '__' + (c.direction || 'none')),
        calibratedContextOverlapIds: contextShortlisted
          .filter(c => {
            const key = c.id + '__' + (c.direction || 'none');
            return calibratedShortlisted.some(m => m.id + '__' + (m.direction || 'none') === key);
          })
          .map(c => c.id + '__' + (c.direction || 'none')),
        contextOnlyIds: contextShortlisted
          .filter(c => c.selectionType === 'context_only')
          .map(c => c.id + '__' + (c.direction || 'none')),
        contextDisagreementIds: contextShortlisted
          .filter(c => c.selectionType === 'context_disagrees')
          .map(c => c.id + '__' + (c.direction || 'none')),
      },
    });
    writeJSON(config.META_FILE, {
      lastRefresh:                  new Date().toISOString(),
      totalScraped:                 allMatches.length,
      bettableCount:                matchesToScore.length,
      scoredCount:                  scored.length,
      shortlistCount:               shortlistForDetails.length,
      currentShortlistCount:        currentShortlisted.length,
      calibratedShortlistCount:     calibratedShortlisted.length,
      bettableLeagues:              bettableSlugs.length,
      leaguesOnPage:                todaySlugs.length,
      leagueStatsFound:             Object.keys(leagueStatsMap).length,
    });

    refreshState.status         = 'done';
    refreshState.lastRefresh    = new Date().toISOString();
    refreshState.matchCount     = scored.length;
    refreshState.shortlistCount = shortlistForDetails.length;
    refreshState.bettableCount  = matchesToScore.length;
    refreshState.progress       = 'Complete';
    refreshState.lastError      = null;

    console.log(`[orchestrator] done. ${allMatches.length} scraped → ${matchesToScore.length} bettable → ${shortlistForDetails.length} unique shortlisted (${currentShortlisted.length} current, ${calibratedShortlisted.length} calibrated, ${contextShortlisted.length} context_raw)`);
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