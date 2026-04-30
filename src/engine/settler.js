// src/engine/settler.js
// ─────────────────────────────────────────────────────────────
// Settlement engine.
//
// Responsibilities:
//   1. Fetch match scores from The-Odds-API /scores
//   2. Match scores to pending predictions by commence_time + teams
//   3. Fetch current odds for CLV (closing line value) calculation
//   4. Call settlePrediction() and updatePreKickoffOdds() in history.js
//   5. Capture near-close odds 3–15 minutes before kickoff (captureClosingOdds)
//
// CLV note:
//   closingOdds is written by captureClosingOdds() 3–15 min before kickoff.
//   settlePrediction() uses resolvedClosingOdds = closingOdds ?? p.closingOdds,
//   so a clean capture is never overwritten by the settlement-time odds fetch.
//   updatePreKickoffOdds() only writes preKickoffOdds + preKickoffMovePct.
//
// The-Odds-API /scores returns results for completed matches.
// We use the 'daysFrom' parameter to look back up to 3 days.
// ─────────────────────────────────────────────────────────────

const fs     = require('fs');
const config = require('../config');
const { readJSONL } = require('../engine/history');
const { settlePrediction, updatePreKickoffOdds } = require('../engine/history');

// ── Odds API request helper ───────────────────────────────────

async function oddsApiRequest(path, params = {}) {
  const keys = config.ODDS_API_KEYS;
  if (!keys || keys.length === 0) {
    console.warn('[settler] no ODDS_API_KEYS configured');
    return null;
  }

  const qs = new URLSearchParams(params).toString();
  const url = `https://api.the-odds-api.com${path}?apiKey=${keys[0]}${qs ? '&' + qs : ''}`;

  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) {
      console.warn(`[settler] odds API ${path} returned ${resp.status}`);
      return null;
    }
    return await resp.json();
  } catch (err) {
    console.warn(`[settler] odds API request failed: ${err.message}`);
    return null;
  }
}

// ── Team name normalisation ───────────────────────────────────

