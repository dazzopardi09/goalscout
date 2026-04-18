// src/utils/storage.js
// ─────────────────────────────────────────────────────────────
// Simple JSON file storage — read, write, overwrite.
// ─────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const { DATA_DIR, DETAILS_DIR } = require('../config');

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(DETAILS_DIR, { recursive: true });
}

function writeJSON(filePath, data) {
  ensureDirs();
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);  // atomic overwrite
}

function readJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeMatchDetail(matchId, data) {
  ensureDirs();
  const safe = matchId.replace(/[^a-zA-Z0-9_-]/g, '_');
  writeJSON(path.join(DETAILS_DIR, `${safe}.json`), data);
}

function readMatchDetail(matchId) {
  const safe = matchId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return readJSON(path.join(DETAILS_DIR, `${safe}.json`));
}

module.exports = { writeJSON, readJSON, writeMatchDetail, readMatchDetail, ensureDirs };
