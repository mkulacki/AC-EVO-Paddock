// Leaderboards tab: the online boards (per car and per car class), sharing and Steam sign-in, the HUD target,
// "you were beaten" notices, driver profiles, comparing with another driver's lap, reports, removing your own laps
// and (moderators) the moderation queue with its evidence and trail (PL10, docs/platform/LEADERBOARD_TRUST.md)
import { $, esc, api, post, fmt, fmtGap, prettyName } from './util.js';

// a board: a car on a track/layout, or a car class there ("cls" set)
const comboKey = (c) => (c.cls ? `class:${c.track}|${c.layout ?? ''}|${c.cls}` : `${c.track}|${c.layout ?? ''}|${c.car}`);
const trackLabel = (c) => `${prettyName(c.track)}${c.layout ? ` · ${prettyName(c.layout)}` : ''}`;
const comboLabel = (c) => `${trackLabel(c)} · ${c.cls ? `${c.cls} (all cars)` : prettyName(c.car)}`;
const temp = (v) => (v == null ? '–' : `${Math.round(v)}°`);
const secFmt = (ms) => (ms == null ? '–' : (ms / 1000).toFixed(3));
const signed = (ms) => (ms == null ? '–' : `${ms > 0 ? '+' : ms < 0 ? '−' : '±'}${(Math.abs(ms) / 1000).toFixed(3)}`);
const ago = (t) => { if (!t) return ''; const s = (Date.now() - t) / 1000; return s < 90 ? 'just now' : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : new Date(t).toLocaleDateString(); };
// Evidence tiers (leaderboard/worker.js TIERS): each label says only what was checked, never that a lap is genuine
const TIER = {
  legacy: ['Legacy', 'Stored before evidence labels: the checks of that time were not recorded for this lap'],
  basic: ['Format checked', 'Sent by a signed-in driver; the times add up and are in range. Nothing more was checked'],
  telemetry: ['Telemetry consistent', 'Its light telemetry passed the server checks and matches the lap time. This does not prove how it was driven'],
  reviewed: ['Reviewed', 'A moderator looked at the evidence and kept the lap'],
};
// an older server sends no tier: say so instead of calling every lap Legacy
const tierCell = (t) => { const [l, tip] = TIER[t] || ['–', 'Not reported by the server (an older server version)']; return `<span class="muted" title="${esc(tip)}">${esc(l)}</span>`; };
// anomaly flags (moderators only): what the server found when the lap was stored
const flagText = (f) => (f.code === 'tel_rejected' ? `Telemetry refused: ${f.reason}`
  : f.code === 'far_ahead' ? `${f.pct}% faster than the best of ${f.drivers} other drivers (${fmt(f.boardBestMs)})`
    : f.code === 'sector_ahead' ? `Sector ${f.sector} ${f.pct}% faster than the best of ${f.drivers} other drivers`
      : f.code === 'clock_ahead' ? 'Dated after it was received (clock?)' : String(f.code));
const place = (r, of) => `P${r}${of ? ` <span class="muted">of ${of}</span>` : ''}`;

