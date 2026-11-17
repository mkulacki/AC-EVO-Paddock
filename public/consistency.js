// Consistency view: lap-to-lap spread per corner for one track + car.
import { $, css, esc, api, fmt, fmtGap, prettyName, SESSION_TYPES, stats, emptyHtml, prov } from './util.js';

const METRICS = [
  { k: 'timeMs', label: 'Corner time', unit: 'ms', hint: 'time through the corner segment; left = faster', lowerBetter: true },
  { k: 'brakePoint', label: 'Brake point', unit: 'm', hint: '+ = braking later' },
  { k: 'minSpeed', label: 'Min speed', unit: 'km/h', hint: '+ = more speed through the apex' },
  { k: 'throttlePickup', label: 'Throttle on', unit: 'm', hint: '− = back on throttle earlier' },
  { k: 'exitSpeed', label: 'Exit speed', unit: 'km/h', hint: '+ = faster exit' },
  { k: 'entryWide', label: 'Line at turn-in', unit: 'm', hint: 'Against your best lap line: positive is wider (outside), negative is tighter' },
  { k: 'apexWide', label: 'Line at apex', unit: 'm', hint: 'Against your best lap line: positive is wider (outside), negative is tighter' },
  { k: 'exitWide', label: 'Line at exit', unit: 'm', hint: 'Against your best lap line: positive is wider (outside), negative is tighter' },
];

