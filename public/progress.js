// Progress view: one track + car over the days you drove it. Best lap of each day, the all-time best
// and the ideal lap as they stood that day, and how repeatable the day's laps were.
import { $, css, esc, api, fmt, fmtGap, prettyName } from './util.js';

const dayLabel = (day, long) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, long ? { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' } : { day: 'numeric', month: 'short' });
};
const sec = (ms) => (ms == null ? null : ms / 1000);

export async function viewProgress(view, params, cleanup) {
  const overview = await api('/api/overview');
  const combos = overview.combos.sort((a, b) => b.lastAt - a.lastAt);
  if (!combos.length) { view.innerHTML = '<div class="card empty"><h2>No laps yet</h2><p>Drive some laps first: progress is drawn per car and track, one point per day.</p></div>'; return; }
  const key = combos.some((c) => c.key === params.get('combo')) ? params.get('combo') : combos[0].key;
  const [track, layout, car] = key.split('|');
  const data = await api(`/api/progress?${new URLSearchParams({ track, layout, car })}`);
  const days = data.days;
  const timed = days.filter((d) => d.bestMs != null);
  const first = timed[0], last = timed[timed.length - 1];
  const gained = first && last ? last.allTimeBestMs - first.bestMs : null;
  const sds = days.filter((d) => d.sdMs != null);
  const sdTrend = sds.length >= 2 ? sds[sds.length - 1].sdMs - sds[0].sdMs : null;

  view.innerHTML = `
    <div class="cmp-head">
      <a href="#/"><button class="ghost">← Laps</button></a>
      <div><h1>Progress · ${esc(prettyName(track))} <span class="muted">${esc(prettyName(layout))}</span></h1>
        <div class="secondary">${esc(prettyName(car))}</div></div>
      <span class="spacer"></span>
      <label class="row">Car and track <select id="pCombo">${combos.map((c) => `<option value="${esc(c.key)}" ${c.key === key ? 'selected' : ''}>${esc(prettyName(c.track))} ${esc(prettyName(c.layout))} · ${esc(prettyName(c.car))}</option>`).join('')}</select></label>
    </div>
    ${!timed.length ? '<div class="card empty">No valid laps for this car and track yet.</div>' : `
    <div class="tiles">
      <div class="card stat"><span class="k">Best lap</span><span class="v">${fmt(data.bestMs)}</span></div>
      <div class="card stat"><span class="k">Ideal lap</span><span class="v">${fmt(data.idealMs)}</span></div>
      <div class="card stat"><span class="k">Since the first day</span><span class="v ${gained < 0 ? 'neg' : ''}">${timed.length > 1 ? fmtGap(gained) : '–'}</span></div>
      <div class="card stat"><span class="k">Days driven</span><span class="v">${days.length}</span></div>
      <div class="card stat"><span class="k">Laps</span><span class="v">${data.validLaps}<small class="muted"> valid / ${data.laps}</small></span></div>
      <div class="card stat"><span class="k">Spread, latest day</span><span class="v">${sds.length ? `±${(sds[sds.length - 1].sdMs / 1000).toFixed(3)}s` : '–'}${sdTrend != null ? ` <small class="${sdTrend < 0 ? 'neg' : sdTrend > 0 ? 'pos' : ''}">${fmtGap(sdTrend)}</small>` : ''}</span></div>
    </div>
    ${timed.length < 2 ? '<div class="card"><span class="muted">One day of laps so far. Drive this car here on another day and the trend appears.</span></div>' : ''}
    <div class="card"><div class="row" style="margin-bottom:6px"><h2 style="margin:0">Lap times by day</h2><span class="spacer"></span><div class="legend" id="pLegend"></div></div>
      <div id="pTimes"></div></div>
    <div class="card"><h2>Consistency by day</h2>
      <p class="muted" style="margin:0 0 8px;font-size:12px">Spread (σ) of the day's clean laps: valid laps within ${data.cleanWithinPct}% of that day's best. Lower = more repeatable. Needs 3 clean laps.</p>
      <div id="pSpread"></div></div>
    <div class="card"><h2>Days</h2><div class="tablewrap"><table>
      <thead><tr><th>Day</th><th>Laps</th><th>Best of the day</th><th>vs best before</th><th>All-time best</th><th>Ideal lap</th><th>Typical lap</th><th>Spread (σ)</th><th></th></tr></thead>
      <tbody>${[...days].reverse().map((d) => {
        const i = days.indexOf(d);
        const before = days.slice(0, i).map((x) => x.allTimeBestMs).filter((x) => x != null).pop() ?? null;
        const gap = d.bestMs != null && before != null ? d.bestMs - before : null;
        return `<tr><td><b>${esc(dayLabel(d.day, true))}</b></td>
          <td>${d.validLaps}<span class="muted"> valid / ${d.laps}</span></td>
          <td class="time"><b>${fmt(d.bestMs)}</b> ${d.newBest && i > 0 ? '<span class="badge best">new best</span>' : ''}</td>
          <td class="${gap == null ? 'muted' : gap < 0 ? 'neg' : gap > 0 ? 'pos' : ''}">${gap == null ? (d.bestMs != null ? 'first day' : '–') : fmtGap(gap)}</td>
          <td>${fmt(d.allTimeBestMs)}</td><td>${fmt(d.idealMs)}</td><td>${fmt(d.medianMs)}</td>
          <td>${d.sdMs != null ? `±${(d.sdMs / 1000).toFixed(3)}s` : `<span class="muted">${d.cleanLaps} clean</span>`}</td>
          <td class="actions">${d.bestLapId ? `<a href="#/compare?laps=${d.bestLapId}&ref=best"><button class="small ghost">Open best lap</button></a>` : ''}</td></tr>`;
      }).join('')}</tbody></table></div>
      <p class="muted" style="font-size:12px;margin:8px 0 0">Ideal lap = your fastest pass of every corner so far, put together. Typical lap = the middle one of the day's clean laps.</p>
    </div>`}`;

  $('#pCombo').onchange = (e) => { location.hash = `#/progress?combo=${encodeURIComponent(e.target.value)}`; };
  if (!timed.length) return;

  // ---------------- charts (uPlot), one point per driving day
  const xs = days.map((_, i) => i + 1);
  const axis = () => ({ stroke: css('--text-muted'), grid: { stroke: css('--grid'), width: 1 }, ticks: { stroke: css('--grid') }, font: '11px system-ui' });
  const xAxis = () => ({ ...axis(), values: (u, v) => v.map((x) => (Number.isInteger(x) && days[x - 1] ? dayLabel(days[x - 1].day) : '')) });
  const xScale = { time: false, range: () => [0.5, days.length + 0.5] };
  const padRange = (u, min, max) => { const p = Math.max((max - min) * 0.15, 0.05); return [min - p, max + p]; };
  const S = [
    { k: 'bestMs', label: 'Best of the day', color: css('--series-1'), width: 2, points: { size: 8, fill: css('--series-1') } },
    { k: 'allTimeBestMs', label: 'All-time best', color: css('--series-2'), width: 2, points: { show: false }, paths: uPlot.paths.stepped({ align: 1 }) },
    { k: 'idealMs', label: 'Ideal lap', color: css('--series-3'), width: 1.5, dash: [5, 4], points: { show: false }, paths: uPlot.paths.stepped({ align: 1 }) },
    { k: 'medianMs', label: 'Typical lap', color: css('--text-muted'), width: 1, points: { size: 5 } },
  ];
  $('#pLegend').innerHTML = S.map((s) => `<span class="row" style="gap:6px;font-size:12px"><i style="display:inline-block;width:14px;height:3px;border-radius:2px;background:${s.color}"></i>${s.label}</span>`).join('');
  const mkTip = (el) => { const t = document.createElement('div'); t.className = 'tip'; t.hidden = true; el.style.position = 'relative'; el.appendChild(t); return t; };

  const timesEl = $('#pTimes');
  const timesPlot = new uPlot({
    width: timesEl.clientWidth, height: 260, legend: { show: false }, cursor: { points: { size: 8 } },
    scales: { x: xScale, y: { range: padRange } },
    axes: [xAxis(), { ...axis(), size: 70, values: (u, v) => v.map((x) => fmt(x * 1000)) }],
    series: [{}, ...S.map((s) => ({ label: s.label, stroke: s.color, width: s.width, dash: s.dash, points: s.points, paths: s.paths, spanGaps: true }))],
    hooks: { setCursor: [(u) => {
      const i = u.cursor.idx; timesTip.hidden = i == null; if (i == null) return;
      const d = days[i];
      timesTip.innerHTML = `<b>${esc(dayLabel(d.day, true))}</b> · best ${fmt(d.bestMs)}${d.newBest && i > 0 ? ' <span class="neg">new best</span>' : ''} · all-time ${fmt(d.allTimeBestMs)} · ideal ${fmt(d.idealMs)} · ${d.validLaps} valid laps`;
      timesTip.style.left = `${Math.min(u.valToPos(i + 1, 'x') + 60, timesEl.clientWidth - 420)}px`;
    }] },
  }, [xs, ...S.map((s) => days.map((d) => sec(d[s.k])))], timesEl);
  const timesTip = mkTip(timesEl);
  timesEl.querySelector('.u-over').addEventListener('click', () => { const d = days[timesPlot.cursor.idx]; if (d?.bestLapId) location.hash = `#/compare?laps=${d.bestLapId}&ref=best`; });

  const spreadEl = $('#pSpread');
  const spreadPlot = new uPlot({
    width: spreadEl.clientWidth, height: 180, legend: { show: false }, cursor: { points: { size: 8 } },
    scales: { x: xScale, y: { range: (u, min, max) => [0, Math.max(0.1, (max || 0) * 1.25)] } },
    axes: [xAxis(), { ...axis(), size: 70, values: (u, v) => v.map((x) => `±${x.toFixed(2)}s`) }],
    series: [{}, { label: 'Spread', stroke: css('--series-4'), width: 2, points: { size: 8, fill: css('--series-4') }, spanGaps: true }],
    hooks: { setCursor: [(u) => {
      const i = u.cursor.idx; spreadTip.hidden = i == null; if (i == null) return;
      const d = days[i];
      spreadTip.innerHTML = `<b>${esc(dayLabel(d.day, true))}</b> · ${d.sdMs != null ? `±${(d.sdMs / 1000).toFixed(3)}s over ${d.cleanLaps} clean laps` : `only ${d.cleanLaps} clean lap${d.cleanLaps === 1 ? '' : 's'}`}`;
      spreadTip.style.left = `${Math.min(u.valToPos(i + 1, 'x') + 60, spreadEl.clientWidth - 320)}px`;
    }] },
  }, [xs, days.map((d) => sec(d.sdMs))], spreadEl);
  const spreadTip = mkTip(spreadEl);

  const onResize = () => { timesPlot.setSize({ width: timesEl.clientWidth, height: 260 }); spreadPlot.setSize({ width: spreadEl.clientWidth, height: 180 }); };
  window.addEventListener('resize', onResize);
  cleanup.push(() => { window.removeEventListener('resize', onResize); timesPlot.destroy(); spreadPlot.destroy(); });
}
