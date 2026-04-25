// src/engine/settler.js
// ─────────────────────────────────────────────────────────────
// Settlement engine.
//
// Responsibilities:
//   1. Fetch match scores from The-Odds-API /scores (primary, daysFrom=3)
//   2. Cross-check against Football-Data.org where coverage exists
//   3. Settle predictions only when sources agree (or only one exists)
//   4. Log conflicts to settlement-conflicts.jsonl for manual review
//   5. Tag every settled prediction with resultSource
//   6. Update pre-kickoff odds via fetchCurrentOddsForPending()
//
// Eligibility guards (applied before any API call):
//   - commenceTime must be > 135 minutes ago (match likely complete)
//   - commenceTime must be < 3 days ago (within Odds API /scores window)
//   - Predictions with no commenceTime are attempted regardless
//
// Settlement logic per prediction:
//   Odds API result + FD agrees  → settle, resultSource: 'verified'
//   Odds API result only         → settle, resultSource: 'odds-api'
//   FD result only               → settle, resultSource: 'football-data'
//   Sources disagree             → mark 'conflict', log to conflicts file
//   No result from either        → skip (no_score_candidate)
//
// Skip-reason counters logged per sweep:
//   future_fixture               - kickoff hasn't happened yet
//   not_old_enough               - kicked off < 135 min ago
//   outside_odds_api_window      - kicked off > 3 days ago (scores dropped)
//   no_key                       - league slug not in SLUG_TO_ODDS_MAP
//   api_error                    - scores fetch failed for this sport
//   no_completed_scores_for_sport - sport returned no completed records
//   no_score_candidate           - completed scores exist but no team match
//   conflict                     - sources returned different scores
//   matched                      - settled successfully
// ─────────────────────────────────────────────────────────────

const fs = require('fs');
const config = require('../config');
const {
  readJSONL,
  settlePrediction,
  markConflict,
  logConflict,
  updatePreKickoffOdds,
} = require('../engine/history');
const { getOddsKey } = require('../odds/the-odds-api');
const { teamsMatch } = require('../utils/team-names');
const { lookupResult, hasCoverage } = require('../results/football-data');

// ── Eligibility thresholds ────────────────────────────────────
const MIN_AGE_MS      = 135 * 60 * 1000;        // 135 minutes
const MAX_AGE_MS      = 3 * 24 * 60 * 60 * 1000; // 3 days (Odds API /scores window)

// ── Kickoff proximity guard ───────────────────────────────────
// Reject Odds API score records that are more than 48h away from
// the prediction's stored commenceTime. Prevents double-leg collisions.
const KO_PROXIMITY_MS = 48 * 60 * 60 * 1000;

// ── lastSettlementChange ──────────────────────────────────────
// Updated only when at least one prediction is actually written.
// Module-level — survives within a container lifetime.
let lastSettlementChange = null;

function getLastSettlementChange() {
  return lastSettlementChange;
}

// ── Eligibility check ─────────────────────────────────────────

function classifyEligibility(p, now) {
  if (!p.commenceTime) return 'eligible'; // no time stored — attempt it

  const koMs = new Date(p.commenceTime).getTime();

  if (koMs > now) return 'future_fixture';
  if (now - koMs < MIN_AGE_MS) return 'not_old_enough';
  if (now - koMs > MAX_AGE_MS) return 'outside_odds_api_window';

  return 'eligible';
}

// ── Kickoff proximity guard ───────────────────────────────────

function isKickoffMatch(scoreRecord, prediction) {
  if (!prediction.commenceTime) return true;
  if (!scoreRecord.commence_time) return true;

  const diff = Math.abs(
    new Date(scoreRecord.commence_time).getTime() -
    new Date(prediction.commenceTime).getTime()
  );

  return diff <= KO_PROXIMITY_MS;
}

// ── Odds API request helper ───────────────────────────────────

async function oddsApiRequest(path, params = {}) {
  const keys = config.ODDS_API_KEYS;
  if (!keys || keys.length === 0) {
    console.warn('[settler] no ODDS_API_KEYS configured');
    return null;
  }

  const qs = new URLSearchParams(params).toString();

  for (const key of keys) {
    const url = `https://api.the-odds-api.com${path}?apiKey=${key}${qs ? `&${qs}` : ''}`;

    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });

      if (!resp.ok) {
        console.warn(`[settler] odds API ${path} returned ${resp.status} for key ...${key.slice(-6)}`);
        continue;
      }

      return await resp.json();
    } catch (err) {
      console.warn(`[settler] odds API request failed for key ...${key.slice(-6)}: ${err.message}`);
    }
  }

  return null;
}

