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
    ...techniqueMetrics(R, c),
  };
}

// ---------------------------------------------------------------- driving technique (P6)
// How a corner was driven, from the pedals and the steering (core telemetry, checked against the game).
// Thresholds are relative to the pass itself (peak brake, peak steering lock), so they suit any car; comparisons
// against the corner's reference pass are made by the callers (report, Consistency page).
// The definitions are shown as tooltips (TECHNIQUE below); keep them in step with the code.
export const TECHNIQUE = {
  brakeRampMs: { label: 'Brake application', unit: 'ms', lowerBetter: true, def: 'Time from first touching the brake (over 10 %) to 90 % of the peak pressure of this corner. Shorter = a firmer, quicker hit.' },
  trailM: { label: 'Trail braking', unit: 'm', def: 'Distance with the brake still on (over 5 %) while the wheel is turned more than 20 % of the corner\'s peak lock: braking into the turn.' },
  releaseMs: { label: 'Brake release', unit: 'ms', def: 'Time from the last moment at 90 % of the peak pressure until the brake is off (under 5 %).' },
  releaseBumps: { label: 'Release bumps', unit: '', lowerBetter: true, def: 'Times the brake was pressed again by 5 % or more while releasing it. 0 = a smooth release.' },
  pickupMs: { label: 'Apex to full throttle', unit: 'ms', lowerBetter: true, def: 'Time from the slowest point of the corner to full throttle (over 95 %). Empty when full throttle is not reached before the next corner.' },
  reLifts: { label: 'Throttle re-lifts', unit: '', lowerBetter: true, def: 'Times the throttle went down again by 20 % or more after the exit had started (over 50 %).' },
  steerReversals: { label: 'Steering reversals', unit: '', lowerBetter: true, def: 'Big changes of steering direction (a swing of 25 % of the corner\'s peak lock or more). 1 for a simple corner: turn in, then unwind.' },
  steerSaw: { label: 'Steering saw', unit: '', lowerBetter: true, def: 'Small steering corrections: changes of direction between 2 % and 25 % of the corner\'s peak lock.' },
  coastM: { label: 'Coasting', unit: 'm', lowerBetter: true, def: 'Distance with neither pedal pressed (both under 10 %) above 30 km/h.' },
};

// Direction changes of a signal with hysteresis: a change counts when the value moves back by `th` from its extreme.
function reversals(a, s, e, th) {
  let dir = 0, hi = a[s], lo = a[s], n = 0;
  for (let i = s + 1; i <= e; i++) {
    const v = a[i];
    if (dir === 0) {
      hi = Math.max(hi, v); lo = Math.min(lo, v);
      if (v - lo >= th) { dir = 1; hi = v; } else if (hi - v >= th) { dir = -1; lo = v; }
    } else if (dir === 1) { if (v > hi) hi = v; else if (hi - v >= th) { n++; dir = -1; lo = v; } }
    else if (v < lo) lo = v; else if (v - lo >= th) { n++; dir = 1; hi = v; }
  }
  return n;
}

/** Technique metrics of one corner segment `c` ({a, b, apexIdx}) of a resampled lap. See TECHNIQUE. */
export function techniqueMetrics(R, c) {
  const { step } = R;
  const win = Math.round(100 / step);
  const apex = argmin(R.spd, Math.max(c.a, c.apexIdx - win), Math.min(c.b, c.apexIdx + win));
  const ms = (i, j) => (i == null || j == null ? null : Math.round(R.t[j] - R.t[i]));
  let peakLock = 0;
  for (let i = c.a; i <= c.b; i++) peakLock = Math.max(peakLock, Math.abs(R.str[i]));
  // brakes: the braking zone is the application holding the segment's peak pressure (up to just after the apex), from
  // its onset (over 10 %) to the brake coming off (under 5 %); an earlier short tap on the straight is not the zone
  const zEnd = Math.min(c.b, apex + win);
  let peak = c.a;
  for (let i = c.a; i <= zEnd; i++) if (R.brk[i] > R.brk[peak]) peak = i;
  let on = R.brk[peak] > 0.1 ? peak : null;
  if (on != null) while (on > c.a && R.brk[on - 1] > 0.1) on--;
  let brakeRampMs = null, releaseMs = null, releaseBumps = null, trail = 0;
  if (on != null) {
    let off = c.b;
    for (let i = peak; i <= c.b; i++) { if (R.brk[i] < 0.05) { off = i; break; } if (R.brk[i] > R.brk[peak]) peak = i; }
    const pk = R.brk[peak];
    let reach = peak; for (let i = on; i <= peak; i++) if (R.brk[i] >= 0.9 * pk) { reach = i; break; }
    let last = peak; for (let i = peak; i <= off; i++) if (R.brk[i] >= 0.9 * pk) last = i;
    brakeRampMs = ms(on, reach); releaseMs = ms(last, off);
    // re-applications while releasing: the brake rising again by 5 % from its lowest point so far
    // (falling: track the low, a rise of 5 % counts; rising: track the high, a fall of 5 % arms the next count)
    releaseBumps = 0; let rising = false, ext = R.brk[last];
    for (let i = last + 1; i <= off; i++) {
      const v = R.brk[i];
      if (!rising) { if (v < ext) ext = v; else if (v - ext >= 0.05) { releaseBumps++; rising = true; ext = v; } }
      else if (v > ext) ext = v; else if (ext - v >= 0.05) { rising = false; ext = v; }
    }
    if (peakLock >= 0.02) for (let i = on; i <= off; i++) if (R.brk[i] > 0.05 && Math.abs(R.str[i]) > 0.2 * peakLock) trail += step;
  }
  // throttle: apex to full throttle; re-lifts once the exit has started
  let full = null; for (let i = apex; i <= c.b; i++) if (R.thr[i] > 0.95) { full = i; break; }
  // (rising: track the high, a fall of 20 % counts; falling: track the low, a rise of 20 % arms the next count,
  // so one gradual lift counts once however far it goes)
  let reLifts = 0, started = false, falling = false, ext = 0;
  for (let i = apex; i <= c.b; i++) {
    const v = R.thr[i];
    if (!started) { if (v > 0.5) { started = true; ext = v; } continue; }
    if (!falling) { if (v > ext) ext = v; else if (ext - v >= 0.2) { reLifts++; falling = true; ext = v; } }
    else if (v < ext) ext = v; else if (v - ext >= 0.2) { falling = false; ext = v; }
  }
  let coast = 0;
  for (let i = c.a; i <= c.b; i++) if (R.thr[i] < 0.1 && R.brk[i] < 0.1 && R.spd[i] > 30) coast += step;
  // steering: big direction changes and small corrections, relative to this pass's peak lock
  const straight = peakLock < 0.02;
  const big = straight ? 0 : reversals(R.str, c.a, c.b, 0.25 * peakLock);
  const small = straight ? 0 : reversals(R.str, c.a, c.b, Math.max(0.004, 0.02 * peakLock));
  return {
    brakeRampMs, trailM: on != null ? Math.round(trail) : null, releaseMs, releaseBumps,
    pickupMs: ms(apex, full), reLifts: started ? reLifts : null,
    steerReversals: big, steerSaw: Math.max(0, small - big), coastM: Math.round(coast),
  };
}

