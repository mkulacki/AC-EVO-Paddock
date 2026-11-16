// Session reports: made automatically when a session ends (3+ laps, one valid), or on request for older sessions.
// Best lap and average, change against earlier sessions, best / weakest corners, consistency, setups and
// conditions, lap-time trend, theoretical best, track limits, next practice targets and the AI debrief.
import { $, css, esc, api, post, fmt, fmtGap, prettyName, SESSION_TYPES, md } from './util.js';

const when = (t) => new Date(t).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const s3 = (ms) => (ms == null ? '–' : `${(ms / 1000).toFixed(3)} s`);
const pm = (ms) => (ms == null ? '–' : `±${(ms / 1000).toFixed(3)} s`);
const cls = (d) => (d == null ? 'muted' : d < 0 ? 'neg' : d > 0 ? 'pos' : '');
const comboTxt = (c) => `${esc(prettyName(c.track))} <span class="muted">${esc(prettyName(c.layout))}</span>`;
const MATCH = {
  matched: ['Recognised', 'The car matched this saved setup when it stood in the pits'],
  standard: ['Standard', 'The car matched none of your saved setups for this car and track'],
  guess: ['Best guess', 'The shared-memory readings did not look right, so this is the setup you saved most recently'],
  manual: ['Set by you', 'You picked this setup in the report'],
};

// ================================================================== list
export async function viewReports(view) {
  const { reports, sessions } = await api('/api/reports');
  view.innerHTML = `
    <div class="row" style="margin-bottom:6px"><h1>Session reports</h1></div>
    <p class="muted" style="margin:0 0 16px;max-width:80ch">A report is made when you leave a session with at least 3 laps, one of them valid.
      Older or shorter sessions get one on request.</p>
    ${reports.length ? `<div class="card"><div class="tablewrap"><table>
      <thead><tr><th>Session</th><th>Track</th><th>Car</th><th>Best lap</th><th>Average</th><th>Laps</th><th></th></tr></thead>
      <tbody>${reports.map((r) => `<tr data-open="#/report?session=${r.sessionId}" style="cursor:pointer">
        <td style="white-space:nowrap">${esc(when(r.startedAt))}</td><td>${comboTxt(r.combo)}</td><td class="secondary">${esc(prettyName(r.combo.car))}</td>
        <td class="time"><b>${fmt(r.bestMs)}</b> ${r.newPb ? '<span class="badge best">New PB</span>' : ''}</td><td>${fmt(r.avgMs)}</td>
        <td>${r.laps.valid}<span class="muted"> valid / ${r.laps.total}</span></td>
        <td class="actions"><a href="#/report?session=${r.sessionId}"><button class="small">Open</button></a></td></tr>`).join('')}</tbody></table></div></div>`
      : '<div class="card empty"><h2>No reports yet</h2><p>Drive a session of 3 laps or more; the report appears here when you leave it.</p></div>'}
    ${sessions.length ? `<div class="card"><h2>Sessions without a report</h2><div class="tablewrap"><table>
      <thead><tr><th>Session</th><th>Track</th><th>Car</th><th>Laps</th><th></th></tr></thead>
      <tbody>${sessions.map((s) => `<tr><td style="white-space:nowrap">${esc(when(s.startedAt))}</td><td>${comboTxt(s.combo)}</td>
        <td class="secondary">${esc(prettyName(s.combo.car))}</td><td>${s.valid}<span class="muted"> valid / ${s.laps}</span></td>
        <td class="actions"><a href="#/report?session=${s.sessionId}"><button class="small ghost">Make report</button></a></td></tr>`).join('')}</tbody></table></div></div>` : ''}`;
  view.querySelectorAll('tr[data-open]').forEach((tr) => { tr.onclick = (e) => { if (!e.target.closest('a')) location.hash = tr.dataset.open; }; });
}

