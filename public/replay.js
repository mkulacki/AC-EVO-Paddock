// Racing line replay: follow-camera track view, tick-by-tick stepping, compact telemetry panel.
import { $, css, esc, fmt, fmtGap, idxAt, gearTxt, getMirror, setMirror, sideTxt, SERIES } from './util.js';

const TICK_MS = 1000 / 60;
const CAR_L = 4.6, CAR_W = 1.9; // metres

function bandNote(band) {
  if (band?.source?.left === 'track') return 'The band shows the real track edges from AC EVO’s own track data.';
  return 'The band is the track width you have used across your valid laps (plus half a car width): AC EVO’s track data has no entry for this track.';
}

export function mountReplay(root, data, cleanup, opts = {}) {
  const cars = [
    { name: 'Ref', trace: data.ref.trace, color: css(SERIES[0]), isRef: true },
    ...data.laps.map((l, i) => ({ name: `#${l.id}`, trace: l.trace, color: css(SERIES[i + 1]), offset: l.offset, delta: l.delta })),
  ];
  const ref = cars[0].trace;
  const tEnd = Math.max(...cars.map((c) => c.trace.t[c.trace.t.length - 1]));
  const strMax = Math.max(0.01, ...cars.map((c) => c.trace.str.reduce((m, v) => Math.max(m, Math.abs(v)), 0)));
  const st = { T: 0, mode: 'pos', playing: false, speed: 1, zoom: 160, headingUp: false, inputs: false, mirror: getMirror(),
    focus: cars.length > 1 ? 1 : 0, rot: 0, dirty: true };
  try { Object.assign(st, JSON.parse(localStorage.getItem('replayPrefs') || '{}'), { T: 0, playing: false, focus: st.focus, mirror: getMirror() }); } catch { /* ignore */ }
  if (opts.mode === 'time' || opts.mode === 'pos') st.mode = opts.mode;
  if (opts.inputs != null) st.inputs = opts.inputs;
  const savePrefs = () => { try { localStorage.setItem('replayPrefs', JSON.stringify({ mode: st.mode, speed: st.speed, zoom: st.zoom, headingUp: st.headingUp, inputs: st.inputs })); } catch { /* ignore */ } };

  const ROWS = [
    ['time', 'Lap time'], ['delta', 'Δ to ref'], ['gap', 'Gap'], ['speed', 'Speed'], ['gear', 'Gear · RPM'],
    ['thr', 'Throttle'], ['brk', 'Brake'], ['str', 'Steering'], ['line', 'Line vs ref'],
  ];
  root.innerHTML = `
  <div class="replay">
    <div class="card rp-main">
      <div class="row rp-toolbar">
        <div class="seg" id="rpMode"><button data-v="pos" title="Both cars at the same track position - compare inputs">Same position</button><button data-v="time" title="Both cars at the same lap time - ghost race">Same time (ghost)</button></div>
        <label class="row"><input type="checkbox" id="rpInputs"> Line colour by inputs</label>
        <label class="row"><input type="checkbox" id="rpHead"> Heading up</label>
        <label class="row" title="Use only if the track looks mirrored"><input type="checkbox" id="rpMirror"> Flip map</label>
        ${cars.length > 2 ? `<label class="row">Focus <select id="rpFocus">${cars.slice(1).map((c, i) => `<option value="${i + 1}">${c.name}</option>`).join('')}</select></label>` : ''}
        <span class="spacer"></span>
        <button class="small" id="zOut" title="Zoom out (−)">−</button><span class="num muted" id="zTxt"></span><button class="small" id="zIn" title="Zoom in (+)">+</button>
      </div>
      <canvas id="rpCanvas" class="rp-canvas"></canvas>
      <canvas id="rpStrip" class="rp-strip"></canvas>
      <div class="row rp-controls">
        <button id="prevC" title="Previous corner  [">⏮</button>
        <button id="stepB" title="Step back one tick  ←  (Shift = 10)">◀︎</button>
        <button id="play" class="primary" title="Play / pause  Space">▶ Play</button>
        <button id="stepF" title="Step forward one tick  →  (Shift = 10)">▶︎</button>
        <button id="nextC" title="Next corner  ]">⏭</button>
        <select id="speed" title="Playback speed">${[0.1, 0.25, 0.5, 1, 2, 4].map((s) => `<option value="${s}">${s}×</option>`).join('')}</select>
        <input type="range" id="scrub" min="0" max="${Math.ceil(tEnd)}" step="1" value="0">
        <span class="num" id="rpPos"></span>
      </div>
      <div class="row rp-corners">${data.corners.map((c, i) => `<button class="small ghost" data-c="${i}">${c.name}</button>`).join('')}
        <span class="spacer"></span><span class="muted" style="font-size:12px">Space play · ← → tick · Shift+← → 10 ticks · [ ] corners · + − zoom · wheel zoom</span></div>
    </div>
    <div class="rp-side">
      <div class="card tablewrap">
        <table class="rp-table"><thead><tr><th></th>${cars.map((c) => `<th><span class="sw" style="background:${c.color}"></span>${esc(c.name)}</th>`).join('')}</tr></thead>
        <tbody>${ROWS.map(([k, label]) => `<tr><td class="muted">${label}</td>${cars.map((_, ci) => `<td id="c-${k}-${ci}"></td>`).join('')}</tr>`).join('')}</tbody></table>
      </div>
      <div class="card"><div class="row"><h2 style="margin:0">G-forces</h2><span class="muted" style="font-size:12px">rings: 1 g, 2 g</span></div><canvas id="gcirc" class="gcirc"></canvas></div>
      <div class="card muted" style="font-size:12px">${bandNote(data.band)}
        “Line vs ref” is the distance from the reference line.</div>
    </div>
  </div>`;

  // bars inside table cells
  for (let ci = 0; ci < cars.length; ci++) {
    for (const k of ['thr', 'brk']) $(`#c-${k}-${ci}`).innerHTML = `<div class="hbar"><div style="background:${k === 'thr' ? 'var(--good)' : 'var(--critical)'}"></div></div><span class="num"></span>`;
    $(`#c-str-${ci}`).innerHTML = '<div class="hbar center"><div></div><i></i></div>';
  }

  // ---------------------------------------------------------------- sampling helpers
  const invT = (tr, T) => {
    const t = tr.t; if (T <= t[0]) return 0; if (T >= t[t.length - 1]) return t.length - 1;
    let lo = 0, hi = t.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (t[m] <= T) lo = m; else hi = m; }
    return lo + (T - t[lo]) / ((t[hi] - t[lo]) || 1);
  };
  const smp = (arr, fi) => { const i = Math.floor(fi), f = fi - i; const a = arr[i], b = arr[Math.min(arr.length - 1, i + 1)]; return a + (b - a) * f; };
  const headingAt = (tr, fi) => {
    const i = Math.round(fi), n = tr.x.length, a = Math.max(0, i - 3), b = Math.min(n - 1, i + 3);
    const hx = tr.x[b] - tr.x[a], hz = tr.z[b] - tr.z[a], l = Math.hypot(hx, hz) || 1;
    return [hx / l, hz / l];
  };
  const indices = () => cars.map((c) => (st.mode === 'pos' ? invT(ref, st.T) : invT(c.trace, st.T)));

  // ---------------------------------------------------------------- canvases
  const cv = $('#rpCanvas', root), strip = $('#rpStrip', root), gc = $('#gcirc', root);
  const fit = (c) => {
    const dpr = devicePixelRatio || 1, W = c.clientWidth, H = c.clientHeight;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    const ctx = c.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
    return [ctx, W, H];
  };
  const colors = () => ({ band: css('--grid'), edge: css('--axis'), text: css('--text-secondary'), muted: css('--text-muted'),
    surface: css('--surface-1'), good: css('--good'), crit: css('--critical'), warn: css('--warning'), grid: css('--grid'), primary: css('--text-primary') });

  function drawTrack(fis) {
    const [ctx, W, H] = fit(cv);
    const C = colors();
    const fc = cars[st.focus];
    const p0 = [smp(ref.x, fis[0]), smp(ref.z, fis[0])];
    const p1 = [smp(fc.trace.x, fis[st.focus]), smp(fc.trace.z, fis[st.focus])];
    const cx = (p0[0] + p1[0]) / 2, cz = (p0[1] + p1[1]) / 2;
    const s = W / st.zoom;
    const m = st.mirror ? -1 : 1;
    // camera rotation (heading up), smoothed
    let target = 0;
    if (st.headingUp) { const [hx, hz] = headingAt(ref, fis[0]); target = Math.PI / 2 - Math.atan2(hz, hx * m); }
    let diff = target - st.rot; diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    st.rot += st.playing ? diff * 0.15 : diff;
    if (Math.abs(diff) > 1e-3 && st.playing) st.dirty = true;
    const cs = Math.cos(st.rot), sn = Math.sin(st.rot);
    const P = (x, z) => { const u = (x - cx) * m, v = z - cz; return [W / 2 + (u * cs - v * sn) * s, H / 2 - (u * sn + v * cs) * s]; };
    const R2 = (st.zoom * 1.2) ** 2;
    const near = (x, z) => (x - cx) ** 2 + (z - cz) ** 2 < R2;

    // used-width band
    const band = data.band;
    if (band) {
      ctx.fillStyle = C.band; ctx.strokeStyle = C.edge; ctx.lineWidth = 1;
      ctx.beginPath();
      band.left.x.forEach((x, i) => { const [a, b] = P(x, band.left.z[i]); i ? ctx.lineTo(a, b) : ctx.moveTo(a, b); });
      for (let i = band.right.x.length - 1; i >= 0; i--) { const [a, b] = P(band.right.x[i], band.right.z[i]); ctx.lineTo(a, b); }
      ctx.closePath(); ctx.fill();
      for (const e of [band.left, band.right]) { ctx.beginPath(); e.x.forEach((x, i) => { const [a, b] = P(x, e.z[i]); i ? ctx.lineTo(a, b) : ctx.moveTo(a, b); }); ctx.stroke(); }
    }
    // start/finish line
    { const [hx, hz] = headingAt(ref, 0); const nx = -hz * 8, nz = hx * 8; const [a, b] = P(ref.x[0] + nx, ref.z[0] + nz), [c, d] = P(ref.x[0] - nx, ref.z[0] - nz);
      ctx.strokeStyle = C.primary; ctx.lineWidth = 3; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(a, b); ctx.lineTo(c, d); ctx.stroke(); ctx.setLineDash([]); }

    // racing lines
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const cat = (tr, i) => (tr.brk[i] > 0.1 ? 3 : tr.thr[i] > 0.9 ? 1 : tr.thr[i] > 0.1 ? 2 : 0);
    const catColor = [C.muted, C.good, C.warn, C.crit];
    const order = cars.map((_, i) => i).filter((i) => i !== st.focus).concat(st.focus);
    for (const ci of order) {
      const c = cars[ci], tr = c.trace, isFocus = ci === st.focus;
      if (st.inputs && isFocus) {
        ctx.lineWidth = Math.max(3, 0.9 * s);
        let curCat = -1;
        for (let i = 0; i < tr.x.length - 1; i++) {
          if (!near(tr.x[i], tr.z[i])) { if (curCat !== -1) { ctx.stroke(); curCat = -1; } continue; }
          const k = cat(tr, i);
          const [a, b] = P(tr.x[i], tr.z[i]);
          if (k !== curCat) { if (curCat !== -1) { ctx.lineTo(a, b); ctx.stroke(); } ctx.strokeStyle = catColor[k]; ctx.beginPath(); ctx.moveTo(a, b); curCat = k; }
          else ctx.lineTo(a, b);
        }
        if (curCat !== -1) ctx.stroke();
      } else {
        ctx.strokeStyle = c.color; ctx.lineWidth = isFocus || ci === 0 ? 2.5 : 1.8;
        ctx.globalAlpha = isFocus || ci === 0 ? 1 : 0.7;
        ctx.beginPath(); let pen = false;
        for (let i = 0; i < tr.x.length; i++) {
          if (!near(tr.x[i], tr.z[i])) { pen = false; continue; }
          const [a, b] = P(tr.x[i], tr.z[i]); pen ? ctx.lineTo(a, b) : ctx.moveTo(a, b); pen = true;
        }
        ctx.stroke(); ctx.globalAlpha = 1;
      }
    }
    // corner labels
    ctx.font = '600 12px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const c of data.corners) {
      const i = idxAt(ref.d, c.apex);
      if (!near(ref.x[i], ref.z[i])) continue;
      const [hx, hz] = headingAt(ref, i);
      // label 26 px towards the outside of the corner
      const [ax, ay] = P(ref.x[i], ref.z[i]), [ox, oy] = P(ref.x[i] + hz * c.turn, ref.z[i] - hx * c.turn);
      const ol = Math.hypot(ox - ax, oy - ay) || 1;
      const a = ax + ((ox - ax) / ol) * 26, b = ay + ((oy - ay) / ol) * 26;
      ctx.fillStyle = C.surface; ctx.beginPath(); ctx.arc(a, b, 13, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = C.text; ctx.fillText(c.name, a, b);
    }
    // cars (true scale, min size)
    for (const ci of order) {
      const c = cars[ci], fi = fis[ci], tr = c.trace;
      const [x, z] = [smp(tr.x, fi), smp(tr.z, fi)];
      const [hx, hz] = headingAt(tr, fi);
      const [a, b] = P(x, z), [a2, b2] = P(x + hx, z + hz);
      const ang = Math.atan2(b2 - b, a2 - a);
      const L = Math.max(14, CAR_L * s), Wd = Math.max(7, CAR_W * s);
      ctx.save(); ctx.translate(a, b); ctx.rotate(ang);
      ctx.fillStyle = c.color; ctx.strokeStyle = C.surface; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.roundRect(-L / 2, -Wd / 2, L, Wd, Math.min(3, Wd / 3)); ctx.fill(); ctx.stroke();
      ctx.fillStyle = C.surface; ctx.beginPath(); ctx.moveTo(L / 2 - 1, 0); ctx.lineTo(L / 2 - Math.min(6, L / 3), -Wd / 3); ctx.lineTo(L / 2 - Math.min(6, L / 3), Wd / 3); ctx.fill();
      ctx.restore();
    }
    // scale bar + readout
    const nice = [5, 10, 20, 50, 100, 200, 500].find((v) => v * s > W * 0.12) || 500;
    ctx.strokeStyle = C.text; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(16, H - 16); ctx.lineTo(16 + nice * s, H - 16); ctx.stroke();
    ctx.fillStyle = C.text; ctx.textAlign = 'left'; ctx.font = '12px system-ui'; ctx.fillText(`${nice} m`, 16, H - 28);
    ctx.textAlign = 'right'; ctx.fillText(st.mirror ? '' : 'flipped', W - 12, H - 16);
    if (st.inputs) {
      ctx.textAlign = 'left'; let x0 = 16;
      for (const [label, col] of [['Brake', C.crit], ['Partial throttle', C.warn], ['Full throttle', C.good], ['Coast', C.muted]]) {
        ctx.fillStyle = col; ctx.fillRect(x0, 14, 14, 4); ctx.fillStyle = C.text; ctx.fillText(label, x0 + 18, 17); x0 += ctx.measureText(label).width + 34;
      }
    }
  }

  function drawStrip(fis) {
    const [ctx, W, H] = fit(strip);
    const C = colors();
    const fc = cars[st.focus];
    const dc = smp(fc.trace.d, fis[st.focus]);
    const half = Math.max(80, st.zoom), d0 = dc - half, d1 = dc + half;
    const left = 64, pw = W - left - 8;
    const X = (d) => left + ((d - d0) / (d1 - d0)) * pw;
    const lanes = [['Speed', 'spd'], ['Throttle', 'thr'], ['Brake', 'brk'], ['Steering', 'str']];
    const lh = (H - 6) / lanes.length;
    // speed range in window
    let lo = Infinity, hi = -Infinity;
    for (const c of cars) { const a = idxAt(c.trace.d, d0), b = idxAt(c.trace.d, d1); for (let i = a; i <= b; i++) { lo = Math.min(lo, c.trace.spd[i]); hi = Math.max(hi, c.trace.spd[i]); } }
    lanes.forEach(([label, ch], li) => {
      const top = 3 + li * lh, bot = top + lh - 4;
      ctx.fillStyle = C.muted; ctx.font = '11px system-ui'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(label, 4, (top + bot) / 2);
      ctx.strokeStyle = C.grid; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(left, bot + 2); ctx.lineTo(W - 8, bot + 2); ctx.stroke();
      const Y = ch === 'spd' ? (v) => bot - ((v - lo) / ((hi - lo) || 1)) * (bot - top)
        : ch === 'str' ? (v) => (top + bot) / 2 - (v / strMax) * ((bot - top) / 2)
          : (v) => bot - v * (bot - top);
      for (let ci = cars.length - 1; ci >= 0; ci--) {
        const tr = cars[ci].trace, a = idxAt(tr.d, d0), b = idxAt(tr.d, d1);
        ctx.strokeStyle = cars[ci].color; ctx.lineWidth = ci === st.focus || ci === 0 ? 1.8 : 1.2;
        ctx.beginPath();
        for (let i = a; i <= b; i++) { const x = X(tr.d[i]), y = Y(tr[ch][i]); i === a ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
        ctx.stroke();
      }
    });
    // car position markers
    cars.forEach((c, ci) => {
      const x = X(smp(c.trace.d, fis[ci]));
      ctx.strokeStyle = ci === st.focus ? C.primary : c.color; ctx.lineWidth = 1; ctx.setLineDash(ci === st.focus ? [] : [3, 3]);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); ctx.setLineDash([]);
    });
  }

  function drawG(fis) {
    const [ctx, W, H] = fit(gc);
    const C = colors();
    const R = Math.min(W, H) / 2 - 6, cx = W / 2, cy = H / 2, maxG = 3;
    ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
    for (const g of [1, 2, 3]) { ctx.beginPath(); ctx.arc(cx, cy, (g / maxG) * R, 0, Math.PI * 2); ctx.stroke(); }
    ctx.beginPath(); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy); ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R); ctx.stroke();
    ctx.fillStyle = C.muted; ctx.font = '10px system-ui'; ctx.textAlign = 'center';
    ctx.fillText('accel / brake', cx, 10); ctx.textAlign = 'right'; ctx.fillText('lateral', W - 4, cy - 4);
    for (let ci = cars.length - 1; ci >= 0; ci--) {
      const tr = cars[ci].trace, fi = fis[ci];
      // short trail (≈0.5 s)
      ctx.strokeStyle = cars[ci].color; ctx.globalAlpha = 0.4; ctx.lineWidth = 1.5; ctx.beginPath();
      const i1 = Math.round(fi), i0 = Math.max(0, i1 - 25);
      for (let i = i0; i <= i1; i++) { const x = cx + (tr.glat[i] / maxG) * R, y = cy - (tr.glon[i] / maxG) * R; i === i0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
      ctx.stroke(); ctx.globalAlpha = 1;
      const gx = smp(tr.glat, fi), gy = smp(tr.glon, fi);
      ctx.fillStyle = cars[ci].color; ctx.strokeStyle = C.surface; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(cx + (gx / maxG) * R, cy - (gy / maxG) * R, 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
  }

  function updatePanel(fis) {
    const tRef = smp(ref.t, fis[0]), dRef = smp(ref.d, fis[0]);
    cars.forEach((c, ci) => {
      const tr = c.trace, fi = fis[ci];
      const t = smp(tr.t, fi), d = smp(tr.d, fi);
      const set = (k, html) => { const el = $(`#c-${k}-${ci}`); if (el.innerHTML !== html) el.innerHTML = html; };
      set('time', fmt(t));
      if (c.isRef) { set('delta', '<span class="muted">–</span>'); set('line', '<span class="muted">reference</span>'); }
      else {
        const dl = st.mode === 'pos' ? t - tRef : smp(c.delta, fi) * 1000;
        set('delta', `<span class="${dl > 5 ? 'pos' : dl < -5 ? 'neg' : ''}">${fmtGap(dl)}</span>`);
        set('line', sideTxt(smp(c.offset, fi), st.mirror));
      }
      set('gap', c.isRef ? '<span class="muted">–</span>' : st.mode === 'pos' ? '<span class="muted">0 m</span>' : `${d - dRef > 0 ? '+' : ''}${Math.round(d - dRef)} m`);
      set('speed', `<b>${Math.round(smp(tr.spd, fi))}</b> <small class="muted">km/h</small>`);
      set('gear', `<b>${gearTxt(tr.gear[Math.round(fi)])}</b> <small class="muted">${Math.round(smp(tr.rpm, fi))}</small>`);
      for (const k of ['thr', 'brk']) {
        const v = Math.max(0, Math.min(1, smp(tr[k], fi)));
        const el = $(`#c-${k}-${ci}`); el.firstChild.firstChild.style.width = `${v * 100}%`; el.lastChild.textContent = `${Math.round(v * 100)}%`;
      }
      const sv = Math.max(-1, Math.min(1, smp(tr.str, fi) / strMax));
      const bar = $(`#c-str-${ci}`).firstChild.firstChild;
      bar.style.left = sv < 0 ? `${50 + sv * 50}%` : '50%'; bar.style.width = `${Math.abs(sv) * 50}%`; bar.style.background = c.color;
    });
    $('#rpPos', root).textContent = `${fmt(st.T)} · ${Math.round(dRef)} m`;
    const sc = $('#scrub', root); if (document.activeElement !== sc) sc.value = Math.round(st.T);
  }

  // ---------------------------------------------------------------- loop
  let last = performance.now(), raf;
  const loop = (now) => {
    const dt = Math.min(100, now - last); last = now;
    if (st.playing) { st.T += dt * st.speed; if (st.T >= tEnd) { st.T = tEnd; setPlaying(false); } st.dirty = true; }
    if (st.dirty) {
      st.dirty = false;
      const fis = indices();
      drawTrack(fis); drawStrip(fis); drawG(fis); updatePanel(fis);
    }
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);

  // ---------------------------------------------------------------- controls
  const setPlaying = (p) => { st.playing = p; $('#play', root).textContent = p ? '❚❚ Pause' : '▶ Play'; };
  const step = (k) => {
    setPlaying(false);
    if (st.mode === 'pos') { const i = Math.max(0, Math.min(ref.t.length - 1, Math.round(invT(ref, st.T)) + k)); st.T = ref.t[i]; }
    else st.T = Math.max(0, Math.min(tEnd, st.T + k * TICK_MS));
    st.dirty = true;
  };
  const cornerStartT = (i) => {
    const r = data.ref.corners[i], c = data.corners[i];
    const d = Math.max(0, (r.brakePoint ?? r.liftPoint ?? c.start) - 60);
    return ref.t[idxAt(ref.d, d)];
  };
  const jumpCorner = (dir) => {
    const dNow = smp(ref.d, invT(ref, st.T));
    const starts = data.corners.map((c, i) => [i, smp(ref.d, invT(ref, cornerStartT(i)))]);
    const cand = dir > 0 ? starts.find(([, d]) => d > dNow + 5) : [...starts].reverse().find(([, d]) => d < dNow - 5);
    if (cand) { setPlaying(false); st.T = cornerStartT(cand[0]); st.dirty = true; }
  };
  const setZoom = (z) => { st.zoom = Math.max(30, Math.min(3000, z)); $('#zTxt', root).textContent = `${Math.round(st.zoom)} m`; st.dirty = true; savePrefs(); };
  const modeBtns = root.querySelectorAll('#rpMode button');
  const setMode = (m) => { st.mode = m; modeBtns.forEach((b) => b.classList.toggle('on', b.dataset.v === m)); st.dirty = true; savePrefs(); };

  modeBtns.forEach((b) => b.onclick = () => setMode(b.dataset.v));
  $('#rpInputs', root).checked = st.inputs; $('#rpInputs', root).onchange = (e) => { st.inputs = e.target.checked; st.dirty = true; savePrefs(); };
  $('#rpHead', root).checked = st.headingUp; $('#rpHead', root).onchange = (e) => { st.headingUp = e.target.checked; st.dirty = true; savePrefs(); };
  $('#rpMirror', root).checked = !st.mirror; $('#rpMirror', root).onchange = (e) => { st.mirror = !e.target.checked; setMirror(st.mirror); st.dirty = true; };
  if ($('#rpFocus', root)) $('#rpFocus', root).onchange = (e) => { st.focus = +e.target.value; st.dirty = true; };
  $('#zIn', root).onclick = () => setZoom(st.zoom / 1.4);
  $('#zOut', root).onclick = () => setZoom(st.zoom * 1.4);
  cv.addEventListener('wheel', (e) => { e.preventDefault(); setZoom(st.zoom * (e.deltaY > 0 ? 1.15 : 1 / 1.15)); }, { passive: false });
  $('#play', root).onclick = () => { if (!st.playing && st.T >= tEnd) st.T = 0; setPlaying(!st.playing); };
  $('#stepB', root).onclick = (e) => step(e.shiftKey ? -10 : -1);
  $('#stepF', root).onclick = (e) => step(e.shiftKey ? 10 : 1);
  $('#prevC', root).onclick = () => jumpCorner(-1);
  $('#nextC', root).onclick = () => jumpCorner(1);
  $('#speed', root).value = String(st.speed);
  $('#speed', root).onchange = (e) => { st.speed = +e.target.value; savePrefs(); };
  $('#scrub', root).oninput = (e) => { setPlaying(false); st.T = +e.target.value; st.dirty = true; };
  root.querySelectorAll('.rp-corners [data-c]').forEach((b) => b.onclick = () => { setPlaying(false); st.T = cornerStartT(+b.dataset.c); st.dirty = true; });

  const onKey = (e) => {
    if (e.target.matches('input:not([type=range]), select, textarea')) return;
    const k = e.key;
    if (k === ' ') { e.preventDefault(); $('#play', root).click(); }
    else if (k === 'ArrowRight') { e.preventDefault(); step(e.shiftKey ? 10 : 1); }
    else if (k === 'ArrowLeft') { e.preventDefault(); step(e.shiftKey ? -10 : -1); }
    else if (k === ']') jumpCorner(1);
    else if (k === '[') jumpCorner(-1);
    else if (k === '+' || k === '=') setZoom(st.zoom / 1.4);
    else if (k === '-') setZoom(st.zoom * 1.4);
  };
  const onResize = () => { st.dirty = true; };
  document.addEventListener('keydown', onKey);
  window.addEventListener('resize', onResize);
  cleanup.push(() => { cancelAnimationFrame(raf); document.removeEventListener('keydown', onKey); window.removeEventListener('resize', onResize); });

  setMode(st.mode); setZoom(st.zoom);
  // start at ?at=<metres>, otherwise just before the first corner's braking zone
  st.T = opts.at != null ? ref.t[idxAt(ref.d, opts.at)] : data.corners.length ? cornerStartT(0) : 0;
  st.dirty = true;
}
