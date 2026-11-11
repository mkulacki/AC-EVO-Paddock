// Track geometry helpers: corners from a line's curvature (geometry, not any car's speed, so T1..Tn are
// the same in every car), and mapping a track model's corners onto a lap's distance grid.
// The track models themselves come from AC EVO's own files (src/trackdata.js).

function smoothCircular(arr, w) {
  if (w < 1) return arr.slice();
  const n = arr.length, out = new Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let k = -w; k <= w; k++) s += arr[((i + k) % n + n) % n]; out[i] = s / (2 * w + 1); }
  return out;
}
// ---------------------------------------------------------------- corners from geometry
export function detectCornersGeo(cx, cz, step) {
  const n = cx.length;
  const k = Math.max(1, Math.round(5 / step));
  const head = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = (i - k + n) % n, b = (i + k) % n;
    head[i] = Math.atan2(cz[b] - cz[a], cx[b] - cx[a]);
  }
  let curv = new Array(n);
  for (let i = 0; i < n; i++) {
    let d = head[(i + 1) % n] - head[i];
    d = Math.atan2(Math.sin(d), Math.cos(d));
    curv[i] = d / step; // rad per metre
  }
  curv = smoothCircular(curv, Math.round(15 / step));
  const THR = 1 / 250; // radius < 250 m
  // contiguous regions over the threshold (same sign)
  let regions = [];
  let cur = null;
  for (let i = 0; i < n; i++) {
    const sgn = Math.abs(curv[i]) > THR ? Math.sign(curv[i]) : 0;
    if (sgn && cur && cur.sign === sgn) cur.e = i;
    else { if (cur) regions.push(cur); cur = sgn ? { s: i, e: i, sign: sgn } : null; }
  }
  if (cur) regions.push(cur);
  // merge same-direction regions separated by < 40 m (one long corner with a slight easing)
  const merged = [];
  for (const r of regions) {
    const p = merged[merged.length - 1];
    if (p && p.sign === r.sign && (r.s - p.e) * step < 40) p.e = r.e; else merged.push({ ...r });
  }
  regions = merged.filter((r) => {
    let turn = 0; for (let i = r.s; i <= r.e; i++) turn += Math.abs(curv[i]) * step;
    r.turnDeg = (turn * 180) / Math.PI;
    return r.turnDeg >= 15;
  });
  if (!regions.length) return [];
  for (const r of regions) { let m = r.s; for (let i = r.s; i <= r.e; i++) if (Math.abs(curv[i]) > Math.abs(curv[m])) m = i; r.apex = m; }
  // contiguous segments: boundary on the straight between two corners, nearer the previous exit
  // so the following braking zone belongs to the next corner
  const bounds = [0];
  for (let j = 0; j + 1 < regions.length; j++) {
    const straight = (regions[j + 1].s - regions[j].e) * step;
    const off = Math.min(0.4 * straight, Math.max(50, straight - 250));
    bounds.push(Math.min(regions[j + 1].s, regions[j].e + Math.round(Math.max(0, off) / step)));
  }
  bounds.push(n - 1);
  return regions.map((r, j) => ({
    n: j + 1, name: `T${j + 1}`, apexD: r.apex * step, aD: bounds[j] * step, bD: bounds[j + 1] * step,
    turnDeg: Math.round(r.turnDeg),
  }));
}

// Model corners -> corner objects on a lap's resampled grid (same shape as analysis.detectCorners).
export function cornersOnGrid(model, R) {
  const scale = R.L / model.L, last = R.n - 1;
  const idx = (d) => Math.max(0, Math.min(last, Math.round((d * scale) / R.step)));
  return model.corners.map((c, j) => {
    const a = j === 0 ? 0 : idx(c.aD), b = j === model.corners.length - 1 ? last : idx(c.bD);
    return { n: c.n, name: c.name, apexIdx: Math.max(a, Math.min(b, idx(c.apexD))), a, b };
  });
}