// ================================================================== one report
export async function viewReport(view, params, cleanup) {
  const id = Number(params.get('session'));
  const res = await api(`/api/report?session=${id}`);
  const r = res.data, imp = r.improvement, cons = r.consistency;
  const cornerBy = new Map(r.corners.all.map((c) => [c.name, c]));
  const prevTxt = imp.prev ? `previous session (${when(imp.prev.startedAt)})` : null;

  const improvementRows = [
    ['Best lap', r.best.ms, imp.prev?.bestMs, imp.bestDeltaMs, fmt],
    ['Average (clean laps)', r.average.cleanMs, imp.prev?.avgMs, imp.avgDeltaMs, fmt],
    ['Spread (σ)', cons.sdMs, imp.prev?.sdMs, imp.sdDeltaMs, pm],
  ];
  const cornerCard = (title, names, weak) => `<div class="card"><h2>${title}</h2>${names.length ? names.map((w) => {
    const name = weak ? w.name : w;
    const c = cornerBy.get(name);
    return `<div style="padding:8px 0;border-top:1px solid var(--border)">
      <div class="row"><b style="font-size:16px">${esc(name)}</b><span class="muted" style="font-size:12px">apex ${c.apex} m</span><span class="spacer"></span>
        <span title="Typical time through the corner today, against your fastest pass ever">${s3(c.medianMs)} <small class="${c.gapMs > 0 ? 'pos' : 'neg'}">${fmtGap(c.gapMs)}</small></span></div>
      <div class="muted" style="font-size:12px">fastest ever ${s3(c.bestEverMs)}${c.changeMs != null ? ` · <span class="${cls(c.changeMs)}">${fmtGap(c.changeMs)}</span> against last session` : ''}</div>
      ${weak && w.reasons.length ? `<ul style="margin:6px 0 0 18px;padding:0">${w.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    </div>`;
  }).join('') : '<p class="muted">Not enough laps through the corners yet.</p>'}</div>`;

  const setupCard = () => `<div class="card"><h2>Setup${r.setups.length > 1 ? 's' : ''} used</h2>
    ${res.probeConfirmed ? '' : '<p class="muted" style="font-size:12px;margin:0 0 8px">Setup recognition has not been checked in the game yet. Check it once in the <a href="#/setups">Setups</a> tab (stand in the pit box with a saved setup loaded).</p>'}
    ${r.setups.map((s, i) => {
      const [label, tip] = s.name == null ? ['Not recorded', 'Laps recorded before Paddock linked setups to laps'] : MATCH[s.match] || ['', ''];
      const vals = s.values ? Object.entries(s.values) : [];
      return `<div style="padding:8px 0;border-top:1px solid var(--border)">
        <div class="row"><b style="font-size:16px">${esc(s.name ?? 'Unknown')}</b>${label ? `<span class="badge${s.match === 'matched' || s.match === 'manual' ? ' accent' : ''}" title="${esc(tip)}">${esc(label)}</span>` : ''}
          <span class="muted">laps ${s.laps[0]}${s.laps.length > 1 ? `–${s.laps[s.laps.length - 1]}` : ''}</span><span class="spacer"></span>
          <span>best ${fmt(s.bestMs)}</span></div>
        ${vals.length ? `<div class="muted" style="font-size:12px;margin-top:4px">${vals.map(([k, v]) => `${esc(k.replace(/_/g, ' '))} <b>${esc(String(v))}</b>`).join(' · ')}</div>` : ''}
        <div class="row" style="margin-top:6px;font-size:12px"><label class="row">Not right? <select data-seg="${i}">
          ${s.name == null ? '<option value="-" selected disabled>Choose the setup…</option>' : ''}<option value="" ${s.name === 'Standard' ? 'selected' : ''}>Standard</option>${res.setupChoices.map((c) => `<option value="${esc(c.rel)}" ${c.rel === s.rel ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
          ${s.rel && !res.setupChoices.some((c) => c.rel === s.rel) ? `<option value="${esc(s.rel)}" selected>${esc(s.name)} (file gone)</option>` : ''}
        </select></label>${s.id ? `<a href="#/setups?id=${encodeURIComponent(s.id)}">Open in Setups</a>` : ''}</div>
      </div>`;
    }).join('')}</div>`;

  const c = r.conditions;
  const temp = (t) => (t ? `${t.avg} °C${t.max - t.min >= 1 ? ` <span class="muted">(${t.min}–${t.max})</span>` : ''}` : '<span class="muted">not read</span>');
  const conditionsCard = `<div class="card"><h2>Conditions</h2>
    ${c?.launch ? `<p style="margin:0 0 6px"><b>${esc(c.launch.weather)}</b>${c.launch.dynamic ? ' (changing)' : ''} · grip ${esc(c.launch.grip)} · start ${esc(c.launch.time)} · ${esc(c.launch.mode)}</p>`
      : '<p class="muted" style="margin:0 0 6px">Weather and grip are known for sessions started from the Race tab.</p>'}
    <p style="margin:0">Air ${temp(c?.airC)} · Track ${temp(c?.roadC)}</p>
    ${res.probeConfirmed || !(c?.airC || c?.roadC) ? '' : '<p class="muted" style="font-size:12px;margin:6px 0 0">Temperatures are read from shared memory and not confirmed in game yet.</p>'}</div>`;

  const tl = r.trackLimits;
  const limitsCard = `<div class="card"><h2>Track limits</h2>${!tl.invalid ? '<p class="neg" style="margin:0">No invalid laps.</p>'
    : `<p style="margin:0 0 6px">${tl.invalid} invalid lap${tl.invalid === 1 ? '' : 's'} of ${r.laps.total}.</p>
      ${tl.byCorner.length ? `<ul style="margin:0 0 0 18px;padding:0">${tl.byCorner.map((x) => `<li><b>${esc(x.name)}</b>: ${x.n} lap${x.n === 1 ? '' : 's'}</li>`).join('')}</ul>` : ''}
      ${tl.unknown ? `<p class="muted" style="font-size:12px;margin:6px 0 0">${tl.unknown} lap${tl.unknown === 1 ? '' : 's'} without the data to tell where.</p>` : ''}`}</div>`;

  view.innerHTML = `
    <div class="cmp-head">
      <a href="#/reports"><button class="ghost">All reports</button></a>
      <div><h1>${comboTxt(r.combo)}</h1>
        <div class="secondary">${esc(prettyName(r.combo.car))} · ${esc(SESSION_TYPES[r.sessionType] || 'Session')} on ${esc(when(r.startedAt))}</div></div>
      <span class="spacer"></span>
      <a href="#/compare?laps=${r.best.lapId}&ref=best"><button>Open best lap</button></a>
      <a href="#/consistency?combo=${encodeURIComponent(`${r.combo.track}|${r.combo.layout}|${r.combo.car}`)}&session=${id}"><button>Consistency</button></a>
      <button class="ghost" id="rRegen" title="Build the report again from the laps (keeps nothing but the AI debrief)">Regenerate</button>
    </div>
    <div class="tiles">
      <div class="card stat"><span class="k">Best lap${r.best.lapNumber != null ? ` (lap ${r.best.lapNumber})` : ''}</span><span class="v best">${fmt(r.best.ms)}</span>
        ${imp.newPb ? `<span class="badge best" style="align-self:flex-start;margin-top:4px">New PB ${fmtGap(imp.pbDeltaMs)}</span>` : imp.firstSession ? '<span class="muted" style="font-size:12px">first session here</span>' : `<span class="muted" style="font-size:12px">PB ${fmt(imp.allTimeBeforeMs)} <span class="${cls(imp.pbDeltaMs)}">${fmtGap(imp.pbDeltaMs)}</span></span>`}</div>
      <div class="card stat"><span class="k">Session average</span><span class="v">${fmt(r.average.cleanMs)}</span><span class="muted" style="font-size:12px">${r.laps.clean} clean laps · all valid ${fmt(r.average.validMs)}</span></div>
      <div class="card stat"><span class="k">Against last session</span><span class="v ${cls(imp.bestDeltaMs)}">${imp.prev ? fmtGap(imp.bestDeltaMs) : '–'}</span><span class="muted" style="font-size:12px">${imp.prev ? `average <span class="${cls(imp.avgDeltaMs)}">${fmtGap(imp.avgDeltaMs)}</span>` : 'no earlier session'}</span></div>
      <div class="card stat"><span class="k">Theoretical best</span><span class="v">${fmt(r.theoretical?.ms)}</span><span class="muted" style="font-size:12px" title="Your best pass of every corner in this session, put together">${r.theoretical ? `${s3(r.theoretical.gapMs)} left on the table` : ''}</span></div>
      <div class="card stat"><span class="k">Consistency</span><span class="v">${cons.score ?? '–'}<small class="muted">${cons.score != null ? ' / 100' : ''}</small></span><span class="muted" style="font-size:12px">${cons.sdMs != null ? `spread ${pm(cons.sdMs)}` : 'needs 3 clean laps'}</span></div>
      <div class="card stat"><span class="k">Laps</span><span class="v">${r.laps.valid}<small class="muted"> valid / ${r.laps.total}</small></span></div>
    </div>

    <div class="card"><h2>Next practice targets</h2><ol style="margin:0 0 0 20px;padding:0">${r.targets.map((t) => `<li style="margin:4px 0">${esc(t.text)}</li>`).join('')}</ol>
      ${r.prevTargets ? `<h3 style="margin:14px 0 6px">Last session's targets</h3><ul style="list-style:none;margin:0;padding:0">${r.prevTargets.items.map((t) => `<li style="margin:4px 0">
        <span class="${t.met ? 'neg' : t.met === false ? 'pos' : 'muted'}" style="font-weight:700">${t.met ? '✔' : t.met === false ? '✘' : '·'}</span> ${esc(t.text)} <span class="muted">: ${esc(t.actual)}</span></li>`).join('')}</ul>` : ''}
    </div>

    <div class="card"><h2>Improvement</h2>${imp.prev ? `<div class="tablewrap"><table>
      <thead><tr><th></th><th>This session</th><th>${esc(prevTxt)}</th><th>Change</th></tr></thead>
      <tbody>${improvementRows.map(([k, a, b, d, f]) => `<tr><td>${k}</td><td><b>${f(a)}</b></td><td>${f(b)}</td><td class="${cls(d)}">${d == null ? '–' : fmtGap(d)}</td></tr>`).join('')}
      <tr><td>All-time best before this session</td><td colspan="2">${fmt(imp.allTimeBeforeMs)}</td><td class="${cls(imp.pbDeltaMs)}">${fmtGap(imp.pbDeltaMs)}</td></tr></tbody></table></div>`
      : '<p class="muted" style="margin:0">Your first session with this car on this track: the next report compares against this one.</p>'}</div>

    <div class="grid-2">${cornerCard('Best corners', r.corners.best, false)}${cornerCard('Weakest corners', r.corners.weakest, true)}</div>
    <p class="muted" style="font-size:12px;margin:-6px 0 16px">Corner times: your typical time today (the middle of your valid laps) against your fastest pass of that corner ever.${cons.worstCorner ? ` Least consistent corner: <b>${esc(cons.worstCorner.name)}</b> (${pm(cons.worstCorner.sdMs)}).` : ''}</p>

    <div class="card"><div class="row" style="margin-bottom:6px"><h2 style="margin:0">Lap times</h2><span class="spacer"></span><div class="legend" id="rLegend"></div></div><div id="rTrend"></div></div>

    <div class="grid-2">${setupCard()}<div>${conditionsCard}${limitsCard}</div></div>

    <details class="card"><summary><b>All corners</b></summary><div class="tablewrap" style="margin-top:8px"><table>
      <thead><tr><th>Corner</th><th>Typical today</th><th>Best today</th><th>Fastest ever</th><th>Gap</th><th>Spread</th><th>Against last session</th></tr></thead>
      <tbody>${r.corners.all.map((x) => `<tr><td><b>${esc(x.name)}</b></td><td>${s3(x.medianMs)}</td><td>${s3(x.sessionBestMs)}</td><td>${s3(x.bestEverMs)}</td>
        <td class="${x.gapMs > 0 ? 'pos' : 'neg'}">${fmtGap(x.gapMs)}</td><td>${pm(x.sdMs)}</td><td class="${cls(x.changeMs)}">${x.changeMs == null ? '–' : fmtGap(x.changeMs)}</td></tr>`).join('')}</tbody></table></div></details>

    <div class="card"><div class="row"><h2 style="margin:0">AI debrief</h2><span class="spacer"></span>
      <button id="rAi" class="${res.ai ? 'ghost' : 'primary'}" ${res.hasKey ? '' : 'disabled title="Add a Gemini API key in Settings"'}>${res.ai ? 'Write again' : 'Write debrief'}</button></div>
      <div id="rAiOut" style="margin-top:8px">${res.ai ? `<div class="ai-out">${md(res.ai.text)}</div><p class="muted" style="font-size:12px">${esc(res.ai.model)}, ${esc(when(res.ai.at))}</p>`
        : `<p class="muted" style="margin:0">${res.hasKey ? 'Gemini turns this report into a short debrief with a plan for your next session.' : 'Add a Gemini API key in <a href="#/settings">Settings</a> for an AI debrief.'}</p>`}</div></div>`;

  // ---- actions
  $('#rRegen').onclick = async () => { await post('/api/report/regenerate', { session: id }); viewReport(view, params, cleanup); };
  view.querySelectorAll('select[data-seg]').forEach((sel) => {
    sel.onchange = async () => {
      const seg = r.setups[Number(sel.dataset.seg)];
      sel.disabled = true;
      try { await post('/api/report/setup', { session: id, lapIds: seg.lapIds, rel: sel.value || null }); viewReport(view, params, cleanup); }
      catch (e) { alert(e.message); sel.disabled = false; }
    };
  });
  $('#rAi').onclick = async () => {
    const b = $('#rAi'); b.disabled = true; b.textContent = 'Writing…';
    try {
      const out = await post('/api/report/ai', { session: id });
      $('#rAiOut').innerHTML = `<div class="ai-out">${md(out.text)}</div><p class="muted" style="font-size:12px">${esc(out.model)}, just now</p>`;
      b.textContent = 'Write again'; b.className = 'ghost';
    } catch (e) { $('#rAiOut').innerHTML = `<p class="pos">${esc(e.message)}</p>`; b.textContent = 'Write debrief'; }
    b.disabled = false;
  };

  // ---- lap-time trend (uPlot): valid laps, invalid laps, clean average, theoretical best
  const el = $('#rTrend');
  const laps = r.trend;
  const xs = laps.map((_, i) => i + 1);
  const sec = (ms) => (ms == null ? null : ms / 1000);
  // invalid laps far off the pace would squash the chart: those above 115 % of the best are left out of the scale
  const cap = r.best.ms * 1.15;
  const S = [
    { label: 'Valid lap', color: css('--series-1'), data: laps.map((l) => (l.valid ? sec(l.ms) : null)), width: 2, points: { size: 8, fill: css('--series-1') } },
    { label: 'Invalid lap', color: css('--slower'), data: laps.map((l) => (!l.valid && l.ms <= cap ? sec(l.ms) : null)), width: 0, points: { size: 7, fill: css('--slower') } },
    { label: 'Clean average', color: css('--text-muted'), data: laps.map(() => sec(r.average.cleanMs)), width: 1, dash: [5, 4], points: { show: false } },
    { label: 'Theoretical best', color: css('--series-3'), data: laps.map(() => sec(r.theoretical?.ms)), width: 1.5, dash: [2, 3], points: { show: false } },
  ];
  $('#rLegend').innerHTML = S.map((s) => `<span class="row" style="gap:6px;font-size:12px"><i style="display:inline-block;width:14px;height:3px;border-radius:2px;background:${s.color}"></i>${s.label}</span>`).join('');
  const axis = () => ({ stroke: css('--text-muted'), grid: { stroke: css('--grid'), width: 1 }, ticks: { stroke: css('--grid') }, font: '11px system-ui' });
  const tip = document.createElement('div'); tip.className = 'tip'; tip.hidden = true; el.style.position = 'relative';
  const plot = new uPlot({
    width: el.clientWidth, height: 240, legend: { show: false }, cursor: { points: { size: 8 } },
    scales: { x: { time: false, range: () => [0.5, laps.length + 0.5] }, y: { range: (u, min, max) => { const p = Math.max((max - min) * 0.15, 0.1); return [min - p, max + p]; } } },
    axes: [{ ...axis(), values: (u, v) => v.map((x) => (Number.isInteger(x) && laps[x - 1] ? String(laps[x - 1].n ?? x) : '')) }, { ...axis(), size: 70, values: (u, v) => v.map((x) => fmt(x * 1000)) }],
    series: [{}, ...S.map((s) => ({ label: s.label, stroke: s.color, width: s.width, dash: s.dash, points: s.points, spanGaps: false }))],
    hooks: { setCursor: [(u) => {
      const i = u.cursor.idx; tip.hidden = i == null; if (i == null) return;
      const l = laps[i];
      tip.innerHTML = `Lap ${l.n ?? i + 1}: <b>${fmt(l.ms)}</b>${l.valid ? '' : ' <span class="pos">invalid</span>'}${l.setup ? ` · ${esc(l.setup)}` : ''} · ${fmtGap(l.ms - r.best.ms)}`;
      tip.style.left = `${Math.min(u.valToPos(i + 1, 'x') + 60, el.clientWidth - 300)}px`;
    }] },
  }, [xs, ...S.map((s) => s.data)], el);
  el.appendChild(tip);
  el.querySelector('.u-over').addEventListener('click', () => { const l = laps[plot.cursor.idx]; if (l) location.hash = `#/compare?laps=${l.id}&ref=best`; });
  const onResize = () => plot.setSize({ width: el.clientWidth, height: 240 });
  window.addEventListener('resize', onResize);
  cleanup.push(() => { window.removeEventListener('resize', onResize); plot.destroy(); });
}
