// Pure telemetry analysis: distance resampling, deltas, corner detection, corner metrics, ideal lap.
export const CHANNELS = ['t', 'spd', 'thr', 'brk', 'str', 'gear', 'rpm', 'x', 'z', 'glat', 'glon'];
const STEP_CHANNELS = new Set(['gear']); // not interpolated

export const gridStep = (L) => Math.min(3, Math.max(1, L / 2500));

// Resample raw samples (time-based) onto a fixed distance grid [0, L].
export function resample(data, L, lapTimeMs, step = gridStep(L)) {
  // keep strictly increasing distance
  const idx = [];
  let last = -Infinity;
  for (let i = 0; i < data.d.length; i++) {
    const d = data.d[i];
    if (Number.isFinite(d) && d > last + 0.01) { idx.push(i); last = d; }
  }
  const src = {};
  for (const c of [...CHANNELS, 'd']) src[c] = idx.map((i) => data[c]?.[i] ?? 0);
  // anchor the start (d=0, t extrapolated) and the end (d=L, t=official lap time)
  if (src.d[0] > 0) {
    const v = Math.max(src.spd[0], 10) / 3.6;
    for (const c of CHANNELS) src[c].unshift(src[c][0]);
    src.d.unshift(0);
    src.t[0] = Math.max(0, src.t[1] - (src.d[1] / v) * 1000);
  }
  if (src.d[src.d.length - 1] < L) {
    const n = src.d.length - 1;
    for (const c of CHANNELS) src[c].push(src[c][n]);
    src.d.push(L);
    const v = Math.max(src.spd[n], 10) / 3.6;
    src.t[n + 1] = lapTimeMs || src.t[n] + ((L - src.d[n]) / v) * 1000;
  }
  const n = Math.floor(L / step) + 1;
  const out = { step, n, L, d: new Array(n) };
  for (const c of CHANNELS) out[c] = new Array(n);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.min(i * step, L);
    out.d[i] = d;
    while (j < src.d.length - 2 && src.d[j + 1] < d) j++;
    const d0 = src.d[j], d1 = src.d[j + 1];
    const f = d1 > d0 ? Math.min(1, Math.max(0, (d - d0) / (d1 - d0))) : 0;
    for (const c of CHANNELS) {
      const a = src[c][j], b = src[c][j + 1];
      out[c][i] = STEP_CHANNELS.has(c) ? (f < 0.5 ? a : b) : a + (b - a) * f;
    }
  }
  return out;
}

export function smooth(arr, w) {
  if (w < 1) return arr.slice();
  const out = new Array(arr.length);
  let sum = 0, cnt = 0;
  for (let i = 0; i < arr.length + w; i++) {
    if (i < arr.length) { sum += arr[i]; cnt++; }
    if (i - 2 * w - 1 >= 0) { sum -= arr[i - 2 * w - 1]; cnt--; }
    const k = i - w;
    if (k >= 0 && k < arr.length) out[k] = sum / cnt;
  }
  return out;
}

const argmin = (a, s, e) => { let m = s; for (let i = s; i <= e; i++) if (a[i] < a[m]) m = i; return m; };
const argmax = (a, s, e) => { let m = s; for (let i = s; i <= e; i++) if (a[i] > a[m]) m = i; return m; };

// Detect corners from the reference lap's speed trace (speed minima with enough prominence).
// Segments are split at the fastest point between consecutive corners.
export function detectCorners(R) {
  const { step, n } = R;
  const s = smooth(R.spd, Math.round(20 / step));
  const W = Math.round(80 / step), P = Math.round(400 / step);
  const at = (i) => s[((i % n) + n) % n];
  let mins = [];
  for (let i = 0; i < n; i++) {
    let isMin = true;
    for (let k = -W; k <= W && isMin; k++) if (k && at(i + k) < s[i]) isMin = false;
    if (!isMin) continue;
    let before = 0, after = 0;
    for (let k = 1; k <= P; k++) { before = Math.max(before, at(i - k)); after = Math.max(after, at(i + k)); }
    if (before - s[i] >= 10 && after - s[i] >= 6) mins.push(i);
  }
  // merge minima that are too close
  const merged = [];
  for (const i of mins) {
    const prev = merged[merged.length - 1];
    if (prev !== undefined && (i - prev) * step < 120) { if (s[i] < s[prev]) merged[merged.length - 1] = i; }
    else merged.push(i);
  }
  mins = merged;
  const bounds = [0];
  for (let k = 0; k + 1 < mins.length; k++) bounds.push(argmax(s, mins[k], mins[k + 1]));
  bounds.push(n - 1);
  if (!mins.length) return [{ n: 1, name: 'Lap', apexIdx: argmin(s, 0, n - 1), a: 0, b: n - 1 }];
  return mins.map((apexIdx, k) => ({ n: k + 1, name: `T${k + 1}`, apexIdx, a: bounds[k], b: bounds[k + 1] }));
}

