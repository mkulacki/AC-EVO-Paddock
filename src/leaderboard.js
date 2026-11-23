// Online leaderboard (leaderboard/worker.js is the server): lap and sector times, track conditions, car class boards,
// light telemetry, "you were beaten" notices, the HUD's target, driver profiles, reports.
//
// Every saved lap gets its own conditions (laps.cond): air and track temperature averaged over the lap, the weather
// and grip when the session was started from the Race tab, and the game and Paddock versions. When sharing is on
// (Leaderboards tab, off by default), the fastest valid lap per track / layout / car / game version is sent to the
// server, with its light telemetry (src/telcodec.js) unless that is switched off; laps.board keeps how that went.
// Only laps that carry their conditions are sent, so laps driven before this existed never are.
//
// Sending needs a Steam sign-in (the boards are public). Sign-in runs in the browser: the leaderboard server
// sends the driver to Steam, confirms the answer with Steam, and comes back to this app's own local address
// (/api/board/callback) with a one-time code and the random `state` made here; the code is swapped for a login
// token, kept in settings.json (data\, never published) and sent only over https (or to a server on this PC).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import * as db from './db.js';
import * as settings from './settings.js';
import * as svc from './service.js';
import * as carsDb from './cars.js';
import { resample } from './analysis.js';
import { STATUS } from './shm.js';
import { encodeTel, decodeTel, toBase64, fromBase64, TEL_STEP } from './telcodec.js';

export const DEFAULT_URL = 'https://acevo-paddock-leaderboard.acevo-paddock.workers.dev'; // leaderboard/wrangler.toml (local test server: npm run board, http://127.0.0.1:8787)
const TIMEOUT_MS = 8000;
const SYNC_EVERY_MS = 10 * 60 * 1000;
const RANKS_EVERY_MS = 2 * 3600 * 1000; // "you were beaten": at start, after sending, and every 2 hours
const TARGET_TTL_MS = 10 * 60 * 1000;   // the HUD target's board is read again after this (and after each own lap sent)
const LOGIN_MS = 10 * 60 * 1000;        // a sign-in started here must finish within this
const RANKS_FILE = () => path.join(db.DATA_DIR, 'board-ranks.json');

const round1 = (v) => Math.round(v * 10) / 10;
const comboKey = (x) => `${x.track}|${x.layout ?? ''}|${x.car}`;
const pretty = (s) => String(s ?? '').replace(/_/g, ' ');
const fmtMs = (ms) => `${Math.floor(ms / 60000)}:${((ms % 60000) / 1000).toFixed(3).padStart(6, '0')}`;
const BOARD_ROWS = 8; // the in-game board window: P1-P3, then two above you, you, two below

/** Login tokens only travel encrypted: https, or plain http to a server on this PC (local testing). */
export function safeUrl(u) {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' || (x.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(x.hostname));
  } catch { return false; }
}

/** The class board a car races on: GT3 / GT4 / GT2 race cars, from the game's car list and the car's name.
 *  One-make cups, road and track cars have only their own car board (null). */
export function carClass(name) {
  let c = null;
  try { c = carsDb.match(name); } catch { /* no game data */ }
  const label = c ? `${c.brand} ${c.name} ${c.variants.map((v) => v.model).join(' ')}` : String(name ?? '');
  if (c && !c.categories.includes('Race')) return null;
  if (/\bGT3\b/i.test(label) && !/\bCup\b|Rennsport/i.test(label)) return 'GT3';
  if (/\bGT4\b/i.test(label)) return 'GT4';
  if (/\bGT2\b/i.test(label)) return 'GT2';
  return null;
}

/** The sector times (ms) of a lap from its recorded data, split at the game's own sector lines (thirds without
 *  track data). They add up to the lap time exactly. Null when the lap data does not allow it. */
