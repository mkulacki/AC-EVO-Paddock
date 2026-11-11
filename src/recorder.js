// Turns a stream of frames into sessions and laps.
import { EventEmitter } from 'node:events';
import * as db from './db.js';
import { STATUS } from './shm.js';

const CH = ['t', 'd', 'spd', 'thr', 'brk', 'str', 'gear', 'rpm', 'x', 'z', 'glat', 'glon',
  // track-limit data from EVO: tyres beyond limits, lap still valid, kerb vibration, tyre contact points (FL, FR, RL, RR)
  'out', 'ok', 'kerb', 'w0x', 'w0z', 'w1x', 'w1z', 'w2x', 'w2z', 'w3x', 'w3z'];

export class Recorder extends EventEmitter {
  constructor(getDriverName) {
    super();
    this.getDriverName = getDriverName;
    this.session = null;   // {key, id|null, track, layout, car, ...}
    this.lap = null;       // current lap buffer
    this.prev = null;
    this.pending = null;   // finished lap waiting for the official lap time
    this.state = { connected: false, status: 'offline', lastFrameAt: 0, savedLaps: 0, lastLap: null };
  }

  newLap(f, full) {
    const lap = { full, invalid: !f.valid, pit: f.inPit, startedAt: Date.now(), lapNumber: f.lapCount + 1, buf: {},
      prevP: null, wrap: 0, u0: null, d0: 0 };
    for (const c of CH) lap.buf[c] = [];
    return lap;
  }

  // Distance from the timing line. AC EVO's npos spline does not start at the timing line
  // (e.g. Red Bull Ring: ~125 m off), so npos is unwrapped and measured relative to the lap's first sample.
  distance(f, lap) {
    const L = f.trackLength || 0;
    const p = f.npos;
    if (lap.prevP != null) {
      if (p - lap.prevP < -0.5) lap.wrap += 1;
      else if (p - lap.prevP > 0.5) lap.wrap -= 1;
    }
    lap.prevP = p;
    const u = p + lap.wrap;
    if (lap.u0 == null) {
      lap.u0 = u;
      // distance already covered since the line when the first sample arrived
      lap.d0 = lap.full ? (Math.max(0, f.speed) / 3.6) * (Math.max(0, f.lapTimeMs) / 1000) : u * L;
    }
    return (u - lap.u0) * L + lap.d0;
  }

  push(f, lap) {
    const b = lap.buf;
    b.t.push(f.lapTimeMs); b.d.push(Math.round(this.distance(f, lap) * 100) / 100);
    b.spd.push(+f.speed.toFixed(2)); b.thr.push(+f.gas.toFixed(3)); b.brk.push(+f.brake.toFixed(3));
    b.str.push(+f.steer.toFixed(4)); b.gear.push(f.gear); b.rpm.push(f.rpm);
    b.x.push(+f.x.toFixed(2)); b.z.push(+f.z.toFixed(2));
    b.glat.push(+f.glat.toFixed(3)); b.glon.push(+f.glon.toFixed(3));
    b.out.push(f.tyresOut ?? 0); b.ok.push(f.valid ? 1 : 0); b.kerb.push(+(f.kerb ?? 0).toFixed(3));
    for (let w = 0; w < 4; w++) {
      const [wx, wz] = f.wheels?.[w] ?? [f.x, f.z];
      b[`w${w}x`].push(+wx.toFixed(2)); b[`w${w}z`].push(+wz.toFixed(2));
    }
    if (!f.valid) lap.invalid = true;
    if (f.inPit) lap.pit = true;
  }

