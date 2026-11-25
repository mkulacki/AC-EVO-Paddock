// Setup experiments (PL8): test two setups of one car on one track in alternating stints (A, B, B, A …), with a
// hypothesis, the expected outcome, a change journal and handling feedback by corner phase. Paddock compares the
// typical laps of each setup, leaves out laps that would make the comparison unfair (each with its reason) and says
// "inconclusive" when the laps can't tell. It never loads a setup into the game: the driver does that in the game's
// setup screen. Data: /api/experiments (src/experiments.js, rules in src/experimentstats.js).
import { $, esc, api, post, fmt, fmtGap, prettyName, prov } from './util.js';

const STATUS = { planned: 'Planned', running: 'Running', reviewed: 'Reviewed', archived: 'Archived' };
const day = (t) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const when = (t) => new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const s3 = (ms) => (ms == null ? '–' : `${(Math.abs(ms) / 1000).toFixed(3)} s`);
const num = (v) => (v == null ? '–' : String(+(+v).toFixed(4)));
const comboKey = (c) => `${c.track}|${c.layout}|${c.car}`;
const comboName = (c) => `${prettyName(c.track)} ${prettyName(c.layout)} · ${prettyName(c.car)}`;
const comboOf = (key) => { const [track, layout, car] = String(key || '').split('|'); return track && car ? { track, layout: layout ?? '', car } : null; };
const badge = (st) => `<span class="badge ${st === 'running' ? 'accent' : ''}" data-status="${esc(st)}">${esc(STATUS[st] || st)}</span>`;
const verdictShort = (r) => (!r ? '' : r.kind === 'difference' ? `${r.faster} quicker by ${s3(r.deltaMs)}` : 'Inconclusive');
const NEVER = 'Paddock never loads a setup into the game: before each stint, load that setup yourself in the game\'s setup screen.';

// ---------------------------------------------------------------- the list (and the form for a new one)
export async function viewExperiments(view, params, cleanup) {
  const combo = comboOf(params.get('combo'));
  const q = combo ? `?${new URLSearchParams(combo)}` : '';
  const data = await api(`/api/experiments${q}`);
  const E = data.experiments;
  const head = `<div class="cmp-head">
      ${combo ? `<a href="#/setuphistory?combo=${encodeURIComponent(comboKey(combo))}"><button class="ghost">Setup history</button></a>` : '<a href="#/setups"><button class="ghost">Setups</button></a>'}
      <div><h1>Setup experiments${combo ? ` at ${esc(prettyName(combo.track))} <span class="muted">${esc(prettyName(combo.layout))}</span>` : ''}</h1>
        <div class="secondary">${combo ? esc(prettyName(combo.car)) : 'Test one setup change at a time, on one car and track'}</div></div><span class="spacer"></span>
      ${combo ? `<a href="#/experiments"><button>All experiments</button></a>` : ''}</div>`;
  const item = (x) => `<li class="exp-item" data-exp="${x.id}"><a href="#/experiment?id=${x.id}"><b>${esc(x.title)}</b></a> ${badge(x.status)}
      <div class="muted s">${combo ? '' : `${esc(comboName(x.combo))} · `}A: ${esc(x.variants.A)} · B: ${esc(x.variants.B)} · ${x.plan.done} of ${x.plan.sequence.length} stints${x.result ? ` · <b>${esc(verdictShort(x.result))}</b>` : ''} · ${day(x.createdAt)}</div></li>`;
  const group = (title, list, id) => (list.length ? `<h3 style="margin:14px 0 6px">${title} <span class="muted">${list.length}</span></h3><ul class="exp-list" id="${id}">${list.map(item).join('')}</ul>` : '');
  const active = E.filter((x) => x.status === 'planned' || x.status === 'running'), reviewed = E.filter((x) => x.status === 'reviewed'), archived = E.filter((x) => x.status === 'archived');
  const pick = !combo ? `<div class="row" style="flex-wrap:wrap;gap:8px"><label for="exCombo">Car and track</label>
      <select id="exCombo">${(data.combos || []).map((c) => `<option value="${esc(comboKey(c))}">${esc(comboName(c))} (${c.laps} laps)</option>`).join('')}</select>
      <button id="exGo"${data.combos?.length ? '' : ' disabled'}>New experiment</button></div>` : `<button id="exNewBtn">New experiment</button>`;
  view.innerHTML = `${head}
    <div class="card plain note-warn" style="margin-bottom:12px">Change one thing, then drive A and B in alternating stints (A, B, B, A balances learning and a track that gains grip).
      Paddock compares the typical lap of each setup from every counted lap, never the best lap alone, and says which laps it left out and why. ${esc(NEVER)}</div>
    <div class="card"><div class="row" style="flex-wrap:wrap;gap:8px"><h2 style="margin:0">Experiments</h2><span class="spacer"></span>${pick}</div>
      <div id="exForm"></div>
      ${E.length ? `${group('Planned and running', active, 'exActive')}${group('Reviewed', reviewed, 'exReviewed')}
        ${archived.length ? `<details id="exArchived" style="margin-top:12px"><summary>Archived <span class="muted">${archived.length}</span></summary><ul class="exp-list">${archived.map(item).join('')}</ul></details>` : ''}`
    : `<p class="muted" style="margin:10px 0 0">No experiments${combo ? ' on this car and track' : ''} yet.</p>`}</div>`;
  if (!combo) { const go = $('#exGo'); if (go) go.onclick = () => { location.hash = `#/experiments?${new URLSearchParams({ combo: $('#exCombo').value, new: '1' })}`; }; return; }
  const open = () => { $('#exNewBtn').hidden = true; mountForm($('#exForm'), combo, params.get('parent'), cleanup); };
  $('#exNewBtn').onclick = open;
  if (params.get('new') === '1') open();
}

