// Leaderboards tab: the online lap time boards (version 1: lap and sector times, track conditions) and sharing
import { $, esc, api, post, fmt, fmtGap, prettyName } from './util.js';

const comboKey = (c) => `${c.track}|${c.layout ?? ''}|${c.car}`;
const comboLabel = (c) => `${prettyName(c.track)}${c.layout ? ` · ${prettyName(c.layout)}` : ''} · ${prettyName(c.car)}`;
const temp = (v) => (v == null ? '–' : `${Math.round(v)}°`);
const secFmt = (ms) => (ms == null ? '–' : (ms / 1000).toFixed(3));
const ago = (t) => { if (!t) return ''; const s = (Date.now() - t) / 1000; return s < 90 ? 'just now' : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : new Date(t).toLocaleDateString(); };

export async function viewLeaderboard(view, cleanup, params) {
  const state = { status: null, combos: [], versions: [], rows: null, error: null, loading: false,
    combo: params.get('combo') || null, game: '', airMin: '', airMax: '', roadMin: '', roadMax: '' };

  view.innerHTML = `
    <div class="row" style="margin-bottom:16px"><h1>Leaderboards</h1><span class="spacer"></span><span id="lbChip" class="muted"></span></div>
    <div class="card" id="lbShare"></div>
    <div class="card" id="lbBoard"></div>`;

  function shareCard() {
    const s = state.status, box = $('#lbShare');
    if (!s || !box) return;
    const who = s.signedIn
      ? `<div class="row" style="gap:10px;margin-bottom:12px"><span>Signed in with Steam as <b>${esc(s.steam?.name || '?')}</b></span><button id="lbOut">Sign out</button></div>`
      : `<div class="row" style="gap:10px;margin-bottom:12px"><button class="primary" id="lbIn" ${s.secure ? '' : 'disabled title="The server address must start with https://"'}>Sign in with Steam</button>
          <span class="muted" style="font-size:13px" id="lbInMsg">Needed to send laps: your name on the board is your Steam name. Your Steam password goes to Steam only.</span></div>`;
    const mine = s.bests.length ? `<table class="lb-mine"><thead><tr><th>Your best laps</th><th>Time</th><th>Air / track</th><th>Leaderboard</th></tr></thead><tbody>${s.bests.map((b) => {
      const st = !s.share ? '<span class="muted">not shared</span>'
        : !b.board && !s.signedIn ? '<span class="muted">waiting for Steam sign-in</span>'
        : !b.board && !s.auto ? '<span class="muted">not sent yet (Send now)</span>'
        : b.board?.ok ? `sent · <b>${b.board.rank ?? '?'}</b> of ${b.board.of ?? '?'}`
          : b.board ? `<span class="${b.board.retry ? 'muted' : 'error'}">${esc(b.board.error)}${b.board.retry ? ' (will try again)' : ''}</span>`
            : '<span class="muted">waiting</span>';
      return `<tr><td><a href="#/leaderboard?combo=${encodeURIComponent(comboKey(b))}">${esc(comboLabel(b))}</a>${b.cond?.game ? ` <span class="muted">· AC EVO ${esc(b.cond.game)}</span>` : ''}</td>
        <td class="mono">${fmt(b.lapMs)}</td><td>${temp(b.cond?.airC)} / ${temp(b.cond?.roadC)}</td><td>${st}</td></tr>`;
    }).join('')}</tbody></table>`
      : '<p class="muted">No laps to share yet. Laps driven from this version on carry their track conditions; your fastest valid lap on each track and car is the one that is shared.</p>';
    box.innerHTML = `${who}
      <div class="row"><label class="row" style="gap:8px"><input type="checkbox" id="lbOn" ${s.share ? 'checked' : ''}> <b>Share my best laps on the leaderboard</b></label>
        <label class="row" style="gap:8px;margin-left:18px"><input type="checkbox" id="lbAuto" ${s.auto ? 'checked' : ''} ${s.share ? '' : 'disabled'}> Send automatically after each lap</label>
        <span class="spacer"></span><button id="lbSync" ${s.share && s.signedIn ? '' : 'disabled'}>${s.syncing ? 'Sending…' : 'Send now'}</button></div>
      <p class="muted" style="margin:8px 0 12px;font-size:13px">Sent: your Steam name, the track, layout and car, the lap and sector times, air and track temperature, the weather when the session was started from the Race tab, and the game and Paddock versions. Only your fastest valid lap per track, car and game version.</p>
      <div class="row" style="gap:8px;font-size:13px"><span class="muted">Server</span><input id="lbUrl" style="width:260px" placeholder="${esc(s.defaultUrl)}" value="${esc(s.url === s.defaultUrl ? '' : s.url)}"><button id="lbUrlSave">Save</button>
        <span class="muted" id="lbSyncInfo">${s.lastError ? `<span class="error">${esc(s.lastError)}</span>` : s.lastSync ? `last sent ${ago(s.lastSync)}` : ''}</span></div>
      ${mine}`;
    $('#lbOut')?.addEventListener('click', async () => { state.status = await post('/api/board/logout', {}); shareCard(); });
    $('#lbIn')?.addEventListener('click', async () => {
      try {
        const r = await post('/api/board/login', {});
        window.open(r.url, '_blank'); // the desktop app opens it in the normal browser
        $('#lbInMsg').textContent = 'Finish the sign-in in your browser…';
        waitForLogin();
      } catch (e) { $('#lbInMsg').textContent = e.message; }
    });
    $('#lbOn').addEventListener('change', async (e) => { state.status = await post('/api/board/settings', { share: e.target.checked }); shareCard(); setTimeout(refreshStatus, 2500); });
    $('#lbAuto').addEventListener('change', async (e) => { state.status = await post('/api/board/settings', { auto: e.target.checked }); shareCard(); });
    $('#lbUrlSave').addEventListener('click', async () => { state.status = await post('/api/board/settings', { url: $('#lbUrl').value }); shareCard(); await loadCombos(); });
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
      if (s?.signedIn) { clearInterval(loginT); state.status = s; shareCard(); loadCombos(); }
    }, 2000);
  }
  cleanup.push(() => clearInterval(loginT));

  function boardCard() {
    const box = $('#lbBoard');
    if (!box) return;
    if (state.error) {
      box.innerHTML = `<h2>Board</h2><p class="error">${esc(state.error)}</p><p class="muted" style="font-size:13px">For now the leaderboard server runs on this PC only: start it with <code>npm run board</code> in the Paddock source folder.</p><button id="lbRetry">Try again</button>`;
      $('#lbRetry').addEventListener('click', loadCombos);
      return;
    }
    if (!state.combos.length) { box.innerHTML = '<h2>Board</h2><p class="muted">No laps on the leaderboard yet.</p>'; return; }
    const c = state.combos.find((x) => comboKey(x) === state.combo) || state.combos[0];
    state.combo = comboKey(c);
    const rows = state.rows || [];
    const nSec = Math.max(0, ...rows.map((r) => r.sectors.length));
    const bestSec = Array.from({ length: nSec }, (_, k) => Math.min(...rows.map((r) => r.sectors[k] ?? Infinity)));
    const lead = rows[0]?.lapMs;
    const num = (id, v, ph) => `<input id="${id}" type="number" step="1" style="width:64px" placeholder="${ph}" value="${esc(v)}">`;
    box.innerHTML = `
      <div class="row" style="gap:10px;flex-wrap:wrap;margin-bottom:12px">
        <select id="lbCombo" style="max-width:420px">${state.combos.map((x) => `<option value="${esc(comboKey(x))}" ${comboKey(x) === state.combo ? 'selected' : ''}>${esc(comboLabel(x))} (${x.drivers})</option>`).join('')}</select>
        <select id="lbGame"><option value="">All game versions</option>${state.versions.map((v) => `<option value="${esc(v.game ?? '')}" ${v.game === state.game ? 'selected' : ''}>AC EVO ${esc(v.game ?? '?')}</option>`).join('')}</select>
        <span class="muted">Air</span>${num('lbAirMin', state.airMin, 'min')}–${num('lbAirMax', state.airMax, 'max')}°C
        <span class="muted">Track</span>${num('lbRoadMin', state.roadMin, 'min')}–${num('lbRoadMax', state.roadMax, 'max')}°C
      </div>
      ${state.loading && !state.rows ? '<span class="spinner"></span>' : !rows.length ? '<p class="muted">No laps match these filters.</p>' : `
      <div style="overflow-x:auto"><table class="lb"><thead><tr><th>#</th><th>Driver</th><th>Time</th><th>Gap</th>${Array.from({ length: nSec }, (_, k) => `<th>S${k + 1}</th>`).join('')}<th>Air</th><th>Track</th><th>Weather</th><th>Game</th><th>Driven</th></tr></thead>
      <tbody>${rows.map((r, i) => `<tr class="${r.me ? 'lb-me' : ''}"><td>${i + 1}</td><td>${esc(r.name)}${r.me ? ' <span class="muted">(you)</span>' : ''}</td>
        <td class="mono"><b>${fmt(r.lapMs)}</b></td><td class="mono muted">${i ? fmtGap(r.lapMs - lead) : ''}</td>
        ${Array.from({ length: nSec }, (_, k) => `<td class="mono ${r.sectors[k] === bestSec[k] ? 'lb-best' : ''}">${secFmt(r.sectors[k])}</td>`).join('')}
        <td>${temp(r.airC)}</td><td>${temp(r.roadC)}</td><td>${esc([r.weather, r.grip].filter(Boolean).join(' · ') || '–')}</td>
        <td class="muted">${esc(r.game ?? '?')}</td><td class="muted">${new Date(r.drivenAt).toLocaleDateString()}</td></tr>`).join('')}</tbody></table></div>`}`;
    $('#lbCombo').addEventListener('change', (e) => { state.combo = e.target.value; state.game = ''; loadBoard(true); });
    $('#lbGame').addEventListener('change', (e) => { state.game = e.target.value; loadBoard(); });
    for (const [id, k] of [['lbAirMin', 'airMin'], ['lbAirMax', 'airMax'], ['lbRoadMin', 'roadMin'], ['lbRoadMax', 'roadMax']]) {
      $(`#${id}`).addEventListener('change', (e) => { state[k] = e.target.value; loadBoard(); });
    }
  }

  async function loadCombos() {
    try {
      const r = await api('/api/board/combos');
      state.combos = r.combos || []; state.error = null;
    } catch (e) {
      state.combos = []; state.error = `The leaderboard server is not reachable at ${state.status?.url || '?'}: ${e.message}`;
    }
    if (!state.combo && state.status?.bests?.length) state.combo = comboKey(state.status.bests[0]);
    await loadBoard(true);
  }

  async function loadBoard(withVersions = false) {
    boardCard();
    const c = state.combos.find((x) => comboKey(x) === state.combo) || state.combos[0];
    if (!c || state.error) return;
    const q = new URLSearchParams({ track: c.track, layout: c.layout ?? '', car: c.car });
    state.loading = true;
    try {
      if (withVersions) state.versions = (await api(`/api/board/versions?${q}`)).versions || [];
      for (const k of ['game', 'airMin', 'airMax', 'roadMin', 'roadMax']) if (state[k] !== '') q.set(k, state[k]);
      state.rows = (await api(`/api/board/table?${q}`)).rows || [];
    } catch { state.error = 'The leaderboard server is not reachable.'; }
    state.loading = false;
    boardCard();
  }

  await refreshStatus();
  await loadCombos();
  const t = setInterval(() => { if (!state.status?.syncing) refreshStatus().catch(() => {}); }, 15000);
  cleanup.push(() => clearInterval(t));
}
