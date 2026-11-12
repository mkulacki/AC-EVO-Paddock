// Live HUD data: delta to the all-time best (or ideal / session best), predicted lap, trend,
// corner-by-corner gain/loss and the next corner's reference numbers. Fed from the 60 Hz telemetry loop.
import * as db from './db.js';
import * as svc from './service.js';
import { cornerMetrics } from './analysis.js';
import { STATUS } from './shm.js';
import * as cars from './cars.js';

const MODES = ['best', 'ideal', 'session'];
const LABELS = { best: 'All-time best', ideal: 'Ideal lap', session: 'Session best' };
const TREND_WINDOW_MS = 1000;
const CORNER_SHOW_MS = 8000;
const SAVED_SHOW_MS = 8000;
const CUE_SHOW_MS = 6000;
const LIFT_SAMPLES = 5;   // ~80 ms at 60 Hz
const PICKUP_SAMPLES = 4;
const AHEAD_STEP_M = 5;   // the reference lap's pedals ahead of the car, for the HUD's input markers:
const AHEAD_N = 40;       // 40 points 5 m apart = 200 m, enough for the 0.2 s between the game's reads
const SHIFT_AT = 0.96;    // share of the redline where the shift lights flash (outside the game)
const FUEL_LAPS = 5;      // laps averaged for fuel use

export class LiveHud {
  constructor(recorder) {
    this.rec = recorder;
    this.mode = 'best';
    this.refs = null;        // loaded references for the current combo
    this.refsKey = null;
    this.cur = null;         // per-lap tracking (corner crossings)
    this.ring = [];          // [{at, delta}] for the trend
    this.delta = null;
    this.lastCorner = null;  // {name, deltaMs, at}
    this.cueRes = { brake: null, throttle: null }; // this lap's brake / throttle points vs the reference
    this.saved = null;       // {id, lapTimeMs, valid, pb, at}
    this.frame = null;
    this.lastSectors = null; // the previous lap's sector times, shown until this lap overwrites them
    this.fuel = { lap: null, start: null, pit: false, used: [] }; // litres used per lap
    this.redline = { key: null, rpm: null, seen: 0 }; // from the car catalogue, else the highest rpm seen
    recorder.on('lap', (l) => this.onLap(l));
    recorder.on('session', () => { this.refsKey = null; this.fuel.used = []; this.redline.key = null; });
  }

  setMode(mode) {
    if (mode === 'cycle') {
      const avail = MODES.filter((m) => this.refFor(m));
      const i = avail.indexOf(this.mode);
      mode = avail.length ? avail[(i + 1) % avail.length] : 'best';
    }
    if (!MODES.includes(mode)) throw new Error('unknown reference');
    this.mode = mode;
    this.ring = [];
  }

  onLap(l) {
    const prevBest = this.refs?.best?.timeMs ?? null;
    this.saved = { id: l.id, lapTimeMs: l.lapTimeMs, valid: l.valid, pb: l.valid && (prevBest == null || l.lapTimeMs < prevBest), at: Date.now() };
    this.refsKey = null; // best / ideal / session best may have changed
  }

  // ------------------------------------------------------------ references
  loadRefs() {
    const s = this.rec.session;
    const key = s ? `${s.key}|${s.id}` : null;
    if (key === this.refsKey) return this.refs;
    this.refsKey = key;
    this.refs = null;
    if (!s) return null;
    try {
      const info = svc.comboInfo(s);
      const refs = { corners: info.corners, best: null, ideal: null, session: null };
      if (info.best) {
        const e = svc.getResampled(info.best.id);
        if (e) refs.best = { id: info.best.id, timeMs: info.best.lap_time_ms, at: info.best.recorded_at, R: e.R };
      }
      if (info.ideal) refs.ideal = { id: 'ideal', timeMs: info.ideal.timeMs, R: info.ideal.R };
      const sb = s.id ? db.bestLapOfSession(s.id) : null;
      if (sb) {
        const e = svc.getResampled(sb.id);
        if (e && (!refs.best || e.R.n === refs.best.R.n)) refs.session = { id: sb.id, timeMs: sb.lap_time_ms, R: e.R };
      }
      for (const m of MODES) if (refs[m]) refs[m].metrics = refs.corners.map((c) => cornerMetrics(refs[m].R, c));
      refs.sectors = refs.best ? sectorInfo(s, refs.best.R) : null;
      this.refs = refs;
    } catch (e) { console.error('[hud] reference load failed:', e.message); }
    return this.refs;
  }