async function mountForm(el, combo, parentId, cleanup) {
  el.innerHTML = '<p class="muted">Loading the setups of this car and track…</p>';
  const o = await api(`/api/experiments/options?${new URLSearchParams(combo)}`);
  if (!el.isConnected) return;
  const V = o.variants;
  const opt = (i) => `<option value="${i}">${esc(V[i].label)}${V[i].source === 'standard' ? ' (no saved setup)' : V[i].laps ? ` · ${V[i].laps} laps` : ''}</option>`;
  const sel = (id) => `<select id="${id}">${V.map((_, i) => opt(i)).join('')}</select>`;
  const p = o.patterns;
  el.innerHTML = `<form id="exCreate" class="exp-form" style="margin-top:12px" novalidate>
    <h3 style="margin:0 0 8px">New experiment${parentId ? ` <span class="muted">(follow-up of experiment ${esc(parentId)})</span>` : ''}</h3>
    <div class="form">
      <label for="exTitle">Title</label><input id="exTitle" maxlength="120" required placeholder="e.g. More rear wing">
      <label for="exHyp">Hypothesis</label><textarea id="exHyp" rows="2" maxlength="2000" required placeholder="What you change and why, e.g. two more degrees of rear wing calm the exit of T2"></textarea>
      <label for="exMetric">Expected outcome</label><div class="row" style="flex-wrap:wrap;gap:6px">
        <select id="exMetric" aria-label="Measure">${Object.entries(o.metrics).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select>
        <select id="exDir" aria-label="Direction">${Object.entries(o.directions).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select>
        <input id="exExp" maxlength="500" placeholder="In words, e.g. about 0.3 s quicker" aria-label="Expected outcome in words" style="flex:1 1 180px"></div>
      <label for="exA">Setup A (baseline)</label><div>${sel('exA')}<input id="exAName" maxlength="80" placeholder="Name (optional)" aria-label="Name of setup A" style="margin-top:4px"><div class="muted s" id="exALine"></div></div>
      <label for="exB">Setup B (the change)</label><div>${sel('exB')}<input id="exBName" maxlength="80" placeholder="Name (optional)" aria-label="Name of setup B" style="margin-top:4px"><div class="muted s" id="exBLine"></div></div>
      <label for="exPattern">Stint plan</label><div class="row" style="flex-wrap:wrap;gap:6px">
        <select id="exPattern">${Object.keys(p).map((k) => `<option value="${k}">${p[k].join(' ')}${k === 'ABBA' ? ' (recommended)' : ''}</option>`).join('')}</select>
        <label class="row s">laps per stint <input id="exLaps" type="number" min="2" max="30" value="${o.rules.lapsPerStint}" style="width:64px"></label>
        <label class="row s">warm-up laps left out <input id="exWarm" type="number" min="0" max="${o.rules.maxWarmup}" value="${o.rules.warmup}" style="width:56px"></label></div>
      <label for="exMatch">Matched conditions</label><label class="row s"><input id="exMatch" type="checkbox" checked> Leave out laps in other temperatures, weather, grip, aids or session types</label>
    </div>
    <p class="muted s" style="margin:8px 0">The setups listed are the ones you drove here (setup history) and the saved setups of this car for this track (the game lists setups per track: copy one from another track in Setups first). ${esc(NEVER)}
      ${o.game ? `It is recorded on AC EVO ${esc(o.game)}: laps on another game version won't count.` : 'The game version is not known now: the first counted lap sets it.'}</p>
    <div class="row"><button type="submit">Create experiment</button><button type="button" class="ghost" id="exCancel">Cancel</button></div>
    <div class="note-err" id="exErr" role="alert"></div></form>`;
  const line = (i) => (V[i].lineage?.length > 1 ? `From: ${V[i].lineage.slice(1).map((l) => esc(l.name) + (l.gone ? ' (gone)' : '')).join(' ← ')}` : '');
  const sync = () => { $('#exALine').innerHTML = line(+$('#exA').value); $('#exBLine').innerHTML = line(+$('#exB').value); };
  $('#exA').value = '0'; $('#exB').value = V.length > 1 ? '1' : '0';
  $('#exA').onchange = sync; $('#exB').onchange = sync; sync();
  $('#exCancel').onclick = () => { el.innerHTML = ''; const b = $('#exNewBtn'); if (b) { b.hidden = false; b.focus(); } };
  $('#exTitle').focus();
  $('#exCreate').onsubmit = async (ev) => {
    ev.preventDefault();
    const v = (i, name) => ({ rel: V[i].rel, label: name.trim() || (V[i].rel ? '' : V[i].label) });
    try {
      const d = await post('/api/experiments', { action: 'create', combo, title: $('#exTitle').value, hypothesis: $('#exHyp').value,
        expected: { metric: $('#exMetric').value, direction: $('#exDir').value, text: $('#exExp').value },
        a: v(+$('#exA').value, $('#exAName').value), b: v(+$('#exB').value, $('#exBName').value),
        plan: { pattern: $('#exPattern').value, lapsPerStint: +$('#exLaps').value, warmup: +$('#exWarm').value, matchConditions: $('#exMatch').checked },
        parentId: parentId ? Number(parentId) : null });
      location.hash = `#/experiment?id=${d.id}`;
    } catch (e) { $('#exErr').textContent = e.message; }
  };
  void cleanup;
}

