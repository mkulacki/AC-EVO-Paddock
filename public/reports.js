// Session page (Sessions → a session): telemetry of its laps (public/telemetry.js), its report and its laps. Reports are made automatically when a session ends (3+ laps, one valid), or on request for older sessions.
// Best lap and average, change against earlier sessions, best / weakest corners, consistency, setups and
// conditions, lap-time trend, theoretical best, track limits, next practice targets and the AI debrief.
import { $, css, esc, api, post, fmt, fmtGap, prettyName, SESSION_TYPES, md, prov, aiConfidence } from './util.js';
import { mountTelemetry } from './telemetry.js';
import { mountCarSetup } from './carsetup.js';

const stamp = (ms) => new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
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

// ================================================================== one session: its report and its laps
export async function viewReport(view, params, cleanup) {
  const id = Number(params.get('session'));
  const res = await api(`/api/report?session=${id}`);
  const reload = () => viewReport(view, params, cleanup);
  if (!res.data) { await viewBasic(view, res, reload, params, cleanup); return; }
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

  const ch = res.channels || {};
  const setupCard = () => `<div class="card"><h2>Setup${r.setups.length > 1 ? 's' : ''} used${prov(ch.setupProbe || 'unverified', 'Recognised from the tyre pressures, camber, brake bias and fuel read in the pit box.')}</h2>
    ${ch.setupProbe === 'verified' ? '' : `<p class="muted" style="font-size:12px;margin:0 0 8px">${ch.setupProbe === 'mismatch' ? 'You found that the pit-box readings do not match the game, so the recognised setup is likely wrong.' : 'The pit-box readings behind setup recognition have not been checked in the game yet.'} Check them in the <a href="#/setups">Setups</a> tab (stand in the pit box with a saved setup loaded), or correct a setup below.</p>`}
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
    <p style="margin:0">Air ${temp(c?.airC)} · Track ${temp(c?.roadC)} ${c?.airC || c?.roadC ? prov(ch.conditions || 'unverified') : ''}</p></div>`;

  const tl = r.trackLimits;
  const limitsCard = `<div class="card"><h2>Track limits</h2>${!tl.invalid ? '<p class="neg" style="margin:0">No invalid laps.</p>'
    : `<p style="margin:0 0 6px">${tl.invalid} invalid lap${tl.invalid === 1 ? '' : 's'} of ${r.laps.total}.</p>
      ${tl.byCorner.length ? `<ul style="margin:0 0 0 18px;padding:0">${tl.byCorner.map((x) => `<li><b>${esc(x.name)}</b>: ${x.n} lap${x.n === 1 ? '' : 's'}</li>`).join('')}</ul>` : ''}
      ${tl.unknown ? `<p class="muted" style="font-size:12px;margin:6px 0 0">${tl.unknown} lap${tl.unknown === 1 ? '' : 's'} without the data to tell where.</p>` : ''}`}</div>`;

  view.innerHTML = `
    <div class="cmp-head">
      <a href="#/"><button class="ghost">← Sessions</button></a>
      <div><h1>${comboTxt(r.combo)}</h1>
        <div class="secondary">${esc(prettyName(r.combo.car))} · ${esc(SESSION_TYPES[r.sessionType] || 'Session')} on ${esc(when(r.startedAt))}</div></div>
      <span class="spacer"></span>
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

    ${sessionTabs(res.laps, r.best.lapId, r.best.ms)}
    <div id="tabReport" hidden>
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
    <p class="muted" style="font-size:12px;margin:-6px 0 16px">${prov('calculated', 'From your lap times, speed and inputs.')} Corner times: your typical time today (the middle of your valid laps) against your fastest pass of that corner ever.${cons.worstCorner ? ` Least consistent corner: <b>${esc(cons.worstCorner.name)}</b> (${pm(cons.worstCorner.sdMs)}).` : ''}</p>

    <div class="card"><div class="row" style="margin-bottom:6px"><h2 style="margin:0">Lap times</h2><span class="spacer"></span><div class="legend" id="rLegend"></div></div><div id="rTrend"></div></div>

    <div class="grid-2">${setupCard()}<div>${conditionsCard}${limitsCard}</div></div>

    <details class="card"><summary><b>All corners</b></summary><div class="tablewrap" style="margin-top:8px"><table>
      <thead><tr><th>Corner</th><th>Typical today</th><th>Best today</th><th>Fastest ever</th><th>Gap</th><th>Spread</th><th>Against last session</th></tr></thead>
      <tbody>${r.corners.all.map((x) => `<tr><td><b>${esc(x.name)}</b></td><td>${s3(x.medianMs)}</td><td>${s3(x.sessionBestMs)}</td><td>${s3(x.bestEverMs)}</td>
        <td class="${x.gapMs > 0 ? 'pos' : 'neg'}">${fmtGap(x.gapMs)}</td><td>${pm(x.sdMs)}</td><td class="${cls(x.changeMs)}">${x.changeMs == null ? '–' : fmtGap(x.changeMs)}</td></tr>`).join('')}</tbody></table></div></details>

    <div class="card"><div class="row"><h2 style="margin:0">AI debrief</h2><span class="spacer"></span>
      <button id="rAi" class="${res.ai ? 'ghost' : 'primary'}" ${res.hasKey ? '' : 'disabled title="Add a Gemini API key in Settings"'}>${res.ai ? 'Write again' : 'Write debrief'}</button></div>
      <div id="rAiOut" style="margin-top:8px">${res.ai ? `<div class="ai-out">${md(res.ai.text)}</div>${aiConfidence(res.ai.confidence)}<p class="muted" style="font-size:12px">${esc(res.ai.model)}, ${esc(when(res.ai.at))}</p>`
        : `<p class="muted" style="margin:0">${res.hasKey ? 'Gemini turns this report into a short debrief with a plan for your next session.' : 'Add a Gemini API key in <a href="#/settings">Settings</a> for an AI debrief.'}</p>`}</div></div>
    </div>`;

  // ---- actions
  $('#rRegen').onclick = async () => { await post('/api/report/regenerate', { session: id }); reload(); };
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
      $('#rAiOut').innerHTML = `<div class="ai-out">${md(out.text)}</div>${aiConfidence(out.confidence)}<p class="muted" style="font-size:12px">${esc(out.model)}, just now</p>`;
      b.textContent = 'Write again'; b.className = 'ghost';
    } catch (e) { $('#rAiOut').innerHTML = `<p class="pos">${esc(e.message)}</p>`; b.textContent = 'Write debrief'; }
    b.disabled = false;
  };

  await bindSession(view, params, cleanup, { id, laps: res.laps, bestLapId: r.best.lapId, hasKey: res.hasKey, probeConfirmed: res.probeConfirmed, reload, onReport: drawTrend });

  // ---- lap-time trend (uPlot): valid laps, invalid laps, clean average, theoretical best. Drawn when the Report tab is first shown
  function drawTrend() {
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
}

