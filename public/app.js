// AC EVO Paddock - browser app (no build step)
import { $, esc, api, post, fmt, fmtGap, prettyName, SESSION_TYPES } from './util.js';
import { mountReplay } from './replay.js';
import { viewConsistency } from './consistency.js';
import { viewTracks, viewTrack } from './tracks.js';
import { viewRace } from './race.js';
import { viewProgress } from './progress.js';
import { viewMods } from './mods.js';
import { viewSetups } from './setups.js';
import { viewReport, lapsBlock, bindLaps } from './reports.js';
import { mountTelemetry, getCompare, forgetCompare } from './telemetry.js';
import { initSpotter, spotterAudioState, loadVoice } from './spotter.js';

const view = $('#view');

// ------------------------------------------------------------------ live status + events
let status = { hasKey: false };
const statusEl = $('#status');
// ?noevents disables the live stream (used for headless screenshots)
const events = location.search.includes('noevents') ? new EventTarget() : new EventSource('/api/events');
initSpotter(events); // audio brake cues play from this page
// brake points marked in the game: the track page listens for these
events.addEventListener('brakemarks', (e) => window.dispatchEvent(new CustomEvent('paddock:brakemarks', { detail: JSON.parse(e.data) })));
events.addEventListener('status', (e) => {
  const { state, live } = JSON.parse(e.data);
  const recording = state.status === 'live' && live;
  statusEl.className = `status ${recording ? 'live' : state.connected ? 'idle' : ''}`;
  statusEl.querySelector('.txt').textContent = recording
    ? `Recording ${prettyName(live.car)} at ${prettyName(live.track)}, ${fmt(live.lapTimeMs)}`
    : STATUS_TEXT[state.status] || `AC EVO: ${state.status}`;
  statusEl.title = recording ? 'Every lap you finish is saved' : '';
});
// the recorder's state in plain words
const STATUS_TEXT = {
  offline: "AC EVO isn't running", 'waiting for game': "AC EVO isn't running", 'game not running': "AC EVO isn't running",
  menu: 'AC EVO is in the menus', off: 'AC EVO is in the menus', pause: 'Paused', replay: 'Watching a replay',
  live: 'On track', unknown: 'AC EVO is running',
};
events.addEventListener('lap', () => { if (currentRoute === 'laps') clearTimeout(reloadT), (reloadT = setTimeout(render, 500)); });
// a session report was just made: a dot on the Sessions tab until it is opened (the desktop app also notifies)
events.addEventListener('report', () => {
  if (currentRoute === 'laps') { render(); return; }
  const a = document.querySelector('nav a[data-nav=laps]');
  if (a && !a.querySelector('.nav-dot')) a.insertAdjacentHTML('beforeend', '<span class="nav-dot" title="New session report"></span>');
});
let reloadT;

// ------------------------------------------------------------------ restart the app (Settings), e.g. to load code changes
async function restartPaddock(btn) {
  if (statusEl.classList.contains('live') && !confirm('A lap is being recorded.\n\nRestart anyway? The lap in progress is lost.')) return;
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = 'Restarting…';
  try { await post('/api/dev/restart', {}); } catch { /* already going down */ }
  // wait until the server has gone and is back, then load the new page code
  const t0 = Date.now();
  let wentDown = false;
  const poll = async () => {
    try {
      await fetch('/api/status', { cache: 'no-store' }).then((r) => { if (!r.ok) throw new Error(); });
      if (wentDown || Date.now() - t0 > 4000) return location.reload();
    } catch { wentDown = true; }
    if (Date.now() - t0 > 60000) { btn.disabled = false; btn.textContent = label; alert('Paddock did not come back within a minute. Check its console or log.'); return; }
    setTimeout(poll, 400);
  };
  setTimeout(poll, 600);
}

api('/api/status').then((s) => { status = s.settings; });

// a dot on the Mods tab while the Paddock HUD is missing or older than this Paddock's copy
async function hudBadge() {
  let h; try { h = await api('/api/mods/hud'); } catch { return; }
  const a = document.querySelector('nav a[data-nav=mods]'); if (!a) return;
  a.querySelector('.nav-dot')?.remove();
  if ((h.state === 'missing' && !h.removed) || h.state === 'outdated') a.insertAdjacentHTML('beforeend', `<span class="nav-dot" title="${h.state === 'missing' ? 'Paddock HUD not installed' : `Paddock HUD update: ${h.installed} → ${h.bundled}`}"></span>`);
}
hudBadge();
setInterval(hudBadge, 60000);
window.addEventListener('paddock:hud', hudBadge);