// ---------------------------------------------------------------- one experiment
export async function viewExperiment(view, params, cleanup) {
  const id = Number(params.get('id'));
  let d = await api(`/api/experiments/one?id=${id}`);
  let opts = null; // the sessions that can become stints (loaded once, only while stints can be added)
  const draw = async () => {
    const editable = d.status === 'planned' || d.status === 'running';
    if (editable && !opts) { try { opts = await api(`/api/experiments/options?${new URLSearchParams(d.combo)}`); } catch { opts = { sessions: [] }; } }
    if (!view.isConnected) return;
    view.innerHTML = page(d, opts, editable);
    wire(editable);
  };
  const msg = (t) => { const m = $('#exMsg'); if (m) m.textContent = t; };
  async function act(body, focus) {
    try { d = await post('/api/experiments', { id, ...body }); await draw(); if (focus) $(focus)?.focus(); msg(''); }
    catch (e) { msg(e.message); }
  }
  function wire(editable) {
    view.querySelectorAll('[data-start]').forEach((b) => b.onclick = () => act({ action: 'start', variant: b.dataset.start }, '#exEnd'));
    const end = $('#exEnd'); if (end) end.onclick = () => act({ action: 'end' }, '[data-start]');
    view.querySelectorAll('[data-unstint]').forEach((b) => b.onclick = () => { if (confirm('Take this stint out of the experiment? Its laps stay in Paddock but no longer count here.')) act({ action: 'unstint', stintId: Number(b.dataset.unstint) }); });
    const sa = $('#exSessAdd'); if (sa) sa.onclick = () => act({ action: 'session', variant: $('#exSessVar').value, sessionId: Number($('#exSess').value) }, '#exSessAdd');
    const fb = $('#exFbForm'); if (fb) fb.onsubmit = (ev) => { ev.preventDefault(); act({ action: 'feedback', variant: $('#exFbVar').value, phase: $('#exFbPhase').value, balance: $('#exFbBal').value, corner: $('#exFbCorner').value, note: $('#exFbNote').value }, '#exFbVar'); };
    const nf = $('#exNoteForm'); if (nf) nf.onsubmit = (ev) => { ev.preventDefault(); act({ action: 'note', text: $('#exNote').value }, '#exNote'); };
    const rv = $('#exReview'); if (rv) rv.onclick = () => act({ action: 'review', decision: $('#exDecision').value, conclusion: $('#exConcl').value }, '#exReopen');
    const ro = $('#exReopen'); if (ro) ro.onclick = () => act({ action: 'reopen' });
    const ar = $('#exArchive'); if (ar) ar.onclick = () => act({ action: 'archive' }, '#exRestore');
    const rs = $('#exRestore'); if (rs) rs.onclick = () => act({ action: 'restore' }, '#exArchive');
    const del = $('#exDelete'); if (del) del.onclick = async () => {
      if (!confirm(`Delete the experiment "${d.title}" and its journal? Your laps and setup files are not touched.`)) return;
      try { await post('/api/experiments', { action: 'remove', id }); location.hash = `#/experiments?combo=${encodeURIComponent(comboKey(d.combo))}`; } catch (e) { msg(e.message); }
    };
    void editable;
  }
  // laps of an open stint come in while driving: the page follows each new lap
  const onLap = () => { if (d.plan.open) api(`/api/experiments/one?id=${id}`).then((x) => { d = x; return draw(); }).catch(() => {}); };
  window.addEventListener('paddock:lapsaved', onLap);
  cleanup.push(() => window.removeEventListener('paddock:lapsaved', onLap));
  await draw();
}

