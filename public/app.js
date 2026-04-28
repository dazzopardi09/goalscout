// public/app.js
// ─────────────────────────────────────────────────────────────
// GoalScout v3 — all frontend JavaScript.
// Extracted from index.html inline <script> block.
//
// Sections:
//   State + helpers
//   Shortlist rendering
//   Performance tab (Current / Calibrated / Context)
//   Context Research tab (backtest viewer)
//   Init + polling
// ─────────────────────────────────────────────────────────────

// ── State ─────────────────────────────────────────────────────
let shortlistData = { current: [], calibrated: [], context_raw: [], comparison: {} };
let filters = { method: 'all', grade: 'all', direction: 'all', league: 'all' };
let currentSort = { key: 'kickoff', dir: 'asc' };
let perfData = null;
let activePerfMarket = 'over_2.5';
let activeCtxMkt = 'over_2.5'; // context settled market tab
let statsData = null;
let statsMethod = 'current';
// Shortlist header state — owned by renderShortlist(), populated by loadStatus()
var lastRawPickCount = null;
var lastUpdatedText  = '—';

// ── Helpers ───────────────────────────────────────────────────
function pctClass(v) { return v == null ? 'pct-cold' : v >= 65 ? 'pct-hot' : v >= 50 ? 'pct-warm' : 'pct-cold'; }
function gradeClass(g) { return g === 'A+' ? 'grade-aplus' : g === 'A' ? 'grade-a' : g === 'B' ? 'grade-b' : 'grade-c'; }
function fmtPct(v)  { return v == null ? '—' : v + '%'; }
function fmtVal(v, d = 2) { return v == null ? '—' : Number(v).toFixed(d); }
function fmtProbPct(v) { return v == null ? '—' : Math.round(v * 100) + '%'; }

function edgeColor(v) {
  if (v == null) return '#66758c';
  if (v > 5)  return '#6ee7b7';
  if (v > 0)  return '#bef264';
  if (v > -5) return '#fbbf24';
  return '#f87171';
}
function clvColor(v) {
  if (v == null) return '#66758c';
  if (v > 3)  return '#6ee7b7';
  if (v > 0)  return '#bef264';
  if (v > -3) return '#fbbf24';
  return '#f87171';
}
function moveColor(v) {
  if (v == null) return '#66758c';
  if (v > 3)  return '#6ee7b7';
  if (v > 0)  return '#bef264';
  if (v < -3) return '#f87171';
  return '#fbbf24';
}

function getMelbourneNow() {
  return new Date(
    new Date().toLocaleString('en-US', { timeZone: 'Australia/Melbourne' })
  );
}

function parseKickoffParts(kickoff) {
  if (!kickoff || typeof kickoff !== 'string' || !kickoff.includes(':')) return null;
  var parts = kickoff.split(':').map(Number);
  if (parts.length !== 2 || Number.isNaN(parts[0]) || Number.isNaN(parts[1])) return null;
  return { hour: parts[0], minute: parts[1] };
}

function deriveKickoffDate(m) {
  if (m.odds && m.odds.commenceTime) {
    return new Date(m.odds.commenceTime);
  }

  var kp = parseKickoffParts(m.kickoff);
  if (!kp) return null;

  var now = getMelbourneNow();

  var h = (kp.hour - 1 + 24) % 24;
  var d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, kp.minute, 0, 0);

  var dayLabel = (m.day || '').toLowerCase().trim();

  if (dayLabel === 'tomorrow') {
    d.setDate(d.getDate() + 1);
    return d;
  }

  if (dayLabel === 'today') {
    var minsAgo = (now.getTime() - d.getTime()) / 60000;
    if (minsAgo > 180) {
      d.setDate(d.getDate() + 1);
    }
    return d;
  }

  return d;
}

function fmtKickoff(m) {
  var d = deriveKickoffDate(m);
  if (d) {
    return d.toLocaleTimeString('en-AU', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'Australia/Melbourne'
    });
  }
  if (!m.kickoff) return '—';
  return m.kickoff;
}

function fmtDate(m) {
  var d = deriveKickoffDate(m);
  if (d) {
    return d.toLocaleDateString('en-AU', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      timeZone: 'Australia/Melbourne'
    });
  }
  return m.day || '—';
}

function getActiveShortlist() {
  if (filters.method === 'current')     return shortlistData.current     || [];
  if (filters.method === 'calibrated')  return shortlistData.calibrated  || [];
  if (filters.method === 'context_raw') return shortlistData.context_raw || [];

  // All mode: smart merge
  // Rules (display-only — no effect on logging/shortlist.json/performance):
  //   1. cur+cal+ctx all same fixture+direction → one merged row, badge all three
  //   2. cur+cal agree, ctx disagrees direction → merged cur/cal row + separate ctx row
  //   3. cur+cal disagree → separate rows; ctx merges into whichever direction it agrees with
  //   4. ctx only → own row with Context badge
  // _models[] attached to each output row for badge rendering in buildMatchRow

  const current    = shortlistData.current     || [];
  const calibrated = shortlistData.calibrated  || [];
  const ctxRaw     = shortlistData.context_raw || [];

  function makeIdx(list) {
    const m = new Map();
    list.forEach(r => m.set(r.id + '__' + (r.direction || 'none'), r));
    return m;
  }

  const curIdx = makeIdx(current);
  const calIdx = makeIdx(calibrated);
  const ctxIdx = makeIdx(ctxRaw);

  const output  = [];
  const ctxUsed = new Set();

  // All unique fixture+direction pairs across current and calibrated
  const ccKeys = new Set([
    ...current.map(r => r.id + '__' + (r.direction || 'none')),
    ...calibrated.map(r => r.id + '__' + (r.direction || 'none')),
  ]);

  ccKeys.forEach(key => {
    const curRow = curIdx.get(key);
    const calRow = calIdx.get(key);
    const base   = calRow || curRow;
    const models = [];
    if (curRow) models.push('current');
    if (calRow) models.push('calibrated');

    // context_raw agrees if same fixture + same direction
    const ctxAgree = ctxIdx.get(key);
    if (ctxAgree) {
      models.push('context_raw');
      ctxUsed.add(key);
    }

    output.push(Object.assign({}, base, { _models: models }));
  });

  // context_raw entries not consumed by merging — show as own rows
  ctxRaw.forEach(r => {
    const key = r.id + '__' + (r.direction || 'none');
    if (!ctxUsed.has(key)) {
      output.push(Object.assign({}, r, { _models: ['context_raw'] }));
    }
  });

  return output;
}

// ── Status polling ─────────────────────────────────────────────
async function loadStatus(returnData) {
  try {
    var r = await fetch('/api/status');
    var d = await r.json();
    var dot = document.getElementById('statusDot');
    dot.className = 'dot ' + (d.status === 'running' ? 'running' : d.status === 'error' ? 'error' : '');

    if (d.status === 'running') {
      document.getElementById('statusText').textContent = d.progress || 'Refreshing...';
      document.getElementById('loadingBar').classList.add('active');
      document.getElementById('refreshBtn').disabled = true;
    } else {
      document.getElementById('statusText').textContent = d.lastRefresh
        ? 'Last: ' + new Date(d.lastRefresh).toLocaleTimeString('en-AU', { timeZone: 'Australia/Melbourne' })
        : (d.lastError || 'Ready');
      document.getElementById('loadingBar').classList.remove('active');
      document.getElementById('refreshBtn').disabled = false;
    }

    if (d.meta) {
      // Store raw backend pick count — renderShortlist() uses this for secondary text.
      // Do NOT write statShortlisted here: renderShortlist() owns that element and
      // knows the merged/filtered visible count. Writing here would overwrite the
      // correct merged count on every status poll.
      lastRawPickCount = d.meta.shortlistCount != null ? d.meta.shortlistCount : null;
      if (d.meta.lastRefresh) {
        var dt = new Date(d.meta.lastRefresh);
        lastUpdatedText =
          'Updated ' +
          dt.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', timeZone: 'Australia/Melbourne' }) +
          ' · ' +
          dt.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', timeZone: 'Australia/Melbourne' }) +
          ' AEST';
        // Still write statUpdated immediately so it shows on first load before
        // renderShortlist() has run. renderShortlist() will recompose it with
        // the model-picks prefix when needed.
        document.getElementById('statUpdated').textContent = lastUpdatedText;
      }
    }
    if (returnData) return d;
    return d.status;
  } catch (e) { return returnData ? null : 'error'; }
}

async function loadShortlist() {
  try {
    var r = await fetch('/api/shortlist');
    var payload = await r.json();

    if (Array.isArray(payload)) {
      shortlistData = { current: payload, calibrated: [], context_raw: [], comparison: {} };
    } else {
      shortlistData = {
        current:     payload.current     || [],
        calibrated:  payload.calibrated  || [],
        context_raw: payload.context_raw || [],
        comparison:  payload.comparison  || {}
      };
    }

    populateLeagueFilter();
    renderShortlist();
  } catch (e) {}
}

function populateLeagueFilter() {
  var s = document.getElementById('leagueFilter');
  var active = getActiveShortlist();
  var ls = [...new Set(active.map(m => m.league))].sort();
  var currentValue = filters.league || 'all';

  while (s.options.length > 1) s.remove(1);

  ls.forEach(l => {
    var o = document.createElement('option');
    o.value = l;
    o.textContent = l;
    s.appendChild(o);
  });

  if ([...s.options].some(o => o.value === currentValue)) {
    s.value = currentValue;
  } else {
    s.value = 'all';
    filters.league = 'all';
  }
}

// ── Sorting ───────────────────────────────────────────────────
function getSortedData() {
  var data = getActiveShortlist().filter(m => {
    if (filters.grade !== 'all' && m.grade !== filters.grade) return false;
    if (filters.league !== 'all' && m.league !== filters.league) return false;
    if (filters.direction !== 'all' && m.direction !== filters.direction) return false;
    return true;
  });

  var key = currentSort.key, mult = currentSort.dir === 'asc' ? 1 : -1;

  return data.sort((a, b) => {
    var va, vb;
    switch (key) {
      case 'prob':
        va = a.analysis ? ((a.direction === 'u25' ? a.analysis.u25 : a.analysis.o25)?.probability || 0) : 0;
        vb = b.analysis ? ((b.direction === 'u25' ? b.analysis.u25 : b.analysis.o25)?.probability || 0) : 0;
        break;
      case 'grade': {
        var go = { 'A+': 4, 'A': 3, 'B': 2, 'C': 1, '-': 0 };
        va = go[a.grade] || 0;
        vb = go[b.grade] || 0;
        break;
      }
      case 'kickoff':
        va = deriveKickoffDate(a)?.getTime() ?? Number.MAX_SAFE_INTEGER;
        vb = deriveKickoffDate(b)?.getTime() ?? Number.MAX_SAFE_INTEGER;
        break;
      case 'match':
        va = a.homeTeam || '';
        vb = b.homeTeam || '';
        break;
      case 'edge':
        va = a.analysis ? ((a.direction === 'u25' ? a.analysis.u25 : a.analysis.o25)?.edge ?? -999) : -999;
        vb = b.analysis ? ((b.direction === 'u25' ? b.analysis.u25 : b.analysis.o25)?.edge ?? -999) : -999;
        break;
      case 'odds':
        va = a.direction === 'u25' ? a.odds?.u25?.price ?? 0 : a.odds?.o25?.price ?? 0;
        vb = b.direction === 'u25' ? b.odds?.u25?.price ?? 0 : b.odds?.o25?.price ?? 0;
        break;
      default:
        va = 0;
        vb = 0;
    }

    if (typeof va === 'string') return mult * va.localeCompare(vb);
    return mult * ((va || 0) - (vb || 0));
  });
}

function setSort(key) {
  if (currentSort.key === key) {
    currentSort.dir = currentSort.dir === 'desc' ? 'asc' : 'desc';
  } else {
    currentSort = { key, dir: 'desc' };
  }
  renderShortlist();
}

