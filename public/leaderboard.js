// Leaderboards tab, in three subpages (#/leaderboard?tab=…):
// - Boards (default): pick a track, then a car or a car class there; the board with its sectors, "Show me", driver
//   profiles, comparing with another driver's lap, reports, removing your own laps and (moderators) the moderation
//   queue with its evidence and trail (PL10, docs/platform/LEADERBOARD_TRUST.md). #/leaderboard?combo=<key> opens a board.
// - My best laps (?tab=mine): your best lap per track, car and game version, with its place and gap to P1.
// - Settings (?tab=settings): Steam sign-in, what is shared and when, the in-game HUD target and the server address.
import { $, esc, api, post, fmt, fmtGap, prettyName } from './util.js';

// a board: a car on a track/layout, or a car class there ("cls" set)
const comboKey = (c) => (c.cls ? `class:${c.track}|${c.layout ?? ''}|${c.cls}` : `${c.track}|${c.layout ?? ''}|${c.car}`);
const trackKey = (c) => `${c.track}|${c.layout ?? ''}`;
const trackLabel = (c) => `${prettyName(c.track)}${c.layout ? ` · ${prettyName(c.layout)}` : ''}`;
const comboLabel = (c) => `${trackLabel(c)} · ${c.cls ? `${c.cls} (all cars)` : prettyName(c.car)}`;
const carLabel = (c) => (c.cls ? `${c.cls} · all cars (${c.drivers})` : `${prettyName(c.car)} (${c.drivers})`);
const temp = (v) => (v == null ? '–' : `${Math.round(v)}°`);
const secFmt = (ms) => (ms == null ? '–' : (ms / 1000).toFixed(3));
const signed = (ms) => (ms == null ? '–' : `${ms > 0 ? '+' : ms < 0 ? '−' : '±'}${(Math.abs(ms) / 1000).toFixed(3)}`);
const ago = (t) => { if (!t) return ''; const s = (Date.now() - t) / 1000; return s < 90 ? 'just now' : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : new Date(t).toLocaleDateString(); };
const boardLink = (c) => `#/leaderboard?combo=${encodeURIComponent(comboKey(c))}`;
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

// the last board looked at (per browser; a convenience only)
const LAST = 'leaderboard.board';
const lastBoard = () => { try { return localStorage.getItem(LAST); } catch { return null; } };
const rememberBoard = (k) => { try { localStorage.setItem(LAST, k); } catch { /* private window: not remembered */ } };

// My best laps: place and gap to P1 per lap, read from its board; kept a minute so switching subpages costs nothing
const RANK_TTL = 60 * 1000, RANK_MAX = 40, RANK_PARALLEL = 3;
const rankCache = new Map(); // `${comboKey}|${game}` -> {at, val: {rank, of, gap} | 'error'}
const rankKey = (b) => `${comboKey(b)}|${b.cond?.game ?? ''}`;

const SUBPAGES = [['boards', 'Boards', '#/leaderboard'], ['mine', 'My best laps', '#/leaderboard?tab=mine'], ['settings', 'Settings', '#/leaderboard?tab=settings']];

/**
 * A small accessible combobox: an input that filters a listbox as you type (ARIA 1.2 combobox pattern).
 * items: [{v, label, group?}] in display order; a new group starts a labelled section. onPick(v) when one is chosen.
 */