export async function viewConsistency(view, params, cleanup) {
  const [track, layout, car] = (params.get('combo') || '').split('|');
  const session = params.get('session') || 'all';
  const invalid = params.get('invalid') === '1';
  let metric = params.get('metric') || 'timeMs';
  const q = new URLSearchParams({ track, layout, car, session, invalid: invalid ? '1' : '0' });
  let data;
  try { data = await api(`/api/consistency?${q}`); } catch (e) {
    // no valid lap on this track with this car yet: nothing to compare, which is not an error (src/service.js consistency)
    if (!/^No valid laps/.test(e.message)) throw e;
    view.innerHTML = emptyHtml('No valid laps yet', `Consistency compares your valid laps with this car on ${esc(prettyName(track))} ${esc(prettyName(layout))}. Drive at least two clean laps first.`, '<a href="#/"><button>Sessions</button></a>');
    return;
  }
  const laps = data.laps;
  // the technique metrics (src/analysis.js TECHNIQUE) join the spread chart; coasting is there once
  for (const [k, t] of Object.entries(data.technique || {})) if (!METRICS.some((m) => m.k === k)) METRICS.push({ k, label: t.label, unit: t.unit, hint: t.def.replace(/\.$/, '') });
  if (!METRICS.some((m) => m.k === metric)) metric = 'timeMs';
  const nav = (patch) => {
    const p = new URLSearchParams({ combo: params.get('combo'), session, invalid: invalid ? '1' : '0', metric, ...patch });
    location.hash = `#/consistency?${p}`;
  };

  const times = stats(laps.map((l) => l.lapTimeMs));
  // per-corner stats
  const corners = data.corners.map((c, i) => {
    const s = {};
    for (const m of METRICS) s[m.k] = stats(laps.map((l) => l.corners[i][m.k]));
    const opp = s.timeMs ? s.timeMs.mean - s.timeMs.min : 0; // avg time left vs your fastest pass
    return { ...c, s, opp };
  });
  const focus = [...corners].sort((a, b) => b.opp - a.opp).slice(0, 3).filter((c) => c.opp > 20).map((c) => c.n);

  view.innerHTML = `
    <div class="cmp-head">
      <a href="#/"><button class="ghost">Back to laps</button></a>
      <div><h1>Consistency at ${esc(prettyName(track))} <span class="muted">${esc(prettyName(layout))}</span></h1>
        <div class="secondary">${esc(prettyName(car))}</div></div>
      <span class="spacer"></span>
      <label class="row">Session <select id="sess"><option value="all">All sessions</option>
        ${data.sessions.map((s) => `<option value="${s.id}">${SESSION_TYPES[s.type] || 'Session'} on ${new Date(s.startedAt).toLocaleString()}</option>`).join('')}</select></label>
      <label class="row"><input type="checkbox" id="inv" ${invalid ? 'checked' : ''}> Include invalid laps</label>
    </div>
    ${laps.length < 2 ? '<div class="card empty">Drive at least 2 laps here to see how consistent you are.</div>' : `
    <div class="tiles">
      <div class="card stat"><span class="k">Laps</span><span class="v">${laps.length}</span></div>
      <div class="card stat"><span class="k">Best</span><span class="v">${fmt(times.min)}</span></div>
      <div class="card stat"><span class="k">Average</span><span class="v">${fmt(times.mean)}</span></div>
      <div class="card stat"><span class="k">Spread (σ)</span><span class="v">±${(times.sd / 1000).toFixed(3)}s</span></div>
      <div class="card stat"><span class="k">Ideal lap</span><span class="v">${fmt(data.idealMs)}</span></div>
      <div class="card stat"><span class="k">Average to ideal</span><span class="v pos">${fmtGap(times.mean - data.idealMs)}</span></div>
    </div>
    ${focus.length ? `<div class="card"><h2>Focus corners</h2><p class="secondary" style="margin:0">On average you lose the most time compared with your own fastest pass in
      ${focus.map((n) => { const c = corners.find((x) => x.n === n); return `<b>${c.name}</b> (${(c.opp / 1000).toFixed(3)}s)`; }).join(', ')}.
      Make these corners repeatable before chasing a faster line elsewhere.</p></div>` : ''}
    ${scoreCard(data)}
    ${rankingsCard(data, laps)}
    ${techniqueCard(data, laps)}
    <div class="card"><h2>Lap time trend</h2><div id="trend"></div></div>
    <div class="card"><div class="row" style="margin-bottom:8px"><h2 style="margin:0">Spread per corner</h2><span class="spacer"></span>
      <label class="row">Metric <select id="metric">${METRICS.map((m) => `<option value="${m.k}" ${m.k === metric ? 'selected' : ''}>${m.label}</option>`).join('')}</select></label></div>
      <p class="muted" style="margin:0 0 8px;font-size:12px" id="mhint"></p>
      <div id="strip"></div></div>
    <div class="card"><h2>Corner summary</h2><div style="overflow:auto"><table>
      <thead><tr><th>Corner</th><th>Avg time left</th><th>Corner time σ</th><th>Brake point σ</th><th>Min speed σ</th><th>Throttle on σ</th><th>Exit speed σ</th><th>Apex line σ</th></tr></thead>
      <tbody>${corners.map((c) => {
        const sd = (k, unit, d = 1) => (c.s[k] ? `${c.s[k].sd.toFixed(d)} ${unit}` : '–');
        return `<tr><td><b>${c.name}</b> ${focus.includes(c.n) ? '<span class="badge bad">Focus</span>' : ''}</td>
          <td class="${c.opp > 50 ? 'pos' : ''}">${(c.opp / 1000).toFixed(3)}s</td>
          <td>${sd('timeMs', 'ms', 0)}</td><td>${sd('brakePoint', 'm')}</td><td>${sd('minSpeed', 'km/h')}</td>
          <td>${sd('throttlePickup', 'm')}</td><td>${sd('exitSpeed', 'km/h')}</td><td>${sd('apexWide', 'm', 2)}</td></tr>`;
      }).join('')}</tbody></table></div>
      <p class="muted" style="font-size:12px;margin:8px 0 0">σ = standard deviation across laps (lower = more consistent). “Avg time left” = average corner time minus your fastest time through that corner.</p>
    </div>`}`;

  $('#sess').value = session;
  $('#sess').onchange = (e) => nav({ session: e.target.value });
  $('#inv').onchange = (e) => nav({ invalid: e.target.checked ? '1' : '0' });
  if (laps.length < 2) return;
  $('#metric').onchange = (e) => { metric = e.target.value; drawStrip(); history.replaceState(null, '', `#/consistency?${new URLSearchParams({ combo: params.get('combo'), session, invalid: invalid ? '1' : '0', metric })}`); };

  // ---------------- lap time trend (uPlot)
  const xs = laps.map((_, i) => i + 1);
  const trendEl = $('#trend');
  const axis = () => ({ stroke: css('--text-muted'), grid: { stroke: css('--grid'), width: 1 }, ticks: { stroke: css('--grid') }, font: '11px system-ui' });
  const plot = new uPlot({
    width: trendEl.clientWidth, height: 200, legend: { show: false },
    cursor: { points: { size: 8 } },
    scales: { x: { time: false } },
    axes: [{ ...axis(), values: (u, v) => v.map((x) => (Number.isInteger(x) ? `#${x}` : '')) }, { ...axis(), size: 70, values: (u, v) => v.map((x) => fmt(x * 1000)) }],
    series: [{}, { label: 'Lap time', stroke: css('--series-1'), width: 2, points: { size: 7, fill: css('--series-1') } },
      { label: 'Best', stroke: css('--text-muted'), width: 1, dash: [4, 4], points: { show: false } }],
    hooks: {
      setCursor: [(u) => {
        const i = u.cursor.idx;
        tip.hidden = i == null;
        if (i == null) return;
        const l = laps[i];
        tip.innerHTML = `Lap #${l.id}: <b>${fmt(l.lapTimeMs)}</b> ${l.valid ? '' : '(invalid)'} <span class="${l.lapTimeMs - times.min > 0 ? 'pos' : ''}">${fmtGap(l.lapTimeMs - times.min)}</span>`;
        tip.style.left = `${u.valToPos(i + 1, 'x') + 50}px`;
      }],
    },
  }, [xs, laps.map((l) => l.lapTimeMs / 1000), laps.map(() => times.min / 1000)], trendEl);
  const tip = document.createElement('div'); tip.className = 'tip'; tip.hidden = true; trendEl.style.position = 'relative'; trendEl.appendChild(tip);
  trendEl.querySelector('.u-over').addEventListener('click', () => { const i = plot.cursor.idx; if (i != null) location.hash = `#/compare?laps=${laps[i].id}&ref=best`; });
  const onResize = () => { plot.setSize({ width: trendEl.clientWidth, height: 200 }); drawStrip(); };
  window.addEventListener('resize', onResize);
  cleanup.push(() => { window.removeEventListener('resize', onResize); plot.destroy(); });

  // ---------------- dot strip per corner (SVG)
  function drawStrip() {
    const m = METRICS.find((x) => x.k === metric);
    $('#mhint').textContent = `${m.label}: each dot is one lap, shown relative to the median for that corner (${m.unit}). ${m.hint}. Bar = middle 50% of laps. Ringed dot = best lap. Click a dot to open that lap.`;
    const W = $('#strip').clientWidth, rowH = 30, left = 70, right = 90, top = 24;
    const rows = corners.map((c, i) => {
      const vals = laps.map((l) => ({ l, v: l.corners[i][metric] })).filter((x) => x.v != null);
      const s = c.s[metric];
      return { c, s, vals: s ? vals.map((x) => ({ ...x, r: x.v - s.median })) : [] };
    });
    let ext = 0;
    for (const r of rows) for (const v of r.vals) ext = Math.max(ext, Math.abs(v.r));
    ext = ext || 1;
    const X = (r) => left + ((r + ext) / (2 * ext)) * (W - left - right);
    const H = top + rows.length * rowH + 8;
    const colDot = css('--series-1'), colAccent = css('--series-2');
    let svg = `<svg width="${W}" height="${H}" class="strip">`;
    svg += `<line x1="${X(0)}" x2="${X(0)}" y1="${top - 6}" y2="${H - 4}" stroke="${css('--axis')}" />`;
    for (const t of [-ext, -ext / 2, ext / 2, ext]) svg += `<text x="${X(t)}" y="12" text-anchor="middle" class="ax">${t > 0 ? '+' : ''}${Math.abs(ext) >= 10 ? Math.round(t) : t.toFixed(1)}</text>`;
    svg += `<text x="${X(0)}" y="12" text-anchor="middle" class="ax">median (${m.unit})</text>`;
    rows.forEach((r, ri) => {
      const y = top + ri * rowH + rowH / 2;
      svg += `<text x="8" y="${y + 4}" class="lbl">${r.c.name}</text>`;
      svg += `<line x1="${left}" x2="${W - right}" y1="${y}" y2="${y}" stroke="${css('--grid')}" />`;
      if (!r.s) { svg += `<text x="${left + 4}" y="${y + 4}" class="ax">no data</text>`; return; }
      svg += `<rect x="${X(r.s.q1 - r.s.median)}" y="${y - 5}" width="${Math.max(2, X(r.s.q3 - r.s.median) - X(r.s.q1 - r.s.median))}" height="10" rx="3" fill="${css('--surface-2')}" stroke="${css('--axis')}" />`;
      for (const v of [...r.vals].sort((a, b) => a.l.isBest - b.l.isBest)) { // best lap drawn last (on top)
        const best = v.l.isBest;
        svg += `<circle cx="${X(v.r)}" cy="${y}" r="${best ? 6 : 4.5}" fill="${best ? colAccent : colDot}" fill-opacity="${best ? 1 : 0.6}" ${best ? `stroke="${css('--text-primary')}" stroke-width="1.5"` : ''} data-lap="${v.l.id}">
          <title>Lap #${v.l.id}${best ? ' (best lap)' : ''}: ${v.v}${m.unit === 'ms' ? ' ms' : ' ' + m.unit} (${v.r > 0 ? '+' : ''}${Math.round(v.r * 10) / 10} vs median)</title></circle>`;
      }
      svg += `<text x="${W - right + 8}" y="${y + 4}" class="ax">σ ${r.s.sd.toFixed(m.unit === 'ms' ? 0 : m.unit === 'm' && metric.endsWith('Wide') ? 2 : 1)} ${m.unit}</text>`;
    });
    svg += '</svg>';
    $('#strip').innerHTML = svg;
    $('#strip').querySelectorAll('circle[data-lap]').forEach((el) => el.onclick = () => { location.hash = `#/compare?laps=${el.dataset.lap}&ref=best`; });
  }
  drawStrip();
}