  finalize(lap, lapTimeMs, f) {
    const b = lap.buf;
    const L = f.trackLength || Math.max(...b.d);
    const coverage = b.d.length ? (b.d[b.d.length - 1] - b.d[0]) / L : 0;
    if (!lap.full || lap.pit || b.t.length < 50 || coverage < 0.9 || !(lapTimeMs > 0)) {
      this.emit('discarded', { reason: !lap.full ? 'out lap' : lap.pit ? 'pit' : 'incomplete' });
      return;
    }
    if (!this.session.id) this.session.id = db.createSession(this.session);
    const meta = {
      sessionId: this.session.id, track: this.session.track, layout: this.session.layout, car: this.session.car,
      lapNumber: lap.lapNumber, lapTimeMs, valid: !lap.invalid, driver: this.session.driver,
      recordedAt: Date.now(), trackLength: L, data: b,
    };
    const id = db.insertLap(meta);
    this.state.savedLaps++;
    this.state.lastLap = { id, lapTimeMs, valid: meta.valid };
    this.emit('lap', { id, ...meta, data: undefined });
  }

  onFrame(f) {
    const now = Date.now();
    this.state.lastFrameAt = now;
    this.state.connected = true;
    if (!f || f.status === STATUS.OFF || !f.track) {
      this.state.status = 'menu';
      this.endSession();
      return;
    }
    this.state.status = ['off', 'replay', 'live', 'pause'][f.status] || 'unknown';
    if (f.status !== STATUS.LIVE) return; // ignore replay / pause (lap buffer is kept)

    const key = `${f.track}|${f.layout}|${f.car}|${f.sessionType}`;
    if (!this.session || this.session.key !== key) {
      this.endSession();
      this.session = { key, id: null, track: f.track, layout: f.layout, car: f.car, sessionType: f.sessionType,
        driver: this.getDriverName() || f.driver || 'Me', startedAt: now };
      this.emit('session', this.session);
    }

    // official lap time arrives a few frames after the line crossing
    if (this.pending) {
      const p = this.pending;
      p.frames++;
      if (f.lastLapMs > 0 && f.lastLapMs !== p.prevLast && Math.abs(f.lastLapMs - p.candidate) < 1500) {
        this.finalize(p.lap, f.lastLapMs, f); this.pending = null;
      } else if (p.frames > 60) { this.finalize(p.lap, p.candidate, f); this.pending = null; }
    }

    const prev = this.prev;
    this.prev = f;
    // a lap only counts if we saw it start (timer just reset, not in the pits); npos is not used here
    // because its zero point is not at the timing line
    if (!this.lap) { this.lap = this.newLap(f, f.lapTimeMs < 1000 && !f.inPit); }
    else if (prev && f.lapTimeMs < prev.lapTimeMs - 1000) {
      // lap timer reset: line crossed (lap count up / npos wrapped) or session restart
      const crossed = f.lapCount > prev.lapCount || (prev.npos > 0.9 && f.npos < 0.1);
      if (crossed) {
        if (this.pending) this.finalize(this.pending.lap, this.pending.candidate, f);
        this.pending = { lap: this.lap, candidate: prev.lapTimeMs, prevLast: prev.lastLapMs, frames: 0 };
        this.lap = this.newLap(f, true);
      } else {
        this.emit('discarded', { reason: 'restart' });
        this.lap = this.newLap(f, f.lapTimeMs < 3000);
      }
    } else if (prev && f.packetId === prev.packetId) {
      return; // no new physics step
    }
    if (f.speed > 1 || this.lap.buf.t.length) this.push(f, this.lap);
  }

  endSession() {
    if (this.pending && this.prev) this.finalize(this.pending.lap, this.pending.candidate, this.prev);
    this.pending = null; this.lap = null; this.prev = null;
    if (this.session) this.emit('sessionEnd', this.session);
    this.session = null;
  }

  // live info for the dashboard
  live() {
    const f = this.prev;
    if (!f || !this.lap) return null;
    const b = this.lap.buf, n = b.d.length;
    return {
      track: f.track, layout: f.layout, car: f.car, lapTimeMs: f.lapTimeMs, lastLapMs: f.lastLapMs, bestLapMs: f.bestLapMs,
      d: n ? b.d[n - 1] : 0, speed: f.speed, gear: f.gear, rpm: f.rpm, gas: f.gas, brake: f.brake, x: f.x, z: f.z,
      valid: !this.lap.invalid, fullLap: this.lap.full, trackLength: f.trackLength,
    };
  }
}