function combobox(input, items, onPick) {
  const list = document.getElementById(input.getAttribute('aria-controls'));
  let shown = [], active = -1, typed = false;
  const selected = () => items.find((x) => x.v === input.dataset.value);
  const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); active = -1; };
  const draw = () => {
    const q = typed ? input.value.trim().toLowerCase() : '';
    shown = items.filter((x) => !q || x.label.toLowerCase().includes(q));
    let g = null, html = '';
    shown.forEach((x, i) => {
      if (x.group && x.group !== g) { g = x.group; html += `<li role="presentation" class="cbx-group">${esc(g)}</li>`; }
      html += `<li role="option" id="${list.id}-${i}" data-i="${i}" aria-selected="${i === active}" class="${x.v === input.dataset.value ? 'cur' : ''}">${esc(x.label)}</li>`;
    });
    list.innerHTML = html || '<li role="presentation" class="cbx-none">No match</li>';
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    if (active >= 0 && shown[active]) {
      input.setAttribute('aria-activedescendant', `${list.id}-${active}`);
      document.getElementById(`${list.id}-${active}`)?.scrollIntoView({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
  };
  const restore = () => { input.value = selected()?.label ?? ''; typed = false; };
  const pick = (x) => { close(); typed = false; input.value = x.label; if (x.v !== input.dataset.value) { input.dataset.value = x.v; onPick(x.v); } };
  const open = () => { typed = false; active = Math.max(0, items.findIndex((x) => x.v === input.dataset.value)); draw(); };
  input.addEventListener('focus', () => input.select());
  input.addEventListener('click', () => { if (list.hidden) open(); });
  input.addEventListener('input', () => { typed = true; active = 0; draw(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (list.hidden) { open(); return; }
      active = e.key === 'ArrowDown' ? Math.min(active + 1, shown.length - 1) : Math.max(active - 1, 0);
      draw();
    } else if (e.key === 'Enter') {
      if (!list.hidden && shown[active]) { e.preventDefault(); pick(shown[active]); }
    } else if (e.key === 'Escape') {
      if (!list.hidden) { e.preventDefault(); e.stopPropagation(); close(); restore(); }
    }
  });
  // a click on an option must not blur the input first
  list.addEventListener('mousedown', (e) => e.preventDefault());
  list.addEventListener('click', (e) => { const o = e.target.closest('[role=option]'); if (o) pick(shown[Number(o.dataset.i)]); });
  input.addEventListener('blur', () => {
    if (list.hidden) return;
    const q = input.value.trim().toLowerCase();
    const exact = typed && items.find((x) => x.label.toLowerCase() === q);
    close();
    if (exact) pick(exact); else restore();
  });
}

export async function viewLeaderboard(view, cleanup, params) {
  const tab = SUBPAGES.some(([k]) => k === params.get('tab')) ? params.get('tab') : 'boards';
  const state = { status: null, combos: [], versions: [], rows: null, error: null, loading: false,
    wanted: params.get('combo') || null, combo: null, game: '',
    driver: params.get('driver') || null, reports: null, evidence: null, msg: '', sort: { k: 'date', dir: -1 } };

  const body = {
    boards: '<div id="lbNotices"></div><div class="card" id="lbBoard"></div><div id="lbProfile"></div><div id="lbAdmin"></div>',
    mine: '<div id="lbNotices"></div><div class="card" id="lbMine"></div><div id="lbProfile"></div>',
    settings: '<div class="card" id="lbShare"></div><div id="lbProfile"></div>',
  }[tab];
  view.innerHTML = `
    <div class="race-head"><div><h1>Leaderboards</h1></div><span class="spacer"></span>
      <div class="tabs" role="navigation" aria-label="Leaderboards">${SUBPAGES.map(([k, l, h]) => `<a href="${h}" data-sub="${k}" class="${k === tab ? 'on' : ''}"${k === tab ? ' aria-current="page"' : ''}>${l}</a>`).join('')}</div></div>
    ${body}`;

  const say = (m) => { state.msg = m; const el = $('#lbMsg'); if (el) el.textContent = m; };
  const reloadBoards = () => (tab === 'boards' ? loadCombos() : null);
  const drawStatus = () => { noticesCard(); shareCard(); mineCard(); };

  // ------------------------------------------------------------ "you were beaten"
  function noticesCard() {
    const n = state.status?.notices || [], box = $('#lbNotices');
    if (!box) return;
    box.innerHTML = n.length ? `<div class="card" style="padding:12px 16px"><b>Recent changes on your boards</b><ul class="lb-notes">${n.slice(0, 5).map((x) => `
      <li><a href="${boardLink(x)}">${esc(x.title.replace('Leaderboard: ', ''))}</a> ${esc(x.text)} <span class="muted">${ago(x.at)}</span></li>`).join('')}</ul></div>` : '';
  }

  // ------------------------------------------------------------ Settings: sharing, sign-in, HUD target, server
  function shareCard() {
    const s = state.status, box = $('#lbShare');
    if (!s || !box) return;
    const who = s.signedIn
      ? `<div class="row" style="gap:10px;margin-bottom:12px"><span>Signed in with Steam as <a href="#" data-driver="${esc(s.steam?.steamId)}"><b>${esc(s.steam?.name || '?')}</b></a>${s.admin ? ' <span class="muted">(admin)</span>' : ''}</span><button id="lbOut">Sign out</button>
        <button class="ghost" id="lbForget" title="Removes your laps, their telemetry, your reports and your sign-ins from the leaderboard server">Delete my online data</button></div>`
      : `<div class="row" style="gap:10px;margin-bottom:12px"><button class="primary" id="lbIn" ${s.secure ? '' : 'disabled title="The server address must start with https://"'}>Sign in with Steam</button>
          <span class="muted" style="font-size:13px" id="lbInMsg">Needed to send laps: your name on the board is your Steam name. Your Steam password goes to Steam only.</span></div>`;
    box.innerHTML = `<h2>Account and sharing</h2>${who}
      <div class="row" style="flex-wrap:wrap;gap:6px 18px"><label class="row" style="gap:8px"><input type="checkbox" id="lbOn" ${s.share ? 'checked' : ''}> <b>Share my best laps on the leaderboard</b></label>
        <label class="row" style="gap:8px"><input type="checkbox" id="lbAuto" ${s.auto ? 'checked' : ''} ${s.share ? '' : 'disabled'}> Send automatically after each lap</label>
        <label class="row" style="gap:8px"><input type="checkbox" id="lbTel" ${s.tel ? 'checked' : ''} ${s.share ? '' : 'disabled'}> With light telemetry</label>
        <span class="spacer"></span><button id="lbSync" ${s.share && s.signedIn ? '' : 'disabled'}>${s.syncing ? 'Sending…' : 'Send now'}</button></div>
      <p class="muted" style="margin:8px 0 12px;font-size:13px">Sent: your Steam name, the track, layout and car, the lap and sector times, air and track temperature, the weather when the session was started from the Race tab, and the game and Paddock versions; with light telemetry also speed, pedals, steering, gear, revs and the line every 2 m (about 10 KB), so others can compare with your lap. Only your fastest valid lap per track, car and game version.</p>
      <div class="row" style="gap:8px;font-size:13px;flex-wrap:wrap"><label class="muted" for="lbTarget">In-game HUD target</label>
        <select id="lbTarget">${[['next', 'The driver just ahead of me'], ['p1', 'P1'], ['off', 'Off']].map(([v, l]) => `<option value="${v}" ${s.target === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <label class="muted" style="margin-left:12px" for="lbUrl">Server address</label><input id="lbUrl" style="width:260px;max-width:100%" placeholder="${esc(s.defaultUrl)}" value="${esc(s.url === s.defaultUrl ? '' : s.url)}"><button id="lbUrlSave">Save</button>
        <span class="muted" id="lbSyncInfo">${s.lastError ? `<span class="error">${esc(s.lastError)}</span>` : s.lastSync ? `last sent ${ago(s.lastSync)}` : ''}</span></div>
      <div id="lbMsg" class="muted" role="status" style="font-size:13px;min-height:1em;margin-top:8px">${esc(state.msg)}</div>`;
    $('#lbOut')?.addEventListener('click', async () => { state.status = await post('/api/board/logout', {}); drawStatus(); });
    $('#lbForget')?.addEventListener('click', async () => {
      if (!window.confirm('Delete your laps, their telemetry, your reports and your sign-in from the leaderboard server? Sharing is switched off; your laps in Paddock stay.')) return;
      try { const r = await post('/api/board/delete-account', {}); state.status = r.status; rankCache.clear(); drawStatus(); say(`Removed from the leaderboard (${r.laps} laps).`); }
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
    const set = async (body) => { state.status = await post('/api/board/settings', body); drawStatus(); };
    $('#lbOn').addEventListener('change', async (e) => { await set({ share: e.target.checked }); setTimeout(refreshStatus, 2500); });
    $('#lbAuto').addEventListener('change', (e) => set({ auto: e.target.checked }));
    $('#lbTel').addEventListener('change', (e) => set({ tel: e.target.checked }));
    $('#lbTarget').addEventListener('change', (e) => set({ target: e.target.value }));
    $('#lbUrlSave').addEventListener('click', async () => { rankCache.clear(); await set({ url: $('#lbUrl').value }); });
    $('#lbSync').addEventListener('click', async () => {
      $('#lbSync').disabled = true; $('#lbSync').textContent = 'Sending…';
      const r = await post('/api/board/sync', {});
      rankCache.clear(); state.status = r.status; drawStatus();
    });
  }

  async function refreshStatus() { state.status = await api('/api/board/status'); drawStatus(); }
  // after "Sign in with Steam": look every 2 s (for up to 10 minutes) whether the browser finished it
  let loginT = null;
  function waitForLogin() {
    clearInterval(loginT);
    const until = Date.now() + 10 * 60 * 1000;
    loginT = setInterval(async () => {
      if (Date.now() > until) { clearInterval(loginT); return; }
      const s = await api('/api/board/status').catch(() => null);
      if (s?.signedIn) { clearInterval(loginT); state.status = s; rankCache.clear(); drawStatus(); reloadBoards(); loadAdmin(); }
    }, 2000);
  }
  cleanup.push(() => clearInterval(loginT));

  // ------------------------------------------------------------ My best laps: place and gap to P1 on each board
  const sentRank = (b) => (b.board?.ok && b.board.rank ? { rank: b.board.rank, of: b.board.of ?? null } : null);
  /** The place and gap known for a lap: from its board when read, else the place given when it was sent. */
  function rankOf(b) {
    const v = rankCache.get(rankKey(b))?.val;
    const got = v && v !== 'error' ? v : null;
    const r = got?.rank ? got : sentRank(b);
    return { rank: r?.rank ?? null, of: r?.of ?? null, gap: got?.gap ?? null };
  }
  /** Reads the boards of your sent laps (at most RANK_MAX, RANK_PARALLEL at a time) for your place and gap to P1. */
  let rankRun = 0;
  async function loadRanks() {
    const run = ++rankRun;
    const now = Date.now();
    const todo = (state.status?.bests || []).filter((b) => b.board?.ok)
      .filter((b) => { const c = rankCache.get(rankKey(b)); return !c || now - c.at > RANK_TTL; }).slice(0, RANK_MAX);
    const one = async (b) => {
      const q = new URLSearchParams({ track: b.track, layout: b.layout ?? '', car: b.car });
      if (b.cond?.game) q.set('game', b.cond.game);
      let val;
      try {
        const rows = (await api(`/api/board/table?${q}`)).rows || [];
        const i = rows.findIndex((r) => r.me), me = rows[i];
        // not marked (not signed in here): the lap sent is your best, so it is measured against P1 as it is
        val = me ? { rank: i + 1, of: Math.max(rows.length, b.board?.of ?? 0), gap: me.lapMs - rows[0].lapMs }
          : { rank: null, of: null, gap: rows.length ? b.lapMs - rows[0].lapMs : null };
      } catch { val = 'error'; }
      rankCache.set(rankKey(b), { at: Date.now(), val });
    };
    const queue = [...todo];
    await Promise.all(Array.from({ length: Math.min(RANK_PARALLEL, queue.length) }, async () => {
      while (queue.length) { await one(queue.shift()); if (run === rankRun) mineCard(); }
    }));
  }

  const SORTS = {
    date: ['Driven', -1, (a, b) => (a.b.recordedAt ?? 0) - (b.b.recordedAt ?? 0)],
    track: ['Board', 1, (a, b) => trackLabel(a.b).localeCompare(trackLabel(b.b)) || prettyName(a.b.car).localeCompare(prettyName(b.b.car))],
    rank: ['Place', 1, null], // places unknown go last, whichever way
  };
  function mineCard() {
    const s = state.status, box = $('#lbMine');
    if (!s || !box) return;
    if (!s.bests.length) {
      box.innerHTML = '<h2>My best laps</h2><p class="muted">No laps to share yet. Laps driven from this version on carry their track conditions; your fastest valid lap on each track and car is the one that is shared.</p>';
      return;
    }
    const { k, dir } = state.sort;
    const focused = document.activeElement?.closest?.('#lbMine [data-sort]')?.dataset.sort;
    const list = s.bests.map((b) => ({ b, r: rankOf(b) }));
    if (k === 'rank') list.sort((a, b) => (a.r.rank == null) - (b.r.rank == null) || dir * ((a.r.rank ?? 0) - (b.r.rank ?? 0)) || SORTS.track[2](a, b));
    else list.sort((a, b) => dir * SORTS[k][2](a, b) || SORTS.track[2](a, b));
    const head = (key) => {
      const on = key === k, arrow = on ? (dir > 0 ? ' ▲' : ' ▼') : '';
      return `<th aria-sort="${on ? (dir > 0 ? 'ascending' : 'descending') : 'none'}"><button class="th-sort" data-sort="${key}">${SORTS[key][0]}${arrow}</button></th>`;
    };
    const loading = (b) => b.board?.ok && !rankCache.has(rankKey(b));
    const stCell = (b) => (!s.share ? '<span class="muted">not shared</span>'
      : !b.board && !s.signedIn ? '<span class="muted">waiting for Steam sign-in</span>'
        : !b.board && !s.auto ? '<span class="muted">not sent yet (Send now)</span>'
          : b.board?.ok ? `sent${b.board.tel ? (b.board.telError ? ' <span class="muted" title="' + esc(b.board.telError) + '">· no telemetry</span>' : ' <span class="muted">· with telemetry</span>') : ''}`
            : b.board ? `<span class="${b.board.retry ? 'muted' : 'error'}">${esc(b.board.error)}${b.board.retry ? ' (will try again)' : ''}</span>`
              : '<span class="muted">waiting</span>');
    box.innerHTML = `<h2>My best laps</h2>
      <p class="muted" style="font-size:13px;margin-top:0">Your fastest valid lap per track, car and game version, with its place and gap to P1 on that board. Sharing and sign-in are under <a href="#/leaderboard?tab=settings">Settings</a>.</p>
      <div style="overflow-x:auto"><table class="lb-mine" id="lbMineTable"><thead><tr>${head('track')}<th>Time</th>${head('rank')}<th>Gap to P1</th><th>Air / track</th>${head('date')}<th>Leaderboard</th></tr></thead><tbody>${list.map(({ b, r }) => `
        <tr data-board="${esc(comboKey(b))}"><td><a href="${boardLink(b)}">${esc(comboLabel(b))}</a>${b.carClass ? ` <span class="muted">· ${esc(b.carClass)}</span>` : ''}${b.cond?.game ? ` <span class="muted">· AC EVO ${esc(b.cond.game)}</span>` : ''}</td>
        <td class="mono">${fmt(b.lapMs)}</td>
        <td class="lb-rank"${loading(b) ? ' aria-busy="true"' : ''}>${r.rank ? place(r.rank, r.of) : '–'}</td>
        <td class="mono lb-gap">${r.gap == null ? '–' : r.gap === 0 && r.rank === 1 ? 'P1' : fmtGap(r.gap)}</td>
        <td>${temp(b.cond?.airC)} / ${temp(b.cond?.roadC)}</td><td class="muted">${b.recordedAt ? new Date(b.recordedAt).toLocaleDateString() : '–'}</td><td>${stCell(b)}</td></tr>`).join('')}</tbody></table></div>`;
    box.querySelectorAll('[data-sort]').forEach((btn) => btn.addEventListener('click', () => {
      const key = btn.dataset.sort;
      state.sort = key === state.sort.k ? { k: key, dir: -state.sort.dir } : { k: key, dir: SORTS[key][1] };
      mineCard();
      $(`#lbMine [data-sort="${key}"]`)?.focus();
    }));
    if (focused) $(`#lbMine [data-sort="${focused}"]`)?.focus(); // a refresh keeps the keyboard where it was
  }

  // ------------------------------------------------------------ Boards
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

  /** The board card: the pickers (kept while the table reloads, so focus stays where it is) and the table. */
  function boardCard({ picker = false } = {}) {
    const box = $('#lbBoard');
    if (!box) return;
    if (state.error) {
      box.innerHTML = `<h2>Board</h2><p class="error">${esc(state.error)}</p><p class="muted" style="font-size:13px">Check your internet connection, or the server address under <a href="#/leaderboard?tab=settings">Settings</a>.</p><button id="lbRetry">Try again</button>`;
      $('#lbRetry').addEventListener('click', loadCombos);
      return;
    }
    if (!state.combos.length) { box.innerHTML = '<h2>Board</h2><p class="muted">No laps on the leaderboard yet.</p>'; return; }
    if (picker || !$('#lbPick')) {
      box.innerHTML = '<div id="lbPick" class="row lb-pick"></div><div id="lbTable"></div>';
      drawPicker();
    }
    drawTable();
  }

  function drawPicker() {
    const c = current(), pick = $('#lbPick');
    if (!c || !pick) return;
    const focused = document.activeElement?.id;
    const tracks = [...new Map(state.combos.map((x) => [trackKey(x), { v: trackKey(x), label: trackLabel(x) }])).values()]
      .sort((a, b) => a.label.localeCompare(b.label));
    // the boards of this track: car classes first, then the single cars (loadCombos sorted them so)
    const cars = state.combos.filter((x) => trackKey(x) === trackKey(c))
      .map((x) => ({ v: comboKey(x), label: carLabel(x), group: x.cls ? 'Car classes' : 'Cars' }));
    const field = (id, label, items, v) => `<div class="lb-field"><label for="${id}" class="muted">${label}</label>
      <div class="cbx"><input id="${id}" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${id}List" autocomplete="off" spellcheck="false"
        data-value="${esc(v)}" value="${esc(items.find((x) => x.v === v)?.label ?? '')}"><ul id="${id}List" role="listbox" aria-label="${label}" hidden></ul></div></div>`;
    pick.innerHTML = `${field('lbTrack', 'Track', tracks, trackKey(c))}${field('lbCar', 'Car', cars, comboKey(c))}
      <div class="lb-field"><label for="lbGame" class="muted">Game version</label><select id="lbGame"></select></div>`;
    drawGame();
    combobox($('#lbTrack'), tracks, (v) => {
      // the same car (or class) on the new track if it has laps there, else your own car there, else its first board
      const on = state.combos.filter((x) => trackKey(x) === v);
      const same = on.find((x) => (x.cls ? `class:${x.cls}` : x.car) === (c.cls ? `class:${c.cls}` : c.car));
      const mine = on.find((x) => !x.cls && (state.status?.bests || []).some((b) => comboKey(b) === comboKey(x)));
      state.combo = comboKey(same || mine || on[0]);
      state.game = '';
      drawPicker();
      $('#lbCar')?.focus();
      loadBoard(true);
    });
    combobox($('#lbCar'), cars, (v) => { state.combo = v; state.game = ''; loadBoard(true); });
    $('#lbGame').addEventListener('change', (e) => { state.game = e.target.value; loadBoard(); });
    if (focused && $(`#${focused}`)) $(`#${focused}`).focus();
  }

  function drawGame() {
    const sel = $('#lbGame');
    if (sel) sel.innerHTML = `<option value="">All game versions</option>${state.versions.map((v) => `<option value="${esc(v.game ?? '')}" ${v.game === state.game ? 'selected' : ''}>AC EVO ${esc(v.game ?? '?')}</option>`).join('')}`;
  }

  function drawTable() {
    const box = $('#lbTable'), c = current();
    if (!box || !c) return;
    const rows = state.rows || [];
    const nSec = Math.max(0, ...rows.map((r) => r.sectors.length));
    const bestSec = Array.from({ length: nSec }, (_, k) => Math.min(...rows.map((r) => r.sectors[k] ?? Infinity)));
    const lead = rows[0]?.lapMs;
    const s = state.status || {};
    const me = rows.some((r) => r.me);
    const actions = (r) => [
      r.tel ? `<button class="small" data-compare="${r.lapId}" title="Download this lap and compare it with your best">Compare</button>` : '',
      s.signedIn && !r.me ? `<button class="small ghost" data-report="${r.lapId}" title="This lap looks impossible">Report</button>` : '',
      s.signedIn && r.me ? `<button class="small ghost" data-remove="${r.lapId}" title="Remove this lap of yours from the leaderboard">Remove</button>` : '',
      s.admin ? `<button class="small ghost" data-hide="${r.lapId}" title="Moderator: hide this lap from every board (written to the moderation trail)">Hide</button>` : '',
    ].join(' ');
    box.innerHTML = `
      <div class="row" style="gap:10px;min-height:28px;margin:4px 0 6px"><div id="lbMsg" class="muted" role="status" style="font-size:13px">${esc(state.msg)}</div><span class="spacer"></span>
        ${me ? '<button class="small" id="lbShowMe" title="Scroll to your row on this board">Show me</button>' : ''}</div>
      ${state.loading && !state.rows ? '<span class="spinner"></span>' : !rows.length ? '<p class="muted">No laps match these filters.</p>' : `
      <div style="overflow-x:auto"><table class="lb"><thead><tr><th>#</th><th>Driver</th>${c.cls ? '<th>Car</th>' : ''}<th>Time</th><th>Gap</th><th>Int.</th>${Array.from({ length: nSec }, (_, k) => `<th>S${k + 1}</th>`).join('')}<th>Air</th><th>Track</th><th>Weather</th><th>Game</th><th>Driven</th><th title="What the server checked for this lap">Evidence</th><th></th></tr></thead>
      <tbody>${rows.map((r, i) => `<tr class="${r.me ? 'lb-me' : ''}"${r.me ? ' tabindex="-1"' : ''}><td>${i + 1}</td><td><a href="#" data-driver="${esc(r.driver)}">${esc(r.name)}</a>${r.me ? ' <span class="muted">(you)</span>' : ''}</td>
        ${c.cls ? `<td>${esc(prettyName(r.car))}</td>` : ''}
        <td class="mono"><b>${fmt(r.lapMs)}</b></td><td class="mono muted">${i ? fmtGap(r.lapMs - lead) : ''}</td><td class="mono muted">${i ? fmtGap(r.lapMs - rows[i - 1].lapMs) : ''}</td>
        ${Array.from({ length: nSec }, (_, k) => `<td class="mono ${r.sectors[k] === bestSec[k] ? 'lb-best' : ''}">${secFmt(r.sectors[k])}</td>`).join('')}
        <td>${temp(r.airC)}</td><td>${temp(r.roadC)}</td><td>${esc([r.weather, r.grip].filter(Boolean).join(' · ') || '–')}</td>
        <td class="muted">${esc(r.game ?? '?')}</td><td class="muted">${new Date(r.drivenAt).toLocaleDateString()}</td><td>${tierCell(r.tier)}</td><td class="lb-act">${actions(r)}</td></tr>`).join('')}</tbody></table></div>
      ${analysis(rows, nSec)}
      <p class="muted" style="font-size:12px;margin-top:8px">Evidence says what the server checked for each lap. A Steam sign-in proves who sent a lap, not that it was driven as sent: no check run on a PC or on the server can prove that.</p>`}`;
    $('#lbShowMe')?.addEventListener('click', () => {
      const tr = $('#lbTable tr.lb-me');
      if (!tr) return;
      const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      tr.scrollIntoView({ block: 'center', behavior: still ? 'auto' : 'smooth' });
      tr.focus({ preventScroll: true });
      tr.classList.remove('lb-flash'); void tr.offsetWidth; tr.classList.add('lb-flash');
      setTimeout(() => tr.classList.remove('lb-flash'), 2000);
    });
  }

  // the board's buttons and driver links (one listener for the whole page, removed when the page is left)
  async function onClick(e) {
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
      try { await post('/api/board/delete-lap', { lapId: Number(rm.dataset.remove) }); say('Removed.'); rankCache.clear(); await refreshStatus(); await loadCombos(); }
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
  }
  view.addEventListener('click', onClick);
  cleanup.push(() => view.removeEventListener('click', onClick));

  async function loadCombos() {
    if (tab !== 'boards') return;
    try {
      const r = await api('/api/board/combos');
      const cls = (r.classes || []).map((x) => ({ track: x.track, layout: x.layout, cls: x.car_class, drivers: x.drivers }));
      // per track: the class boards first, then the cars
      state.combos = [...cls, ...(r.combos || [])].sort((a, b) => trackLabel(a).localeCompare(trackLabel(b)) || (a.cls ? 0 : 1) - (b.cls ? 0 : 1) || comboLabel(a).localeCompare(comboLabel(b)));
      state.error = null;
    } catch (e) {
      state.combos = []; state.error = `The leaderboard server is not reachable at ${state.status?.url || '?'}: ${e.message}`;
    }
    // which board: the one asked for (a link), the one in view, the last one looked at, the newest of your best laps, the first
    const has = (k) => !!k && state.combos.some((x) => comboKey(x) === k);
    const newest = [...(state.status?.bests || [])].sort((a, b) => (b.recordedAt ?? 0) - (a.recordedAt ?? 0)).map(comboKey).find(has);
    state.combo = [state.wanted, state.combo, lastBoard(), newest].find(has) || (state.combos[0] ? comboKey(state.combos[0]) : null);
    state.wanted = null;
    boardCard({ picker: true });
    await loadBoard(true);
  }

  let boardRun = 0;
  async function loadBoard(withVersions = false) {
    const c = current();
    if (!c || state.error) { boardCard(); return; }
    const run = ++boardRun;
    state.combo = comboKey(c);
    rememberBoard(state.combo);
    const q = new URLSearchParams({ track: c.track, layout: c.layout ?? '' });
    q.set(c.cls ? 'class' : 'car', c.cls || c.car);
    state.loading = true;
    if (withVersions) state.rows = null; // another board: not the old one's rows under the new name
    boardCard();
    try {
      if (withVersions) {
        const v = (await api(`/api/board/versions?${q}`)).versions || [];
        if (run !== boardRun) return;
        state.versions = v; drawGame();
      }
      if (state.game !== '') q.set('game', state.game);
      const rows = (await api(`/api/board/table?${q}`)).rows || [];
      if (run !== boardRun) return;
      state.rows = rows;
    } catch {
      if (run !== boardRun) return;
      state.error = 'The leaderboard server is not reachable.';
    }
    state.loading = false;
    boardCard();
  }

  // ------------------------------------------------------------ driver profile
  async function loadProfile(id) {
    state.driver = id;
    const box = $('#lbProfile');
    if (!box) return;
    box.innerHTML = '<div class="card"><span class="spinner"></span></div>';
    try {
      const p = await api(`/api/board/driver?id=${encodeURIComponent(id)}`);
      box.innerHTML = `<div class="card"><div class="row"><h2 style="margin:0">${esc(p.name)}</h2><span class="spacer"></span>
          <a href="https://steamcommunity.com/profiles/${esc(p.driver)}" target="_blank" rel="noopener">Steam profile</a><button class="ghost" id="lbProfClose" style="margin-left:10px">Close</button></div>
        <p class="muted">${p.boards.length} board${p.boards.length === 1 ? '' : 's'} · ${p.wins} P1 · ${p.podiums} podium${p.podiums === 1 ? '' : 's'}</p>
        <table class="lb-mine"><thead><tr><th>Board</th><th>Time</th><th>Place</th><th>Just ahead</th></tr></thead><tbody>${p.boards.map((b) => `
          <tr><td><a href="${boardLink(b)}">${esc(comboLabel(b))}</a>${b.carClass ? ` <span class="muted">· ${esc(b.carClass)}</span>` : ''}</td>
          <td class="mono">${fmt(b.lapMs)}</td><td>${place(b.rank, b.of)}</td>
          <td>${b.ahead ? `${esc(b.ahead.name)} <span class="mono muted">${signed(b.ahead.lapMs - b.lapMs)}</span>` : '<span class="muted">–</span>'}</td></tr>`).join('')}</tbody></table></div>`;
      $('#lbProfClose').addEventListener('click', () => { box.innerHTML = ''; state.driver = null; });
      box.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) { box.innerHTML = `<div class="card"><p class="error">${esc(e.message)}</p></div>`; }
  }

  // ------------------------------------------------------------ moderators: reported or flagged laps, evidence, trail
  async function loadAdmin() {
    if (!$('#lbAdmin')) return;
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
  api('/api/board/profile').then((r) => { if (r?.status) { state.status = r.status; drawStatus(); } }).catch(() => {});
  if (tab === 'boards') { await loadCombos(); loadAdmin(); }
  if (tab === 'mine') loadRanks();
  if (state.driver) loadProfile(state.driver);
  const t = setInterval(() => { if (!state.status?.syncing) refreshStatus().then(() => { if (tab === 'mine') loadRanks(); }).catch(() => {}); }, 15000);
  cleanup.push(() => clearInterval(t), () => { rankRun++; boardRun++; });
}