// ── Render shortlist ──────────────────────────────────────────
function renderShortlist() {
  var wrap = document.getElementById('shortlistWrap');
  var empty = document.getElementById('emptyState');
  var data = getSortedData();

  // Visible match count — merged rows after All-mode dedup and current filter.
  var matchCount = data.length;

  // Raw model pick count — only meaningful in All mode when the merge
  // collapses multiple model picks into fewer visible rows.
  // For single-model views, rawPickCount === matchCount so no secondary shown.
  var rawPickCount = filters.method === 'all'
    ? (shortlistData.current?.length     || 0) +
      (shortlistData.calibrated?.length  || 0) +
      (shortlistData.context_raw?.length || 0)
    : matchCount;

  document.getElementById('statShortlisted').textContent = matchCount;
  document.getElementById('statShortlistedLabel').textContent =
    matchCount === 1 ? 'MATCH SHORTLISTED' : 'MATCHES SHORTLISTED';

  // Secondary text: prepend model-picks count only in All mode when it
  // differs from visible count (i.e. merging collapsed some rows).
  var updatedEl = document.getElementById('statUpdated');
  if (filters.method === 'all' && rawPickCount !== matchCount && rawPickCount > 0) {
    updatedEl.textContent =
      rawPickCount + ' model pick' + (rawPickCount === 1 ? '' : 's') +
      ' · ' + lastUpdatedText;
  } else {
    updatedEl.textContent = lastUpdatedText;
  }

  if (!data.length) {
    wrap.innerHTML = '';
    empty.style.display = 'block';
    var methodLabel = filters.method === 'context_raw' ? 'context (paper)' : filters.method;
    empty.querySelector('h2').textContent = `No ${methodLabel} matches shortlisted`;
    empty.querySelector('p').textContent  = filters.method === 'context_raw'
      ? 'No England or Germany fixtures met the context_raw threshold. Try refreshing.'
      : `No bettable matches meet the ${methodLabel} model threshold. Try refreshing.`;
    return;
  }

  empty.style.display = 'none';

  function sc(k) { return currentSort.key === k ? currentSort.dir : ''; }

  const tips = {
    prob:    'Model probability for the recommended direction (O2.5 or U2.5).',
    grade:   'Current uses score-based grade. Calibrated uses probability-based grade.',
    call:    'Recommended direction: O2.5 or U2.5.',
    kickoff: 'Match kickoff time in Australian Eastern time (AEST/AEDT).',
    league:  'Competition name as reported by SoccerSTATS.',
    match:   'Home vs Away team.',
    odds:    'Best available odds for the recommended direction across bookmakers via The-Odds-API.',
    edge:    'Edge % = (market odds / fair odds − 1) × 100.'
  };

  function tipBtn(label, key) {
    return `<button class="sort-btn ${sc(key)}" onclick="setSort('${key}')" title="${tips[key] || ''}">${label} <span class="col-tip">?</span></button>`;
  }
  function tipLabel(label, key) {
    return `<span class="sort-label" title="${tips[key] || ''}" style="cursor:default">${label} <span class="col-tip">?</span></span>`;
  }

  var sortBar = `<div class="sort-bar">
    ${tipBtn('Prob.', 'prob')}
    ${tipBtn('Grade', 'grade')}
    ${tipLabel('Call', 'call')}
    ${tipBtn('Kickoff', 'kickoff')}
    ${tipLabel('League', 'league')}
    ${tipBtn('Match', 'match')}
    ${tipBtn('Best Odds', 'odds')}
    ${tipBtn('Edge', 'edge')}
    <span></span>
  </div>`;

  wrap.innerHTML = sortBar + data.map((m, i) => buildMatchRow(m, i)).join('');

  wrap.querySelectorAll('.row-summary').forEach(el => {
    el.addEventListener('click', () => el.closest('.match-row').classList.toggle('open'));
  });
}

function buildMatchRow(m, i) {
  var isU25 = m.direction === 'u25';
  var a = m.analysis;
  var mktA = a ? (isU25 ? a.u25 : a.o25) : null;
  var prob = mktA?.probability;
  var fair = mktA?.fairOdds;
  var oddsData = isU25 ? m.odds?.u25 : m.odds?.o25;
  var displayedPrice = oddsData?.price ?? mktA?.marketOdds ?? null;
  var edge = (fair != null && displayedPrice != null)
    ? ((displayedPrice / fair) - 1) * 100
    : null;
  var probPct = prob != null ? Math.round(prob * 100) : null;
  var probColor = probPct >= 65 ? '#6ee7b7' : probPct >= 50 ? '#fbbf24' : '#8b9ab0';

  var ko = fmtKickoff(m), dt = fmtDate(m);
  var dirBadge = isU25
    ? '<span class="dir-badge dir-u25">U2.5</span>'
    : '<span class="dir-badge dir-o25">O2.5</span>';

  oddsData = isU25 ? m.odds?.u25 : m.odds?.o25;
  var oddsHtml = '<span style="color:#66758c;font-size:12px;font-style:italic">No odds</span>';
  if (oddsData) {
    var cls = isU25 ? 'odds-box-u25' : 'odds-box';
    var priceCls = isU25 ? 'odds-price-u25' : 'odds-price';
    oddsHtml = `<div class="${cls}"><div class="${priceCls}">${oddsData.price.toFixed(2)}</div><div class="odds-label">${oddsData.bookmaker}</div></div>`;
  }

  var edgeHtml = '<span style="color:#66758c;font-size:12px">—</span>';
  if (edge != null) {
    var ec = edgeColor(edge);
    edgeHtml = `<div class="edge-box"><div class="edge-label">Edge</div><div class="edge-val" style="color:${ec}">${edge > 0 ? '+' : ''}${edge.toFixed(1)}%</div></div>`;
  }

  var leagueLabel = m.league || m.leagueSlug || '—';

  // Model badges — only rendered in All mode when _models is populated
  var modelBadgesHtml = '';
  if (m._models && m._models.length > 0 && filters.method === 'all') {
    var BADGE_CFG = {
      current:     { label: 'Cur',  color: '#67e8f9', bg: 'rgba(103,232,249,.1)',  border: 'rgba(103,232,249,.25)' },
      calibrated:  { label: 'Cal',  color: '#6ee7b7', bg: 'rgba(110,231,183,.1)',  border: 'rgba(110,231,183,.25)' },
      context_raw: { label: 'Ctx',  color: '#818cf8', bg: 'rgba(129,140,248,.1)',  border: 'rgba(129,140,248,.25)' },
    };
    modelBadgesHtml = '<div style="display:flex;gap:3px;margin-top:3px;flex-wrap:wrap">' +
      m._models.map(function(mdl) {
        var cfg = BADGE_CFG[mdl] || { label: mdl, color: '#94a3b8', bg: 'transparent', border: 'rgba(255,255,255,.1)' };
        return '<span style="font-size:8px;font-weight:700;letter-spacing:.08em;color:' + cfg.color +
          ';background:' + cfg.bg + ';border:1px solid ' + cfg.border +
          ';border-radius:4px;padding:1px 4px;text-transform:uppercase">' + cfg.label + '</span>';
      }).join('') +
    '</div>';
  }
  var hCS = fmtPct(m.home?.csPct), aCS = fmtPct(m.away?.csPct);
  var hFTS = fmtPct(m.home?.ftsPct), aFTS = fmtPct(m.away?.ftsPct);
  var hO = fmtPct(m.home?.o25pct), aO = fmtPct(m.away?.o25pct);
  var combinedTG = (m.home?.avgTG != null && m.away?.avgTG != null)
    ? (m.home.avgTG + m.away.avgTG).toFixed(2) : null;

  var leagueO25 = m.leagueO25pct != null ? m.leagueO25pct : null;
  var hOraw = m.home?.o25pct || 0;
  var aOraw = m.away?.o25pct || 0;
  var tgRaw = combinedTG ? parseFloat(combinedTG) : null;

  var flags = (m.flags || []);
  var flagsHtml = flags.map(f => {
    var txt = f.replace(/^[🔥📈⚠🔒]\s*/u, '').trim();
    return `<span class="sig-tag fire" style="display:inline-flex;margin:2px 0"><span class="sig-text">${txt}</span></span>`;
  }).join('') || '<span style="color:#66758c;font-size:12px">No signals</span>';

  var linksHtml = '';
  if (m.matchUrl)  linksHtml += `<a href="${m.matchUrl}" target="_blank" rel="noopener" style="border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.04);color:#ddd6fe;border-radius:9px;padding:8px 12px;font-size:12px;text-decoration:none;display:block;margin-bottom:6px">📊 Match detail</a>`;
  if (m.leagueUrl) linksHtml += `<a href="${m.leagueUrl}" target="_blank" rel="noopener" style="border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.04);color:#ddd6fe;border-radius:9px;padding:8px 12px;font-size:12px;text-decoration:none;display:block">🏆 League page</a>`;

  return `
<div class="match-row" id="mrow-${i}">
  <div class="row-summary">
    <div class="col-prob">
      <div class="prob-big" style="color:${probColor}">${probPct != null ? probPct + '%' : '—'}</div>
      <div class="prob-sub">Fair: ${fair ? fair.toFixed(2) : '—'}</div>
    </div>
    <div><span class="badge ${gradeClass(m.grade)}">${m.grade}</span></div>
    <div>${dirBadge}</div>
    <div class="col-ko">${ko}<div class="ko-date">${dt}</div></div>
    <div class="col-league"><span title="${leagueLabel}">${leagueLabel}</span></div>
    <div class="col-match">
      <div class="match-title">${m.homeTeam} <span style="color:#66758c">vs</span> ${m.awayTeam}</div>
      ${modelBadgesHtml}
    </div>
    <div>${oddsHtml}</div>
    <div>${edgeHtml}</div>
    <div class="chevron">▾</div>
  </div>

  <div class="row-detail">
    <div class="detail-panels">

      <div class="detail-panel">
        <div class="dp-head">Model Inputs</div>
        <div class="inp-row">
          <div class="inp-name">Home O2.5% <span class="inp-weight">×0.35</span></div>
          <div class="inp-track"><div class="inp-fill" style="width:${Math.min(hOraw,100)}%"></div></div>
          <div class="inp-val">${hO}</div>
        </div>
        <div class="inp-row">
          <div class="inp-name">Away O2.5% <span class="inp-weight">×0.35</span></div>
          <div class="inp-track"><div class="inp-fill" style="width:${Math.min(aOraw,100)}%"></div></div>
          <div class="inp-val">${aO}</div>
        </div>
        ${leagueO25 != null ? `<div class="inp-row">
          <div class="inp-name">League O2.5% <span class="inp-weight">×0.10</span></div>
          <div class="inp-track"><div class="inp-fill" style="width:${Math.min(leagueO25,100)}%"></div></div>
          <div class="inp-val">${leagueO25}%</div>
        </div>` : ''}
        ${tgRaw != null ? `<div class="inp-row">
          <div class="inp-name">Avg TG <span class="inp-weight">×0.20</span></div>
          <div class="inp-track"><div class="inp-fill" style="width:${Math.min(tgRaw/5*100,100)}%"></div></div>
          <div class="inp-val">${tgRaw}</div>
        </div>` : ''}
        <div class="blend-hero">
          <div class="blend-labels">
            <div class="blend-lbl">P(${isU25 ? 'U2.5' : 'O2.5'}) blended</div>
            <div class="blend-lbl">fair odds ${fair ? fair.toFixed(2) : '—'}</div>
          </div>
          <div class="blend-val" style="color:${probColor}">${probPct != null ? probPct + '%' : '—'}</div>
        </div>
      </div>

      <div class="detail-panel">
        <div class="dp-head">${isU25 ? 'U2.5' : 'O2.5'} Context</div>
        ${isU25 ? `
          <div class="ctx-row"><div class="ctx-name">Home CS%</div><div class="ctx-val ${m.home?.csPct >= 40 ? 'hit' : 'plain'}">${hCS}</div></div>
          <div class="ctx-row"><div class="ctx-name">Away CS%</div><div class="ctx-val ${m.away?.csPct >= 40 ? 'hit' : 'plain'}">${aCS}</div></div>
          <div class="ctx-row"><div class="ctx-name">Home FTS%</div><div class="ctx-val ${m.home?.ftsPct >= 40 ? 'hit' : 'plain'}">${hFTS}</div></div>
          <div class="ctx-row"><div class="ctx-name">Away FTS%</div><div class="ctx-val ${m.away?.ftsPct >= 40 ? 'hit' : 'plain'}">${aFTS}</div></div>
          ${combinedTG ? `<div class="ctx-row"><div class="ctx-name">Avg TG</div><div class="ctx-val plain">${combinedTG}</div></div>` : ''}
        ` : `
          <div class="ctx-row"><div class="ctx-name">Home O2.5%</div><div class="ctx-val ${m.home?.o25pct >= 55 ? 'hit' : 'plain'}">${hO}</div></div>
          <div class="ctx-row"><div class="ctx-name">Away O2.5%</div><div class="ctx-val ${m.away?.o25pct >= 55 ? 'hit' : 'plain'}">${aO}</div></div>
          ${combinedTG ? `<div class="ctx-row"><div class="ctx-name">Combined TG</div><div class="ctx-val ${parseFloat(combinedTG) >= 2.7 ? 'hit' : 'plain'}">${combinedTG}</div></div>` : ''}
        `}
      </div>

      <div class="detail-panel">
        <div class="dp-head">Odds Timeline</div>
        <div class="dp-placeholder">
          <div class="dp-placeholder__icon">📈</div>
          <div class="dp-placeholder__title">Coming soon</div>
          <div class="dp-placeholder__sub">Tip-time → Pre-KO → Closing price movement and CLV</div>
          <div class="dp-placeholder__chip">ODDS MODULE</div>
        </div>
      </div>

      <div class="detail-panel">
        <div class="dp-head">Book Odds</div>
        <div class="dp-placeholder">
          <div class="dp-placeholder__icon">📚</div>
          <div class="dp-placeholder__title">Coming soon</div>
          <div class="dp-placeholder__sub">Multi-book O2.5 / U2.5 comparison with best price</div>
          <div class="dp-placeholder__chip">ODDS MODULE</div>
        </div>
      </div>

    </div>

    <div class="detail-signals">
      <div class="sig-head">
        <div class="sig-head-lbl">Signals</div>
      </div>
      <div class="sig-cols">
        <div>
          <div class="sig-col-head ${isU25 ? 'u25' : 'o25'}">
            ${isU25 ? 'U2.5' : 'O2.5'} Signals Fired
          </div>
          ${flagsHtml}
        </div>
        <div>
          <div class="sig-col-head" style="color:#66758c">Links</div>
          ${linksHtml || '<span style="color:#66758c;font-size:12px">No links</span>'}
        </div>
      </div>
    </div>

  </div>
</div>`;
}

// ── Filters ───────────────────────────────────────────────────
function applyFilters() {
  filters.league = document.getElementById('leagueFilter').value;
  renderShortlist();
}

document.querySelectorAll('.filter-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    var group = chip.dataset.group;
    document.querySelectorAll(`.filter-chip[data-group="${group}"]`).forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    filters[group] = chip.dataset.val;

    if (group === 'method') {
      populateLeagueFilter();
    }

    renderShortlist();
  });
});

// ── Refresh + poll ────────────────────────────────────────────
async function triggerRefresh() {
  document.getElementById('refreshBtn').disabled = true;
  await fetch('/api/refresh', { method: 'POST' });
  pollUntilDone();
}
async function pollUntilDone() {
  var s = await loadStatus();
  if (s === 'running') setTimeout(pollUntilDone, 2000);
  else await loadShortlist();
}

