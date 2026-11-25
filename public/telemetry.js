// Telemetry analysis: your lap (up to 3) against a reference. Used by the session page (Telemetry tab) and the compare page.
// Layout: lap picker · "where the time went" bar (one segment per corner and straight) · on the left the track map and the
// selected corner, on the right the charts. One cursor: hovering the charts or the map moves the cursor on all charts and the
// cars on the map. Clicking a corner (bar, map or the corner card) zooms the charts and the map to it.
import { css, esc, api, post, fmt, fmtGap, gapClass, idxAt, md, aiConfidence, getMirror, sideTxt, fitProjection, gearTxt, SERIES, prov } from './util.js';

const MAX_LAPS = 3;
const color = (i) => css(SERIES[i]); // 0 = reference, 1.. = laps
// which charts are shown (checkboxes at the top of the Telemetry card), remembered per browser
const CHARTS = { gap: 'Gap', speed: 'Speed', pedals: 'Pedals', steering: 'Steering', gear: 'Gear', rpm: 'RPM', line: 'Racing line' };
let shown = new Set(['gap', 'speed', 'pedals', 'steering']);
try {
  const saved = localStorage.getItem('tele.charts');
  if (saved) shown = new Set(JSON.parse(saved).filter((k) => k in CHARTS));
  else for (const k of JSON.parse(localStorage.getItem('tele.extra') || '[]')) if (k in CHARTS) shown.add(k); // before 0.6: only the extra charts were optional
} catch { /* defaults */ }
// what colours the map: 'time' (gaining / losing against the reference) or 'inputs' (brake / throttle / coasting)
let mapLayer = 'time';
try { mapLayer = localStorage.getItem('tele.mapLayer') === 'inputs' ? 'inputs' : 'time'; } catch { /* default */ }
// map zoom (+ / − on the map): above 1× the map follows the car (the cursor position)
const MAP_ZOOMS = [1, 1.5, 2, 3, 4, 6, 8];
let mapZoom = 1;
try { const z = +localStorage.getItem('tele.mapZoom'); if (MAP_ZOOMS.includes(z)) mapZoom = z; } catch { /* default */ }
// the game's racing line on the track map: off unless the driver turns it on (remembered)
let racingLine = false;
try { racingLine = localStorage.getItem('tele.racingLine') === '1'; } catch { /* default */ }
// one input state per grid point, the same limits as the technique metrics (src/analysis.js)
const INPUTS = [
  { k: 'brake', label: 'Braking', v: '--critical', is: (L, i) => L.brk[i] > 0.1 },
  { k: 'coast', label: 'Coasting', v: '--warning', is: (L, i) => L.thr[i] < 0.1 && L.spd[i] > 30 },
  { k: 'full', label: 'Full throttle', v: '--good', is: (L, i) => L.thr[i] > 0.95 },
  { k: 'part', label: 'Part throttle', v: '--faster', is: () => true },
];
export const inputState = (L, i) => INPUTS.findIndex((s) => s.is(L, i));
const dataCache = new Map(); // "laps|ref" -> compare payload (small: last few)
// comparisons the driver chose to see although they are not comparable ("laps|ref"), for this page visit (PL4.2)
const accepted = new Set();
/** The key a "Compare anyway" is remembered under: the same on the Telemetry and the Racing line replay tab. */
export const compatKey = (laps, ref) => `${laps.slice(0, MAX_LAPS).join(',')}|${String(ref)}`;
export const compatAccepted = (key) => accepted.has(key);
export const acceptCompat = (key) => { accepted.add(key); };

// ---------------------------------------------------------------- comparison compatibility (src/compat.js, PL4.2)
// compatible: one quiet line; caveats: a closed list, each caveat with what it changes; incompatible: the analysis
// waits behind "Compare anyway". The charts only use readings checked against the game (data.compat.basis).
export function compatHtml(data, lapTxt, gated) {
  const laps = data.laps.filter((l) => l.compat);
  if (!laps.length) return '';
  const level = data.compat?.level || 'compatible';
  const shaky = (data.compat?.basis || []).filter((b) => b.id !== 'gforce' && b.status !== 'verified');
  const many = laps.length > 1;
  // readings only "not confirmed yet" (D-PL4-12): one combined line with where to confirm them, not one caveat each
  const unconf = [...new Set(laps.flatMap((l) => l.compat.items.filter((i) => i.unconfirmed).map((i) => i.unconfirmed)))];
  const UNCONF = 'Some readings aren\'t confirmed yet';
  const unconfLine = unconf.length ? `<p class="compat-unconf"><b>${UNCONF}:</b> ${esc(unconf.join(', '))}. Until they are, they never count as the same. <a href="#/setups">Confirm them in Setups → Setup recognition</a></p>` : '';
  const shown = (l) => l.compat.items.filter((i) => !i.unconfirmed);
  const list = laps.filter((l) => shown(l).length).map((l) => `${many ? `<li class="grp">${esc(lapTxt(l.id))}</li>` : ''}${shown(l).map((it) => `<li class="compat-item ${it.level}">
      <b>${esc(it.title)}</b> <span>${esc(it.detail)}</span><div class="compat-effect"><span class="muted">What it changes:</span> ${esc(it.effect)}</div></li>`).join('')}`).join('');
  const basis = `<p class="hint compat-basis">The charts use ${(data.compat?.basis || []).filter((b) => b.id !== 'gforce').map((b) => `${esc(b.use.toLowerCase())} ${prov(b.status)}`).join(', ')}.${shaky.length ? ' Some of these are not checked against the game: read the charts as a hint.' : ''}</p>`;
  if (level === 'compatible') {
    const m = laps[0].compat.matched;
    return `<div class="card compat compat-ok"><span class="compat-tag ok">Like for like</span> <span class="hint">Same ${esc(m.join(', '))}.</span>${shaky.length ? basis : ''}</div>`;
  }
  const titles = [...new Set(laps.flatMap((l) => shown(l).map((i) => i.title))), ...(unconf.length ? [UNCONF] : [])];
  if (level === 'incompatible') {
    return `<div class="card compat compat-bad" ${gated ? 'role="alert"' : ''}><div class="row"><span class="compat-tag bad">Not comparable</span>
      <b>${gated ? 'These laps cannot be compared like for like' : 'Compared anyway: these laps are not like for like'}</b></div>
      ${list ? `<ul class="compat-list">${list}</ul>` : ''}${unconfLine}${basis}
      ${gated ? '<div class="row"><button class="primary" data-force>Compare anyway</button><span class="hint">The charts will show, but the gap and corner times do not mean what they usually do.</span></div>' : ''}</div>`;
  }
  return `<details class="card compat compat-warn"><summary><span class="compat-tag warn">Compare with care</span>
    <span class="hint">${titles.length} thing${titles.length === 1 ? '' : 's'} to keep in mind: ${esc(titles.join(' · '))}</span></summary>
    ${list ? `<ul class="compat-list">${list}</ul>` : ''}${unconfLine}${basis}</details>`;
}
let choicesCache = null; // { at, laps }

