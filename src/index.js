// src/index.js
// ─────────────────────────────────────────────────────────────
// GoalScout — main entry point.
//
// Starts Express server, mounts API routes, serves static UI,
// and schedules automatic refresh via cron.
// ─────────────────────────────────────────────────────────────

const express = require('express');
const path = require('path');
const cron = require('node-cron');
const apiRoutes = require('./api/routes');
const { runFullRefresh } = require('./scrapers/orchestrator');
const { runSettlement } = require('./engine/settler');
const { ensureDirs } = require('./utils/storage');
const config = require('./config');

const app = express();

// ── Middleware ───────────────────────────────────────────────
app.use(express.json());

// ── API routes ──────────────────────────────────────────────
app.use('/api', apiRoutes);

// ── Static frontend ─────────────────────────────────────────
app.use(express.static(path.join(__dirname, '..', 'public')));

// Fallback to index.html for SPA-style routing
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ── Startup ─────────────────────────────────────────────────
ensureDirs();

app.listen(config.PORT, '0.0.0.0', () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║  GoalScout v1.0                                  ║
║  Football Match Investigation Tool               ║
║                                                  ║
║  Dashboard: http://localhost:${config.PORT}              ║
║  API:       http://localhost:${config.PORT}/api/status   ║
║                                                  ║
║  Auto-refresh: ${config.CRON_SCHEDULE}                     ║
╚══════════════════════════════════════════════════╝
  `);

  // Run initial refresh on startup (after a brief delay)
  setTimeout(() => {
    console.log('[startup] triggering initial data refresh...');
    runFullRefresh().catch(err => {
      console.error('[startup] initial refresh failed:', err.message);
    });
  }, 2000);
});

// ── Cron scheduler ──────────────────────────────────────────
cron.schedule(config.CRON_SCHEDULE, () => {
  console.log(`[cron] scheduled refresh at ${new Date().toISOString()}`);
  runFullRefresh().catch(err => {
    console.error('[cron] scheduled refresh failed:', err.message);
  });
});

// ── Settlement cron (every 2 hours) ─────────────────────────
// Runs independently of the main refresh — fetches scores for
// past matches and captures closing odds for upcoming ones.
cron.schedule('0 */2 * * *', () => {
  console.log(`[cron] settlement cycle at ${new Date().toISOString()}`);
  runSettlement().catch(err => {
    console.error('[cron] settlement failed:', err.message);
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