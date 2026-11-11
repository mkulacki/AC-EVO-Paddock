// Race tab: pick a car, a track and a session type, press Start, and the Paddock HUD sets it all up in the
// game and starts it (also from a closed game, or while another session is running). Cars (specs,
// pictures) and tracks come from AC EVO's own files; the session types and their limits are the game's own.
import { $, esc, api, post, fmt, prettyName, askText } from './util.js';
import { openGarage, openTrackPicker, thumbUrl, variantOf, specTiles, badges, modBadge, prettyId } from './garage.js';

const ago = (t) => { const s = (Date.now() - t) / 1000; return s < 3600 ? `${Math.max(1, Math.round(s / 60))} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const LS = 'race.form2';

export async function viewRace(view, cleanup) {
  let data = await api('/api/race');
  let cat = data.catalogue;
  const M = cat.model, D = M.defaults, LIM = M.limits;
  const fresh = () => ({ kind: 'solo', mode: 'practice', car: null, track: null, time: D.time, timeMult: D.timeMult, weather: D.weather, dynamic: D.dynamic, grip: D.grip,
    practiceMin: D.practiceMin, qualifyingMin: D.qualifyingMin, warmupMin: D.warmupMin, race: { ...D.race }, ai: { ...D.ai }, grid: { custom: false, cars: [] } });
  // any saved or older setup is completed with the defaults
  const complete = (s) => { const f = fresh(); const o = { ...f, ...(s || {}) }; o.race = { ...f.race, ...(s?.race || {}) }; o.ai = { ...f.ai, ...(s?.ai || {}) };
    o.grid = { custom: !!(s?.grid?.custom ?? s?.grid?.cars?.length), cars: s?.grid?.cars || [] }; if (!M.modes.some((m) => m.id === o.mode)) o.mode = 'practice'; delete o.endSession; delete o.values; return o; };
  let st = initialState();
  let driven, trackDriven;
  indexDriven();

  function initialState() {
    try { const s = JSON.parse(localStorage.getItem(LS) || 'null'); if (s) return complete(s); } catch { /* none */ }
    return complete(data.last);
  }
  function indexDriven() {
    driven = new Map(); trackDriven = new Map();
    for (const r of data.recent) {
      const t = r.trackRef ? cat.tracks.find((x) => x.id === r.trackRef.id) : null;
      if (r.car?.id) {
        const d = driven.get(r.car.id) || { laps: 0, bestMs: null, lastAt: 0 };
        d.laps += r.laps; d.lastAt = Math.max(d.lastAt, r.lastAt);
        if (r.bestMs && (!d.bestMs || r.bestMs < d.bestMs)) { d.bestMs = r.bestMs; d.where = `${t?.name || prettyName(r.track)} ${r.layout || ''}`.trim(); }
        driven.set(r.car.id, d);
      }
      if (r.trackRef) {
        const k = `${r.trackRef.id}|${r.trackRef.layout}`, d = trackDriven.get(k) || { bestMs: null, laps: 0, lastAt: 0 };
        d.laps += r.laps || 0; d.lastAt = Math.max(d.lastAt, r.lastAt || 0);
        if (r.bestMs && (!d.bestMs || r.bestMs < d.bestMs)) d.bestMs = r.bestMs;
        trackDriven.set(k, d);
      }
    }
  }
  const remember = () => { try { localStorage.setItem(LS, JSON.stringify(st)); } catch { /* ignore */ } };
  const mode = () => M.modes.find((m) => m.id === st.mode) || M.modes[0];
  const carById = (id) => cat.cars.find((c) => c.id === id);
  const trackOf = (t) => { const tr = cat.tracks.find((x) => x.id === t?.id); return tr ? { t: tr, l: tr.layouts.find((x) => x.key === t.layout) || tr.layouts[0] } : null; };
  const offered = (l, m = st.mode) => l.modes[m] !== false;   // false = the game has no such layout for this session type
  const gridMax = () => { const tl = trackOf(st.track); const n = tl?.l.modes[st.mode]; return typeof n === 'number' && n > 1 ? n - 1 : 40; };

  view.innerHTML = `
    <div class="race-head"><div><h1>Race</h1><div class="sub" id="rInfo"></div></div><span class="spacer"></span>
      <div class="tabs" style="margin:0"><a href="#" data-kind="solo">Solo</a><a href="#" data-kind="mp">Online</a></div></div>
    <div id="rLaunch" class="launch-box"></div>
    <div id="rBody"></div>`;

  // ---------------------------------------------------------------- header + launch progress
  function headInfo() {
    const at = cat.readAt ? new Date(cat.readAt) : null;
    const when = at ? `<span class="muted" title="${esc(at.toLocaleString())} (${ago(cat.readAt)})">last updated ${esc(at.toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }))}</span>`
      : '<span class="muted">never updated from game</span>';
    $('#rInfo').innerHTML = `${cat.cars.length} cars · ${cat.tracks.length} tracks, from the game's own files · <a href="#" id="rScan" title="Starts the game and re-reads which layouts each session type offers and which cars the AI can drive. Only needed after a game update.">update from game</a> · ${when}`;
    $('#rScan').onclick = async (e) => { e.preventDefault(); try { const r = await post('/api/race/scan', {}); msg(r.msg); } catch (err) { msg(err.message, true); } poll(); };
  }
  const msg = (text, bad) => { const el = $('#rMsg'); if (el) el.innerHTML = `<span class="${bad ? 'error' : 'muted'}">${esc(text)}</span>`; };

  let game = data.game, lastScanDone = null, hidden = null, firstPoll = true;
  async function poll() {
    if (!document.body.contains(view) || !$('#rLaunch')) return;
    let g; try { g = await api('/api/race/status'); } catch { return; }
    game = g;
    const L = g.launch, box = $('#rLaunch');
    if (!box) return;
    const waiting = !g.running ? 'Waiting for the game to start…' : g.inSession ? 'A session is running in the game: leave it (Esc → quit session) and the Paddock HUD carries on.' : 'Waiting for the Paddock HUD on the game\'s menu…';
    box.innerHTML = L.order || L.events.length ? `<div class="card" style="margin:0">
      ${L.order ? `<div class="row"><span class="spinner"></span><b>${L.order.kind === 'solo' || L.order.kind === 'mp' ? 'Starting' : 'Reading the game'}</b><span class="muted">${esc(L.order.summary || '')}</span>
        <span class="spacer"></span><button class="small ghost" id="rCancel">Cancel</button></div>` : '<div class="row"><b>Last start</b><span class="spacer"></span><button class="small ghost" id="rHide">Hide</button></div>'}
      ${L.events.length ? `<ol>${L.events.map((e) =>
        `<li class="${e.step === 'error' ? 'g-bad' : e.step === 'warn' ? 'pos' : e.step === 'started' || e.step === 'scandone' ? 'g-ok' : ''}">${esc(e.msg || e.step)}</li>`).join('')}</ol>`
        : `<div class="muted" style="margin-top:6px">${waiting}</div>`}
    </div>` : '';
    if ($('#rCancel')) $('#rCancel').onclick = async () => { await post('/api/game/cancel', {}); poll(); };
    if ($('#rHide')) $('#rHide').onclick = () => { box.innerHTML = ''; hidden = L.events.at(-1)?.at; };
    if (!L.order && hidden && L.events.at(-1)?.at === hidden) box.innerHTML = '';
    // game data read while this page is open: reload the catalogue (which layouts each session type offers)
    const doneAt = L.events.find((e) => e.step === 'scandone' || e.step === 'started')?.at ?? null;
    if (!firstPoll && doneAt && doneAt !== lastScanDone) setTimeout(reload, 2500);
    lastScanDone = doneAt; firstPoll = false;
  }
  async function reload() { data = await api('/api/race'); cat = data.catalogue; indexDriven(); if ($('#rInfo')) headInfo(); if (document.body.contains(view) && !document.querySelector('.modal-back')) body(); }
  const timer = setInterval(poll, 1500);
  cleanup.push(() => { clearInterval(timer); document.querySelector('.modal-back')?.remove(); document.body.style.overflow = ''; });

  view.querySelectorAll('[data-kind]').forEach((a) => { a.onclick = (e) => { e.preventDefault(); st.kind = a.dataset.kind; remember(); body(); }; });

  function body() {
    view.querySelectorAll('[data-kind]').forEach((a) => a.classList.toggle('on', a.dataset.kind === st.kind));
    if (st.kind === 'mp') bodyOnline(); else bodySolo();
  }

  // ---------------------------------------------------------------- car + track panels
  function carPanel(withPicker = true) {
    const c = st.car?.id ? carById(st.car.id) : null;
    if (!c) {
      const label = st.car?.display ? prettyName(st.car.display) : null;
      return `<div class="pick"><div class="pick-media" data-open-car><div class="empty-pick">${label ? `${esc(label)}<br><span style="font-size:12px">not found in the game's car list</span>` : `<div><div style="font-size:42px;line-height:1">🏎️</div>Choose a car</div>`}</div>
        ${withPicker ? '<button class="small change" data-open-car>Open garage</button>' : ''}</div></div>`;
    }
    const v = variantOf(c, st.car.mech);
    const livs = (v?.liveries || []).filter((l) => l.thumb);
    return `<div class="pick">
      <div class="pick-media" data-open-car><img alt="" src="${thumbUrl(c.id, v?.mech, st.car.visual)}"><div class="shade"></div>
        <div class="over"><span class="eyebrow">${esc(c.brand)}</span><div class="title">${esc(c.name)}</div><div class="badges">${badges(c, v)}${c.variants.length > 1 ? `<span class="badge">${esc(v.trim && v.trim !== 'Standard' ? v.trim : v.name)}</span>` : ''}</div></div>
        <button class="small change" data-open-car>Change car</button></div>
      <div class="pick-body">
        ${c.variants.length > 1 ? `<div class="pills">${c.variants.map((x) => `<button class="pill ${x.mech === v.mech ? 'on' : ''}" data-mech="${esc(x.mech)}">${esc(x.trim && x.trim !== 'Standard' ? x.trim : x.name)}</button>`).join('')}</div>` : ''}
        ${specTiles(c, v, { compact: true })}
        ${livs.length > 1 ? `<div class="liveries">${livs.map((l) => `<button class="livery ${l.visual === st.car.visual || (!st.car.visual && l === livs[0]) ? 'on' : ''}" data-vis="${esc(l.visual)}" title="${esc(prettyId(l.visual))}"><img loading="lazy" alt="" src="${thumbUrl(c.id, v.mech, l.visual)}"></button>`).join('')}</div>` : ''}
      </div></div>`;
  }
  function bindCarPanel(after) {
    view.querySelectorAll('[data-open-car]').forEach((el) => { el.onclick = (e) => { e.stopPropagation(); garage(); }; });
    view.querySelectorAll('.pick [data-mech]').forEach((b) => { b.onclick = () => { st.car = { ...st.car, mech: b.dataset.mech, visual: null }; remember(); after(); }; });
    view.querySelectorAll('.pick [data-vis]').forEach((b) => { b.onclick = () => { st.car = { ...st.car, visual: b.dataset.vis }; remember(); after(); }; });
    function garage() {
      openGarage({ cars: cat.cars, driven, selected: st.car, onPick: (s) => { st.car = { id: s.id, mech: s.mech, visual: s.visual }; remember(); after(); } });
    }
  }
  // tracks and layouts the game offers for the chosen session type
  const tracksForMode = () => cat.tracks.map((t) => ({ ...t, layouts: t.layouts.filter((l) => offered(l)) })).filter((t) => t.layouts.length);
  function trackPanel() {
    const tl = trackOf(st.track);
    if (!tl) return `<div class="pick"><div class="pick-media map" data-open-track><div class="empty-pick"><div><div style="font-size:42px;line-height:1">🏁</div>Choose a track</div></div><button class="small change" data-open-track>Choose track</button></div><div class="pick-body" id="rRecord"></div></div>`;
    const { t, l } = tl;
    return `<div class="pick">
      <div class="pick-media map" data-open-track style="background:radial-gradient(circle at 50% 40%,#20242a,var(--tile) 70%)">${l.hasMap ? `<img alt="" src="/api/tracks/map?track=${encodeURIComponent(t.id)}&layout=${encodeURIComponent(l.key)}">` : ''}<div class="shade"></div>
        <div class="over"><span class="eyebrow">${esc(t.country || '')}</span><div class="title">${esc(t.name)}</div><div class="badges">${modBadge(t)}<span class="badge">${esc(l.name)}</span>${l.lengthM ? `<span class="badge">${(l.lengthM / 1000).toFixed(2)} km</span>` : ''}${typeof l.modes[st.mode] === 'number' ? `<span class="badge">up to ${l.modes[st.mode]} cars</span>` : ''}${offered(l) ? '' : `<span class="badge bad">not offered for ${esc(mode().label)}</span>`}</div></div>
        <button class="small change" data-open-track>Change track</button></div>
      <div class="pick-body">
        ${t.layouts.length > 1 ? `<div class="pills">${t.layouts.map((x) => `<button class="pill ${x.key === l.key ? 'on' : ''}" data-layout="${esc(x.key)}" ${offered(x) ? '' : `disabled title="the game does not offer this layout for ${esc(mode().label)}"`}>${esc(x.name)}</button>`).join('')}</div>` : ''}
        <div id="rRecord"></div></div></div>`;
  }
  function bindTrackPanel(after) {
    view.querySelectorAll('[data-open-track]').forEach((el) => { el.onclick = (e) => { e.stopPropagation(); openTrackPicker({ tracks: tracksForMode(), driven: trackDriven, selected: st.track, onPick: (t) => { st.track = t; remember(); after(); } }); }; });
    view.querySelectorAll('[data-layout]').forEach((b) => { b.onclick = () => { st.track = { ...st.track, layout: b.dataset.layout }; remember(); after(); }; });
  }

  // ================================================================ SOLO
  const num = (id, key, [lo, hi], unit, obj = 'st') => `<div class="row" style="gap:8px"><input type="number" id="${id}" data-num="${key}" data-obj="${obj}" min="${lo}" max="${hi}" step="1" style="width:90px"><span class="muted">${unit}</span></div>`;
  const seg = (name, options, value) => `<div class="seg" data-seg="${name}">${options.map((o) => `<button data-v="${esc(o.id)}" class="${String(o.id) === String(value) ? 'on' : ''}">${esc(o.label)}</button>`).join('')}</div>`;

  function bodySolo() {
    const m = mode(), tl = trackOf(st.track);
    const blocked = tl && !offered(tl.l);
    st.ai.count = Math.max(1, Math.min(gridMax(), Number(st.ai.count) || D.ai.count));
    $('#rBody').innerHTML = `
      <div class="setup">${carPanel()}${trackPanel()}</div>
      <h3 style="margin:22px 0 10px">Session</h3>
      <div class="modes">${M.modes.map((x) => `<button class="mode-card ${x.id === st.mode ? 'on' : ''}" data-mode="${x.id}"><span class="t">${esc(x.label)}</span><span class="d">${esc(x.hint)}</span></button>`).join('')}</div>
      <div class="settings">
        <div class="card"><h2>Conditions</h2><div class="fields">
          <label>${m.id === 'weekend' ? 'Race start' : 'Time of day'}</label><div><input type="time" id="fTime" step="300" value="${esc(st.time)}"></div>
          <label>Time passes</label><div><select id="fMult">${M.multipliers.map((x) => `<option value="${x}" ${x === Number(st.timeMult) ? 'selected' : ''}>${x === 1 ? 'in real time' : `${x}× faster`}</option>`).join('')}</select></div>
          <label>Weather</label><div><select id="fWeather">${M.weather.map((w) => `<option value="${w.id}" ${w.id === st.weather ? 'selected' : ''}>${esc(w.label)}</option>`).join('')}</select></div>
          <label>Weather changes</label><div>${seg('dynamic', [{ id: 'false', label: 'Stays the same' }, { id: 'true', label: 'Dynamic' }], String(!!st.dynamic))}</div>
          <label>Track grip</label><div>${seg('grip', M.grips, st.grip)}</div>
        </div>${m.id === 'weekend' ? '<p class="muted" style="font-size:12px;margin:10px 0 0">Practice starts 5 h, qualifying 2 h and the warm-up 1 h before the race, as in the game.</p>' : ''}</div>
        <div class="card"><h2>${m.id === 'weekend' ? 'Sessions' : 'Length'}</h2><div class="fields">
          ${m.practice ? `<label>Practice</label>${num('fPractice', 'practiceMin', LIM.practiceMin, 'minutes')}` : ''}
          ${m.qualifying ? `<label>Qualifying</label>${num('fQuali', 'qualifyingMin', LIM.qualifyingMin, 'minutes')}` : ''}
          ${m.warmup ? `<label>Warm-up</label>${num('fWarm', 'warmupMin', LIM.warmupMin, 'minutes (0 = none)')}` : ''}
          ${m.race ? `<label>Race length</label><div>${seg('raceType', [{ id: 'laps', label: 'Laps' }, { id: 'time', label: 'Time' }], st.race.type)}</div>
            <label></label>${st.race.type === 'time' ? num('fRaceMin', 'minutes', LIM.raceMin, 'minutes', 'race') : num('fRaceLaps', 'laps', LIM.raceLaps, 'laps', 'race')}` : ''}
          ${m.startPos ? `<label>You start</label><div><select id="fStart"><option value="0">Random place</option>${Array.from({ length: st.ai.count + 1 }, (_, i) => `<option value="${i + 1}" ${Number(st.race.startPos) === i + 1 ? 'selected' : ''}>P${i + 1}${i === 0 ? ' (pole)' : i === st.ai.count ? ' (last)' : ''}</option>`).join('')}</select></div>` : ''}
          ${m.id === 'hotlap' ? '<label>Length</label><div class="muted">One hour of flying laps, set by the game.</div>' : ''}
        </div></div>
        ${m.ai ? `<div class="card"><h2>AI opponents</h2><div class="fields">
          <label>Opponents</label>${num('fCount', 'count', [1, gridMax()], `cars (up to ${gridMax()} here)`, 'ai')}
          <label>Strength</label><div class="row" style="gap:8px"><input type="number" data-num="min" data-obj="ai" min="${LIM.strength[0]}" max="${LIM.strength[1]}" style="width:74px"><span class="muted">to</span><input type="number" data-num="max" data-obj="ai" min="${LIM.strength[0]}" max="${LIM.strength[1]}" style="width:74px"><span class="muted">% (${LIM.strength[0]}–${LIM.strength[1]})</span></div>
          <label>Behaviour</label><div>${seg('aggression', M.aggression, st.ai.aggression)}</div>
          <label>Their cars</label><div>${seg('gridMode', [{ id: 'auto', label: 'Game picks' }, { id: 'same', label: 'Same as mine' }, { id: 'custom', label: 'I pick' }], st.grid.custom ? 'custom' : st.ai.singleMake ? 'same' : 'auto')}</div></div>
          <div id="gPick" ${st.grid.custom ? '' : 'hidden'} style="margin-top:14px">
            <div class="row"><button class="small" id="gGarage">+ Add cars</button><button class="small ghost" id="gMine" title="add the car you drive">+ My car</button></div>
            <div class="chips" id="gChosen" style="margin-top:10px"></div>
            <p class="muted" style="font-size:12px;margin:8px 0 0">The chosen cars fill the grid in turn. A car the game does not offer to the AI keeps the game's pick for that place.</p>
          </div></div>` : ''}
      </div>
      <div class="actionbar">
        <div class="summary"><b id="rSummary"></b><span id="rMsg">${blocked ? `<span class="error">The game does not offer ${esc(tl.t.name)} ${esc(tl.l.name)} for ${esc(m.label)}: pick another layout or session type.</span>` : ''}</span></div><span class="spacer"></span>
        <select id="rRandMode" title="what the dice may pick"><option value="any">Any car &amp; track</option><option value="driven">Combos I've driven</option><option value="new">New combos only</option></select>
        <button id="rRand" title="random car, track, time and weather">🎲 Random</button>
        <button id="rSave">Save preset</button>
        <button class="primary big" id="rGo" ${blocked ? 'disabled' : ''}>Start ${esc(m.label)} ▸</button>
      </div>
      ${presetsCard()}
      ${recentCard()}`;

    const again = () => bodySolo();
    bindCarPanel(again); bindTrackPanel(again);
    view.querySelectorAll('.modes [data-mode]').forEach((b) => { b.onclick = () => { st.mode = b.dataset.mode; remember(); bodySolo(); }; });
    // fields
    $('#fTime').onchange = (e) => { st.time = e.target.value || D.time; remember(); };
    $('#fMult').onchange = (e) => { st.timeMult = Number(e.target.value); remember(); };
    $('#fWeather').onchange = (e) => { st.weather = e.target.value; remember(); };
    if ($('#fStart')) $('#fStart').onchange = (e) => { st.race.startPos = Number(e.target.value); remember(); };
    view.querySelectorAll('[data-num]').forEach((el) => {
      const o = el.dataset.obj === 'st' ? st : st[el.dataset.obj];
      el.value = o[el.dataset.num];
      el.onchange = () => {
        const v = Math.max(Number(el.min), Math.min(Number(el.max), Math.round(Number(el.value)) || Number(el.min)));
        o[el.dataset.num] = v; el.value = v;
        if (el.dataset.obj === 'ai' && st.ai.min > st.ai.max) { if (el.dataset.num === 'min') st.ai.max = v; else st.ai.min = v; }
        remember();
        if (el.dataset.obj === 'ai') bodySolo(); // the start places follow the grid size
      };
    });
    const SEG = {
      dynamic: (v) => { st.dynamic = v === 'true'; }, grip: (v) => { st.grip = v; }, raceType: (v) => { st.race.type = v; },
      aggression: (v) => { st.ai.aggression = v; },
      gridMode: (v) => { st.grid.custom = v === 'custom'; st.ai.singleMake = v === 'same'; },
    };
    view.querySelectorAll('[data-seg]').forEach((box) => box.querySelectorAll('button').forEach((b) => { b.onclick = () => { SEG[box.dataset.seg](b.dataset.v); remember(); bodySolo(); }; }));
    if (m.ai) bindGrid();
    record(); summary();
    $('#rGo').onclick = () => launch(spec());
    $('#rRand').onclick = () => randomize($('#rRandMode').value);
    $('#rSave').onclick = savePreset;
    bindPresets(); bindRecent();
  }

  function summary() {
    const c = st.car?.id ? carById(st.car.id) : null, tl = trackOf(st.track);
    const el = $('#rSummary');
    if (el) el.textContent = [st.kind === 'mp' ? 'Online' : mode().label, c ? `${c.brand} ${c.name}` : st.car?.display, tl ? `${tl.t.name} ${tl.l.name}` : null].filter(Boolean).join('  ·  ') || 'Choose a car and a track';
  }

  // Start: also from a closed game. With a session running in the game, ask before ending it.
  async function launch(s) {
    try {
      let g = game; try { g = await api('/api/race/status'); } catch { /* keep the last one */ }
      if (g?.inSession) {
        if (!confirm('A session is running in the game.\n\nEnd it and start this one?')) return;
        s = { ...s, endSession: true };
      }
      const r = await post('/api/race/launch', s);
      msg(g?.inSession ? 'Ending the running session, then starting…' : r.started ? r.msg : 'The game is running: the Paddock HUD starts the session from its menu.');
      window.scrollTo({ top: 0, behavior: 'smooth' });
      poll();
    } catch (e) { msg(e.message, true); }
  }

  function bindGrid() {
    const g = st.grid;
    const chosen = () => {
      $('#gChosen').innerHTML = g.cars.length ? g.cars.map((c, i) => { const car = carById(c.id); return `<span class="chip"><img alt="" src="${thumbUrl(c.id, c.mech)}" style="width:44px;height:28px;object-fit:cover;border-radius:4px">${esc(car ? car.name : c.id)}${modBadge(car)}<button class="small ghost" data-rm="${i}">×</button></span>`; }).join('')
        : '<span class="muted" style="font-size:13px">No cars yet: the game picks until you add some.</span>';
      $('#gChosen').querySelectorAll('[data-rm]').forEach((b) => { b.onclick = () => { g.cars.splice(+b.dataset.rm, 1); remember(); chosen(); }; });
    };
    $('#gGarage').onclick = () => openGarage({ cars: cat.cars, driven, aiOnly: true, multi: true, title: 'Add opponent cars', chosenCount: () => g.cars.length,
      onAdd: (s) => { g.cars.push({ id: s.id, mech: s.mech }); remember(); chosen(); } });
    $('#gMine').onclick = () => { if (st.car?.id) { g.cars.push({ id: st.car.id, mech: st.car.mech }); remember(); chosen(); } };
    chosen();
  }

  function spec(from = st) {
    const { grid, ...s } = structuredClone(from);
    if (grid?.custom && grid.cars.length) s.grid = { cars: grid.cars };
    return s;
  }

  // ---------------------------------------------------------------- record for the chosen combo
  let recSeq = 0;
  async function record() {
    const box = $('#rRecord'); if (!box) return;
    if (!st.track?.id || !st.car) { box.innerHTML = '<p class="muted" style="margin:0">Your best and ideal lap for the chosen car and track appear here.</p>'; return; }
    const q = new URLSearchParams({ track: st.track.id, layout: st.track.layout || '', car: st.car.id || '', display: st.car.display || '' });
    const seq = ++recSeq;
    let r; try { r = await api(`/api/race/combo?${q}`); } catch { return; }
    if (seq !== recSeq || !$('#rRecord')) return;
    const tile = (k, v, hi) => `<div class="spec${hi ? ' hi' : ''}"><div class="k">${k}</div><div class="v">${v}</div></div>`;
    $('#rRecord').innerHTML = !r.laps ? '<div class="row"><span class="badge accent">New combo</span><span class="muted" style="font-size:13px">You have not driven this car here yet.</span></div>'
      : `<div class="record">${tile('Your best', fmt(r.bestMs), true)}${tile('Ideal', fmt(r.idealMs))}${tile('Laps', r.laps)}${tile('Last driven', `<span style="font-size:14px">${ago(r.lastAt)}</span>`)}</div>
        ${r.bestMs && r.idealMs ? `<div class="muted" style="font-size:12px">${((r.bestMs - r.idealMs) / 1000).toFixed(3)} s on the table: your best corners put together.${r.comboKey ? ` <a href="#/progress?combo=${encodeURIComponent(r.comboKey)}">Progress</a>` : ''}</div>` : ''}`;
  }

  // ---------------------------------------------------------------- random
  function randomize(how) {
    const pairs = data.recent.filter((r) => r.trackRef && r.car?.id);
    if (how === 'driven') {
      if (!pairs.length) return msg('No driven combos found in the car list yet.', true);
      const r = pick(pairs);
      st.car = { id: r.car.id, mech: null, visual: null }; st.track = { ...r.trackRef };
    } else {
      const tracks = tracksForMode();
      if (!cat.cars.length || !tracks.length) return msg('No cars or tracks found in the game files.', true);
      for (let i = 0; i < 300; i++) {
        const c = pick(cat.cars), t = pick(tracks), l = pick(t.layouts);
        if (how === 'new' && pairs.some((r) => r.car.id === c.id && r.trackRef.id === t.id && r.trackRef.layout === l.key)) continue;
        const v = pick(c.variants), liv = (v.liveries || []).filter((x) => x.thumb);
        st.car = { id: c.id, mech: v.mech, visual: liv.length ? pick(liv).visual : null }; st.track = { id: t.id, layout: l.key };
        break;
      }
    }
    st.time = `${String(8 + Math.floor(Math.random() * 11)).padStart(2, '0')}:${pick(['00', '15', '30', '45'])}`;
    st.weather = pick(M.weather.slice(0, 4).concat(M.weather)).id; // dry weather twice as likely
    remember(); body();
  }

  // ---------------------------------------------------------------- presets and quick picks
  function presetsCard() {
    const list = data.presets.filter((p) => (p.spec?.kind || 'solo') === st.kind);
    return `<h3 style="margin:26px 0 10px">Presets</h3>${!list.length ? '<div class="card"><span class="muted">Save a setup with <b>Save preset</b> to start it again in one click.</span></div>'
      : `<div class="mini-grid">${list.map((p) => { const c = p.spec?.car?.id ? carById(p.spec.car.id) : null; return `<div class="mini">
        <div class="img">${c ? `<img loading="lazy" alt="" src="${thumbUrl(c.id, p.spec.car.mech, p.spec.car.visual)}">` : ''}</div>
        <div class="body"><b>${esc(p.name)} ${modBadge(c)}</b><span class="muted">${esc(describe(p.spec))}</span><span class="spacer"></span>
          <div class="acts"><button class="small primary" data-pgo="${p.id}">Start ▸</button><button class="small" data-pload="${p.id}">Load</button><span class="spacer"></span><button class="small ghost" data-pdel="${p.id}">Delete</button></div></div></div>`; }).join('')}</div>`}`;
  }
  function describe(s) {
    if (!s) return '';
    const c = s.car?.id ? carById(s.car.id) : null;
    if (s.kind === 'mp') return [`Online · ${data.servers.find((x) => x.id === s.serverId)?.name || ''}`, c?.name].filter(Boolean).join(' · ');
    const m = M.modes.find((x) => x.id === s.mode), tl = trackOf(s.track);
    return [m?.label, tl && `${tl.t.name} ${tl.l.name}`, c ? c.name : s.car?.display].filter(Boolean).join(' · ');
  }
  function bindPresets() {
    const byId = (id) => data.presets.find((p) => p.id === id);
    view.querySelectorAll('[data-pload]').forEach((b) => { b.onclick = () => {
      const p = structuredClone(byId(b.dataset.pload).spec);
      st = p.kind === 'mp' ? { ...st, ...p } : complete(p);
      remember(); body(); window.scrollTo({ top: 0, behavior: 'smooth' });
    }; });
    view.querySelectorAll('[data-pgo]').forEach((b) => { b.onclick = () => { const p = byId(b.dataset.pgo).spec; launch(p.kind === 'mp' ? p : spec(complete(p))); }; });
    view.querySelectorAll('[data-pdel]').forEach((b) => { b.onclick = async () => {
      if (!confirm(`Delete preset "${byId(b.dataset.pdel).name}"?`)) return;
      Object.assign(data, await api(`/api/race/presets/${b.dataset.pdel}`, { method: 'DELETE' })); body();
    }; });
  }
  async function savePreset() {
    const c = st.car?.id ? carById(st.car.id) : null, tl = trackOf(st.track);
    const name = await askText('Preset name', [c?.name, tl?.t.name, st.kind === 'mp' ? null : mode().label].filter(Boolean).join(' · ') || 'My setup');
    if (!name) return;
    try { Object.assign(data, await post('/api/race/presets', { name, spec: st.kind === 'mp' ? { kind: 'mp', car: st.car, serverId: st.serverId } : spec() })); body(); msg(`Saved "${name}"`); }
    catch (e) { msg(e.message, true); }
  }
  function recentCard() {
    const r = data.recent.slice(0, 8);
    if (!r.length) return '';
    return `<h3 style="margin:26px 0 10px">Quick picks <span class="muted" style="text-transform:none;letter-spacing:0;font-weight:400">· your recent combos, started as ${esc(mode().label)} with the conditions above</span></h3>
      <div class="mini-grid">${r.map((c, i) => { const car = c.car?.id ? carById(c.car.id) : null; const tl = c.trackRef ? trackOf(c.trackRef) : null; const ok = tl && offered(tl.l); return `<div class="mini">
        <div class="img">${car ? `<img loading="lazy" alt="" src="${thumbUrl(car.id)}">` : ''}${c.bestMs ? `<span class="time">${fmt(c.bestMs)}</span>` : ''}</div>
        <div class="body"><b>${esc(car ? `${car.brand} ${car.name}` : prettyName(c.carName))} ${modBadge(car)}</b><span class="muted">${esc(tl ? `${tl.t.name} · ${tl.l.name}` : `${prettyName(c.track)} ${c.layout || ''}`)} · ${c.laps} laps · ${ago(c.lastAt)}</span><span class="spacer"></span>
          <div class="acts"><button class="small primary" data-rgo="${i}" ${ok ? '' : 'disabled title="this track is not offered for the chosen session type"'}>Start ▸</button><button class="small" data-rload="${i}" ${c.trackRef ? '' : 'disabled title="track not found in the game data"'}>Load</button></div></div></div>`; }).join('')}</div>`;
  }
  const useRecent = (c) => { st.car = c.car.id ? { id: c.car.id, mech: null, visual: null } : { display: c.car.display }; st.track = { ...c.trackRef }; remember(); };
  function bindRecent() {
    view.querySelectorAll('[data-rload]').forEach((b) => { b.onclick = () => { useRecent(data.recent[+b.dataset.rload]); bodySolo(); window.scrollTo({ top: 0, behavior: 'smooth' }); }; });
    view.querySelectorAll('[data-rgo]').forEach((b) => { b.onclick = () => { useRecent(data.recent[+b.dataset.rgo]); bodySolo(); launch(spec()); }; });
  }

  // ================================================================ ONLINE
  function bodyOnline() {
    $('#rBody').innerHTML = `
      <div class="setup">
        <div>${st.car ? carPanel() : `<div class="pick"><div class="pick-media" data-open-car><div class="empty-pick"><div><div style="font-size:42px;line-height:1">🏎️</div>Using the car selected in the game<br><span style="font-size:12px">or choose one</span></div></div><button class="small change" data-open-car>Open garage</button></div></div>`}
          ${st.car ? '<button class="ghost small" id="oKeep" style="margin-top:8px">Use the car selected in the game instead</button>' : ''}</div>
        <div class="card" style="margin:0"><h2>Server</h2>
          ${data.servers.length ? `<div style="display:flex;flex-direction:column;gap:8px">${data.servers.map((s) => `<label class="mode-card ${st.serverId === s.id ? 'on' : ''}" style="display:flex;align-items:center;gap:12px;cursor:pointer">
            <input type="radio" name="srv" value="${s.id}" ${st.serverId === s.id ? 'checked' : ''}><span style="flex:1"><span class="t">${esc(s.name)}</span><span class="d">${esc(s.ip)}:${s.port}${s.hasPassword ? ' · password saved' : ''}</span></span>
            <button class="small ghost" data-sdel="${s.id}">Delete</button></label>`).join('')}</div>` : '<p class="muted">No saved servers yet.</p>'}
          <h3 style="margin-top:18px">Add a server</h3>
          <div class="fields"><label>Name</label><input id="sName" placeholder="e.g. league server">
            <label>Address</label><input id="sIp" placeholder="IP or host name"><label>Port</label><input id="sPort" type="number" placeholder="9700">
            <label>Password</label><input id="sPw" type="password" autocomplete="off" placeholder="if the server has one">
            <span></span><div><button id="sAdd">Save server</button></div></div>
          <p class="muted" style="font-size:12px;margin-bottom:0">The Paddock HUD opens the game's server list aimed at this address and presses Join. The server decides whether your car is allowed.</p>
        </div>
      </div>
      <div class="actionbar"><div class="summary"><b id="rSummary"></b><span id="rMsg"></span></div><span class="spacer"></span>
        <button id="rSave">Save preset</button><button class="primary big" id="oGo">Join server ▸</button></div>
      ${presetsCard()}`;
    bindCarPanel(() => bodyOnline());
    if ($('#oKeep')) $('#oKeep').onclick = () => { st.car = null; remember(); bodyOnline(); };
    view.querySelectorAll('input[name=srv]').forEach((r) => { r.onchange = () => { st.serverId = r.value; remember(); bodyOnline(); }; });
    view.querySelectorAll('[data-sdel]').forEach((b) => { b.onclick = async (e) => {
      e.preventDefault();
      if (!confirm('Delete this server?')) return;
      Object.assign(data, await api(`/api/race/servers/${b.dataset.sdel}`, { method: 'DELETE' })); bodyOnline();
    }; });
    $('#sAdd').onclick = async () => {
      try { Object.assign(data, await post('/api/race/servers', { name: $('#sName').value, ip: $('#sIp').value, port: $('#sPort').value, password: $('#sPw').value })); st.serverId = data.servers.at(-1)?.id; remember(); bodyOnline(); }
      catch (e) { msg(e.message, true); }
    };
    $('#oGo').onclick = () => (st.serverId ? launch({ kind: 'mp', car: st.car, serverId: st.serverId }) : msg('Pick or add a server', true));
    $('#rSave').onclick = savePreset;
    summary();
    const srv = data.servers.find((s) => s.id === st.serverId);
    if (srv) $('#rSummary').textContent = `Online · ${srv.name}${st.car?.id ? ' · ' + (carById(st.car.id)?.name || '') : ''}`;
    bindPresets();
  }

  headInfo();
  body();
  poll();
}
