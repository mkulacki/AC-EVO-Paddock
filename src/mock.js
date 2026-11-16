// Synthetic telemetry source for testing without the game.
// Builds a fictional circuit, computes a speed profile per lap with random driver mistakes,
// and replays it as shared-memory-like frames.
const G = 9.81;
const LAYOUT = [ // [straight m, radius m, angle deg]
  [700, 40, 90], [250, 120, 60], [200, 60, -45], [450, 18, 135], [300, 200, 40], [250, 80, -30], [350, 50, 110], [400, 0, 0],
];

function buildTrack() {
  // each point: position, curvature, and the index of the corner it belongs to (straights belong to the next corner)
  const pts = []; let x = 0, z = 0, h = 0;
  const nc = LAYOUT.length - 1;
  const add = (curv, cornerIdx) => { pts.push({ x, z, h, curv, cornerIdx }); x += Math.cos(h); z += Math.sin(h); h += curv; };
  LAYOUT.forEach(([str, r, ang], ci) => {
    for (let i = 0; i < str; i++) add(0, ci % nc);
    if (r) {
      const len = Math.round((Math.abs(ang) * Math.PI / 180) * r);
      for (let i = 0; i < len; i++) add(Math.sign(ang) / r, ci);
      pts[pts.length - 1].corner = ci; // corner exit marker
    }
  });
  return pts;
}
const TRACK = buildTrack();
export const MOCK_LENGTH = TRACK.length;

function lapProfile(skill = 0.6) {
  const n = TRACK.length, nc = LAYOUT.length - 1;
  const rnd = (a, b) => a + Math.random() * (b - a);
  // per-corner mistakes: lower corner speed, early braking, late throttle, coasting
  const cs = Array.from({ length: nc }, () => rnd(0.93 + 0.05 * skill, 1.0));
  const bd = Array.from({ length: nc }, () => rnd(0.75 + 0.2 * skill, 1.0));
  const late = Array.from({ length: nc }, () => (Math.random() < 0.35 ? rnd(10, 40) : 0));
  const muG = 1.7 * G, vTop = 72, aDecel = 27;
  const vlim = TRACK.map((p) => (p.curv ? Math.sqrt(muG / Math.abs(p.curv)) * cs[p.cornerIdx] : vTop));
  const v = new Array(n).fill(vTop);
  // backward pass (braking) then forward pass (acceleration)
  for (let k = 0; k < 2; k++) for (let i = n - 1; i >= 0; i--) {
    const nx = v[(i + 1) % n];
    v[i] = Math.min(vlim[i], Math.sqrt(nx * nx + 2 * aDecel * bd[TRACK[(i + 1) % n].cornerIdx]));
  }
  const thr = new Array(n).fill(1), brk = new Array(n).fill(0);
  let delay = 0;
  for (let k = 0; k < 2; k++) for (let i = 0; i < n; i++) {
    const pv = v[(i - 1 + n) % n];
    const acc = 9 * (1 - pv / vTop) + 1;
    const vf = Math.sqrt(pv * pv + 2 * acc);
    if (TRACK[i].corner !== undefined) delay = late[TRACK[i].cornerIdx];
    if (delay > 0 && !TRACK[i].curv) { delay--; v[i] = Math.min(v[i], pv); thr[i] = 0.05; continue; }
    if (vf <= v[i]) { v[i] = vf; thr[i] = 1; brk[i] = 0; }
    else { brk[i] = pv - v[i] > 0.05 ? Math.min(1, ((pv * pv - v[i] * v[i]) / 2) / aDecel + 0.2) : 0; thr[i] = brk[i] ? 0 : 0.45; }
  }
  const t = new Array(n); t[0] = 0;
  for (let i = 1; i < n; i++) t[i] = t[i - 1] + 2 / (v[i] + v[i - 1]);
  const lapTime = t[n - 1] + 2 / (v[n - 1] + v[0]);
  // racing line variation: per-corner lateral deviation (m), smoothed in and out of each corner
  const amp = Array.from({ length: nc }, () => rnd(-1.8, 1.8) * (1.2 - skill));
  const raw = TRACK.map((p) => (p.curv ? amp[p.cornerIdx] : 0));
  const lat = new Array(n).fill(0), W = 60;
  for (let i = 0; i < n; i++) { let s = 0; for (let k = -W; k <= W; k++) s += raw[(i + k + n) % n]; lat[i] = s / (2 * W + 1) + rnd(-0.05, 0.05); }
  return { v, thr, brk, t, lapTime, lat };
}

export class MockSource {
  constructor({ speedup = 1 } = {}) {
    this.speedup = speedup; this.dt = 1 / 60;
    this.lapCount = 0; this.lastLapMs = 0; this.bestLapMs = 0; this.packet = 0;
    this.prof = lapProfile(); this.time = this.prof.t[Math.floor(TRACK.length * 0.6)]; // start with an out lap
    this.out = true; this.invalid = false;
  }
  get name() { return `Mock track (x${this.speedup})`; }

  step() {
    this.time += this.dt; this.packet++;
    if (this.time >= this.prof.lapTime) {
      const ms = Math.round(this.prof.lapTime * 1000);
      this.lastLapMs = ms; if (!this.out && !this.invalid && (!this.bestLapMs || ms < this.bestLapMs)) this.bestLapMs = ms;
      this.time -= this.prof.lapTime; this.lapCount++; this.out = false;
      this.prof = lapProfile(); this.invalid = Math.random() < 0.12;
    }
  }

