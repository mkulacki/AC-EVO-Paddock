// AC EVO Paddock - browser app (no build step)
import { $, css, esc, api, post, fmt, fmtGap, gapClass, prettyName, SESSION_TYPES, SERIES, idxAt, md, getMirror, sideTxt, wideTxt, fitProjection, gearTxt } from './util.js';
import { mountReplay } from './replay.js';
import { viewConsistency } from './consistency.js';
import { viewTracks, viewTrack } from './tracks.js';
import { viewRace } from './race.js';
import { viewProgress } from './progress.js';
import { viewMods } from './mods.js';
import { viewSetups } from './setups.js';
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
  currentRoute = { '/compare': 'compare', '/settings': 'settings', '/consistency': 'consistency', '/progress': 'progress', '/game': 'game', '/mods': 'mods', '/race': 'race', '/setups': 'setups', '/tracks': 'tracks', '/track': 'track' }[path] || 'laps';
  if (currentRoute === 'laps' && prevRoute !== 'laps') lapView = { ...LAP_VIEW_DEFAULT };
  const navKey = currentRoute === 'track' ? 'tracks' : ['settings', 'game', 'mods', 'race', 'setups', 'tracks'].includes(currentRoute) ? currentRoute : 'laps';
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
    else await viewLaps();
  } catch (e) {
    view.innerHTML = `<div class="card error">Error: ${esc(e.message)}</div>`;
  }
}
window.addEventListener('hashchange', render);
queueMicrotask(render); // after all module-level declarations are initialised

// ================================================================== LAPS
const selected = new Map(); // comboKey -> Set(lapId)
const LAP_VIEW_DEFAULT = { track: '', car: '', order: 'recent' };
let lapView = { ...LAP_VIEW_DEFAULT }; // filters/order; kept across auto-refreshes, reset when leaving the page
// column sort of the lap tables: null = grouped by session (oldest first); otherwise one flat list
let lapSort = null;
try { lapSort = JSON.parse(localStorage.getItem('laps.sort') || 'null'); } catch { /* none */ }
const LAP_COLS = {
  lap: ['Lap', (l) => l.lap_number ?? -1],
  time: ['Time', (l) => l.lap_time_ms],
  gap: ['Gap', (l) => l.lap_time_ms],
  driver: ['Driver', (l) => String(l.driver || '').toLowerCase()],
  recorded: ['Recorded', (l) => l.recorded_at],
};
// header click: ascending -> descending -> back to the session groups
function cycleLapSort(col) {
  lapSort = lapSort?.col !== col ? { col, dir: 1 } : lapSort.dir === 1 ? { col, dir: -1 } : null;
  try { localStorage.setItem('laps.sort', JSON.stringify(lapSort)); } catch { /* ignore */ }
}
const fmtStamp = (ms) => new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
async function removeLaps(ids, what) {
  if (!ids.length) return;
  if (!confirm(`Delete ${ids.length} ${what} permanently?\n\nThis cannot be undone.`)) return;
  await post('/api/laps/delete', { ids });
  for (const s of selected.values()) for (const id of ids) s.delete(id);
  render();
}