// Performance score of a set of laps against the ideal lap (P6). The formula is shown on the page as written here.
// pace = 100 − 2000 × (median clean lap − ideal) / ideal (5 % slower than the ideal lap = 0)
// consistency = 100 − 4000 × σ / mean of the clean laps (as the session report)
// validity = valid laps / all laps × 100; score = 0.5 pace + 0.3 consistency + 0.2 validity (each 0..100).
// Clean = valid and within 7 % of the best of the set. Needs 3 clean laps; else null with the reason.
export const SCORE_FORMULA = 'Score = 0.5 × pace + 0.3 × consistency + 0.2 × validity. Pace = 100 − 2000 × (median clean lap − ideal lap) / ideal lap. Consistency = 100 − 4000 × σ / mean of the clean laps. Validity = valid laps / all laps × 100. Each part is kept between 0 and 100; clean laps are valid laps within 7 % of the best one.';
export function performanceScore(laps /* [{ms, valid}] */, idealMs) {
  const clamp = (v) => Math.max(0, Math.min(100, v));
  const valid = laps.filter((l) => l.valid && l.ms > 0).map((l) => l.ms);
  if (!laps.length || !idealMs) return { score: null, reason: idealMs ? 'no laps' : 'no ideal lap yet', laps: laps.length };
  const best = valid.length ? Math.min(...valid) : null;
  const clean = valid.filter((t) => t <= best * 1.07).sort((a, b) => a - b);
  if (clean.length < 3) return { score: null, reason: 'fewer than 3 clean laps', laps: laps.length, clean: clean.length };
  const m = clean.length >> 1, median = clean.length % 2 ? clean[m] : (clean[m - 1] + clean[m]) / 2;
  const mean = clean.reduce((a, b) => a + b, 0) / clean.length;
  const sd = Math.sqrt(clean.reduce((a, b) => a + (b - mean) ** 2, 0) / clean.length);
  const pace = clamp(100 - 2000 * (median - idealMs) / idealMs);
  const consistency = clamp(100 - 4000 * sd / mean);
  const validity = (valid.length / laps.length) * 100;
  return { score: Math.round(0.5 * pace + 0.3 * consistency + 0.2 * validity), pace: Math.round(pace), consistency: Math.round(consistency),
    validity: Math.round(validity), medianMs: Math.round(median), sdMs: Math.round(sd), idealMs, laps: laps.length, clean: clean.length };
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
// A lap is {id, R} (its resampled trace) or {id, dts} (its time per corner, src/service.js keeps these so a long
// history is not read again for every new lap); getR gives the full trace of a lap that holds a best corner.
const cornerTime = (lap, c, j) => (lap.dts ? lap.dts[j] : lap.R.t[c.b] - lap.R.t[c.a]);
/** The fastest lap through each corner: [{lap, dt}] (the first lap wins a tie). */
export function pickIdealCorners(laps, corners) {
  return corners.map((c, j) => {
    let best = null;
    for (const lap of laps) {
      const dt = cornerTime(lap, c, j);
      if (!best || dt < best.dt) best = { lap, dt };
    }
    return best;
  });
}
export function buildIdeal(laps /* [{id, R} | {id, dts}] */, corners, { grid = null, getR = (lap) => lap.R } = {}) {
  if (!laps.length) return null;
  const G = grid || getR(laps[0]);
  const n = G.n;
  const R = { step: G.step, n, L: G.L, d: G.d.slice() };
  for (const c of CHANNELS) R[c] = new Array(n);
  const sources = [];
  let tStart = 0;
  const picks = pickIdealCorners(laps, corners);
  corners.forEach((c, j) => {
    const best = picks[j];
    const L = getR(best.lap);
    for (let i = c.a; i <= c.b; i++) {
      for (const ch of CHANNELS) R[ch][i] = L[ch][i];
      R.t[i] = tStart + (L.t[i] - L.t[c.a]);
    }
    tStart += best.dt;
    sources.push({ corner: c.name, lapId: best.lap.id, timeMs: Math.round(best.dt) });
  });
  return { R, timeMs: Math.round(tStart), sources };
}
