// src/api/routes.js
// ─────────────────────────────────────────────────────────────
// REST API — serves cached JSON to the frontend.
// NO live scraping happens here. All data is pre-cached.
//
// Endpoints:
//   GET /api/status                         → refresh state + meta
//   GET /api/shortlist                      → shortlisted matches
//   GET /api/matches                        → all discovered matches
//   GET /api/leagues                        → all discovered leagues
//   GET /api/match/:id                      → match detail (if scraped)
//   POST /api/refresh                       → trigger manual refresh
//   GET /api/context/index                  → backtest index (_index.json)
//   GET /api/context/backtest?league=&season= → backtest JSONL as JSON array
// ─────────────────────────────────────────────────────────────

const express = require('express');
const fs      = require('fs');
const path    = require('path');

const { readJSON, readMatchDetail } = require('../utils/storage');
const { runFullRefresh, getRefreshState } = require('../scrapers/orchestrator');
const { getPredictionStats, readJSONL } = require('../engine/history');
const config = require('../config');

const router = express.Router();

// ── Status ──────────────────────────────────────────────────

router.get('/status', (req, res) => {
  const meta = readJSON(config.META_FILE) || {};
  const state = getRefreshState();
  res.json({ ...state, meta });
});

// ── Shortlist ───────────────────────────────────────────────

router.get('/shortlist', (req, res) => {
  const data = readJSON(config.SHORTLIST_FILE) || [];
  res.json(data);
});

// ── All matches ─────────────────────────────────────────────

router.get('/matches', (req, res) => {
  const data = readJSON(config.DISCOVERED_FILE) || [];
  res.json(data);
});

// ── Leagues ─────────────────────────────────────────────────

router.get('/leagues', (req, res) => {
  const data = readJSON(config.LEAGUES_FILE) || [];
  res.json(data);
});

// ── Match detail ────────────────────────────────────────────

router.get('/match/:id', (req, res) => {
  const detail = readMatchDetail(req.params.id);
  if (!detail) {
    return res.status(404).json({ error: 'No detail scraped for this match' });
  }
  res.json(detail);
});

// ── Prediction history stats ────────────────────────────────

router.get('/stats', (req, res) => {
  const stats = getPredictionStats();
  res.json(stats);
});

// ── Raw prediction history ──────────────────────────────────

router.get('/predictions', (req, res) => {
  const predictions = readJSONL(config.PREDICTIONS_FILE);
  const limit = parseInt(req.query.limit) || 100;
  res.json(predictions.slice(-limit));
});

// ── Manual refresh ──────────────────────────────────────────

router.post('/refresh', async (req, res) => {
  const state = getRefreshState();
  if (state.status === 'running') {
    return res.status(409).json({ error: 'Refresh already running', ...state });
  }

  runFullRefresh().catch(err => {
    console.error('[api] background refresh error:', err);
  });

  res.json({ message: 'Refresh started', status: 'running' });
});

// ── Context Research: backtest index ──────────────────────────
//
// Returns _index.json from data/backtests/context_raw/.
// Used by the Research tab selector strip to populate dropdowns
// and show model/feature version metadata.

router.get('/context/index', (req, res) => {
  const indexFile = path.join(config.DATA_DIR, 'backtests', 'context_raw', '_index.json');
  const data = readJSON(indexFile);
  if (!data) {
    return res.json({ leagues: [], lastUpdated: null });
  }
  res.json(data);
});

// ── Context Research: backtest JSONL ──────────────────────────
//
// Returns the full backtest JSONL for a given league/season as a
// JSON array. All 380 rows (settled + skipped) are returned;
// client-side filtering handles the rest.
//
// Query params:
//   league  — e.g. "england"  (must match /^[a-z_]+$/)
//   season  — e.g. "2024_25"  (must match /^\d{4}_\d{2}$/)
//
// Returns 400 on invalid params, 404 if file not found.

router.get('/context/backtest', (req, res) => {
  const { league, season } = req.query;

  // Validate to prevent path traversal
  if (!league || !/^[a-z_]+$/.test(league)) {
    return res.status(400).json({ error: 'Invalid league parameter' });
  }
  if (!season || !/^\d{4}_\d{2}$/.test(season)) {
    return res.status(400).json({ error: 'Invalid season parameter (expected: 2024_25)' });
  }

  const file = path.join(
    config.DATA_DIR, 'backtests', 'context_raw',
    `${league}_${season}.jsonl`
  );

  if (!fs.existsSync(file)) {
    return res.status(404).json({ error: `No backtest found for ${league} ${season}` });
  }

  const rows = readJSONL(file);
  res.json(rows);
});

module.exports = router;