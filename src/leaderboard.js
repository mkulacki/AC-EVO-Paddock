// Online leaderboard, version 1: lap times, sector times and track conditions (leaderboard/worker.js is the server).
//
// Every saved lap gets its own conditions (laps.cond): air and track temperature averaged over the lap, the weather
// and grip when the session was started from the Race tab, and the game and Paddock versions. When sharing is on
// (Leaderboards tab, off by default), the fastest valid lap per track / layout / car / game version is sent to the
// server; laps.board keeps how that went. Only laps that carry their conditions are sent, so laps driven before
// this version never are.
//
// Sending needs a Steam sign-in (the board itself is public). Sign-in runs in the browser: the leaderboard server
// sends the driver to Steam, confirms the answer with Steam, and comes back to this app's own local address
// (/api/board/callback) with a one-time code and the random `state` made here; the code is swapped for a login
// token, kept in settings.json (data\, never published) and sent only over https (or to a server on this PC).
import crypto from 'node:crypto';
import * as db from './db.js';
import * as settings from './settings.js';
import * as svc from './service.js';
import { STATUS } from './shm.js';

export const DEFAULT_URL = 'https://acevo-paddock-leaderboard.acevo-paddock.workers.dev'; // leaderboard/wrangler.toml (local test server: npm run board, http://127.0.0.1:8787)
const TIMEOUT_MS = 8000;
const SYNC_EVERY_MS = 10 * 60 * 1000;

const LOGIN_MS = 10 * 60 * 1000; // a sign-in started here must finish within this

const round1 = (v) => Math.round(v * 10) / 10;

/** Login tokens only travel encrypted: https, or plain http to a server on this PC (local testing). */
export function safeUrl(u) {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' || (x.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(x.hostname));
  } catch { return false; }
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

/** What the server is sent for a lap row (with data), or null when it cannot go. */
export function payload(lap) {
  const c = lap.cond ? JSON.parse(lap.cond) : null;
  if (!c || !lap.valid) return null;
  const sectors = lapSectors(lap);
  if (!sectors) return null;
  return {
    ref: `${lap.id}-${lap.recorded_at}`, track: lap.track, layout: lap.layout ?? '', car: lap.car,
    valid: true, lapMs: lap.lap_time_ms, sectors, airC: c.airC ?? null, roadC: c.roadC ?? null, weather: c.weather ?? null,
    grip: c.grip ?? null, game: c.game ?? null, app: c.app ?? null, drivenAt: lap.recorded_at,
  };
}

export function createLeaderboard({ recorder, launchInfo = () => null, gameVersion = () => null, appVersion = null, fetchImpl = (...a) => fetch(...a) }) {
  let acc = null; // temperatures of the lap being driven
  const state = { syncing: false, lastSync: null, lastError: null };
  const reset = () => { acc = { air: 0, road: 0, nA: 0, nR: 0 }; };
  reset();

  const cfg = () => {
    const s = settings.get();
    const url = String(s.boardUrl || DEFAULT_URL).replace(/\/+$/, '');
    // a login belongs to the server it was made on: with another address it is not used (nor sent there)
    const mine = !!s.boardToken && s.boardSteam?.url === url;
    return { share: !!s.boardShare, auto: s.boardAuto !== false, url, token: mine ? s.boardToken : '', steam: mine ? s.boardSteam : null };
  };
  const pending = new Map(); // sign-ins started here: state -> started at (only these may finish)

  /** Calls the server. auth: send the login token (only over https, or to a server on this PC). */
  async function call(path, opts = {}, { auth = false } = {}) {
    const c = cfg();
    const headers = { 'content-type': 'application/json' };
    if (auth) {
      if (!c.token) return { status: 401, body: { ok: false, error: 'sign in with Steam first' } };
      if (!safeUrl(c.url)) return { status: 0, body: { ok: false, error: 'the leaderboard address must start with https://' } };
      headers.authorization = `Bearer ${c.token}`;
    }
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const r = await fetchImpl(`${c.url}${path}`, { ...opts, signal: ctl.signal, headers });
      let body = null;
      try { body = await r.json(); } catch { /* not JSON */ }
      return { status: r.status, body };
    } catch (e) {
      return { status: 0, body: { ok: false, error: e.name === 'AbortError' ? 'the leaderboard server did not answer' : `cannot reach the leaderboard server (${e.cause?.code || e.message})` } };
    } finally { clearTimeout(timer); }
  }

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
        // sent counts per server and per Steam account: a lap sent elsewhere, before signing in or by another account goes again
        const sentByMe = b?.ok && b.steamId === c.steam?.steamId && b.url === c.url;
        if (b && (sentByMe || (!b.ok && !b.retry)) && !force) continue;
        const lap = db.getLap(row.id);
        const p = lap && payload(lap);
        if (!p) { db.setLapBoard(row.id, { at: Date.now(), ok: false, error: 'no sector times for this lap', retry: false }); continue; }
        const r = await call('/v1/laps', { method: 'POST', body: JSON.stringify(p) }, { auth: true });
        if (r.status === 401) { // the login ended (expired, or signed out elsewhere): the lap waits for a new sign-in
          settings.update({ boardToken: '' });
          state.lastError = 'signed out: sign in with Steam again';
          failed++;
          break;
        }
        if (r.body?.ok) {
          db.setLapBoard(row.id, { at: Date.now(), ok: true, rank: r.body.rank, of: r.body.of, steamId: c.steam?.steamId ?? null, url: c.url });
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
      return { sent, failed };
    } finally { state.syncing = false; }
  }

  if (recorder) {
    recorder.on('lap', onLap);
    recorder.on('session', reset);
    recorder.on('discarded', reset);
  }
  const timer = setInterval(() => sync().catch(() => {}), SYNC_EVERY_MS);
  timer.unref?.();

  return {
    onFrame, onLap, sync, call,
    /** For the Leaderboards tab. */
    status() {
      const c = cfg();
      const bests = db.boardBests().map((l) => ({ id: l.id, track: l.track, layout: l.layout, car: l.car, lapMs: l.lap_time_ms,
        cond: l.cond ? JSON.parse(l.cond) : null, board: l.board ? JSON.parse(l.board) : null }));
      return { share: c.share, auto: c.auto, url: c.url, secure: safeUrl(c.url), defaultUrl: DEFAULT_URL,
        signedIn: !!c.token, steam: c.token ? c.steam : null,
        syncing: state.syncing, lastSync: state.lastSync, lastError: state.lastError, bests };
    },
    /** The board for a combo, with the driver's own row marked. */
    async table(q) {
      const p = new URLSearchParams();
      for (const k of ['track', 'layout', 'car', 'game', 'airMin', 'airMax', 'roadMin', 'roadMax']) if (q[k] != null && q[k] !== '') p.set(k, q[k]);
      const me = cfg().steam?.steamId;
      if (me) p.set('me', me);
      return call(`/v1/board?${p}`);
    },
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
      settings.update({ boardToken: r.body.token, boardSteam: { steamId: r.body.steamId, name: r.body.name, url: cfg().url } });
      state.lastError = null;
      console.log(`[board] signed in with Steam as ${r.body.name}`);
      // laps that waited for the sign-in go now
      if (cfg().share && cfg().auto) setTimeout(() => sync().catch(() => {}), 500);
      return { ok: true, name: r.body.name };
    },
    async logout() {
      if (cfg().token) await call('/v1/logout', { method: 'POST', body: '{}' }, { auth: true });
      settings.update({ boardToken: '', boardSteam: null });
      console.log('[board] signed out');
    },
  };
}