  refFor(mode) { return this.loadRefs()?.[mode] ?? null; }

  // ------------------------------------------------------------ per frame
  onFrame(f) {
    this.frame = f;
    if (!f || f.status !== STATUS.LIVE) return;
    const lap = this.rec.lap;
    if (lap && f.fuel > 0) this.trackFuel(f, lap);
    if (f.rpm > this.redline.seen) this.redline.seen = f.rpm;
    const ref = this.refFor(this.mode);
    if (!lap || !lap.full || f.inPit) { this.delta = null; this.cur = null; return; }
    const b = lap.buf, n = b.d.length;
    if (!n) return;
    const d = b.d[n - 1], t = f.lapTimeMs;

    // new lap: close the corner that ended at the line, and the last sector
    if (!this.cur || this.cur.lap !== lap) {
      if (this.cur && ref) this.closeCorner(this.cur, ref, this.cur.lastD, this.cur.lastT, true);
      if (this.cur) this.closeSectors(this.cur, f);
      this.cur = { lap, cross: new Map([[0, 0]]), lastD: null, lastT: null, k: 0, sk: 0, secs: [], secStart: 0 };
      this.ring = [];
    }
    if (!ref) { this.delta = null; return; }
    const R = ref.R;
    const scale = f.trackLength > 0 ? R.L / f.trackLength : 1;
    const dr = Math.max(0, Math.min(R.L, d * scale));
    const delta = t - interp(R.t, dr / R.step);
    const cur = this.cur;

    // corner boundaries crossed since the last frame (corners are contiguous segments a..b)
    if (cur.lastD != null && dr > cur.lastD) {
      const corners = this.refs.corners;
      while (cur.k < corners.length) {
        const c = corners[cur.k], bd = R.d[c.b];
        if (bd > dr) break;
        const tb = cur.lastT + ((bd - cur.lastD) / (dr - cur.lastD)) * (t - cur.lastT);
        cur.cross.set(c.b, tb);
        this.closeCorner(cur, ref, bd, tb, false);
        cur.k++;
      }
      // sector boundaries crossed (bounds: 0, the gates inside the lap, the line)
      const S = this.refs.sectors;
      while (S && cur.sk < S.n - 1) {
        const bd = S.bounds[cur.sk + 1];
        if (bd > dr) break;
        const tb = cur.lastT + ((bd - cur.lastD) / (dr - cur.lastD)) * (t - cur.lastT);
        cur.secs[cur.sk] = Math.round(tb - cur.secStart);
        cur.secStart = tb;
        cur.sk++;
      }
    }
    cur.lastD = dr; cur.lastT = t;
    this.trackCue(cur, ref, dr, b.thr[n - 1], b.brk[n - 1]);

    // trend over the last second (ms of delta per second)
    const now = Date.now();
    this.ring.push({ at: now, delta });
    while (this.ring.length > 2 && now - this.ring[1].at > TREND_WINDOW_MS) this.ring.shift();
    const first = this.ring[0];
    if (Math.abs(delta - first.delta) > 1500) this.ring = [{ at: now, delta }];
    const span = (now - this.ring[0].at) / 1000;
    const rate = span > 0.2 ? (delta - this.ring[0].delta) / span : 0;
    this.delta = { ms: Math.round(delta), rate: Math.round(rate), d: dr };
  }

