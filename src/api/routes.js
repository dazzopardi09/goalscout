// src/api/routes.js
// ─────────────────────────────────────────────────────────────
// REST API — serves cached JSON to the frontend.
// NO live scraping happens here. All data is pre-cached.
//
// Endpoints:
//   GET /api/status       → refresh state + meta
//   GET /api/shortlist    → shortlisted matches
//   GET /api/matches      → all discovered matches
//   GET /api/leagues      → all discovered leagues
//   GET /api/match/:id    → match detail (if scraped)
//   POST /api/refresh     → trigger manual refresh
//
// Future extension endpoints (not implemented):
//   GET /api/odds/:id     → bookmaker odds for a match
//   GET /api/value        → value-flagged matches
//   POST /api/execute     → place a bet (phase 3)
// ─────────────────────────────────────────────────────────────

const express = require('express');
const { readJSON, readMatchDetail } = require('../utils/storage');
const { runFullRefresh, getRefreshState } = require('../scrapers/orchestrator');
const { runSettlement } = require('../engine/settler');
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

// ── Manual settlement trigger ───────────────────────────────

router.post('/settle', async (req, res) => {
  console.log('[api] manual settlement triggered');
  try {
    const result = await runSettlement();
    res.json({ message: 'Settlement complete', ...result });
  } catch (err) {
    console.error('[api] settlement error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;