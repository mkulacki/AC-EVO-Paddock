// Deterministic synthetic laps with known driving patterns, for the PL6 lap analysis tests (provenance:
// test/fixtures/README.md). No randomness: every lap is a pure function of its parameters.
//
// The circuit: a 500 m straight into a hairpin (R 18 m, 150°), 350 m into a medium right (R 60 m, 90°), 350 m into a
// left (R 40 m, 120°), then 300 m to the line. Speed: the cornering limit (1.7 g), braking at 27 m/s² × the corner's
// brake factor (lower = braking earlier and softer), accelerating as the mock car does (src/mock.js). One sample per
// metre, as the recorder's distance channel would give at ~60 Hz.
//
// Per-corner parameters (arrays of 3, one per corner):
//   brake: braking factor (1 = the latest braking; 0.7 = brakes earlier and longer)
//   hold:  metres of part throttle (50 %, half the acceleration) after the corner, before full throttle
//   gear:  gears added at the corner (a taller gear than the speed suggests; does not change the speed)
// noGear: write gear 0 everywhere (a lap file without a gear channel).
// dip: {at, kmh}: slow to kmh at metre `at` (a lift on a straight; PL7 review: a best lap with one more corner).
export const COMBO = { track: 'fixture_ring', layout: 'gp', car: 'fixture_gt' };
const LAYOUT = [[500, 18, 150], [350, 60, -90], [350, 40, 120], [300, 0, 0]];

function buildTrack() {
  const pts = []; let x = 0, z = 0, h = 0;
  LAYOUT.forEach(([str, r, ang], ci) => {
    for (let i = 0; i < str; i++) { pts.push({ x, z, curv: 0, k: ci, arc: false }); x += Math.cos(h); z += Math.sin(h); }
    if (r) {
      const len = Math.round((Math.abs(ang) * Math.PI / 180) * r);
      for (let i = 0; i < len; i++) { const curv = Math.sign(ang) / r; pts.push({ x, z, curv, k: ci, arc: true, last: i === len - 1 }); x += Math.cos(h); z += Math.sin(h); h += curv; }
    }
  });
  return pts;
}
const TRACK = buildTrack();
export const LENGTH = TRACK.length;

export function lapData({ brake = [1, 1, 1], hold = [0, 0, 0], gear = [0, 0, 0], noGear = false, dip = null } = {}) {
  const n = TRACK.length, G = 9.81, muG = 1.7 * G, vTop = 72, aDec = 27;
  const vlim = TRACK.map((p) => (p.curv ? Math.sqrt(muG / Math.abs(p.curv)) : vTop));
  const v = vlim.slice();
  v[0] = 60;
  if (dip) v[dip.at] = Math.min(v[dip.at], dip.kmh / 3.6); // a lift on a straight: one more speed minimum (an extra "corner" on a best lap)
  // braking: backwards from each corner, at the deceleration of the corner ahead
  for (let i = n - 2; i >= 0; i--) {
    const k = TRACK[i + 1].k;
    v[i] = Math.min(v[i], Math.sqrt(v[i + 1] ** 2 + 2 * aDec * (brake[k] ?? 1)));
  }
  const thr = new Array(n).fill(1), brk = new Array(n).fill(0);
  let holding = 0;
  for (let i = 1; i < n; i++) {
    const pv = v[i - 1], p = TRACK[i];
    if (TRACK[i - 1].last) holding = hold[TRACK[i - 1].k] || 0;
    let acc = 9 * (1 - pv / vTop) + 1;
    const part = holding > 0 && !p.arc;
    if (part) { acc *= 0.5; holding--; }
    const vf = Math.sqrt(pv * pv + 2 * acc);
    if (vf <= v[i]) { v[i] = vf; thr[i] = part ? 0.5 : 1; brk[i] = 0; }
    else if (pv - v[i] > 0.05) { brk[i] = Math.min(1, (pv * pv - v[i] * v[i]) / 2 / aDec + 0.2); thr[i] = 0; }
    else { brk[i] = 0; thr[i] = part ? 0.5 : 0.45; } // holding the cornering limit
  }
  const t = [0];
  for (let i = 1; i < n; i++) t.push(t[i - 1] + 2000 / (v[i] + v[i - 1]));
  const d = TRACK.map((_, i) => i);
  const spd = v.map((x) => Math.round(x * 3.6 * 100) / 100);
  const gr = spd.map((kmh, i) => (noGear ? 0 : Math.min(6, 1 + Math.floor(kmh / 45)) + (TRACK[i].arc ? gear[TRACK[i].k] || 0 : 0)));
  const data = {
    t: t.map((x) => Math.round(x)), d, spd, thr, brk, str: TRACK.map((p) => Math.max(-1, Math.min(1, p.curv * 30))), gear: gr,
    rpm: spd.map(() => 6000), x: TRACK.map((p) => Math.round(p.x * 100) / 100), z: TRACK.map((p) => Math.round(p.z * 100) / 100),
    glat: spd.map(() => 0), glon: spd.map(() => 0), ok: spd.map(() => 1),
  };
  return { data, lapTimeMs: Math.round(t[n - 1] + 2000 / (v[n - 1] + v[0])) };
}

/** Inserts a lap into the database (src/db.js insertLap) and returns its id. */
export function insertLap(db, { sessionId, lapNumber = 1, recordedAt, params = {}, valid = true, combo = COMBO }) {
  const { data, lapTimeMs } = lapData(params);
  return db.insertLap({ sessionId, ...combo, lapNumber, lapTimeMs, valid, driver: 'Me', recordedAt, trackLength: LENGTH, data });
}
