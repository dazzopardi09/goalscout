// src/engine/settler.js
// ─────────────────────────────────────────────────────────────
// Result settler — finds completed matches and writes results.
//
// Runs on a schedule (every 2 hours via cron in index.js).
// Does NOT touch predictions.jsonl — immutable once written.
// Writes to results.jsonl only (append-only).
// Captures closing odds snapshots before kickoff.
//
// Settlement flow:
//   1. Read all predictions
//   2. Read all existing results (build a settled-fixture Set)
//   3. Find predictions past kickoff with no result yet
//   4. Group those by sport key, fetch scores from Odds API
//   5. Match scores back to fixtures via team name normalisation
//   6. Write result records
//   7. Capture closing odds for fixtures 30–90 mins from kickoff
//
// Fixture matching strategy:
//   - Primary:   commenceTime + normalised team names (most reliable)
//   - Fallback:  predictionDate + SoccerSTATS kickoff + leagueSlug
//     (for predictions where odds API didn't match at prediction time)
//
// Match status values written to results.jsonl:
//   'completed'  — full time score confirmed
//   'postponed'  — API returned postponed status
//   'cancelled'  — API returned cancelled/abandoned before KO
//   'abandoned'  — API returned abandoned mid-match
//   'unknown'    — kickoff was >24h ago, no result found anywhere
//
// Only 'completed' results are used in performance metrics.
// All others are treated as void.
// ─────────────────────────────────────────────────────────────

const { fetch } = require('undici');
const config = require('../config');
const { logResult, readJSONL } = require('./history');
const { normalise, SLUG_TO_ODDS_MAP } = require('../odds/the-odds-api');

// ── Constants ────────────────────────────────────────────────

// How long after kickoff before we attempt settlement (mins)
const SETTLE_AFTER_MINS = 120;

// How long before giving up and marking unknown (hours)
const ABANDON_AFTER_HOURS = 72;

// Window before kickoff to capture closing odds (mins)
const CLOSING_ODDS_WINDOW_MINS_MIN = 30;
const CLOSING_ODDS_WINDOW_MINS_MAX = 90;

// ── API key rotation (shared state, separate from main app) ──
let keyIndex = 0;
function getApiKey() {
  const keys = config.ODDS_API_KEYS;
  if (!keys || keys.length === 0) return null;
  const key = keys[keyIndex % keys.length];
  keyIndex++;
  return key;
}

// ── Fetch scores from The-Odds-API ───────────────────────────

/**
 * Fetch completed scores for a sport key.
 * The-Odds-API /scores endpoint returns recent completed events.
 * daysFrom=1 returns events from the last 1 day.
 */
async function fetchScoresForSport(sportKey, daysFrom = 2) {
  const key = getApiKey();
  if (!key) return null;

  const url = new URL(`https://api.the-odds-api.com/v4/sports/${sportKey}/scores`);
  url.searchParams.set('apiKey', key);
  url.searchParams.set('daysFrom', String(daysFrom));

  try {
    const res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(15000),
    });

    const remaining = res.headers.get('x-requests-remaining');
    if (remaining) {
      console.log(`[settler] scores API quota: ${remaining} remaining (key ...${key.slice(-6)})`);
    }

    if (!res.ok) {
      const body = await res.text();
      console.warn(`[settler] scores API ${res.status} for ${sportKey}: ${body.substring(0, 150)}`);
      return null;
    }

    const data = await res.json();
    return Array.isArray(data) ? data : null;
  } catch (err) {
    console.warn(`[settler] scores request failed for ${sportKey}:`, err.message);
    return null;
  }
}

/**
 * Fetch pre-match odds for a sport key (for closing odds capture).
 */
async function fetchCurrentOddsForSport(sportKey) {
  const key = getApiKey();
  if (!key) return null;

  const url = new URL(`https://api.the-odds-api.com/v4/sports/${sportKey}/odds`);
  url.searchParams.set('apiKey', key);
  url.searchParams.set('regions', config.ODDS_REGIONS || 'au,uk');
  url.searchParams.set('markets', 'totals');
  url.searchParams.set('oddsFormat', 'decimal');

  try {
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data) ? data : null;
  } catch (err) {
    console.warn(`[settler] current odds request failed for ${sportKey}:`, err.message);
    return null;
  }
}