async function viewLaps() {
  const o = await api('/api/overview');
  if (!o.combos.length) {
    view.innerHTML = `<div class="card empty">
      <h2>No laps yet</h2>
      <p>Start Assetto Corsa EVO and drive. Laps are saved automatically when you cross the line.</p>
      <p class="muted">Want to try it first? Run <code>npm run seed</code> for demo laps, or start with <code>npm run mock</code>.</p>
      <p><label class="row" style="justify-content:center"><button id="imp">Import lap files…</button></label></p>
    </div>`;
    bindImport($('#imp'));
    return;
  }
  const sessions = new Map(o.sessions.map((s) => [s.id, s]));
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
  const comboLaps = (c) => o.laps.filter((l) => `${l.track}|${l.layout}|${l.car}` === c.key);
  const opts = (list, cur, all) => `<option value="">${all}</option>` + list.map((v) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(prettyName(v))}</option>`).join('');
  view.innerHTML = `
    <div class="row" style="margin-bottom:16px">
      <h1>Your laps</h1><span class="spacer"></span>
      <select id="f-track" title="Filter by track">${opts(tracks, lapView.track, 'All tracks')}</select>
      <select id="f-car" title="Filter by car">${opts(cars, lapView.car, 'All cars')}</select>
      <select id="f-order" title="Order by">${Object.entries(orders).map(([k, [label]]) => `<option value="${k}" ${k === lapView.order ? 'selected' : ''}>${label}</option>`).join('')}</select>
      <button id="imp">Import lap files…</button>
    </div>
    ${combos.length ? '' : '<div class="card empty"><p>No laps match this track and car. Choose “All tracks” or “All cars” to see the rest.</p></div>'}
    ${combos.map((c) => comboCard(c, comboLaps(c), sessions)).join('')}`;
  bindImport($('#imp'));
  view.querySelectorAll('th[data-sort]').forEach((th) => { th.onclick = () => { cycleLapSort(th.dataset.sort); render(); }; });
  [['#f-track', 'track'], ['#f-car', 'car'], ['#f-order', 'order']].forEach(([sel, k]) => {
    $(sel).onchange = (e) => { lapView[k] = e.target.value; render(); };
  });

  view.querySelectorAll('[data-combo]').forEach((card) => {
    const key = card.dataset.combo;
    if (!selected.has(key)) selected.set(key, new Set());
    const sel = selected.get(key);
    const btn = card.querySelector('.cmp-sel');
    const upd = () => { btn.disabled = !sel.size; btn.textContent = `Compare selected (${sel.size})`; };
    card.querySelectorAll('input[data-lap]').forEach((cb) => {
      cb.checked = sel.has(+cb.dataset.lap);
      cb.onchange = () => {
        const id = +cb.dataset.lap;
        if (cb.checked) { if (sel.size >= 3) { cb.checked = false; alert('Compare up to 3 laps against the reference.'); return; } sel.add(id); } else sel.delete(id);
        upd();
      };
    });
    upd();
    btn.onclick = () => {
      const ref = card.querySelector('.ref-sel').value;
      let ids = [...sel];
      let r = ref;
      if (ref === 'first') { r = ids[0]; }
      location.hash = `#/compare?laps=${ids.join(',')}&ref=${r}`;
    };
    card.querySelector('[data-hotlap]').onclick = () => {
      const c = o.combos.find((x) => x.key === key);
      if (c) startHotlap(c);
    };
    const rmc = card.querySelector('[data-rm-invalid]');
    if (rmc) rmc.onclick = () => {
      const ids = rmc.dataset.rmInvalid.split(',').map(Number);
      removeLaps(ids, `invalid lap${ids.length > 1 ? 's' : ''} of this car and track`);
    };
    // a click anywhere on a lap row (not on its checkbox or tools) opens it against the best lap, or the best lap against the ideal
    card.querySelectorAll('tr[data-open]').forEach((tr) => tr.onclick = (e) => {
      if (e.target.closest('input, button, a, label')) return;
      location.hash = tr.dataset.open;
    });
    card.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
      if (!confirm('Delete this lap permanently?')) return;
      await api(`/api/laps/${b.dataset.del}`, { method: 'DELETE' });
      sel.delete(+b.dataset.del); render();
    });
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