// ── Tab switching ─────────────────────────────────────────────
function switchTab(tab) {
  document.getElementById('tabShortlist').classList.toggle('active', tab === 'shortlist');
  document.getElementById('tabPerf').classList.toggle('active', tab === 'perf');
  document.getElementById('tabContext').classList.toggle('active', tab === 'context');
  document.getElementById('shortlistPanel').style.display = tab === 'shortlist' ? '' : 'none';
  document.getElementById('perfPanel').style.display     = tab === 'perf'      ? '' : 'none';
  document.getElementById('contextPanel').style.display  = tab === 'context'   ? '' : 'none';
  if (tab === 'perf')     loadPerformance();
  if (tab === 'context')  initContextResearch();
}

// ── Settle ────────────────────────────────────────────────────
async function triggerSettle(btn) {
  btn.disabled = true;
  btn.textContent = '⟳ Settling...';
  try {
    var r = await fetch('/api/settle', { method: 'POST' });
    var d = await r.json();
    btn.textContent = `✓ ${d.settled || 0} settled`;
    if (document.getElementById('tabPerf').classList.contains('active')) loadPerformance();
  } catch (e) {
    btn.textContent = '✗ Error';
  }
  setTimeout(() => { btn.textContent = '↻ Settle now'; btn.disabled = false; }, 3000);
}

// ── Performance ───────────────────────────────────────────────
function switchPerfMethod(method) {
  statsMethod = method;
  var isCtx = method === 'context_raw';
  document.getElementById('perfMethodCurrent').className =
    'market-tab' + (method === 'current' ? ' active' : '');
  document.getElementById('perfMethodCalibrated').className =
    'market-tab' + (method === 'calibrated' ? ' active' : '');
  document.getElementById('perfMethodContext').className =
    'market-tab' + (isCtx ? ' active' : '');

  // Show the correct content pane
  document.getElementById('perfContent').style.display    = isCtx ? 'none' : '';
  document.getElementById('ctxPerfContent').style.display = isCtx ? '' : 'none';

  if (statsData) {
    if (isCtx) renderCtxPerfSection(statsData);
    else renderPerformance(statsData);
  }
}

function switchPerfMarketTab(market) {
  activePerfMarket = market;
  document.getElementById('perfTabO25').className =
    'market-tab' + (market === 'over_2.5' ? ' active' : '');
  document.getElementById('perfTabU25').className =
    'market-tab' + (market === 'under_2.5' ? ' active-u25' : '');

  if (statsData) {
    const methodData = statsData.methods?.[statsMethod] || { recentSettled: [] };
    const arr = market === 'over_2.5'
      ? (methodData.recentSettledO25 || methodData.recentSettled || [])
      : (methodData.recentSettledU25 || methodData.recentSettled || []);
    renderPerfTable(arr);
  }
}

async function loadPerformance() {
  document.getElementById('perfLoading').style.display = 'block';
  document.getElementById('perfContent').style.display = 'none';
  document.getElementById('ctxPerfContent').style.display = 'none';

  try {
    const r = await fetch('/api/stats');
    statsData = await r.json();
    renderPerformance(statsData);
  } catch (e) {
    document.getElementById('perfLoading').textContent = 'Failed to load performance data.';
  }
}

function renderPerformance(d) {
  const current = d.methods?.current || {
    summary: {}, markets: {}, recentSettled: [], overlap: {}
  };
  const calibrated = d.methods?.calibrated || {
    summary: {}, markets: {}, recentSettled: [], overlap: {}
  };
  const methodData = d.methods?.[statsMethod] || current;
  const comparison = d.comparison?.overlap || { both: 0, current_only: 0, calibrated_only: 0 };

  // Hero CLV helper — colour thresholds per ARCHITECTURE.md:
  //   > +1.5% convincingly positive, 0–1.5% marginal, < 0% negative.
  // null CLV (no closing odds yet) shows as "— CLV" — never use 0 as placeholder.
  function heroCLV(s) {
    const clv = s?.meanCLVPct ?? null;
    const val = clv != null
      ? (clv >= 0 ? '+' : '') + clv.toFixed(1) + '% CLV'
      : '\u2014 CLV';
    const col = clv == null  ? '#66758c'
      : clv >  1.5           ? '#6ee7b7'
      : clv >= 0             ? '#fbbf24'
      :                        '#f87171';
    const hitRate = s?.hitRate != null ? s.hitRate + '%' : '\u2014';
    const settled = s?.settled || 0;
    return { val, col, sub: hitRate + ' hit \u00b7 ' + settled + ' settled' };
  }

  const curHero = heroCLV(current.summary);
  const calHero = heroCLV(calibrated.summary);

  const summaryCards = [
    {
      label:   'CURRENT',
      val:     curHero.val,
      col:     curHero.col,
      sub:     curHero.sub,
      tooltip: 'Mean CLV \u2014 how much tip-time odds beat the closing line. Positive = finding value before the market moves.',
    },
    {
      label:   'CALIBRATED',
      val:     calHero.val,
      col:     calHero.col,
      sub:     calHero.sub,
      tooltip: 'Mean CLV \u2014 how much tip-time odds beat the closing line. Positive = finding value before the market moves.',
    },
    {
      label:   'OVERLAP',
      val:     String(comparison.both || 0),
      col:     null,
      sub:     (comparison.current_only || 0) + ' cur-only \u00b7 ' + (comparison.calibrated_only || 0) + ' cal-only',
      tooltip: null,
    },
    {
      label:   'ACTIVE VIEW',
      val:     statsMethod === 'current' ? 'Current' : 'Calibrated',
      col:     null,
      sub:     (methodData.summary?.pending || 0) + ' pending',
      tooltip: null,
    },
  ];

  document.getElementById('perfSummaryCards').innerHTML = summaryCards.map(c =>
    '<div class="perf-hero-cell">' +
      '<div class="ph-label">' + c.label + (c.tooltip ? ' <span class="ctx-tip" title="' + c.tooltip + '" style="cursor:help;font-size:10px;opacity:.7">\u24d8</span>' : '') + '</div>' +
      '<div class="ph-val" style="' + (c.col ? 'color:' + c.col : '') + '">' + c.val + '</div>' +
      '<div class="ph-sub">' + c.sub + '</div>' +
    '</div>'
  ).join('');

  function mktPanel(label, m) {
    const hitColor = m.hitRate >= 55 ? '#6ee7b7' : m.hitRate >= 45 ? '#fbbf24' : '#f87171';
    const hitCls   = m.hitRate >= 55 ? 'green' : m.hitRate >= 45 ? 'amber' : 'red';
    const brierCls = m.brierScore != null
      ? (m.brierScore < 0.22 ? 'green' : m.brierScore < 0.26 ? 'amber' : 'red')
      : '';

    return `
      <div class="pmc-head">
        <div class="pmc-title">${label} <em>${m.total || 0} predictions</em></div>
        <div class="pmc-pending">${(m.pending || 0) + ((m.awaiting || 0) ? ' · ' + m.awaiting + ' awaiting' : '') + ' pending'}</div>
      </div>
      <div class="pmc-body">
        <div class="pmc-stat">
          <div class="pmc-stat-lbl">Hit Rate</div>
          <div class="pmc-stat-val ${hitCls}">${m.hitRate != null ? m.hitRate + '%' : '—'}</div>
          <div class="hit-bar"><div class="hit-fill" style="width:${m.hitRate || 0}%;background:${hitColor}"></div></div>
          <div class="pmc-stat-sub">${m.won || 0} of ${m.settled || 0} settled</div>
          <div style="height:10px"></div>
          <div class="pmc-stat-lbl">Brier Score</div>
          <div class="pmc-stat-val ${brierCls}">${m.brierScore != null ? m.brierScore : '—'}</div>
          <div class="pmc-stat-sub">${m.brierScore != null ? (m.brierScore < 0.22 ? 'Good' : m.brierScore < 0.26 ? 'Fair' : 'Needs calibration') : 'need data'}</div>
        </div>
        <div class="pmc-rows">
          <div class="pmc-row"><div class="pmc-row-lbl">Mean model prob</div><div class="pmc-row-val">${m.meanModelProb != null ? m.meanModelProb + '%' : '—'}</div></div>
          <div class="pmc-row"><div class="pmc-row-lbl">Mean edge at tip</div><div class="pmc-row-val ${m.meanEdgePct > 0 ? 'g' : 'r'}">${m.meanEdgePct != null ? (m.meanEdgePct > 0 ? '+' : '') + m.meanEdgePct + '%' : '—'}</div></div>
          <div class="pmc-row"><div class="pmc-row-lbl">Pre-KO move</div><div class="pmc-row-val">${m.meanPreKickoffMovePct != null ? (m.meanPreKickoffMovePct > 0 ? '+' : '') + m.meanPreKickoffMovePct + '%' : '—'}</div></div>
          <div class="pmc-row"><div class="pmc-row-lbl">Mean CLV</div><div class="pmc-row-val ${m.meanCLVPct > 0 ? 'g' : ''}">${m.meanCLVPct != null ? (m.meanCLVPct > 0 ? '+' : '') + m.meanCLVPct + '%' : '—'}</div></div>
          <div class="pmc-row"><div class="pmc-row-lbl">Units</div><div class="pmc-row-val ${(m.units || 0) >= 0 ? 'g' : 'r'}">${m.units != null ? ((m.units > 0 ? '+' : '') + m.units.toFixed(2) + 'u') : '—'}</div></div>
          <div class="pmc-row"><div class="pmc-row-lbl">ROI</div><div class="pmc-row-val ${(m.roi || 0) >= 0 ? 'g' : 'r'}">${m.roi != null ? ((m.roi > 0 ? '+' : '') + m.roi + '%') : '—'}</div></div>
        </div>
      </div>
      ${(m.settled || 0) < 30 ? `<div class="pmc-warn">⚠ Only ${m.settled || 0} settled. Early sample — read edge, CLV and Brier before hit rate.</div>` : ''}
    `;
  }

  document.getElementById('perfO25Panel').innerHTML =
    mktPanel('Over 2.5 Goals', methodData.markets?.['over_2.5'] || {});
  document.getElementById('perfU25Panel').innerHTML =
    mktPanel('Under 2.5 Goals', methodData.markets?.['under_2.5'] || {});

  const initArr = activePerfMarket === 'over_2.5'
    ? (methodData.recentSettledO25 || methodData.recentSettled || [])
    : (methodData.recentSettledU25 || methodData.recentSettled || []);
  renderPerfTable(initArr);

  document.getElementById('perfLoading').style.display = 'none';
  var isCtxActive = statsMethod === 'context_raw';
  document.getElementById('perfContent').style.display    = isCtxActive ? 'none' : 'block';
  document.getElementById('ctxPerfContent').style.display = isCtxActive ? 'block' : 'none';
  if (isCtxActive) { renderCtxPerfSection(d); return; }
}

function renderPerfTable(all) {
  const rows = all.filter(p => p.market === activePerfMarket);
  const tbody = document.getElementById('perfTableBody');

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="14" style="text-align:center;padding:2rem;color:#8b9ab0;font-size:13px">No settled ${statsMethod} ${activePerfMarket === 'over_2.5' ? 'Over 2.5' : 'Under 2.5'} predictions yet.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(p => {
    const edgeStr = p.edge != null
      ? `<span style="color:${edgeColor(p.edge)}">${p.edge > 0 ? '+' : ''}${p.edge.toFixed(1)}%</span>`
      : '—';

    const clvStr = p.clvPct != null
      ? `<span style="color:${clvColor(p.clvPct)}">${p.clvPct > 0 ? '+' : ''}${p.clvPct.toFixed(1)}%</span>`
      : '—';

    const moveColour = p.preKickoffMovePct != null
      ? (p.preKickoffMovePct < 0 ? '#6ee7b7' : p.preKickoffMovePct > 0 ? '#f87171' : '#8b9ab0')
      : '#8b9ab0';

    const moveDisplay = p.preKickoffMovePct != null
      ? `<span style="color:${moveColour}">${p.preKickoffMovePct > 0 ? '+' : ''}${p.preKickoffMovePct.toFixed(1)}%</span>`
      : '—';

    const resultScore = p.result || '—';
    const resultBadge = p.status === 'settled_won'
      ? `<span style="color:#6ee7b7;font-weight:700">✓ Won</span>`
      : p.status === 'settled_lost'
        ? `<span style="color:#f87171;font-weight:700">✗ Lost</span>`
        : '—';

    const grade = p.grade || p.inputs?.grade || '—';
    const dir = p.direction || (p.market === 'under_2.5' ? 'u25' : 'o25');

    return `<tr>
      <td style="color:#66758c;font-size:11px">${p.predictionDate}</td>
      <td>${p.homeTeam} vs ${p.awayTeam}</td>
      <td><span class="badge ${gradeClass(grade)}" style="font-size:10px;padding:3px 7px">${grade}</span></td>
      <td><span class="dir-badge ${dir === 'u25' ? 'dir-u25' : 'dir-o25'}" style="font-size:10px;padding:3px 7px">${dir === 'u25' ? 'U2.5' : 'O2.5'}</span></td>
      <td style="text-align:right;font-weight:700">${fmtProbPct(p.modelProbability)}</td>
      <td style="text-align:right;color:#66758c">${fmtVal(p.fairOdds)}</td>
      <td style="text-align:right;color:#c4b5fd">${fmtVal(p.marketOdds)}</td>
      <td style="text-align:right">${edgeStr}</td>
      <td style="text-align:right;color:#66758c">${fmtVal(p.preKickoffOdds)}</td>
      <td style="text-align:right">${moveDisplay}</td>
      <td style="text-align:right;color:#66758c">${fmtVal(p.closingOdds)}</td>
      <td style="text-align:right">${clvStr}</td>
      <td style="text-align:center;color:#67e8f9;font-weight:700">${resultScore}</td>
      <td style="text-align:center">${resultBadge}</td>
    </tr>`;
  }).join('');
}

