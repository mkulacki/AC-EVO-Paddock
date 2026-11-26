// Tracks tab: every track and layout in AC EVO (from the game's own track data), with the game's map,
// and a detail page with the real edges, ideal line, pit lane, start/finish, sectors and corners.
import { $, css, esc, api, post, fmt, prettyName, getMirror, fitProjection } from './util.js';

const km = (m) => (m ? `${(m / 1000).toFixed(3)} km` : '—');
const mapUrl = (id, key) => `/api/tracks/map?track=${encodeURIComponent(id)}&layout=${encodeURIComponent(key)}`;
const trackUrl = (id, key) => `#/track?id=${encodeURIComponent(id)}&layout=${encodeURIComponent(key)}`;

// ------------------------------------------------------------------ list
export async function viewTracks(view) {
  view.innerHTML = '<div class="card muted">Reading AC EVO track data…</div>';
  const { status, tracks } = await api('/api/tracks');
  if (!status.ok) {
    view.innerHTML = `<div class="card error">${esc(status.error || 'AC EVO track data not available')}<br>
      <span class="muted">Set the AC EVO folder in <a href="#/settings">Settings</a>.</span></div>`;
    return;
  }
  const layouts = tracks.flatMap((t) => t.layouts.map((l) => ({ t, l })));
  view.innerHTML = `<div class="race-head"><div><h1>Tracks</h1><div class="sub">${tracks.length} tracks and ${layouts.length} layouts, read from AC EVO's own track data.</div></div><span class="spacer"></span>
      <div class="head-tools"><input id="tq" type="search" placeholder="Search track, layout or country" aria-label="Search tracks" style="width:260px">
      <label class="row" style="gap:8px;font-size:var(--fs-sm)"><input type="checkbox" id="tdriven"> Only tracks I've driven</label></div></div>
    <div class="track-grid" id="tgrid"></div>`;
  const render = () => {
    const q = $('#tq').value.trim().toLowerCase(), driven = $('#tdriven').checked;
    const list = layouts.filter(({ t, l }) => (!driven || l.laps) && (!q || `${t.name} ${l.name} ${t.country} ${t.countryName} ${t.region}`.toLowerCase().includes(q)));
    $('#tgrid').innerHTML = list.map(({ t, l }) => `<a class="track-card" href="${trackUrl(t.id, l.key)}">
        <div class="track-map">${l.hasMap ? `<img loading="lazy" src="${mapUrl(t.id, l.key)}" alt="${esc(t.name)} ${esc(l.name)} map">` : '<span class="muted">no map</span>'}</div>
        <div class="track-body">
          <div class="row"><b>${esc(t.name)}</b><span class="spacer"></span><span class="tag">${esc(t.country)}</span></div>
          <div class="muted">${esc(l.name)}</div>
          <div class="track-facts"><span>${km(l.lengthM)}</span><span>${l.corners ?? '—'} corners</span><span>${l.width?.known ? `${l.width.median} m wide` : ''}</span></div>
          ${l.laps ? `<div class="track-mine"><span class="g-ok">${l.laps} lap${l.laps > 1 ? 's' : ''}</span>, best ${fmt(l.bestMs)}</div>` : '<div class="track-mine muted">Not driven yet</div>'}
        </div></a>`).join('') || '<div class="card muted">No track matches.</div>';
  };
  $('#tq').oninput = render; $('#tdriven').onchange = render;
  render();
}