// ── Match score events to predictions ────────────────────────

/**
 * Try to match a score event (from Odds API) to a prediction.
 * Returns true if this event matches the given prediction's fixture.
 */
function isMatchForPrediction(event, prediction) {
  const eHome = normalise(event.home_team || '');
  const eAway = normalise(event.away_team || '');
  const pHome = normalise(prediction.homeTeam || '');
  const pAway = normalise(prediction.awayTeam || '');

  // Strategy 1: normalised name exact match
  if (eHome === pHome && eAway === pAway) return true;

  // Strategy 2: substring match (handles "Man Utd" vs "Manchester United")
  if (
    (eHome.includes(pHome) || pHome.includes(eHome)) &&
    (eAway.includes(pAway) || pAway.includes(eAway))
  ) return true;

  // Strategy 3: commenceTime match if both have it (most reliable)
  if (prediction.commenceTime && event.commence_time) {
    if (prediction.commenceTime === event.commence_time) return true;
  }

  // Strategy 4: first-6-chars match (handles suffix differences)
  const h1 = pHome.substring(0, 6);
  const a1 = pAway.substring(0, 6);
  if (h1.length >= 4 && a1.length >= 4) {
    if (eHome.startsWith(h1) && eAway.startsWith(a1)) return true;
  }

  return false;
}

/**
 * Extract score from an Odds API scores event.
 * Returns null if the match is not completed.
 */
function extractScore(event) {
  if (!event.completed) return null;

  const scores = event.scores;
  if (!scores || !Array.isArray(scores)) return null;

  let homeGoals = null;
  let awayGoals = null;

  for (const s of scores) {
    if (s.name === event.home_team) homeGoals = parseInt(s.score, 10);
    if (s.name === event.away_team) awayGoals = parseInt(s.score, 10);
  }

  // Some events use 'home'/'away' as name instead of team name
  if (homeGoals === null || awayGoals === null) {
    for (const s of scores) {
      const name = (s.name || '').toLowerCase();
      if (name === 'home') homeGoals = parseInt(s.score, 10);
      if (name === 'away') awayGoals = parseInt(s.score, 10);
    }
  }

  if (homeGoals === null || awayGoals === null || isNaN(homeGoals) || isNaN(awayGoals)) {
    return null;
  }

  return { homeGoals, awayGoals };
}

// ── Build estimated UTC kickoff from prediction fields ────────

/**
 * For predictions that missed odds matching (commenceTime is null),
 * estimate a UTC kickoff from predictionDate + kickoff time (AEST).
 *
 * Key edge case: early-morning AEST times (00:00-09:59) cross midnight
 * backwards into the previous UTC day when attached to predictionDate.
 * e.g. predictionDate=2026-04-18, kickoff=01:00 AEST
 *      naive parse -> 2026-04-17T15:00Z (one day early, wrong)
 *      actual match -> 2026-04-18T15:00Z (Apr 19 01:00 AEST)
 *
 * Fix: if estimated kickoff is before predictionTimestamp (impossible),
 * add one day.
 */
function estimateKickoffUTC(prediction) {
  if (prediction.commenceTime) return new Date(prediction.commenceTime);

  if (!prediction.predictionDate || !prediction.kickoff) return null;

  try {
    const [hh, mm] = prediction.kickoff.split(':').map(Number);
    let kickoff = new Date(`${prediction.predictionDate}T${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}:00+10:00`);

    if (isNaN(kickoff.getTime())) return null;

    // If estimated kickoff predates when prediction was made, add one day
    const predMadeAt = prediction.predictionTimestamp
      ? new Date(prediction.predictionTimestamp)
      : new Date(`${prediction.predictionDate}T00:00:00Z`);

    if (kickoff < predMadeAt) {
      kickoff = new Date(kickoff.getTime() + 24 * 60 * 60 * 1000);
    }

    return kickoff;
  } catch {
    return null;
  }
}

// ── Core settler logic ────────────────────────────────────────

/**
 * Run a full settlement cycle.
 *
 * Returns a summary of what was settled.
 */