// ── Init ──────────────────────────────────────────────────────
async function init() {
  var s = await loadStatus();
  await loadShortlist();
  if (s === 'running') pollUntilDone();

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
}
init();

// ═══════════════════════════════════════════════════════════════
// CONTEXT RESEARCH
// ═══════════════════════════════════════════════════════════════

// ── Constants ─────────────────────────────────────────────────
var FLAG_META = {
  strong_two_sided_over:    { key: 'strong_two_sided_over',    label: 'Strong Two-Sided Over',   abbr: 'STO',  role: 'attractor',  expected: '↑ O2.5', tooltip: 'STO — Strong Two-Sided Over: both teams show recent attacking strength and O2.5 frequency. Supports O2.5.' },
  both_leaky_defence:       { key: 'both_leaky_defence',       label: 'Both Leaky Defence',       abbr: 'BLD',  role: 'attractor',  expected: '↑ O2.5', tooltip: 'BLD — Both Leaky Defence: both teams conceding heavily recently despite scoring. Supports O2.5.' },
  concede_driven_over:      { key: 'concede_driven_over',      label: 'Concede Driven Over',      abbr: 'CDO',  role: 'suppressor', expected: '↓ O2.5', tooltip: 'CDO — Concede Driven Over: overs driven by conceding, not scoring. Underdog concedes heavily but doesn\'t score — suppresses O2.5.' },
  one_sided_over_risk:      { key: 'one_sided_over_risk',      label: 'One-Sided Over Risk',      abbr: 'OSIR', role: 'suppressor', expected: '↓ O2.5', tooltip: 'OSIR — One-Sided Over Risk: only one team has strong attacking output. The other may not contribute. Suppresses O2.5.' },
  low_attack_under_support: { key: 'low_attack_under_support', label: 'Low Attack Under Support', abbr: 'LAUS', role: 'suppressor', expected: '↓ O2.5', tooltip: 'LAUS — Low Attack Under Support: both teams show weak attacking output and high FTS rate. Supports U2.5, suppresses O2.5.' },
  both_weak_attack:         { key: 'both_weak_attack',         label: 'Both Weak Attack',         abbr: 'BWA',  role: 'suppressor', expected: '↓ O2.5', tooltip: 'BWA — Both Weak Attack: both teams averaging under 1 goal scored per game recently. Suppresses O2.5.' },
};

// ── State ─────────────────────────────────────────────────────
var ctxState = {
  allRows:       [],
  settled:       [],
  filtered:      [],
  index:         null,
  loaded:        false,
  loading:       false,
  loadedSeason:  null,      // tracks what dataset is currently in memory
  currentLeague: 'england',
  currentSeason: 'all',     // 'all' = aggregate, or e.g. '2024_25'
  page:          0,
  pageSize:      50,
  drawerRow:     null,
  filters: {
    direction:  'all',
    grade:      'all',
    result:     'all',
    flags:      [],
    gwMin:      1,
    gwMax:      38,
    viewMode:   'standard',  // 'standard' | 'gameweek' (aggregate mode only)
    seasonSort: 'newest',    // 'newest' | 'oldest' (gameweek mode only)
  },
};

// ── Init ──────────────────────────────────────────────────────
async function initContextResearch() {
  if (ctxState.loading) return;
  // If already loaded the correct season, just render
  if (ctxState.loaded && ctxState.loadedSeason === ctxState.currentSeason) {
    renderCtx();
    return;
  }

  // Phase 1: load index (once per session)
  if (!ctxState.index) {
    document.getElementById('ctxLoading').style.display = 'block';
    document.getElementById('ctxContent').style.display = 'none';
    document.getElementById('ctxLoading').textContent = 'Loading index...';
    try {
      var ir = await fetch('/api/context/index');
      ctxState.index = await ir.json();
    } catch (e) {
      document.getElementById('ctxLoading').textContent = '⚠ Failed to load index: ' + e.message;
      return;
    }
  }

  // Phase 2: load backtest data for selected season
  await loadContextSeason(ctxState.currentSeason);
}

// ── Season loader — handles single season or aggregate ────────
async function loadContextSeason(season) {
  if (ctxState.loading) return;
  ctxState.loading = true;
  ctxState.loaded  = false;

  document.getElementById('ctxLoading').style.display = 'block';
  document.getElementById('ctxContent').style.display = 'none';
  document.getElementById('ctxLoading').textContent = season === 'all'
    ? 'Loading all seasons...'
    : 'Loading ' + season.replace('_', '-') + '...';

  try {
    var allRows;

    if (season === 'all') {
      // Load all seasons for this league in parallel
      var entries = (ctxState.index.leagues || [])
        .filter(function(l) { return l.league === ctxState.currentLeague; });

      var fetches = entries.map(function(entry) {
        var s = entry.season.replace('-', '_');
        return fetch('/api/context/backtest?league=' + ctxState.currentLeague + '&season=' + s)
          .then(function(r) { return r.ok ? r.json() : []; })
          .catch(function() { return []; });
      });

      var results = await Promise.all(fetches);
      // Flatten and sort by date so the table is chronological
      allRows = results.reduce(function(acc, arr) { return acc.concat(arr); }, [])
        .sort(function(a, b) { return (a.fixtureDate || '').localeCompare(b.fixtureDate || ''); });

    } else {
      // Load single season
      var r = await fetch('/api/context/backtest?league=' + ctxState.currentLeague + '&season=' + season);
      if (!r.ok) throw new Error('Backtest not found: ' + r.status);
      allRows = await r.json();
    }

    ctxState.allRows      = allRows;
    ctxState.settled      = allRows.filter(function(r) { return r.status === 'settled'; });
    ctxState.currentSeason = season;
    ctxState.loadedSeason  = season;
    ctxState.loaded        = true;
    ctxState.loading       = false;

    // Reset filters on season change
    ctxState.filters.direction = 'all';
    ctxState.filters.grade     = 'all';
    ctxState.filters.result    = 'all';
    ctxState.filters.flags     = [];
    ctxState.page              = 0;
    // Gameweek mode only makes sense in aggregate — reset when switching to single season
    if (season !== 'all') ctxState.filters.viewMode = 'standard';

    // Set gameweek slider range from actual data
    var maxGw = Math.max.apply(null, ctxState.settled.map(function(r) { return r.gameweek || 0; }));
    if (maxGw > 1) {
      ctxState.filters.gwMax = maxGw;
      var minEl = document.getElementById('ctxGwMin');
      var maxEl = document.getElementById('ctxGwMax');
      if (minEl) { minEl.max = maxGw; minEl.value = 1; }
      if (maxEl) { maxEl.max = maxGw; maxEl.value = maxGw; }
      ctxState.filters.gwMin = 1;
    }

    // Populate season selector and rebuild flag checkboxes
    populateSeasonSelector();
    buildFlagCheckboxes();
    applyCtxFilters();
    renderCtx();

    document.getElementById('ctxLoading').style.display = 'none';
    document.getElementById('ctxContent').style.display = 'block';

  } catch (e) {
    ctxState.loading = false;
    document.getElementById('ctxLoading').textContent = '⚠ Failed to load data: ' + e.message;
    console.error('[ctx] load error:', e);
  }
}

// ── Season selector population ────────────────────────────────
function populateSeasonSelector() {
  var sel = document.getElementById('ctxSeasonSelect');
  if (!sel || !ctxState.index) return;

  // Preserve current value before rebuilding
  var current = ctxState.currentSeason;

  sel.innerHTML = '<option value="all">All seasons (aggregate)</option>';

  var entries = (ctxState.index.leagues || [])
    .filter(function(l) { return l.league === ctxState.currentLeague; })
    .sort(function(a, b) { return b.season.localeCompare(a.season); }); // newest first

  entries.forEach(function(entry) {
    var opt = document.createElement('option');
    opt.value = entry.season.replace('-', '_');
    opt.textContent = entry.season + '  (' + entry.predictions + ' preds · ' + Math.round(entry.hitRate * 1000) / 10 + '%)';
    if (opt.value === current) opt.selected = true;
    sel.appendChild(opt);
  });

  // If current is 'all', ensure All seasons option is selected
  if (current === 'all') sel.value = 'all';
}

// ── Season change handler ─────────────────────────────────────
function ctxSeasonChange() {
  var sel = document.getElementById('ctxSeasonSelect');
  var newSeason = sel ? sel.value : 'all';
  if (newSeason === ctxState.loadedSeason) return; // no-op if already loaded
  ctxState.currentSeason = newSeason;
  loadContextSeason(newSeason);
}

function buildFlagCheckboxes() {
  var wrap = document.getElementById('ctxFlagChecks');
  if (!wrap) return;
  wrap.innerHTML = Object.values(FLAG_META).map(function(meta) {
    return '<label class="ctx-flag-check-label" title="' + meta.tooltip + '">' +
      '<input type="checkbox" value="' + meta.key + '" onchange="ctxFlagCheck(\'' + meta.key + '\', this.checked)">' +
      meta.abbr +
    '</label>';
  }).join('');
}

// ── Filter application ────────────────────────────────────────
function applyCtxFilters() {
  var f = ctxState.filters;
  ctxState.filtered = ctxState.settled.filter(function(r) {
    if (f.direction !== 'all' && r.context_direction !== f.direction) return false;
    if (f.grade !== 'all' && r.context_grade !== f.grade) return false;
    if (f.result === 'won'  && r.won !== true)  return false;
    if (f.result === 'lost' && r.won !== false) return false;
    if (r.gameweek < f.gwMin || r.gameweek > f.gwMax) return false;
    if (f.flags.length > 0) {
      for (var i = 0; i < f.flags.length; i++) {
        var flag = f.flags[i];
        if (flag === 'concede_driven_over') {
          if (!r.flags || (!r.flags.concede_driven_over_home && !r.flags.concede_driven_over_away)) return false;
        } else {
          if (!r.flags || !r.flags[flag]) return false;
        }
      }
    }
    return true;
  });
  ctxState.page = 0;
}

// ── Master render ─────────────────────────────────────────────
function renderCtx() {
  renderCtxSelector();
  renderCtxCards();
  renderCtxFilterBar();
  renderFlagTable();
  renderGwChart();
  renderEdgeChart();
  renderCtxTable();
}

// ── Selector strip ────────────────────────────────────────────
function renderCtxSelector() {
  var idx  = ctxState.index;
  var meta = '';

  if (idx && idx.leagues) {
    var leagueEntries = idx.leagues
      .filter(function(l) { return l.league === ctxState.currentLeague; })
      .sort(function(a, b) { return a.season.localeCompare(b.season); }); // asc for range display

    if (ctxState.currentSeason === 'all') {
      var totalPreds   = ctxState.settled.length;
      var seasonCount  = leagueEntries.length;
      var earliest     = leagueEntries.length > 0 ? leagueEntries[0].season : '';
      var latest       = leagueEntries.length > 0 ? leagueEntries[leagueEntries.length - 1].season : '';
      var rangeStr     = seasonCount > 1 ? earliest + ' to ' + latest : earliest;
      meta = totalPreds + ' predictions across ' + seasonCount + ' seasons (' + rangeStr + ') · model context_raw_v1.2 · features pre_match_v1';
    } else {
      var entry = idx.leagues.find(function(l) {
        return l.league === ctxState.currentLeague &&
               l.season.replace('-', '_') === ctxState.currentSeason;
      });
      if (entry) {
        meta = entry.predictions + ' of ' + entry.fixtures + ' fixtures predicted · ' +
               entry.season + ' · model ' + entry.modelVersion + ' · features ' + entry.featureSetVersion;
      }
    }
  }

  var el = document.getElementById('ctxSelectorMeta');
  if (el) el.textContent = meta;

  // Keep the season select in sync
  populateSeasonSelector();
}