// ------------------------------------------------------------------ detail
export async function viewTrack(view, params, cleanup) {
  const id = params.get('id'), key = params.get('layout');
  const d = await api(`/api/tracks/detail?track=${encodeURIComponent(id)}&layout=${encodeURIComponent(key)}`);
  const { track: t, layout: l, model: m, combos } = d;
  view.innerHTML = `<div class="row" style="margin-bottom:12px"><a href="#/tracks"><button class="ghost">All tracks</button></a>
      <div><h1 style="margin:0">${esc(t.name)} <span class="muted">${esc(l.name)}</span></h1>
        <div class="muted">${esc([t.countryName || t.country, t.region].filter(Boolean).join(', '))}</div></div>
      <span class="spacer"></span>
      ${t.layouts.length > 1 ? `<select id="tlayout">${t.layouts.map((x) => `<option value="${esc(x.key)}" ${x.key === l.key ? 'selected' : ''}>${esc(x.name)}, ${km(x.lengthM)}</option>`).join('')}</select>` : ''}</div>
    <div class="track-detail">
      <div class="card"><div class="row"><h2 style="margin:0">Track map</h2><span class="spacer"></span>
          <label class="row" style="gap:6px"><input type="checkbox" id="tline" checked> ideal line</label>
          <label class="row" style="gap:6px"><input type="checkbox" id="tpit" checked> pit lane</label></div>
        <canvas id="tcanvas" class="track-canvas"></canvas>
        <div class="muted" style="font-size:12px">Edges, ideal (AI) line, pit lane, start/finish and sector lines from AC EVO's track data. Corners are found from the track's shape.</div></div>
      <div>
        <div class="card"><h2 style="margin-top:0">Details</h2><table class="kv"><tbody>
          <tr><td>Length</td><td>${km(l.lengthM)} <span class="muted">(ideal line ${km(m.L)})</span></td></tr>
          <tr><td>Corners</td><td>${m.corners.length}</td></tr>
          <tr><td>Sectors</td><td>${m.sectors.length + 1}${m.sectors.length ? ` <span class="muted">(splits at ${m.sectors.map((s) => `${s} m`).join(', ')})</span>` : ''}</td></tr>
          <tr><td>Track width</td><td>${m.width.known ? `${m.width.median} m <span class="muted">(${m.width.min}–${m.width.max} m)</span>`
            : '<span class="muted">not in the game data (drawn as 10 m)</span>'}</td></tr>
          <tr><td>Pit lane</td><td>${m.pit ? 'yes' : '—'}</td></tr>
        </tbody></table>
        ${l.hasMap ? `<div class="track-map small"><img src="${mapUrl(t.id, l.key)}" alt="game map"></div><div class="muted" style="font-size:12px">The game's own map</div>` : ''}</div>
        <div class="card"><h2 style="margin-top:0">Your laps here</h2>
          ${combos.length ? `<table><thead><tr><th>Car</th><th>Laps</th><th>Best</th><th>Ideal</th><th></th></tr></thead><tbody>${combos.map((c) =>
            `<tr><td>${esc(prettyName(c.car))}</td><td>${c.laps}</td><td>${fmt(c.bestMs)}</td><td class="muted">${fmt(c.idealMs)}</td>
              <td>${c.bestLapId ? `<a href="#/compare?laps=${c.bestLapId}&ref=best">analyse</a>` : ''}</td></tr>`).join('')}</tbody></table>`
            : '<p class="muted">You haven\'t driven this layout yet.</p>'}</div>
      </div>
    </div>
    <div class="card" id="bm"><div class="row"><h2 style="margin:0">Brake points</h2>
        <select id="bmCar" title="Brake points are kept for each car"></select><span class="muted" id="bmCount"></span>
        <span class="spacer"></span><span class="muted" id="bmSaved"></span>
        <button class="small" id="bmAdd" title="Then click the track on the map where you want to brake">Add point</button>
        <button class="small" id="bmBest">Fill from my best lap</button>
        <button class="small danger-ghost" id="bmClear">Clear all</button></div>
      <p class="muted" style="margin:6px 0 10px">Your own braking points for this car. With <a href="#/settings">Settings → Brake spotter → Count down to: My brake points</a>,
        the spotter and the HUD count down to these, and only these. Drag a point along the track on the map to move it.</p>
      <div class="row" style="margin-bottom:10px">
        <button id="bmRecBtn" title="Press your mark button (or keyboard shortcut) where you want to brake. A press near an existing point moves it.">Mark with button</button>
        <button id="bmRecPedal" title="Drive one full lap: every point where you start braking becomes a brake point, replacing this car's points">Record from my braking (next lap)</button>
        <span id="bmRecState" class="muted"></span></div>
      <div id="bmList"></div></div>
    <div class="card"><h2 style="margin-top:0">Corners</h2>
      <table><thead><tr><th>Corner</th><th>Apex at</th><th>Direction</th><th>Angle</th><th>Tightest radius</th><th>Segment</th></tr></thead><tbody>
      ${m.corners.map((c) => `<tr data-c="${c.n - 1}" class="clickable"><td><b>${c.name}</b></td><td>${Math.round(c.apexD)} m</td><td>${c.dir}</td><td>${c.turnDeg}°</td>
        <td>${c.minRadius != null ? `${c.minRadius} m` : '—'}</td><td class="muted">${Math.round(c.aD)}–${Math.round(c.bD)} m</td></tr>`).join('')}
      </tbody></table></div>`;

  if ($('#tlayout')) $('#tlayout').onchange = (e) => { location.hash = trackUrl(t.id, e.target.value); };
  let sel = null;
  const canvas = $('#tcanvas');
  let proj = null; // the last drawing's projection, for clicks and drags on the map

  // ---- brake points (own brake marks) of one car on this layout
  const bm = { car: null, marks: [], sel: null, adding: false, drag: null, rec: null, live: null };
  const posToI = (pos) => Math.min(m.n - 1, Math.max(0, Math.round((pos * m.L) / m.step)));
  const cornerAt = (pos) => (m.corners.find((c) => c.apexD / m.L >= pos) || m.corners[0])?.name || '';
  const bmQuery = () => `track=${encodeURIComponent(t.id)}&layout=${encodeURIComponent(l.key)}&car=${encodeURIComponent(bm.car)}`;
  let bmT;
  const bmSave = () => {
    clearTimeout(bmT);
    bmT = setTimeout(async () => {
      try {
        const r = await post('/api/brakemarks', { track: t.id, layout: l.key, car: bm.car, marks: bm.marks.map(({ pos, kind }) => ({ pos, kind })) });
        $('#bmSaved').textContent = 'Saved ✓'; bm.marks = r.marks; bmList(); draw();
      } catch (e) { $('#bmSaved').textContent = e.message; }
    }, 300);
  };
  function bmList() {
    $('#bmCount').textContent = bm.car ? `${bm.marks.length} point${bm.marks.length === 1 ? '' : 's'}` : '';
    $('#bmAdd').classList.toggle('on', bm.adding);
    $('#bmAdd').textContent = bm.adding ? 'Click the track…' : 'Add point';
    $('#bmList').innerHTML = !bm.car ? '<p class="muted">Drive this layout once, or start marking while you drive, to add brake points.</p>'
      : !bm.marks.length ? '<p class="muted">No brake points for this car yet. Mark them while driving, record them from your braking, fill them from your best lap, or add them on the map.</p>'
      : `<table><thead><tr><th>#</th><th>Corner</th><th>From the line</th><th>Type</th><th></th></tr></thead><tbody>${bm.marks.map((k, i) =>
        `<tr data-i="${i}" class="${i === bm.sel ? 'sel' : ''}"><td>${i + 1}</td><td><b>${esc(cornerAt(k.pos))}</b></td><td>${Math.round(k.pos * m.L)} m</td>
          <td><select data-kind="${i}"><option value="brake" ${k.kind === 'brake' ? 'selected' : ''}>Brake</option><option value="lift" ${k.kind === 'lift' ? 'selected' : ''}>Lift</option></select></td>
          <td><button class="small ghost" data-del="${i}" title="Delete this point" aria-label="Delete this point">✕</button></td></tr>`).join('')}</tbody></table>`;
    $('#bmList').querySelectorAll('[data-kind]').forEach((s) => { s.onchange = () => { bm.marks[+s.dataset.kind].kind = s.value; bmSave(); draw(); }; });
    $('#bmList').querySelectorAll('[data-del]').forEach((b) => { b.onclick = () => { bm.marks.splice(+b.dataset.del, 1); bm.sel = null; bmSave(); bmList(); draw(); }; });
    $('#bmList').querySelectorAll('tr[data-i]').forEach((tr) => { tr.onmouseenter = () => { bm.sel = +tr.dataset.i; draw(); }; });
  }
  function bmRecState() {
    const r = bm.rec;
    $('#bmRecBtn').classList.toggle('on', r?.mode === 'button');
    $('#bmRecPedal').classList.toggle('on', r?.mode === 'pedal');
    $('#bmRecBtn').textContent = r?.mode === 'button' ? 'Stop marking' : 'Mark with button';
    $('#bmRecPedal').textContent = r?.mode === 'pedal' ? 'Stop recording' : 'Record from my braking (next lap)';
    const where = bm.live ? ` for the car you're driving${bm.live.track === t.id && bm.live.layout === l.key ? '' : ', on the track you are on'}` : ' as soon as you are on track';
    $('#bmRecState').innerHTML = !r ? ''
      : r.mode === 'button' ? `Marking${where}: press your mark button where you want to brake. You hear a beep for each point.`
      : r.phase === 'waiting' ? `Waiting for your next lap to start at the line${where}…`
      : `Recording this lap: ${r.found} brake point${r.found === 1 ? '' : 's'} so far. They are saved when you cross the line.`;
  }
  async function bmLoad() {
    if (!bm.car) { bm.marks = []; bmList(); draw(); return; }
    const r = await api(`/api/brakemarks?${bmQuery()}`);
    bm.marks = r.marks; bm.rec = r.recording; bm.live = r.live; bm.sel = null;
    bmList(); bmRecState(); draw();
  }
  {
    const r = await api(`/api/brakemarks?track=${encodeURIComponent(t.id)}&layout=${encodeURIComponent(l.key)}&car=-`);
    bm.rec = r.recording; bm.live = r.live;
    const liveHere = r.live && r.live.track === t.id && r.live.layout === l.key ? r.live.car : null;
    const cars = [...new Set([liveHere, ...combos.map((c) => c.car), ...r.cars.map((c) => c.car)].filter(Boolean))];
    bm.car = liveHere || r.cars[0]?.car || cars[0] || null;
    $('#bmCar').innerHTML = cars.map((c) => `<option value="${esc(c)}" ${c === bm.car ? 'selected' : ''}>${esc(prettyName(c))}${c === liveHere ? ' (driving now)' : ''}</option>`).join('');
    $('#bmCar').hidden = !cars.length;
    $('#bmCar').onchange = (e) => { bm.car = e.target.value; bmLoad(); };
    $('#bmAdd').onclick = () => { if (bm.car) { bm.adding = !bm.adding; bmList(); } };
    $('#bmClear').onclick = () => { if (bm.marks.length && confirm(`Delete all ${bm.marks.length} brake points of ${prettyName(bm.car)} here?`)) { bm.marks = []; bmSave(); bmList(); draw(); } };
    $('#bmBest').onclick = async () => {
      const c = combos.find((x) => x.car === bm.car);
      if (!c) { $('#bmSaved').textContent = 'No laps with this car here yet.'; return; }
      if (bm.marks.length && !confirm(`Replace the ${bm.marks.length} brake points of ${prettyName(bm.car)} with those of your best lap?`)) return;
      try {
        const r2 = await api(`/api/brakemarks/best?track=${encodeURIComponent(c.gameTrack)}&layout=${encodeURIComponent(c.gameLayout)}&car=${encodeURIComponent(c.car)}`);
        bm.marks = r2.marks; bmSave(); bmList(); draw();
      } catch (e) { $('#bmSaved').textContent = e.message; }
    };
    const rec = async (mode) => { try { bm.rec = (await post('/api/brakemarks/record', { mode: bm.rec?.mode === mode ? null : mode })).recording; bmRecState(); } catch (e) { $('#bmRecState').textContent = e.message; } };
    $('#bmRecBtn').onclick = () => rec('button');
    $('#bmRecPedal').onclick = () => rec('pedal');
    // marks made in the game (button, pedal lap) show up here straight away
    const onMarks = (e) => {
      bm.rec = e.detail.recording; bmRecState();
      const c = e.detail.combo;
      if (c && c.track === t.id && c.layout === l.key && c.car === bm.car) bmLoad();
    };
    window.addEventListener('paddock:brakemarks', onMarks);
    cleanup.push(() => window.removeEventListener('paddock:brakemarks', onMarks));
    bmRecState();
    bmLoad();
  }

  // map: nearest point of the centre line to the mouse, as a lap fraction
  const toPos = (ev) => {
    if (!proj) return null;
    const r = canvas.getBoundingClientRect(), x = ev.clientX - r.left, y = ev.clientY - r.top;
    let best = Infinity, bi = 0;
    for (let i = 0; i < m.n; i++) { const [px, py] = proj(m.centre.x[i], m.centre.z[i]); const dd = (px - x) ** 2 + (py - y) ** 2; if (dd < best) { best = dd; bi = i; } }
    return { pos: ((bi * m.step) / m.L) % 1, dist: Math.sqrt(best) };
  };
  const markAtMouse = (ev) => {
    if (!proj) return -1;
    const r = canvas.getBoundingClientRect(), x = ev.clientX - r.left, y = ev.clientY - r.top;
    return bm.marks.findIndex((k) => { const i = posToI(k.pos); const [px, py] = proj(m.centre.x[i], m.centre.z[i]); return Math.hypot(px - x, py - y) < 10; });
  };
  canvas.addEventListener('pointerdown', (ev) => {
    if (!bm.car) return;
    const k = markAtMouse(ev);
    if (k >= 0) { bm.drag = k; bm.sel = k; canvas.setPointerCapture(ev.pointerId); draw(); return; }
    if (bm.adding) {
      const p = toPos(ev);
      if (p && p.dist < 30) { bm.marks.push({ pos: p.pos, kind: 'brake' }); bm.marks.sort((a, b) => a.pos - b.pos); bm.adding = false; bmSave(); bmList(); draw(); }
    }
  });
  canvas.addEventListener('pointermove', (ev) => {
    if (bm.drag == null) { canvas.style.cursor = bm.adding ? 'crosshair' : markAtMouse(ev) >= 0 ? 'grab' : ''; return; }
    const p = toPos(ev);
    if (p) { bm.marks[bm.drag].pos = p.pos; draw(); }
  });
  canvas.addEventListener('pointerup', () => {
    if (bm.drag == null) return;
    const moved = bm.marks[bm.drag];
    bm.marks.sort((a, b) => a.pos - b.pos);
    bm.sel = bm.marks.indexOf(moved); bm.drag = null;
    bmSave(); bmList(); draw();
  });

  function draw() {
    const dpr = window.devicePixelRatio || 1, W = canvas.clientWidth, H = canvas.clientHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
    const P = proj = fitProjection([...m.left.x, ...m.right.x], [...m.left.z, ...m.right.z], W, H, 28, getMirror());
    const path = (line, close) => { ctx.beginPath(); line.x.forEach((x, i) => { const [a, b] = P(x, line.z[i]); i ? ctx.lineTo(a, b) : ctx.moveTo(a, b); }); if (close) ctx.closePath(); };
    // track surface between the edges
    ctx.fillStyle = css('--grid');
    ctx.beginPath();
    m.left.x.forEach((x, i) => { const [a, b] = P(x, m.left.z[i]); i ? ctx.lineTo(a, b) : ctx.moveTo(a, b); }); ctx.closePath();
    for (let i = m.right.x.length - 1; i >= 0; i--) { const [a, b] = P(m.right.x[i], m.right.z[i]); i === m.right.x.length - 1 ? ctx.moveTo(a, b) : ctx.lineTo(a, b); }
    ctx.closePath(); ctx.fill('evenodd');
    ctx.strokeStyle = css('--axis'); ctx.lineWidth = 1.2; path(m.left, true); ctx.stroke(); path(m.right, true); ctx.stroke();
    if (m.pit && $('#tpit').checked) { ctx.strokeStyle = css('--text-muted'); ctx.setLineDash([2, 3]); ctx.lineWidth = 1.5; path(m.pit, false); ctx.stroke(); ctx.setLineDash([]); }
    if ($('#tline').checked) { ctx.strokeStyle = css('--series-1') || '#3b82f6'; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]); path(m.ideal, true); ctx.stroke(); ctx.setLineDash([]); }
    // selected corner segment
    if (sel != null) {
      const c = m.corners[sel], a = Math.round(c.aD / m.step), b = Math.round(c.bD / m.step);
      ctx.strokeStyle = css('--text-primary'); ctx.lineWidth = 4; ctx.globalAlpha = 0.5; ctx.beginPath();
      for (let i = a; i <= b; i++) { const [x, y] = P(m.centre.x[i], m.centre.z[i]); i === a ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
      ctx.stroke(); ctx.globalAlpha = 1;
    }
    // start/finish and sector lines across the track
    const across = (dist, color, w) => {
      const i = Math.min(m.n - 1, Math.max(0, Math.round(dist / m.step)));
      const [a, b] = P(m.left.x[i], m.left.z[i]), [c2, d2] = P(m.right.x[i], m.right.z[i]);
      ctx.strokeStyle = color; ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(a, b); ctx.lineTo(c2, d2); ctx.stroke();
    };
    for (const s of m.sectors) across(s, css('--warning'), 2.5);
    across(0, css('--text-primary'), 4);
    // corner labels, pushed outward from the map centre
    ctx.font = '600 11px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    m.corners.forEach((c, k) => {
      const i = Math.round(c.apexD / m.step);
      const [px, py] = P(m.centre.x[i], m.centre.z[i]);
      const dx = px - W / 2, dy = py - H / 2, len = Math.hypot(dx, dy) || 1;
      const lx = px + (dx / len) * 20, ly = py + (dy / len) * 20;
      ctx.fillStyle = k === sel ? css('--text-primary') : css('--surface-2'); ctx.beginPath(); ctx.arc(lx, ly, 11, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = k === sel ? css('--surface-1') : css('--text-secondary'); ctx.fillText(String(c.n), lx, ly);
    });
    // brake points: red = brake, yellow = lift; the hovered / dragged one is bigger
    bm.marks.forEach((k, j) => {
      const i = posToI(k.pos), [px, py] = P(m.centre.x[i], m.centre.z[i]), big = j === bm.sel || j === bm.drag;
      ctx.fillStyle = k.kind === 'lift' ? css('--warning') : css('--slower');
      ctx.strokeStyle = css('--page'); ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(px, py, big ? 7 : 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    });
  }
  $('#tline').onchange = draw; $('#tpit').onchange = draw;
  view.querySelectorAll('tr[data-c]').forEach((tr) => { tr.onclick = () => { sel = sel === +tr.dataset.c ? null : +tr.dataset.c; draw(); }; });
  draw();
  const onResize = () => draw();
  window.addEventListener('resize', onResize);
  cleanup.push(() => window.removeEventListener('resize', onResize));
}