export async function viewLeaderboard(view, cleanup, params) {
  const state = { status: null, combos: [], versions: [], rows: null, error: null, loading: false,
    combo: params.get('combo') || null, game: '', airMin: '', airMax: '', roadMin: '', roadMax: '',
    driver: params.get('driver') || null, profile: null, reports: null, evidence: null, msg: '' };

  view.innerHTML = `
    <div class="row" style="margin-bottom:16px"><h1>Leaderboards</h1><span class="spacer"></span><span id="lbChip" class="muted"></span></div>
    <div id="lbNotices"></div>
    <div class="card" id="lbShare"></div>
    <div class="card" id="lbBoard"></div>
    <div id="lbProfile"></div>
    <div id="lbAdmin"></div>`;

  // ------------------------------------------------------------ "you were beaten"
  function noticesCard() {
    const n = state.status?.notices || [], box = $('#lbNotices');
    if (!box) return;
    box.innerHTML = n.length ? `<div class="card" style="padding:12px 16px"><b>Recent changes on your boards</b><ul class="lb-notes">${n.slice(0, 5).map((x) => `
      <li><a href="#/leaderboard?combo=${encodeURIComponent(comboKey(x))}">${esc(x.title.replace('Leaderboard: ', ''))}</a> ${esc(x.text)} <span class="muted">${ago(x.at)}</span></li>`).join('')}</ul></div>` : '';
  }

  // ------------------------------------------------------------ sharing, sign-in, HUD target
  function shareCard() {
    const s = state.status, box = $('#lbShare');
    if (!s || !box) return;
    noticesCard();
    const who = s.signedIn
      ? `<div class="row" style="gap:10px;margin-bottom:12px"><span>Signed in with Steam as <a href="#" data-driver="${esc(s.steam?.steamId)}"><b>${esc(s.steam?.name || '?')}</b></a>${s.admin ? ' <span class="muted">(admin)</span>' : ''}</span><button id="lbOut">Sign out</button>
        <button class="ghost" id="lbForget" title="Removes your laps, their telemetry, your reports and your sign-ins from the leaderboard server">Delete my online data</button></div>`
      : `<div class="row" style="gap:10px;margin-bottom:12px"><button class="primary" id="lbIn" ${s.secure ? '' : 'disabled title="The server address must start with https://"'}>Sign in with Steam</button>
          <span class="muted" style="font-size:13px" id="lbInMsg">Needed to send laps: your name on the board is your Steam name. Your Steam password goes to Steam only.</span></div>`;
    const mine = s.bests.length ? `<table class="lb-mine"><thead><tr><th>Your best laps</th><th>Time</th><th>Air / track</th><th>Leaderboard</th></tr></thead><tbody>${s.bests.map((b) => {
      const st = !s.share ? '<span class="muted">not shared</span>'
        : !b.board && !s.signedIn ? '<span class="muted">waiting for Steam sign-in</span>'
        : !b.board && !s.auto ? '<span class="muted">not sent yet (Send now)</span>'
        : b.board?.ok ? `sent · <b>${b.board.rank ?? '?'}</b> of ${b.board.of ?? '?'}${b.board.tel ? (b.board.telError ? ' <span class="muted" title="' + esc(b.board.telError) + '">· no telemetry</span>' : ' <span class="muted">· with telemetry</span>') : ''}`
          : b.board ? `<span class="${b.board.retry ? 'muted' : 'error'}">${esc(b.board.error)}${b.board.retry ? ' (will try again)' : ''}</span>`
            : '<span class="muted">waiting</span>';
      return `<tr><td><a href="#/leaderboard?combo=${encodeURIComponent(comboKey(b))}">${esc(comboLabel(b))}</a>${b.carClass ? ` <span class="muted">· ${esc(b.carClass)}</span>` : ''}${b.cond?.game ? ` <span class="muted">· AC EVO ${esc(b.cond.game)}</span>` : ''}</td>
        <td class="mono">${fmt(b.lapMs)}</td><td>${temp(b.cond?.airC)} / ${temp(b.cond?.roadC)}</td><td>${st}</td></tr>`;
    }).join('')}</tbody></table>`
      : '<p class="muted">No laps to share yet. Laps driven from this version on carry their track conditions; your fastest valid lap on each track and car is the one that is shared.</p>';
    box.innerHTML = `${who}
      <div class="row" style="flex-wrap:wrap;gap:6px 18px"><label class="row" style="gap:8px"><input type="checkbox" id="lbOn" ${s.share ? 'checked' : ''}> <b>Share my best laps on the leaderboard</b></label>
        <label class="row" style="gap:8px"><input type="checkbox" id="lbAuto" ${s.auto ? 'checked' : ''} ${s.share ? '' : 'disabled'}> Send automatically after each lap</label>
        <label class="row" style="gap:8px"><input type="checkbox" id="lbTel" ${s.tel ? 'checked' : ''} ${s.share ? '' : 'disabled'}> With light telemetry</label>
        <span class="spacer"></span><button id="lbSync" ${s.share && s.signedIn ? '' : 'disabled'}>${s.syncing ? 'Sending…' : 'Send now'}</button></div>
      <p class="muted" style="margin:8px 0 12px;font-size:13px">Sent: your Steam name, the track, layout and car, the lap and sector times, air and track temperature, the weather when the session was started from the Race tab, and the game and Paddock versions; with light telemetry also speed, pedals, steering, gear, revs and the line every 2 m (about 10 KB), so others can compare with your lap. Only your fastest valid lap per track, car and game version.</p>
      <div class="row" style="gap:8px;font-size:13px;flex-wrap:wrap"><span class="muted">In-game HUD target</span>
        <select id="lbTarget">${[['next', 'The driver just ahead of me'], ['p1', 'P1'], ['off', 'Off']].map(([v, l]) => `<option value="${v}" ${s.target === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <span class="muted" style="margin-left:12px">Server</span><input id="lbUrl" style="width:260px" placeholder="${esc(s.defaultUrl)}" value="${esc(s.url === s.defaultUrl ? '' : s.url)}"><button id="lbUrlSave">Save</button>
        <span class="muted" id="lbSyncInfo">${s.lastError ? `<span class="error">${esc(s.lastError)}</span>` : s.lastSync ? `last sent ${ago(s.lastSync)}` : ''}</span></div>
      ${mine}`;
    $('#lbOut')?.addEventListener('click', async () => { state.status = await post('/api/board/logout', {}); shareCard(); adminCard(); });
    $('#lbForget')?.addEventListener('click', async () => {
      if (!window.confirm('Delete your laps, their telemetry, your reports and your sign-in from the leaderboard server? Sharing is switched off; your laps in Paddock stay.')) return;
      try { const r = await post('/api/board/delete-account', {}); state.status = r.status; shareCard(); adminCard(); await loadCombos(); say(`Removed from the leaderboard (${r.laps} laps).`); }
      catch (err) { say(`Not removed: ${err.message}`); }
    });
    $('#lbIn')?.addEventListener('click', async () => {
      try {
        const r = await post('/api/board/login', {});
        window.open(r.url, '_blank'); // the desktop app opens it in the normal browser
        $('#lbInMsg').textContent = 'Finish the sign-in in your browser…';
        waitForLogin();
      } catch (e) { $('#lbInMsg').textContent = e.message; }
    });
    const set = async (body) => { state.status = await post('/api/board/settings', body); shareCard(); };
    $('#lbOn').addEventListener('change', async (e) => { await set({ share: e.target.checked }); setTimeout(refreshStatus, 2500); });
    $('#lbAuto').addEventListener('change', (e) => set({ auto: e.target.checked }));
    $('#lbTel').addEventListener('change', (e) => set({ tel: e.target.checked }));
    $('#lbTarget').addEventListener('change', (e) => set({ target: e.target.value }));
    $('#lbUrlSave').addEventListener('click', async () => { await set({ url: $('#lbUrl').value }); await loadCombos(); });
    $('#lbSync').addEventListener('click', async () => {
      $('#lbSync').disabled = true; $('#lbSync').textContent = 'Sending…';
      const r = await post('/api/board/sync', {});
      state.status = r.status; shareCard(); await loadCombos();
    });
  }

  async function refreshStatus() { state.status = await api('/api/board/status'); shareCard(); }
  // after "Sign in with Steam": look every 2 s (for up to 10 minutes) whether the browser finished it
  let loginT = null;
  function waitForLogin() {
    clearInterval(loginT);
    const until = Date.now() + 10 * 60 * 1000;
    loginT = setInterval(async () => {
      if (Date.now() > until) { clearInterval(loginT); return; }
      const s = await api('/api/board/status').catch(() => null);
      if (s?.signedIn) { clearInterval(loginT); state.status = s; shareCard(); loadCombos(); loadAdmin(); }
    }, 2000);
  }
  cleanup.push(() => clearInterval(loginT));

  // ------------------------------------------------------------ the board
  const current = () => state.combos.find((x) => comboKey(x) === state.combo) || state.combos[0];

  /** Your row against P1 and the driver just ahead, sector by sector; and the board's ideal lap. */
  function analysis(rows, nSec) {
    const out = [];
    if (nSec && rows.length > 1 && rows.every((r) => r.sectors.length === nSec)) {
      const best = Array.from({ length: nSec }, (_, k) => Math.min(...rows.map((r) => r.sectors[k])));
      const ideal = best.reduce((a, b) => a + b, 0);
      out.push(`<div><span class="muted">Ideal lap of this board</span> (the best of each sector, whoever drove it): <b class="mono">${fmt(ideal)}</b> <span class="muted">· ${signed(ideal - rows[0].lapMs)} to P1</span></div>`);
    }
    const i = rows.findIndex((r) => r.me);
    if (i > 0) {
      const me = rows[i];
      const vs = (o, label) => {
        if (o.sectors.length !== me.sectors.length) return '';
        const d = me.sectors.map((v, k) => v - o.sectors[k]);
        const worst = d.indexOf(Math.max(...d));
        return `<div>${label} <b>${esc(o.name)}</b>: <span class="mono">${signed(me.lapMs - o.lapMs)}</span> ·
          ${d.map((x, k) => `S${k + 1} <span class="mono ${x > 0 ? 'lb-lose' : 'lb-gain'}">${signed(x)}</span>`).join(' · ')}
          ${d[worst] > 0 ? ` <span class="muted">· most to find in sector ${worst + 1}</span>` : ''}</div>`;
      };
      out.push(vs(rows[i - 1], `You (P${i + 1}) vs P${i}`));
      if (i > 1) out.push(vs(rows[0], 'You vs P1'));
    }
    return out.length ? `<div class="lb-analysis">${out.join('')}</div>` : '';
  }

  function boardCard() {
    const box = $('#lbBoard');
    if (!box) return;
    if (state.error) {
      box.innerHTML = `<h2>Board</h2><p class="error">${esc(state.error)}</p><p class="muted" style="font-size:13px">Check your internet connection, or the server address above.</p><button id="lbRetry">Try again</button>`;
      $('#lbRetry').addEventListener('click', loadCombos);
      return;
    }
    if (!state.combos.length) { box.innerHTML = '<h2>Board</h2><p class="muted">No laps on the leaderboard yet.</p>'; return; }
    const c = current();
    state.combo = comboKey(c);
    const rows = state.rows || [];
    const nSec = Math.max(0, ...rows.map((r) => r.sectors.length));
    const bestSec = Array.from({ length: nSec }, (_, k) => Math.min(...rows.map((r) => r.sectors[k] ?? Infinity)));
    const lead = rows[0]?.lapMs;
    const s = state.status || {};
    const num = (id, v, ph) => `<input id="${id}" type="number" step="1" style="width:64px" placeholder="${ph}" value="${esc(v)}">`;
    const actions = (r) => [
      r.tel ? `<button class="small" data-compare="${r.lapId}" title="Download this lap and compare it with your best">Compare</button>` : '',
      s.signedIn && !r.me ? `<button class="small ghost" data-report="${r.lapId}" title="This lap looks impossible">Report</button>` : '',
      s.signedIn && r.me ? `<button class="small ghost" data-remove="${r.lapId}" title="Remove this lap of yours from the leaderboard">Remove</button>` : '',
      s.admin ? `<button class="small ghost" data-hide="${r.lapId}" title="Moderator: hide this lap from every board (written to the moderation trail)">Hide</button>` : '',
    ].join(' ');
    box.innerHTML = `
      <div class="row" style="gap:10px;flex-wrap:wrap;margin-bottom:12px">
        <select id="lbCombo" style="max-width:460px">${state.combos.map((x) => `<option value="${esc(comboKey(x))}" ${comboKey(x) === state.combo ? 'selected' : ''}>${esc(comboLabel(x))} (${x.drivers})</option>`).join('')}</select>
        <select id="lbGame"><option value="">All game versions</option>${state.versions.map((v) => `<option value="${esc(v.game ?? '')}" ${v.game === state.game ? 'selected' : ''}>AC EVO ${esc(v.game ?? '?')}</option>`).join('')}</select>
        <span class="muted">Air</span>${num('lbAirMin', state.airMin, 'min')}–${num('lbAirMax', state.airMax, 'max')}°C
        <span class="muted">Track</span>${num('lbRoadMin', state.roadMin, 'min')}–${num('lbRoadMax', state.roadMax, 'max')}°C
      </div>
      <div id="lbMsg" class="muted" style="font-size:13px;min-height:1em">${esc(state.msg)}</div>
      ${state.loading && !state.rows ? '<span class="spinner"></span>' : !rows.length ? '<p class="muted">No laps match these filters.</p>' : `
      <div style="overflow-x:auto"><table class="lb"><thead><tr><th>#</th><th>Driver</th>${c.cls ? '<th>Car</th>' : ''}<th>Time</th><th>Gap</th><th>Int.</th>${Array.from({ length: nSec }, (_, k) => `<th>S${k + 1}</th>`).join('')}<th>Air</th><th>Track</th><th>Weather</th><th>Game</th><th>Driven</th><th title="What the server checked for this lap">Evidence</th><th></th></tr></thead>
      <tbody>${rows.map((r, i) => `<tr class="${r.me ? 'lb-me' : ''}"><td>${i + 1}</td><td><a href="#" data-driver="${esc(r.driver)}">${esc(r.name)}</a>${r.me ? ' <span class="muted">(you)</span>' : ''}</td>
        ${c.cls ? `<td>${esc(prettyName(r.car))}</td>` : ''}
        <td class="mono"><b>${fmt(r.lapMs)}</b></td><td class="mono muted">${i ? fmtGap(r.lapMs - lead) : ''}</td><td class="mono muted">${i ? fmtGap(r.lapMs - rows[i - 1].lapMs) : ''}</td>
        ${Array.from({ length: nSec }, (_, k) => `<td class="mono ${r.sectors[k] === bestSec[k] ? 'lb-best' : ''}">${secFmt(r.sectors[k])}</td>`).join('')}
        <td>${temp(r.airC)}</td><td>${temp(r.roadC)}</td><td>${esc([r.weather, r.grip].filter(Boolean).join(' · ') || '–')}</td>
        <td class="muted">${esc(r.game ?? '?')}</td><td class="muted">${new Date(r.drivenAt).toLocaleDateString()}</td><td>${tierCell(r.tier)}</td><td class="lb-act">${actions(r)}</td></tr>`).join('')}</tbody></table></div>
      ${analysis(rows, nSec)}
      <p class="muted" style="font-size:12px;margin-top:8px">Evidence says what the server checked for each lap. A Steam sign-in proves who sent a lap, not that it was driven as sent: no check run on a PC or on the server can prove that.</p>`}`;
    $('#lbCombo').addEventListener('change', (e) => { state.combo = e.target.value; state.game = ''; loadBoard(true); });
    $('#lbGame').addEventListener('change', (e) => { state.game = e.target.value; loadBoard(); });
    for (const [id, k] of [['lbAirMin', 'airMin'], ['lbAirMax', 'airMax'], ['lbRoadMin', 'roadMin'], ['lbRoadMax', 'roadMax']]) {
      $(`#${id}`).addEventListener('change', (e) => { state[k] = e.target.value; loadBoard(); });
    }
  }

  const say = (m) => { state.msg = m; const el = $('#lbMsg'); if (el) el.textContent = m; };

  // the board's buttons and driver links (one listener for the whole page)
  view.addEventListener('click', async (e) => {
    const d = e.target.closest('[data-driver]');
    if (d) { e.preventDefault(); if (d.dataset.driver) loadProfile(d.dataset.driver); return; }
    const cmp = e.target.closest('[data-compare]');
    if (cmp) {
      cmp.disabled = true; say('Downloading the lap…');
      try {
        const r = await post('/api/board/compare', { lapId: Number(cmp.dataset.compare) });
        location.hash = `#/compare?laps=${[r.mine, r.online].filter(Boolean).join(',')}`;
      } catch (err) { say(`Could not download it: ${err.message}`); cmp.disabled = false; }
      return;
    }
    const rep = e.target.closest('[data-report]');
    if (rep) {
      const reason = window.prompt('What looks wrong with this lap? (sent to the leaderboard admins)', '');
      if (reason === null) return;
      try { await post('/api/board/report', { lapId: Number(rep.dataset.report), reason }); say('Reported. Thank you.'); rep.disabled = true; }
      catch (err) { say(`Not reported: ${err.message}`); }
      return;
    }
    const rm = e.target.closest('[data-remove]');
    if (rm) {
      if (!window.confirm('Remove this lap of yours from the leaderboard (with its telemetry)? It stays in Paddock and is not sent again by itself.')) return;
      try { await post('/api/board/delete-lap', { lapId: Number(rm.dataset.remove) }); say('Removed.'); await refreshStatus(); await loadCombos(); }
      catch (err) { say(`Not removed: ${err.message}`); }
      return;
    }
    const hide = e.target.closest('[data-hide]');
    if (hide) {
      const on = hide.dataset.unhide !== '1';
      // every moderation action is written to the trail with its reason
      const reason = window.prompt(on ? 'Hide this lap from every board. Reason (kept in the moderation trail):' : 'Show this lap again. Reason (kept in the moderation trail):', '');
      if (reason === null) return;
      try { await post('/api/board/admin/moderate', { lapId: Number(hide.dataset.hide), action: on ? 'hide' : 'show', reason }); say(on ? 'Lap hidden.' : 'Lap shown again.'); await loadCombos(); loadAdmin(); }
      catch (err) { say(err.message); }
      return;
    }
    const mod = e.target.closest('[data-mod]');
    if (mod) {
      const reason = window.prompt(mod.dataset.action === 'review' ? 'Mark as reviewed (you looked at the evidence and keep the lap). Reason:' : 'Take back the review. Reason:', '');
      if (reason === null) return;
      try { await post('/api/board/admin/moderate', { lapId: Number(mod.dataset.mod), action: mod.dataset.action, reason }); await loadCombos(); loadAdmin(); }
      catch (err) { say(err.message); }
      return;
    }
    const ev = e.target.closest('[data-evidence]');
    if (ev) { loadEvidence(Number(ev.dataset.evidence)); return; }
    const sus = e.target.closest('[data-suspend]');
    if (sus) {
      const on = sus.dataset.on === '1';
      const reason = window.prompt(on ? 'Suspend this driver (no new laps or reports). Reason (required, kept in the trail):' : 'Lift the suspension. Reason:', '');
      if (reason === null || (on && !reason.trim())) return;
      const hideLaps = on && window.confirm('Also hide all laps of this driver? (Each one can be shown again.)');
      try { await post('/api/board/admin/suspend', { driver: sus.dataset.suspend, suspended: on, reason, hideLaps }); await loadCombos(); loadAdmin(); }
      catch (err) { say(err.message); }
    }
  });

  async function loadCombos() {
    try {
      const r = await api('/api/board/combos');
      const cls = (r.classes || []).map((x) => ({ track: x.track, layout: x.layout, cls: x.car_class, drivers: x.drivers }));
      // per track: the class boards first, then the cars
      state.combos = [...cls, ...(r.combos || [])].sort((a, b) => trackLabel(a).localeCompare(trackLabel(b)) || (a.cls ? 0 : 1) - (b.cls ? 0 : 1) || comboLabel(a).localeCompare(comboLabel(b)));
      state.error = null;
    } catch (e) {
      state.combos = []; state.error = `The leaderboard server is not reachable at ${state.status?.url || '?'}: ${e.message}`;
    }
    if (!state.combo && state.status?.bests?.length) state.combo = comboKey(state.status.bests[0]);
    await loadBoard(true);
  }

  async function loadBoard(withVersions = false) {
    boardCard();
    const c = current();
    if (!c || state.error) return;
    const q = new URLSearchParams({ track: c.track, layout: c.layout ?? '' });
    q.set(c.cls ? 'class' : 'car', c.cls || c.car);
    state.loading = true;
    try {
      if (withVersions) state.versions = (await api(`/api/board/versions?${q}`)).versions || [];
      for (const k of ['game', 'airMin', 'airMax', 'roadMin', 'roadMax']) if (state[k] !== '') q.set(k, state[k]);
      state.rows = (await api(`/api/board/table?${q}`)).rows || [];
    } catch { state.error = 'The leaderboard server is not reachable.'; }
    state.loading = false;
    boardCard();
  }

  // ------------------------------------------------------------ driver profile
  async function loadProfile(id) {
    state.driver = id;
    const box = $('#lbProfile');
    box.innerHTML = '<div class="card"><span class="spinner"></span></div>';
    try {
      const p = await api(`/api/board/driver?id=${encodeURIComponent(id)}`);
      box.innerHTML = `<div class="card"><div class="row"><h2 style="margin:0">${esc(p.name)}</h2><span class="spacer"></span>
          <a href="https://steamcommunity.com/profiles/${esc(p.driver)}" target="_blank" rel="noopener">Steam profile</a><button class="ghost" id="lbProfClose" style="margin-left:10px">Close</button></div>
        <p class="muted">${p.boards.length} board${p.boards.length === 1 ? '' : 's'} · ${p.wins} P1 · ${p.podiums} podium${p.podiums === 1 ? '' : 's'}</p>
        <table class="lb-mine"><thead><tr><th>Board</th><th>Time</th><th>Place</th><th>Just ahead</th></tr></thead><tbody>${p.boards.map((b) => `
          <tr><td><a href="#/leaderboard?combo=${encodeURIComponent(comboKey(b))}">${esc(comboLabel(b))}</a>${b.carClass ? ` <span class="muted">· ${esc(b.carClass)}</span>` : ''}</td>
          <td class="mono">${fmt(b.lapMs)}</td><td>${place(b.rank, b.of)}</td>
          <td>${b.ahead ? `${esc(b.ahead.name)} <span class="mono muted">${signed(b.ahead.lapMs - b.lapMs)}</span>` : '<span class="muted">–</span>'}</td></tr>`).join('')}</tbody></table></div>`;
      $('#lbProfClose').addEventListener('click', () => { box.innerHTML = ''; state.driver = null; });
      box.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) { box.innerHTML = `<div class="card"><p class="error">${esc(e.message)}</p></div>`; }
  }

  // ------------------------------------------------------------ moderators: reported or flagged laps, evidence, trail
  async function loadAdmin() {
    if (!state.status?.admin) { state.reports = null; state.evidence = null; adminCard(); return; }
    try { state.reports = (await api('/api/board/admin/reports')).laps || []; } catch { state.reports = null; }
    adminCard();
    if (state.evidence) loadEvidence(state.evidence.lap.lapId);
  }
  async function loadEvidence(id) {
    try { state.evidence = await api(`/api/board/admin/lap?id=${id}`); } catch (e) { state.evidence = null; say(e.message); }
    evidenceCard();
  }
  function evidenceCard() {
    const box = $('#lbEvidence'), v = state.evidence;
    if (!box) return;
    if (!v) { box.innerHTML = ''; return; }
    const l = v.lap, d = v.driver;
    const when = (t) => (t ? new Date(t).toLocaleString() : '–');
    box.innerHTML = `<h3 style="margin:14px 0 6px">Evidence: ${esc(l.name ?? l.driver)} · ${esc(comboLabel(l))} · <span class="mono">${fmt(l.lapMs)}</span></h3>
      <p class="muted" style="font-size:13px">${tierCell(l.tier)} · ${l.hidden ? 'hidden' : 'on the boards'} · sectors ${l.sectors.map(secFmt).join(' / ')} · AC EVO ${esc(l.game ?? '?')} · Paddock ${esc(l.app ?? '?')}
        · driven ${when(l.drivenAt)} · received ${when(l.receivedAt)} · telemetry ${l.tel ? 'yes' : 'no'} · driver first seen ${when(d.firstSeen)}, ${d.laps} lap${d.laps === 1 ? '' : 's'}
        ${d.suspended ? ` · <b>suspended</b> (${esc(d.suspended.reason || '')})` : ''}</p>
      ${l.flags.length ? `<ul>${l.flags.map((f) => `<li>${esc(flagText(f))}</li>`).join('')}</ul>` : '<p class="muted">No anomaly flags.</p>'}
      ${v.reports.length ? `<p><b>Reports</b></p><ul>${v.reports.map((r) => `<li>${esc(r.reason || '(no reason)')} <span class="muted">${when(r.at)}</span></li>`).join('')}</ul>` : ''}
      <p><b>Moderation trail</b> <span class="muted" style="font-size:12px">(kept on the server; no route changes or removes an entry)</span></p>
      ${v.trail.length ? `<ul>${v.trail.map((t) => `<li>${when(t.at)} · ${esc(t.action)} by ${esc(t.actor === 'system' ? 'the server' : t.actor)}${t.reason ? `: ${esc(t.reason)}` : ''}</li>`).join('')}</ul>` : '<p class="muted">No entries.</p>'}
      <div class="row" style="gap:8px"><button class="small ghost" data-suspend="${esc(l.driver)}" data-on="${d.suspended ? '0' : '1'}">${d.suspended ? 'Lift suspension' : 'Suspend driver'}</button>
        <button class="small ghost" id="lbEvClose">Close</button></div>`;
    $('#lbEvClose').addEventListener('click', () => { state.evidence = null; evidenceCard(); });
  }
  function adminCard() {
    const box = $('#lbAdmin');
    if (!box) return;
    const r = state.reports;
    if (!state.status?.admin || !r) { box.innerHTML = ''; return; }
    box.innerHTML = `<div class="card"><h2>Moderation queue <span class="muted" style="font-size:13px">(admin: reported or flagged laps)</span></h2>
      <p class="muted" style="font-size:13px">Flags come from simple rules and hide nothing by themselves. Look at the evidence before hiding a lap; every action is written to the trail with its reason.</p>${!r.length ? '<p class="muted">Nothing to look at.</p>' : `
      <table class="lb-mine"><thead><tr><th>Driver</th><th>Board</th><th>Time</th><th>Evidence</th><th>Reports</th><th>Why / flags</th><th></th></tr></thead><tbody>${r.map((x) => `
        <tr class="${x.hidden ? 'muted' : ''}"><td>${esc(x.name ?? x.driver)}</td><td>${esc(comboLabel(x))}</td><td class="mono">${fmt(x.lapMs)}</td><td>${tierCell(x.tier)}</td><td>${x.reports}</td>
        <td>${esc([x.reasons, ...(x.flags || []).map(flagText)].filter(Boolean).join(' | '))}</td>
        <td class="lb-act"><button class="small" data-evidence="${x.lapId}">Evidence</button>
          <button class="small ghost" data-hide="${x.lapId}" data-unhide="${x.hidden ? '1' : '0'}">${x.hidden ? 'Show again' : 'Hide'}</button>
          <button class="small ghost" data-mod="${x.lapId}" data-action="${x.tier === 'reviewed' ? 'unreview' : 'review'}">${x.tier === 'reviewed' ? 'Unreview' : 'Mark reviewed'}</button></td></tr>`).join('')}</tbody></table>`}
      <div id="lbEvidence"></div></div>`;
    evidenceCard();
  }

  // the profile is read on opening the page: it also brings "you were beaten" up to date
  await refreshStatus();
  api('/api/board/profile').then((r) => { if (r?.status) { state.status = r.status; shareCard(); } }).catch(() => {});
  await loadCombos();
  loadAdmin();
  if (state.driver) loadProfile(state.driver);
  const t = setInterval(() => { if (!state.status?.syncing) refreshStatus().catch(() => {}); }, 15000);
  cleanup.push(() => clearInterval(t));
}