  // Where this lap brakes (or lifts) and gets back on the throttle in the current corner, against the
  // reference lap's points. Same definitions as analysis.cornerMetrics, found live:
  //   brake    = first sample with brake > 10 % before the apex zone ends
  //   lift     = throttle < 30 % (only compared when the reference lap lifts there without braking)
  //   throttle = first throttle > 20 % once the brakes are released, from 100 m before the reference apex
  // A few consecutive samples are required, so a gear-change blip is not taken for a lift or a pick-up.
  trackCue(cur, ref, dr, thr, brk) {
    const corners = this.refs?.corners;
    if (!corners?.length || cur.k >= corners.length) return;
    const m = ref.metrics?.[cur.k];
    if (!m) return;
    let c = cur.cue;
    if (!c || c.k !== cur.k) c = cur.cue = { k: cur.k, onset: null, pickup: null, lastBrakeD: null, liftRun: 0, liftD: null, thrRun: 0, thrD: null };
    const name = corners[cur.k].name, now = Date.now();
    const refOnset = m.brakePoint ?? m.liftPoint;
    if (refOnset == null) return; // flat-out corner on the reference lap: nothing to compare
    if (brk > 0.1) c.lastBrakeD = dr;
    if (c.onset == null && dr <= m.apexAt + 100) {
      if (brk > 0.1) {
        c.onset = dr;
        this.cueRes.brake = { corner: name, kind: 'brake', refKind: m.brakePoint != null ? 'brake' : 'lift', deltaM: Math.round(dr - refOnset), at: now };
      } else if (m.brakePoint == null && dr >= refOnset - 150) {
        if (thr < 0.3) { if (!c.liftRun) c.liftD = dr; c.liftRun++; } else c.liftRun = 0;
        if (c.liftRun >= LIFT_SAMPLES) {
          c.onset = c.liftD;
          this.cueRes.brake = { corner: name, kind: 'lift', refKind: 'lift', deltaM: Math.round(c.liftD - refOnset), at: now };
        }
      }
    }
    if (c.onset != null && c.pickup == null && m.throttlePickup != null && dr >= m.apexAt - 100) {
      if (thr > 0.2 && brk <= 0.1) { if (!c.thrRun) c.thrD = dr; c.thrRun++; } else c.thrRun = 0;
      if (c.thrRun >= PICKUP_SAMPLES) {
        c.pickup = c.thrD;
        this.cueRes.throttle = { corner: name, deltaM: Math.round(c.thrD - m.throttlePickup), at: now };
      }
    }
  }

  // the lap ended: its last sector runs to the line (the game's lap time, unless that is stale)
  closeSectors(cur, f) {
    const S = this.refs?.sectors;
    if (!S) return;
    if (cur.sk === S.n - 1 && cur.lastT != null) {
      const gap = f.lastLapMs - cur.lastT;
      const end = gap > -50 && gap < 1000 ? f.lastLapMs : cur.lastT;
      cur.secs[S.n - 1] = Math.round(end - cur.secStart);
    }
    if (cur.secs.length) this.lastSectors = cur.secs.slice();
  }

  // litres used per lap: from the start of a lap to the start of the next; laps with a pit stop
  // (or a refuel) are left out of the average
  trackFuel(f, lap) {
    const F = this.fuel;
    if (F.lap !== lap) {
      if (F.lap && F.full && F.start != null && !F.pit) { // whole laps only (not the one Paddock joined mid-way)
        const used = F.start - f.fuel;
        if (used > 0.05 && used < 30) { F.used.push(used); if (F.used.length > FUEL_LAPS) F.used.shift(); }
      }
      F.lap = lap; F.full = !!lap.full; F.start = f.fuel; F.pit = !!f.inPit;
      return;
    }
    if (f.inPit) F.pit = true;
    if (f.fuel > F.start + 0.5) { F.start = f.fuel; F.pit = true; } // refuelled
  }

  // the car's redline from Paddock's car catalogue, else the highest rpm seen this session
  redlineFor(car) {
    const r = this.redline;
    if (r.key !== car) {
      r.key = car; r.rpm = null; r.seen = 0;
      try { r.rpm = cars.match(car)?.variants?.[0]?.stats?.redlineRpm || null; } catch { /* no catalogue */ }
    }
    return r.rpm || (r.seen > 3000 ? r.seen : null);
  }

