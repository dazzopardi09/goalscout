// src/utils/fetcher.js
// ─────────────────────────────────────────────────────────────
// HTTP fetcher with FlareSolverr integration.
//
// FlareSolverr runs a real browser that solves Cloudflare
// challenges. Since SoccerSTATS uses Cloudflare, we route
// requests through FlareSolverr to get authenticated pages.
//
// Falls back to direct fetch if FlareSolverr is unavailable.
// ─────────────────────────────────────────────────────────────

const { fetch } = require('undici');
const { REQUEST_DELAY_MS, REQUEST_TIMEOUT_MS, USER_AGENT, SOCCERSTATS_COOKIE } = require('../config');

const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || 'http://flaresolverr:8191/v1';

let lastRequestTime = 0;
let flaresolverrAvailable = null; // null = untested

/**
 * Wait until at least REQUEST_DELAY_MS has passed since last request.
 */
async function throttle() {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < REQUEST_DELAY_MS) {
    await new Promise(r => setTimeout(r, REQUEST_DELAY_MS - elapsed));
  }
  lastRequestTime = Date.now();
}

/**
 * Check if FlareSolverr is reachable.
 */
async function checkFlareSolverr() {
  const healthUrl = FLARESOLVERR_URL.replace('/v1', '/health');
  console.log(`[fetcher] checking FlareSolverr at ${healthUrl}`);
  try {
    const res = await fetch(healthUrl, {
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      console.log('[fetcher] FlareSolverr is available');
      return true;
    }
    console.warn(`[fetcher] FlareSolverr health returned ${res.status}`);
  } catch (e) {
    console.warn(`[fetcher] FlareSolverr health check failed: ${e.message}`);
  }

  // Try the /v1 endpoint as fallback health check
  try {
    const res = await fetch(FLARESOLVERR_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: 'sessions.list' }),
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      console.log('[fetcher] FlareSolverr is available (v1 endpoint)');
      return true;
    }
  } catch {}

  console.warn('[fetcher] FlareSolverr not available, using direct fetch');
  return false;
}

/**
 * Fetch a page via FlareSolverr (real browser, solves Cloudflare).
 */
async function fetchViaFlareSolverr(url) {
  const payload = {
    cmd: 'request.get',
    url: url,
    maxTimeout: 60000,
  };

  // If we have cookies, pass them to FlareSolverr
  if (SOCCERSTATS_COOKIE) {
    payload.cookies = SOCCERSTATS_COOKIE.split(';').map(c => {
      const [name, ...rest] = c.trim().split('=');
      return {
        name: name.trim(),
        value: rest.join('=').trim(),
        domain: 'www.soccerstats.com',
      };
    }).filter(c => c.name && c.value);
  }

  const res = await fetch(FLARESOLVERR_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(90000), // FlareSolverr can be slow
  });

  if (!res.ok) {
    throw new Error(`FlareSolverr HTTP ${res.status}`);
  }

  const data = await res.json();

  if (data.status !== 'ok') {
    throw new Error(`FlareSolverr error: ${data.message || 'unknown'}`);
  }

  return data.solution.response;
}

/**
 * Fetch a page directly (no Cloudflare bypass).
 */
async function fetchDirect(url) {
  const headers = {
    'User-Agent': USER_AGENT,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  };

  if (SOCCERSTATS_COOKIE) {
    headers['Cookie'] = SOCCERSTATS_COOKIE;
  }

  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }

  return await res.text();
}

/**
 * Fetch a URL and return the HTML body as a string.
 * Uses FlareSolverr if available, falls back to direct fetch.
 * Retries once on transient failure.
 */
async function fetchPage(url, retries = 1) {
  await throttle();

  // Check FlareSolverr availability on first call
  if (flaresolverrAvailable === null) {
    flaresolverrAvailable = await checkFlareSolverr();
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      if (flaresolverrAvailable) {
        return await fetchViaFlareSolverr(url);
      } else {
        return await fetchDirect(url);
      }
    } catch (err) {
      if (attempt < retries) {
        console.warn(`[fetcher] retry ${attempt + 1} for ${url}: ${err.message}`);

        // If FlareSolverr failed, recheck availability
        if (flaresolverrAvailable) {
          flaresolverrAvailable = await checkFlareSolverr();
        }

        await new Promise(r => setTimeout(r, 3000));
        await throttle();
      } else {
        throw err;
      }
    }
  }
}

module.exports = { fetchPage };