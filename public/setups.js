// Setups tab: the game's own saved setups (Saved Games\ACE\Car Setups\<car>\<track>\*.carsetup), per car, with the
// chosen track's setups first. Setups are loaded and saved in the game's own setup screen; here they are read,
// edited (as files), explained and changed by the AI setup engineer, copied to other tracks and shared.
import { $, esc, api, post, askText } from './util.js';
import { openGarage, openTrackPicker, thumbUrl } from './garage.js';

const FROM = { shared: 'Shared', paddock: 'Edited in Paddock', ai: 'AI engineer', copy: 'Copied' };
const LS = 'setups.view3';
const ago = (t) => { const s = (Date.now() - t) / 1000; return s < 90 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };

// ---------------------------------------------------------------- values as the game shows them (stored * scale)
const decimals = (x) => { const s = String(x); const i = s.indexOf('.'); return i < 0 || /e/i.test(s) ? 0 : Math.min(4, s.length - i - 1); };
const dpOf = (v) => (v.step > 0 ? decimals(+(v.step * v.scale).toFixed(6)) : 3);
const show = (v, x) => +(x * v.scale).toFixed(dpOf(v));
const snap = (v, x) => {
  let r = Number(x);
  if (!Number.isFinite(r)) return v.value;
  if (v.step > 0) r = v.min + Math.round((r - v.min) / v.step) * v.step;
  return +Math.min(v.max, Math.max(v.min, r)).toFixed(6);
};
const CORNER = { FL: 'FL', FR: 'FR', RL: 'RL', RR: 'RR', F3: 'front 3rd', R3: 'rear 3rd' };