  // time gained/lost in corner k (segment a..b) vs the reference
  closeCorner(cur, ref, dEnd, tEnd, atLine) {
    const corners = this.refs?.corners;
    if (!corners?.length || cur.k >= corners.length) return; // already closed before the line
    const k = atLine ? corners.length - 1 : cur.k;
    const c = corners[k];
    const ta = cur.cross.get(c.a);
    if (ta == null || tEnd == null) return;
    const R = ref.R;
    const refDt = interp(R.t, dEnd / R.step) - R.t[c.a];
    this.lastCorner = { name: c.name, deltaMs: Math.round((tEnd - ta) - refDt), at: Date.now() };
  }

  // ------------------------------------------------------------ payload for the HUD
  snapshot() {
    const f = this.frame, st = this.rec.state, s = this.rec.session, lap = this.rec.lap;
    const now = Date.now();
    const refs = (s && this.loadRefs()) || null;
    const ref = refs?.[this.mode] ?? null;
    const live = st.status === 'live' && f;
    const out = {
      v: 1, now,
      game: st.status, connected: st.connected,
      combo: s ? { track: s.track, layout: s.layout, car: s.car } : null,
      lap: live && lap ? {
        timeMs: f.lapTimeMs, timed: !!lap.full && !f.inPit, valid: !lap.invalid, inPit: f.inPit, tyresOut: f.tyresOut ?? 0,
        lapNumber: lap.lapNumber, d: this.delta?.d ?? null, speed: Math.round(f.speed || 0), gear: f.gear ?? null, length: ref?.R.L ?? f.trackLength,
      } : null,
      ref: {
        mode: this.mode, label: LABELS[this.mode], timeMs: ref?.timeMs ?? null,
        available: Object.fromEntries(MODES.map((m) => [m, !!refs?.[m]])),
      },
      delta: this.delta && ref ? { ms: this.delta.ms, rate: this.delta.rate, predictedMs: ref.timeMs + this.delta.ms } : null,
      times: {
        bestMs: refs?.best?.timeMs ?? null, bestAt: refs?.best?.at ?? null,
        idealMs: refs?.ideal?.timeMs ?? null, sessionBestMs: refs?.session?.timeMs ?? null,
        lastMs: f && f.lastLapMs > 0 ? f.lastLapMs : null,
      },
      corner: { last: null, next: null },
      saved: this.saved && now - this.saved.at < SAVED_SHOW_MS ? { ...this.saved, ageMs: now - this.saved.at } : null,
      trackData: s ? !!svc.trackModel(s.track, s.layout) : null,
    };
    if (this.lastCorner && now - this.lastCorner.at < CORNER_SHOW_MS) out.corner.last = { name: this.lastCorner.name, deltaMs: this.lastCorner.deltaMs };
    // next corner: first apex ahead of the car on the reference lap
    if (ref && this.delta && refs.corners.length) {
      const d = this.delta.d;
      const k = ref.metrics.findIndex((m) => m.apexAt > d);
      if (k >= 0) {
        const m = ref.metrics[k];
        const bp = m.brakePoint ?? m.liftPoint;
        out.corner.next = { name: refs.corners[k].name, toApexM: Math.round(m.apexAt - d),
          brakeInM: bp != null && bp > d ? Math.round(bp - d) : null, brakeKind: m.brakePoint != null ? 'brake' : 'lift',
          minSpeed: m.minSpeed, minGear: m.minGear };
      }
    }
    // brake / throttle cues: the countdown is extrapolated in the HUD from `now`, the distance and the speed
    if (ref && this.delta && live && lap?.full && !f.inPit) {
      const n = out.corner.next;
      const fresh = (r) => (r && now - r.at < CUE_SHOW_MS ? { corner: r.corner, kind: r.kind, refKind: r.refKind, deltaM: r.deltaM, ageMs: now - r.at } : null);
      out.cue = {
        next: n && n.brakeInM != null ? { corner: n.name, kind: n.brakeKind, inM: n.brakeInM } : null,
        speedMs: Math.round((f.speed / 3.6) * 10) / 10,
        brake: fresh(this.cueRes.brake), throttle: fresh(this.cueRes.throttle),
      };
      // the reference lap's pedals over the next 200 m: the HUD moves along it with the car's speed
      const R = ref.R, ahead = { step: AHEAD_STEP_M, speedMs: out.cue.speedMs, thr: [], brk: [] };
      for (let i = 0; i < AHEAD_N; i++) {
        const x = this.delta.d + i * AHEAD_STEP_M;
        if (x > R.L) break;
        ahead.thr.push(Math.round(interp(R.thr, x / R.step) * 100) / 100);
        ahead.brk.push(Math.round(interp(R.brk, x / R.step) * 100) / 100);
      }
      out.ahead = ahead;
    }
    // pedals, driver aids and revs (in game the HUD reads these from the game itself, every frame)
    if (live) {
      const red = this.redlineFor(s?.car);
      out.car = { gas: Math.round(f.gas * 100) / 100, brake: Math.round(f.brake * 100) / 100, tc: !!f.tc, abs: !!f.abs,
        rpm: f.rpm, rpmPct: red ? Math.round((f.rpm / red) * 1000) / 1000 : null, shift: !!red && f.rpm >= red * SHIFT_AT };
    }
    // fuel: litres left, average use per lap, laps that is good for
    if (live && f.fuel > 0) {
      const u = this.fuel.used, avg = u.length ? u.reduce((a, b) => a + b, 0) / u.length : null;
      out.fuel = { l: Math.round(f.fuel * 10) / 10, perLap: avg ? Math.round(avg * 100) / 100 : null, lapsLeft: avg ? Math.round((f.fuel / avg) * 10) / 10 : null };
    }
    // sectors: this lap's so far, the previous lap's, and the best of each (all-time / this session)
    const S = refs?.sectors;
    if (S) {
      const cur = this.cur;
      out.sectors = { n: S.n, k: cur && live ? cur.sk : null, cur: cur ? cur.secs.slice() : [], prev: this.lastSectors || [],
        best: S.best, sess: S.sess };
    }
    return out;
  }
}

