// Setup history (P7) for one track + car: every setup you actually drove there (each version of a saved file is its own
// row), with dates, sessions, best and typical lap, and two of them compared value by value. Data: /api/setuphistory
// (src/setuphistory.js). Setups are recognised from pit-box readings, so the page carries that reading's status.
import { $, esc, api, fmt, fmtGap, prettyName, emptyHtml, prov } from './util.js';

const MATCH = { matched: 'recognised', guess: 'best guess', manual: 'picked by you', standard: 'no saved setup matched' };
const day = (t) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const temp = (v) => (v == null ? '–' : `${v} °C`);
const num = (v) => (v == null ? '–' : String(+(+v).toFixed(4)));

export async function viewSetupHistory(view, params, cleanup) {
  const [track, layout, car] = (params.get('combo') || '').split('|');
  const q = new URLSearchParams({ track, layout, car });
  const data = await api(`/api/setuphistory?${q}`);
  const E = data.entries;
  const head = `<div class="cmp-head">
      <a href="#/"><button class="ghost">Back to laps</button></a>
      <div><h1>Setup history at ${esc(prettyName(track))} <span class="muted">${esc(prettyName(layout))}</span></h1>
        <div class="secondary">${esc(prettyName(car))}</div></div><span class="spacer"></span>
      <a href="#/setups"><button>Setups</button></a></div>`;
  if (!E.length) {
    view.innerHTML = head + emptyHtml('No laps here yet', 'Drive this car on this track: every lap remembers the setup it was driven on.');
    return;
  }
  const label = (g) => `${esc(g.name)}${g.versions > 1 ? ` <span class="badge" title="The same saved file with other values: each version you drove is listed apart">version ${g.version} of ${g.versions}</span>` : ''}`;
  const withBest = E.filter((g) => g.bestMs != null);
  const fastest = withBest.length ? Math.min(...withBest.map((g) => g.bestMs)) : null;
  const withMed = E.filter((g) => g.medianMs != null);
  const fastestMed = withMed.length ? Math.min(...withMed.map((g) => g.medianMs)) : null;
  const comparable = E.filter((g) => g.snapshot || g.rel);
  const keyParam = (k) => (E.some((g) => g.key === k) ? k : null);
  let A = keyParam(params.get('a')) || comparable[1]?.key || E[1]?.key || E[0].key;
  let B = keyParam(params.get('b')) || comparable[0]?.key || E[0].key;

  view.innerHTML = `${head}
    <div class="card plain note-warn" style="margin-bottom:12px">${prov(data.probe || 'unverified', 'Setups are recognised from the tyre pressures, camber, brake bias and fuel read in the pit box.')}
      Each lap remembers the setup it was recognised as. ${data.probe === 'verified' ? '' : 'These readings are not checked against the game yet (Setups → Setup recognition), so a lap may be listed under the wrong setup; you can correct it in the session report.'}
      “Standard” = no saved setup matched (the game's default, or a change you did not save).</div>
    <div class="card"><h2>Setups you drove here</h2><div class="tablewrap"><table class="setup-hist">
      <thead><tr><th>Setup</th><th>Driven</th><th>Sessions</th><th>Laps</th><th>Best lap</th>
        <th title="Median of the clean laps: valid laps within 7 % of this setup's best">Typical lap</th><th title="Spread of the clean laps (with 3 or more)">Spread</th>
        <th title="Average air and track temperature of the sessions that recorded them">Air / track</th><th></th></tr></thead>
      <tbody>${E.map((g) => `<tr>
        <td><b>${label(g)}</b><div class="muted" style="font-size:12px">${esc(g.match.map((m) => MATCH[m] || m).join(', ') || (g.key === 'none' ? 'laps from before setups were tracked' : ''))}</div></td>
        <td class="muted" style="white-space:nowrap">${day(g.firstAt)}${day(g.firstAt) !== day(g.lastAt) ? ` – ${day(g.lastAt)}` : ''}</td>
        <td>${g.sessions}</td><td>${g.validLaps}<span class="muted"> / ${g.laps}</span></td>
        <td>${g.bestMs != null ? `<b class="${g.bestMs === fastest ? 'best' : ''}">${fmt(g.bestMs)}</b> ${g.bestMs !== fastest ? `<span class="pos">${fmtGap(g.bestMs - fastest)}</span>` : ''}` : '<span class="muted">no valid lap</span>'}</td>
        <td>${g.medianMs != null ? `${fmt(g.medianMs)} ${g.medianMs !== fastestMed ? `<span class="pos">${fmtGap(g.medianMs - fastestMed)}</span>` : ''}` : '–'}</td>
        <td>${g.sdMs != null ? `±${(g.sdMs / 1000).toFixed(3)} s` : '–'}</td>
        <td class="muted">${g.conditions.sessions ? `${temp(g.conditions.airC)} / ${temp(g.conditions.roadC)}` : '–'}</td>
        <td style="white-space:nowrap">${g.bestLapId ? `<a href="#/compare?laps=${g.bestLapId}&ref=best">Best lap</a>` : ''}</td></tr>`).join('')}</tbody></table></div>
      <p class="muted" style="font-size:12px;margin:8px 0 0">${prov('calculated', 'From your lap times.')} Gaps are against the fastest setup in each column. Few laps or different conditions can make a setup look faster than it is.</p></div>
    ${E.length >= 2 ? `<div class="card"><div class="row" style="flex-wrap:wrap;gap:8px"><h2 style="margin:0">Compare two setups</h2><span class="spacer"></span>
      <label class="row">A <select id="shA">${E.map((g) => `<option value="${esc(g.key)}">${esc(g.name)}${g.versions > 1 ? ` (v${g.version})` : ''}</option>`).join('')}</select></label>
      <label class="row">B <select id="shB">${E.map((g) => `<option value="${esc(g.key)}">${esc(g.name)}${g.versions > 1 ? ` (v${g.version})` : ''}</option>`).join('')}</select></label></div>
      <div id="shDiff" style="margin-top:10px"></div></div>` : ''}`;
  if (E.length < 2) return;

  let seq = 0;
  async function drawDiff() {
    const my = ++seq;
    history.replaceState(null, '', `#/setuphistory?${new URLSearchParams({ combo: params.get('combo'), a: A, b: B })}`);
    const box = $('#shDiff');
    if (A === B) { box.innerHTML = '<p class="muted" style="margin:0">Pick two different setups.</p>'; return; }
    let d;
    try { d = await api(`/api/setuphistory/diff?${new URLSearchParams({ track, layout, car, a: A, b: B })}`); } catch (e) { if (my === seq) box.innerHTML = `<p class="pos" style="margin:0">${esc(e.message)}</p>`; return; }
    if (my !== seq || !box.isConnected) return;
    const perf = `<div class="tablewrap"><table><thead><tr><th></th><th>A: ${esc(d.a.name)}</th><th>B: ${esc(d.b.name)}</th><th>B against A</th></tr></thead><tbody>
      <tr><td>Best lap</td><td>${fmt(d.a.bestMs)}</td><td>${fmt(d.b.bestMs)}</td><td class="${d.a.bestMs != null && d.b.bestMs != null ? (d.b.bestMs < d.a.bestMs ? 'neg' : 'pos') : ''}">${d.a.bestMs != null && d.b.bestMs != null ? fmtGap(d.b.bestMs - d.a.bestMs) : '–'}</td></tr>
      <tr><td>Typical lap</td><td>${fmt(d.a.medianMs)}</td><td>${fmt(d.b.medianMs)}</td><td class="${d.a.medianMs != null && d.b.medianMs != null ? (d.b.medianMs < d.a.medianMs ? 'neg' : 'pos') : ''}">${d.a.medianMs != null && d.b.medianMs != null ? fmtGap(d.b.medianMs - d.a.medianMs) : '–'}</td></tr>
      <tr><td>Laps (valid)</td><td>${d.a.validLaps} / ${d.a.laps}</td><td>${d.b.validLaps} / ${d.b.laps}</td><td></td></tr></tbody></table></div>`;
    const src = (s) => (s === 'file' ? ' <span class="muted" title="No values were recorded when it was driven: these are the saved file\'s values now, which may have changed since">(file as it is now)</span>' : '');
    let values;
    if (!d.changed) values = `<p class="muted" style="margin:10px 0 0">No value comparison: ${esc(d.reason)}.</p>`;
    else if (!d.changed.length) values = `<p style="margin:10px 0 0">The values are the same (${d.same} values compared).${d.onlyA.length || d.onlyB.length ? ' Some values exist in only one of them.' : ''}</p>`;
    else values = `<h3 style="margin:14px 0 6px">${d.changed.length} value${d.changed.length === 1 ? '' : 's'} differ <span class="muted" style="font-weight:400;font-size:12px">· ${d.same} the same${src(d.a.source)}${d.a.source !== d.b.source ? src(d.b.source) : ''}</span></h3>
      <div class="tablewrap"><table><thead><tr><th>Setting</th><th>A</th><th>B</th><th>Change</th></tr></thead><tbody>
      ${d.changed.map((c) => `<tr><td>${esc(c.label)}${c.corner ? ` <span class="muted">${esc(c.corner)}</span>` : ''}</td><td>${num(c.a)} ${esc(c.unit)}</td><td><b>${num(c.b)}</b> ${esc(c.unit)}</td>
        <td>${c.delta > 0 ? '+' : ''}${num(c.delta)} ${esc(c.unit)}</td></tr>`).join('')}</tbody></table></div>`;
    const only = (list, who) => (list.length ? `<p class="muted" style="font-size:12px;margin:6px 0 0">Only in ${who}: ${list.map(esc).join(', ')}</p>` : '');
    box.innerHTML = perf + values + only(d.onlyA, 'A') + only(d.onlyB, 'B');
  }
  $('#shA').value = A; $('#shB').value = B;
  $('#shA').onchange = (e) => { A = e.target.value; drawDiff(); };
  $('#shB').onchange = (e) => { B = e.target.value; drawDiff(); };
  cleanup.push(() => { seq++; });
  drawDiff();
}
