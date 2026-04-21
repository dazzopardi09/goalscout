'use strict';

const fs = require('fs');
const { HISTORICAL_LEAGUES, getHistoricalFilePath } = require('./historical-config');

function readFixturesFile(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return Array.isArray(raw) ? raw : [];
}

function loadHistoricalFixtures({ leagueKey = null } = {}) {
  const selected = leagueKey
    ? HISTORICAL_LEAGUES.filter(l => l.leagueKey === leagueKey)
    : HISTORICAL_LEAGUES;

  if (!selected.length) {
    throw new Error(`No historical league config found for leagueKey=${leagueKey}`);
  }

  const fixtures = selected.flatMap(l => readFixturesFile(getHistoricalFilePath(l.file)));

  return fixtures.sort((a, b) => new Date(a.kickoffUtc) - new Date(b.kickoffUtc));
}

module.exports = { loadHistoricalFixtures };