// ── Headline cards ────────────────────────────────────────────
function renderCtxCards() {
  var rows  = ctxState.filtered;
  var total = rows.length;
  var won   = rows.filter(function(r) { return r.won === true; }).length;
  var o25   = rows.filter(function(r) { return r.context_direction === 'o25'; });
  var u25   = rows.filter(function(r) { return r.context_direction === 'u25'; });
  var o25w  = o25.filter(function(r) { return r.won === true; }).length;
  var u25w  = u25.filter(function(r) { return r.won === true; }).length;

  var roiRows = rows.filter(function(r) { return r.marketOdds != null && r.won !== null; });
  var pnl = roiRows.reduce(function(s, r) { return s + (r.won ? (r.marketOdds - 1) : -1); }, 0);
  var roi = roiRows.length > 0 ? (pnl / roiRows.length * 100) : null;

  var clvRows = rows.filter(function(r) { return r.clv_pct != null; });
  var meanCLV = clvRows.length > 0
    ? clvRows.reduce(function(s, r) { return s + r.clv_pct; }, 0) / clvRows.length
    : null;

  function hr(n, d) { return d > 0 ? Math.round(n / d * 1000) / 10 : null; }
  function hrStr(n, d) { var v = hr(n, d); return v != null ? v + '%' : '—'; }
  function hrCol(v) { return v == null ? '#66758c' : v >= 57 ? '#6ee7b7' : v >= 52 ? '#fbbf24' : '#f87171'; }

  var hitR  = hr(won, total);
  var o25R  = hr(o25w, o25.length);
  var u25R  = hr(u25w, u25.length);
  var pnlStr = (pnl >= 0 ? '+' : '') + pnl.toFixed(2);

  var cards = [
    { label: 'Hit Rate', val: hrStr(won, total),       sub: won + ' / ' + total,             color: hrCol(hitR) },
    { label: 'O2.5',     val: hrStr(o25w, o25.length), sub: o25w + ' / ' + o25.length,       color: hrCol(o25R) },
    { label: 'U2.5',     val: hrStr(u25w, u25.length), sub: u25w + ' / ' + u25.length,       color: hrCol(u25R) },
    {
      label: 'ROI',
      val: roi != null ? (roi >= 0 ? '+' : '') + roi.toFixed(1) + '%' : '—',
      sub: roiRows.length > 0 ? pnlStr + 'u · ' + roiRows.length + ' bets' : '—',
      color: roi != null ? (roi >= 2 ? '#6ee7b7' : roi >= -2 ? '#fbbf24' : '#f87171') : '#66758c',
      tip: 'Model is uncalibrated — ROI gap expected until context_calibrated (Stage 10).',
    },
    {
      label: 'Mean CLV',
      val: meanCLV != null ? (meanCLV >= 0 ? '+' : '') + meanCLV.toFixed(2) + '%' : '—',
      sub: clvRows.length + ' of ' + total + ' with closing odds',
      color: meanCLV != null ? (meanCLV >= 1 ? '#6ee7b7' : meanCLV >= 0 ? '#fbbf24' : '#f87171') : '#66758c',
    },
  ];

  document.getElementById('ctxCards').innerHTML = cards.map(function(c) {
    return '<div class="perf-hero-cell">' +
      '<div class="ph-label">' + c.label + (c.tip ? ' <span class="ctx-tip" title="' + c.tip + '" style="cursor:help">ⓘ</span>' : '') + '</div>' +
      '<div class="ph-val" style="color:' + c.color + '">' + c.val + '</div>' +
      '<div class="ph-sub">' + c.sub + '</div>' +
    '</div>';
  }).join('');
}

// ── Filter bar update ─────────────────────────────────────────
function renderCtxFilterBar() {
  var f           = ctxState.filters;
  var isAggregate = ctxState.currentSeason === 'all';
  var isGwMode    = f.viewMode === 'gameweek' && isAggregate;

  document.querySelectorAll('.ctx-chip[data-ctxgroup]').forEach(function(chip) {
    chip.classList.toggle('active', f[chip.dataset.ctxgroup] === chip.dataset.ctxval);
  });

  var gwEl = document.getElementById('ctxGwDisplay');
  if (gwEl) gwEl.textContent = 'GW ' + f.gwMin + ' – ' + f.gwMax;

  var gwNote = document.getElementById('ctxGwNote');
  if (gwNote) gwNote.style.display = isAggregate ? 'inline' : 'none';

  // View mode row: only visible in aggregate mode
  var vmRow = document.getElementById('ctxViewModeRow');
  if (vmRow) vmRow.style.display = isAggregate ? 'flex' : 'none';

  // Season sort: only visible in gameweek mode
  var ssWrap = document.getElementById('ctxSeasonSortWrap');
  if (ssWrap) ssWrap.style.display = isGwMode ? 'inline-flex' : 'none';

  var countEl = document.getElementById('ctxFilterCount');
  if (countEl) countEl.textContent = 'Showing ' + ctxState.filtered.length + ' of ' + ctxState.settled.length + ' settled predictions';
}

// ── Filter event handlers ─────────────────────────────────────
function ctxChipClick(chip) {
  var group = chip.dataset.ctxgroup;
  var val   = chip.dataset.ctxval;
  ctxState.filters[group] = val;

  // viewMode/seasonSort only affect rendering — no re-filter needed
  if (group === 'viewMode' || group === 'seasonSort') {
    renderCtxFilterBar();
    renderCtxTable();
    return;
  }

  applyCtxFilters();
  renderCtxCards();
  renderCtxFilterBar();
  renderFlagTable();
  renderCtxTable();
}

function ctxFlagCheck(key, checked) {
  var flags = ctxState.filters.flags;
  if (checked) {
    if (flags.indexOf(key) === -1) flags.push(key);
  } else {
    ctxState.filters.flags = flags.filter(function(f) { return f !== key; });
  }
  applyCtxFilters();
  renderCtxCards();
  renderCtxFilterBar();
  renderCtxTable();
}

function ctxGwChange() {
  var minEl = document.getElementById('ctxGwMin');
  var maxEl = document.getElementById('ctxGwMax');
  var minV  = parseInt(minEl.value);
  var maxV  = parseInt(maxEl.value);
  if (minV > maxV) { minEl.value = maxV; minV = maxV; }
  ctxState.filters.gwMin = minV;
  ctxState.filters.gwMax = maxV;
  applyCtxFilters();
  renderCtxCards();
  renderCtxFilterBar();
  renderFlagTable();
  renderGwChart();
  renderCtxTable();
}

// ── Flag performance table ────────────────────────────────────
function renderFlagTable() {
  // Apply direction/grade/result/gameweek filters — but NOT flag filters.
  // This lets you see how flags behave within a slice (e.g. O2.5 + Grade A)
  // without the circular logic of filtering by a flag and reading its own row.
  var f = ctxState.filters;
  var rows = ctxState.settled.filter(function(r) {
    if (f.direction !== 'all' && r.context_direction !== f.direction) return false;
    if (f.grade !== 'all' && r.context_grade !== f.grade) return false;
    if (f.result === 'won'  && r.won !== true)  return false;
    if (f.result === 'lost' && r.won !== false) return false;
    if (r.gameweek != null && (r.gameweek < f.gwMin || r.gameweek > f.gwMax)) return false;
    return true;
  });

  // Build description of active slice for the header note
  var sliceParts = [];
  if (f.direction !== 'all') sliceParts.push(f.direction === 'o25' ? 'O2.5' : 'U2.5');
  if (f.grade !== 'all')     sliceParts.push('Grade ' + f.grade);
  if (f.result !== 'all')    sliceParts.push(f.result.charAt(0).toUpperCase() + f.result.slice(1));
  if (f.gwMin > 1 || f.gwMax < 999) sliceParts.push('GW ' + f.gwMin + '–' + f.gwMax);
  var sliceNote = sliceParts.length > 0
    ? rows.length + ' predictions matching current filters (flag filters excluded)'
    : rows.length + ' settled predictions · season/league/direction/grade filters applied · flag filters excluded';

  var html = '<div class="ctx-panel-head">Flag Performance' +
    '<span style="color:#66758c;font-size:10px;font-weight:400;text-transform:none;letter-spacing:0;margin-left:10px">' +
    sliceNote + '</span></div>' +
    '<div style="overflow-x:auto"><table class="ctx-flag-table">' +
    '<thead><tr>' +
    '<th>Flag</th><th>Fired</th><th>Expected</th>' +
    '<th>O2.5 hit (fired)</th><th>O2.5 hit (not fired)</th><th>Δ</th><th>Signal</th>' +
    '</tr></thead><tbody>';

  Object.values(FLAG_META).forEach(function(meta) {
    var key = meta.key;
    var fired;
    if (key === 'concede_driven_over') {
      fired = rows.filter(function(r) { return r.flags && (r.flags.concede_driven_over_home || r.flags.concede_driven_over_away); });
    } else {
      fired = rows.filter(function(r) { return r.flags && r.flags[key]; });
    }
    var notFired = rows.filter(function(r) { return fired.indexOf(r) === -1; });

    var fO25  = fired.filter(function(r) { return r.context_direction === 'o25'; });
    var fO25w = fO25.filter(function(r) { return r.won; }).length;
    var nO25  = notFired.filter(function(r) { return r.context_direction === 'o25'; });
    var nO25w = nO25.filter(function(r) { return r.won; }).length;

    var fRate = fO25.length  > 0 ? fO25w  / fO25.length  * 100 : null;
    var nRate = nO25.length  > 0 ? nO25w  / nO25.length  * 100 : null;
    var delta = (fRate != null && nRate != null) ? fRate - nRate : null;
    var isLowN = fired.length < 10;

    var signal = '—', sigColor = '#66758c';
    if (!isLowN && delta != null) {
      var correct  = (meta.role === 'attractor' && delta > 2) || (meta.role === 'suppressor' && delta < -2);
      var wrong    = (meta.role === 'attractor' && delta < -2) || (meta.role === 'suppressor' && delta > 2);
      if (correct)    { signal = '✓'; sigColor = '#6ee7b7'; }
      else if (wrong) { signal = '⚠'; sigColor = '#fbbf24'; }
      else            { signal = '~'; sigColor = '#66758c'; }
    }

    var dStr  = delta != null ? (delta > 0 ? '+' : '') + delta.toFixed(1) + 'pp' : '—';
    var dCol  = delta != null ? (delta > 2 ? '#6ee7b7' : delta < -2 ? '#f87171' : '#66758c') : '#66758c';

    html += '<tr' + (isLowN ? ' style="opacity:.5"' : '') + '>' +
      '<td>' + meta.label + (isLowN ? ' <span style="font-size:10px;color:#66758c">(low N)</span>' : '') + '</td>' +
      '<td>' + fired.length + '</td>' +
      '<td style="color:#94a3b8">' + meta.expected + '</td>' +
      '<td>' + (fRate != null ? fRate.toFixed(1) + '%' : '—') + '</td>' +
      '<td>' + (nRate != null ? nRate.toFixed(1) + '%' : '—') + '</td>' +
      '<td style="color:' + dCol + ';font-weight:600">' + dStr + '</td>' +
      '<td style="color:' + sigColor + ';font-weight:700;font-size:15px">' + signal + '</td>' +
    '</tr>';
  });

  html += '</tbody></table></div>';
  document.getElementById('ctxFlagTable').innerHTML = html;
}

// ── Gameweek hit-rate chart ───────────────────────────────────
function renderGwChart() {
  var f    = ctxState.filters;
  var rows = ctxState.settled.filter(function(r) {
    return r.gameweek >= f.gwMin && r.gameweek <= f.gwMax;
  });

  var gwData = {};
  rows.forEach(function(r) {
    var gw = r.gameweek || 0;
    if (!gwData[gw]) gwData[gw] = { won: 0, total: 0 };
    gwData[gw].total++;
    if (r.won) gwData[gw].won++;
  });

  var gws = Object.keys(gwData).map(Number).sort(function(a, b) { return a - b; });
  var el  = document.getElementById('ctxGwChart');

  if (!gws.length) {
    el.innerHTML = '<div class="ctx-panel-head">Hit Rate by Gameweek</div><div style="text-align:center;color:#66758c;padding:2rem;font-size:12px">No data for selected range</div>';
    return;
  }

  var totalWon   = rows.filter(function(r) { return r.won; }).length;
  var seasonAvg  = rows.length > 0 ? totalWon / rows.length : 0;
  var maxGw      = Math.max.apply(null, gws);
  var W = 620, H = 150, PL = 34, PR = 28, PT = 14, PB = 26;
  var CW = W - PL - PR, CH = H - PT - PB;
  var slotW = CW / Math.max(maxGw, 1);
  var barW  = Math.max(3, Math.min(14, Math.floor(slotW) - 3));
  var avgY  = PT + CH * (1 - seasonAvg);

  var yTicks = [0, 25, 50, 75, 100];
  var xLabels = gws.filter(function(gw) { return gw === 1 || gw % 5 === 0 || gw === maxGw; });
  var maxVol = Math.max.apply(null, gws.map(function(gw) { return gwData[gw].total; }));

  var gridLines = yTicks.map(function(pct) {
    var y = PT + CH * (1 - pct / 100);
    return '<line x1="' + PL + '" y1="' + y + '" x2="' + (W - PR) + '" y2="' + y + '" stroke="' +
      (pct === 50 ? '#3d4f6a' : '#1a2535') + '" stroke-width="' + (pct === 50 ? 1.2 : 0.5) + '"' +
      (pct === 50 ? ' stroke-dasharray="4,3"' : '') + '/>' +
      '<text x="' + (PL - 4) + '" y="' + (y + 4) + '" text-anchor="end" fill="#44576e" font-size="9">' + pct + '%</text>';
  }).join('');

  var bars = gws.map(function(gw) {
    var d    = gwData[gw];
    var rate = d.total > 0 ? d.won / d.total : null;
    var x    = PL + (gw - 0.5) / maxGw * CW - barW / 2;
    var bH   = rate != null ? rate * CH : 0;
    var y    = PT + CH - bH;
    var col  = rate == null ? '#1e2d3d'
             : rate >= seasonAvg + 0.05 ? '#34d399'
             : rate >= seasonAvg - 0.05 ? '#fbbf24' : '#f87171';
    var volH = maxVol > 0 ? d.total / maxVol * 11 : 0;
    var volY = H - PB - volH;
    return '<rect x="' + x + '" y="' + y + '" width="' + barW + '" height="' + bH + '" fill="' + col + '" opacity=".7" rx="2">' +
        '<title>GW' + gw + ': ' + (rate != null ? Math.round(rate * 100) : '—') + '% (' + d.total + ' preds)</title>' +
      '</rect>' +
      '<rect x="' + x + '" y="' + volY + '" width="' + barW + '" height="' + volH + '" fill="#2a3f5f" opacity=".8" rx="1">' +
        '<title>GW' + gw + ': ' + d.total + ' predictions</title>' +
      '</rect>';
  }).join('');

  var xAxisLabels = xLabels.map(function(gw) {
    var x = PL + (gw - 0.5) / maxGw * CW;
    return '<text x="' + x + '" y="' + (H - 4) + '" text-anchor="middle" fill="#44576e" font-size="9">' + gw + '</text>';
  }).join('');

  var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:' + H + 'px">' +
    gridLines +
    '<line x1="' + PL + '" y1="' + avgY + '" x2="' + (W - PR) + '" y2="' + avgY + '" stroke="#818cf8" stroke-width="1" stroke-dasharray="5,3" opacity=".65"/>' +
    '<text x="' + (W - PR + 2) + '" y="' + (avgY + 4) + '" fill="#818cf8" font-size="9" opacity=".65">' + Math.round(seasonAvg * 100) + '%</text>' +
    bars + xAxisLabels +
  '</svg>';

  el.innerHTML = '<div class="ctx-panel-head">Hit Rate by Gameweek</div>' +
    '<div style="color:#44576e;font-size:11px;margin-bottom:6px">Green = above avg · Amber = near avg · Red = below avg · Purple dashed = season avg · Bottom strip = volume</div>' + svg;
}