export async function viewSetups(view, params, cleanup) {
  const [{ groups }, race] = await Promise.all([api('/api/setups/meta'), api('/api/race')]);
  const cat = race.catalogue;
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(LS) || '{}'); } catch { /* none */ }
  const st = {
    car: params.get('car') || saved.car || null,
    track: params.get('track') ? { id: params.get('track'), layout: params.get('layout') || null } : saved.track || null,
    open: params.get('id') || null, cars: [], list: [], folder: '', setup: null,
    edit: null,   // {name: stored value} while values are being changed
    ai: null,     // {busy, problem, result, error, pick: Set of names}
  };
  const remember = () => { try { localStorage.setItem(LS, JSON.stringify({ car: st.car, track: st.track })); } catch { /* ignore */ } };
  const carById = (id) => cat.cars.find((c) => c.id === id);
  const carLabel = (id) => { const c = carById(id); return c ? `${c.brand} ${c.name}` : st.cars.find((x) => x.carId === id)?.carName || String(id || '').replace(/^folder:/, ''); };
  const trackOf = (t) => { const tr = cat.tracks.find((x) => x.id === t?.id); return tr ? { t: tr, l: tr.layouts.find((x) => x.key === t.layout) || tr.layouts[0] } : null; };

  view.innerHTML = `
    <div class="row" style="margin-bottom:6px"><h1>Setups</h1><span class="spacer"></span>
      <button id="sImport">Import…</button><input type="file" id="sFile" accept=".carsetup" multiple hidden></div>
    <p class="muted" style="margin:0 0 16px">The setups you save in AC EVO's setup screen, per car and track. Read and change their values here, or ask the
      AI setup engineer, and save the result as a new setup: in the game it is in the setup screen's <b>Load</b> list for that car and track.
      Share a setup as its <code>.carsetup</code> file.</p>
    <div id="sMsg"></div>
    <div class="setups-layout"><div id="sSide"></div><div id="sMain"></div></div>`;
  const msg = (text, bad = false) => { $('#sMsg').innerHTML = text ? `<div class="card ${bad ? 'error' : ''}" style="padding:10px 16px">${esc(text)}</div>` : ''; };

  // ---------------------------------------------------------------- side: car and track
  function side() {
    const c = st.car ? carById(st.car) : null;
    const tl = trackOf(st.track);
    $('#sSide').innerHTML = `<div class="card">
        <h3>Car</h3>
        <button class="setup-pickbtn" data-pcar>${c ? `<img alt="" src="${thumbUrl(c.id)}"><span><span class="muted" style="font-size:12px">${esc(c.brand)}</span><br><b>${esc(c.name)}</b></span>` : st.car ? `<b>${esc(carLabel(st.car))}</b>` : '<span>Choose a car…</span>'}</button>
        ${st.cars.length ? `<h3 style="margin-top:14px">Cars with setups</h3><div class="setup-cars">${st.cars.map((x) => `<button class="pill ${x.carId === st.car ? 'on' : ''}" data-car="${esc(x.carId)}">${esc(x.carName)} <span class="muted">${x.count}</span></button>`).join('')}</div>` : ''}
        <h3 style="margin-top:14px">Track first</h3>
        <button class="setup-pickbtn" data-ptrack>${tl ? `<span><span class="muted" style="font-size:12px">${esc(tl.t.country || '')}</span><br><b>${esc(tl.t.name)}</b></span>` : '<span>Any track</span>'}</button>
        ${tl ? '<button class="small ghost" data-notrack style="margin-top:6px">Clear track</button>' : ''}
        <p class="muted" style="font-size:12px;margin:14px 0 0">Files: <code style="word-break:break-all">${esc(st.folder)}</code></p>
      </div>`;
    const pickCar = (id) => { st.car = id; st.open = null; st.setup = null; st.edit = null; st.ai = null; remember(); load(); };
    $('#sSide').querySelector('[data-pcar]').onclick = () => openGarage({ cars: cat.cars, selected: st.car ? { id: st.car } : null, title: 'Setups for which car?', onPick: (s) => pickCar(s.id) });
    $('#sSide').querySelectorAll('[data-car]').forEach((b) => { b.onclick = () => pickCar(b.dataset.car); });
    $('#sSide').querySelector('[data-ptrack]').onclick = () => openTrackPicker({ tracks: cat.tracks, selected: st.track, onPick: (t) => { st.track = t; remember(); load(); } });
    $('#sSide').querySelector('[data-notrack]')?.addEventListener('click', () => { st.track = null; remember(); load(); });
  }

  // ---------------------------------------------------------------- list
  function listHtml() {
    if (!st.car) return '<div class="card empty"><p>Choose a car to see its setups.</p></div>';
    if (!st.list.length) return `<div class="card empty"><p>No saved setups for the ${esc(carLabel(st.car))} yet.</p>
      <p class="muted">Save one in AC EVO's setup screen (in the pits: <b>Setup</b> → <b>Save</b>), or import a shared <code>.carsetup</code> file.</p></div>`;
    const here = st.list.filter((s) => s.forTrack), byTrack = new Map();
    for (const s of st.list.filter((x) => !x.forTrack)) { if (!byTrack.has(s.track.name)) byTrack.set(s.track.name, []); byTrack.get(s.track.name).push(s); }
    const row = (s) => `<tr class="${s.id === st.open ? 'on' : ''}" data-open="${esc(s.id)}">
        <td><b>${esc(s.name)}</b>${s.from && FROM[s.from] ? ` <span class="badge">${esc(FROM[s.from])}</span>` : ''}
          ${s.basedOn ? `<div class="muted" style="font-size:12px">from ${esc(s.basedOn)}</div>` : ''}</td>
        <td class="muted" style="font-size:12.5px">${esc(s.notes ? s.notes.split('\n')[0].slice(0, 90) : '')}</td>
        <td class="muted" style="font-size:12.5px;white-space:nowrap">${esc(ago(s.updatedAt))}</td></tr>`;
    const table = (title, items) => `<h3 style="margin:18px 0 6px">${esc(title)}</h3>
      <table class="setups"><thead><tr><th>Setup</th><th>Notes</th><th>Saved</th></tr></thead><tbody>${items.map(row).join('')}</tbody></table>`;
    const tl = trackOf(st.track);
    return `<div class="card">
      <div class="row"><h2 style="margin:0">${esc(carLabel(st.car))}</h2><span class="muted">${st.list.length} setup${st.list.length === 1 ? '' : 's'}</span></div>
      ${tl ? table(`For ${tl.t.name}`, here) + (here.length ? '' : '<p class="muted" style="margin:4px 0 0">No setup saved for this track yet. Open one from another track below and use <b>Copy to track…</b>: the game lists only the current track\'s setups.</p>') : ''}
      ${[...byTrack].sort((a, b) => a[0].localeCompare(b[0])).map(([k, items]) => table(tl ? `From ${k}` : k, items)).join('')}
    </div>`;
  }
  function bindList() {
    view.querySelectorAll('[data-open]').forEach((tr) => { tr.onclick = () => openSetup(tr.dataset.open); });
  }

  // ---------------------------------------------------------------- values
  const valueOf = (v) => (st.edit && v.name in st.edit ? st.edit[v.name] : v.value);
  const proposal = () => (st.ai?.result ? new Map(st.ai.result.changes.map((c) => [c.name, c])) : new Map());
  function valuesHtml(values) {
    const prop = proposal();
    const row = (v) => {
      const cur = valueOf(v), changed = Math.abs(cur - v.value) > 1e-9, p = prop.get(v.name);
      const unit = `<span class="muted unit">${esc(v.unit)}</span>`;
      let cell;
      if (v.locked) cell = `<b>${show(v, cur)}</b> ${unit} <span class="muted" style="font-size:11.5px">${v.locked === 'clicks' ? '· change in game' : '· fixed'}</span>`;
      else if (v.list) cell = `<select data-v="${esc(v.name)}">${Array.from({ length: Math.round((v.max - v.min) / (v.step || 1)) + 1 }, (_, i) => v.min + i * (v.step || 1))
        .map((x) => `<option value="${x}" ${Math.abs(x - cur) < 1e-9 ? 'selected' : ''}>Compound ${x - v.min + 1}</option>`).join('')}</select>`;
      else cell = `<input type="number" data-v="${esc(v.name)}" value="${show(v, cur)}" step="${v.step > 0 ? +(v.step * v.scale).toFixed(6) : 'any'}" min="${show(v, v.min)}" max="${show(v, v.max)}"> ${unit}`;
      return `<tr class="${changed ? 'changed' : ''} ${p ? 'diff' : ''}" title="${esc(v.tip || '')}"><td>${esc(v.label)}${v.corner ? ` <span class="muted">${CORNER[v.corner] || v.corner}</span>` : ''}</td><td>${cell}</td>
        <td class="muted range">${v.locked === 'clicks' ? '' : `${show(v, v.min)} – ${show(v, v.max)}`}${changed ? ` <span title="saved value">· was ${show(v, v.value)}</span>` : ''}</td></tr>`;
    };
    const out = [];
    for (const g of groups) {
      const rows = values.filter((v) => v.group === g.id);
      if (rows.length) out.push(`<div class="setup-group"><h3>${esc(g.label)}</h3><table class="setup-values"><tbody>${rows.map(row).join('')}</tbody></table></div>`);
    }
    return `<div class="setup-values-wrap">${out.join('')}</div>`;
  }
  const changedCount = () => (st.setup?.values || []).filter((v) => Math.abs(valueOf(v) - v.value) > 1e-9).length;

  // ---------------------------------------------------------------- the AI setup engineer
  function aiHtml() {
    const a = st.ai || {};
    const s = st.setup;
    const res = a.result;
    const label = (name) => { const v = s.values.find((x) => x.name === name); return v ? `${v.label}${v.corner ? ` ${CORNER[v.corner] || v.corner}` : ''}` : name; };
    const val = (name, x) => { const v = s.values.find((y) => y.name === name); return v ? `${show(v, x)} ${v.unit}` : x; };
    return `<div class="card" style="margin-top:16px">
      <div class="row"><h2 style="margin:0">AI setup engineer</h2><span class="spacer"></span><span class="muted" style="font-size:12px">Gemini · uses your laps with this car on ${esc((trackOf(st.track)?.t.id === s.track.id && trackOf(st.track)?.t.name) || s.track.name)}</span></div>
      <p class="muted" style="margin:6px 0 8px;font-size:13px">Describe what the car does (e.g. "understeer in slow corners, rear steps out on throttle at T6"). The engineer proposes a few changes; nothing is saved until you save them as a new setup.</p>
      <textarea id="aiProblem" rows="3" style="width:100%" placeholder="What should be better? Leave empty for a baseline for this track.">${esc(a.problem || '')}</textarea>
      <div class="row" style="margin-top:8px"><span class="spacer"></span><button class="primary" id="aiAsk" ${a.busy ? 'disabled' : ''}>${a.busy ? '<span class="spinner"></span> Thinking…' : res ? 'Ask again' : 'Ask the engineer'}</button></div>
      ${a.error ? `<p class="error">${esc(a.error)}</p>` : ''}
      ${res ? `<div class="ai-out" style="margin-top:10px">
          <div class="md">${md(res.summary)}</div>
          ${res.changes.length ? `<h3 style="margin-top:12px">Proposed changes</h3><table class="setup-values"><tbody>${res.changes.map((c) => `<tr>
              <td><label class="row" style="gap:6px"><input type="checkbox" data-aipick="${esc(c.name)}" ${a.pick?.has(c.name) ? 'checked' : ''}> ${esc(label(c.name))}</label></td>
              <td style="white-space:nowrap">${esc(val(c.name, c.from))} → <b>${esc(val(c.name, c.to))}</b></td><td class="muted" style="font-size:12.5px">${esc(c.reason)}</td></tr>`).join('')}</tbody></table>
            <div class="row" style="margin-top:8px"><span class="spacer"></span><button id="aiApply">Put the ticked changes in the values ▾</button></div>`
          : '<p class="muted">No setup changes proposed.</p>'}
          ${res.skipped?.length ? `<p class="muted" style="font-size:12px">Ignored (not adjustable on this car): ${esc(res.skipped.join(', '))}</p>` : ''}
          ${res.testPlan ? `<h3 style="margin-top:12px">On track</h3><div class="md">${md(res.testPlan)}</div>` : ''}
          <p class="muted" style="font-size:12px">${esc(res.model)} · ${res.usedLaps ? `${res.usedLaps} lap${res.usedLaps === 1 ? '' : 's'} used` : 'no laps recorded on this track yet'}</p>
        </div>` : ''}
    </div>`;
  }
  // tiny Markdown: headings, bullets, bold
  function md(text) {
    const inline = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>');
    let html = '', list = false;
    for (const raw of String(text || '').split('\n')) {
      const line = raw.trimEnd();
      const li = line.match(/^\s*[-*] (.*)$/);
      if (li) { if (!list) { html += '<ul>'; list = true; } html += `<li>${inline(li[1])}</li>`; continue; }
      if (list) { html += '</ul>'; list = false; }
      const h = line.match(/^#{1,4} (.*)$/);
      if (h) html += `<h4 style="margin:10px 0 4px">${inline(h[1])}</h4>`;
      else if (line.trim()) html += `<p style="margin:4px 0">${inline(line)}</p>`;
    }
    return html + (list ? '</ul>' : '');
  }
  function bindAi() {
    const s = st.setup;
    $('#aiProblem').oninput = (e) => { st.ai = { ...(st.ai || {}), problem: e.target.value }; };
    $('#aiAsk').onclick = async () => {
      st.ai = { ...(st.ai || {}), busy: true, error: null };
      main();
      try {
        const tr = trackOf(st.track);
        const result = await post('/api/setups/ai', { id: s.id, problem: st.ai.problem || '', track: s.track.id || tr?.t.id, layout: tr && tr.t.id === s.track.id ? tr.l.key : null });
        if (st.setup?.id !== s.id) return;
        st.ai = { ...st.ai, busy: false, result, pick: new Set(result.changes.map((c) => c.name)) };
      } catch (e) { st.ai = { ...st.ai, busy: false, error: e.message }; }
      main();
    };
    view.querySelectorAll('[data-aipick]').forEach((b) => { b.onchange = () => { if (b.checked) st.ai.pick.add(b.dataset.aipick); else st.ai.pick.delete(b.dataset.aipick); }; });
    $('#aiApply')?.addEventListener('click', () => {
      st.edit = { ...(st.edit || {}) };
      for (const c of st.ai.result.changes) if (st.ai.pick.has(c.name)) st.edit[c.name] = c.to;
      main();
      document.querySelector('.setup-values-wrap')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  // ---------------------------------------------------------------- one setup file
  async function openSetup(id) {
    if (st.open !== id) { st.edit = null; st.ai = null; }
    st.open = id;
    try { st.setup = await api(`/api/setups/file?id=${encodeURIComponent(id)}`); } catch (e) { msg(e.message, true); st.open = null; st.setup = null; }
    main();
  }
  function detailHtml() {
    const s = st.setup, n = changedCount();
    return `<div class="card setup-detail">
      <div class="row"><button class="small ghost" data-close>← All setups</button><span class="spacer"></span>
        ${s.from && FROM[s.from] ? `<span class="badge">${esc(FROM[s.from])}</span>` : ''}<span class="muted" style="font-size:12px">saved ${esc(ago(s.updatedAt))}</span></div>
      <div class="fields" style="margin-top:12px">
        <label>Name</label><div class="row" style="gap:8px"><input id="eName" value="${esc(s.name)}" style="flex:1"><button class="small" id="eRename">Rename</button></div>
        <label>Car · track</label><div>${esc(s.carName)} · ${esc(s.track.name)} <span class="muted" style="font-size:12px">(folder ${esc(s.carFolder)}\\${esc(s.track.folder)})</span>
          ${s.basedOn ? `<div class="muted" style="font-size:12px">made from ${esc(s.basedOn)}</div>` : ''}</div>
        <label>Notes</label><div><textarea id="eNotes" rows="3" style="width:100%" placeholder="What it is good at, what to try next…">${esc(s.notes)}</textarea></div>
      </div>
      <div class="row" style="margin-top:16px"><h2 style="margin:0">Values</h2><span class="spacer"></span><span class="muted" style="font-size:12.5px">${n ? `${n} changed, not saved yet` : 'change any value, then save'}</span></div>
      ${s.values ? valuesHtml(s.values) : `<p class="error">${esc(s.error || 'The values could not be read.')}</p>`}
      <div class="actionbar">
        <button class="ghost danger-ghost" id="eDel">Delete</button>
        <button class="ghost" id="eCopy" title="the game lists only the current track's setups">Copy to track…</button>
        <button class="ghost" id="eExport">Share</button>
        <span class="spacer"></span>
        <button class="ghost" id="eReset" ${n ? '' : 'disabled'}>Undo changes</button>
        <button id="eOver" ${n ? '' : 'disabled'} title="replace this setup's values">Save</button>
        <button class="primary" id="eNew" ${n ? '' : 'disabled'}>Save as new setup…</button>
      </div></div>
      ${s.values ? aiHtml() : ''}`;
  }
  async function saveValues(asName) {
    const s = st.setup;
    try {
      const d = await post('/api/setups/values', { id: s.id, values: st.edit, asName, notes: asName && st.ai?.result ? aiNote(st.ai) : null, from: st.ai?.result ? 'ai' : 'paddock' });
      st.edit = null; st.setup = d; st.open = d.id;
      if (asName) st.ai = null;
      await load(false); main();
      msg(asName ? `Saved as "${d.name}". In the game it is in the setup screen's Load list for ${d.track.name}.` : `"${d.name}" saved.`);
    } catch (e) { msg(e.message, true); }
  }
  const aiNote = (a) => `AI engineer: ${a.problem ? `"${a.problem.trim().slice(0, 300)}". ` : ''}${a.result.changes.filter((c) => st.edit && c.name in st.edit).map((c) => c.name).join(', ')}`;
  function bindDetail() {
    const s = st.setup;
    $('[data-close]').onclick = () => { st.open = null; st.setup = null; st.edit = null; st.ai = null; main(); };
    $('#eRename').onclick = async () => {
      try { st.setup = await api(`/api/setups/file?id=${encodeURIComponent(s.id)}`, { method: 'PUT', body: JSON.stringify({ name: $('#eName').value }) }); st.open = st.setup.id; await load(false); main(); msg('Renamed.'); } catch (e) { msg(e.message, true); }
    };
    let notesT = null;
    $('#eNotes').oninput = (e) => { clearTimeout(notesT); notesT = setTimeout(() => api(`/api/setups/file?id=${encodeURIComponent(s.id)}`, { method: 'PUT', body: JSON.stringify({ notes: e.target.value }) }).catch((err) => msg(err.message, true)), 600); };
    view.querySelectorAll('[data-v]').forEach((el) => {
      el.onchange = () => {
        const v = s.values.find((x) => x.name === el.dataset.v);
        const raw = el.tagName === 'SELECT' ? Number(el.value) : Number(el.value) / v.scale;
        st.edit = { ...(st.edit || {}), [v.name]: snap(v, raw) };
        if (Math.abs(st.edit[v.name] - v.value) < 1e-9) delete st.edit[v.name];
        const keep = window.scrollY; main(); window.scrollTo(0, keep);
      };
    });
    $('#eReset').onclick = () => { st.edit = null; main(); };
    $('#eOver').onclick = () => { if (confirm(`Replace the values of "${s.name}"? To keep it as it is, use "Save as new setup…".`)) saveValues(null); };
    $('#eNew').onclick = async () => {
      const name = await askText('Name of the new setup', st.ai?.result?.name || `${s.name} v2`);
      if (name) saveValues(name);
    };
    $('#eExport').onclick = () => { location.href = `/api/setups/export?id=${encodeURIComponent(s.id)}`; };
    $('#eCopy').onclick = () => openTrackPicker({ tracks: cat.tracks, selected: st.track, onPick: async (t) => {
      try { const d = await post('/api/setups/copy', { id: s.id, track: t.id }); st.track = { id: t.id, layout: t.layout || null }; remember(); st.setup = d; st.open = d.id; st.edit = null; await load(false); main(); msg(`Copied as "${d.name}" for ${d.track.name}.`); }
      catch (e) { msg(e.message, true); }
    } });
    $('#eDel').onclick = async () => {
      if (!confirm(`Delete the setup "${s.name}"? This deletes the game's setup file.`)) return;
      try { await api(`/api/setups/file?id=${encodeURIComponent(s.id)}`, { method: 'DELETE' }); st.open = null; st.setup = null; st.edit = null; st.ai = null; load(); } catch (e) { msg(e.message, true); }
    };
    if (s.values) bindAi();
  }

  function main() {
    side();
    if (st.setup) { $('#sMain').innerHTML = detailHtml(); bindDetail(); }
    else { $('#sMain').innerHTML = listHtml(); bindList(); }
  }

  async function load(render = true) {
    const q = new URLSearchParams();
    if (st.car) q.set('car', st.car);
    if (st.track?.id) { q.set('track', st.track.id); if (st.track.layout) q.set('layout', st.track.layout); }
    const r = await api(`/api/setups?${q}`);
    st.cars = r.cars; st.list = r.list; st.folder = r.folder;
    if (!st.car && r.cars[0]?.carId) { st.car = r.cars[0].carId; return load(render); }
    if (!render) return;
    if (st.open && st.list.some((s) => s.id === st.open)) return openSetup(st.open);
    st.open = null; st.setup = null;
    main();
  }

  // ---------------------------------------------------------------- import: the game's own .carsetup files
  $('#sImport').onclick = () => $('#sFile').click();
  $('#sFile').onchange = async (e) => {
    const done = [], failed = [];
    for (const f of e.target.files) {
      const buf = await f.arrayBuffer();
      const send = (track) => fetch(`/api/setups/import?filename=${encodeURIComponent(f.name)}${track ? `&track=${encodeURIComponent(track)}` : ''}`, { method: 'POST', body: buf }).then(async (r) => ({ r, j: await r.json() }));
      try {
        let { r, j } = await send(null);
        if (r.status === 409 && j.needsTrack) {
          // the file name does not say the track: ask
          const track = await new Promise((res) => openTrackPicker({ tracks: cat.tracks, selected: st.track, onPick: (t) => res(t.id) }));
          ({ r, j } = await send(track));
        }
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        done.push(j);
      } catch (err) { failed.push(`${f.name}: ${err.message}`); }
    }
    e.target.value = '';
    if (done.length) { st.car = done[0].carId; remember(); }
    await load();
    msg(`${done.length ? `Imported ${done.map((d) => `"${d.name}" (${d.track})`).join(', ')}.` : 'Nothing imported.'}${failed.length ? ` ${failed.join('; ')}` : ''}`, !done.length);
  };

  await load();
}
