// src/api/routes.js
// ─────────────────────────────────────────────────────────────
// REST API — serves cached JSON to the frontend.
//
// Endpoints:
//   GET  /api/status        → refresh state + meta
//   GET  /api/shortlist     → shortlisted matches
//   GET  /api/matches       → all discovered matches
//   GET  /api/leagues       → all discovered leagues
//   GET  /api/match/:id     → match detail (if scraped)
//   GET  /api/stats         → performance stats
//   GET  /api/predictions   → raw prediction history
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
  settlePrediction,
  updatePreKickoffOdds,
} = require('../engine/history');
const { fetchScoresAndSettle, fetchCurrentOddsForPending } = require('../engine/settler');
const config = require('../config');

const router = express.Router();

// ── Status ───────────────────────────────────────────────────

router.get('/status', (req, res) => {
  const meta  = readJSON(config.META_FILE) || {};
  const state = getRefreshState();
  res.json({ ...state, meta });
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
//
// Fetches match scores from The-Odds-API /scores endpoint for all
// pending predictions whose kickoff has passed, then:
//   1. Updates result (won/lost)
//   2. Fetches current (closing) odds for CLV calculation
//   3. Calculates Move% and CLV%

router.post('/settle', async (req, res) => {
  try {
    const result = await fetchScoresAndSettle();
    res.json({
      settled:  result.settled,
      skipped:  result.skipped,
      errors:   result.errors,
      message:  `Settled ${result.settled} predictions`,
    });
  } catch (err) {
    console.error('[api/settle] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Pre-kickoff odds update ───────────────────────────────────
//
// Fetches current odds for all pending predictions and updates
// preKickoffOdds + preKickoffMovePct.
// Designed to be called ~60-90 mins before kickoff.
// Also called automatically by the pre-KO cron job in index.js.

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