// src/scrapers/league-discovery.js
// ─────────────────────────────────────────────────────────────
// Discovers all available leagues from SoccerSTATS.
//
// Strategy:
//   The /leagues.asp page contains links to every league the
//   site covers, in the format:
//     latest.asp?league=<slug>
//     leagueview.asp?league=<slug>
//
//   We extract ALL of these slugs dynamically — no hardcoded
//   league list. This means if SoccerSTATS adds an obscure
//   women's third division, we pick it up automatically.
//
// Known selectors:
//   Links matching href patterns:
//     latest.asp?league=...
//     leagueview.asp?league=...
//   The link text contains the league display name.
//
// Limitations:
//   - If SoccerSTATS changes their URL structure, this breaks.
//   - We trust whatever leagues.asp exposes; we can't discover
//     leagues that aren't linked from this page.
// ─────────────────────────────────────────────────────────────

const cheerio = require('cheerio');
const { fetchPage } = require('../utils/fetcher');
const { BASE_URL } = require('../config');

async function discoverLeagues() {
  const url = `${BASE_URL}/leagues.asp`;
  console.log(`[leagues] fetching ${url}`);

  const html = await fetchPage(url);
  const $ = cheerio.load(html);

  const leagues = new Map();

  // Find all league links on the page
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const text = $(el).text().trim();

    // Match latest.asp?league=xxx or leagueview.asp?league=xxx
    let match = href.match(/(?:latest|leagueview)\.asp\?league=([a-zA-Z0-9_-]+)/);
    if (match && text) {
      const slug = match[1].toLowerCase();
      if (!leagues.has(slug)) {
        leagues.set(slug, {
          slug,
          name: text.replace(/\s+/g, ' ').trim(),
          latestUrl: `${BASE_URL}/latest.asp?league=${slug}`,
          leagueViewUrl: `${BASE_URL}/leagueview.asp?league=${slug}`,
        });
      }
    }
  });

  const result = Array.from(leagues.values());
  console.log(`[leagues] discovered ${result.length} leagues`);
  return result;
}

module.exports = { discoverLeagues };