export function lapSectors(lap) {
  const d = lap?.data?.d, t = lap?.data?.t, L = lap?.track_length, lapMs = lap?.lap_time_ms;
  if (!d?.length || !t?.length || !(L > 0) || !(lapMs > 0)) return null;
  let starts = null;
  try {
    const m = svc.trackModel(lap.track, lap.layout);
    if (m?.sectors?.length && m.L > 0) starts = m.sectors.map((x) => (x * L) / m.L).filter((x) => x > 1 && x < L - 1);
  } catch { /* no track data */ }
  if (!starts?.length) starts = [L / 3, (2 * L) / 3];
  const at = (dist) => { // lap time at a distance, between the two samples around it
    let lo = 0, hi = d.length - 1;
    if (dist <= d[0]) return t[0];
    if (dist >= d[hi]) return null;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (d[mid] < dist) lo = mid; else hi = mid; }
    const f = d[hi] > d[lo] ? (dist - d[lo]) / (d[hi] - d[lo]) : 0;
    return t[lo] + f * (t[hi] - t[lo]);
  };
  const marks = [0];
  for (const s of starts) {
    const v = at(s);
    if (v == null || !Number.isFinite(v)) return null;
    marks.push(Math.round(Math.max(v, 0)));
  }
  marks.push(lapMs);
  const out = marks.slice(1).map((v, i) => v - marks[i]);
  return out.every((x) => x > 0) ? out : null;
}

/** A lap's light telemetry (every 2 m: time, speed, pedals, steering, gear, revs, position), gzip + base64. */
export function lapTel(lap) {
  try {
    const R = resample(lap.data, lap.track_length, lap.lap_time_ms, TEL_STEP);
    return toBase64(zlib.gzipSync(encodeTel(R, lap.lap_time_ms), { level: 9 }));
  } catch { return null; }
}

/** What the server is sent for a lap row (with data), or null when it cannot go. */
export function payload(lap, { tel = true } = {}) {
  const c = lap.cond ? JSON.parse(lap.cond) : null;
  if (!c || !lap.valid) return null;
  const sectors = lapSectors(lap);
  if (!sectors) return null;
  return {
    ref: `${lap.id}-${lap.recorded_at}`, track: lap.track, layout: lap.layout ?? '', car: lap.car, carClass: carClass(lap.car),
    valid: true, lapMs: lap.lap_time_ms, sectors, airC: c.airC ?? null, roadC: c.roadC ?? null, weather: c.weather ?? null,
    grip: c.grip ?? null, game: c.game ?? null, app: c.app ?? null, drivenAt: lap.recorded_at, tel: tel ? lapTel(lap) : null,
  };
}