// ── Fetch scores and settle ───────────────────────────────────

async function fetchScoresAndSettle() {
  const now = Date.now();
  const predictions = readJSONL(config.PREDICTIONS_FILE);
  const pending = predictions.filter(p => p.status === 'pending');

  if (pending.length === 0) {
    return { settled: 0, conflicts: 0, counters: {} };
  }

  // ── Eligibility pre-filter ────────────────────────────────
  const counters = {
    future_fixture:               0,
    not_old_enough:               0,
    outside_odds_api_window:      0,
    no_key:                       0,
    api_error:                    0,
    no_completed_scores_for_sport: 0,
    no_score_candidate:           0,
    conflict:                     0,
    matched:                      0,
  };

  const eligible = [];
  for (const p of pending) {
    const reason = classifyEligibility(p, now);
    if (reason !== 'eligible') {
      counters[reason]++;
    } else {
      eligible.push(p);
    }
  }

  console.log(`[settler] ${pending.length} pending — ${eligible.length} eligible, ${counters.future_fixture} future, ${counters.not_old_enough} not old enough, ${counters.outside_odds_api_window} outside window`);

  if (eligible.length === 0) {
    return { settled: 0, conflicts: 0, counters };
  }

  // ── Collect unique sport keys for eligible predictions ────
  const sportKeys = new Set();
  for (const p of eligible) {
    const key = getOddsKey(p.leagueSlug);
    if (key) sportKeys.add(key);
    else counters.no_key++;
  }

  // ── Fetch scores — one call per sport key, daysFrom=3 ────
  const allScores = [];
  const failedSportKeys = new Set();

  for (const sportKey of sportKeys) {
    const scores = await oddsApiRequest(`/v4/sports/${sportKey}/scores`, {
      daysFrom: 3,
    });

    if (scores && Array.isArray(scores)) {
      allScores.push(...scores.map(s => ({ ...s, sportKey })));
    } else {
      failedSportKeys.add(sportKey);
    }
  }

  if (allScores.length === 0 && sportKeys.size > 0) {
    console.warn('[settler] no scores fetched from Odds API');
  } else {
    const completed = allScores.filter(s => s.completed).length;
    console.log(`[settler] fetched ${allScores.length} score records (${completed} completed) from Odds API`);
  }

  // ── Pre-fetch closing odds ────────────────────────────────
  const allClosingOddsMap = new Map();

  for (const sportKey of sportKeys) {
    if (failedSportKeys.has(sportKey)) continue;
    const oddsData = await oddsApiRequest(`/v4/sports/${sportKey}/odds`, {
      regions: config.ODDS_REGIONS || 'au,uk',
      markets: 'totals',
      oddsFormat: 'decimal',
    });
    if (oddsData && Array.isArray(oddsData)) {
      allClosingOddsMap.set(sportKey, oddsData);
    }
  }

  // ── Settle each eligible prediction ──────────────────────
  let anyWritten = false;

  for (const p of eligible) {
    try {
      const sportKey = getOddsKey(p.leagueSlug);
      if (!sportKey) {
        // already counted above
        continue;
      }

      if (failedSportKeys.has(sportKey)) {
        counters.api_error++;
        continue;
      }

      // Completed scores for this sport
      const completedForSport = allScores.filter(
        s => s.sportKey === sportKey && s.completed
      );

      if (completedForSport.length === 0) {
        counters.no_completed_scores_for_sport++;
        continue;
      }

      // ── Find Odds API result ──────────────────────────────
      const oddsApiMatch = completedForSport.find(s => {
        if (!isKickoffMatch(s, p)) return false;
        return teamsMatch(s.home_team, s.away_team, p.homeTeam, p.awayTeam);
      });

      let oddsApiResult = null;
      if (oddsApiMatch) {
        const homeScore = oddsApiMatch.scores?.find(s => s.name === oddsApiMatch.home_team);
        const awayScore = oddsApiMatch.scores?.find(s => s.name === oddsApiMatch.away_team);
        const homeGoals = homeScore ? parseInt(homeScore.score, 10) : null;
        const awayGoals = awayScore ? parseInt(awayScore.score, 10) : null;
        if (homeGoals !== null && awayGoals !== null) {
          oddsApiResult = { homeGoals, awayGoals };
        }
      }

      // ── Find Football-Data result (if league is covered) ──
      let fdResult = null;
      if (hasCoverage(p.leagueSlug)) {
        fdResult = await lookupResult(p.leagueSlug, p.homeTeam, p.awayTeam, p.commenceTime);
      }

      // ── Determine settlement action ───────────────────────
      const hasOddsApi = oddsApiResult !== null;
      const hasFD      = fdResult !== null;

      if (!hasOddsApi && !hasFD) {
        counters.no_score_candidate++;
        continue;
      }

      if (hasOddsApi && hasFD) {
        if (
          oddsApiResult.homeGoals === fdResult.homeGoals &&
          oddsApiResult.awayGoals === fdResult.awayGoals
        ) {
          const closingOdds = getClosingOdds(p, allClosingOddsMap, sportKey);
          const wasSettled = settlePrediction(p.fixtureId, p.market, p.method || 'current', {
            homeGoals:    oddsApiResult.homeGoals,
            awayGoals:    oddsApiResult.awayGoals,
            closingOdds,
            resultSource: 'verified',
          });
          if (wasSettled) {
            counters.matched++;
            anyWritten = true;
            console.log(`[settler] verified ${p.homeTeam} vs ${p.awayTeam} [${p.method || 'current'}] (${p.market}): ${oddsApiResult.homeGoals}-${oddsApiResult.awayGoals}`);
          }
        } else {
          console.warn(`[settler] CONFLICT ${p.homeTeam} vs ${p.awayTeam}: OddsAPI=${oddsApiResult.homeGoals}-${oddsApiResult.awayGoals} FD=${fdResult.homeGoals}-${fdResult.awayGoals}`);
          logConflict(p, oddsApiResult, fdResult);
          markConflict(p.fixtureId, p.market, p.method || 'current');
          counters.conflict++;
          anyWritten = true;
        }
        continue;
      }

      // Only one source returned
      const result      = hasOddsApi ? oddsApiResult : fdResult;
      const source      = hasOddsApi ? 'odds-api' : 'football-data';
      const closingOdds = getClosingOdds(p, allClosingOddsMap, sportKey);

      const wasSettled = settlePrediction(p.fixtureId, p.market, p.method || 'current', {
        homeGoals:    result.homeGoals,
        awayGoals:    result.awayGoals,
        closingOdds,
        resultSource: source,
      });

      if (wasSettled) {
        counters.matched++;
        anyWritten = true;
        console.log(`[settler] settled [${source}] ${p.homeTeam} vs ${p.awayTeam} [${p.method || 'current'}] (${p.market}): ${result.homeGoals}-${result.awayGoals}`);
      }

    } catch (err) {
      console.error(`[settler] error settling ${p.homeTeam} vs ${p.awayTeam}:`, err.message);
      counters.api_error++;
    }
  }

  // ── Update lastSettlementChange only if data was written ──
  if (anyWritten) {
    lastSettlementChange = new Date().toISOString();
  }

  console.log(
    `[settler] sweep done — matched=${counters.matched} conflict=${counters.conflict}` +
    ` future=${counters.future_fixture} not_old_enough=${counters.not_old_enough}` +
    ` outside_window=${counters.outside_odds_api_window} no_key=${counters.no_key}` +
    ` api_error=${counters.api_error} no_completed=${counters.no_completed_scores_for_sport}` +
    ` no_candidate=${counters.no_score_candidate}`
  );

  return { settled: counters.matched, conflicts: counters.conflict, counters };
}