async function runSettlement() {
  console.log('[settler] starting settlement cycle...');

  if (config.ODDS_API_KEYS.length === 0) {
    console.warn('[settler] no API keys configured — cannot fetch scores');
    return { settled: 0, closingOdds: 0, skipped: 0, errors: 0 };
  }

  const predictions = readJSONL(config.PREDICTIONS_FILE);
  const existingResults = readJSONL(config.RESULTS_FILE);
  const closingSnapshots = readJSONL(config.CLOSING_ODDS_FILE);

  if (predictions.length === 0) {
    console.log('[settler] no predictions found, nothing to settle');
    return { settled: 0, closingOdds: 0, skipped: 0, errors: 0 };
  }

  // Build sets of what we already have
  const settledFixtures = new Set(existingResults.map(r => r.fixtureId));
  const closingCaptured = new Set(closingSnapshots.map(s => `${s.fixtureId}__${s.market}`));

  const now = new Date();
  const stats = { settled: 0, closingOdds: 0, skipped: 0, errors: 0 };

  // ── Identify fixtures needing attention ─────────────────────

  // De-duplicate predictions to one record per fixture (keep the richest)
  const fixtureMap = new Map(); // fixtureId → best prediction record
  for (const p of predictions) {
    const existing = fixtureMap.get(p.fixtureId);
    // Prefer records with commenceTime and marketOdds
    if (!existing || (!existing.commenceTime && p.commenceTime)) {
      fixtureMap.set(p.fixtureId, p);
    }
  }

  // Categorise fixtures
  const toSettle = [];       // need result fetched
  const forClosingOdds = []; // kickoff coming up, capture closing odds

  for (const [fixtureId, pred] of fixtureMap) {
    const kickoff = estimateKickoffUTC(pred);
    if (!kickoff) {
      console.warn(`[settler] can't determine kickoff for ${fixtureId}, skipping`);
      stats.skipped++;
      continue;
    }

    const minsFromKickoff = (now - kickoff) / 60000;
    const hoursFromKickoff = minsFromKickoff / 60;

    if (settledFixtures.has(fixtureId)) {
      // Already settled — check if we still need closing odds (pre-kickoff capture)
      // (unlikely but handle it)
      continue;
    }

    if (minsFromKickoff > SETTLE_AFTER_MINS) {
      // Match should be finished — try to settle
      if (hoursFromKickoff > ABANDON_AFTER_HOURS) {
        // Too long ago — mark as unknown and move on
        console.log(`[settler] ${fixtureId} is ${Math.round(hoursFromKickoff)}h old with no result — marking unknown`);
        logResult(fixtureId, {
          homeGoals: null,
          awayGoals: null,
          matchStatus: 'unknown',
          source: 'settler-timeout',
        });
        settledFixtures.add(fixtureId);
        stats.settled++;
      } else {
        toSettle.push({ fixtureId, pred, kickoff });
      }
    } else if (
      minsFromKickoff > -CLOSING_ODDS_WINDOW_MINS_MAX &&
      minsFromKickoff < -CLOSING_ODDS_WINDOW_MINS_MIN
    ) {
      // In the closing odds capture window (30–90 mins before kickoff)
      forClosingOdds.push({ fixtureId, pred });
    }
  }

  console.log(`[settler] ${toSettle.length} fixtures to settle, ${forClosingOdds.length} need closing odds`);

  // ── Fetch scores for fixtures needing settlement ─────────────

  if (toSettle.length > 0) {
    // Group by sport key to minimise API calls
    const bySportKey = new Map();
    for (const item of toSettle) {
      const sportKey = SLUG_TO_ODDS_MAP[item.pred.leagueSlug];
      if (!sportKey) {
        console.warn(`[settler] no sport key for slug ${item.pred.leagueSlug} (${item.fixtureId})`);
        stats.skipped++;
        continue;
      }
      if (!bySportKey.has(sportKey)) bySportKey.set(sportKey, []);
      bySportKey.get(sportKey).push(item);
    }

    for (const [sportKey, items] of bySportKey) {
      console.log(`[settler] fetching scores for ${sportKey} (${items.length} fixtures)...`);

      const scores = await fetchScoresForSport(sportKey, 3); // last 3 days
      if (!scores) {
        console.warn(`[settler] no scores returned for ${sportKey}`);
        stats.errors++;
        continue;
      }

      console.log(`[settler] got ${scores.length} score events for ${sportKey}`);

      for (const item of items) {
        if (settledFixtures.has(item.fixtureId)) continue;

        // Find the matching score event
        const event = scores.find(e => isMatchForPrediction(e, item.pred));

        if (!event) {
          console.log(`[settler] no score event found for ${item.fixtureId} (${item.pred.homeTeam} vs ${item.pred.awayTeam})`);
          // Don't mark unknown yet — might still be playing or API lag
          stats.skipped++;
          continue;
        }

        // Check event status
        if (!event.completed) {
          const status = (event.status || '').toLowerCase();
          if (status.includes('postponed')) {
            logResult(item.fixtureId, { homeGoals: null, awayGoals: null, matchStatus: 'postponed', source: 'odds-api' });
            settledFixtures.add(item.fixtureId);
            stats.settled++;
            console.log(`[settler] ${item.fixtureId} → postponed`);
          } else if (status.includes('cancel')) {
            logResult(item.fixtureId, { homeGoals: null, awayGoals: null, matchStatus: 'cancelled', source: 'odds-api' });
            settledFixtures.add(item.fixtureId);
            stats.settled++;
            console.log(`[settler] ${item.fixtureId} → cancelled`);
          } else {
            console.log(`[settler] ${item.fixtureId} not yet completed (status: ${event.status || 'unknown'})`);
            stats.skipped++;
          }
          continue;
        }

        const score = extractScore(event);
        if (!score) {
          console.warn(`[settler] completed event but couldn't extract score for ${item.fixtureId}`);
          stats.errors++;
          continue;
        }

        logResult(item.fixtureId, {
          homeGoals: score.homeGoals,
          awayGoals: score.awayGoals,
          matchStatus: 'completed',
          source: 'odds-api',
        });
        settledFixtures.add(item.fixtureId);
        stats.settled++;
        console.log(`[settler] ✓ ${item.fixtureId} → ${score.homeGoals}–${score.awayGoals}`);
      }

      // Small delay between sport key fetches to be kind to the API
      await sleep(500);
    }
  }

  // ── Capture closing odds ──────────────────────────────────────

  if (forClosingOdds.length > 0) {
    const bySportKey = new Map();
    for (const item of forClosingOdds) {
      const sportKey = SLUG_TO_ODDS_MAP[item.pred.leagueSlug];
      if (!sportKey) continue;
      if (!bySportKey.has(sportKey)) bySportKey.set(sportKey, []);
      bySportKey.get(sportKey).push(item);
    }

    for (const [sportKey, items] of bySportKey) {
      const odds = await fetchCurrentOddsForSport(sportKey);
      if (!odds) continue;

      for (const item of items) {
        // Find matching event
        const event = odds.find(e => isMatchForPrediction(e, item.pred));
        if (!event) continue;

        // Extract O2.5 closing odds
        let bestO25 = null;
        for (const bm of (event.bookmakers || [])) {
          for (const mkt of (bm.markets || [])) {
            if (mkt.key === 'totals') {
              const over = (mkt.outcomes || []).find(o => o.name === 'Over' && o.point === 2.5);
              if (over && (!bestO25 || over.price > bestO25.price)) {
                bestO25 = { price: over.price, bookmaker: bm.title };
              }
            }
          }
        }

        if (bestO25) {
          const snapKey = `${item.fixtureId}__over_2.5`;
          if (!closingCaptured.has(snapKey)) {
            logClosingOdds(item.fixtureId, 'over_2.5', bestO25.price, bestO25.bookmaker);
            closingCaptured.add(snapKey);
            stats.closingOdds++;
            console.log(`[settler] closing odds for ${item.fixtureId} O2.5: ${bestO25.price} (${bestO25.bookmaker})`);
          }
        }
      }

      await sleep(500);
    }
  }

  console.log(`[settler] done. settled=${stats.settled}, closingOdds=${stats.closingOdds}, skipped=${stats.skipped}, errors=${stats.errors}`);
  return stats;
}

// ── Closing odds logging ──────────────────────────────────────

const fs = require('fs');

function logClosingOdds(fixtureId, market, price, bookmaker) {
  const dir = config.HISTORY_DIR;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const line = JSON.stringify({
    fixtureId,
    market,
    capturedAt: new Date().toISOString(),
    snapshotType: 'closing',
    decimalOdds: price,
    bookmaker,
  }) + '\n';

  fs.appendFileSync(config.CLOSING_ODDS_FILE, line, 'utf8');
}

// ── Utility ───────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { runSettlement };