function page(d, opts, editable) {
  const R = d.result, A = R.variants.A, B = R.variants.B, P = d.plan;
  const key = encodeURIComponent(comboKey(d.combo));
  const head = `<div class="cmp-head">
      <a href="#/experiments?combo=${key}"><button class="ghost">Experiments</button></a>
      <div><h1>${esc(d.title)} ${badge(d.status)}</h1><div class="secondary">${esc(comboName(d.combo))}${R.game ? ` · AC EVO ${esc(R.game)}` : ''}</div></div><span class="spacer"></span>
      <a href="#/setuphistory?combo=${key}"><button>Setup history</button></a></div>`;
  const warn = [...d.warnings.map((w) => w.text), ...(d.liveDiffers ? ['The laps changed after the review (a lap deleted or a session changed): the saved result below is as it was reviewed. Reopen the experiment to work it out again.'] : [])];
  const warnHtml = `<div class="card plain note-warn" id="exWarn" style="margin-bottom:12px">${warn.length ? `<ul style="margin:0 0 6px;padding-left:18px">${warn.map((t) => `<li data-warn>${esc(t)}</li>`).join('')}</ul>` : ''}${esc(NEVER)}</div>`;

  const ex = d.expected || {};
  const meta = `<div class="card"><h2>Hypothesis</h2><p style="margin:0 0 6px" id="exHypText">${esc(d.hypothesis)}</p>
    <p class="muted s" style="margin:0">Expected: <b>${esc(({ pace: 'pace', consistency: 'consistency', validity: 'valid laps', handling: 'handling' })[ex.metric] || ex.metric)}</b>, ${esc(({ better: 'B better than A', worse: 'B worse than A', same: 'no difference' })[ex.direction] || ex.direction)}${ex.text ? ` (“${esc(ex.text)}”)` : ''}.
      ${d.parent ? ` Follows up <a href="#/experiment?id=${d.parent.id}">${esc(d.parent.title)}</a>.` : ''}${d.children.length ? ` Followed up by ${d.children.map((c) => `<a href="#/experiment?id=${c.id}">${esc(c.title)}</a>`).join(', ')}.` : ''}
      Created ${day(d.createdAt)}.</p></div>`;

  const lin = (v) => (v.lineage?.length > 1 ? `<div class="muted s">From: ${v.lineage.slice(1).map((l) => `${esc(l.name)}${l.track && l.track !== v.lineage[0].track ? ` (${esc(l.track)})` : ''}${l.gone ? ' (gone)' : ''}`).join(' ← ')}</div>` : '');
  const vcard = (k) => { const v = d.variants[k]; return `<div><b>${k}: ${esc(v.label)}</b><div class="muted s">${v.rel ? `Saved setup ${esc(v.file || v.rel.split('/').pop().replace(/\.carsetup$/i, ''))}` : 'No saved setup (Standard or an unsaved change)'}</div>${lin(v)}</div>`; };
  const changes = d.changes ? (d.changes.changed.length
    ? `<div class="tablewrap" style="margin-top:8px"><table><thead><tr><th>Setting</th><th>A</th><th>B</th></tr></thead><tbody>${d.changes.changed.map((c) => `<tr><td>${esc(c.label)}${c.corner ? ` <span class="muted">${esc(c.corner)}</span>` : ''}</td><td>${num(c.a)} ${esc(c.unit)}</td><td><b>${num(c.b)}</b> ${esc(c.unit)}</td></tr>`).join('')}</tbody></table></div>
      <p class="muted s" style="margin:4px 0 0">${d.changes.changed.length} value${d.changes.changed.length === 1 ? '' : 's'} differ, ${d.changes.same} the same (as recorded when the experiment was set up).${d.changes.changed.length > 1 ? ' More than one change: the result can\'t say which of them made the difference.' : ''}</p>`
    : '<p class="muted s">The recorded values of A and B are the same.</p>') : '<p class="muted s">What differs between A and B is not known (Standard, or a file Paddock can\'t read): write it in the journal.</p>';
  const setupsCard = `<div class="card"><h2>Setups</h2><div class="grid2" style="grid-template-columns:1fr 1fr">${vcard('A')}${vcard('B')}</div>${changes}</div>`;

  // the plan and the stints
  const seq = P.sequence.map((v, i) => `<span class="pill${i < P.done ? ' on' : ''}" title="${i < P.done ? 'Driven' : i === P.done ? 'Next' : 'Planned'}">${i + 1}. ${v}${i === P.done && !P.open && !P.complete ? ' · next' : ''}</span>`).join('');
  const lapsOf = (s) => R.laps.filter((l) => l.stint === s.id);
  const stintRows = d.stints.map((s, i) => { const L = lapsOf(s); return `<tr><td>${i + 1}</td><td><b>${s.variant}</b> <span class="muted">${esc(d.variants[s.variant].label)}</span></td>
      <td class="muted">${s.sessionId != null ? `session of ${when(s.startAt)}` : `${when(s.startAt)} – ${s.endAt ? when(s.endAt) : '<b>running</b>'}`}</td>
      <td>${L.filter((l) => !l.reason).length}<span class="muted"> / ${L.length}</span>${(P.empty || []).includes(s.id) ? ' <span class="muted s" data-empty>no laps: not counted as driven</span>' : ''}</td>
      <td>${editable ? `<button class="small ghost" data-unstint="${s.id}" aria-label="Take stint ${i + 1} out">Take out</button>` : ''}</td></tr>`; }).join('');
  const sess = (opts?.sessions || []).filter((s) => !d.stints.some((x) => x.sessionId === s.id));
  const controls = editable ? `<div class="row" style="flex-wrap:wrap;gap:8px;margin-top:10px">${P.open
    ? `<button id="exEnd">End stint (${P.open.variant}: ${esc(d.variants[P.open.variant].label)})</button><span class="muted s">Laps you finish now count for ${P.open.variant}. Drive about ${P.lapsPerStint} laps, then end the stint.</span>`
    : ['A', 'B'].map((k) => `<button data-start="${k}" class="${P.next === k ? '' : 'ghost'}">Start stint ${k}${P.next === k ? ' (next)' : ''}</button>`).join('')}</div>
    ${!P.open && sess.length ? `<div class="row" style="flex-wrap:wrap;gap:6px;margin-top:8px"><span class="muted s">Or add a session you drove:</span>
      <label class="sr-only" for="exSess">Session</label><select id="exSess">${sess.map((s) => `<option value="${s.id}">${when(s.startedAt)} · ${s.laps} laps</option>`).join('')}</select>
      <label class="sr-only" for="exSessVar">Setup</label><select id="exSessVar"><option value="A">as A</option><option value="B">as B</option></select>
      <button class="small" id="exSessAdd">Add as stint</button></div>` : ''}` : '';
  const planCard = `<div class="card" id="exPlan"><h2>Stint plan</h2><div class="pills" aria-label="Planned stints">${seq}</div>
    <p class="muted s" style="margin:6px 0 0">About ${P.lapsPerStint} laps a stint; the first ${P.warmup} lap${P.warmup === 1 ? '' : 's'} of each stint ${P.warmup === 1 ? 'is a warm-up and is' : 'are warm-up and are'} left out.${P.complete ? ' The plan is complete.' : ''}</p>
    ${d.stints.length ? `<div class="tablewrap" style="margin-top:8px"><table><thead><tr><th>#</th><th>Setup</th><th>When</th><th title="Counted laps / laps in the stint">Laps</th><th></th></tr></thead><tbody>${stintRows}</tbody></table></div>` : '<p class="muted" style="margin:8px 0 0">No stint driven yet.</p>'}
    ${controls}</div>`;

  // the result
  const C = R.comparison;
  const reasons = (v) => Object.entries(v.excluded).map(([k, n]) => `${n} ${esc((d.reasons[k] || k).toLowerCase())}`).join(', ');
  const cell = (v, f) => (v.summary ? f(v.summary) : '–');
  const valid = (v) => (v.validity.of ? `${v.validity.valid} of ${v.validity.of}` : '–');
  const tbl = `<div class="tablewrap"><table id="exStats"><thead><tr><th></th><th>A: ${esc(A.label)}</th><th>B: ${esc(B.label)}</th></tr></thead><tbody>
    <tr><td>Laps in its stints</td><td>${A.laps} <span class="muted">(${A.stintsDriven} stint${A.stintsDriven === 1 ? '' : 's'})</span></td><td>${B.laps} <span class="muted">(${B.stintsDriven} stint${B.stintsDriven === 1 ? '' : 's'})</span></td></tr>
    <tr><td><b>Counted</b></td><td data-used="A"><b>${A.used}</b></td><td data-used="B"><b>${B.used}</b></td></tr>
    ${A.unrecognised || B.unrecognised ? `<tr><td class="s" title="Setup recognition found no saved setup for these laps (Standard, or not recorded): they count by your stint">Counted by stint only</td><td>${A.unrecognised}</td><td>${B.unrecognised}</td></tr>` : ''}
    <tr><td>Left out</td><td class="s">${reasons(A) || '–'}</td><td class="s">${reasons(B) || '–'}</td></tr>
    <tr><td title="Median of the counted laps">Typical lap</td><td>${cell(A, (s) => fmt(Math.round(s.median)))}</td><td>${cell(B, (s) => fmt(Math.round(s.median)))}</td></tr>
    <tr><td title="Approximate 95 % interval of the typical lap">± interval</td><td>${cell(A, (s) => `±${s3(s.ci)}`)}</td><td>${cell(B, (s) => `±${s3(s.ci)}`)}</td></tr>
    <tr><td title="Middle half of the counted laps (interquartile range)">Spread (IQR)</td><td>${cell(A, (s) => s3(s.iqr))}</td><td>${cell(B, (s) => s3(s.iqr))}</td></tr>
    <tr><td>Valid laps <span class="muted">(after warm-up)</span></td><td>${valid(A)}</td><td>${valid(B)}</td></tr>
    <tr><td class="muted">Best counted lap <span class="s">(shown, not used)</span></td><td class="muted">${fmt(A.bestMs)}</td><td class="muted">${fmt(B.bestMs)}</td></tr>
    ${C.deltaMs != null ? `<tr><td>B against A</td><td colspan="2">typical lap ${fmtGap(C.deltaMs)} s · typical pairwise gap ${fmtGap(C.shiftMs)} s</td></tr>` : ''}</tbody></table></div>`;
  const exp = R.expected;
  const confounds = `<h3 style="margin:14px 0 6px">What else could explain a gap</h3><ul id="exConfounds" style="margin:0;padding-left:18px">${R.confounds.map((c) => `<li${c.strong ? ' class="strong" data-strong' : ''}>${c.strong ? '<b>' : ''}${esc(c.text)}${c.strong ? '</b>' : ''}</li>`).join('')}</ul>`;
  const out = R.laps.filter((l) => l.reason);
  const excl = `<details id="exExcl" style="margin-top:10px"><summary>Laps left out <span class="muted">${out.length} of ${R.laps.length}</span></summary>
    ${out.length ? `<div class="tablewrap"><table><thead><tr><th>Stint</th><th>Setup</th><th>Lap time</th><th>Why</th></tr></thead><tbody>${out.map((l) => `<tr><td>${d.stints.findIndex((s) => s.id === l.stint) + 1 || '–'}</td><td>${l.variant}</td><td>${fmt(l.timeMs)}</td><td>${esc(d.reasons[l.reason] || l.reason)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">None.</p>'}</details>`;
  const resultCard = `<div class="card" id="exResult"><div class="row"><h2 style="margin:0">Result</h2><span class="spacer"></span><span class="muted s">${d.saved ? `Saved at review, ${day(d.reviewedAt)}` : 'Worked out from your laps now'}</span></div>
    <div class="card plain ${C.kind === 'difference' ? '' : 'note-warn'}" data-verdict="${C.kind}" style="margin:10px 0">${prov('calculated', 'From your lap times: medians, spreads and intervals of the counted laps.')} <b>${C.kind === 'difference' ? 'A difference' : 'Inconclusive'}.</b> ${esc(C.text)}</div>
    ${tbl}
    <p style="margin:10px 0 0" data-expected="${esc(exp.status)}"><b>Expected outcome:</b> ${esc({ supported: 'agrees', 'not-supported': 'does not agree', inconclusive: 'not decided', descriptive: 'described only' }[exp.status] || exp.status)}. ${esc(exp.text)}</p>
    ${confounds}${excl}
    <p class="muted s" style="margin:8px 0 0">${R.filter ? `Matched conditions: laps more than 5 °C from the experiment's typical track or air temperature, or with other weather, grip, aids or session type, are left out${R.reference.roadC != null ? ` (typical track ${R.reference.roadC} °C)` : ''}.` : 'Matched conditions are off for this experiment.'}</p></div>`;

  // handling feedback
  const F = R.feedback;
  const fbRow = (k) => Object.values(F[k]).map((c) => `<td>${Object.entries(c).filter(([, n]) => n).map(([b, n]) => `${n}× ${esc(b)}`).join(', ') || '–'}</td>`).join('');
  const fbEntries = d.entries.filter((e) => e.kind === 'feedback');
  const fbCard = `<div class="card" id="exFb"><h2>Handling feedback</h2>
    <p class="muted s" style="margin:0 0 8px">What you felt, by corner phase. Your own judgement: Paddock does not measure balance.</p>
    <div class="tablewrap"><table id="exFbTable"><thead><tr><th></th><th>Entry</th><th>Mid-corner</th><th>Exit</th></tr></thead><tbody>
      <tr><td>A</td>${fbRow('A')}</tr><tr><td>B</td>${fbRow('B')}</tr></tbody></table></div>
    ${fbEntries.length ? `<ul class="s" style="margin:8px 0 0;padding-left:18px">${fbEntries.slice(-8).reverse().map((e) => `<li>${e.data.variant} · ${esc(e.data.phase)} · ${esc(e.data.balance)}${e.data.corner ? ` · ${esc(e.data.corner)}` : ''}${e.data.note ? `: ${esc(e.data.note)}` : ''} <span class="muted">${when(e.at)}</span></li>`).join('')}</ul>` : ''}
    ${d.status !== 'archived' ? `<form id="exFbForm" class="row" style="flex-wrap:wrap;gap:6px;margin-top:10px">
      <label class="sr-only" for="exFbVar">Setup</label><select id="exFbVar"><option value="A">A</option><option value="B"${P.open?.variant === 'B' ? ' selected' : ''}>B</option></select>
      <label class="sr-only" for="exFbPhase">Corner phase</label><select id="exFbPhase"><option value="entry">Entry</option><option value="mid">Mid-corner</option><option value="exit">Exit</option></select>
      <label class="sr-only" for="exFbBal">Balance</label><select id="exFbBal"><option value="understeer">Understeer</option><option value="neutral">Neutral</option><option value="oversteer">Oversteer</option></select>
      <label class="sr-only" for="exFbCorner">Corner</label><input id="exFbCorner" maxlength="40" placeholder="Corner (optional)" style="flex:0 1 130px">
      <label class="sr-only" for="exFbNote">Note</label><input id="exFbNote" maxlength="500" placeholder="Note (optional)" style="flex:1 1 160px">
      <button type="submit" class="small">Add feedback</button></form>` : ''}</div>`;

  // journal
  const jl = [...d.entries].filter((e) => e.kind !== 'feedback').reverse();
  const journal = `<div class="card" id="exJournal"><h2>Journal</h2>
    ${d.status !== 'archived' ? `<form id="exNoteForm" class="row" style="gap:6px;align-items:flex-start;margin-bottom:8px"><label class="sr-only" for="exNote">Journal note</label>
      <textarea id="exNote" rows="2" maxlength="2000" placeholder="What you changed, what you tried, fuel, tyres…" style="flex:1"></textarea><button type="submit" class="small">Add</button></form>` : ''}
    <ul class="exp-journal" style="margin:0;padding-left:18px">${jl.map((e) => `<li data-kind="${e.kind}"><span class="muted s">${when(e.at)}</span> ${e.kind === 'journal' ? `<b>${esc(e.data.text)}</b>` : esc(e.data.text)}
      ${e.data.changes?.length ? `<span class="muted s"> Changed: ${e.data.changes.map((c) => `${esc(c.label)}${c.corner ? ` ${esc(c.corner)}` : ''} ${num(c.a)} → ${num(c.b)}`).join('; ')}.</span>` : e.data.noValues ? `<span class="muted s"> ${esc(e.data.noValues)}</span>` : ''}</li>`).join('')}</ul></div>`;

  // review, archive
  const decisions = Object.entries(d.decisions);
  const review = d.status === 'reviewed'
    ? `<div class="card" id="exReviewCard"><h2>Review</h2><p style="margin:0">Decision: <b data-decision="${esc(d.decision || 'none')}">${esc(d.decisions[d.decision] || 'No decision')}</b>${d.conclusion ? `. ${esc(d.conclusion)}` : ''}</p>
      <div class="row" style="flex-wrap:wrap;gap:8px;margin-top:10px"><button id="exReopen" class="ghost">Reopen to drive more</button>
      <a href="#/experiments?${new URLSearchParams({ combo: comboKey(d.combo), new: '1', parent: String(d.id) })}"><button>Follow-up experiment</button></a>
      <button id="exArchive" class="ghost">Archive</button></div></div>`
    : d.status === 'archived'
      ? `<div class="card" id="exReviewCard"><h2>Archived</h2>${d.saved ? `<p style="margin:0">Decision: <b>${esc(d.decisions[d.decision] || 'No decision')}</b>${d.conclusion ? `. ${esc(d.conclusion)}` : ''}</p>` : ''}
        <div class="row" style="flex-wrap:wrap;gap:8px;margin-top:10px"><button id="exRestore">Restore</button><button id="exDelete" class="ghost">Delete</button></div></div>`
      : `<div class="card" id="exReviewCard"><h2>Review</h2><p class="muted s" style="margin:0 0 8px">Saves the result as it is now with your decision. ${C.kind === 'inconclusive' ? 'The result is inconclusive: "Test again" or "No decision" are honest answers.' : ''}</p>
        <div class="form"><label for="exDecision">Decision</label><select id="exDecision">${decisions.map(([k, v]) => `<option value="${k}"${k === 'none' ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select>
          <label for="exConcl">Conclusion</label><textarea id="exConcl" rows="2" maxlength="2000" placeholder="What you take from it"></textarea></div>
        <div class="row" style="flex-wrap:wrap;gap:8px;margin-top:10px"><button id="exReview"${d.stints.length && !P.open ? '' : ' disabled title="Drive and end at least one stint first"'}>Save the result</button>
          <button id="exArchive" class="ghost">Archive</button></div></div>`;

  return `${head}${warnHtml}<div class="note-err" id="exMsg" role="alert"></div>${meta}${setupsCard}${planCard}${resultCard}${fbCard}${journal}${review}`;
}

/** The experiments card on the Setup history page: this car + track's experiments and a way to start one. */
export async function experimentsCard(el, combo) {
  let data;
  try { data = await api(`/api/experiments?${new URLSearchParams(combo)}`); } catch { el.innerHTML = ''; return; }
  if (!el.isConnected) return;
  const key = encodeURIComponent(comboKey(combo));
  const list = data.experiments.filter((x) => x.status !== 'archived').slice(0, 5);
  el.innerHTML = `<div class="card" id="shExperiments"><div class="row" style="flex-wrap:wrap;gap:8px"><h2 style="margin:0">Setup experiments</h2><span class="spacer"></span>
      <a href="#/experiments?combo=${key}"><button class="ghost">All</button></a><a href="#/experiments?combo=${key}&new=1"><button>New experiment</button></a></div>
    ${list.length ? `<ul class="exp-list" style="margin-top:8px">${list.map((x) => `<li><a href="#/experiment?id=${x.id}">${esc(x.title)}</a> ${badge(x.status)} <span class="muted s">A: ${esc(x.variants.A)} · B: ${esc(x.variants.B)}${x.result ? ` · ${esc(verdictShort(x.result))}` : ''}</span></li>`).join('')}</ul>`
    : '<p class="muted s" style="margin:8px 0 0">Test one change at a time: drive A and B in alternating stints and let Paddock compare the typical laps.</p>'}</div>`;
}
