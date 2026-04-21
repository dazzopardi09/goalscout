'use strict';

const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');

const HISTORICAL_LEAGUES = [
  { leagueKey: 'epl', file: 'epl_2025_26_fixtures.json' },
  { leagueKey: 'a_league', file: 'a_league_2025_26_fixtures.json' },
  { leagueKey: 'eredivisie', file: 'eredivisie_2025_26_fixtures.json' },
  { leagueKey: 'danish_superliga', file: 'danish_superliga_2025_26_fixtures.json' },
  { leagueKey: 'belgian_pro_league', file: 'belgian_pro_league_2025_26_fixtures.json' },
  { leagueKey: 'austrian_bundesliga', file: 'austrian_bundesliga_2025_26_fixtures.json' },
];

function getHistoricalFilePath(file) {
  return path.join(DATA_DIR, 'historical', file);
}

module.exports = {
  DATA_DIR,
  HISTORICAL_LEAGUES,
  getHistoricalFilePath,
};