  frame() {
    const { t, v, thr, brk, lat } = this.prof; const n = TRACK.length;
    let lo = 0, hi = n - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (t[m] <= this.time) lo = m; else hi = m - 1; }
    const p = TRACK[lo]; const kmh = v[lo] * 3.6;
    const gear = Math.min(6, 1 + Math.floor(kmh / 45));
    const lapTimeMs = this.out ? Math.round((this.time - this.prof.t[Math.floor(n * 0.6)]) * 1000) : Math.round(this.time * 1000);
    // tyre contact points FL, FR, RL, RR (track 1.6 m, wheelbase 2.7 m)
    const cx = p.x - Math.sin(p.h) * lat[lo], cz = p.z + Math.cos(p.h) * lat[lo];
    const fx = Math.cos(p.h), fz = Math.sin(p.h), nx = -Math.sin(p.h), nz = Math.cos(p.h);
    const wheel = (side, fwd) => [cx + nx * 0.8 * side + fx * fwd, cz + nz * 0.8 * side + fz * fwd];
    const wheels = [wheel(1, 1.35), wheel(-1, 1.35), wheel(1, -1.35), wheel(-1, -1.35)];
    const warm = Math.min(1, (this.lapCount + lo / n) / 2); // tyres warm up over two laps
    const probe = { pressures: [26 + 1.8 * warm, 26 + 1.8 * warm, 26 + 1.5 * warm, 26 + 1.5 * warm], camber: [-0.85, -0.85, -1.05, -1.05],
      rideHeight: [62, 70], brakeBias: 0.58, airTemp: 21, roadTemp: 29 + warm };
    // car & setup report: fronts run a little over-inflated with too little camber, rears cool; front bump stop
    // reached under heavy braking, understeer mid-corner, wheelspin on slow exits, the odd front lock-up
    const gLat = (v[lo] ** 2) * p.curv / G, b = brk[lo], g = thr[lo];
    const tyres = [0, 1, 2, 3].map((w) => {
      const front = w < 2, base = 45 + (front ? 40 : 28) * warm + Math.abs(gLat) * 6;
      const i = base + (front ? 2 : 9), m = base + (front ? 7 : 1), o = base + (front ? 4 : 0);
      const brake = 180 + 520 * warm * (front ? 1 : 0.6) + 300 * b;
      return { lock: front && b > 0.97 && (this.packet % 7 === 0), p: probe.pressures[w], core: base + 3, brake, i, m, o,
        nP: front ? 0.82 : 0.55, nI: 0, nM: 0, nO: 0, nB: Math.min(1, brake / 900), nC: Math.min(1.2, (base + 3) / 85) };
    });
    const susp = [0, 1, 2, 3].map((w) => Math.min(w < 2 ? 62 : 75, 30 + (w < 2 ? 34 : 6) * b + 9 * Math.abs(gLat) + (w >= 2 ? 10 * g : 0)));
    const sa = Math.abs(p.curv) * v[lo] * 0.9;
    const carData = { tyres, susp, load: [3000, 3000, 3200, 3200], slipAngle: [sa * 1.35, sa * 1.35, sa, sa],
      slipRatio: [0, 0, ...[0, 0].map(() => (g > 0.85 && kmh < 110 && Math.abs(p.curv) > 0.004 ? 0.14 : 0.03))], phys: null };
    return { wheels, tyresOut: 0, kerb: 0, probe, carData,
      packetId: this.packet, status: 2, gas: thr[lo], brake: brk[lo], clutch: 0, gear, rpm: Math.round(4000 + ((kmh % 45) / 45) * 4000),
      fuel: Math.max(0, 60 - (this.lapCount + lo / n) * 2.3), // litres: 2.3 a lap from a 60 L tank
      steer: Math.max(-1, Math.min(1, p.curv * 30)), speed: kmh, glat: (v[lo] ** 2) * p.curv / G, glon: 0, tc: 0, abs: 0,
      lapTimeMs, lastLapMs: this.lastLapMs, bestLapMs: this.bestLapMs, lapCount: this.lapCount,
      npos: lo / n, inPit: false, valid: !(this.invalid && lo > n * 0.4), x: p.x - Math.sin(p.h) * lat[lo], y: 0, z: p.z + Math.cos(p.h) * lat[lo],
      car: 'mock_gt3', driver: 'Mock Driver', track: 'mock_ring', layout: 'gp', trackLength: n, sessionType: 0,
    };
  }

  read() { return this.frame(); }
  tick() { for (let i = 0; i < this.speedup; i++) this.step(); }
}

// Seed the database with N mock laps: node src/mock.js --seed 10
if (process.argv[1]?.endsWith('mock.js') && process.argv.includes('--seed')) {
  const n = Number(process.argv[process.argv.indexOf('--seed') + 1]) || 8;
  const { Recorder } = await import('./recorder.js');
  const rec = new Recorder(() => 'Mock Driver');
  const src = new MockSource();
  rec.on('lap', (l) => console.log(`lap #${l.id} ${(l.lapTimeMs / 1000).toFixed(3)}s ${l.valid ? '' : '(invalid)'}`));
  while (rec.state.savedLaps < n) { src.step(); rec.onFrame(src.frame()); }
  rec.endSession();
}
