// src/engine/settler.js
// ─────────────────────────────────────────────────────────────
// Settlement engine.
//
// Responsibilities:
//   1. Fetch match scores from The-Odds-API /scores
//   2. Match scores to pending predictions by teams
//   3. Fetch current odds for CLV (closing line value) calculation
//   4. Call settlePrediction() and updatePreKickoffOdds() in history.js
//
// The-Odds-API /scores returns results for completed matches.
// We use the 'daysFrom' parameter to look back up to 3 days.
// ─────────────────────────────────────────────────────────────


const config = require('../config');
const { readJSONL, settlePrediction, updatePreKickoffOdds } = require('../engine/history');
const { getOddsKey } = require('../odds/the-odds-api');

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

// ── Team name normalisation ───────────────────────────────────

function stripDiacritics(str) {
  return (str || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function normalise(name) {
  return stripDiacritics(name || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\b(fc|ac|cf|sc|bk|fk|if|ik|sk|nk|as|sv|cd|club|athletic|atletico)\b/g, ' ')
    .replace(/\butd\b/g, 'united')
    .replace(/\bmtjylland\b/g, 'midtjylland')
    .replace(/\bkobenhavn\b/g, 'copenhagen')
    .replace(/\bnurnberg\b/g, 'nuremberg')
    .replace(/\bsaint etienne\b/g, 'st etienne')
    .replace(/\bdefensa y j\b/g, 'defensa y justicia')
    .replace(/\bd\.?\s*riestra\b/g, 'deportivo riestra')
    .replace(/\be\.?\s*rio cuarto\b/g, 'estudiantes rio cuarto')
    .replace(/\bestudiantes de rio cuarto\b/g, 'estudiantes rio cuarto')
    .replace(/\bman utd\b/g, 'manchester united')
    .replace(/\bman city\b/g, 'manchester city')
    .replace(/\bpsv eindhoven\b/g, 'psv')
    .replace(/\bpec zwolle\b/g, 'zwolle')
    .replace(/\bqpr\b/g, 'queens park rangers')
    .replace(/\bws wanderers\b/g, 'western sydney wanderers')
    .replace(/\bmacarthur fc\b/g, 'macarthur')
    .replace(/\bwellington phoenix\b/g, 'wellington')
    .replace(/\bbor\b/g, 'borussia')
    .replace(/\bgladbach\b/g, 'monchengladbach')
    .replace(/\bmgladbach\b/g, 'monchengladbach')
    .replace(/\bst\b/g, 'saint')
    .replace(/\s+/g, ' ')
    .trim();
}

function singleTeamMatch(a, b) {
  const na = normalise(a);
  const nb = normalise(b);

  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;

  const ta = na.split(' ').filter(Boolean);
  const tb = nb.split(' ').filter(Boolean);
  const common = ta.filter(t => tb.includes(t));
  const overlap = common.length / Math.max(ta.length, tb.length);

  return common.length >= 1 && overlap >= 0.4;
}

function teamsMatch(apiHome, apiAway, predHome, predAway) {
  const direct =
    singleTeamMatch(apiHome, predHome) &&
    singleTeamMatch(apiAway, predAway);

  if (direct) return true;

  return (
    singleTeamMatch(apiHome, predAway) &&
    singleTeamMatch(apiAway, predHome)
  );
}

// ── Fetch scores and settle ───────────────────────────────────

async function fetchScoresAndSettle() {
  const predictions = readJSONL(config.PREDICTIONS_FILE);
  const pending = predictions.filter(p => p.status === 'pending');

  if (pending.length === 0) {
    return { settled: 0, skipped: 0, errors: 0 };
  }

  console.log(`[settler] ${pending.length} pending predictions to check`);

  const sportKeys = new Set();
  for (const p of pending) {
    const key = getOddsKey(p.leagueSlug);
    if (key) sportKeys.add(key);
  }

  const allScores = [];

  for (const sportKey of sportKeys) {
    const scores = await oddsApiRequest(`/v4/sports/${sportKey}/scores`, {
      daysFrom: 3,
    });

    if (scores && Array.isArray(scores)) {
      allScores.push(...scores.map(s => ({ ...s, sportKey })));
    }
  }

  if (allScores.length === 0) {
    console.warn('[settler] ⚠️ no scores fetched — likely mapping issue');
    console.warn(`[settler] sportKeys attempted: ${[...sportKeys].join(', ')}`);
  }

  console.log(`[settler] fetched ${allScores.length} score records from API`);

  let settled = 0;
  let skipped = 0;
  let errors = 0;

  for (const p of pending) {
    try {
      const sportKey = getOddsKey(p.leagueSlug);
      if (!sportKey) {
        skipped++;
        continue;
      }

      const match = allScores.find(s => {
        if (!s.completed) return false;
        if (s.sportKey !== sportKey) return false;
        return teamsMatch(s.home_team, s.away_team, p.homeTeam, p.awayTeam);
      });

      if (!match) {
        skipped++;
        continue;
      }

      const homeScore = match.scores?.find(s => s.name === match.home_team);
      const awayScore = match.scores?.find(s => s.name === match.away_team);
      const homeGoals = homeScore ? parseInt(homeScore.score, 10) : null;
      const awayGoals = awayScore ? parseInt(awayScore.score, 10) : null;

      if (homeGoals == null || awayGoals == null) {
        skipped++;
        continue;
      }

      let closingOdds = null;

      const oddsData = await oddsApiRequest(`/v4/sports/${sportKey}/odds`, {
        regions: config.ODDS_REGIONS || 'au,uk',
        markets: 'totals',
        oddsFormat: 'decimal',
      });

      if (oddsData && Array.isArray(oddsData)) {
        const event = oddsData.find(e =>
          teamsMatch(e.home_team, e.away_team, p.homeTeam, p.awayTeam)
        );

        if (event) {
          for (const bk of event.bookmakers || []) {
            const market = bk.markets?.find(m => m.key === 'totals');
            if (!market) continue;

            const selection = p.market === 'over_2.5'
              ? market.outcomes?.find(o => o.name === 'Over' && parseFloat(o.point) === 2.5)
              : market.outcomes?.find(o => o.name === 'Under' && parseFloat(o.point) === 2.5);

            if (selection) {
              closingOdds = selection.price;
              break;
            }
          }
        }
      }

      const wasSettled = settlePrediction(
        p.fixtureId,
        p.market,
        p.method || 'current',
        { homeGoals, awayGoals, closingOdds }
      );

      if (wasSettled) {
        settled++;
        console.log(
          `[settler] settled ${p.homeTeam} vs ${p.awayTeam} [${p.method || 'current'}] (${p.market}): ${homeGoals}-${awayGoals}`
        );
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

async function fetchCurrentOddsForPending() {
  const predictions = readJSONL(config.PREDICTIONS_FILE);

  const now = Date.now();
  const window = 2 * 60 * 60 * 1000;

  const toUpdate = predictions.filter(p => {
    if (p.status !== 'pending') return false;
    if (p.preKickoffOdds != null) return false;
    if (!p.commenceTime) return false;
    const ko = new Date(p.commenceTime).getTime();
    return ko - now <= window;
  });

  if (toUpdate.length === 0) {
    return { updated: 0 };
  }

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
          ? market.outcomes?.find(o => o.name === 'Over' && parseFloat(o.point) === 2.5)
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

module.exports = { fetchScoresAndSettle, fetchCurrentOddsForPending };