// ── Edge vs outcome chart ─────────────────────────────────────
function renderEdgeChart() {
  var rows = ctxState.settled.filter(function(r) { return r.edge_pct != null && r.won !== null; });
  var el   = document.getElementById('ctxEdgeChart');

  var buckets = [
    { label: '< 0%',   min: -Infinity, max: 0   },
    { label: '0–5%',   min: 0,         max: 5   },
    { label: '5–10%',  min: 5,         max: 10  },
    { label: '10–15%', min: 10,        max: 15  },
    { label: '15–20%', min: 15,        max: 20  },
    { label: '20–25%', min: 20,        max: 25  },
    { label: '25%+',   min: 25,        max: Infinity },
  ];

  var bData = buckets.map(function(b) {
    var br  = rows.filter(function(r) { return r.edge_pct >= b.min && r.edge_pct < b.max; });
    var won = br.filter(function(r) { return r.won; }).length;
    return { label: b.label, total: br.length, won: won, rate: br.length > 0 ? won / br.length * 100 : null };
  }).filter(function(b) { return b.total > 0; });

  if (!bData.length) {
    el.innerHTML = '<div class="ctx-panel-head">Edge vs Outcome</div><div style="text-align:center;color:#66758c;padding:2rem;font-size:12px">No edge data</div>';
    return;
  }

  var totalWon  = rows.filter(function(r) { return r.won; }).length;
  var seasonAvg = rows.length > 0 ? totalWon / rows.length * 100 : 50;
  var W = 420, H = 150, PL = 34, PR = 14, PT = 14, PB = 26;
  var CW = W - PL - PR, CH = H - PT - PB;
  var bCount = bData.length;
  var barW   = Math.floor(CW / bCount) - 8;
  var avgY   = PT + CH * (1 - seasonAvg / 100);

  var yTicks  = [0, 25, 50, 75, 100];
  var gridLines = yTicks.map(function(pct) {
    var y = PT + CH * (1 - pct / 100);
    return '<line x1="' + PL + '" y1="' + y + '" x2="' + (W - PR) + '" y2="' + y + '" stroke="' +
      (pct === 50 ? '#3d4f6a' : '#1a2535') + '" stroke-width="' + (pct === 50 ? 1.2 : 0.5) + '"' +
      (pct === 50 ? ' stroke-dasharray="4,3"' : '') + '/>' +
      '<text x="' + (PL - 4) + '" y="' + (y + 4) + '" text-anchor="end" fill="#44576e" font-size="9">' + pct + '%</text>';
  }).join('');

  var bars = bData.map(function(b, i) {
    if (b.rate == null) return '';
    var x   = PL + i * (CW / bCount) + (CW / bCount - barW) / 2;
    var bH  = b.rate / 100 * CH;
    var y   = PT + CH - bH;
    var col = b.total < 5 ? '#2a3448'
            : b.rate >= seasonAvg + 5 ? '#34d399'
            : b.rate >= seasonAvg - 5 ? '#fbbf24' : '#f87171';
    var cx  = x + barW / 2;
    var nY  = Math.max(y - 3, PT + 10);
    return '<rect x="' + x + '" y="' + y + '" width="' + barW + '" height="' + bH + '" fill="' + col +
        '" opacity="' + (b.total < 5 ? '.35' : '.75') + '" rx="2">' +
        '<title>' + b.label + ': ' + b.rate.toFixed(1) + '% (n=' + b.total + ')</title></rect>' +
      '<text x="' + cx + '" y="' + nY + '" text-anchor="middle" fill="#44576e" font-size="8">n=' + b.total + '</text>' +
      '<text x="' + cx + '" y="' + (H - 4) + '" text-anchor="middle" fill="#44576e" font-size="8">' + b.label + '</text>';
  }).join('');

  var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:' + H + 'px">' +
    gridLines +
    '<line x1="' + PL + '" y1="' + avgY + '" x2="' + (W - PR) + '" y2="' + avgY + '" stroke="#818cf8" stroke-width="1" stroke-dasharray="5,3" opacity=".65"/>' +
    bars +
  '</svg>';

  el.innerHTML = '<div class="ctx-panel-head">Edge vs Outcome</div>' +
    '<div style="color:#44576e;font-size:11px;margin-bottom:6px">Upward slope = edge ranking is meaningful. Flat = calibration needed. Purple = avg hit rate.</div>' + svg;
}

// ── Predictions table ─────────────────────────────────────────
// ── Helper: open drawer by fixtureId (used in gameweek mode) ─
function openCtxDrawerById(fixtureId) {
  var row = ctxState.filtered.find(function(r) { return r.fixtureId === fixtureId; });
  openCtxDrawer(row);
}

// ── Predictions table — branches on viewMode ──────────────────
function renderCtxTable() {
  var isAggregate = ctxState.currentSeason === 'all';
  var isGwMode    = ctxState.filters.viewMode === 'gameweek' && isAggregate;

  var countEl = document.getElementById('ctxFilterCount');
  if (countEl) countEl.textContent = 'Showing ' + ctxState.filtered.length + ' of ' + ctxState.settled.length + ' settled predictions';

  if (isGwMode) {
    renderCtxTableGameweek();
  } else {
    renderCtxTableStandard();
  }
}

// ── Standard table (paginated) ────────────────────────────────
function renderCtxTableStandard() {
  var rows       = ctxState.filtered;
  var pageSize   = ctxState.pageSize;
  var page       = ctxState.page;
  var total      = rows.length;
  var totalPages = Math.ceil(total / pageSize);
  var pageRows   = rows.slice(page * pageSize, (page + 1) * pageSize);

  if (!pageRows.length) {
    document.getElementById('ctxTableWrap').innerHTML =
      '<div style="text-align:center;padding:2rem;color:#66758c;font-size:13px">No predictions match these filters.</div>';
    return;
  }

  var tbody = pageRows.map(function(r, i) {
    var globalIdx = page * pageSize + i;
    return buildCtxRowHTML(r, 'onclick="openCtxDrawer(ctxState.filtered[' + globalIdx + '])"', false);
  }).join('');

  var pagination = totalPages > 1
    ? '<div class="ctx-pagination">' +
        '<button class="ctx-page-btn" onclick="ctxPageNav(-1)"' + (page === 0 ? ' disabled' : '') + '>← Prev</button>' +
        '<span style="color:#66758c;font-size:12px">Page ' + (page + 1) + ' of ' + totalPages + '</span>' +
        '<button class="ctx-page-btn" onclick="ctxPageNav(1)"' + (page >= totalPages - 1 ? ' disabled' : '') + '>Next →</button>' +
      '</div>'
    : '';

  document.getElementById('ctxTableWrap').innerHTML =
    '<table class="ctx-table">' +
      '<thead><tr>' +
        '<th>GW</th><th>Date</th><th>Match</th><th>Dir</th><th>Grade</th>' +
        '<th>Flags</th>' +
        '<th style="text-align:right">Fair</th><th style="text-align:right">Odds</th>' +
        '<th style="text-align:right">Edge</th><th style="text-align:right">CLV</th>' +
        '<th style="text-align:center">Score</th><th style="text-align:center">Won</th>' +
      '</tr></thead>' +
      '<tbody>' + tbody + '</tbody>' +
    '</table>' + pagination;
}

// ── Gameweek mode table (grouped, no pagination) ──────────────
function renderCtxTableGameweek() {
  var rows      = ctxState.filtered;
  var isNewest  = ctxState.filters.seasonSort === 'newest';

  if (!rows.length) {
    document.getElementById('ctxTableWrap').innerHTML =
      '<div style="text-align:center;padding:2rem;color:#66758c;font-size:13px">No predictions match these filters.</div>';
    return;
  }

  // Group by gameweek
  var groups = {};
  rows.forEach(function(r) {
    var gw = r.gameweek || 0;
    if (!groups[gw]) groups[gw] = [];
    groups[gw].push(r);
  });

  // Sort GW numbers ascending
  var gwNums = Object.keys(groups).map(Number).sort(function(a, b) { return a - b; });

  // Sort rows within each GW by season
  gwNums.forEach(function(gw) {
    groups[gw].sort(function(a, b) {
      var sa = a.season || '';
      var sb = b.season || '';
      return isNewest ? sb.localeCompare(sa) : sa.localeCompare(sb);
    });
  });

  var html = '<div style="color:#44576e;font-size:11px;padding:10px 16px 6px;font-style:italic">' +
    'Showing matches grouped by gameweek across seasons. Season sort: ' +
    (isNewest ? 'newest first' : 'oldest first') + '.' +
  '</div>';

  gwNums.forEach(function(gw) {
    var gwRows = groups[gw];
    var won    = gwRows.filter(function(r) { return r.won === true; }).length;
    var hitStr = gwRows.length > 0 ? Math.round(won / gwRows.length * 100) + '%' : '—';

    html +=
      '<div style="padding:10px 16px 4px;border-top:1px solid rgba(255,255,255,.07);margin-top:2px;display:flex;align-items:center;gap:10px">' +
        '<span style="font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.1em;min-width:32px">GW ' + gw + '</span>' +
        '<span style="font-size:10px;color:#44576e">' + gwRows.length + ' match' + (gwRows.length !== 1 ? 'es' : '') + '</span>' +
        '<span style="font-size:10px;color:#44576e">·</span>' +
        '<span style="font-size:10px;color:' + (won / gwRows.length >= 0.57 ? '#6ee7b7' : '#66758c') + '">' + hitStr + ' hit rate</span>' +
      '</div>' +
      '<table class="ctx-table" style="width:100%;border-collapse:collapse;margin-bottom:6px">' +
        '<thead><tr>' +
          '<th>Season</th><th>Date</th><th>Match</th><th>Dir</th><th>Grade</th>' +
          '<th>Flags</th>' +
          '<th style="text-align:right">Fair</th><th style="text-align:right">Odds</th>' +
          '<th style="text-align:right">Edge</th><th style="text-align:right">CLV</th>' +
          '<th style="text-align:center">Score</th><th style="text-align:center">Won</th>' +
        '</tr></thead>' +
        '<tbody>' +
        gwRows.map(function(r) {
          return buildCtxRowHTML(r, 'onclick="openCtxDrawerById(\'' + r.fixtureId + '\')"', true);
        }).join('') +
        '</tbody>' +
      '</table>';
  });

  document.getElementById('ctxTableWrap').innerHTML = html;
}

// ── Shared row builder ────────────────────────────────────────
// gwMode=true: first column shows season label instead of GW number
function buildCtxRowHTML(r, onclickAttr, gwMode) {
  var isO25 = r.context_direction === 'o25';

  var dirBadge = isO25
    ? '<span class="dir-badge dir-o25" style="font-size:10px;padding:3px 7px">O2.5</span>'
    : '<span class="dir-badge dir-u25" style="font-size:10px;padding:3px 7px">U2.5</span>';

  var gradeBadge = '<span class="badge ' + gradeClass(r.context_grade) + '" style="font-size:10px;padding:3px 7px">' + (r.context_grade || '—') + '</span>';

  var flagPills = '';
  Object.values(FLAG_META).forEach(function(meta) {
    var fired = meta.key === 'concede_driven_over'
      ? (r.flags && (r.flags.concede_driven_over_home || r.flags.concede_driven_over_away))
      : (r.flags && r.flags[meta.key]);
    if (fired) {
      flagPills += '<span title="' + meta.tooltip + '" style="display:inline-block;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.05);border-radius:5px;padding:1px 5px;font-size:9px;color:#94a3b8;margin:1px">' + meta.abbr + '</span>';
    }
  });
  if (!flagPills) flagPills = '<span style="color:#2d3f57;font-size:10px">—</span>';

  var edgeStr = r.edge_pct != null
    ? '<span style="color:' + edgeColor(r.edge_pct) + ';font-size:12px">' + (r.edge_pct > 0 ? '+' : '') + r.edge_pct.toFixed(1) + '%</span>'
    : '<span style="color:#2d3f57">—</span>';

  var clvStr = r.clv_pct != null
    ? '<span style="color:' + clvColor(r.clv_pct) + ';font-size:12px">' + (r.clv_pct > 0 ? '+' : '') + r.clv_pct.toFixed(1) + '%</span>'
    : '<span style="color:#2d3f57">—</span>';

  var wonHtml = r.won === true  ? '<span style="color:#6ee7b7;font-weight:700">✓</span>'
              : r.won === false ? '<span style="color:#f87171;font-weight:700">✗</span>'
              : '<span style="color:#2d3f57">—</span>';

  var result = r.fullTimeHome != null ? r.fullTimeHome + '–' + r.fullTimeAway : '—';
  var odds   = r.marketOdds != null
    ? '<span style="color:#c4b5fd;font-size:12px">' + r.marketOdds.toFixed(2) + '</span>'
    : '<span style="color:#2d3f57">—</span>';

  // First column: GW number in standard mode, Season label in gameweek mode
  var firstCol = gwMode
    ? '<td style="color:#66758c;font-size:11px;white-space:nowrap">' + (r.season || '—') + '</td>'
    : '<td style="color:#66758c;font-size:11px">' + (r.gameweek || '—') + '</td>';

  return '<tr style="cursor:pointer" ' + onclickAttr + '>' +
    firstCol +
    '<td style="color:#66758c;font-size:11px;white-space:nowrap">' + (r.fixtureDate || '—') + '</td>' +
    '<td style="font-size:12px;white-space:nowrap">' + r.homeTeam + ' <span style="color:#3d4f6a">vs</span> ' + r.awayTeam + '</td>' +
    '<td>' + dirBadge + '</td>' +
    '<td>' + gradeBadge + '</td>' +
    '<td style="max-width:110px">' + flagPills + '</td>' +
    '<td style="text-align:right;color:#66758c;font-size:12px">' + (r.context_fair_odds ? r.context_fair_odds.toFixed(2) : '—') + '</td>' +
    '<td style="text-align:right">' + odds + '</td>' +
    '<td style="text-align:right">' + edgeStr + '</td>' +
    '<td style="text-align:right">' + clvStr + '</td>' +
    '<td style="text-align:center;color:#67e8f9;font-size:12px;font-weight:600">' + result + '</td>' +
    '<td style="text-align:center">' + wonHtml + '</td>' +
  '</tr>';
}

