// scripts/patch-frontend-polling.js
// Patches public/index.html to:
//   1. Add _lastRefresh / _lastSettlementChange change-detection to the poll loop
//   2. Reload shortlist when lastRefresh changes
//   3. Reload performance when lastSettlementChange changes
//   4. Update loadStatus() to accept a returnData flag so the poller
//      can read the full response object
//
// Run from /mnt/user/appdata/goalscout:
//   docker run --rm -v "$(pwd)":/app -w /app goalscout-goalscout node scripts/patch-frontend-polling.js

const fs = require('fs');
const path = require('path');

const TARGET = path.join(__dirname, '..', 'public', 'index.html');

if (!fs.existsSync(TARGET)) {
  console.error('ERROR: public/index.html not found. Run from /mnt/user/appdata/goalscout');
  process.exit(1);
}

let content = fs.readFileSync(TARGET, 'utf8');
const original = content;

// ── Patch 1: loadStatus — add returnData parameter ────────────
// Find the function signature and the return at the bottom.
// Current:
//   async function loadStatus() {
// Replace with:
//   async function loadStatus(returnData) {
//
// Current return block (last two lines of the function):
//     return d.status;
//   } catch (e) { return 'error'; }
// }
//
// Replace with:
//     if (returnData) return d;
//     return d.status;
//   } catch (e) { return returnData ? null : 'error'; }
// }

const OLD_SIG = 'async function loadStatus() {';
const NEW_SIG = 'async function loadStatus(returnData) {';

if (content.includes(OLD_SIG)) {
  content = content.replace(OLD_SIG, NEW_SIG);
  console.log('Fix 1a applied: loadStatus() signature updated');
} else if (content.includes(NEW_SIG)) {
  console.log('Fix 1a skipped: loadStatus() signature already updated');
} else {
  console.log('Fix 1a FAILED: loadStatus() signature not found');
}

const OLD_RETURN = `    return d.status;
  } catch (e) { return 'error'; }
}`;

const NEW_RETURN = `    if (returnData) return d;
    return d.status;
  } catch (e) { return returnData ? null : 'error'; }
}`;

if (content.includes(OLD_RETURN)) {
  content = content.replace(OLD_RETURN, NEW_RETURN);
  console.log('Fix 1b applied: loadStatus() return updated');
} else if (content.includes('if (returnData) return d;')) {
  console.log('Fix 1b skipped: loadStatus() return already updated');
} else {
  console.log('Fix 1b FAILED: loadStatus() return block not found');
  console.log('  Expected to find:');
  console.log('    return d.status;');
  console.log('  } catch (e) { return \'error\'; }');
  console.log('  }');
}

// ── Patch 2: init() — add change-detection polling ───────────
// Current:
//   async function init() {
//     var s = await loadStatus();
//     await loadShortlist();
//     if (s === 'running') pollUntilDone();
//     setInterval(loadStatus, 30000);
//   }
//
// Replace with version that tracks lastRefresh + lastSettlementChange
// and reloads data selectively when they change.

const OLD_INIT = `async function init() {
  var s = await loadStatus();
  await loadShortlist();
  if (s === 'running') pollUntilDone();
  setInterval(loadStatus, 30000);
}`;

const NEW_INIT = `async function init() {
  var s = await loadStatus();
  await loadShortlist();
  if (s === 'running') pollUntilDone();

  // Seed trackers from first load so first poll tick doesn't trigger spurious reloads
  var _lastRefresh = null;
  var _lastSettlementChange = null;

  setInterval(async function() {
    var d = await loadStatus(true);
    if (!d) return;

    var rfChanged = d.lastRefresh && d.lastRefresh !== _lastRefresh;
    var scChanged = d.lastSettlementChange && d.lastSettlementChange !== _lastSettlementChange;

    if (rfChanged) {
      _lastRefresh = d.lastRefresh;
      _lastSettlementChange = d.lastSettlementChange;
      await loadShortlist();
      if (document.getElementById('perfPanel').style.display !== 'none') {
        await loadPerformance();
      }
    } else if (scChanged) {
      _lastSettlementChange = d.lastSettlementChange;
      if (document.getElementById('perfPanel').style.display !== 'none') {
        await loadPerformance();
      }
    }
  }, 30000);
}`;

if (content.includes(OLD_INIT)) {
  content = content.replace(OLD_INIT, NEW_INIT);
  console.log('Fix 2 applied: init() updated with change-detection polling');
} else if (content.includes('_lastSettlementChange')) {
  console.log('Fix 2 skipped: init() already patched');
} else {
  console.log('Fix 2 FAILED: init() target not found');
  console.log('  Check that index.html has not been reformatted');
}

// ── Write ──────────────────────────────────────────────────────
if (content === original) {
  console.log('\nNo changes written — already patched or all targets failed.');
} else {
  const backup = TARGET + '.bak-polling';
  fs.copyFileSync(TARGET, backup);
  console.log('\nBackup saved: ' + backup);
  fs.writeFileSync(TARGET, content, 'utf8');
  console.log('Written: ' + TARGET);
  console.log('\nRedeploy required:');
  console.log('  docker compose down');
  console.log('  docker rmi goalscout goalscout-goalscout 2>/dev/null || true');
  console.log('  docker builder prune -f');
  console.log('  docker compose up --build -d');
}