// ── Closing odds helper ───────────────────────────────────────

function getClosingOdds(p, closingOddsMap, sportKey) {
  const leagueOdds = closingOddsMap.get(sportKey);
  if (!leagueOdds || !Array.isArray(leagueOdds)) return null;

  const event = leagueOdds.find(e =>
    teamsMatch(e.home_team, e.away_team, p.homeTeam, p.awayTeam)
  );

  if (!event) return null;

  for (const bk of event.bookmakers || []) {
    const market = bk.markets?.find(m => m.key === 'totals');
    if (!market) continue;

    const selection = p.market === 'over_2.5'
      ? market.outcomes?.find(o => o.name === 'Over'  && parseFloat(o.point) === 2.5)
      : market.outcomes?.find(o => o.name === 'Under' && parseFloat(o.point) === 2.5);

    if (selection) return selection.price;
  }

  return null;
}

// ── Pre-kickoff odds update ───────────────────────────────────

async function fetchCurrentOddsForPending() {
  const predictions = readJSONL(config.PREDICTIONS_FILE);
  const now = Date.now();
  const window = 2 * 60 * 60 * 1000;

  const toUpdate = predictions.filter(p => {
    if (p.status !== 'pending') return false;
    if (p.preKickoffOdds != null) return false;
    if (!p.commenceTime) return false;
    const ko = new Date(p.commenceTime).getTime();
    const msToKo = ko - now;
    return msToKo > 15 * 60 * 1000 && msToKo <= window;
  });

  if (toUpdate.length === 0) return { updated: 0 };

  console.log(`[settler] fetching pre-KO odds for ${toUpdate.length} predictions`);

  let updated = 0;

  for (const p of toUpdate) {
    try {
      const sportKey = getOddsKey(p.leagueSlug);
      if (!sportKey) continue;

      const oddsData = await oddsApiRequest(`/v4/sports/${sportKey}/odds`, {
        regions: config.ODDS_REGIONS || 'au,uk',
        markets: 'totals',
        oddsFormat: 'decimal',
      });

      if (!oddsData || !Array.isArray(oddsData)) continue;

      const event = oddsData.find(e =>
        teamsMatch(e.home_team, e.away_team, p.homeTeam, p.awayTeam)
      );

      if (!event) continue;

      let currentPrice = null;

      for (const bk of event.bookmakers || []) {
        const market = bk.markets?.find(m => m.key === 'totals');
        if (!market) continue;

        const selection = p.market === 'over_2.5'
          ? market.outcomes?.find(o => o.name === 'Over'  && parseFloat(o.point) === 2.5)
          : market.outcomes?.find(o => o.name === 'Under' && parseFloat(o.point) === 2.5);

        if (selection) {
          currentPrice = selection.price;
          break;
        }
      }

      if (currentPrice == null) continue;

      const wasUpdated = updatePreKickoffOdds(
        p.fixtureId,
        p.market,
        p.method || 'current',
        currentPrice
      );

      if (wasUpdated) updated++;

      await new Promise(r => setTimeout(r, 300));
    } catch (err) {
      console.warn(`[settler] pre-KO odds fetch failed for ${p.homeTeam} vs ${p.awayTeam}:`, err.message);
    }
  }

  return { updated };
}