function ctxPageNav(dir) {
  var totalPages = Math.ceil(ctxState.filtered.length / ctxState.pageSize);
  ctxState.page  = Math.max(0, Math.min(totalPages - 1, ctxState.page + dir));
  renderCtxTable();
  // Scroll table into view
  var el = document.getElementById('ctxTableWrap');
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── Detail drawer ─────────────────────────────────────────────
function openCtxDrawer(row) {
  if (!row) return;
  ctxState.drawerRow = row;
  document.getElementById('ctxDrawerOverlay').style.display = 'block';
  var drawer = document.getElementById('ctxDrawer');
  drawer.style.display = 'block';
  requestAnimationFrame(function() { drawer.classList.add('open'); });
  document.getElementById('ctxDrawerBody').innerHTML = buildDrawerHTML(row);
}

function closeCtxDrawer() {
  var drawer = document.getElementById('ctxDrawer');
  drawer.classList.remove('open');
  setTimeout(function() {
    drawer.style.display = 'none';
    document.getElementById('ctxDrawerOverlay').style.display = 'none';
  }, 230);
}

document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') closeCtxDrawer();
});

function ctxCopyId(id) {
  navigator.clipboard && navigator.clipboard.writeText(id).catch(function() {});
}

function buildDrawerHTML(r) {
  var isO25    = r.context_direction === 'o25';
  var dirLabel = isO25 ? 'O2.5' : 'U2.5';
  var won = r.won === true  ? '<span style="color:#6ee7b7;font-weight:700">✓ Won ' + dirLabel + '</span>'
           : r.won === false ? '<span style="color:#f87171;font-weight:700">✗ Lost ' + dirLabel + '</span>'
           : '—';

  // Fired flags
  var firedFlags = Object.values(FLAG_META).filter(function(meta) {
    if (!r.flags) return false;
    if (meta.key === 'concede_driven_over') return r.flags.concede_driven_over_home || r.flags.concede_driven_over_away;
    return r.flags[meta.key];
  });

  var flagsHTML = firedFlags.length > 0
    ? firedFlags.map(function(meta) {
        var correct = (meta.role === 'attractor' && r.context_direction === 'o25') ||
                      (meta.role === 'suppressor' && r.context_direction === 'u25');
        var extra = '';
        if (meta.key === 'concede_driven_over') {
          var eff  = r.flags.concede_driven_over_effect;
          var side = r.flags.concede_driven_over_fixture;
          extra = ' · effect: ' + (eff >= 0 ? '+' : '') + eff + ' pts · side: ' + (side || '—');
        }
        return '<div style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,.04)">' +
          '<div style="font-size:12px;color:#e2e8f0;font-weight:500">' + (correct ? '✓' : '⚠') + ' ' + meta.label + extra + '</div>' +
          '<div style="font-size:11px;color:#66758c;margin-top:2px">' + meta.expected + ' · ' + meta.role + ' · ' + (correct ? 'firing correctly' : 'unexpected direction') + '</div>' +
        '</div>';
      }).join('')
    : '<div style="color:#66758c;font-size:12px">No flags fired</div>';

  // Rolling inputs
  var home = r.homeRolling || {};
  var away = r.awayRolling || {};
  var fields = [
    ['gf_avg', 'gf avg'],
    ['ga_avg', 'ga avg'],
    ['fts_count', 'FTS count'],
    ['scored2plus_count', 'scored 2+'],
    ['conceded2plus_count', 'conceded 2+'],
    ['o25_count', 'O2.5 count'],
    ['games_available', 'games avail'],
  ];
  var inputRows = fields.map(function(pair) {
    var field = pair[0], label = pair[1];
    var hv = home[field] != null ? home[field] : '—';
    var av = away[field] != null ? away[field] : '—';
    return '<tr>' +
      '<td style="color:#66758c;font-size:11px;padding:5px 0;width:50%">' + label + '</td>' +
      '<td style="text-align:right;font-size:12px;color:#e2e8f0;padding:5px 10px">' + hv + '</td>' +
      '<td style="text-align:right;font-size:12px;color:#e2e8f0;padding:5px 0">' + av + '</td>' +
    '</tr>';
  }).join('');

  var probO25 = r.context_o25_prob_raw != null ? Math.round(r.context_o25_prob_raw * 100) + '%' : '—';
  var probU25 = r.context_u25_prob_raw != null ? Math.round(r.context_u25_prob_raw * 100) + '%' : '—';
  var fair    = r.context_fair_odds    != null ? r.context_fair_odds.toFixed(2) : '—';
  var openO25 = r.marketOddsO25  != null ? r.marketOddsO25.toFixed(2)  : '—';
  var openU25 = r.marketOddsU25  != null ? r.marketOddsU25.toFixed(2)  : '—';
  var clsO25  = r.closingOddsO25 != null ? r.closingOddsO25.toFixed(2) : '—';
  var clsU25  = r.closingOddsU25 != null ? r.closingOddsU25.toFixed(2) : '—';
  var edgeStr = r.edge_pct != null ? (r.edge_pct > 0 ? '+' : '') + r.edge_pct.toFixed(2) + '%' : '—';
  var clvStr  = r.clv_pct  != null ? (r.clv_pct  > 0 ? '+' : '') + r.clv_pct.toFixed(2)  + '%' : '—';
  var pnlStr  = r.won === true  ? (r.marketOdds != null ? '+' + (r.marketOdds - 1).toFixed(2) + 'u' : '—')
              : r.won === false ? '-1.00u' : '—';

  function dRow(label, val, color) {
    return '<tr><td style="font-size:11px;color:#66758c;padding:5px 0">' + label + '</td>' +
           '<td style="text-align:right;font-size:12px;padding:5px 0' + (color ? ';color:' + color : '') + '">' + val + '</td></tr>';
  }

  return '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px">' +
    '<div>' +
      '<div style="font-size:16px;font-weight:700;color:#e2e8f0;line-height:1.3">' + r.homeTeam + ' vs ' + r.awayTeam + '</div>' +
      '<div style="font-size:11px;color:#66758c;margin-top:5px">' + (r.fixtureDate || '') + ' · GW ' + (r.gameweek || '—') + ' · ' + (r.league || 'England') + ' ' + (r.season || '') + '</div>' +
    '</div>' +
    '<button onclick="closeCtxDrawer()" style="background:none;border:none;color:#66758c;font-size:20px;cursor:pointer;padding:0;line-height:1;margin-left:12px;flex-shrink:0">✕</button>' +
  '</div>' +

  '<div style="font-size:9px;color:#2d3f57;font-family:\'JetBrains Mono\',monospace;margin-bottom:16px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
    r.fixtureId +
    '<button onclick="ctxCopyId(\'' + r.fixtureId + '\')" style="background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);color:#44576e;border-radius:6px;padding:2px 8px;font-size:9px;cursor:pointer;font-family:inherit">Copy</button>' +
  '</div>' +

  '<div class="ctx-drawer-section">' +
    '<div class="ctx-drawer-title">Prediction</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px 8px">' +
      '<div><div style="font-size:10px;color:#66758c;text-transform:uppercase;letter-spacing:.1em">Direction</div>' +
        '<div style="margin-top:4px">' + (isO25 ? '<span class="dir-badge dir-o25">O2.5</span>' : '<span class="dir-badge dir-u25">U2.5</span>') + '</div></div>' +
      '<div><div style="font-size:10px;color:#66758c;text-transform:uppercase;letter-spacing:.1em">Grade</div>' +
        '<div style="margin-top:4px"><span class="badge ' + gradeClass(r.context_grade) + '">' + (r.context_grade || '—') + '</span></div></div>' +
      '<div><div style="font-size:10px;color:#66758c;text-transform:uppercase;letter-spacing:.1em">O2.5 score</div>' +
        '<div style="margin-top:4px;color:#e2e8f0;font-size:13px;font-weight:600">' + (r.context_o25_score != null ? r.context_o25_score : '—') + '</div></div>' +
      '<div><div style="font-size:10px;color:#66758c;text-transform:uppercase;letter-spacing:.1em">U2.5 score</div>' +
        '<div style="margin-top:4px;color:#e2e8f0;font-size:13px;font-weight:600">' + (r.context_u25_score != null ? r.context_u25_score : '—') + '</div></div>' +
      '<div><div style="font-size:10px;color:#66758c;text-transform:uppercase;letter-spacing:.1em">P(O2.5)</div>' +
        '<div style="margin-top:4px;color:#e2e8f0;font-size:13px;font-weight:600">' + probO25 + '</div></div>' +
      '<div><div style="font-size:10px;color:#66758c;text-transform:uppercase;letter-spacing:.1em">P(U2.5)</div>' +
        '<div style="margin-top:4px;color:#e2e8f0;font-size:13px;font-weight:600">' + probU25 + '</div></div>' +
      '<div><div style="font-size:10px;color:#66758c;text-transform:uppercase;letter-spacing:.1em">Fair odds</div>' +
        '<div style="margin-top:4px;color:#e2e8f0;font-size:13px;font-weight:600">' + fair + '</div></div>' +
    '</div>' +
  '</div>' +

  '<div class="ctx-drawer-section">' +
    '<div class="ctx-drawer-title">Result</div>' +
    (r.totalGoals != null
      ? '<div style="font-size:22px;font-weight:700;color:#e2e8f0;margin-bottom:8px">' +
          r.fullTimeHome + ' – ' + r.fullTimeAway +
          ' <span style="font-size:13px;color:#66758c;font-weight:400">(' + r.totalGoals + ' goals)</span></div>' +
          '<div>' + won + '</div>'
      : '<div style="color:#66758c;font-size:13px">Result not yet available</div>') +
  '</div>' +

  '<div class="ctx-drawer-section">' +
    '<div class="ctx-drawer-title">Market</div>' +
    '<table style="width:100%;border-collapse:collapse">' +
      dRow('Opening O2.5 / U2.5', openO25 + ' / ' + openU25, '#c4b5fd') +
      dRow('Closing O2.5 / U2.5', clsO25  + ' / ' + clsU25,  '#94a3b8') +
      dRow('Edge',  edgeStr, edgeColor(r.edge_pct)) +
      dRow('CLV',   clvStr,  clvColor(r.clv_pct)) +
      dRow('P&L',   pnlStr,  r.won === true ? '#6ee7b7' : r.won === false ? '#f87171' : '#66758c') +
    '</table>' +
  '</div>' +

  '<div class="ctx-drawer-section">' +
    '<div class="ctx-drawer-title">Flags Fired</div>' +
    flagsHTML +
  '</div>' +

  '<div class="ctx-drawer-section">' +
    '<div class="ctx-drawer-title">Rolling Inputs (last 6 matches before kickoff)</div>' +
    '<table style="width:100%;border-collapse:collapse">' +
      '<thead><tr>' +
        '<th style="text-align:left;font-size:10px;color:#66758c;padding:4px 0;font-weight:500;text-transform:uppercase;letter-spacing:.1em"></th>' +
        '<th style="text-align:right;font-size:10px;color:#66758c;padding:4px 10px;font-weight:500">' + (r.homeTeam || 'Home') + '</th>' +
        '<th style="text-align:right;font-size:10px;color:#66758c;padding:4px 0;font-weight:500">' + (r.awayTeam || 'Away') + '</th>' +
      '</tr></thead>' +
      '<tbody>' + inputRows + '</tbody>' +
    '</table>' +
  '</div>';
}

// ─── Context Performance section ──────────────────────────────────────────────

function toggleCtxPerfSection() {
  var body = document.getElementById('ctxPerfBody');
  var chevron = document.getElementById('ctxPerfChevron');
  if (!body) return;
  var open = body.style.display !== 'none';
  body.style.display = open ? 'none' : 'block';
  if (chevron) chevron.style.transform = open ? 'rotate(-90deg)' : 'rotate(0deg)';
}

function switchCtxPerfMarketTab(market) {
  activeCtxMkt = market;
  var o25Btn = document.getElementById('ctxPerfTabO25');
  var u25Btn = document.getElementById('ctxPerfTabU25');
  if (o25Btn) o25Btn.className = 'market-tab' + (market === 'over_2.5' ? ' active' : '');
  if (u25Btn) u25Btn.className = 'market-tab' + (market === 'under_2.5' ? ' active-u25' : '');
  if (statsData) {
    var ctx = statsData.methods && statsData.methods['context_raw'];
    if (ctx) renderCtxPerfSection(ctx);
  }
}

