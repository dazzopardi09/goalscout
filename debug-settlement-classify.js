// debug-settlement-classify.js
// daysFrom=3 is the maximum valid value for The Odds API /scores endpoint.
const config = require('./src/config');
const { readJSONL } = require('./src/engine/history');
const { getOddsKey } = require('./src/odds/the-odds-api');
const { teamsMatch } = require('./src/utils/team-names');
const { fetch } = require('undici');

const DAYS_FROM = 3;
const NOW = Date.now();

async function main() {
  const preds = readJSONL(config.PREDICTIONS_FILE);
  const pending = preds.filter(p => p.status === 'pending');
  console.log('Total pending: ' + pending.length);

  const apiKey = config.ODDS_API_KEYS[0];
  if (!apiKey) { console.error('No API key'); process.exit(1); }

  const byKey = new Map();
  const noKey = [];
  for (const p of pending) {
    const key = getOddsKey(p.leagueSlug);
    if (!key) { noKey.push(p); continue; }
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(p);
  }

  const reasons = {
    matched: [],
    future_fixture: [],
    fixture_outside_scores_window: [],
    no_completed_scores_for_sport: [],
    team_mismatch_possible: [],
    api_error: [],
    no_key: noKey,
  };

  const earliestWindowMs = NOW - DAYS_FROM * 24 * 60 * 60 * 1000;

  for (const [sportKey, sportPreds] of byKey) {
    const url = 'https://api.the-odds-api.com/v4/sports/' + sportKey + '/scores?daysFrom=' + DAYS_FROM + '&apiKey=' + apiKey;
    let scores = [];
    let apiError = false;

    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
      const data = await res.json();
      if (!Array.isArray(data)) {
        console.warn('  [' + sportKey + '] API error: ' + JSON.stringify(data).slice(0, 120));
        reasons.api_error.push(
          ...sportPreds.map(p => Object.assign({}, p, { _note: data.message || 'API error' }))
        );
        apiError = true;
      } else {
        scores = data;
      }
    } catch (err) {
      console.warn('  [' + sportKey + '] fetch failed: ' + err.message);
      reasons.api_error.push(
        ...sportPreds.map(p => Object.assign({}, p, { _note: 'fetch error: ' + err.message }))
      );
      apiError = true;
    }

    if (apiError) continue;

    const completed = scores.filter(s => s.completed);
    const future = scores.filter(s => !s.completed && new Date(s.commence_time).getTime() > NOW);
    console.log('[' + sportKey + '] total=' + scores.length + ' completed=' + completed.length + ' future=' + future.length);

    for (const p of sportPreds) {
      const koMs = p.commenceTime ? new Date(p.commenceTime).getTime() : null;

      if (koMs && koMs > NOW) {
        reasons.future_fixture.push(p);
        continue;
      }

      if (koMs && koMs < earliestWindowMs) {
        reasons.fixture_outside_scores_window.push(Object.assign({}, p, {
          _note: 'KO ' + new Date(koMs).toISOString() + ' is older than ' + DAYS_FROM + 'd window (max daysFrom=3)'
        }));
        continue;
      }

      if (completed.length === 0) {
        reasons.no_completed_scores_for_sport.push(Object.assign({}, p, { _note: 'no completed records in window' }));
        continue;
      }

      const match = completed.find(s => teamsMatch(s.home_team, s.away_team, p.homeTeam, p.awayTeam));
      if (match) {
        reasons.matched.push(Object.assign({}, p, { _apiHome: match.home_team, _apiAway: match.away_team }));
        continue;
      }

      const candidates = completed
        .filter(s => s.commence_time)
        .map(s => ({
          home: s.home_team,
          away: s.away_team,
          ko: s.commence_time,
          diffH: koMs ? Math.abs(new Date(s.commence_time).getTime() - koMs) / 3600000 : null,
        }))
        .sort((a, b) => (a.diffH != null ? a.diffH : 9999) - (b.diffH != null ? b.diffH : 9999));

      const closeCandidates = candidates.filter(c => c.diffH != null && c.diffH <= 12);

      if (closeCandidates.length > 0) {
        reasons.team_mismatch_possible.push(Object.assign({}, p, { _candidates: closeCandidates.slice(0, 3) }));
      } else {
        reasons.no_completed_scores_for_sport.push(Object.assign({}, p, {
          _note: 'no completed match within 12h of KO',
          _nearest: candidates[0] ? '"' + candidates[0].home + '" vs "' + candidates[0].away + '" (' + (candidates[0].diffH != null ? candidates[0].diffH.toFixed(1) + 'h away' : 'unknown offset') + ')' : 'none'
        }));
      }
    }
  }

  console.log('');
  console.log('=== SETTLEMENT SKIP REASON SUMMARY ===');
  console.log('matched:                        ' + reasons.matched.length);
  console.log('future_fixture:                 ' + reasons.future_fixture.length);
  console.log('fixture_outside_scores_window:  ' + reasons.fixture_outside_scores_window.length);
  console.log('no_completed_scores_for_sport:  ' + reasons.no_completed_scores_for_sport.length);
  console.log('team_mismatch_possible:         ' + reasons.team_mismatch_possible.length);
  console.log('api_error:                      ' + reasons.api_error.length);
  console.log('no_key:                         ' + reasons.no_key.length);

  if (reasons.matched.length > 0) {
    console.log('');
    console.log('--- MATCHED (would settle) ---');
    for (const p of reasons.matched) {
      console.log('  ' + p.homeTeam + ' vs ' + p.awayTeam + ' (' + p.leagueSlug + ')');
      console.log('    API name: "' + p._apiHome + '" vs "' + p._apiAway + '"');
    }
  }

  if (reasons.future_fixture.length > 0) {
    console.log('');
    console.log('--- FUTURE FIXTURES (not yet played) ---');
    for (const p of reasons.future_fixture) {
      console.log('  ' + p.homeTeam + ' vs ' + p.awayTeam + ' (' + p.leagueSlug + ') KO: ' + p.commenceTime);
    }
  }

  if (reasons.fixture_outside_scores_window.length > 0) {
    console.log('');
    console.log('--- OUTSIDE 3-DAY SCORES WINDOW (permanently unsettleable via Odds API) ---');
    for (const p of reasons.fixture_outside_scores_window) {
      console.log('  ' + p.homeTeam + ' vs ' + p.awayTeam + ' (' + p.leagueSlug + ')');
      console.log('    ' + p._note);
    }
  }

  if (reasons.no_completed_scores_for_sport.length > 0) {
    console.log('');
    console.log('--- NO COMPLETED SCORES IN WINDOW ---');
    for (const p of reasons.no_completed_scores_for_sport) {
      console.log('  ' + p.homeTeam + ' vs ' + p.awayTeam + ' (' + p.leagueSlug + ') -- ' + (p._note || ''));
      if (p._nearest) console.log('    nearest: ' + p._nearest);
    }
  }

  if (reasons.api_error.length > 0) {
    console.log('');
    console.log('--- API ERRORS ---');
    for (const p of reasons.api_error) {
      console.log('  ' + p.homeTeam + ' vs ' + p.awayTeam + ' (' + p.leagueSlug + ') -- ' + (p._note || ''));
    }
  }

  if (reasons.no_key.length > 0) {
    console.log('');
    console.log('--- NO ODDS API KEY (slug not mapped) ---');
    for (const p of reasons.no_key) {
      console.log('  ' + p.homeTeam + ' vs ' + p.awayTeam + ' (' + p.leagueSlug + ')');
    }
  }

  if (reasons.team_mismatch_possible.length > 0) {
    console.log('');
    console.log('--- POSSIBLE TEAM NAME MISMATCH (fixture within 12h, names differ) ---');
    for (const p of reasons.team_mismatch_possible) {
      console.log('');
      console.log('  Prediction: "' + p.homeTeam + '" vs "' + p.awayTeam + '" (' + p.leagueSlug + ')');
      console.log('  KO: ' + (p.commenceTime || 'unknown'));
      console.log('  Nearest completed fixtures by kickoff time:');
      for (const c of p._candidates) {
        const diffStr = c.diffH != null ? c.diffH.toFixed(1) + 'h apart' : 'unknown offset';
        console.log('    "' + c.home + '" vs "' + c.away + '" @ ' + c.ko + ' (' + diffStr + ')');
      }
    }
  }

  console.log('');
  console.log('=== END ===');
}

main().catch(console.error);