const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10 || 0);

// ---------------------------------------------------------------- racing line geometry
// Unit tangent (heading) of a resampled lap at every grid point.
export function headings(R) {
  const k = Math.max(1, Math.round(4 / R.step)), n = R.n;
  const hx = new Array(n), hz = new Array(n);
  for (let i = 0; i < n; i++) {
    let dx = R.x[Math.min(n - 1, i + k)] - R.x[Math.max(0, i - k)];
    let dz = R.z[Math.min(n - 1, i + k)] - R.z[Math.max(0, i - k)];
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) { hx[i] = i ? hx[i - 1] : 1; hz[i] = i ? hz[i - 1] : 0; continue; }
    hx[i] = dx / len; hz[i] = dz / len;
  }
  return { hx, hz };
}

// Signed lateral distance (m) of lap R from the reference line at every grid point.
// Positive = to the left of the reference in (x, z) coordinates (counter-clockwise of heading).
export function lateralOffsets(R, ref) {
  const n = Math.min(R.n, ref.n), W = Math.max(3, Math.round(30 / ref.step));
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const qx = R.x[i], qz = R.z[i];
    let best = Infinity, side = 0;
    for (let j = Math.max(0, i - W); j < Math.min(ref.n - 1, i + W); j++) {
      const ax = ref.x[j], az = ref.z[j], dx = ref.x[j + 1] - ax, dz = ref.z[j + 1] - az;
      const L2 = dx * dx + dz * dz;
      const t = L2 > 0 ? Math.max(0, Math.min(1, ((qx - ax) * dx + (qz - az) * dz) / L2)) : 0;
      const px = ax + dx * t, pz = az + dz * t;
      const d2 = (qx - px) ** 2 + (qz - pz) ** 2;
      if (d2 < best) { best = d2; side = dx * (qz - pz) - dz * (qx - px); }
    }
    out[i] = Math.sqrt(best) * (side >= 0 ? 1 : -1);
  }
  return out;
}

// Turning direction of the reference around a corner apex: +1 = counter-clockwise (left in x/z), -1 = clockwise.
export function turnSign(ref, apexIdx) {
  const k = Math.round(30 / ref.step), n = ref.n;
  const a = Math.max(0, apexIdx - k), b = Math.min(n - 1, apexIdx + k);
  const H = headings({ ...ref, n });
  return H.hx[a] * H.hz[b] - H.hz[a] * H.hx[b] >= 0 ? 1 : -1;
}

// Track width used across many laps: min/max lateral offset around the reference line (+ half a car width).
export function envelope(ref, offsetLists, pad = 1.0) {
  const n = ref.n, H = headings(ref);
  let lo = new Array(n).fill(0), hi = new Array(n).fill(0);
  for (const off of offsetLists) for (let i = 0; i < n; i++) { if (off[i] < lo[i]) lo[i] = off[i]; if (off[i] > hi[i]) hi[i] = off[i]; }
  const w = Math.round(5 / ref.step);
  lo = smooth(lo, w); hi = smooth(hi, w);
  const L = { x: [], z: [] }, Rr = { x: [], z: [] };
  for (let i = 0; i < n; i++) {
    const nx = -H.hz[i], nz = H.hx[i]; // left normal
    L.x.push(ref.x[i] + nx * (hi[i] + pad)); L.z.push(ref.z[i] + nz * (hi[i] + pad));
    Rr.x.push(ref.x[i] + nx * (lo[i] - pad)); Rr.z.push(ref.z[i] + nz * (lo[i] - pad));
  }
  return { left: L, right: Rr };
}