function renderCtxPerfSection(statsData) {
  if (!statsData || !statsData.methods || !statsData.methods.context_raw) return;
  var ctx = statsData.methods.context_raw;
  if (!ctx) return;

  // ── Hero cards ──────────────────────────────────────────────
  var summary = ctx.summary || {};
  var clv = summary.meanCLV;
  var ctxClvCol = clv == null ? '#66758c' : clv > 1 ? '#6ee7b7' : clv >= 0 ? '#bef264' : '#fbbf24';
  var hitColor = summary.hitRate == null ? '#66758c' : summary.hitRate >= 57 ? '#6ee7b7' : summary.hitRate >= 52 ? '#fbbf24' : '#f87171';

  var cards = [
    { label: 'Context Settled', val: summary.settled != null ? summary.settled : '—', sub: (summary.pending || 0) + ' pending' },
    { label: 'Hit Rate', val: summary.hitRate != null ? summary.hitRate + '%' : '—', sub: (summary.won || 0) + ' / ' + (summary.settled || 0), color: hitColor },
    { label: 'Mean CLV', val: clv != null ? (clv >= 0 ? '+' : '') + clv + '%' : '—',
      sub: 'primary metric', color: ctxClvCol,
      tip: 'CLV = how much tip-time odds beat closing line. Positive = finding value before market moves.' },
    { label: 'O2.5', val: (function() {
        var o = ctx.markets && ctx.markets['over_2.5'];
        return o && o.hitRate != null ? o.hitRate + '%' : '—';
      })(), sub: (function() {
        var o = ctx.markets && ctx.markets['over_2.5'];
        return o ? (o.won || 0) + ' / ' + (o.settled || 0) : '—';
      })() },
  ];

  // Render to the shared summary strip (perfSummaryCards) so the top
  // of the page looks consistent with Current/Calibrated.
  document.getElementById('perfSummaryCards').innerHTML = cards.map(function(c) {
    return '<div class="perf-hero-cell">' +
      '<div class="ph-label">' + c.label + (c.tip ? ' <span class="ctx-tip" title="' + c.tip + '" style="cursor:help;font-size:10px">ⓘ</span>' : '') + '</div>' +
      '<div class="ph-val" style="' + (c.color ? 'color:' + c.color : '') + '">' + c.val + '</div>' +
      '<div class="ph-sub">' + c.sub + '</div>' +
    '</div>';
  }).join('');

  // ── Agreement breakdown ─────────────────────────────────────
  var agr = ctx.byAgreement || {};
  var agrTypes = [
    { key: 'context_confirms',  label: 'Confirms',  desc: 'Same fixture + direction as Current or Calibrated', color: '#6ee7b7' },
    { key: 'context_disagrees', label: 'Disagrees', desc: 'Same fixture, opposite direction to Current/Calibrated', color: '#fbbf24' },
    { key: 'context_only',      label: 'Context only', desc: 'No Current/Calibrated for this fixture', color: '#818cf8' },
  ];
  document.getElementById('ctxPerfAgreement').innerHTML = agrTypes.map(function(t) {
    var d = agr[t.key] || {};
    var hr = d.hitRate != null ? d.hitRate + '%' : '—';
    var clv = d.meanCLV != null ? (d.meanCLV >= 0 ? '+' : '') + d.meanCLV + '%' : '—';
    var ctxClvCol = d.meanCLV == null ? '#66758c' : d.meanCLV > 1 ? '#6ee7b7' : d.meanCLV >= 0 ? '#bef264' : '#f87171';
    return '<div style="display:flex;align-items:center;gap:16px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.05)">' +
      '<div style="width:10px;height:10px;border-radius:50%;background:' + t.color + ';flex-shrink:0"></div>' +
      '<div style="flex:1">' +
        '<div style="font-size:13px;font-weight:600;color:#e2e8f0">' + t.label + '</div>' +
        '<div style="font-size:11px;color:#66758c;margin-top:2px">' + t.desc + '</div>' +
      '</div>' +
      '<div style="text-align:right;min-width:80px">' +
        '<div style="font-size:12px;color:#94a3b8">' + (d.settled || 0) + ' settled · ' + hr + '</div>' +
        '<div style="font-size:11px;color:' + ctxClvCol + '">CLV ' + clv + '</div>' +
      '</div>' +
    '</div>';
  }).join('');

  // ── By league ───────────────────────────────────────────────
  var byLeague = ctx.byLeague || {};
  var LEAGUE_NAMES = { england: 'England (EPL)', germany: 'Germany (BL1)' };
  document.getElementById('ctxPerfByLeague').innerHTML = Object.entries(byLeague).map(function(entry) {
    var slug = entry[0], d = entry[1];
    var hr = d.hitRate != null ? d.hitRate + '%' : '—';
    var clv = d.meanCLV != null ? (d.meanCLV >= 0 ? '+' : '') + d.meanCLV + '%' : '—';
    var ctxClvCol = d.meanCLV == null ? '#66758c' : d.meanCLV > 1 ? '#6ee7b7' : d.meanCLV >= 0 ? '#bef264' : '#f87171';
    return '<div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid rgba(255,255,255,.05)">' +
      '<div style="font-size:13px;color:#e2e8f0">' + (LEAGUE_NAMES[slug] || slug) + '</div>' +
      '<div style="text-align:right">' +
        '<div style="font-size:12px;color:#94a3b8">' + (d.settled || 0) + ' · ' + hr + '</div>' +
        '<div style="font-size:11px;color:' + ctxClvCol + '">CLV ' + clv + '</div>' +
      '</div>' +
    '</div>';
  }).join('') || '<div style="color:#66758c;font-size:12px">No data yet</div>';

  // ── By grade ────────────────────────────────────────────────
  var byGrade = ctx.byGrade || {};
  document.getElementById('ctxPerfByGrade').innerHTML = ['A+', 'A', 'B'].map(function(g) {
    var d = byGrade[g] || {};
    var hr = d.hitRate != null ? d.hitRate + '%' : '—';
    var clv = d.meanCLV != null ? (d.meanCLV >= 0 ? '+' : '') + d.meanCLV + '%' : '—';
    var ctxClvCol = d.meanCLV == null ? '#66758c' : d.meanCLV > 1 ? '#6ee7b7' : d.meanCLV >= 0 ? '#bef264' : '#f87171';
    return '<div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid rgba(255,255,255,.05)">' +
      '<div><span class="badge ' + gradeClass(g) + '" style="font-size:11px;padding:3px 9px">' + g + '</span></div>' +
      '<div style="text-align:right">' +
        '<div style="font-size:12px;color:#94a3b8">' + (d.settled || 0) + ' · ' + hr + '</div>' +
        '<div style="font-size:11px;color:' + ctxClvCol + '">CLV ' + clv + '</div>' +
      '</div>' +
    '</div>';
  }).join('');

  // ── Market panels ───────────────────────────────────────────
  var markets = ctx.markets || {};
  function ctxMktPanel(label, m, isUnvalidated) {
    var hitCls = m.hitRate >= 55 ? 'green' : m.hitRate >= 45 ? 'amber' : 'red';
    var hitColor = m.hitRate >= 55 ? '#6ee7b7' : m.hitRate >= 45 ? '#fbbf24' : '#f87171';
    return '<div class="pmc-head">' +
        '<div class="pmc-title">' + label + ' <em>' + (m.total || 0) + ' predictions</em>' +
          (isUnvalidated ? ' <span style="font-size:10px;color:#fbbf24;font-weight:600">UNVALIDATED</span>' : '') +
        '</div>' +
        '<div class="pmc-pending">' + (m.pending || 0) + ' pending</div>' +
      '</div>' +
      '<div class="pmc-body">' +
        '<div class="pmc-stat">' +
          '<div class="pmc-stat-lbl">Hit Rate</div>' +
          '<div class="pmc-stat-val ' + (m.hitRate != null ? hitCls : '') + '">' + (m.hitRate != null ? m.hitRate + '%' : '—') + '</div>' +
          '<div class="hit-bar"><div class="hit-fill" style="width:' + (m.hitRate || 0) + '%;background:' + hitColor + '"></div></div>' +
          '<div class="pmc-stat-sub">' + (m.won || 0) + ' of ' + (m.settled || 0) + ' settled</div>' +
        '</div>' +
        '<div class="pmc-rows">' +
          '<div class="pmc-row"><div class="pmc-row-lbl">Mean CLV</div><div class="pmc-row-val ' + (m.meanCLV > 0 ? 'g' : '') + '">' + (m.meanCLV != null ? (m.meanCLV > 0 ? '+' : '') + m.meanCLV + '%' : '—') + '</div></div>' +
          '<div class="pmc-row"><div class="pmc-row-lbl">Mean edge</div><div class="pmc-row-val">' + (m.meanEdge != null ? (m.meanEdge > 0 ? '+' : '') + m.meanEdge + '%' : '—') + '</div></div>' +
          '<div class="pmc-row"><div class="pmc-row-lbl">Brier score</div><div class="pmc-row-val ' + (m.brierScore != null ? (m.brierScore < 0.22 ? 'g' : m.brierScore < 0.26 ? '' : 'r') : '') + '">' + (m.brierScore != null ? m.brierScore : '—') + '</div></div>' +
          '<div class="pmc-row"><div class="pmc-row-lbl">ROI</div><div class="pmc-row-val ' + ((m.roi || 0) >= 0 ? 'g' : 'r') + '">' + (m.roi != null ? (m.roi > 0 ? '+' : '') + m.roi + '%' : '—') + '</div></div>' +
        '</div>' +
      '</div>' +
      (isUnvalidated ? '<div class="pmc-warn">⚠ U2.5 signal not validated — see Stage 8 report. Track CLV only at this stage.</div>' : '') +
      ((m.settled || 0) < 20 ? '<div class="pmc-warn">⚠ Only ' + (m.settled || 0) + ' settled. Sample too small — CLV trend over hit rate.</div>' : '');
  }

  var mktGrid = document.getElementById('ctxPerfMarkets');
  if (mktGrid) {
    mktGrid.innerHTML =
      '<div class="perf-mkt-card">' + ctxMktPanel('Over 2.5 Goals',  markets['over_2.5']  || {}, false) + '</div>' +
      '<div class="perf-mkt-card">' + ctxMktPanel('Under 2.5 Goals', markets['under_2.5'] || {}, true)  + '</div>';
  }

  // ── Settled table ─────────────────────────────────────────────
  var allRows = activeCtxMkt === 'over_2.5'
    ? (ctx.recentSettledO25 || (ctx.recentSettled || []).filter(function(p){ return p.market === 'over_2.5'; }))
    : (ctx.recentSettledU25 || (ctx.recentSettled || []).filter(function(p){ return p.market === 'under_2.5'; }));
  var rows = allRows;
  var tbody = document.getElementById('ctxPerfTableBody');
  if (!tbody) return;

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="12" style="text-align:center;padding:2rem;color:#8b9ab0;font-size:13px">No settled context ' + (activeCtxMkt === 'over_2.5' ? 'Over 2.5' : 'Under 2.5') + ' predictions yet.</td></tr>';
    return;
  }

  var AGR_LABELS = { context_confirms: 'Confirms', context_disagrees: 'Disagrees', context_only: 'Only' };
  var AGR_COLORS = { context_confirms: '#6ee7b7', context_disagrees: '#fbbf24', context_only: '#818cf8' };

  tbody.innerHTML = rows.map(function(p) {
    var grade = p.context_grade || '—';
    var dir = p.direction || (p.market === 'under_2.5' ? 'u25' : 'o25');
    var isU25 = dir === 'u25';
    var edgeStr = p.edge != null ? '<span style="color:' + edgeColor(p.edge) + '">' + (p.edge > 0 ? '+' : '') + p.edge.toFixed(1) + '%</span>' : '—';
    var clvStr  = p.clvPct != null ? '<span style="color:' + clvColor(p.clvPct) + '">' + (p.clvPct > 0 ? '+' : '') + p.clvPct.toFixed(1) + '%</span>' : '—';
    var agrLabel = AGR_LABELS[p.selectionType] || '—';
    var agrCol   = AGR_COLORS[p.selectionType] || '#66758c';
    var resultBadge = p.status === 'settled_won'
      ? '<span style="color:#6ee7b7;font-weight:700">✓ Won</span>'
      : p.status === 'settled_lost'
        ? '<span style="color:#f87171;font-weight:700">✗ Lost</span>'
        : '—';

    return '<tr>' +
      '<td style="color:#66758c;font-size:11px">' + (p.predictionDate || '—') + '</td>' +
      '<td>' + (p.homeTeam || '') + ' vs ' + (p.awayTeam || '') + '</td>' +
      '<td><span class="badge ' + gradeClass(grade) + '" style="font-size:10px;padding:3px 7px">' + grade + '</span></td>' +
      '<td><span class="dir-badge ' + (isU25 ? 'dir-u25' : 'dir-o25') + '" style="font-size:10px;padding:3px 7px">' + (isU25 ? 'U2.5' : 'O2.5') + '</span>' + (isU25 ? ' <span style="font-size:9px;color:#fbbf24" title="U2.5 unvalidated">⚠</span>' : '') + '</td>' +
      '<td><span style="font-size:11px;color:' + agrCol + ';font-weight:600">' + agrLabel + '</span></td>' +
      '<td style="text-align:right;font-weight:700">' + fmtProbPct(p.modelProbability) + '</td>' +
      '<td style="text-align:right;color:#c4b5fd">' + fmtVal(p.marketOdds) + '</td>' +
      '<td style="text-align:right">' + edgeStr + '</td>' +
      '<td style="text-align:right;color:#66758c">' + fmtVal(p.closingOdds) + '</td>' +
      '<td style="text-align:right">' + clvStr + '</td>' +
      '<td style="text-align:center;color:#67e8f9;font-weight:700">' + (p.result || '—') + '</td>' +
      '<td style="text-align:center">' + resultBadge + '</td>' +
    '</tr>';
  }).join('');
}
