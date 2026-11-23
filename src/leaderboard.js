// Online leaderboard, version 1: lap times, sector times and track conditions (leaderboard/worker.js is the server).
//
// Every saved lap gets its own conditions (laps.cond): air and track temperature averaged over the lap, the weather
// and grip when the session was started from the Race tab, and the game and Paddock versions. When sharing is on
// (Leaderboards tab, off by default), the fastest valid lap per track / layout / car / game version is sent to the
// server; laps.board keeps how that went. Only laps that carry their conditions are sent, so laps driven before
// this version never are. No login yet: the driver is a random id made here, with the name from Settings.
import crypto from 'node:crypto';
import * as db from './db.js';
import * as settings from './settings.js';
import * as svc from './service.js';
import { STATUS } from './shm.js';

export const DEFAULT_URL = 'http://127.0.0.1:8787';
const TIMEOUT_MS = 8000;
const SYNC_EVERY_MS = 10 * 60 * 1000;

const round1 = (v) => Math.round(v * 10) / 10;

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
export function payload(lap, { playerId, name }) {
  const c = lap.cond ? JSON.parse(lap.cond) : null;
  if (!c || !lap.valid) return null;
  const sectors = lapSectors(lap);
  if (!sectors) return null;
  return {
    player: { id: playerId, name }, ref: `${lap.id}-${lap.recorded_at}`, track: lap.track, layout: lap.layout ?? '', car: lap.car,
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
    return { share: !!s.boardShare, url: String(s.boardUrl || DEFAULT_URL).replace(/\/+$/, ''), name: String(s.driverName || '').trim(), playerId: s.boardPlayerId || '' };
  };
  const playerId = () => {
    let id = settings.get().boardPlayerId;
    if (!id) { id = crypto.randomBytes(16).toString('hex'); settings.update({ boardPlayerId: id }); }
    return id;
  };

  async function call(path, opts = {}) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const r = await fetchImpl(`${cfg().url}${path}`, { ...opts, signal: ctl.signal, headers: { 'content-type': 'application/json' } });
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
    if (cfg().share && l.valid) setTimeout(() => sync().catch(() => {}), 1500);
  }

  /** Sends every best lap not sent yet (or that failed for a reason worth retrying). */
  async function sync({ force = false } = {}) {
    const c = cfg();
    if (!c.share || state.syncing) return { sent: 0, skipped: true };
    state.syncing = true;
    let sent = 0, failed = 0;
    try {
      const pid = playerId();
      for (const row of db.boardBests()) {
        const b = row.board ? JSON.parse(row.board) : null;
        if (b && (b.ok || !b.retry) && !force) continue;
        const lap = db.getLap(row.id);
        const p = lap && payload(lap, { playerId: pid, name: c.name });
        if (!p) { db.setLapBoard(row.id, { at: Date.now(), ok: false, error: 'no sector times for this lap', retry: false }); continue; }
        const r = await call('/v1/laps', { method: 'POST', body: JSON.stringify(p) });
        if (r.body?.ok) {
          db.setLapBoard(row.id, { at: Date.now(), ok: true, rank: r.body.rank, of: r.body.of });
          console.log(`[board] sent ${row.track}/${row.car} ${(row.lap_time_ms / 1000).toFixed(3)}s: ${r.body.rank ?? '?'} of ${r.body.of ?? '?'}`);
          sent++;
        } else {
          const error = r.body?.error || `HTTP ${r.status}`;
          // network trouble, the server, the rate limit or a missing name: try again later
          const retry = r.status === 0 || r.status >= 500 || r.status === 429 || /driver name/.test(error);
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
      return { share: c.share, url: c.url, name: c.name, defaultUrl: DEFAULT_URL, syncing: state.syncing, lastSync: state.lastSync, lastError: state.lastError, bests };
    },
    /** The board for a combo, with the driver's own row marked. */
    async table(q) {
      const p = new URLSearchParams();
      for (const k of ['track', 'layout', 'car', 'game', 'airMin', 'airMax', 'roadMin', 'roadMax']) if (q[k] != null && q[k] !== '') p.set(k, q[k]);
      if (cfg().playerId) p.set('me', cfg().playerId);
      return call(`/v1/board?${p}`);
    },
  };
}
