// src/index.js
// ─────────────────────────────────────────────────────────────
// GoalScout — main entry point.
//
// Starts Express server, mounts API routes, serves static UI,
// and schedules automatic refresh and settlement via cron.
//
// Cron jobs:
//   CRON_SCHEDULE (every 6h) — full SoccerSTATS + odds refresh
//   SETTLE_CRON   (every 30min) — settlement sweep only
//   PREKICKOFF_CRON (every 30min) — pre-KO odds capture
// ─────────────────────────────────────────────────────────────

const express = require('express');
const path = require('path');
const cron = require('node-cron');
const apiRoutes = require('./api/routes');
const { runFullRefresh } = require('./scrapers/orchestrator');
const { fetchScoresAndSettle, fetchCurrentOddsForPending, getLastSettlementChange, captureClosingOdds } = require('./engine/settler');
const { ensureDirs } = require('./utils/storage');
const config = require('./config');

const app = express();

// ── Middleware ───────────────────────────────────────────────
app.use(express.json());

// ── Expose lastSettlementChange to routes ────────────────────
// Routes read this via a getter so they always have the current value.
app.locals.getLastSettlementChange = getLastSettlementChange;

// ── API routes ──────────────────────────────────────────────
app.use('/api', apiRoutes);

// ── Static frontend ─────────────────────────────────────────
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ── Startup ─────────────────────────────────────────────────
ensureDirs();

app.listen(config.PORT, '0.0.0.0', () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║  GoalScout v2                                    ║
║  Probability Engine                              ║
║                                                  ║
║  Dashboard: http://localhost:${config.PORT}              ║
║  API:       http://localhost:${config.PORT}/api/status   ║
╚══════════════════════════════════════════════════╝
  `);

  setTimeout(() => {
    console.log('[startup] triggering initial data refresh...');
    runFullRefresh().catch(err => {
      console.error('[startup] initial refresh failed:', err.message);
    });
  }, 2000);
});

// ── Cron: full refresh every 6 hours ────────────────────────
cron.schedule(config.CRON_SCHEDULE, () => {
  console.log(`[cron] scheduled refresh at ${new Date().toISOString()}`);
  runFullRefresh().catch(err => {
    console.error('[cron] scheduled refresh failed:', err.message);
  });
});

// ── Cron: settlement sweep every 30 minutes ─────────────────
cron.schedule('*/30 * * * *', () => {
  console.log(`[cron] settlement sweep at ${new Date().toISOString()}`);
  fetchScoresAndSettle().catch(err => {
    console.error('[cron] settlement sweep failed:', err.message);
  });
});

// ── Cron: pre-kickoff odds capture every 30 minutes ─────────
cron.schedule('*/30 * * * *', () => {
  fetchCurrentOddsForPending().catch(err => {
    console.error('[cron] pre-KO odds failed:', err.message);
  });
});

// ── Cron: near-close odds capture every 5 minutes ───────────
// Targets predictions with kickoff 3–15 minutes away.
// Writes closingOdds + closingOddsCapturedAt only — never overwrites.
// Zero API calls on ticks where no match is in the close window.
cron.schedule(config.CLOSE_CAPTURE_CRON, () => {
  captureClosingOdds().catch(err => {
    console.error('[cron/close-capture] failed:', err.message);
  });
});

// ── Graceful shutdown ───────────────────────────────────────
process.on('SIGTERM', () => {
  console.log('[shutdown] received SIGTERM, exiting...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[shutdown] received SIGINT, exiting...');
  process.exit(0);
});