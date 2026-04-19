// src/engine/settler.js
// ─────────────────────────────────────────────────────────────
// Settlement engine.
//
// Responsibilities:
//   1. Fetch match scores from The-Odds-API /scores
//   2. Match scores to pending predictions by commence_time + teams
//   3. Fetch current odds for CLV (closing line value) calculation
//   4. Call settlePrediction() and updatePreKickoffOdds() in history.js
//
// The-Odds-API /scores returns results for completed matches.
// We use the 'daysFrom' parameter to look back up to 3 days.
// ─────────────────────────────────────────────────────────────

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

module.exports = { fetchScoresAndSettle, fetchCurrentOddsForPending };