const tipOf = (def) => esc(def);
// the true median (the middle two averaged), the same as the session report's "typical" value
const median = (vals) => {
  const v = vals.filter((x) => x != null && isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
const valTxt = (v, unit) => (v == null ? '–' : unit === 'ms' ? (v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(2)} s`) : `${Math.round(v * 10) / 10}${unit ? ` ${unit}` : ''}`);

// Performance score of the laps in view, with its formula (src/analysis.js performanceScore)
function scoreCard(data) {
  const s = data.score;
  if (!s) return '';
  const part = (k, v, tip) => `<div class="card stat" title="${esc(tip)}"><span class="k">${k}</span><span class="v">${v ?? '–'}</span></div>`;
  return `<div class="card"><div class="row"><h2 style="margin:0">Performance score ${prov('calculated', 'From your lap times and the ideal lap.')}</h2><span class="spacer"></span>
      <span class="muted" style="font-size:12px">${s.laps} lap${s.laps === 1 ? '' : 's'} in view${s.clean != null ? `, ${s.clean} clean` : ''}</span></div>
    ${s.score == null ? `<p class="muted" style="margin:8px 0 0">No score yet: ${esc(s.reason)}.</p>` : `<div class="tiles" style="margin:10px 0 0">
      ${part('Score', `${s.score}<span class="muted" style="font-size:13px"> / 100</span>`, 'The weighted sum of the three parts.')}
      ${part('Pace · 50 %', s.pace, `Median clean lap ${fmt(s.medianMs)} against the ideal lap ${fmt(s.idealMs)}.`)}
      ${part('Consistency · 30 %', s.consistency, `Spread of the clean laps: ±${(s.sdMs / 1000).toFixed(3)} s.`)}
      ${part('Validity · 20 %', s.validity, 'Share of valid laps.')}</div>`}
    <p class="muted" style="font-size:12px;margin:8px 0 0">${esc(data.scoreFormula)}</p></div>`;
}

// Corner rankings: per corner the fastest, the middle and the slowest of your passes, each a link to that lap
function rankingsCard(data, laps) {
  if (laps.length < 2) return '';
  const link = (p) => (p ? `<a href="#/compare?laps=${p.l.id}&ref=best" title="Open lap #${p.l.id} against your best lap">${(p.v / 1000).toFixed(3)} s</a> <span class="muted">#${p.l.id}</span>` : '–');
  const rows = data.corners.map((c, i) => {
    const passes = laps.map((l) => ({ l, v: l.corners[i].timeMs })).filter((p) => p.v != null).sort((a, b) => a.v - b.v);
    return { c, passes, best: passes[0], mid: passes[(passes.length - 1) >> 1], worst: passes[passes.length - 1] };
  });
  return `<details class="card" open><summary><b>Corner rankings</b> <span class="muted" style="font-size:12px">all your passes of each corner, fastest to slowest · click a time to open that lap</span></summary>
    <div class="tablewrap" style="margin-top:8px"><table>
    <thead><tr><th>Corner</th><th>Passes</th><th>Fastest</th><th>Middle</th><th>Slowest</th><th title="Slowest minus fastest pass">Range</th></tr></thead>
    <tbody>${rows.map((r) => `<tr><td><b>${esc(r.c.name)}</b></td><td>${r.passes.length}</td><td>${link(r.best)}</td><td>${link(r.mid)}</td><td>${link(r.worst)}</td>
      <td class="${r.best && r.worst.v - r.best.v > 100 ? 'pos' : ''}">${r.best ? fmtGap(r.worst.v - r.best.v) : '–'}</td></tr>`).join('')}</tbody></table></div></details>`;
}

// Technique per corner: your typical (median) value, and in brackets the value of your fastest pass of that corner
function techniqueCard(data, laps) {
  const T = Object.entries(data.technique || {});
  if (laps.length < 2 || !T.length) return '';
  const rows = data.corners.map((c, i) => {
    const fastest = laps.reduce((a, l) => (l.corners[i].timeMs != null && (!a || l.corners[i].timeMs < a.corners[i].timeMs) ? l : a), null);
    return { c, i, fastest, vals: Object.fromEntries(T.map(([k]) => [k, median(laps.map((l) => l.corners[i][k]))])) };
  });
  return `<details class="card"><summary><b>Driving technique</b> ${prov('calculated', 'From your pedals and steering, which are checked against the game.')}
    <span class="muted" style="font-size:12px">your typical value · (your fastest pass of that corner) · hover a heading for how it is measured</span></summary>
    <div class="tablewrap" style="margin-top:8px"><table class="technique">
    <thead><tr><th>Corner</th>${T.map(([, t]) => `<th title="${tipOf(t.def)}">${esc(t.label)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr><td><b>${esc(r.c.name)}</b></td>${T.map(([k, t]) => {
      const s = r.vals[k], f = r.fastest?.corners[r.i][k];
      return `<td title="${tipOf(t.def)}">${valTxt(s, t.unit)} <span class="muted">(${valTxt(f, t.unit)})</span></td>`;
    }).join('')}</tr>`).join('')}</tbody></table></div>
    <p class="muted" style="font-size:12px;margin:8px 0 0">The limits are relative to each pass (its own peak brake pressure and steering lock), so they suit any car. Choose a technique metric under “Spread per corner” to see every lap.</p></details>`;
}