// ---- the session page's tabs: Telemetry (with the laps folded under it) and the report
function sessionTabs(laps, bestLapId, bestMs, report = true) {
  return `<div class="tabs sess-tabs"><a href="#" data-tab="tele">Telemetry</a>${report ? '<a href="#" data-tab="report">Report &amp; targets</a>' : ''}<a href="#" data-tab="car">Car &amp; setup</a></div>
    <div id="tabCar" hidden></div>
    <div id="tabTele"><div id="tele"><div class="card"><span class="spinner"></span> Loading telemetry…</div></div>
      <details class="card laps-fold" id="rLaps"><summary><b>All ${laps.length} lap${laps.length === 1 ? '' : 's'} of this session</b>
        <span class="hint">click a lap to analyse it · tick up to 3 to compare</span></summary>
        ${lapsBlock(laps, { bestMs, bestLapId })}</details></div>`;
}
async function bindSession(view, params, cleanup, { id, laps, bestLapId, hasKey, probeConfirmed, reload, onReport }) {
  const want = params.get('tab');
  const state = { tab: want === 'report' && onReport ? 'report' : want === 'car' ? 'car' : 'tele', tele: null };
  const url = (s) => `#/report?session=${id}${s ? `&laps=${s.laps.join(',')}&ref=${s.ref}${s.corner ? `&c=${encodeURIComponent(s.corner)}` : ''}` : ''}${state.tab !== 'tele' ? `&tab=${state.tab}` : ''}`;
  let carShown = false;
  let teleState = null;
  let trendDrawn = false;
  const show = (tab) => {
    state.tab = tab;
    view.querySelectorAll('.sess-tabs [data-tab]').forEach((a) => a.classList.toggle('on', a.dataset.tab === tab));
    $('#tabTele').hidden = tab !== 'tele';
    if ($('#tabReport')) $('#tabReport').hidden = tab !== 'report';
    $('#tabCar').hidden = tab !== 'car';
    if (tab === 'report' && !trendDrawn && onReport) { trendDrawn = true; onReport(); }
    if (tab === 'car' && !carShown) { carShown = true; mountCarSetup($('#tabCar'), id); }
    history.replaceState(null, '', url(teleState));
  };
  view.querySelectorAll('.sess-tabs [data-tab]').forEach((a) => a.onclick = (e) => { e.preventDefault(); show(a.dataset.tab); });
  show(state.tab);
  bindLaps($('#rLaps'), laps, afterDelete(laps, reload), (lapId) => {
    state.tele?.set({ laps: [lapId], corner: null });
    $('#tele').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  const first = bestLapId ?? laps[0]?.id;
  if (first == null) return;
  const lapsParam = (params.get('laps') || '').split(',').map(Number).filter(Boolean);
  state.tele = await mountTelemetry($('#tele'), {
    laps: lapsParam.length ? lapsParam : [first], ref: params.get('ref') || 'ideal', corner: params.get('c'), sessionId: id, hasKey,
    onState: (s) => { teleState = s; history.replaceState(null, '', url(s)); },
  }, cleanup);
}

// ---- a list of laps: compare (up to 3), open, export, delete. Session page, and imported laps on the Sessions page
export function lapsBlock(laps, { bestMs, bestLapId, bestLabel = 'Session best' }) {
  const invalid = laps.filter((l) => !l.valid).map((l) => l.id);
  return `<div class="row" style="margin:8px 0"><span class="spacer"></span>
      <button class="cmp-sel" disabled>Compare selected</button>
      <select class="ref-sel" title="Reference lap"><option value="best">with my best lap</option><option value="ideal">with the ideal lap</option><option value="first">with the first one selected</option></select>
      ${invalid.length ? `<button class="danger-ghost" data-rm-invalid="${invalid.join(',')}">Remove invalid laps (${invalid.length})</button>` : ''}</div>
    <table class="laps"><thead><tr><th></th><th>Lap</th><th>Time</th><th>Gap</th><th>Setup</th><th>Recorded</th><th></th></tr></thead><tbody>
    ${laps.map((l) => {
      const isBest = l.id === bestLapId;
      return `<tr class="${l.valid ? '' : 'invalid'}" data-open="#/compare?laps=${l.id}&ref=best" data-id="${l.id}" title="Analyse this lap">
        <td><input type="checkbox" data-lap="${l.id}" aria-label="Select lap for comparison"></td>
        <td class="muted">${l.lap_number ?? ''}</td>
        <td class="time${isBest ? ' pb' : ''}"><b>${fmt(l.lap_time_ms)}</b> ${isBest ? `<span class="badge pb">${bestLabel}</span>` : ''} ${l.valid ? '' : '<span class="badge bad">Invalid</span>'}</td>
        <td class="secondary">${isBest || bestMs == null ? '' : fmtGap(l.lap_time_ms - bestMs)}</td>
        <td class="secondary">${esc(l.setup_name ?? '–')}</td>
        <td class="muted" style="white-space:nowrap">${esc(stamp(l.recorded_at))}</td>
        <td class="actions">
          <a href="#/compare?laps=${l.id}&ref=ideal"><button class="small ghost" title="Compare with the ideal lap (your best sectors)">Ideal</button></a>
          <a href="/api/laps/${l.id}/export" download><button class="small ghost" title="Export lap file" aria-label="Export lap file">⇩</button></a>
          <button class="small ghost" data-del="${l.id}" title="Delete lap" aria-label="Delete lap">✕</button>
        </td></tr>`;
    }).join('')}</tbody></table>`;
}
// after(deletedIds): called once laps were deleted; onOpen(lapId): a click on a lap (default: open it in Compare)
export function bindLaps(root, laps, after, onOpen = null) {
  const sel = new Set();
  const btn = root.querySelector('.cmp-sel');
  const upd = () => { btn.disabled = !sel.size; btn.textContent = `Compare selected (${sel.size})`; };
  root.querySelectorAll('input[data-lap]').forEach((cb) => cb.onchange = () => {
    const id = +cb.dataset.lap;
    if (cb.checked) { if (sel.size >= 3) { cb.checked = false; alert('Compare up to 3 laps against the reference.'); return; } sel.add(id); } else sel.delete(id);
    upd();
  });
  btn.onclick = () => {
    const ids = [...sel]; const ref = root.querySelector('.ref-sel').value;
    location.hash = `#/compare?laps=${ids.join(',')}&ref=${ref === 'first' ? ids[0] : ref}`;
  };
  root.querySelectorAll('table.laps tr[data-open]').forEach((tr) => tr.onclick = (e) => {
    if (e.target.closest('input, button, a, label')) return;
    if (onOpen) onOpen(+tr.dataset.id); else location.hash = tr.dataset.open;
  });
  const remove = async (ids, what) => {
    if (!confirm(`Delete ${what} permanently?\n\nThis cannot be undone.`)) return;
    await post('/api/laps/delete', { ids });
    after(ids);
  };
  root.querySelectorAll('[data-del]').forEach((b) => b.onclick = () => remove([+b.dataset.del], 'this lap'));
  const rm = root.querySelector('[data-rm-invalid]');
  if (rm) rm.onclick = () => { const ids = rm.dataset.rmInvalid.split(',').map(Number); remove(ids, `${ids.length} invalid lap${ids.length > 1 ? 's' : ''}`); };
}
// the session page after deleting laps: built again, or back to Sessions when nothing is left
const afterDelete = (laps, reload) => (ids) => { if (laps.every((l) => ids.includes(l.id))) location.hash = '#/'; else reload(); };

// a session too short for a report (fewer than 3 laps, or none valid): the basics and its laps
async function viewBasic(view, res, reload, params, cleanup) {
  const s = res.session, laps = res.laps, c = laps[0];
  const valid = laps.filter((l) => l.valid);
  const best = valid.reduce((a, b) => (!a || b.lap_time_ms < a.lap_time_ms ? b : a), null);
  const setups = [...new Set(laps.map((l) => l.setup_name).filter(Boolean))];
  view.innerHTML = `
    <div class="cmp-head">
      <a href="#/"><button class="ghost">← Sessions</button></a>
      <div><h1>${comboTxt(c)}</h1>
        <div class="secondary">${esc(prettyName(c.car))} · ${esc(SESSION_TYPES[s?.session_type] || 'Session')} on ${esc(when(s?.started_at ?? c.recorded_at))}</div></div>
    </div>
    <div class="tiles">
      <div class="card stat"><span class="k">Best lap</span><span class="v best">${fmt(best?.lap_time_ms)}</span></div>
      <div class="card stat"><span class="k">Laps</span><span class="v">${valid.length}<small class="muted"> valid / ${laps.length}</small></span></div>
      <div class="card stat"><span class="k">Setup</span><span class="v" style="font-size:18px">${setups.length ? setups.map(esc).join(', ') : '–'}</span></div>
    </div>
    <p class="muted" style="margin:0 0 16px">A session report needs 3 laps or more, one of them valid.</p>
    ${sessionTabs(laps, best?.id, best?.lap_time_ms, false)}`;
  await bindSession(view, params, cleanup, { id: s?.id ?? c.session_id, laps, bestLapId: best?.id ?? null, hasKey: res.hasKey, probeConfirmed: res.probeConfirmed, reload, onReport: null });
}