function comboCard(c, laps, sessions) {
  const groups = new Map();
  for (const l of laps) {
    const g = l.source === 'import' ? 'import' : l.session_id;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(l);
  }
  // timing-sheet colours: purple = best lap of this car and track, green = fastest valid lap of its session
  const sessionBest = new Map();
  for (const l of laps) if (l.valid && l.source !== 'import') {
    const b = sessionBest.get(l.session_id);
    if (!b || l.lap_time_ms < b.lap_time_ms) sessionBest.set(l.session_id, l);
  }
  // one driver for every lap: the Driver column says nothing
  const showDriver = new Set(laps.map((l) => l.driver || '')).size > 1;
  const row = (l) => {
      const gap = c.bestMs ? l.lap_time_ms - c.bestMs : null;
      const isBest = l.id === c.bestLapId;
      const isPb = !isBest && l.valid && sessionBest.get(l.session_id)?.id === l.id;
      const open = isBest ? `#/compare?laps=${l.id}&ref=ideal` : `#/compare?laps=${l.id}&ref=best`;
      return `<tr class="${l.valid ? '' : 'invalid'}" data-open="${open}" title="${isBest ? 'Compare with the ideal lap' : 'Compare with your best lap'}">
        <td><input type="checkbox" data-lap="${l.id}" aria-label="Select lap for comparison"></td>
        <td class="muted">${l.lap_number ?? ''}</td>
        <td class="time${isBest ? ' best' : isPb ? ' pb' : ''}"><a href="${open}"><b>${fmt(l.lap_time_ms)}</b></a> ${isBest ? '<span class="badge best">Best</span>' : isPb ? '<span class="badge pb">Session best</span>' : ''} ${l.valid ? '' : '<span class="badge bad">Invalid</span>'}</td>
        <td class="secondary">${isBest ? '' : fmtGap(gap)}</td>
        ${showDriver ? `<td class="secondary">${esc(l.driver || '')}${l.source === 'import' ? ' <span class="badge">Imported</span>' : ''}</td>` : ''}
        <td class="muted" style="white-space:nowrap">${esc(fmtStamp(l.recorded_at))}</td>
        <td class="actions">
          <a href="#/compare?laps=${l.id}&ref=ideal"><button class="small ghost" title="Compare with the ideal lap (your best sectors)">Ideal</button></a>
          <a href="/api/laps/${l.id}/export" download><button class="small ghost" title="Export lap file" aria-label="Export lap file">⇩</button></a>
          <button class="small ghost" data-del="${l.id}" title="Delete lap" aria-label="Delete lap">✕</button>
        </td></tr>`;
  };
  const cols = showDriver ? 7 : 6;
  let rows;
  const sortCol = lapSort && LAP_COLS[lapSort.col];
  if (sortCol) {
    // one flat list sorted by the clicked column (ties: oldest first)
    const key = sortCol[1];
    const cmp = (a, b) => { const x = key(a), y = key(b); return x < y ? -1 : x > y ? 1 : 0; };
    rows = [...laps].sort((a, b) => lapSort.dir * cmp(a, b) || a.recorded_at - b.recorded_at).map(row).join('');
  } else {
    rows = [...groups.entries()].map(([g, ls]) => {
      const s = sessions.get(g);
      const when = s ? new Date(s.started_at).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
      const head = g === 'import' ? '<b>Imported laps</b>'
        : `<b>${esc(SESSION_TYPES[s?.session_type] || 'Session')}</b> on ${esc(when)}, ${ls.length} lap${ls.length === 1 ? '' : 's'}`;
      const sorted = g === 'import' ? ls.sort((a, b) => a.lap_time_ms - b.lap_time_ms) : ls.sort((a, b) => a.recorded_at - b.recorded_at);
      return `<tr class="session"><td colspan="${cols}">${head}</td></tr>` + sorted.map(row).join('');
    }).join('');
  }
  const th = (col) => {
    const on = lapSort?.col === col;
    const tip = !on ? 'Sort by this column' : lapSort.dir === 1 ? 'Sorted ascending: click for descending' : 'Sorted descending: click to group by session again';
    return `<th data-sort="${col}" class="sortable${on ? ' on' : ''}" title="${tip}">${LAP_COLS[col][0]}<span class="arrow">${on ? (lapSort.dir === 1 ? '▲' : '▼') : ''}</span></th>`;
  };
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
      <button class="cmp-sel" disabled>Compare selected</button>
      <select class="ref-sel" title="Reference lap">
        <option value="best">with my best lap</option><option value="ideal">with the ideal lap</option><option value="first">with the first one selected</option>
      </select>
      ${invalidIds.length ? `<button class="danger-ghost" data-rm-invalid="${invalidIds.join(',')}" title="Delete the invalid laps of this car and track">Remove invalid laps (${invalidIds.length})</button>` : ''}
    </div>
    <table class="laps"><thead><tr><th></th>${th('lap')}${th('time')}${th('gap')}${showDriver ? th('driver') : ''}${th('recorded')}<th></th></tr></thead><tbody>${rows}</tbody></table>
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

// ================================================================== COMPARE
let cmpCache = null; // last comparison payload, reused when switching tabs
events.addEventListener('lap', () => { cmpCache = null; });
async function viewCompare(params) {
  const lapIds = params.get('laps');
  const ref = params.get('ref') || 'best';
  const tab = params.get('tab') === 'line' ? 'line' : 'charts';
  const key = `${lapIds}|${ref}`;
  if (cmpCache?.key !== key) {
    view.innerHTML = '<div class="card"><span class="spinner"></span> Loading telemetry…</div>';
    cmpCache = { key, data: await api(`/api/compare?laps=${lapIds}&ref=${ref}`) };
  }
  const data = cmpCache.data;
  const laps = data.laps;
  const mirror = getMirror();
  const hrefTab = (t) => `#/compare?laps=${lapIds}&ref=${ref}${t === 'line' ? '&tab=line' : ''}`;
  const color = (i) => css(SERIES[i]); // 0 = reference
  const step = data.ref.trace.d[1] - data.ref.trace.d[0];
  let focus = 0; // index into laps used for table/map/AI

  const chip = (label, ms, i, extra = '') => `<div class="chip"><span class="sw" style="background:${color(i)}"></span><span>${label}</span><span class="t">${fmt(ms)}</span>${extra}</div>`;
  view.innerHTML = `
    <div class="cmp-head">
      <a href="#/"><button class="ghost">Back to laps</button></a>
      <div><h1>${esc(prettyName(data.combo.track))} <span class="muted">${esc(prettyName(data.combo.layout))}</span></h1>
        <div class="secondary">${esc(prettyName(data.combo.car))}. Best lap ${fmt(data.bestMs)}, ideal lap ${fmt(data.idealMs)}</div></div>
      <span class="spacer"></span>
      <label class="row">Reference <select id="refSel">
        <option value="best">My best lap</option><option value="ideal">Ideal lap (best segments)</option>
        ${data.ref.id !== 'ideal' && String(ref) !== 'best' ? `<option value="${data.ref.id}">Lap #${data.ref.id}</option>` : ''}
      </select></label>
    </div>
    <div class="chips" style="margin-bottom:16px">
      ${chip(`Reference: ${esc(data.ref.label)}${data.ref.meta?.driver ? ` (${esc(data.ref.meta.driver)})` : ''}`, data.ref.lapTimeMs, 0)}
      ${laps.map((l, i) => chip(`Lap #${l.id}${l.meta.source === 'import' ? ` (${esc(l.meta.driver)})` : ''}${l.meta.valid ? '' : ' (invalid)'}`, l.meta.lap_time_ms, i + 1,
        `<span class="num ${gapClass(l.meta.lap_time_ms - data.ref.lapTimeMs)}">${fmtGap(l.meta.lap_time_ms - data.ref.lapTimeMs)}</span>`)).join('')}
    </div>
    ${!laps.length ? '<div class="card muted">This lap is the reference itself. Choose another reference, such as the ideal lap, to see where time goes.</div>' : ''}
    ${data.ref.sources ? `<div class="card plain"><h3>The ideal lap joins your best sectors</h3><div class="ideal-src">${data.ref.sources.map((s) =>
      `<span><b>${s.corner}</b> ${(s.timeMs / 1000).toFixed(3)}s from <a href="#/compare?laps=${s.lapId}&ref=ideal">lap #${s.lapId}</a></span>`).join('')}</div></div>` : ''}
    <div class="tabs"><a href="${hrefTab('charts')}" class="${tab === 'charts' ? 'on' : ''}">Charts &amp; analysis</a><a href="${hrefTab('line')}" class="${tab === 'line' ? 'on' : ''}">Racing line replay</a></div>
    <div id="tabBody">
    <div class="grid2">
      <div class="card mapwrap"><h2>Track map</h2><canvas id="map"></canvas>
        <div class="legend-scale">${laps.length ? `<span>Gaining</span><span class="bar"></span><span>Losing</span><span class="muted">lap #${laps[0]?.id} against the reference</span>` : ''}</div></div>
      <div class="card"><div class="row" style="margin-bottom:8px"><h2 style="margin:0">Corners</h2><span class="spacer"></span>
        ${laps.length > 1 ? `<label class="row">Lap <select id="focusSel">${laps.map((l, i) => `<option value="${i}">#${l.id}</option>`).join('')}</select></label>` : ''}
        <span class="muted" style="font-size:12px">Click a corner to zoom the charts to it</span></div>
        <div class="corner-table" id="corners"></div></div>
    </div>
    <div class="card plain charts" id="charts"></div>
    <div class="card plain" id="ai"></div>
    </div>`;

  $('#refSel').value = String(ref);
  $('#refSel').onchange = (e) => { location.hash = `#/compare?laps=${lapIds}&ref=${e.target.value}${tab === 'line' ? '&tab=line' : ''}`; };
  if (tab === 'line') {
    mountReplay($('#tabBody'), data, cleanup, { at: params.has('at') ? +params.get('at') : null,
      mode: params.get('mode'), inputs: params.has('inputs') ? params.get('inputs') === '1' : null });
    return;
  }

  // ---------------- corner table
  let selCorner = null;
  const renderCorners = () => {
    const lap = laps[focus];
    if (!lap) { $('#corners').innerHTML = '<p class="muted">No lap to compare.</p>'; return; }
    const losses = data.corners.map((c) => lap.delta[idxAt(lap.trace.d, c.end)] - lap.delta[idxAt(lap.trace.d, c.start)]);
    const maxL = Math.max(0.05, ...losses.map(Math.abs));
    const dv = (a, b, unit, invert = false) => {
      if (a == null || b == null) return '<span class="muted">–</span>';
      const d = a - b; const good = invert ? d < 0 : d > 0;
      return `${a}${unit} <small class="${Math.abs(d) < 0.5 ? 'muted' : good ? 'neg' : 'pos'}">${d > 0 ? '+' : ''}${Math.round(d * 10) / 10}</small>`;
    };
    $('#corners').innerHTML = `<table><thead><tr><th>Corner</th><th>Time lost</th><th>Brake point (m)</th><th>Min speed</th><th>Throttle on (m)</th><th>Exit speed</th><th>Coast (m)</th><th title="Your line vs the reference line at turn-in / apex / exit. + = wider (towards the outside), − = tighter">Line in/apex/out (m)</th></tr></thead><tbody>
      ${data.corners.map((c, i) => {
        const m = lap.corners[i], r = data.ref.corners[i], loss = losses[i];
        const w = Math.round((Math.abs(loss) / maxL) * 60);
        return `<tr data-c="${i}" class="${selCorner === i ? 'sel' : ''}">
          <td><b>${c.name}</b> <span class="muted">${c.apex} m</span>
            <a class="replay-link" title="Replay this corner" href="${hrefTab('line')}&at=${Math.max(0, (r.brakePoint ?? r.liftPoint ?? c.start) - 60)}">▶</a></td>
          <td><span class="lossbar" style="width:${w}px;background:${loss > 0 ? 'var(--slower)' : 'var(--faster)'}"></span><span class="${gapClass(loss * 1000)}">${fmtGap(loss * 1000)}</span></td>
          <td>${m.brakePoint != null ? dv(m.brakePoint, r.brakePoint, '') : m.liftPoint != null ? `lift ${m.liftPoint}` : '<span class="muted">flat</span>'}</td>
          <td>${dv(m.minSpeed, r.minSpeed, '')}</td>
          <td>${dv(m.throttlePickup, r.throttlePickup, '', true)}</td>
          <td>${dv(m.exitSpeed, r.exitSpeed, '')}</td>
          <td>${m.coastM ? `<span class="${m.coastM > r.coastM + 5 ? 'pos' : ''}">${m.coastM}</span>` : '<span class="muted">0</span>'}</td>
          <td class="num">${[m.entryWide, m.apexWide, m.exitWide].map((v) => `<span class="${v != null && Math.abs(v) >= 0.5 ? 'secondary' : 'muted'}">${wideTxt(v)}</span>`).join(' / ')}</td></tr>`;
      }).join('')}</tbody></table>
      <p class="foot-note" style="margin:8px 0 0;max-width:80ch">Small numbers are the difference to the reference. A positive brake point means you braked later; a negative throttle point means you were back on the throttle earlier. On the line, positive is wider than the reference (towards the outside of the corner) and negative is tighter.</p>`;
    $('#corners').querySelectorAll('tr[data-c]').forEach((tr) => tr.onclick = () => {
      const i = +tr.dataset.c;
      selCorner = selCorner === i ? null : i;
      const c = data.corners[i];
      zoom(selCorner == null ? null : [Math.max(0, c.start - 50), c.end + 50]);
      renderCorners(); drawMap();
    });
  };
  if ($('#focusSel')) $('#focusSel').onchange = (e) => { focus = +e.target.value; renderCorners(); drawMap(); renderAI(); };
  renderCorners();

  // ---------------- track map
  const canvas = $('#map');
  let cursorIdx = null;
  function drawMap() {
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth, H = canvas.clientHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const { x, z } = data.ref.trace;
    const P = fitProjection(x, z, W, H, 24, mirror);

    // colour by time gained/lost per chunk
    const lap = laps[focus];
    const k = Math.max(1, Math.round(10 / step));
    const raw = [];
    if (lap) for (let i = 0; i + k < x.length; i += k) raw.push(lap.delta[i + k] - lap.delta[i]);
    // smooth over ~±40 m so the colours show trends, not sampling noise
    const slopes = raw.map((_, j) => { let s = 0, c = 0; for (let q = Math.max(0, j - 4); q <= Math.min(raw.length - 1, j + 4); q++) { s += raw[q]; c++; } return s / c; });
    const sorted = slopes.map(Math.abs).sort((a, b) => a - b);
    const scale = Math.max(0.01, sorted[Math.floor(sorted.length * 0.95)] || 0.01);
    const rgb = (h) => { const n = parseInt(h.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
    const cF = rgb(css('--faster')), cS = rgb(css('--slower')), cN = rgb(css('--neutral'));
    const mix = (a, b, t) => `rgb(${a.map((v, j) => Math.round(v + (b[j] - v) * t)).join(',')})`;

    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    // real track surface from the recorded track model (shared by all cars)
    const band = data.band;
    if (band?.source?.left === 'track') {
      ctx.fillStyle = css('--grid');
      ctx.beginPath();
      band.left.x.forEach((bx, i) => { const [px, py] = P(bx, band.left.z[i]); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
      ctx.closePath();
      for (let i = band.right.x.length - 1; i >= 0; i--) { const [px, py] = P(band.right.x[i], band.right.z[i]); i === band.right.x.length - 1 ? ctx.moveTo(px, py) : ctx.lineTo(px, py); }
      ctx.closePath(); ctx.fill('evenodd');
    }
    // base outline
    ctx.strokeStyle = css('--axis'); ctx.lineWidth = 9;
    ctx.beginPath(); for (let i = 0; i < x.length; i++) { const [px, py] = P(x[i], z[i]); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); } ctx.stroke();
    ctx.lineWidth = 5;
    for (let j = 0, i = 0; i + k < x.length; i += k, j++) {
      const v = lap ? Math.max(-1, Math.min(1, slopes[j] / scale)) : 0;
      ctx.strokeStyle = v >= 0 ? mix(cN, cS, v) : mix(cN, cF, -v);
      ctx.beginPath();
      for (let q = i; q <= i + k; q++) { const [px, py] = P(x[q], z[q]); q === i ? ctx.moveTo(px, py) : ctx.lineTo(px, py); }
      ctx.stroke();
    }
    // selected corner outline
    if (selCorner != null) {
      const c = data.corners[selCorner];
      ctx.strokeStyle = css('--text-primary'); ctx.lineWidth = 2; ctx.setLineDash([4, 3]);
      ctx.beginPath();
      for (let i = idxAt(data.ref.trace.d, c.start); i <= idxAt(data.ref.trace.d, c.end); i++) { const [px, py] = P(x[i], z[i]); ctx.lineTo(px, py); }
      ctx.stroke(); ctx.setLineDash([]);
    }
    // start/finish
    const [sx, sy] = P(x[0], z[0]);
    ctx.fillStyle = css('--text-primary'); ctx.fillRect(sx - 4, sy - 4, 8, 8);
    // corner labels
    ctx.font = '600 11px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const c of data.corners) {
      const i = idxAt(data.ref.trace.d, c.apex);
      const [px, py] = P(x[i], z[i]);
      // offset label outward from the track centre
      const cx = W / 2, cy = H / 2, dx = px - cx, dy = py - cy, len = Math.hypot(dx, dy) || 1;
      const lx = px + (dx / len) * 16, ly = py + (dy / len) * 16;
      ctx.fillStyle = css('--surface-2'); ctx.beginPath(); ctx.arc(lx, ly, 11, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = css('--text-secondary'); ctx.fillText(c.name, lx, ly);
    }
    // cursor
    if (cursorIdx != null) {
      const dots = [[data.ref.trace, 0], ...laps.map((l, i) => [l.trace, i + 1])];
      for (const [t, ci] of dots) {
        const [px, py] = P(t.x[cursorIdx], t.z[cursorIdx]);
        ctx.fillStyle = color(ci); ctx.strokeStyle = css('--surface-1'); ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(px, py, 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
    }
  }
  drawMap();

  // ---------------- charts (uPlot, synced cursor + zoom)
  const charts = [];
  let syncing = false;
  const d = data.ref.trace.d;
  const all = [data.ref, ...laps];
  const name = (i) => (i === 0 ? 'Ref' : `#${laps[i - 1].id}`);
  const axisStyle = () => ({ stroke: css('--text-muted'), grid: { stroke: css('--grid'), width: 1 }, ticks: { stroke: css('--grid') }, font: '11px system-ui' });
  const cornerPlugin = (labels) => ({
    hooks: {
      draw: (u) => {
        const ctx = u.ctx; ctx.save();
        const top = u.bbox.top, bot = u.bbox.top + u.bbox.height;
        if (selCorner != null) {
          const c = data.corners[selCorner];
          const a = u.valToPos(c.start, 'x', true), b = u.valToPos(c.end, 'x', true);
          ctx.fillStyle = 'rgba(127,127,127,0.08)'; ctx.fillRect(a, top, b - a, bot - top);
        }
        ctx.strokeStyle = css('--axis'); ctx.setLineDash([3, 4]); ctx.lineWidth = 1;
        ctx.fillStyle = css('--text-muted'); ctx.font = `${11 * devicePixelRatio}px system-ui`; ctx.textAlign = 'center';
        for (const c of data.corners) {
          const px = u.valToPos(c.apex, 'x', true);
          if (px < u.bbox.left || px > u.bbox.left + u.bbox.width) continue;
          ctx.beginPath(); ctx.moveTo(px, top); ctx.lineTo(px, bot); ctx.stroke();
          if (labels) ctx.fillText(c.name, px, top + 12 * devicePixelRatio);
        }
        ctx.restore();
      },
    },
  });
  function makeChart(title, series, values, { height = 120, range, stepped = false, labels = false, fmtV = (v) => v } = {}) {
    const el = document.createElement('div');
    const [t, note] = Array.isArray(title) ? title : [title];
    el.innerHTML = `<div class="chart-title">${t}${note ? `<span>${note}</span>` : ''}</div>`;
    $('#charts').appendChild(el);
    const opts = {
      width: $('#charts').clientWidth - 32, height,
      plugins: [cornerPlugin(labels)],
      cursor: { sync: { key: 'cmp' }, drag: { x: true, y: false }, points: { size: 6 } },
      scales: { x: { time: false }, y: range ? { range } : {} },
      legend: { live: true },
      axes: [{ ...axisStyle(), values: (u, vals) => vals.map((v) => `${v} m`) }, { ...axisStyle(), size: 50, values: (u, vals) => vals.map(fmtV) }],
      series: [{ label: 'Distance', value: (u, v) => (v == null ? '–' : `${Math.round(v)} m`) }, ...series.map((s) => ({
        width: 1.5, value: (u, v) => (v == null ? '–' : fmtV(v)), ...(stepped ? { paths: uPlot.paths.stepped({ align: 1 }) } : {}), ...s,
      }))],
      hooks: {
        setScale: [(u, key) => {
          if (key !== 'x' || syncing) return;
          syncing = true;
          for (const c of charts) if (c !== u) c.setScale('x', { min: u.scales.x.min, max: u.scales.x.max });
          syncing = false;
        }],
        setCursor: [(u) => { const i = u.cursor.idx; if (i !== cursorIdx) { cursorIdx = i; drawMap(); } }],
      },
    };
    const chart = new uPlot(opts, [d, ...values], el);
    charts.push(chart);
    return chart;
  }
  const lapSeries = (fmtLabel) => all.map((_, i) => ({ label: fmtLabel ? fmtLabel(i) : name(i), stroke: color(i), width: i === 0 ? 1.5 : 1.5 }));
  if (laps.length) {
    makeChart(['Gap to reference, in seconds', 'rising means losing time'], [{ label: 'Ref', stroke: css('--axis'), width: 1 }, ...laps.map((l, i) => ({ label: name(i + 1), stroke: color(i + 1), width: 2 }))],
      [d.map(() => 0), ...laps.map((l) => l.delta)], { height: 150, fmtV: (v) => `${v > 0 ? '+' : ''}${(+v).toFixed(2)}s` });
    const sgn = mirror ? -1 : 1;
    makeChart(['Racing line against the reference, in metres', 'above zero means left of the reference on the map'], [{ label: 'Ref line', stroke: css('--axis'), width: 1 }, ...laps.map((l, i) => ({ label: name(i + 1), stroke: color(i + 1), width: 1.5 }))],
      [d.map(() => 0), ...laps.map((l) => l.offset.map((v) => v * sgn))], { height: 130, fmtV: (v) => sideTxt(v * sgn, mirror) });
  }
  makeChart(['Speed', 'km/h'], lapSeries(), all.map((l) => l.trace.spd), { height: 220, labels: true, fmtV: (v) => Math.round(v) });
  makeChart(['Throttle', '%'], lapSeries(), all.map((l) => l.trace.thr.map((v) => v * 100)), { range: [0, 102], fmtV: (v) => `${Math.round(v)}%` });
  makeChart(['Brake', '%'], lapSeries(), all.map((l) => l.trace.brk.map((v) => v * 100)), { range: [0, 102], fmtV: (v) => `${Math.round(v)}%` });
  makeChart('Steering', lapSeries(), all.map((l) => l.trace.str), { fmtV: (v) => (+v).toFixed(2) });
  makeChart('Gear', lapSeries(), all.map((l) => l.trace.gear), { height: 100, stepped: true, fmtV: gearTxt });

  function zoom(range) {
    syncing = true;
    for (const c of charts) c.setScale('x', range ? { min: range[0], max: range[1] } : { min: d[0], max: d[d.length - 1] });
    syncing = false;
  }
  const onResize = () => { for (const c of charts) c.setSize({ width: $('#charts').clientWidth - 32, height: c.height }); drawMap(); };
  window.addEventListener('resize', onResize);
  cleanup.push(() => { window.removeEventListener('resize', onResize); charts.forEach((c) => c.destroy()); });

  // ---------------- AI coach
  const refKey = String(ref);
  function renderAI() {
    const lap = laps[focus];
    const box = $('#ai');
    if (!lap) { box.innerHTML = ''; return; }
    box.innerHTML = `<div class="row"><h2 style="margin:0">AI driving coach</h2><span class="muted">Lap #${lap.id} against ${esc(data.ref.label)}</span><span class="spacer"></span>
        <a class="muted" style="font-size:12px" href="/api/ai/summary?lap=${lap.id}&ref=${refKey}" target="_blank">What is sent to the AI?</a>
        <button class="primary" id="aiGo" ${status.hasKey ? '' : 'disabled'}>Analyze my driving</button></div>
      ${status.hasKey ? '' : '<p class="muted">Add a free Google Gemini API key in <a href="#/settings">Settings</a> to enable the AI coach.</p>'}
      <div class="ai-out" id="aiOut"></div>
      <div class="ai-q" id="aiQ" hidden><input id="aiQIn" placeholder="Ask a follow-up, e.g. “How should I approach T3 differently?”"><button id="aiQGo">Ask</button></div>`;
    const out = $('#aiOut');
    const run = async (body, append) => {
      const holder = document.createElement('div');
      holder.innerHTML = '<p><span class="spinner"></span> Analyzing telemetry…</p>';
      if (append) out.appendChild(holder); else { out.innerHTML = ''; out.appendChild(holder); }
      try {
        const r = await post('/api/ai/analyze', { lap: lap.id, ref: refKey, ...body });
        holder.innerHTML = (body.question ? `<p class="secondary"><b>Q:</b> ${esc(body.question)}</p>` : '') + md(r.text) +
          `<p class="muted" style="font-size:12px">${r.cached ? 'Saved analysis from' : 'Analysis by'} ${esc(r.model)}, ${new Date(r.createdAt).toLocaleString()}${r.cached ? ' <button class="small ghost" id="aiRe">Analyze again</button>' : ''}</p>`;
        if (r.cached) holder.querySelector('#aiRe').onclick = () => run({ force: true });
        $('#aiQ').hidden = false;
      } catch (e) { holder.innerHTML = `<p class="error">${esc(e.message)}</p>`; }
    };
    $('#aiGo').onclick = () => run({});
    const ask = () => { const q = $('#aiQIn').value.trim(); if (q) { $('#aiQIn').value = ''; run({ question: q }, true); } };
    $('#aiQGo').onclick = ask;
    $('#aiQIn').onkeydown = (e) => { if (e.key === 'Enter') ask(); };
  }
  renderAI();
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
