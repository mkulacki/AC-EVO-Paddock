// Tracks tab: every track and layout in AC EVO (from the game's own track data), with the game's map,
// and a detail page with the real edges, ideal line, pit lane, start/finish, sectors and corners.
import { $, css, esc, api, fmt, prettyName, getMirror, fitProjection } from './util.js';

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
  view.innerHTML = `<div class="card"><div class="row"><h1 style="margin:0">Tracks</h1>
      <span class="muted">${tracks.length} tracks · ${layouts.length} layouts · read from AC EVO's own track data</span>
      <span class="spacer"></span>
      <input id="tq" placeholder="search track, layout, country" style="width:240px">
      <label class="row" style="gap:6px"><input type="checkbox" id="tdriven"> only tracks I've driven</label></div></div>
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
          ${l.laps ? `<div class="track-mine"><span class="g-ok">${l.laps} lap${l.laps > 1 ? 's' : ''}</span> · best ${fmt(l.bestMs)}</div>` : '<div class="track-mine muted">not driven yet</div>'}
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
  view.innerHTML = `<div class="row" style="margin-bottom:12px"><a href="#/tracks"><button class="ghost">← Tracks</button></a>
      <div><h1 style="margin:0">${esc(t.name)} <span class="muted">${esc(l.name)}</span></h1>
        <div class="muted">${esc([t.countryName || t.country, t.region].filter(Boolean).join(' · '))}</div></div>
      <span class="spacer"></span>
      ${t.layouts.length > 1 ? `<select id="tlayout">${t.layouts.map((x) => `<option value="${esc(x.key)}" ${x.key === l.key ? 'selected' : ''}>${esc(x.name)} · ${km(x.lengthM)}</option>`).join('')}</select>` : ''}</div>
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
    <div class="card"><h2 style="margin-top:0">Corners</h2>
      <table><thead><tr><th>Corner</th><th>Apex at</th><th>Direction</th><th>Angle</th><th>Tightest radius</th><th>Segment</th></tr></thead><tbody>
      ${m.corners.map((c) => `<tr data-c="${c.n - 1}" class="clickable"><td><b>${c.name}</b></td><td>${Math.round(c.apexD)} m</td><td>${c.dir}</td><td>${c.turnDeg}°</td>
        <td>${c.minRadius != null ? `${c.minRadius} m` : '—'}</td><td class="muted">${Math.round(c.aD)}–${Math.round(c.bD)} m</td></tr>`).join('')}
      </tbody></table></div>`;

  if ($('#tlayout')) $('#tlayout').onchange = (e) => { location.hash = trackUrl(t.id, e.target.value); };
  let sel = null;
  const canvas = $('#tcanvas');
  function draw() {
    const dpr = window.devicePixelRatio || 1, W = canvas.clientWidth, H = canvas.clientHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
    const P = fitProjection([...m.left.x, ...m.right.x], [...m.left.z, ...m.right.z], W, H, 28, getMirror());
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
  }
  $('#tline').onchange = draw; $('#tpit').onchange = draw;
  view.querySelectorAll('tr[data-c]').forEach((tr) => { tr.onclick = () => { sel = sel === +tr.dataset.c ? null : +tr.dataset.c; draw(); }; });
  draw();
  const onResize = () => draw();
  window.addEventListener('resize', onResize);
  cleanup.push(() => window.removeEventListener('resize', onResize));
}