// Sector boundaries on the reference grid, from AC EVO's track data (timing gates), else thirds of the
// lap; and the fastest time through each, over all valid laps (all-time) and this session's.
function sectorInfo(s, R) {
  let starts = null;
  try {
    const model = svc.trackModel(s.track, s.layout);
    if (model?.sectors?.length && model.L > 0) starts = model.sectors.map((x) => (x * R.L) / model.L).filter((x) => x > 1 && x < R.L - 1);
  } catch { /* no track data */ }
  if (!starts?.length) starts = [R.L / 3, (2 * R.L) / 3];
  const bounds = [0, ...starts, R.L];
  const n = bounds.length - 1;
  const best = new Array(n).fill(null), sess = new Array(n).fill(null);
  for (const l of db.lapsForCombo(s.track, s.layout, s.car, true)) {
    if (!l.valid) continue;
    const e = svc.getResampled(l.id);
    if (!e || e.R.n !== R.n) continue;
    const t = bounds.map((b, i) => (i === n ? l.lap_time_ms : interp(e.R.t, b / e.R.step)));
    for (let k = 0; k < n; k++) {
      const v = Math.round(t[k + 1] - t[k]);
      if (!(v > 0)) continue;
      if (best[k] == null || v < best[k]) best[k] = v;
      if (s.id && l.session_id === s.id && (sess[k] == null || v < sess[k])) sess[k] = v;
    }
  }
  return { n, bounds, best, sess };
}

function interp(arr, x) {
  const i = Math.max(0, Math.min(arr.length - 1, x));
  const a = Math.floor(i), b = Math.min(arr.length - 1, a + 1);
  return arr[a] + (arr[b] - arr[a]) * (i - a);
}