// Per-corner driving metrics for one resampled lap.
// `wide` (optional) = lateral offset vs reference converted to + = towards the outside of this corner.
export function cornerMetrics(R, c, wide) {
  const { step } = R;
  const win = Math.round(100 / step);
  const apex = argmin(R.spd, Math.max(c.a, c.apexIdx - win), Math.min(c.b, c.apexIdx + win));
  const peak = argmax(R.spd, c.a, apex);
  let brakeIdx = null, liftIdx = null, brakeEnd = null, pickup = null, full = null;
  for (let i = c.a; i <= apex; i++) if (R.brk[i] > 0.1) { brakeIdx = i; break; }
  if (brakeIdx == null) for (let i = peak; i <= apex; i++) if (R.thr[i] < 0.3) { liftIdx = i; break; }
  for (let i = c.a; i <= Math.min(c.b, apex + win); i++) if (R.brk[i] > 0.1) brakeEnd = i;
  const from = Math.max(apex - win, brakeEnd ?? c.a, c.a);
  for (let i = from; i <= c.b; i++) if (R.thr[i] > 0.2) { pickup = i; break; }
  for (let i = apex; i <= c.b; i++) if (R.thr[i] > 0.95) { full = i; break; }
  let maxBrake = 0, coast = 0, maxSteer = 0;
  for (let i = c.a; i <= c.b; i++) {
    maxBrake = Math.max(maxBrake, R.brk[i]);
    maxSteer = Math.max(maxSteer, Math.abs(R.str[i]));
    if (R.thr[i] < 0.1 && R.brk[i] < 0.1 && R.spd[i] > 30) coast += step;
  }
  const exitIdx = Math.min(c.b, apex + Math.round(150 / step));
  const d = (i) => (i == null ? null : Math.round(R.d[i]));
  const entryIdx = brakeIdx ?? liftIdx ?? Math.max(c.a, apex - Math.round(60 / step));
  const line = wide ? {
    entryWide: r1(wide[entryIdx]), apexWide: r1(wide[apex]), exitWide: r1(wide[Math.min(c.b, apex + Math.round(80 / step))]),
  } : {};
  return {
    ...line,
    timeMs: Math.round(R.t[c.b] - R.t[c.a]),
    entrySpeed: r1(R.spd[peak]), brakePoint: d(brakeIdx), liftPoint: d(liftIdx),
    maxBrakePct: Math.round(maxBrake * 100), brakeRelease: d(brakeEnd),
    minSpeed: r1(R.spd[apex]), apexAt: d(apex), throttlePickup: d(pickup), fullThrottle: d(full),
    exitSpeed: r1(R.spd[exitIdx]), coastM: Math.round(coast), minGear: R.gear[apex], maxSteer: r1(maxSteer),
  };
}

export function lapStats(R) {
  let full = 0, brake = 0, coast = 0, top = 0;
  for (let i = 0; i < R.n; i++) {
    if (R.thr[i] > 0.95) full++;
    if (R.brk[i] > 0.1) brake++;
    if (R.thr[i] < 0.1 && R.brk[i] < 0.1 && R.spd[i] > 30) coast++;
    top = Math.max(top, R.spd[i]);
  }
  return { topSpeed: r1(top), fullThrottlePct: r1((full / R.n) * 100), brakingPct: r1((brake / R.n) * 100), coastM: Math.round(coast * R.step) };
}

export const deltaSeries = (R, ref) => R.t.map((t, i) => Math.round(t - ref.t[i]) / 1000);

// Ideal lap: for each corner segment take the fastest lap and splice the traces together.
export function buildIdeal(laps /* [{id, R}] */, corners) {
  if (!laps.length) return null;
  const n = laps[0].R.n;
  const R = { step: laps[0].R.step, n, L: laps[0].R.L, d: laps[0].R.d.slice() };
  for (const c of CHANNELS) R[c] = new Array(n);
  const sources = [];
  let tStart = 0;
  for (const c of corners) {
    let best = null;
    for (const lap of laps) {
      const dt = lap.R.t[c.b] - lap.R.t[c.a];
      if (!best || dt < best.dt) best = { lap, dt };
    }
    const L = best.lap.R;
    for (let i = c.a; i <= c.b; i++) {
      for (const ch of CHANNELS) R[ch][i] = L[ch][i];
      R.t[i] = tStart + (L.t[i] - L.t[c.a]);
    }
    tStart += best.dt;
    sources.push({ corner: c.name, lapId: best.lap.id, timeMs: Math.round(best.dt) });
  }
  return { R, timeMs: Math.round(tStart), sources };
}