// ------------------------------------------------------------------ router
let currentRoute = '';
let cleanup = [];
async function render() {
  cleanup.forEach((f) => f()); cleanup = [];
  const [path, query] = (location.hash.slice(1) || '/').split('?');
  const params = new URLSearchParams(query || '');
  const prevRoute = currentRoute;
  currentRoute = { '/compare': 'compare', '/settings': 'settings', '/consistency': 'consistency', '/progress': 'progress', '/game': 'game', '/mods': 'mods', '/race': 'race', '/setups': 'setups', '/tracks': 'tracks', '/track': 'track', '/report': 'report' }[path] || 'laps';
  if (currentRoute === 'laps' && prevRoute !== 'laps') lapView = { ...LAP_VIEW_DEFAULT };
  const navKey = currentRoute === 'track' ? 'tracks' : ['settings', 'game', 'mods', 'race', 'setups', 'tracks'].includes(currentRoute) ? currentRoute : 'laps';
  if (navKey === 'laps') document.querySelector('nav a[data-nav=laps] .nav-dot')?.remove();
  document.querySelectorAll('nav a[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === navKey));
  try {
    if (currentRoute === 'game') await viewGame();
    else if (currentRoute === 'mods') await viewMods(view, cleanup);
    else if (currentRoute === 'race') await viewRace(view, cleanup);
    else if (currentRoute === 'setups') await viewSetups(view, params, cleanup);
    else if (currentRoute === 'tracks') await viewTracks(view);
    else if (currentRoute === 'track') await viewTrack(view, params, cleanup);
    else if (currentRoute === 'compare') await viewCompare(params);
    else if (currentRoute === 'consistency') await viewConsistency(view, params, cleanup);
    else if (currentRoute === 'progress') await viewProgress(view, params, cleanup);
    else if (currentRoute === 'settings') await viewSettings();
    else if (currentRoute === 'report') await viewReport(view, params, cleanup);
    else await viewLaps(params);
  } catch (e) {
    view.innerHTML = `<div class="card error">Error: ${esc(e.message)}</div>`;
  }
}
window.addEventListener('hashchange', render);
queueMicrotask(render); // after all module-level declarations are initialised

// ================================================================== SESSIONS
// The Sessions page lists sessions, by track & car (one card per combo) or by date. A row is the session's summary;
// opening it shows the session page (public/reports.js): its report and its laps.
const LAP_VIEW_DEFAULT = { track: '', car: '', order: 'recent' };
let lapView = { ...LAP_VIEW_DEFAULT }; // filters/order; kept across auto-refreshes, reset when leaving the page
const MIN_REPORT_LAPS = 3; // = MIN_LAPS in src/report.js
const CLEAN_WITHIN = 1.07; // same "clean lap" rule as the report and the Progress page
let sessBy = 'combo';
try { if (localStorage.getItem('sessions.by') === 'date') sessBy = 'date'; } catch { /* none */ }
const sessDay = (t) => new Date(t).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const sessTime = (t) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const comboOf = (l) => `${l.track}|${l.layout}|${l.car}`;
async function removeLaps(ids, what) {
  if (!ids.length) return;
  if (!confirm(`Delete ${ids.length} ${what} permanently?\n\nThis cannot be undone.`)) return;
  await post('/api/laps/delete', { ids });
  render();
}

// per session: best, clean average, spread, consistency score, setups; against the previous session and the PB before
function sessionSummaries(o, sessions) {
  const out = new Map();
  for (const l of o.laps) if (l.source !== 'import') {
    if (!out.has(l.session_id)) out.set(l.session_id, { sid: l.session_id, key: comboOf(l), laps: [] });
    out.get(l.session_id).laps.push(l);
  }
  const byCombo = new Map();
  for (const m of out.values()) {
    m.laps.sort((a, b) => a.recorded_at - b.recorded_at);
    m.s = sessions.get(m.sid);
    m.start = m.s?.started_at ?? m.laps[0].recorded_at;
    const valid = m.laps.filter((l) => l.valid);
    m.valid = valid.length;
    m.best = valid.reduce((a, b) => (!a || b.lap_time_ms < a.lap_time_ms ? b : a), null);
    const clean = m.best ? valid.map((l) => l.lap_time_ms).filter((t) => t <= m.best.lap_time_ms * CLEAN_WITHIN) : [];
    m.avg = clean.length ? clean.reduce((a, b) => a + b, 0) / clean.length : null;
    m.sd = clean.length >= 3 ? Math.sqrt(clean.reduce((a, t) => a + (t - m.avg) ** 2, 0) / clean.length) : null;
    m.score = m.sd != null ? Math.max(0, Math.min(100, Math.round(100 - (4000 * m.sd) / m.avg))) : null;
    m.setups = [...new Set(m.laps.map((l) => l.setup_name).filter(Boolean))];
    m.full = m.laps.length >= MIN_REPORT_LAPS && m.valid > 0; // gets a report
    m.weakest = o.reports?.[m.sid]?.weakest ?? null;
    if (!byCombo.has(m.key)) byCombo.set(m.key, []);
    byCombo.get(m.key).push(m);
  }
  const comboLaps = new Map();
  for (const l of o.laps) if (l.valid) { if (!comboLaps.has(comboOf(l))) comboLaps.set(comboOf(l), []); comboLaps.get(comboOf(l)).push(l); }
  for (const [key, list] of byCombo) {
    list.sort((a, b) => a.start - b.start);
    let prev = null;
    for (const m of list) {
      if (!m.best) continue;
      if (prev) m.lastDelta = m.best.lap_time_ms - prev.best.lap_time_ms;
      prev = m;
      const first = m.laps[0].recorded_at;
      const before = (comboLaps.get(key) || []).filter((l) => l.recorded_at < first && l.session_id !== m.sid);
      if (before.length) {
        const pb = Math.min(...before.map((l) => l.lap_time_ms));
        m.newPb = m.best.lap_time_ms < pb; m.pbDelta = m.best.lap_time_ms - pb;
      }
    }
  }
  return out;
}

// one session = one row; combo given: the track and car too (By date, where the day is the card title)
function sessionRow(m, combo) {
  const n = m.laps.length;
  const dCls = (d) => (d < 0 ? 'neg' : d > 0 ? 'pos' : '');
  const cell = (k, v, sub = '', cls = '') => `<div class="sr-cell ${cls}"><span class="k">${k}</span><span class="v">${v}</span>${sub ? `<span class="sub">${sub}</span>` : ''}</div>`;
  const change = m.newPb ? `<span class="badge best" title="Faster than every lap before this session">New PB ${fmtGap(m.pbDelta)}</span>`
    : m.lastDelta != null ? `<span class="${dCls(m.lastDelta)}" title="Best lap against the previous session's best">${fmtGap(m.lastDelta)} vs last</span>` : '';
  return `<a class="sess-row${combo ? ' with-combo' : ''}" href="#/report?session=${m.sid}" title="Open the session: report and laps">
    ${combo ? cell(esc(SESSION_TYPES[m.s?.session_type] || 'Session'), esc(sessTime(m.start)), '', 'when') // the day is the card's title
      : cell(esc(SESSION_TYPES[m.s?.session_type] || 'Session'), esc(sessDay(m.start)), esc(sessTime(m.start)), 'when')}
    ${combo ? cell(esc(prettyName(combo.car)), `${esc(prettyName(combo.track))} <span class="muted">${esc(prettyName(combo.layout))}</span>`, '', 'combo') : ''}
    ${cell('Best lap', m.best ? fmt(m.best.lap_time_ms) : '–', m.best ? change : 'no valid lap')}
    ${cell('Average', m.full && m.avg != null ? fmt(Math.round(m.avg)) : '–')}
    ${cell('Consistency', m.full && m.score != null ? `${m.score}` : '–', m.full && m.sd != null ? `±${(m.sd / 1000).toFixed(2)} s` : '')}
    ${cell('Laps', `${m.valid}<small class="muted"> / ${n}</small>`, m.valid < n ? `${n - m.valid} invalid` : '')}
    ${cell('Setup', m.setups.length ? m.setups.map(esc).join(', ') : '<span class="muted">–</span>', '', 'text')}
    ${cell('Weakest corners', m.full && m.weakest?.length ? m.weakest.map(esc).join(', ') : '<span class="muted">–</span>', '', 'text')}
    <span class="sr-go" aria-hidden="true">›</span>
  </a>`;
}

async function viewLaps(params) {
  const by = params.get('by');
  if (by === 'combo' || by === 'date') { sessBy = by; try { localStorage.setItem('sessions.by', by); } catch { /* ignore */ } }
  const head = `<div class="race-head"><div><h1>Sessions</h1></div><span class="spacer"></span>
    <div class="tabs"><a href="#/?by=combo" class="${sessBy === 'combo' ? 'on' : ''}">By track &amp; car</a><a href="#/?by=date" class="${sessBy === 'date' ? 'on' : ''}">By date</a></div></div>`;
  const o = await api('/api/overview');
  if (!o.combos.length) {
    view.innerHTML = `${head}<div class="card empty">
      <h2>No laps yet</h2>
      <p>Start Assetto Corsa EVO and drive. Laps are saved automatically when you cross the line.</p>
      <p class="muted">Want to try it first? Run <code>npm run seed</code> for demo laps, or start with <code>npm run mock</code>.</p>
      <p><label class="row" style="justify-content:center"><button id="imp">Import lap files…</button></label></p>
    </div>`;
    bindImport($('#imp'));
    return;
  }
  const sessions = new Map(o.sessions.map((s) => [s.id, s]));
  const summaries = sessionSummaries(o, sessions);
  const uniq = (k, list = o.combos) => [...new Set(list.map((c) => c[k]))].sort((a, b) => prettyName(a).localeCompare(prettyName(b)));
  // drop a filter whose value no longer exists (e.g. last lap of that car deleted, or a car never driven on the newly picked track)
  if (!uniq('track').includes(lapView.track)) lapView.track = '';
  // each list only offers what was driven with the other filter's choice
  const cars = uniq('car', o.combos.filter((c) => !lapView.track || c.track === lapView.track));
  if (!cars.includes(lapView.car)) lapView.car = '';
  const tracks = uniq('track', o.combos.filter((c) => !lapView.car || c.car === lapView.car));
  const byName = (k) => (a, b) => prettyName(a[k]).localeCompare(prettyName(b[k]));
  const orders = {
    recent: ['Most recent', (a, b) => b.lastAt - a.lastAt],
    track: ['Track A–Z', (a, b) => byName('track')(a, b) || byName('layout')(a, b) || byName('car')(a, b)],
    car: ['Car A–Z', (a, b) => byName('car')(a, b) || byName('track')(a, b) || byName('layout')(a, b)],
    best: ['Best lap', (a, b) => (a.bestMs ?? Infinity) - (b.bestMs ?? Infinity)],
  };
  const combos = o.combos
    .filter((c) => (!lapView.track || c.track === lapView.track) && (!lapView.car || c.car === lapView.car))
    .sort(orders[lapView.order]?.[1] || orders.recent[1]);
  const comboLaps = (c) => o.laps.filter((l) => comboOf(l) === c.key);
  const opts = (list, cur, all) => `<option value="">${all}</option>` + list.map((v) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(prettyName(v))}</option>`).join('');
  const none = '<div class="card empty"><p>Nothing matches this track and car. Choose “All tracks” or “All cars” to see the rest.</p></div>';

  let body;
  if (sessBy === 'date') {
    // one card per day, newest first
    const byKey = new Map(combos.map((c) => [c.key, c]));
    const list = [...summaries.values()].filter((m) => byKey.has(m.key)).sort((a, b) => b.start - a.start);
    const days = new Map();
    for (const m of list) { const d = sessDay(m.start); if (!days.has(d)) days.set(d, []); days.get(d).push(m); }
    body = list.length ? [...days.entries()].map(([d, ms]) => `<section class="card"><h2>${esc(d)}</h2>
      <div class="sess-list">${ms.map((m) => sessionRow(m, byKey.get(m.key))).join('')}</div></section>`).join('') : none;
  } else {
    body = combos.length ? combos.map((c) => comboCard(c, comboLaps(c), summaries)).join('') : none;
  }
  view.innerHTML = `${head}
    <div class="row" style="margin-bottom:16px">
      <select id="f-track" title="Filter by track">${opts(tracks, lapView.track, 'All tracks')}</select>
      <select id="f-car" title="Filter by car">${opts(cars, lapView.car, 'All cars')}</select>
      ${sessBy === 'combo' ? `<select id="f-order" title="Order by">${Object.entries(orders).map(([k, [label]]) => `<option value="${k}" ${k === lapView.order ? 'selected' : ''}>${label}</option>`).join('')}</select>` : ''}
      <span class="spacer"></span>
      <button id="imp">Import lap files…</button>
    </div>
    ${body}`;
  bindImport($('#imp'));
  [['#f-track', 'track'], ['#f-car', 'car'], ['#f-order', 'order']].forEach(([sel, k]) => {
    if ($(sel)) $(sel).onchange = (e) => { lapView[k] = e.target.value; render(); };
  });
  view.querySelectorAll('[data-combo]').forEach((card) => {
    const key = card.dataset.combo;
    const hot = card.querySelector('[data-hotlap]');
    if (hot) hot.onclick = () => { const c = o.combos.find((x) => x.key === key); if (c) startHotlap(c); };
    const rmc = card.querySelector('[data-rm-invalid]');
    if (rmc) rmc.onclick = () => {
      const ids = rmc.dataset.rmInvalid.split(',').map(Number);
      removeLaps(ids, `invalid lap${ids.length > 1 ? 's' : ''} of this car and track`);
    };
    const imp = card.querySelector('[data-imported]');
    if (imp) bindLaps(imp, o.laps.filter((l) => l.source === 'import' && comboOf(l) === key), () => render());
  });
}

// one click: this combo in Hotlap mode, clear weather, optimum grip; progress shows on the Race tab
async function startHotlap(c) {
  try {
    let g = null; try { g = await api('/api/race/status'); } catch { /* unknown: just try */ }
    let endSession = false;
    if (g?.inSession) {
      if (!confirm('A session is running in the game.\n\nEnd it and start a hotlap?')) return;
      endSession = true;
    }
    await post('/api/race/hotlap', { track: c.track, layout: c.layout, car: c.car, endSession });
    location.hash = '#/race';
  } catch (e) { alert(`Could not start the hotlap: ${e.message}`); }
}

// By track & car: one card per car and track with its sessions, newest first (imported laps have no session: listed below)
function comboCard(c, laps, summaries) {
  const ms = [...summaries.values()].filter((m) => m.key === c.key).sort((a, b) => b.start - a.start);
  const imported = laps.filter((l) => l.source === 'import').sort((a, b) => a.lap_time_ms - b.lap_time_ms);
  const invalidIds = laps.filter((l) => !l.valid).map((l) => l.id);
  const gapIdeal = c.bestMs && c.idealMs ? c.idealMs - c.bestMs : null;
  return `<section class="card" data-combo="${esc(c.key)}">
    <div class="combo-head">
      <div><div class="title">${esc(prettyName(c.track))} <span class="muted">${esc(prettyName(c.layout))}</span></div><div class="secondary">${esc(prettyName(c.car))}</div></div>
      <div class="stat"><span class="k">Best lap</span><span class="v best">${fmt(c.bestMs)}</span></div>
      <div class="stat"><span class="k">Ideal lap</span><span class="v">${fmt(c.idealMs)} <small class="secondary">${gapIdeal != null ? fmtGap(gapIdeal) : ''}</small></span></div>
      <div class="stat"><span class="k">Valid laps</span><span class="v">${c.validLaps}<small class="muted"> of ${c.laps}</small></span></div>
      <span class="spacer"></span>
      <button class="primary" data-hotlap title="Start AC EVO in Hotlap mode with this track and car: clear weather, optimum grip">Start hotlap</button>
    </div>
    <div class="row" style="margin-bottom:12px">
      ${c.validLaps >= 1 ? `<a href="#/progress?combo=${encodeURIComponent(c.key)}"><button>Progress</button></a>` : ''}
      ${c.validLaps >= 2 ? `<a href="#/consistency?combo=${encodeURIComponent(c.key)}"><button>Consistency</button></a>` : ''}
      ${c.bestLapId && c.idealMs ? `<a href="#/compare?laps=${c.bestLapId}&ref=ideal"><button>Best lap against ideal</button></a>` : ''}
      <span class="spacer"></span>
      ${invalidIds.length ? `<button class="danger-ghost" data-rm-invalid="${invalidIds.join(',')}" title="Delete the invalid laps of this car and track">Remove invalid laps (${invalidIds.length})</button>` : ''}
    </div>
    ${ms.length ? `<div class="sess-list">${ms.map((m) => sessionRow(m)).join('')}</div>` : ''}
    ${imported.length ? `<details class="imported" data-imported><summary><b>Imported laps</b> <span class="muted">${imported.length}</span></summary>
      ${lapsBlock(imported, { bestMs: c.bestMs, bestLapId: c.bestLapId, bestLabel: 'Best' })}</details>` : ''}
  </section>`;
}

function bindImport(btn) {
  btn.onclick = () => {
    const inp = Object.assign(document.createElement('input'), { type: 'file', multiple: true, accept: '.gz,.json' });
    inp.onchange = async () => {
      let ok = 0; const errs = [];
      for (const f of inp.files) {
        try { await api('/api/laps/import', { method: 'POST', body: await f.arrayBuffer(), headers: { 'content-type': 'application/octet-stream' } }); ok++; }
        catch (e) { errs.push(`${f.name}: ${e.message}`); }
      }
      alert(`Imported ${ok} lap(s).${errs.length ? '\n' + errs.join('\n') : ''}`);
      render();
    };
    inp.click();
  };
}

// ================================================================== COMPARE: laps against a reference (public/telemetry.js) and the racing line replay
events.addEventListener('lap', () => forgetCompare()); // a new lap can change the best and the ideal lap
async function viewCompare(params) {
  const lapIds = (params.get('laps') || '').split(',').map(Number).filter(Boolean);
  const ref = params.get('ref') || 'best';
  const tab = params.get('tab') === 'line' ? 'line' : 'charts';
  view.innerHTML = '<div class="card"><span class="spinner"></span> Loading telemetry…</div>';
  const data = await getCompare(lapIds, ref);
  const lap0 = data.laps[0]?.meta ?? data.ref.meta;
  const back = lap0?.session_id ? `#/report?session=${lap0.session_id}` : '#/';
  const url = (s, t = tab) => `#/compare?laps=${s.laps.join(',')}&ref=${s.ref}${s.corner ? `&c=${encodeURIComponent(s.corner)}` : ''}${t === 'line' ? '&tab=line' : ''}`;
  let st = { laps: lapIds, ref, corner: params.get('c') };
  view.innerHTML = `
    <div class="cmp-head">
      <a href="${back}"><button class="ghost">← ${lap0?.session_id ? 'Session' : 'Sessions'}</button></a>
      <div><h1>${esc(prettyName(data.combo.track))} <span class="muted">${esc(prettyName(data.combo.layout))}</span></h1>
        <div class="secondary">${esc(prettyName(data.combo.car))} · best lap ${fmt(data.bestMs)}, ideal lap ${fmt(data.idealMs)}</div></div>
    </div>
    <div class="tabs"><a href="#" data-tab="charts" class="${tab === 'charts' ? 'on' : ''}">Telemetry</a><a href="#" data-tab="line" class="${tab === 'line' ? 'on' : ''}">Racing line replay</a></div>
    <div id="tabBody"></div>`;
  view.querySelectorAll('[data-tab]').forEach((a) => a.onclick = (e) => { e.preventDefault(); location.hash = url(st, a.dataset.tab); });
  if (tab === 'line') {
    mountReplay($('#tabBody'), data, cleanup, { at: params.has('at') ? +params.get('at') : null,
      mode: params.get('mode'), inputs: params.has('inputs') ? params.get('inputs') === '1' : null });
    return;
  }
  await mountTelemetry($('#tabBody'), { ...st, hasKey: status.hasKey, onState: (s) => { st = s; history.replaceState(null, '', url(s)); } }, cleanup);
}

// ================================================================== GAME
async function viewGame() {
  view.innerHTML = `<div class="card"><div class="row"><h1 style="margin:0">AC EVO</h1><span class="spacer"></span>
      <button class="primary" id="gLaunch">Start AC EVO</button></div>
      <div id="gStatus" class="game-status muted" style="margin-top:12px">Checking the game…</div></div>
    <div class="card"><h2 style="margin-top:0">Drive</h2>
      <p class="muted">Set up a session (type, car, track, conditions, AI grid) or join a server in the <a href="#/race">Race</a> tab.</p>
      <div id="gLaunchState"></div></div>`;

  // the ACE UI App Loader's state in plain words (Paddock installs it by itself): [ok, text]
  const loaderLine = (l) => {
    if (!l) return [false, 'unknown'];
    const v = l.variant === 'alternate' ? `${l.bundled} (alternate build)` : l.bundled;
    if (l.gameMatch === false) return [false, `built for AC EVO ${l.builtFor}, but the game is ${l.game}: update Paddock${l.installed ? '' : ' (the loader is not installed)'}`];
    if (l.state === 'current') return [true, `installed, ${v}`];
    if (l.removed) return [false, `${l.installed ? 'not the one Paddock ships' : 'removed'} (disabled or deleted in the Mods tab, so Paddock leaves it alone)`];
    if (l.state === 'missing' || l.state === 'other') return [false, `${l.state === 'missing' ? 'missing' : 'a different version'}: Paddock installs ${l.bundled} as soon as AC EVO is closed`];
    if (l.state === 'no-game') return [false, 'AC EVO has not been started yet'];
    return [false, l.state];
  };
  const yesNo = (ok, yes, no) => `<span class="${ok ? 'g-ok' : 'g-bad'}">${ok ? yes : no}</span>`;

  async function refresh() {
    let g;
    try { g = await api('/api/game'); } catch (e) { $('#gStatus').textContent = e.message; return; }
    const t = g.telemetry, live = t.live;
    const hudLive = g.liveAgeMs != null && g.liveAgeMs < 2000;
    $('#gStatus').innerHTML = `<table class="kv"><tbody>
      <tr><td>Game</td><td>${yesNo(g.running, 'running', 'not running')}${g.version ? `, version ${esc(g.version)}` : ''}</td></tr>
      <tr><td>Telemetry</td><td>${t.status === 'live' && live ? `<span class="g-ok">live</span>: ${esc(prettyName(live.car))} at ${esc(prettyName(live.track))} ${esc(live.layout || '')}, lap time ${fmt(live.lapTimeMs)}`
        : esc(STATUS_TEXT[t.status] || t.status)}. ${t.savedLaps} lap${t.savedLaps === 1 ? '' : 's'} saved since Paddock started</td></tr>
      <tr><td>ACE UI App Loader</td><td>${(([ok, txt]) => yesNo(ok, esc(txt), esc(txt)))(loaderLine(g.loaderInfo))}</td></tr>
      <tr><td>Paddock HUD</td><td>${g.hudVersion ? `<span class="g-ok">installed</span>, ${esc(g.hudVersion)}` : '<span class="g-bad">not installed</span> (Paddock installs it as soon as AC EVO is closed; see the <a href="#/mods">Mods</a> tab)'}
        . Data feed ${yesNo(hudLive, 'updating', 'stopped')}</td></tr>
    </tbody></table>`;
    $('#gLaunch').textContent = g.running ? 'AC EVO is running' : 'Start AC EVO';
    $('#gLaunch').disabled = g.running;

    const L = g.launch;
    $('#gLaunchState').innerHTML = L.order || L.events.length ? `<div class="card" style="background:var(--surface-2)">
      ${L.order ? `<div class="row"><b>${L.order.kind === 'scan' ? 'Scanning' : 'Launching'}:</b>&nbsp;${esc(L.order.summary || '')}
        <span class="spacer"></span><button class="small ghost" id="gCancel">Cancel</button></div>` : ''}
      ${L.events.length ? `<ol class="muted" style="margin:6px 0 0 18px;padding:0">${L.events.map((e) =>
        `<li class="${e.step === 'error' ? 'g-bad' : e.step === 'started' || e.step === 'scandone' ? 'g-ok' : ''}">${esc(e.msg || e.step)}</li>`).join('')}</ol>` : '<div class="muted">Waiting for the game…</div>'}
    </div>` : '';
    if ($('#gCancel')) $('#gCancel').onclick = async () => { await post('/api/game/cancel', {}); refresh(); };
  }
  $('#gLaunch').onclick = async () => { try { const r = await post('/api/game/launch', {}); $('#gStatus').insertAdjacentHTML('afterbegin', `<p>${esc(r.msg)}</p>`); } catch (e) { alert(e.message); } };
  await refresh();
  const timer = setInterval(refresh, 2000);
  cleanup.push(() => clearInterval(timer));
}

// ================================================================== SETTINGS
// Paddock HUD parts, as the Settings page groups them (keys: src/settings.js HUD_PARTS)
const HUD_GROUPS = [
  ['Strip', [['lap', 'Lap number and lap status'], ['current', 'Current lap time'], ['predicted', 'Predicted lap'], ['best', 'All-time best'], ['session', 'Session best'], ['last', 'Last lap'],
    ['inputs', 'Pedals vs your reference lap, TC / ABS']]],
  ['Delta', [['delta', 'Live delta and bar'], ['ref', 'Reference name above it (click to switch)']]],
  ['Above and below the strip', [['shift', 'Shift lights'], ['sectors', 'Sector times (purple / green / yellow)']]],
  ['Chips under the strip', [['cues', 'Brake / throttle cues'], ['corners', 'Corner gain/loss and next corner'], ['ideal', 'Ideal lap and potential'], ['speed', 'Speed and gear'],
    ['fuel', 'Fuel: litres, use per lap, laps left'], ['footer', 'Status (saved laps, connection)']]],
];
// what the preview is drawn over, to judge the HUD against bright and dark scenes
const HUD_PREVIEW_BG = [['dark', 'Dark'], ['light', 'Light'], ['track', 'Track']];
async function viewSettings() {
  const s = await api('/api/settings');
  view.innerHTML = `<div class="card"><h1>Settings</h1><p class="muted">Stored locally in <code>data/settings.json</code>.</p>
    <div class="form">
      <label>Driver name</label><input id="driverName" value="${esc(s.driverName)}" placeholder="defaults to the name from the game">
      <label>Gemini API key</label><input id="geminiApiKey" value="${esc(s.geminiApiKey)}" placeholder="paste key" autocomplete="off">
      <div class="hint">Free key: <a href="https://aistudio.google.com/apikey" target="_blank">aistudio.google.com/apikey</a>. Only a compact per-corner summary is sent, never raw telemetry.</div>
      <label>Gemini model</label><div class="row"><select id="geminiModel" style="flex:1"><option>${esc(s.geminiModel)}</option></select><button id="loadModels">Load available models</button></div>
      <label>Coach language</label><input id="language" value="${esc(s.language)}" placeholder="English">
      <label>AC EVO folder</label><input id="gamePath" value="${esc(s.gamePath || '')}" placeholder="found automatically through Steam">
      <div class="hint">Track data (maps, edges, corners) is read from the game's content.kspkg in this folder, read-only.</div>
      <label>Game files folder</label><input id="aceDir" value="${esc(s.aceDir || '')}" placeholder="${esc(s.aceAuto || 'found automatically')}">
      <div class="hint" id="aceHint">Where AC EVO keeps your mods, setups and logs, and where the Paddock HUD is installed: the <code>ACE</code> folder inside your Saved Games folder.
        Leave it empty to use the folder Windows reports. Fill it in only if Paddock can't find it, for example <code>I:\\Games\\Parties enregistrées\\ACE</code>.
        ${s.aceExists ? `In use: <code>${esc(s.aceInUse)}</code>.` : `<span class="g-bad">Not found: <code>${esc(s.aceInUse)}</code>.</span> Start AC EVO once so it creates the folder, or enter where it is.`}</div>
      <span></span><div class="row"><button class="primary" id="save">Save</button><span id="saved" class="muted"></span></div>
    </div></div>
    <div class="card"><div class="row"><h2 style="margin:0">Paddock HUD</h2><span class="spacer"></span><span id="hudSaved" class="muted"></span><button class="small" id="hudReset">Reset to defaults</button></div>
      <p class="muted">Choose what the timing strip shows, in game and in the desktop overlay. Changes are saved and applied straight away, also while you drive.</p>
      <div class="hud-cfg">
        <div class="hud-parts">
          ${HUD_GROUPS.map(([title, parts]) => `<fieldset><legend>${title}</legend>${parts.map(([k, label]) =>
            `<label class="row"><input type="checkbox" data-part="${k}" ${s.hud.parts[k] ? 'checked' : ''}> ${label}</label>`).join('')}</fieldset>`).join('')}
          <fieldset><legend>Look</legend>
            <label class="hud-slider">Size <input type="range" id="hudScale" min="60" max="160" step="5" value="${s.hud.scale}"><b id="hudScaleV">${s.hud.scale}%</b></label>
            <label class="hud-slider">Background <input type="range" id="hudOpacity" min="0" max="100" step="5" value="${s.hud.opacity}"><b id="hudOpacityV">${s.hud.opacity}%</b></label>
          </fieldset>
          <div class="hint" style="margin:0">In game you can choose the same things: right-click the strip, or open Paddock HUD's options in the loader's app drawer (right edge of the screen). Both places stay in sync.</div>
        </div>
        <div class="hud-preview"><div class="row hud-preview-head"><span class="muted small-caps">Preview (sample numbers)</span><span class="spacer"></span>
          <span class="seg" id="hudBg">${HUD_PREVIEW_BG.map(([k, label]) => `<button class="small" data-bg="${k}">${label}</button>`).join('')}</span></div>
          <iframe id="hudFrame" title="Paddock HUD preview"></iframe></div>
      </div>
      <h3>Installing and showing it</h3>
      <ol class="muted" style="margin:0 0 8px 18px;padding:0">
        <li>Nothing to install: Paddock puts the HUD, and the community <a href="https://github.com/dreasgrech/ACEUIAppLoader" target="_blank">ACE UI App Loader</a> it runs in, into the game by itself whenever AC EVO is closed. It is switched on by default. The <a href="#/game">Game</a> tab shows their state.</li>
        <li>To hide it in game, move the mouse to the right edge of the screen and switch “Paddock HUD” off in the loader's app drawer.</li>
        <li>If the in-game panel says “Paddock offline”, use the desktop overlay instead: <code>npm run overlay</code> (borderless/windowed mode).</li>
      </ol>
      <div class="row"><a href="/hud.html" target="_blank"><button>Open HUD in browser</button></a></div></div>
    <div class="card"><div class="row"><h2 style="margin:0">Brake spotter</h2><span class="spacer"></span><span id="spSaved" class="muted"></span><button class="small" id="spTest">Test</button></div>
      <p class="muted">A voice or beeps count down to each braking point while you drive: “three, two, one, brake”, or “lift” where you only lifted.
        It counts down to your best lap's braking points (the HUD's reference lap), or to your own brake points, so you can keep your eyes on the road.</p>
      <div class="form">
        <label>Spotter</label><label class="row"><input type="checkbox" id="spOn" ${s.spotter.on ? 'checked' : ''}> On</label>
        <label>Sound</label><select id="spSound"><option value="orus">Voice: Orus (team radio)</option><option value="algenib">Voice: Algenib (team radio)</option><option value="beep">Beeps</option></select>
        <label>Count down to</label><select id="spPoints"><option value="best">My best lap's braking points</option><option value="mine">My brake points (only those)</option></select>
        <span></span><div class="hint" style="margin:0">Your own brake points are kept per track and car. Make and edit them on each track's page in <a href="#/tracks">Tracks</a>, or mark them while driving with the button below.</div>
        <label>Mark button</label><div class="row"><span id="mbName" class="muted"></span><button class="small" id="mbBind">Set button</button><button class="small ghost" id="mbClear">Remove</button></div>
        <label>Keyboard shortcut</label><div class="row"><input id="markKey" style="width:180px" placeholder="click, then press keys" value="${esc(s.markKey || '')}" autocomplete="off"><button class="small ghost" id="mkClear">Remove</button><span id="mkState" class="muted"></span></div>
        <span></span><div class="hint" style="margin:0">The button or shortcut marks a brake point while “Mark with button” is on (on the track's page). A wheel or button-box button works in game and in VR; the keyboard shortcut works in the desktop app, and the game no longer gets that key.</div>
        <label>Countdown</label><select id="spCountdown"><option value="full">Three, two, one, brake</option><option value="brake">Only “brake”</option></select>
        <label>Corners</label><select id="spCorners"><option value="all">Every braking and lifting point</option><option value="big">Big stops only</option></select>
        <label>Volume</label><label class="hud-slider"><input type="range" id="spVolume" min="0" max="100" step="5" value="${s.spotter.volume}"><b id="spVolumeV">${s.spotter.volume}%</b></label>
        <label>Timing</label><label class="hud-slider"><input type="range" id="spOffset" min="-500" max="500" step="25" value="${s.spotter.offsetMs}"><b id="spOffsetV"></b></label>
        <span></span><div class="hint" style="margin:0">If “brake” comes too late for you, move Timing to the right so it comes earlier.</div>
      </div>
      <div class="hint" id="spState" style="margin:8px 0 0"></div></div>
    <div class="card"><div class="row"><h2 style="margin:0">Restart Paddock</h2><span class="spacer"></span><button id="restart">Restart Paddock</button></div>
      <p class="muted" style="margin-bottom:0">Closes and reopens Paddock, for example after changing its files. The page reloads by itself when Paddock is back.</p></div>
    <div class="card"><div class="row"><h2 style="margin:0">Telemetry debug</h2><span class="spacer"></span><button id="rawGo">Show live raw values</button></div>
      <p class="muted">Use this while driving to check that speed, pedals, lap time, track position (npos) and coordinates look right.</p>
      <pre class="raw" id="raw" hidden></pre></div>`;
  $('#restart').onclick = (e) => restartPaddock(e.currentTarget);
  // brake spotter: saved on every change, like the HUD
  let sp = s.spotter, spT;
  const spOffsetTxt = (v) => (+v === 0 ? 'on the point' : `${Math.abs(v)} ms ${v > 0 ? 'earlier' : 'later'}`);
  const spShowState = () => {
    const st = spotterAudioState();
    $('#spState').innerHTML = st === 'elsewhere' ? 'Sound plays from another open Paddock window or tab.'
      : st === 'blocked' ? '<span class="g-bad">The browser has blocked sound on this page.</span> Click anywhere on the page once to allow it.'
      : 'Sound plays on your default Windows audio device, also while Paddock is minimised to the tray.';
  };
  $('#spSound').value = sp.sound; $('#spCountdown').value = sp.countdown; $('#spCorners').value = sp.corners; $('#spPoints').value = sp.points;
  $('#spPoints').onchange = (e) => spSave({ points: e.target.value });
  // mark button: "press it now" on the wheel (the server watches every controller for 10 s)
  const mbShow = (b) => { $('#mbName').textContent = b ? `${b.name}, button ${b.button}` : 'none'; $('#mbClear').hidden = !b; };
  mbShow(s.markButton);
  $('#mbBind').onclick = async (e) => {
    const btn = e.currentTarget; btn.disabled = true; $('#mbName').textContent = 'Press the button on your wheel or button box now…';
    try {
      const r = await post('/api/wheel/capture', {});
      if (r.binding) mbShow(r.binding);
      else $('#mbName').textContent = r.devices.length ? 'No button pressed. Try again.' : 'No wheel or controller found.';
    } catch (err) { $('#mbName').textContent = err.message; }
    btn.disabled = false;
  };
  $('#mbClear').onclick = async () => { await post('/api/settings', { markButton: null }); mbShow(null); };
  // keyboard shortcut: press the keys in the box; saved straight away
  const MK_TEXT = { ok: 'Active', taken: '<span class="g-bad">Another program already uses this shortcut, or it is not valid.</span>', 'desktop-only': 'Works only in the desktop app.', none: '' };
  const mkShow = (st) => { $('#mkState').innerHTML = MK_TEXT[st] ?? ''; };
  mkShow(s.markKeyState);
  const mkSave = async (accel) => { $('#markKey').value = accel; try { mkShow((await post('/api/settings', { markKey: accel })).markKeyState); } catch (err) { $('#mkState').textContent = err.message; } };
  $('#markKey').onkeydown = (e) => {
    e.preventDefault();
    if (e.key === 'Escape' || e.key === 'Backspace') return mkSave('');
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
    const key = /^F\d{1,2}$/.test(e.key) ? e.key : e.code.startsWith('Key') ? e.code.slice(3) : e.code.startsWith('Digit') ? e.code.slice(5)
      : e.code.startsWith('Numpad') ? `num${e.code.slice(6).toLowerCase()}` : e.key === ' ' ? 'Space'
      : e.key.startsWith('Arrow') ? e.key.slice(5) : e.key.length === 1 ? e.key.toUpperCase() : e.key;
    mkSave([e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', key].filter(Boolean).join('+'));
  };
  $('#mkClear').onclick = () => mkSave('');
  $('#spOffsetV').textContent = spOffsetTxt(sp.offsetMs);
  spShowState();
  const spSave = (patch) => {
    sp = { ...sp, ...patch };
    clearTimeout(spT);
    spT = setTimeout(async () => {
      try { sp = (await post('/api/settings', { spotter: sp })).spotter; $('#spSaved').textContent = 'Saved ✓'; }
      catch (e) { $('#spSaved').textContent = e.message; }
    }, 250);
  };
  $('#spOn').onchange = (e) => spSave({ on: e.target.checked });
  $('#spSound').onchange = (e) => { loadVoice(e.target.value); spSave({ sound: e.target.value }); };
  $('#spCountdown').onchange = (e) => spSave({ countdown: e.target.value });
  $('#spCorners').onchange = (e) => spSave({ corners: e.target.value });
  $('#spVolume').oninput = (e) => { $('#spVolumeV').textContent = `${e.target.value}%`; spSave({ volume: +e.target.value }); };
  $('#spOffset').oninput = (e) => { $('#spOffsetV').textContent = spOffsetTxt(e.target.value); spSave({ offsetMs: +e.target.value }); };
  $('#spTest').onclick = async () => {
    clearTimeout(spT);
    try { sp = (await post('/api/settings', { spotter: sp })).spotter; await post('/api/spotter/test', {}); } catch (e) { $('#spSaved').textContent = e.message; }
    setTimeout(spShowState, 300);
  };
  $('#save').onclick = async () => {
    const body = Object.fromEntries(['driverName', 'geminiApiKey', 'geminiModel', 'language', 'gamePath', 'aceDir'].map((k) => [k, $('#' + k).value.trim()]));
    try {
      status = await post('/api/settings', body); $('#saved').textContent = 'Saved ✓'; $('#geminiApiKey').value = status.geminiApiKey;
      // the game files folder is read when Paddock starts
      if ((body.aceDir || '') !== (s.aceDir || '')) {
        $('#saved').innerHTML = 'Saved ✓. Restart Paddock to use the new game files folder. <button class="small" id="restartAce">Restart now</button>';
        $('#restartAce').onclick = (e) => restartPaddock(e.currentTarget);
      }
    }
    catch (e) { $('#saved').textContent = e.message; }
  };
  // Paddock HUD look: saved on every change (the HUD picks it up with its next data read)
  let hudCfg = s.hud, hudT;
  const hudSave = () => {
    clearTimeout(hudT);
    hudT = setTimeout(async () => {
      try { hudCfg = (await post('/api/settings', { hud: hudCfg })).hud; $('#hudSaved').textContent = 'Saved ✓'; }
      catch (e) { $('#hudSaved').textContent = e.message; }
    }, 250);
  };
  const hudShow = () => {
    document.querySelectorAll('[data-part]').forEach((c) => { c.checked = !!hudCfg.parts[c.dataset.part]; });
    $('#hudScale').value = hudCfg.scale; $('#hudScaleV').textContent = `${hudCfg.scale}%`;
    $('#hudOpacity').value = hudCfg.opacity; $('#hudOpacityV').textContent = `${hudCfg.opacity}%`;
  };
  document.querySelectorAll('[data-part]').forEach((c) => {
    c.onchange = () => { hudCfg = { ...hudCfg, parts: { ...hudCfg.parts, [c.dataset.part]: c.checked } }; hudSave(); };
  });
  $('#hudScale').oninput = (e) => { hudCfg = { ...hudCfg, scale: +e.target.value }; hudShow(); hudSave(); };
  $('#hudOpacity').oninput = (e) => { hudCfg = { ...hudCfg, opacity: +e.target.value }; hudShow(); hudSave(); };
  $('#hudReset').onclick = async () => {
    clearTimeout(hudT);
    try { hudCfg = (await post('/api/settings', { hud: {} })).hud; hudShow(); $('#hudSaved').textContent = 'Defaults restored ✓'; }
    catch (e) { $('#hudSaved').textContent = e.message; }
  };
  // preview background (remembered in this browser only)
  const setPreviewBg = (bg) => {
    try { localStorage.setItem('hud.previewBg', bg); } catch { /* private window */ }
    document.querySelectorAll('#hudBg [data-bg]').forEach((b) => b.classList.toggle('on', b.dataset.bg === bg));
    $('#hudFrame').src = `/hud.html?demo&bg=${bg}`;
  };
  let previewBg = 'dark';
  try { previewBg = localStorage.getItem('hud.previewBg') || 'dark'; } catch { /* private window */ }
  document.querySelectorAll('#hudBg [data-bg]').forEach((b) => { b.onclick = () => setPreviewBg(b.dataset.bg); });
  setPreviewBg(HUD_PREVIEW_BG.some(([k]) => k === previewBg) ? previewBg : 'dark');
  // the same choices can be made in game (right-click the strip): follow them here
  let hudTouched = 0;
  document.querySelector('.hud-parts').addEventListener('input', () => { hudTouched = Date.now(); });
  document.querySelector('.hud-parts').addEventListener('change', () => { hudTouched = Date.now(); });
  const hudFollow = setInterval(async () => {
    if (Date.now() - hudTouched < 3000) return; // a change of ours may still be on its way
    try {
      const h = (await api('/api/settings')).hud;
      if (Date.now() - hudTouched < 3000 || JSON.stringify(h) === JSON.stringify(hudCfg)) return;
      hudCfg = h; hudShow();
    } catch { /* Paddock restarting */ }
  }, 3000);
  cleanup.push(() => { clearTimeout(hudT); clearInterval(hudFollow); });
  $('#loadModels').onclick = async () => {
    try {
      const models = await api('/api/ai/models');
      const cur = $('#geminiModel').value;
      $('#geminiModel').innerHTML = models.map((m) => `<option value="${esc(m.id)}" ${m.id === cur ? 'selected' : ''}>${esc(m.name)} (${esc(m.id)})</option>`).join('');
    } catch (e) { alert(e.message + '\n\n(Save your API key first.)'); }
  };
  let timer;
  $('#rawGo').onclick = () => {
    const pre = $('#raw');
    pre.hidden = !pre.hidden;
    clearInterval(timer);
    if (!pre.hidden) timer = setInterval(async () => { pre.textContent = JSON.stringify(await api('/api/debug/raw'), null, 2); }, 500);
  };
  cleanup.push(() => clearInterval(timer));
}
