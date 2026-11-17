// Sessions page (the home page, #/): sessions by track & car or by date, imports, start hotlap. Split from app.js.
import { $, esc, api, post, fmt, fmtGap, prettyName, SESSION_TYPES } from './util.js';
import { lapsBlock, bindLaps } from './reports.js';

// ================================================================== SESSIONS
// The Sessions page lists sessions, by track & car (one card per combo) or by date. A row is the session's summary;
// opening it shows the session page (public/reports.js): its report and its laps.
const LAP_VIEW_DEFAULT = { track: '', car: '', order: 'recent' };
let rerender = () => {}; // set by viewSessions: draws the page again (after deleting or importing laps)
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
  rerender();
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

export async function viewSessions(view, params, shell) {
  rerender = shell.rerender;
  if (shell.entering) lapView = { ...LAP_VIEW_DEFAULT };
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
    if ($(sel)) $(sel).onchange = (e) => { lapView[k] = e.target.value; rerender(); };
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
    if (imp) bindLaps(imp, o.laps.filter((l) => l.source === 'import' && comboOf(l) === key), () => rerender());
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
      <a href="#/setuphistory?combo=${encodeURIComponent(c.key)}"><button title="Every setup you drove here, how fast each was, and what differs between two of them">Setup history</button></a>
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
      rerender();
    };
    inp.click();
  };
}