export function createLeaderboard({ recorder, launchInfo = () => null, gameVersion = () => null, appVersion = null,
  fetchImpl = (...a) => fetch(...a), notify = () => {} }) {
  let acc = null; // temperatures of the lap being driven
  const state = { syncing: false, lastSync: null, lastError: null, ranksAt: 0 };
  let profile = null;  // the driver's own profile, as last read (Leaderboards tab)
  let notices = [];    // "you were beaten", newest first
  let tgt = { key: null, at: 0, rows: null, loading: false, myBest: null }; // the HUD target's board
  const reset = () => { acc = { air: 0, road: 0, nA: 0, nR: 0 }; };
  reset();
  try { notices = JSON.parse(fs.readFileSync(RANKS_FILE(), 'utf8')).notices || []; } catch { /* none yet */ }

  const cfg = () => {
    const s = settings.get();
    const url = String(s.boardUrl || DEFAULT_URL).replace(/\/+$/, '');
    // a login belongs to the server it was made on: with another address it is not used (nor sent there)
    const mine = !!s.boardToken && s.boardSteam?.url === url;
    return { share: !!s.boardShare, auto: s.boardAuto !== false, tel: s.boardTel !== false, target: s.boardTarget || 'next',
      url, token: mine ? s.boardToken : '', steam: mine ? s.boardSteam : null };
  };
  const pending = new Map(); // sign-ins started here: state -> started at (only these may finish)

  /** Calls the server. auth: send the login token (only over https, or to a server on this PC). */
  async function call(p, opts = {}, { auth = false } = {}) {
    const c = cfg();
    const headers = { 'content-type': 'application/json' };
    if (auth) {
      if (!c.token) return { status: 401, body: { ok: false, error: 'sign in with Steam first' } };
      if (!safeUrl(c.url)) return { status: 0, body: { ok: false, error: 'the leaderboard address must start with https://' } };
      headers.authorization = `Bearer ${c.token}`;
    }
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const r = await fetchImpl(`${c.url}${p}`, { ...opts, signal: ctl.signal, headers });
      let body = null;
      try { body = await r.json(); } catch { /* not JSON */ }
      return { status: r.status, body };
    } catch (e) {
      return { status: 0, body: { ok: false, error: e.name === 'AbortError' ? 'the leaderboard server did not answer' : `cannot reach the leaderboard server (${e.cause?.code || e.message})` } };
    } finally { clearTimeout(timer); }
  }
  const signedOut = () => { settings.update({ boardToken: '' }); state.lastError = 'signed out: sign in with Steam again'; };

  function onFrame(f) {
    if (!f || f.status !== STATUS.LIVE || !f.probe) return;
    const a = f.probe.airTemp, r = f.probe.roadTemp;
    if (Number.isFinite(a) && a > -40 && a < 90) { acc.air += a; acc.nA++; }
    if (Number.isFinite(r) && r > -40 && r < 90) { acc.road += r; acc.nR++; }
  }

  function onLap(l) {
    const w = launchInfo() || {};
    const c = {
      airC: acc.nA ? round1(acc.air / acc.nA) : null, roadC: acc.nR ? round1(acc.road / acc.nR) : null,
      weather: w.weather ?? null, grip: w.grip ?? null, game: gameVersion() ?? null, app: appVersion,
    };
    reset();
    try { db.setLapCond(l.id, c); } catch (e) { console.log(`[board] conditions not saved: ${e.message}`); return; }
    if (l.valid && tgt.key === comboKey(l) && (tgt.myBest == null || l.lapTimeMs < tgt.myBest)) tgt.myBest = l.lapTimeMs;
    if (cfg().share && cfg().auto && l.valid) setTimeout(() => sync().catch(() => {}), 1500);
  }

  /** Sends every best lap not sent yet (or that failed for a reason worth retrying). Without automatic sending,
   *  only when asked (manual: the Send now button). */
  async function sync({ force = false, manual = false } = {}) {
    const c = cfg();
    if (!c.share || (!c.auto && !manual) || state.syncing) return { sent: 0, skipped: true };
    if (!c.token) return { sent: 0, skipped: true, reason: 'sign in with Steam first' };
    state.syncing = true;
    let sent = 0, failed = 0;
    try {
      for (const row of db.boardBests()) {
        const b = row.board ? JSON.parse(row.board) : null;
        // sent counts per server and per Steam account (a lap sent elsewhere, before signing in or by another
        // account goes again), and with its telemetry when that is shared (the server then only adds the telemetry)
        const sentByMe = b?.ok && b.steamId === c.steam?.steamId && b.url === c.url && (b.tel || !c.tel);
        if (b && (sentByMe || (!b.ok && !b.retry)) && !force) continue;
        const lap = db.getLap(row.id);
        const p = lap && payload(lap, { tel: c.tel });
        if (!p) { db.setLapBoard(row.id, { at: Date.now(), ok: false, error: 'no sector times for this lap', retry: false }); continue; }
        const r = await call('/v1/laps', { method: 'POST', body: JSON.stringify(p) }, { auth: true });
        if (r.status === 401) { signedOut(); failed++; break; } // the login ended: the lap waits for a new sign-in
        if (r.body?.ok) {
          db.setLapBoard(row.id, { at: Date.now(), ok: true, rank: r.body.rank, of: r.body.of, steamId: c.steam?.steamId ?? null, url: c.url,
            tel: !!p.tel, telError: r.body.telError ?? null, remoteId: r.body.lapId ?? null });
          if (r.body.telError) console.log(`[board] telemetry of ${row.track}/${row.car} not taken: ${r.body.telError}`);
          console.log(`[board] sent ${row.track}/${row.car} ${(row.lap_time_ms / 1000).toFixed(3)}s: ${r.body.rank ?? '?'} of ${r.body.of ?? '?'}`);
          sent++;
        } else {
          const error = r.body?.error || `HTTP ${r.status}`;
          // network trouble, the server or the rate limit: try again later
          const retry = r.status === 0 || r.status >= 500 || r.status === 429;
          db.setLapBoard(row.id, { at: Date.now(), ok: false, error, retry });
          console.log(`[board] not sent ${row.track}/${row.car}: ${error}`);
          state.lastError = error; failed++;
          if (r.status === 0) break; // the server is away: the rest would fail the same way
        }
      }
      if (!failed) state.lastError = null;
      state.lastSync = Date.now();
      if (sent) { tgt.at = 0; setTimeout(() => checkRanks().catch(() => {}), 500); }
      return { sent, failed };
    } finally { state.syncing = false; }
  }

  // ------------------------------------------------------------ "you were beaten"
  /** Reads the driver's own profile and tells them about every car board where someone went past. */
  async function checkRanks() {
    const c = cfg();
    if (!c.steam) return null;
    state.ranksAt = Date.now();
    const r = await call(`/v1/driver?id=${c.steam.steamId}`);
    if (!r.body?.ok) return null;
    profile = { at: Date.now(), ...r.body };
    let old = null;
    try { const j = JSON.parse(fs.readFileSync(RANKS_FILE(), 'utf8')); if (j.url === c.url && j.steamId === c.steam.steamId) old = j.ranks; } catch { /* first time */ }
    const ranks = {}, fresh = [];
    for (const b of r.body.boards) {
      const k = comboKey(b), o = old?.[k];
      ranks[k] = { rank: b.rank, lapMs: b.lapMs };
      const where = `${pretty(b.car)} · ${pretty(b.track)}${b.layout ? ` ${pretty(b.layout)}` : ''}`;
      const base = { at: Date.now(), track: b.track, layout: b.layout, car: b.car, to: b.rank, of: b.of ?? null };
      // kind: 'lost' = someone went past (a worse place with the same or a better own time), 'gained' = your own
      // faster lap moved you up, 'new' = your first time on this board (only after the first check, so not all at once)
      if (o && b.rank > o.rank && b.lapMs <= o.lapMs) {
        const gap = b.ahead ? ` ${b.ahead.name} is ${((b.lapMs - b.ahead.lapMs) / 1000).toFixed(3)} s faster.` : '';
        fresh.push({ ...base, kind: 'lost', from: o.rank, by: b.ahead?.name ?? null, title: `Leaderboard: P${o.rank} → P${b.rank}`, text: `${where}:${gap}` });
      } else if (o && b.rank < o.rank) {
        fresh.push({ ...base, kind: 'gained', from: o.rank, lapMs: b.lapMs, title: `Leaderboard: P${o.rank} → P${b.rank}`,
          text: `${where}:${b.lapMs < o.lapMs ? ` your ${fmtMs(b.lapMs)}.` : ''}` });
      } else if (!o && old) {
        fresh.push({ ...base, kind: 'new', from: null, lapMs: b.lapMs, title: `Leaderboard: new, P${b.rank}${b.of ? ` of ${b.of}` : ''}`, text: `${where}: your ${fmtMs(b.lapMs)}.` });
      }
    }
    notices = [...fresh.reverse(), ...notices].slice(0, 20);
    try { fs.writeFileSync(RANKS_FILE(), JSON.stringify({ url: c.url, steamId: c.steam.steamId, ranks, notices })); } catch { /* read-only data dir */ }
    // a desktop notice only when someone went past: your own gains you saw happen
    for (const n of fresh.filter((x) => x.kind === 'lost')) {
      console.log(`[board] ${n.title} ${n.text}`);
      notify({ title: n.title, body: n.text, hash: `#/leaderboard?combo=${encodeURIComponent(comboKey(n))}` });
    }
    return profile;
  }

  // ------------------------------------------------------------ the HUD's target
  async function loadTarget(s) {
    const key = comboKey(s);
    if (tgt.loading) return;
    tgt.loading = true;
    try {
      const own = db.lapsForCombo(s.track, s.layout, s.car, true).filter((l) => l.valid).map((l) => l.lap_time_ms);
      const q = new URLSearchParams({ track: s.track, layout: s.layout ?? '', car: s.car, limit: '500' });
      if (cfg().steam) q.set('me', cfg().steam.steamId);
      const r = await call(`/v1/board?${q}`);
      tgt = { key, at: Date.now(), rows: r.body?.ok ? r.body.rows : null, loading: false, myBest: own.length ? Math.min(...own) : null };
    } finally { tgt.loading = false; }
  }
  /** This combo's board as last read (read again in the background when it is another combo or older than the TTL). */
  function boardRows(s) {
    const key = comboKey(s);
    if (tgt.key !== key || Date.now() - tgt.at > TARGET_TTL_MS) { if (!tgt.loading) loadTarget(s).catch(() => {}); if (tgt.key !== key) return null; }
    return tgt.rows?.length ? tgt.rows : null;
  }
  /** The driver to beat on this combo: the one just ahead of your best (or P1), from the board read at the start. */
  function target(s) {
    const mode = cfg().target;
    if (mode === 'off' || !s) return null;
    const rows = boardRows(s);
    if (!rows) return null;
    let i;
    if (mode === 'p1') i = rows[0].me ? -1 : 0;
    else {
      // the slowest driver who is still faster than you; without a time of your own, the last on the board
      const mine = tgt.myBest;
      i = -1;
      for (let k = 0; k < rows.length; k++) if (!rows[k].me && (mine == null || rows[k].lapMs < mine)) i = k;
    }
    if (i < 0) return null;
    const r = rows[i];
    return { rank: i + 1, of: rows.length, name: r.name, lapMs: r.lapMs, sectors: r.sectors };
  }

  // ------------------------------------------------------------ the in-game board window
  let bw = { rowsAt: -1, key: null, myBest: undefined, out: null };
  /** P1-P3 and the two drivers either side of you (8 rows; fewer drivers, fewer rows). Your place counts your best
   *  lap here even before it is sent (local: true), so it moves the moment you drive it. Without a time of yours:
   *  the first 8. Gaps are to your time. Rebuilt only when the board or your best changes (the HUD asks every frame). */
  function boardWindow(s) {
    if (!s) return null;
    const rows = boardRows(s);
    if (!rows) return null;
    if (bw.rowsAt === tgt.at && bw.key === tgt.key && bw.myBest === tgt.myBest) return bw.out;
    const online = rows.find((r) => r.me);
    const list = rows.filter((r) => !r.me).map((r) => ({ name: r.name, lapMs: r.lapMs }));
    const times = [online?.lapMs, tgt.myBest].filter((v) => Number.isFinite(v));
    let me = -1, myMs = null;
    if (times.length) {
      myMs = Math.min(...times);
      me = list.findIndex((r) => r.lapMs > myMs);
      if (me < 0) me = list.length;
      list.splice(me, 0, { name: online?.name || cfg().steam?.name || 'You', lapMs: myMs, me: true, local: !(online && online.lapMs <= myMs) });
    }
    const n = list.length, cap = Math.min(BOARD_ROWS, n);
    const pick = new Set();
    for (let i = 0; i < Math.min(3, n); i++) pick.add(i);
    let lo = me < 0 ? 0 : Math.max(0, me - 2), hi = me < 0 ? -1 : Math.min(n - 1, me + 2);
    for (let i = lo; i <= hi; i++) pick.add(i);
    // near the top or the bottom (or no time of yours): fill up to 8 with the next drivers, below first
    while (pick.size < cap) {
      if (hi + 1 < n) pick.add(++hi);
      else if (lo > 0) pick.add(--lo);
      else break;
    }
    const out = {
      of: n,
      rows: [...pick].sort((a, b) => a - b).map((i) => {
        const r = list[i];
        return { rank: i + 1, name: r.name, lapMs: r.lapMs, me: !!r.me, local: !!r.local, gapMs: myMs != null && !r.me ? r.lapMs - myMs : null };
      }),
    };
    bw = { rowsAt: tgt.at, key: tgt.key, myBest: tgt.myBest, out };
    return out;
  }

  // ------------------------------------------------------------ another driver's lap, to compare with
  /** Downloads an online lap's telemetry into this Paddock (once) as a lap of source 'online'; its local id. */
  async function fetchOnline(remoteId) {
    const have = db.findOnlineLap(remoteId);
    if (have) return have.id;
    const r = await call(`/v1/telemetry?lap=${remoteId}`);
    if (!r.body?.ok) throw new Error(r.body?.error || `HTTP ${r.status}`);
    const gz = fromBase64(r.body.tel);
    const d = gz && decodeTel(new Uint8Array(zlib.gunzipSync(gz)));
    if (!d) throw new Error('the telemetry of this lap cannot be read');
    const data = { t: d.t, d: d.d, spd: d.spd, thr: d.thr, brk: d.brk, str: d.str, gear: d.gear, rpm: d.rpm, x: d.x, z: d.z };
    const id = db.insertLap({ sessionId: null, track: r.body.track, layout: r.body.layout, car: r.body.car, lapNumber: 0, lapTimeMs: r.body.lapMs, valid: true,
      driver: r.body.name || 'Online', source: 'online', recordedAt: Date.now(), trackLength: (d.n - 1) * d.step, data });
    db.setLapBoard(id, { online: remoteId, driver: r.body.driver ?? null, name: r.body.name ?? null });
    console.log(`[board] downloaded ${r.body.name}'s lap ${(r.body.lapMs / 1000).toFixed(3)}s (${r.body.track}/${r.body.car}) -> #${id}`);
    return id;
  }

  if (recorder) {
    recorder.on('lap', onLap);
    recorder.on('session', (s) => { reset(); if (s && cfg().target !== 'off') loadTarget(s).catch(() => {}); });
    recorder.on('discarded', reset);
  }
  const timer = setInterval(() => {
    sync().catch(() => {});
    if (Date.now() - state.ranksAt > RANKS_EVERY_MS) checkRanks().catch(() => {});
  }, SYNC_EVERY_MS);
  timer.unref?.();
  const first = setTimeout(async () => {
    // at start: is the login still good (and an admin?), then the places
    const c = cfg();
    if (!c.token) return;
    const me = await call('/v1/me', {}, { auth: true });
    if (me.status === 401) { signedOut(); return; }
    if (me.body?.ok) settings.update({ boardSteam: { ...c.steam, name: me.body.name, admin: !!me.body.admin } });
    await checkRanks();
  }, 5000);
  first.unref?.();

  return {
    onFrame, onLap, sync, call, checkRanks, target, boardWindow, loadTarget, fetchOnline,
    /** For the Leaderboards tab. */
    status() {
      const c = cfg();
      const bests = db.boardBests().map((l) => ({ id: l.id, track: l.track, layout: l.layout, car: l.car, carClass: carClass(l.car), lapMs: l.lap_time_ms,
        cond: l.cond ? JSON.parse(l.cond) : null, board: l.board ? JSON.parse(l.board) : null }));
      return { share: c.share, auto: c.auto, tel: c.tel, target: c.target, url: c.url, secure: safeUrl(c.url), defaultUrl: DEFAULT_URL,
        signedIn: !!c.token, steam: c.token ? c.steam : null, admin: !!(c.token && c.steam?.admin),
        syncing: state.syncing, lastSync: state.lastSync, lastError: state.lastError, bests, notices };
    },
    /** The board for a car (or a class), with the driver's own row marked. */
    async table(q) {
      const p = new URLSearchParams();
      for (const k of ['track', 'layout', 'car', 'class', 'game', 'airMin', 'airMax', 'roadMin', 'roadMax']) if (q[k] != null && q[k] !== '') p.set(k, q[k]);
      const me = cfg().steam?.steamId;
      if (me) p.set('me', me);
      return call(`/v1/board?${p}`);
    },
    driver: (id) => call(`/v1/driver?id=${encodeURIComponent(id)}`),
    report: (lapId, reason) => call('/v1/report', { method: 'POST', body: JSON.stringify({ lapId, reason }) }, { auth: true }),
    adminReports: () => call('/v1/admin/reports', {}, { auth: true }),
    adminHide: (lapId, hidden) => call('/v1/admin/hide', { method: 'POST', body: JSON.stringify({ lapId, hidden }) }, { auth: true }),
    /** Starts a Steam sign-in: the address to open in the browser. callback = this app's /api/board/callback. */
    loginUrl(callback) {
      const c = cfg();
      if (!safeUrl(c.url)) throw new Error('The leaderboard address must start with https://');
      const now = Date.now();
      for (const [k, t] of pending) if (now - t > LOGIN_MS) pending.delete(k);
      const st = crypto.randomBytes(16).toString('hex');
      pending.set(st, now);
      return `${c.url}/v1/auth/steam?${new URLSearchParams({ return: callback, state: st })}`;
    },
    /** The browser came back from the sign-in: check our state, swap the code for a login token. */
    async finishLogin({ code, state: st }) {
      const t = pending.get(st);
      if (!t || Date.now() - t > LOGIN_MS) return { ok: false, error: 'This sign-in was not started from this Paddock, or took too long. Start it again.' };
      pending.delete(st);
      const r = await call('/v1/auth/token', { method: 'POST', body: JSON.stringify({ code }) });
      if (!r.body?.ok || !/^[0-9a-f]{64}$/.test(r.body.token || '')) return { ok: false, error: r.body?.error || `HTTP ${r.status}` };
      settings.update({ boardToken: r.body.token, boardSteam: { steamId: r.body.steamId, name: r.body.name, admin: !!r.body.admin, url: cfg().url } });
      state.lastError = null;
      console.log(`[board] signed in with Steam as ${r.body.name}`);
      // laps that waited for the sign-in go now; then the places
      if (cfg().share && cfg().auto) setTimeout(() => sync().catch(() => {}), 500);
      setTimeout(() => checkRanks().catch(() => {}), 3000);
      return { ok: true, name: r.body.name };
    },
    async logout() {
      if (cfg().token) await call('/v1/logout', { method: 'POST', body: '{}' }, { auth: true });
      settings.update({ boardToken: '', boardSteam: null });
      profile = null;
      console.log('[board] signed out');
    },
    profile: () => profile,
  };
}