// ── Close-odds capture ────────────────────────────────────────
// Captures closingOdds for pending predictions whose kickoff is
// 3–15 minutes away. Runs on its own 5-minute cron.
//
// Guards:
//   - Only runs if commenceTime is known
//   - Only writes if closingOdds is currently null (never overwrites)
//   - Only writes if kickoff is still in the future (window enforces this)
//   - Only writes if the event is found unambiguously by team name
//   - Only writes if the 2.5 totals market and a price are present
//   - Never touches preKickoffOdds, preKickoffMovePct, or result logic
//
// clvPct is NOT calculated here. It is calculated in settlePrediction()
// once both marketOdds and closingOdds are available.
//
// Log counters emitted per sweep:
//   eligible, sportKeysFetched, captured, noMatch, noMarket, noPrice, errors

const CLOSE_WINDOW_MIN_MS =  3 * 60 * 1000; //  3 minutes
const CLOSE_WINDOW_MAX_MS = 15 * 60 * 1000; // 15 minutes

async function captureClosingOdds() {
  const now = Date.now();
  const predictions = readJSONL(config.PREDICTIONS_FILE);

  const eligible = predictions.filter(p => {
    if (p.status !== 'pending') return false;
    if (p.closingOdds != null) return false;   // already captured
    if (!p.commenceTime) return false;

    const koMs = new Date(p.commenceTime).getTime();
    const msToKo = koMs - now;

    return msToKo >= CLOSE_WINDOW_MIN_MS && msToKo <= CLOSE_WINDOW_MAX_MS;
  });

  if (eligible.length === 0) return { eligible: 0 };

  console.log(`[close-capture] ${eligible.length} eligible predictions in close window`);

  // Group by sportKey — one API call per key
  const byKey = new Map();
  for (const p of eligible) {
    const key = getOddsKey(p.leagueSlug);
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(p);
  }

  const counters = {
    eligible:         eligible.length,
    sportKeysFetched: 0,
    captured:         0,
    noMatch:          0,
    noMarket:         0,
    noPrice:          0,
    errors:           0,
  };

  for (const [sportKey, preds] of byKey) {
    let oddsData;
    try {
      oddsData = await oddsApiRequest(`/v4/sports/${sportKey}/odds`, {
        regions:    config.ODDS_REGIONS || 'au,uk',
        markets:    'totals',
        oddsFormat: 'decimal',
      });
      counters.sportKeysFetched++;
    } catch (err) {
      console.warn(`[close-capture] fetch failed for ${sportKey}: ${err.message}`);
      counters.errors += preds.length;
      continue;
    }

    if (!oddsData || !Array.isArray(oddsData)) {
      console.warn(`[close-capture] unexpected response for ${sportKey}`);
      counters.errors += preds.length;
      continue;
    }

    for (const p of preds) {
      try {
        // Find the event — must be unambiguous (teamsMatch handles normalisation)
        const matches = oddsData.filter(e =>
          teamsMatch(e.home_team, e.away_team, p.homeTeam, p.awayTeam)
        );

        if (matches.length === 0) {
          counters.noMatch++;
          continue;
        }

        if (matches.length > 1) {
          // Ambiguous — more than one event matched, skip to avoid wrong data
          console.warn(`[close-capture] ambiguous match for ${p.homeTeam} vs ${p.awayTeam} (${matches.length} results) — skipping`);
          counters.noMatch++;
          continue;
        }

        const event = matches[0];

        // Find the 2.5 totals market
        let closePrice = null;
        for (const bk of event.bookmakers || []) {
          const mkt = bk.markets?.find(m => m.key === 'totals');
          if (!mkt) continue;

          const outcome = p.market === 'over_2.5'
            ? mkt.outcomes?.find(o => o.name === 'Over'  && parseFloat(o.point) === 2.5)
            : mkt.outcomes?.find(o => o.name === 'Under' && parseFloat(o.point) === 2.5);

          if (outcome?.price) {
            closePrice = outcome.price;
            break;
          }
        }

        if (closePrice == null) {
          counters.noPrice++;
          continue;
        }

        // Write closingOdds + timestamp — do not touch any other field
        const allPreds = readJSONL(config.PREDICTIONS_FILE);
        let wrote = false;

        const updated = allPreds.map(r => {
          if (
            r.fixtureId !== p.fixtureId ||
            r.market !== p.market ||
            (r.method || 'current') !== (p.method || 'current')
          ) return r;

          if (r.closingOdds != null) return r; // guard: never overwrite

          wrote = true;
          return {
            ...r,
            closingOdds:             closePrice,
            closingOddsCapturedAt:   new Date().toISOString(),
          };
        });

        if (wrote) {
          fs.writeFileSync(
            config.PREDICTIONS_FILE,
            updated.map(l => JSON.stringify(l)).join('\n') + '\n',
            'utf8'
          );
          counters.captured++;
          console.log(`[close-capture] captured ${p.homeTeam} vs ${p.awayTeam} [${p.market}]: ${closePrice}`);
        }

      } catch (err) {
        console.warn(`[close-capture] error for ${p.homeTeam} vs ${p.awayTeam}: ${err.message}`);
        counters.errors++;
      }
    }
  }

  console.log(
    `[close-capture] done — eligible=${counters.eligible}` +
    ` fetched=${counters.sportKeysFetched} captured=${counters.captured}` +
    ` noMatch=${counters.noMatch} noMarket=${counters.noMarket}` +
    ` noPrice=${counters.noPrice} errors=${counters.errors}`
  );

  return counters;
}

module.exports = { fetchScoresAndSettle, fetchCurrentOddsForPending, getLastSettlementChange, captureClosingOdds };