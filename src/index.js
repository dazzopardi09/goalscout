// src/index.js
// ─────────────────────────────────────────────────────────────
// GoalScout — main entry point.
// ─────────────────────────────────────────────────────────────

const express = require('express');
const path    = require('path');
const cron    = require('node-cron');

const apiRoutes  = require('./api/routes');
const { runFullRefresh, getRefreshState } = require('./scrapers/orchestrator');
const { ensureDirs } = require('./utils/storage');
const { fetchScoresAndSettle, fetchCurrentOddsForPending } = require('./engine/settler');
const config = require('./config');

const app = express();

// ── Middleware ───────────────────────────────────────────────
app.use(express.json());

// ── API routes ───────────────────────────────────────────────
app.use('/api', apiRoutes);

// ── Static frontend ──────────────────────────────────────────
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ── Startup ──────────────────────────────────────────────────
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

  // Initial refresh on startup
  setTimeout(() => {
    console.log('[startup] triggering initial data refresh...');
    runFullRefresh().catch(err => {
      console.error('[startup] initial refresh failed:', err.message);
    });
  }, 2000);
});

// ── Main refresh cron (every 6 hours) ────────────────────────
cron.schedule(config.CRON_SCHEDULE, () => {
  console.log(`[cron/refresh] scheduled at ${new Date().toISOString()}`);
  runFullRefresh().catch(err => console.error('[cron/refresh] failed:', err.message));
});

// ── Pre-kickoff odds cron (every 30 minutes) ─────────────────
// Fetches current odds for matches kicking off in next 2 hours.
// Populates preKickoffOdds + preKickoffMovePct on predictions.
cron.schedule(config.PREKICKOFF_CRON, async () => {
  try {
    const result = await fetchCurrentOddsForPending();
    if (result.updated > 0) {
      console.log(`[cron/pre-ko] updated pre-KO odds for ${result.updated} predictions`);
    }
  } catch (err) {
    console.error('[cron/pre-ko] failed:', err.message);
  }
});

// ── Settlement cron (every 3 hours) ──────────────────────────
// Checks for completed matches and settles pending predictions.
// Attaches closing odds, CLV%, and win/loss result.
cron.schedule(config.SETTLE_CRON, async () => {
  console.log(`[cron/settle] running at ${new Date().toISOString()}`);
  try {
    const result = await fetchScoresAndSettle();
    console.log(`[cron/settle] settled=${result.settled} skipped=${result.skipped} errors=${result.errors}`);
  } catch (err) {
    console.error('[cron/settle] failed:', err.message);
  }
});

// ── Graceful shutdown ─────────────────────────────────────────
process.on('SIGTERM', () => { console.log('[shutdown] SIGTERM'); process.exit(0); });
process.on('SIGINT',  () => { console.log('[shutdown] SIGINT');  process.exit(0); });