function normalise(name) {
  return (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function teamsMatch(apiHome, apiAway, predHome, predAway) {
  const ah = normalise(apiHome), aa = normalise(apiAway);
  const ph = normalise(predHome), pa = normalise(predAway);
  // Full match or one side contains the other
  const homeOk = ah === ph || ah.includes(ph) || ph.includes(ah);
  const awayOk = aa === pa || aa.includes(pa) || pa.includes(aa);
  return homeOk && awayOk;
}

// ── Fetch scores and settle ───────────────────────────────────

/**
 * Main settlement function.
 * Fetches scores for all sports that have pending predictions,
 * matches them to predictions, and writes results.
 */
async function fetchScoresAndSettle() {
  const predictions = readJSONL(config.PREDICTIONS_FILE);
  const pending = predictions.filter(p => p.status === 'pending');

  if (pending.length === 0) {
    return { settled: 0, skipped: 0, errors: 0 };
  }

  console.log(`[settler] ${pending.length} pending predictions to check`);

  // Get unique sport keys from pending predictions via leagueSlug
  // We need to map league slugs to odds-api sport keys
  // Use the same mapping as the-odds-api.js
  const { mapLeagueSlugToSportKey } = require('../odds/the-odds-api');

  // Collect all sport keys we need scores for
  const sportKeys = new Set();
  for (const p of pending) {
    const key = mapLeagueSlugToSportKey ? mapLeagueSlugToSportKey(p.leagueSlug) : null;
    if (key) sportKeys.add(key);
  }

  // Also try a broad soccer scores fetch if we can't map all
  // The-Odds-API supports fetching scores for all soccer events at once
  const allScores = [];

  // Try fetching scores per sport key (more targeted, uses fewer API credits)
  for (const sportKey of sportKeys) {
    const scores = await oddsApiRequest(`/v4/sports/${sportKey}/scores`, {
      daysFrom: 3,
    });
    if (scores && Array.isArray(scores)) {
      allScores.push(...scores);
    }
  }

  // If we got no scores via sport keys (mapping failed), try main soccer leagues
  if (allScores.length === 0) {
    console.log('[settler] sport key mapping returned no scores, trying broad fetch');
    const mainLeagues = [
      'soccer_epl', 'soccer_germany_bundesliga', 'soccer_italy_serie_a',
      'soccer_spain_la_liga', 'soccer_france_ligue_one', 'soccer_turkey_super_league',
      'soccer_denmark_superliga', 'soccer_south_korea_kleague1',
      'soccer_argentina_primera_division',
    ];
    for (const key of mainLeagues) {
      const scores = await oddsApiRequest(`/v4/sports/${key}/scores`, { daysFrom: 3 });
      if (scores && Array.isArray(scores)) allScores.push(...scores);
      // Small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 200));
    }
  }

  console.log(`[settler] fetched ${allScores.length} score records from API`);

  let settled = 0, skipped = 0, errors = 0;

  for (const p of pending) {
    try {
      // Find matching event in scores
      const match = allScores.find(s => {
        if (!s.completed) return false; // only settle completed matches
        return teamsMatch(s.home_team, s.away_team, p.homeTeam, p.awayTeam);
      });

      if (!match) {
        skipped++;
        continue;
      }

      // Extract final score
      const homeScore = match.scores?.find(s => s.name === match.home_team);
      const awayScore = match.scores?.find(s => s.name === match.away_team);
      const homeGoals = homeScore ? parseInt(homeScore.score) : null;
      const awayGoals = awayScore ? parseInt(awayScore.score) : null;

      if (homeGoals == null || awayGoals == null) {
        skipped++;
        continue;
      }

      // Try to get closing odds for CLV calculation
      // Use the last available odds before the match completed
      let closingOdds = null;
      if (p.leagueSlug) {
        const sportKey = mapLeagueSlugToSportKey ? mapLeagueSlugToSportKey(p.leagueSlug) : null;
        if (sportKey) {
          const oddsData = await oddsApiRequest(`/v4/sports/${sportKey}/odds`, {
            regions: 'uk',
            markets: 'totals',
            oddsFormat: 'decimal',
          });
          if (oddsData && Array.isArray(oddsData)) {
            const event = oddsData.find(e =>
              teamsMatch(e.home_team, e.away_team, p.homeTeam, p.awayTeam)
            );
            if (event) {
              // Find the over/under 2.5 line from Pinnacle or best sharp book
              for (const bk of event.bookmakers || []) {
                const market = bk.markets?.find(m => m.key === 'totals');
                if (!market) continue;
                const selection = p.market === 'over_2.5'
                  ? market.outcomes?.find(o => o.name === 'Over'  && parseFloat(o.point) === 2.5)
                  : market.outcomes?.find(o => o.name === 'Under' && parseFloat(o.point) === 2.5);
                if (selection) {
                  closingOdds = selection.price;
                  break;
                }
              }
            }
          }
        }
      }

      const wasSettled = settlePrediction(p.fixtureId, p.market, {
        homeGoals,
        awayGoals,
        closingOdds,
      });

      if (wasSettled) {
        settled++;
        console.log(`[settler] settled ${p.homeTeam} vs ${p.awayTeam} (${p.market}): ${homeGoals}-${awayGoals}`);
      } else {
        skipped++;
      }

    } catch (err) {
      console.error(`[settler] error settling ${p.homeTeam} vs ${p.awayTeam}:`, err.message);
      errors++;
    }
  }

  console.log(`[settler] done. settled=${settled} skipped=${skipped} errors=${errors}`);
  return { settled, skipped, errors };
}

// ── Pre-kickoff odds update ───────────────────────────────────

/**
 * Fetch current odds for all pending predictions and store as pre-KO odds.
 * This should be called ~60-90 minutes before kickoff.
 * In practice, call it from a cron or manually via POST /api/pre-kickoff.
 */
async function fetchCurrentOddsForPending() {
  const predictions = readJSONL(config.PREDICTIONS_FILE);

  // Only update predictions that:
  // - are still pending
  // - don't already have pre-KO odds
  // - have a commenceTime within the next 120 minutes OR already past
  const now = Date.now();
  const window = 2 * 60 * 60 * 1000; // 2 hours

  const toUpdate = predictions.filter(p => {
    if (p.status !== 'pending') return false;
    if (p.preKickoffOdds != null) return false;
    if (!p.commenceTime) return false;
    const ko = new Date(p.commenceTime).getTime();
    return ko - now <= window; // within 2 hours of kickoff
  });

  if (toUpdate.length === 0) {
    return { updated: 0 };
  }

  console.log(`[settler] fetching pre-KO odds for ${toUpdate.length} predictions`);

  const { mapLeagueSlugToSportKey } = require('../odds/the-odds-api');
  let updated = 0;

  for (const p of toUpdate) {
    try {
      const sportKey = mapLeagueSlugToSportKey ? mapLeagueSlugToSportKey(p.leagueSlug) : null;
      if (!sportKey) continue;

      const oddsData = await oddsApiRequest(`/v4/sports/${sportKey}/odds`, {
        regions: 'uk,au',
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
        if (selection) { currentPrice = selection.price; break; }
      }

      if (currentPrice == null) continue;

      const wasUpdated = updatePreKickoffOdds(p.fixtureId, p.market, currentPrice);
      if (wasUpdated) updated++;

      await new Promise(r => setTimeout(r, 300));

    } catch (err) {
      console.warn(`[settler] pre-KO odds fetch failed for ${p.homeTeam} vs ${p.awayTeam}:`, err.message);
    }
  }

  return { updated };
}

// ── Near-close odds capture ───────────────────────────────────
//
// Captures odds 3–15 minutes before kickoff for pending predictions.
// Writes closingOdds + closingOddsCapturedAt only — no other fields touched.
// Never overwrites an existing closingOdds value.
//
// Batches predictions by sportKey so there is at most one Odds API call
// per league per sweep. Returns diagnostic counters for log inspection.
//
// Ported from origin/fix/settlement-validation (fca442c).
// Adaptations from source:
//   - teamsMatch used inline (not imported from utils/team-names)
//   - mapLeagueSlugToSportKey used (not getOddsKey)
//   - config.ODDS_REGIONS || 'au' (not 'au,uk')

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

  const { mapLeagueSlugToSportKey } = require('../odds/the-odds-api');

  // Group by sportKey — one API call per key
  const byKey = new Map();
  for (const p of eligible) {
    const key = mapLeagueSlugToSportKey ? mapLeagueSlugToSportKey(p.leagueSlug) : null;
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
        regions:    config.ODDS_REGIONS || 'au',
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
        // Find the event — must be unambiguous
        const matches = oddsData.filter(e =>
          teamsMatch(e.home_team, e.away_team, p.homeTeam, p.awayTeam)
        );

        if (matches.length === 0) {
          counters.noMatch++;
          continue;
        }

        if (matches.length > 1) {
          // Ambiguous — skip to avoid writing wrong data
          console.warn(`[close-capture] ambiguous match for ${p.homeTeam} vs ${p.awayTeam} (${matches.length} results) — skipping`);
          counters.noMatch++;
          continue;
        }

        const event = matches[0];

        // Resolve which side we want — must be explicitly over or under 2.5.
        // Three canonical signals checked in order: market, selection, direction.
        // If none matches, skip — do not guess or fall through to Under by default.
        const wantsOver  = p.market === 'over_2.5'  || p.selection === 'over'  || p.direction === 'o25';
        const wantsUnder = p.market === 'under_2.5' || p.selection === 'under' || p.direction === 'u25';

        if (!wantsOver && !wantsUnder) {
          counters.noMarket++;
          continue;
        }

        // Find the 2.5 totals market for the correct side
        let closePrice = null;
        for (const bk of event.bookmakers || []) {
          const mkt = bk.markets?.find(m => m.key === 'totals');
          if (!mkt) continue;

          const outcome = wantsOver
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

        // Write closingOdds + timestamp — do not touch any other field.
        // Re-read the file before each write so concurrent cron ticks
        // do not clobber each other's output.
        const allPreds = readJSONL(config.PREDICTIONS_FILE);
        let wrote = false;

        const updated = allPreds.map(r => {
          if (
            r.fixtureId !== p.fixtureId ||
            r.market    !== p.market    ||
            (r.method || 'current') !== (p.method || 'current')
          ) return r;

          if (r.closingOdds != null) return r; // idempotency guard: never overwrite

          wrote = true;
          return {
            ...r,
            closingOdds:           closePrice,
            closingOddsCapturedAt: new Date().toISOString(),
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
module.exports = { fetchScoresAndSettle, fetchCurrentOddsForPending, captureClosingOdds };