export async function getCompare(laps, ref) {
  const key = `${laps.join(',')}|${ref}`;
  if (!dataCache.has(key)) {
    dataCache.set(key, await api(`/api/compare?laps=${laps.join(',')}&ref=${ref}`));
    if (dataCache.size > 6) dataCache.delete(dataCache.keys().next().value);
  }
  return dataCache.get(key);
}
export function forgetCompare() { dataCache.clear(); choicesCache = null; }
// every lap of this car and track, for the pickers
async function lapsOfCombo(combo) {
  if (!choicesCache || Date.now() - choicesCache.at > 15000) choicesCache = { at: Date.now(), laps: (await api('/api/overview')).laps };
  return choicesCache.laps.filter((l) => l.track === combo.track && l.layout === combo.layout && l.car === combo.car);
}
const when = (t) => new Date(t).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

// opts: { laps: [lapId…], ref: 'ideal'|'best'|lapId, corner: name|null, sessionId, hasKey, onState(state), onError(msg) }
export async function mountTelemetry(root, opts, cleanup) {
  const st = { laps: opts.laps.slice(0, MAX_LAPS), ref: String(opts.ref || 'ideal'), corner: opts.corner || null };
  let own = []; // this render's cleanups (charts, listeners)
  const teardown = () => { own.forEach((f) => f()); own = []; };
  cleanup.push(teardown);
  const q = (s) => root.querySelector(s);
  const changed = () => { opts.onState?.({ ...st }); draw(); };

  async function draw() {
    teardown();
    let data;
    try { data = await getCompare(st.laps, st.ref); } catch (e) {
      if (st.ref === 'ideal') { st.ref = 'best'; return draw(); } // no ideal lap yet: against the best
      root.innerHTML = `<div class="card error">Could not load the telemetry: ${esc(e.message)}</div>`; return;
    }
    const choices = await lapsOfCombo(data.combo);
    const laps = data.laps; // the reference itself is left out by the server
    const d = data.ref.trace.d;
    const corners = [...data.corners].sort((a, b) => a.start - b.start);
    const ci = corners.findIndex((c) => c.name === st.corner);
    const sel = ci >= 0 ? corners[ci] : null;
    if (!sel) st.corner = null;
    const lap0 = laps[0];
    // a chart that can't be drawn for these laps: why (shown as the checkbox's tooltip)
    const chartOff = (k) => ((k === 'gap' || k === 'line') && !laps.length ? 'Add a lap to compare with the reference'
      : k === 'rpm' && !data.ref.trace.rpm ? 'No RPM recorded for these laps' : '');
    const layer = lap0 ? mapLayer : 'inputs'; // without a lap to compare there is no time to colour
    const lossOf = (lap, a, b) => lap.delta[idxAt(lap.trace.d, b)] - lap.delta[idxAt(lap.trace.d, a)];
    const sessOf = (id) => choices.find((l) => l.id === id)?.session_id;
    const homeSession = opts.sessionId ?? sessOf(st.laps[0]);

    // ---------------- lap picker
    const lapTxt = (id) => { const l = choices.find((x) => x.id === id); return l ? `Lap ${l.lap_number ?? '?'} · ${fmt(l.lap_time_ms)}` : `Lap #${id}`; };
    const chip = (i, label, text, badges, removable) => `<div class="tchip" data-chip="${i}" role="button" tabindex="0">
      <i style="background:${color(i)}"></i><div><span class="l">${label}</span><span class="t">${text}</span> ${badges}</div>
      ${removable ? `<button class="small ghost tx" data-rm="${i}" title="Remove this lap" aria-label="Remove this lap">✕</button>` : '<span class="dd">▾</span>'}</div>`;
    const lapBadges = (id) => {
      const l = choices.find((x) => x.id === id);
      if (!l) return '';
      const sess = choices.filter((x) => x.session_id === l.session_id && x.valid);
      const best = sess.reduce((a, b) => (!a || b.lap_time_ms < a.lap_time_ms ? b : a), null);
      return (best?.id === id ? '<span class="badge pb">Session best</span>' : '') + (l.valid ? '' : '<span class="badge bad">Invalid</span>')
        + (l.session_id !== homeSession ? `<span class="badge">${esc(when(l.recorded_at))}</span>` : '');
    };
    const refText = `${esc(data.ref.label)} · ${fmt(data.ref.lapTimeMs)}`;
    // not comparable (another car or layout): the analysis waits until the driver says so (PL4.2)
    const cmpKey = compatKey(st.laps, st.ref);
    const gated = data.compat?.level === 'incompatible' && !accepted.has(cmpKey);
    root.innerHTML = `
      <div class="card tele-pick">
        ${st.laps.map((id, i) => chip(i + 1, i ? 'Also' : 'Your lap', lapTxt(id), lapBadges(id), i > 0)).join('')}
        <span class="vs">vs</span>
        ${chip(0, 'Reference', refText, '', false)}
        ${st.laps.length < MAX_LAPS ? '<button class="add" data-add>+ Add a lap</button>' : ''}
        <span class="spacer"></span>
        <span class="hint" title="Steps your lap through the laps of its session">← → next lap</span>
        <div class="tmenu" hidden></div>
      </div>
      ${!laps.length ? '<div class="card muted">This lap is the reference itself. Choose another reference, such as the ideal lap, to see where time goes.</div>' : ''}
      ${compatHtml(data, lapTxt, gated)}${gated ? '' : `
      ${lap0 ? `<div class="card tele-bar"><div class="row" style="margin-bottom:8px"><b>Where the time went</b>
        <span class="hint">${esc(lapTxt(st.laps[0]))} against ${esc(data.ref.label.toLowerCase())}, corner by corner · click a corner to zoom</span>
        <span class="spacer"></span><b class="${gapClass(lap0.delta[lap0.delta.length - 1] * 1000)}">${fmtGap(lap0.delta[lap0.delta.length - 1] * 1000)}</b></div>
        <div class="cbar"></div></div>` : ''}
      <div class="tele-grid">
        <div class="tele-side">
          <div class="card tele-map"><div class="row"><b>Track</b>
            <span class="seg" role="group" aria-label="Colour the map by" style="margin-left:8px">
              <button class="small${layer === 'time' ? ' on' : ''}" data-layer="time" ${lap0 ? 'title="Where your lap gains or loses time against the reference"' : 'disabled title="Add a lap to compare with the reference"'}>Time</button>
              <button class="small${layer === 'inputs' ? ' on' : ''}" data-layer="inputs" title="Where ${lap0 ? 'your lap' : 'the reference'} brakes, coasts and is on the throttle">Inputs</button></span>
            <span class="spacer"></span>
            ${sel ? '<button class="small ghost" data-whole>Whole lap</button>' : ''}
            ${data.band?.ideal ? `<label class="map-toggle" title="The game's own ideal line (the line the AI follows)"><input type="checkbox" data-racing ${racingLine ? 'checked' : ''}> Ideal line</label>` : ''}
            <span class="seg map-zoom" role="group" aria-label="Map zoom"><button class="small" data-zoom="-1" title="Zoom out">−</button><span class="zlvl"></span><button class="small" data-zoom="1" title="Zoom in: the map follows the car">+</button></span></div>
            <div class="hint map-legend">${layer === 'inputs' ? INPUTS.map((s) => `<i class="sw" style="background:var(${s.v})"></i>${s.label}`).join(' ')
              : lap0 ? '<i class="sw" style="background:var(--slower)"></i>losing <i class="sw" style="background:var(--faster)"></i>gaining' : ''}</div>
            <canvas></canvas></div>
          <div class="card tele-corner"></div>
        </div>
        <div class="card tele-charts"><div class="row tpick"><b>Telemetry</b>
          ${Object.entries(CHARTS).map(([k, v]) => { const why = chartOff(k); return `<label class="tcheck"${why ? ` title="${why}"` : ''}><input type="checkbox" data-chart="${k}" ${shown.has(k) && !why ? 'checked' : ''} ${why ? 'disabled' : ''}>${v}</label>`; }).join('')}</div>
          <div class="hint" style="margin-bottom:4px">hover to move the cursor and the cars on the map · drag to zoom · double-click for the whole lap</div>
          <div class="tcharts"></div></div>
      </div>
      ${opts.hasKey !== undefined && lap0 ? '<div class="card tele-ai"></div>' : ''}`}`;

    // menus: replace a lap, add one, or change the reference
    const menu = q('.tmenu');
    const openMenu = (anchor, items, onPick) => {
      menu.innerHTML = items;
      menu.hidden = false;
      menu.style.left = `${anchor.offsetLeft}px`; menu.style.top = `${anchor.offsetTop + anchor.offsetHeight + 4}px`;
      menu.querySelectorAll('[data-v]').forEach((b) => b.onclick = (e) => { e.stopPropagation(); menu.hidden = true; onPick(b.dataset.v); });
    };
    const lapItems = (exclude) => {
      const groups = new Map();
      for (const l of [...choices].sort((a, b) => a.recorded_at - b.recorded_at)) {
        const g = l.source === 'import' ? 'import' : l.session_id;
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(l);
      }
      const order = [...groups.keys()].sort((a, b) => (a === homeSession ? -1 : b === homeSession ? 1 : (groups.get(b)[0].recorded_at - groups.get(a)[0].recorded_at)));
      return order.map((g) => {
        const ls = groups.get(g);
        const best = ls.filter((l) => l.valid).reduce((a, b) => (!a || b.lap_time_ms < a.lap_time_ms ? b : a), null);
        const title = g === 'import' ? 'Imported laps' : g === homeSession ? 'This session' : when(ls[0].recorded_at);
        return `<div class="grp">${esc(title)}</div>` + ls.map((l) => `<button class="it${exclude.includes(l.id) ? ' on' : ''}" data-v="${l.id}">
          <span class="muted">${l.lap_number ?? ''}</span><span class="${l.valid ? '' : 'inv'}">${fmt(l.lap_time_ms)}</span>
          <span class="${best && l.id !== best.id ? 'pos' : ''}">${best && l.id !== best.id ? fmtGap(l.lap_time_ms - best.lap_time_ms) : best ? '<span class="badge pb">best</span>' : ''}</span></button>`).join('');
      }).join('');
    };
    root.querySelectorAll('[data-chip]').forEach((c) => {
      const i = +c.dataset.chip;
      const open = (e) => {
        if (e.target.closest('[data-rm]')) return;
        e.stopPropagation();
        if (!menu.hidden && menu.dataset.for === String(i)) { menu.hidden = true; return; }
        menu.dataset.for = String(i);
        if (i === 0) {
          openMenu(c, `<div class="grp">References</div>
            ${data.idealMs ? `<button class="it" data-v="ideal"><span>★</span><span>Ideal lap</span><span>${fmt(data.idealMs)}</span></button>` : ''}
            <button class="it" data-v="best"><span>★</span><span>All-time best</span><span>${fmt(data.bestMs)}</span></button>${lapItems([])}`,
          (v) => { st.ref = v; changed(); });
        } else {
          openMenu(c, lapItems(st.laps), (v) => { const id = +v; if (!st.laps.includes(id)) { st.laps[i - 1] = id; changed(); } });
        }
      };
      c.onclick = open;
      c.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(e); } };
    });
    root.querySelectorAll('[data-rm]').forEach((b) => b.onclick = (e) => { e.stopPropagation(); st.laps.splice(+b.dataset.rm - 1, 1); changed(); });
    const add = q('[data-add]');
    if (add) add.onclick = (e) => { e.stopPropagation(); menu.dataset.for = 'add'; openMenu(add, lapItems(st.laps), (v) => { const id = +v; if (!st.laps.includes(id)) { st.laps.push(id); changed(); } }); };
    const closeMenu = (e) => { if (!menu.contains(e.target)) menu.hidden = true; };
    document.addEventListener('click', closeMenu);
    // ← → : your lap steps through the laps of its session
    const onKey = (e) => {
      if (e.target.closest('input, select, textarea') || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || !root.isConnected || root.offsetParent === null) return;
      const s = sessOf(st.laps[0]);
      const ls = choices.filter((l) => l.session_id === s).sort((a, b) => a.recorded_at - b.recorded_at);
      const k = ls.findIndex((l) => l.id === st.laps[0]) + (e.key === 'ArrowRight' ? 1 : -1);
      if (k < 0 || k >= ls.length) return;
      e.preventDefault(); st.laps[0] = ls[k].id; changed();
    };
    document.addEventListener('keydown', onKey);
    own.push(() => { document.removeEventListener('click', closeMenu); document.removeEventListener('keydown', onKey); });
    if (gated) { q('[data-force]').onclick = () => { accepted.add(cmpKey); draw(); }; return; }

    const select = (name) => { st.corner = name; changed(); };
    q('[data-whole]')?.addEventListener('click', () => select(null));
    root.querySelectorAll('[data-layer]').forEach((b) => b.addEventListener('click', () => {
      mapLayer = b.dataset.layer;
      try { localStorage.setItem('tele.mapLayer', mapLayer); } catch { /* not remembered */ }
      draw();
    }));

    // ---------------- where the time went: corners and the straights between them
    if (lap0) {
      const segs = [];
      let at = 0;
      for (const c of corners) {
        if (c.start > at + 1) segs.push({ a: at, b: c.start });
        segs.push({ a: Math.max(at, c.start), b: c.end, c });
        at = Math.max(at, c.end);
      }
      if (d[d.length - 1] > at + 1) segs.push({ a: at, b: d[d.length - 1] });
      const maxL = Math.max(0.05, ...segs.filter((s) => s.c).map((s) => Math.abs(lossOf(lap0, s.a, s.b))));
      q('.cbar').innerHTML = segs.map((s) => {
        const l = lossOf(lap0, s.a, s.b);
        if (!s.c) return `<div class="cseg str" style="flex:${s.b - s.a}" title="Straight ${Math.round(s.a)}–${Math.round(s.b)} m: ${fmtGap(l * 1000)}">${Math.abs(l) >= 0.02 ? `<small>${fmtGap(l * 1000, 2)}</small>` : ''}</div>`;
        const a = Math.min(1, Math.abs(l) / maxL);
        const bg = Math.abs(l) < 0.005 ? 'var(--surface-3)' : `color-mix(in srgb, ${l > 0 ? 'var(--slower)' : 'var(--faster)'} ${Math.round(18 + 72 * a)}%, var(--surface-1))`;
        return `<button class="cseg${s.c === sel ? ' sel' : ''}" data-corner="${esc(s.c.name)}" style="flex:${Math.max(s.b - s.a, 40)};background:${bg};color:${a > 0.55 ? '#fff' : 'var(--text-primary)'}"
          title="${esc(s.c.name)}: ${fmtGap(l * 1000)}"><b>${esc(s.c.name)}</b><span>${fmtGap(l * 1000)}</span></button>`;
      }).join('');
      root.querySelectorAll('.cbar [data-corner]').forEach((b) => b.onclick = () => select(b.dataset.corner === st.corner ? null : b.dataset.corner));
    }

    // ---------------- the selected corner, or the biggest losses
    const box = q('.tele-corner');
    if (!lap0) box.hidden = true;
    else if (!sel) {
      const ranked = corners.map((c) => ({ c, l: lossOf(lap0, c.start, c.end) })).sort((a, b) => b.l - a.l);
      box.innerHTML = `<b>Biggest losses</b><div class="hint" style="margin-bottom:6px">click one, or a corner on the bar or the map</div>
        ${ranked.slice(0, 3).map(({ c, l }) => `<button class="loss-row" data-corner="${esc(c.name)}"><b>${esc(c.name)}</b><span class="${gapClass(l * 1000)}">${fmtGap(l * 1000)}</span><span class="hint">${esc(cornerHeadline(lap0.corners[data.corners.indexOf(c)], data.ref.corners[data.corners.indexOf(c)]))}</span></button>`).join('')}`;
      box.querySelectorAll('[data-corner]').forEach((b) => b.onclick = () => select(b.dataset.corner));
    } else {
      const k = data.corners.indexOf(sel);
      const m = lap0.corners[k], r = data.ref.corners[k], l = lossOf(lap0, sel.start, sel.end);
      const notes = cornerNotes(m, r);
      const replayAt = Math.max(0, (r.brakePoint ?? r.liftPoint ?? sel.start) - 60);
      box.innerHTML = `<div class="row"><h3 style="margin:0">${esc(sel.name)} · <span class="${gapClass(l * 1000)}">${fmtGap(l * 1000)}</span></h3><span class="spacer"></span>
          <a class="hint" href="#/compare?laps=${st.laps.join(',')}&ref=${st.ref}&tab=line&at=${replayAt}" title="Watch both cars through this corner">Replay ▶</a></div>
        <div class="hint">apex at ${sel.apex} m${laps.length > 1 ? `, ${esc(lapTxt(st.laps[0]))}` : ''}</div>
        <ul class="cnotes">${notes.items.map(([tag, txt]) => `<li><span class="tag">${tag}</span>${txt}</li>`).join('') || '<li class="muted">Same as the reference.</li>'}</ul>
        <div class="ctry"><b>Try:</b> ${esc(notes.tip(l))}</div>
        <div class="row" style="margin-top:10px">
          <button class="small" data-step="-1" ${ci > 0 ? '' : 'disabled'}>◀ ${ci > 0 ? esc(corners[ci - 1].name) : ''}</button>
          <button class="small" data-step="1" ${ci < corners.length - 1 ? '' : 'disabled'}>${ci < corners.length - 1 ? esc(corners[ci + 1].name) : ''} ▶</button>
          <span class="spacer"></span><button class="small ghost" data-whole2>Whole lap</button></div>`;
      box.querySelectorAll('[data-step]').forEach((b) => b.onclick = () => select(corners[ci + +b.dataset.step].name));
      box.querySelector('[data-whole2]').onclick = () => select(null);
    }

    // ---------------- track map (zoomed to the selected corner, with both lines)
    const canvas = q('.tele-map canvas');
    const mirror = getMirror();
    const all = [data.ref, ...laps];
    const base = document.createElement('canvas');
    let P = null, cursorIdx = null, view = null; // view: [i0, i1] of the zoomed part
    const carLayer = document.createElement('canvas');
    const carAlpha = (n) => Math.min(0.8, 0.5 + 0.1 * (n - 1)); // 1 car 50 %, +10 % per extra car, at most 80 %
    let carIdx = 0; // where the car is shown: the cursor, or where it last was (start line at first)
    const follow = all[Math.min(1, all.length - 1)].trace; // the car the zoomed map follows: your lap, else the reference
    let baseQueued = false;
    const redrawSoon = () => { if (baseQueued) return; baseQueued = true; requestAnimationFrame(() => { baseQueued = false; drawBase(); }); };
    const zoomShow = () => {
      q('.map-zoom .zlvl').textContent = `${mapZoom}×`;
      q('[data-zoom="-1"]').disabled = mapZoom === MAP_ZOOMS[0]; q('[data-zoom="1"]').disabled = mapZoom === MAP_ZOOMS[MAP_ZOOMS.length - 1];
    };
    root.querySelectorAll('[data-zoom]').forEach((b) => b.addEventListener('click', () => {
      const i = Math.max(0, Math.min(MAP_ZOOMS.length - 1, MAP_ZOOMS.indexOf(mapZoom) + +b.dataset.zoom));
      mapZoom = MAP_ZOOMS[i];
      try { localStorage.setItem('tele.mapZoom', String(mapZoom)); } catch { /* not remembered */ }
      zoomShow(); drawBase();
    }));
    root.querySelector('[data-racing]')?.addEventListener('change', (e) => {
      racingLine = e.target.checked;
      try { localStorage.setItem('tele.racingLine', racingLine ? '1' : '0'); } catch { /* not remembered */ }
      drawBase();
    });
    zoomShow();
    function drawBase() {
      const dpr = window.devicePixelRatio || 1;
      const W = canvas.clientWidth, H = canvas.clientHeight;
      if (!W || !H) return;
      canvas.width = base.width = W * dpr; canvas.height = base.height = H * dpr;
      const ctx = base.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
      const { x, z } = data.ref.trace;
      view = sel ? [idxAt(d, Math.max(0, sel.start - 60)), idxAt(d, Math.min(d[d.length - 1], sel.end + 60))] : null;
      const P0 = view ? fitProjection(x.slice(view[0], view[1] + 1), z.slice(view[0], view[1] + 1), W, H, 30, mirror) : fitProjection(x, z, W, H, 22, mirror);
      if (mapZoom > 1) { // centred on the car
        const [fx, fy] = P0(follow.x[carIdx], follow.z[carIdx]);
        P = (a, b) => { const [u, v] = P0(a, b); return [(u - fx) * mapZoom + W / 2, (v - fy) * mapZoom + H / 2]; };
      } else P = P0;
      const zoomK = (view ? 2.2 : 1) * Math.sqrt(mapZoom);
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      const band = data.band;
      if (band?.source?.left === 'track') {
        ctx.fillStyle = css('--grid'); ctx.beginPath();
        band.left.x.forEach((bx, i) => { const [px, py] = P(bx, band.left.z[i]); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
        ctx.closePath();
        for (let i = band.right.x.length - 1; i >= 0; i--) { const [px, py] = P(band.right.x[i], band.right.z[i]); i === band.right.x.length - 1 ? ctx.moveTo(px, py) : ctx.lineTo(px, py); }
        ctx.closePath(); ctx.fill('evenodd');
        // the track edges, a little darker so the road stands out
        ctx.strokeStyle = css('--track-edge'); ctx.lineWidth = 1.6;
        for (const e of [band.left, band.right]) { ctx.beginPath(); e.x.forEach((bx, i) => { const [px, py] = P(bx, e.z[i]); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }); ctx.closePath(); ctx.stroke(); }
      }
      ctx.strokeStyle = css('--axis'); ctx.lineWidth = 9 * zoomK;
      ctx.beginPath(); for (let i = 0; i < x.length; i++) { const [px, py] = P(x[i], z[i]); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); } ctx.stroke();
      // gaining / losing along the lap
      const step = d[1] - d[0];
      const k = Math.max(1, Math.round(10 / step));
      if (layer === 'inputs') {
        // brake / coast / throttle of your lap (or the reference), one run of the same state at a time
        const L = (lap0 || data.ref).trace, cols = INPUTS.map((s) => css(s.v));
        ctx.lineWidth = 5 * zoomK; ctx.globalAlpha = view ? 0.55 : 1;
        for (let i = 0; i < x.length - 1;) {
          const s = inputState(L, i);
          let j = i + 1; while (j < x.length - 1 && inputState(L, j) === s) j++;
          ctx.strokeStyle = cols[s];
          ctx.beginPath(); for (let qq = i; qq <= j; qq++) { const [px, py] = P(L.x[qq], L.z[qq]); qq === i ? ctx.moveTo(px, py) : ctx.lineTo(px, py); } ctx.stroke();
          i = j;
        }
        ctx.globalAlpha = 1;
      } else if (lap0) {
        const raw = []; for (let i = 0; i + k < x.length; i += k) raw.push(lap0.delta[i + k] - lap0.delta[i]);
        const slopes = raw.map((_, j) => { let s = 0, c = 0; for (let qq = Math.max(0, j - 4); qq <= Math.min(raw.length - 1, j + 4); qq++) { s += raw[qq]; c++; } return s / c; });
        const sorted = slopes.map(Math.abs).sort((a, b) => a - b);
        const scale = Math.max(0.01, sorted[Math.floor(sorted.length * 0.95)] || 0.01);
        const rgb = (h) => { const n = parseInt(h.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
        const cF = rgb(css('--faster')), cS = rgb(css('--slower')), cN = rgb(css('--neutral'));
        const mix = (a, b, t) => `rgb(${a.map((v, j) => Math.round(v + (b[j] - v) * t)).join(',')})`;
        ctx.lineWidth = 5 * zoomK; ctx.globalAlpha = view ? 0.45 : 1;
        for (let j = 0, i = 0; i + k < x.length; i += k, j++) {
          const v = Math.max(-1, Math.min(1, slopes[j] / scale));
          ctx.strokeStyle = v >= 0 ? mix(cN, cS, v) : mix(cN, cF, -v);
          ctx.beginPath(); for (let qq = i; qq <= i + k; qq++) { const [px, py] = P(x[qq], z[qq]); qq === i ? ctx.moveTo(px, py) : ctx.lineTo(px, py); } ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
      // zoomed: the driven lines, reference and laps
      if (view) {
        all.forEach((L, li) => {
          ctx.strokeStyle = color(li); ctx.lineWidth = 2;
          ctx.beginPath(); for (let i = view[0]; i <= view[1]; i++) { const [px, py] = P(L.trace.x[i], L.trace.z[i]); i === view[0] ? ctx.moveTo(px, py) : ctx.lineTo(px, py); } ctx.stroke();
        });
        // brake points of the reference and your lap
        all.forEach((L, li) => {
          const bp = (li ? laps[li - 1].corners : data.ref.corners)[data.corners.indexOf(sel)]?.brakePoint;
          if (bp == null) return;
          const i = idxAt(d, bp); const [px, py] = P(L.trace.x[i], L.trace.z[i]);
          ctx.fillStyle = color(li); ctx.fillRect(px - 4, py - 4, 8, 8);
        });
      }
      if (racingLine && band?.ideal) { // the game's racing line, dashed, over the laps
        ctx.save(); ctx.strokeStyle = css('--racing-line'); ctx.lineWidth = 1.8; ctx.setLineDash([6, 5]);
        ctx.beginPath(); band.ideal.x.forEach((bx, i) => { const [px, py] = P(bx, band.ideal.z[i]); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }); ctx.closePath(); ctx.stroke();
        ctx.restore();
      }
      // start/finish and corner labels
      const [sx, sy] = P(x[0], z[0]);
      ctx.fillStyle = css('--text-primary'); ctx.fillRect(sx - 4, sy - 4, 8, 8);
      ctx.font = '600 11px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (const c of data.corners) {
        const i = idxAt(d, c.apex);
        const [px, py] = P(x[i], z[i]);
        const cx = W / 2, cy = H / 2, dx = px - cx, dy = py - cy, len = Math.hypot(dx, dy) || 1;
        const lx = px + (dx / len) * (view ? 30 : 16), ly = py + (dy / len) * (view ? 30 : 16);
        const on = c === sel;
        ctx.fillStyle = on ? css('--text-primary') : css('--surface-2'); ctx.beginPath(); ctx.arc(lx, ly, 11, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = on ? css('--surface-1') : css('--text-secondary'); ctx.fillText(c.name, lx, ly);
      }
      paint();
    }
    function paint() {
      const ctx = canvas.getContext('2d');
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.drawImage(base, 0, 0);
      if (!P) return;
      const dpr = window.devicePixelRatio || 1; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const size = Math.min(1.8, Math.sqrt(mapZoom) * (view ? 1.3 : 1));
      // each car drawn solid on its own layer, then laid over the map see-through (details and all), so a car under
      // another still shows. More cars: each a bit more opaque, so every one stays easy to pick out.
      if (carLayer.width !== canvas.width || carLayer.height !== canvas.height) { carLayer.width = canvas.width; carLayer.height = canvas.height; }
      const lc = carLayer.getContext('2d');
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = carAlpha(all.length);
      for (let li = all.length - 1; li >= 0; li--) { // the reference first, so your laps' cars sit on top
        lc.setTransform(1, 0, 0, 1, 0, 0); lc.clearRect(0, 0, carLayer.width, carLayer.height); lc.setTransform(dpr, 0, 0, dpr, 0, 0);
        drawCar(lc, all[li].trace, carIdx, color(li), size);
        ctx.drawImage(carLayer, 0, 0);
      }
      ctx.globalAlpha = 1;
    }
    // a top-down closed-wheel race car (prototype shape) pointing along the lap, see-through so the lines under it show
    function drawCar(ctx, t, i, fill, k) {
      const n = t.x.length, a = Math.max(0, Math.min(n - 4, i - 2)), b = Math.min(n - 1, a + 4);
      const [px, py] = P(t.x[i], t.z[i]), [ax, ay] = P(t.x[a], t.z[a]), [bx, by] = P(t.x[b], t.z[b]);
      const L = 26 * k, Wd = 12 * k;
      ctx.save(); ctx.translate(px, py); ctx.rotate(Math.atan2(by - ay, bx - ax)); ctx.scale(L, Wd);
      // body, nose to tail (x: -0.5 rear … 0.5 nose, y: ±0.5): splitter, front wheel arch, sidepod, rear wheel arch, diffuser
      const half = [[0.5, 0.26], [0.47, 0.38], [0.4, 0.47], [0.24, 0.48], [0.16, 0.37], [0.0, 0.36], [-0.12, 0.42], [-0.18, 0.48], [-0.38, 0.48], [-0.46, 0.4]];
      ctx.beginPath(); ctx.moveTo(0.5, 0);
      for (const [x, y] of half) ctx.lineTo(x, y);
      for (let j = half.length - 1; j >= 0; j--) ctx.lineTo(half[j][0], -half[j][1]);
      ctx.closePath();
      ctx.lineJoin = 'round';
      ctx.fillStyle = fill; ctx.fill();
      ctx.save(); ctx.scale(1 / L, 1 / Wd); ctx.lineWidth = 1.4; ctx.strokeStyle = css('--surface-1'); ctx.stroke(); ctx.restore(); // an even outline
      ctx.fillStyle = 'rgba(0,0,0,.35)'; // shading over the wheel arches
      for (const ax of [0.32, -0.28]) for (const s of [-1, 1]) { ctx.beginPath(); ctx.ellipse(ax, s * 0.4, 0.09, 0.06, 0, 0, Math.PI * 2); ctx.fill(); }
      ctx.fillStyle = 'rgba(0,0,0,.5)';
      ctx.fillRect(-0.4, -0.04, 0.32, 0.08); // engine cover fin
      ctx.beginPath(); ctx.moveTo(0.24, 0); ctx.quadraticCurveTo(0.2, 0.17, 0.0, 0.16); ctx.lineTo(-0.1, 0.1); ctx.lineTo(-0.1, -0.1); ctx.lineTo(0.0, -0.16); ctx.quadraticCurveTo(0.2, -0.17, 0.24, 0); ctx.fill(); // canopy
      ctx.fillStyle = 'rgba(255,255,255,.4)'; // windscreen glint
      ctx.beginPath(); ctx.moveTo(0.2, -0.08); ctx.quadraticCurveTo(0.22, 0, 0.2, 0.08); ctx.lineTo(0.15, 0.07); ctx.quadraticCurveTo(0.17, 0, 0.15, -0.07); ctx.fill();
      ctx.fillStyle = 'rgba(0,0,0,.65)'; ctx.fillRect(-0.53, -0.52, 0.08, 1.04); // rear wing
      ctx.fillStyle = fill; ctx.fillRect(-0.55, -0.52, 0.03, 0.06); ctx.fillRect(-0.55, 0.46, 0.03, 0.06); // wing end plates
      ctx.restore();
    }
    // map → cursor: the nearest point of the reference line; a click picks the corner there
    const nearest = (e) => {
      if (!P) return null;
      const r = canvas.getBoundingClientRect(); const mx = e.clientX - r.left, my = e.clientY - r.top;
      const { x, z } = data.ref.trace;
      let best = null, bd = 30 * 30;
      const [i0, i1] = view || [0, x.length - 1];
      for (let i = i0; i <= i1; i++) { const [px, py] = P(x[i], z[i]); const dd = (px - mx) ** 2 + (py - my) ** 2; if (dd < bd) { bd = dd; best = i; } }
      return best;
    };
    // zoomed in, the map follows the car, so hovering it would chase itself: the charts move the car then
    canvas.onmousemove = (e) => { if (mapZoom > 1) { canvas.style.cursor = nearest(e) == null ? '' : 'pointer'; return; } const i = nearest(e); canvas.style.cursor = i == null ? '' : 'pointer'; if (i != null) setCursor(i, true); };
    canvas.onmouseleave = () => setCursor(null, true);
    canvas.onclick = (e) => {
      const i = nearest(e); if (i == null) return;
      const c = corners.find((cc) => d[i] >= cc.start - 20 && d[i] <= cc.end + 20);
      if (c && c !== sel) select(c.name);
    };

    // ---------------- charts (uPlot): one cursor, one zoom
    const charts = [];
    let syncing = false, fromMap = false;
    const holder = q('.tcharts');
    const name = (i) => (i === 0 ? 'Ref' : laps.length > 1 ? `Lap ${laps[i - 1].meta.lap_number ?? i}` : 'You');
    const axisStyle = () => ({ stroke: css('--text-muted'), grid: { stroke: css('--grid'), width: 1 }, ticks: { stroke: css('--grid') }, font: '11px system-ui' });
    const marks = (labels) => ({ hooks: { draw: (u) => {
      const ctx = u.ctx; ctx.save();
      const top = u.bbox.top, bot = u.bbox.top + u.bbox.height;
      if (sel) { const a = u.valToPos(sel.start, 'x', true), b = u.valToPos(sel.end, 'x', true); ctx.fillStyle = 'rgba(127,127,127,0.08)'; ctx.fillRect(a, top, b - a, bot - top); }
      ctx.strokeStyle = css('--axis'); ctx.setLineDash([3, 4]); ctx.lineWidth = 1;
      ctx.fillStyle = css('--text-muted'); ctx.font = `${11 * devicePixelRatio}px system-ui`; ctx.textAlign = 'center';
      for (const c of data.corners) {
        const px = u.valToPos(c.apex, 'x', true);
        if (px < u.bbox.left || px > u.bbox.left + u.bbox.width) continue;
        ctx.beginPath(); ctx.moveTo(px, top); ctx.lineTo(px, bot); ctx.stroke();
        if (labels) ctx.fillText(c.name, px, top + 12 * devicePixelRatio);
      }
      ctx.restore();
    } } });
    const width = () => Math.max(300, holder.clientWidth);
    const xRange = sel ? [Math.max(0, sel.start - 60), Math.min(d[d.length - 1], sel.end + 60)] : null;
    function chart(title, series, values, { height = 120, range, stepped = false, labels = false, fmtV = (v) => v } = {}) {
      const el = document.createElement('div'); el.className = 'tchart';
      el.innerHTML = `<div class="chart-title">${title}</div>`;
      holder.appendChild(el);
      const u = new uPlot({
        width: width(), height, plugins: [marks(labels)],
        cursor: { sync: { key: `tele${mountId}` }, drag: { x: true, y: false }, points: { size: 6 } },
        scales: { x: { time: false, ...(xRange ? { min: xRange[0], max: xRange[1] } : {}) }, y: range ? { range } : {} },
        legend: { live: true },
        axes: [{ ...axisStyle(), values: (uu, vals) => vals.map((v) => `${v} m`) }, { ...axisStyle(), size: 46, values: (uu, vals) => vals.map(fmtV) }],
        series: [{ label: 'At', value: (uu, v) => (v == null ? '–' : `${Math.round(v)} m`) }, ...series.map((s) => ({
          width: 1.5, value: (uu, v) => (v == null ? '–' : fmtV(v)), ...(stepped ? { paths: uPlot.paths.stepped({ align: 1 }) } : {}), ...s }))],
        hooks: {
          setScale: [(uu, key) => {
            if (key !== 'x' || syncing) return;
            syncing = true; for (const c of charts) if (c !== uu) c.setScale('x', { min: uu.scales.x.min, max: uu.scales.x.max }); syncing = false;
          }],
          setCursor: [(uu) => { if (fromMap) return; const i = uu.cursor.idx; if (i !== cursorIdx) moveCar(i); }],
        },
      }, [d, ...values], el);
      if (xRange) u.setScale('x', { min: xRange[0], max: xRange[1] });
      charts.push(u);
      return u;
    }
    const lapSeries = (label = name) => all.map((_, i) => ({ label: label(i), stroke: color(i), width: i ? 1.8 : 1.5 }));
    if (shown.has('gap') && laps.length) {
      chart('Gap to reference <span>s · rising = losing time</span>', [{ label: 'Ref', stroke: css('--axis'), width: 1 }, ...laps.map((l, i) => ({ label: name(i + 1), stroke: color(i + 1), width: 2.2 }))],
        [d.map(() => 0), ...laps.map((l) => l.delta)], { height: 140, labels: true, fmtV: (v) => `${v > 0 ? '+' : ''}${(+v).toFixed(2)}` });
    }
    if (shown.has('speed')) chart('Speed <span>km/h</span>', lapSeries(), all.map((l) => l.trace.spd), { height: 180, labels: !laps.length, fmtV: (v) => Math.round(v) });
    // throttle up, brake down: one chart for both pedals
    if (shown.has('pedals')) chart('Pedals <span>% · throttle up, brake down</span>',
      [...all.map((_, i) => ({ label: `${name(i)} gas`, stroke: color(i), width: 1.5 })), ...all.map((_, i) => ({ label: `${name(i)} brake`, stroke: color(i), width: 1.5, fill: `color-mix(in srgb, ${color(i)} 12%, transparent)` }))],
      [...all.map((l) => l.trace.thr.map((v) => v * 100)), ...all.map((l) => l.trace.brk.map((v) => -v * 100))],
      { height: 150, range: [-104, 104], fmtV: (v) => `${Math.round(Math.abs(v))}%` });
    if (shown.has('steering')) chart('Steering', lapSeries(), all.map((l) => l.trace.str), { height: 100, fmtV: (v) => (+v).toFixed(2) });
    if (shown.has('gear')) chart('Gear', lapSeries(), all.map((l) => l.trace.gear), { height: 90, stepped: true, fmtV: gearTxt });
    if (shown.has('rpm') && data.ref.trace.rpm) chart('RPM', lapSeries(), all.map((l) => l.trace.rpm), { height: 110, fmtV: (v) => Math.round(v) });
    if (shown.has('line') && laps.length) {
      const sgn = mirror ? -1 : 1;
      chart('Racing line <span>m from the reference · above zero = left on the map</span>', [{ label: 'Ref', stroke: css('--axis'), width: 1 }, ...laps.map((l, i) => ({ label: name(i + 1), stroke: color(i + 1), width: 1.5 }))],
        [d.map(() => 0), ...laps.map((l) => l.offset.map((v) => v * sgn))], { height: 110, fmtV: (v) => sideTxt(v * sgn, mirror) });
    }
    if (!charts.length) holder.innerHTML = '<p class="muted">No charts selected: tick one above.</p>';
    root.querySelectorAll('[data-chart]').forEach((cb) => cb.onchange = () => {
      cb.checked ? shown.add(cb.dataset.chart) : shown.delete(cb.dataset.chart);
      try { localStorage.setItem('tele.charts', JSON.stringify([...shown])); } catch { /* ignore */ }
      draw();
    });
    // double-click resets the zoom (uPlot), and also leaves the corner
    holder.addEventListener('dblclick', () => { if (st.corner) select(null); });

    // the cursor from the map: put it on every chart
    // the cars on the map: kept where the cursor last was; zoomed in, the map re-centres on the car
    function moveCar(i) {
      cursorIdx = i;
      if (i == null || i === carIdx) return;
      carIdx = i;
      if (mapZoom > 1) redrawSoon(); else paint();
    }
    function setCursor(i, fromMapEvt) {
      moveCar(i);
      if (!fromMapEvt) return;
      fromMap = true;
      for (const u of charts) {
        if (i == null) { u.setCursor({ left: -10, top: -10 }); continue; }
        const left = u.valToPos(d[i], 'x');
        if (left < 0 || left > u.bbox.width / devicePixelRatio) continue;
        u.setCursor({ left, top: u.bbox.height / devicePixelRatio / 2 });
      }
      fromMap = false;
    }

    const onResize = () => { for (const u of charts) u.setSize({ width: width(), height: u.height }); drawBase(); };
    window.addEventListener('resize', onResize);
    own.push(() => { window.removeEventListener('resize', onResize); charts.forEach((u) => u.destroy()); });
    drawBase();

    // ---------------- AI coach for your lap
    const ai = q('.tele-ai');
    if (ai) mountAi(ai, lap0, data, st.ref, opts.hasKey);
  }
  const mountId = ++mounts;
  await draw();
  return { set: (patch) => { Object.assign(st, patch); changed(); }, state: () => ({ ...st }) };
}
let mounts = 0;

// ---- what your lap does differently in a corner: [tag, html] notes and a tip
function cornerNotes(m, r) {
  const items = [];
  const n = (v) => Math.round(Math.abs(v));
  const has = (a, b) => a != null && b != null;
  if (has(m.brakePoint, r.brakePoint)) {
    const dB = m.brakePoint - r.brakePoint;
    if (Math.abs(dB) >= 3) items.push(['ENTRY', `Braked <b>${n(dB)} m ${dB > 0 ? 'later' : 'earlier'}</b>`]);
    else items.push(['ENTRY', 'Braked at the same point']);
    if (has(m.maxBrakePct, r.maxBrakePct) && Math.abs(m.maxBrakePct - r.maxBrakePct) >= 10) items.push(['ENTRY', `<b>${n(m.maxBrakePct - r.maxBrakePct)}% ${m.maxBrakePct < r.maxBrakePct ? 'less' : 'more'}</b> brake pressure`]);
    if (has(m.brakeRelease, r.brakeRelease) && Math.abs(m.brakeRelease - r.brakeRelease) >= 10) {
      const dR = m.brakeRelease - r.brakeRelease;
      items.push(['ENTRY', dR < 0 ? `Released the brake <b>${n(dR)} m earlier</b>` : `Held the brake <b>${n(dR)} m longer</b>`]);
    }
  } else if (m.brakePoint == null && r.brakePoint != null) items.push(['ENTRY', `No braking (the reference braked at ${r.brakePoint} m)`]);
  else if (m.brakePoint != null && r.brakePoint == null) items.push(['ENTRY', `Braked where the reference ${r.liftPoint != null ? 'only lifted' : 'stayed flat'}`]);
  if (has(m.coastM, r.coastM) && m.coastM - r.coastM >= 8) items.push(['ENTRY', `<b>${n(m.coastM - r.coastM)} m more coasting</b> (neither pedal)`]);
  if (has(m.minSpeed, r.minSpeed) && Math.abs(m.minSpeed - r.minSpeed) >= 1.5) items.push(['APEX', `<b>${n(m.minSpeed - r.minSpeed)} km/h ${m.minSpeed < r.minSpeed ? 'slower' : 'faster'}</b> at the apex (${Math.round(m.minSpeed)} vs ${Math.round(r.minSpeed)})`]);
  if (m.apexWide != null && Math.abs(m.apexWide) >= 0.5) items.push(['APEX', `Apex <b>${Math.abs(m.apexWide).toFixed(1)} m ${m.apexWide > 0 ? 'wider' : 'tighter'}</b>`]);
  if (has(m.throttlePickup, r.throttlePickup) && Math.abs(m.throttlePickup - r.throttlePickup) >= 5) {
    const dT = m.throttlePickup - r.throttlePickup;
    items.push(['EXIT', `Back on the throttle <b>${n(dT)} m ${dT > 0 ? 'later' : 'earlier'}</b>`]);
  }
  if (has(m.exitSpeed, r.exitSpeed) && Math.abs(m.exitSpeed - r.exitSpeed) >= 1.5) items.push(['EXIT', `<b>${n(m.exitSpeed - r.exitSpeed)} km/h ${m.exitSpeed < r.exitSpeed ? 'slower' : 'faster'}</b> on the exit`]);
  const tip = (loss) => {
    const slowApex = has(m.minSpeed, r.minSpeed) && m.minSpeed - r.minSpeed <= -3;
    if (loss < -0.005) return "You're quicker here than the reference. Keep doing this.";
    if (slowApex && has(m.brakePoint, r.brakePoint) && m.brakePoint - r.brakePoint >= 3) return 'Brake a little earlier and carry more speed to the apex.';
    if (slowApex && has(m.brakeRelease, r.brakeRelease) && m.brakeRelease - r.brakeRelease <= -10) return 'Trail the brake further into the corner to carry speed to the apex.';
    if (slowApex) return 'Carry more speed to the apex: release the brake more smoothly.';
    if (has(m.throttlePickup, r.throttlePickup) && m.throttlePickup - r.throttlePickup >= 5) return 'Get back on the throttle earlier; a straighter exit helps.';
    if (has(m.exitSpeed, r.exitSpeed) && m.exitSpeed - r.exitSpeed <= -2) return 'Focus on the exit: earlier, more progressive throttle.';
    if (has(m.coastM, r.coastM) && m.coastM - r.coastM >= 8) return 'Cut the coasting: go from brake to throttle without a pause.';
    return 'A small loss: compare the two lines on the map.';
  };
  return { items, tip };
}
const cornerHeadline = (m, r) => {
  const { items } = cornerNotes(m, r);
  const first = items.find(([t]) => t === 'APEX') || items[0];
  return first ? first[1].replace(/<[^>]+>/g, '') : '';
};

// ---- AI coach: your lap against the reference (Gemini)
function mountAi(box, lap, data, ref, hasKey) {
  box.innerHTML = `<div class="row"><b>AI driving coach</b><span class="hint">lap ${lap.meta.lap_number ?? ''} against ${esc(data.ref.label.toLowerCase())}</span><span class="spacer"></span>
      <a class="hint" href="/api/ai/summary?lap=${lap.id}&ref=${ref}" target="_blank">What is sent to the AI?</a>
      <button class="primary" data-ai ${hasKey ? '' : 'disabled'}>Analyze my driving</button></div>
    ${hasKey ? '' : '<p class="muted">Add a free Google Gemini API key in <a href="#/settings">Settings</a> to enable the AI coach.</p>'}
    <div class="ai-out"></div>
    <div class="ai-q" hidden><input placeholder="Ask a follow-up, e.g. “How should I approach T3 differently?”"><button>Ask</button></div>`;
  const out = box.querySelector('.ai-out'), qBox = box.querySelector('.ai-q'), qIn = qBox.querySelector('input');
  const run = async (body, append) => {
    const h = document.createElement('div');
    h.innerHTML = '<p><span class="spinner"></span> Analyzing telemetry…</p>';
    if (append) out.appendChild(h); else { out.innerHTML = ''; out.appendChild(h); }
    try {
      const r = await post('/api/ai/analyze', { lap: lap.id, ref: String(ref), ...body });
      h.innerHTML = (body.question ? `<p class="secondary"><b>Q:</b> ${esc(body.question)}</p>` : '') + md(r.text) + aiConfidence(r.confidence)
        + `<p class="muted" style="font-size:12px">${r.cached ? 'Saved analysis from' : 'Analysis by'} ${esc(r.model)}, ${new Date(r.createdAt).toLocaleString()}${r.cached ? ' <button class="small ghost" data-re>Analyze again</button>' : ''}</p>`;
      if (r.cached) h.querySelector('[data-re]').onclick = () => run({ force: true });
      qBox.hidden = false;
    } catch (e) { h.innerHTML = `<p class="error">${esc(e.message)}</p>`; }
  };
  box.querySelector('[data-ai]').onclick = () => run({});
  const ask = () => { const v = qIn.value.trim(); if (v) { qIn.value = ''; run({ question: v }, true); } };
  qBox.querySelector('button').onclick = ask;
  qIn.onkeydown = (e) => { if (e.key === 'Enter') ask(); };
}
