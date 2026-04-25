// src/api/routes.js
// ─────────────────────────────────────────────────────────────
// REST API — serves cached JSON to the frontend.
//
// Endpoints:
//   GET  /api/status        → refresh state + meta + lastSettlementChange
//   GET  /api/shortlist     → shortlisted matches
//   GET  /api/matches       → all discovered matches
//   GET  /api/leagues       → all discovered leagues
//   GET  /api/match/:id     → match detail (if scraped)
//   GET  /api/stats         → performance stats
//   GET  /api/predictions   → raw prediction history
//   GET  /api/conflicts     → settlement conflicts log
//   POST /api/refresh       → trigger manual refresh
//   POST /api/settle        → fetch results + settle pending predictions
//   POST /api/pre-kickoff   → fetch current odds and update pre-KO prices
// ─────────────────────────────────────────────────────────────

const express = require('express');
const { readJSON, readMatchDetail } = require('../utils/storage');
const { runFullRefresh, getRefreshState } = require('../scrapers/orchestrator');
const {
  getPredictionStats,
  readJSONL,
} = require('../engine/history');
const { fetchScoresAndSettle, fetchCurrentOddsForPending } = require('../engine/settler');
const config = require('../config');

const router = express.Router();

// ── Status ───────────────────────────────────────────────────

router.get('/status', (req, res) => {
  const meta  = readJSON(config.META_FILE) || {};
  const state = getRefreshState();
  const lastSettlementChange = req.app.locals.getLastSettlementChange
    ? req.app.locals.getLastSettlementChange()
    : null;
  res.json({ ...state, meta, lastSettlementChange });
});

// ── Shortlist ─────────────────────────────────────────────────

router.get('/shortlist', (req, res) => {
  res.json(readJSON(config.SHORTLIST_FILE) || []);
});

// ── All matches ───────────────────────────────────────────────

router.get('/matches', (req, res) => {
  res.json(readJSON(config.DISCOVERED_FILE) || []);
});

// ── Leagues ───────────────────────────────────────────────────

router.get('/leagues', (req, res) => {
  res.json(readJSON(config.LEAGUES_FILE) || []);
});

// ── Match detail ──────────────────────────────────────────────

router.get('/match/:id', (req, res) => {
  const detail = readMatchDetail(req.params.id);
  if (!detail) return res.status(404).json({ error: 'No detail scraped for this match' });
  res.json(detail);
});

// ── Performance stats ─────────────────────────────────────────

router.get('/stats', (req, res) => {
  res.json(getPredictionStats());
});

// ── Raw prediction history ────────────────────────────────────

router.get('/predictions', (req, res) => {
  const predictions = readJSONL(config.PREDICTIONS_FILE);
  const limit = parseInt(req.query.limit) || 100;
  res.json(predictions.slice(-limit));
});

// ── Settlement conflicts ──────────────────────────────────────

router.get('/conflicts', (req, res) => {
  const conflicts = readJSONL(config.CONFLICTS_FILE);
  res.json({
    count: conflicts.length,
    conflicts: conflicts.sort((a, b) =>
      (b.timestamp || '').localeCompare(a.timestamp || '')
    ),
  });
});

// ── Manual refresh ────────────────────────────────────────────

router.post('/refresh', async (req, res) => {
  const state = getRefreshState();
  if (state.status === 'running') {
    return res.status(409).json({ error: 'Refresh already running', ...state });
  }
  runFullRefresh().catch(err => console.error('[api] refresh error:', err));
  res.json({ message: 'Refresh started', status: 'running' });
});

// ── Settle predictions ────────────────────────────────────────

router.post('/settle', async (req, res) => {
  try {
    const result = await fetchScoresAndSettle();
    res.json({
      settled:   result.settled,
      conflicts: result.conflicts,
      counters:  result.counters,
      message:   `Settled ${result.settled} predictions${result.conflicts > 0 ? `, ${result.conflicts} conflicts logged` : ''}`,
    });
  } catch (err) {
    console.error('[api/settle] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Pre-kickoff odds update ───────────────────────────────────

router.post('/pre-kickoff', async (req, res) => {
  try {
    const result = await fetchCurrentOddsForPending();
    res.json({
      updated: result.updated,
      message: `Updated pre-KO odds for ${result.updated} predictions`,
    });
  } catch (err) {
    console.error('[api/pre-kickoff] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;