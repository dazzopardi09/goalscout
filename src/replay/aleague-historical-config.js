'use strict';

const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');

const HISTORICAL_LEAGUES = [
  { leagueKey: 'a_league', file: 'a_league_2025_26_fixtures.json' },
];

function getHistoricalFilePath(file) {
  return path.join(DATA_DIR, 'historical', file);
}

module.exports = {
  DATA_DIR,
  HISTORICAL_LEAGUES,
  getHistoricalFilePath,
};