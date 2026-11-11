// Track data straight from AC EVO's own files (content.kspkg, read in place): every track and layout,
// the game's map drawing, and per layout a track model shared by every car:
//   ideal (AI racing) line, left/right track edges, centre line, start/finish + sector gates, pit lane,
//   corners (from the track's geometry), widths, length.
//
// Files used (protobuf, field numbers as observed on game 0.9.1):
//   system\tracks.table            f2.f3[].f2 {f1 name, f3 folder, f5 country, f13 region, f2 country name}
//   system\track_containers.table  f2.f3[].f8 {f1 row name, f8 length m, f10 track name, f11[] containers, f14 layout name}
//   <folder>\layouts\<layout>.ideal_line.aisplinedata / .pitlane.aisplinedata
//       f1.f1[] points {f1 pos {x,y,z}}, f2[] per point {f2 radius m, f3 / f4 width to the two edges m}
//   <folder>\containers\timelines*.scene   entity f2.f50.f112.f1000.f1[] = gate quads {f1[] {f1 pos}}; the
//       start/finish gate is the LAST one
//   uiresources\images\trackmaps\<track>-<layout>.svg  the game's own map (viewBox 380 x 240)
// World coordinates are the same x/z the shared memory reports for the car (checked: a recorded
// Brands Hatch Indy lap lies a median 0.94 m from the ideal line).
import fs from 'node:fs';
import path from 'node:path';
import { Kspkg, findArchive } from './kspkg.js';
import { fields, sub, str, all, one, num, vec3, walk } from './pb.js';
import { gridStep } from './analysis.js';
import { detectCornersGeo } from './track.js';
import { DATA_DIR } from './db.js';
import * as settings from './settings.js';

const MODEL_VERSION = 4; // bump when the model format / algorithm changes (invalidates the disk cache)
const CACHE_DIR = path.join(DATA_DIR, 'trackcache');
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

let pkg = null, pkgError = null, catalogCache = null;
const models = new Map(); // key -> model | null

export function archive() {
  if (pkg) return pkg;
  const file = findArchive(settings.get().gamePath);
  if (!file) { pkgError = 'AC EVO content.kspkg not found (set the game folder in Settings)'; return null; }
  try { pkg = new Kspkg(file).load(); pkgError = null; } catch (e) { pkgError = e.message; pkg = null; }
  return pkg;
}

// forget the archive (e.g. the game folder setting changed)
export function reset() { pkg = null; pkgError = null; catalogCache = null; models.clear(); }

export function status() {
  const p = archive();
  return { ok: !!p, file: p?.file ?? null, error: pkgError };
}

// ---------------------------------------------------------------- catalogue
export function catalog() {
  const p = archive();
  if (!p) return [];
  if (catalogCache?.stamp === p.stamp) return catalogCache.tracks;
  const tracks = new Map(); // folder -> track
  const tbl = p.read('system\\tracks.table');
  for (const it of walk(tbl, [2, 3, 2])) {
    const fs_ = sub(tbl, it);
    const s = (f) => { const x = one(fs_, f); return x?.wt === 2 ? str(tbl, x) : ''; };
    const folder = s(3);
    if (!folder || /\\interns\\/i.test(folder)) continue;
    tracks.set(folder.toLowerCase(), { id: path.win32.basename(folder).toLowerCase(), name: s(1), folder, country: s(5), countryName: s(2), region: s(13), layouts: new Map() });
  }
  const byName = new Map([...tracks.values()].map((t) => [norm(t.name), t]));
  const ct = p.read('system\\track_containers.table');
  for (const it of walk(ct, [2, 3, 8])) {
    const r = sub(ct, it);
    const s = (f) => { const x = one(r, f); return x?.wt === 2 ? str(ct, x) : ''; };
    const t = byName.get(norm(s(10)));
    const layoutName = s(14);
    if (!t || !layoutName) continue;
    const containers = all(r, 11).map((x) => str(ct, x));
    if (containers.some((c) => /academy/i.test(c))) continue;
    const key = norm(layoutName);
    const L = t.layouts.get(key) || { name: layoutName, lengthM: 0, containers: new Set() };
    L.lengthM = Math.max(L.lengthM, num(r, 8, 0));
    for (const c of containers) L.containers.add(c);
    t.layouts.set(key, L);
  }
  const svgs = p.list('uiresources\\images\\trackmaps\\').filter((f) => f.endsWith('.svg'));
  const out = [];
  for (const t of tracks.values()) {
    const ideals = p.list(`${t.folder.toLowerCase()}\\layouts\\`).filter((f) => f.endsWith('.ideal_line.aisplinedata'));
    const layouts = [];
    for (const L of t.layouts.values()) {
      const cs = [...L.containers];
      const layoutScene = cs.map((c) => c.match(/\\containers\\(layout_[^\\]+|track_layout[^\\]*)\.scene$/i)?.[1]).find(Boolean);
      let ideal = layoutScene && ideals.find((f) => f.endsWith(`\\${layoutScene.toLowerCase()}.ideal_line.aisplinedata`));
      if (!ideal) ideal = ideals.find((f) => path.win32.basename(f).replace('.ideal_line.aisplinedata', '').replace(/^layout_/, '') === slug(L.name));
      if (!ideal && ideals.length === 1) ideal = ideals[0];
      if (!ideal) continue;
      const timelines = cs.find((c) => /\\timelines[^\\]*\.scene$/i.test(c)) || null;
      const base = (f) => slug(path.win32.basename(f, '.svg'));
      const svg = svgs.find((f) => base(f) === slug(`${t.name} ${L.name}`))
        || svgs.find((f) => base(f).startsWith(slug(t.name)) && base(f).includes(slug(L.name)))
        || null;
      layouts.push({ key: norm(L.name), name: L.name, lengthM: L.lengthM, ideal, pit: ideal.replace('.ideal_line.', '.pitlane.'), timelines, svg });
    }
    if (layouts.length) out.push({ id: t.id, name: t.name, country: t.country, countryName: t.countryName, region: t.region, layouts: layouts.sort((a, b) => b.lengthM - a.lengthM) });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  catalogCache = { stamp: p.stamp, tracks: out };
  return out;
}

// shared-memory names ("Brands Hatch", "Indy") -> catalogue entries
export function find(trackName, layoutName) {
  const t = catalog().find((x) => norm(x.name) === norm(trackName) || x.id === norm(trackName).replace(/ /g, '_'));
  if (!t) return null;
  const l = t.layouts.find((x) => x.key === norm(layoutName)) || (t.layouts.length === 1 ? t.layouts[0] : null);
  return l ? { track: t, layout: l } : null;
}

export function mapSvg(trackId, layoutKey) {
  const t = catalog().find((x) => x.id === trackId);
  const l = t?.layouts.find((x) => x.key === layoutKey);
  return l?.svg ? archive().read(l.svg) : null;
}

// ---------------------------------------------------------------- spline files
function readSpline(p, file) {
  const buf = p.read(file);
  if (!buf) return null;
  const top = fields(buf);
  const line = one(top, 1);
  const pts = [];
  for (const it of all(sub(buf, line), 1)) {
    const pos = one(sub(buf, it), 1);
    if (pos) { const [x, y, z] = vec3(buf, pos); pts.push({ x, y, z }); }
  }
  const info = all(top, 2).map((it) => { const f = sub(buf, it); return { radius: num(f, 2, 0), w3: num(f, 3, 0), w4: num(f, 4, 0) }; });
  return { pts, info: info.length === pts.length ? info : null };
}

function readGates(p, file) {
  const buf = file && p.read(file);
  if (!buf) return [];
  return walk(buf, [2, 50, 112, 1000, 1]).map((g) => {
    const corners = walk(buf, [1, 1], g.s, g.e).map((it) => vec3(buf, it));
    if (!corners.length) return null;
    return { x: corners.reduce((a, c) => a + c[0], 0) / corners.length, z: corners.reduce((a, c) => a + c[2], 0) / corners.length, corners };
  }).filter(Boolean);
}

// ---------------------------------------------------------------- model
const cacheFile = (stamp, trackId, layoutKey) => path.join(CACHE_DIR, `${trackId}__${slug(layoutKey)}__${stamp}__v${MODEL_VERSION}.json`);

export function model(trackName, layoutName) {
  const hit = find(trackName, layoutName);
  return hit ? modelById(hit.track.id, hit.layout.key) : null;
}

export function modelById(trackId, layoutKey) {
  const p = archive();
  if (!p) return null;
  const key = `${trackId}|${layoutKey}`;
  if (models.has(key)) return models.get(key);
  const t = catalog().find((x) => x.id === trackId);
  const l = t?.layouts.find((x) => x.key === layoutKey);
  let m = null;
  if (l) {
    const file = cacheFile(p.stamp, trackId, layoutKey);
    try { m = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* not cached */ }
    if (!m) {
      try {
        m = build(p, t, l);
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(m));
      } catch (e) { console.error(`[tracks] ${t.name} ${l.name}: ${e.message}`); m = null; }
    }
  }
  models.set(key, m);
  return m;
}

function build(p, t, l) {
  const sp = readSpline(p, l.ideal);
  if (!sp || sp.pts.length < 20) throw new Error('ideal line missing');
  const P = sp.pts, N = P.length;
  // cumulative distance along the closed ideal line
  const s = new Array(N + 1).fill(0);
  for (let i = 1; i <= N; i++) { const a = P[i - 1], b = P[i % N]; s[i] = s[i - 1] + Math.hypot(b.x - a.x, b.z - a.z); }
  const Lline = s[N];
  const project = (x, z) => {
    let best = Infinity, at = 0;
    for (let i = 0; i < N; i++) {
      const a = P[i], b = P[(i + 1) % N], dx = b.x - a.x, dz = b.z - a.z, L2 = dx * dx + dz * dz;
      const u = L2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / L2)) : 0;
      const d2 = (a.x + dx * u - x) ** 2 + (a.z + dz * u - z) ** 2;
      if (d2 < best) { best = d2; at = s[i] + u * (s[i + 1] - s[i]); }
    }
    return { s: at, dist: Math.sqrt(best) };
  };
  // start/finish = last timing gate; the other gates are sector lines
  const gates = readGates(p, l.timelines).map((g) => ({ ...g, ...project(g.x, g.z) })).filter((g) => g.dist < 60);
  const sf = gates.length ? gates[gates.length - 1] : null;
  const s0 = sf ? sf.s : 0;
  const L = Lline;
  const step = gridStep(L), n = Math.floor(L / step) + 1;
  // sample the line at distance d from the start/finish line
  const at = (d) => {
    let q = (((d + s0) % L) + L) % L;
    let lo = 0, hi = N;
    while (lo < hi - 1) { const m = (lo + hi) >> 1; if (s[m] <= q) lo = m; else hi = m; }
    const a = P[lo], b = P[(lo + 1) % N], u = s[lo + 1] > s[lo] ? (q - s[lo]) / (s[lo + 1] - s[lo]) : 0;
    const ia = sp.info?.[lo], ib = sp.info?.[(lo + 1) % N];
    const mix = (k) => (ia && ib ? ia[k] + (ib[k] - ia[k]) * u : 0);
    return { x: a.x + (b.x - a.x) * u, z: a.z + (b.z - a.z) * u, tx: b.x - a.x, tz: b.z - a.z, w3: mix('w3'), w4: mix('w4'), radius: mix('radius') };
  };
  const g = Array.from({ length: n }, (_, i) => at(Math.min(i * step, L)));
  // tangent (smoothed over a few metres) and the counter-clockwise normal in x/z
  const k = Math.max(1, Math.round(3 / step));
  const nx = new Array(n), nz = new Array(n), curv = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = g[Math.max(0, i - k)], b = g[Math.min(n - 1, i + k)];
    let tx = b.x - a.x, tz = b.z - a.z; const len = Math.hypot(tx, tz) || 1; tx /= len; tz /= len;
    nx[i] = -tz; nz[i] = tx;
  }
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 5 * k), b = Math.min(n - 1, i + 5 * k);
    const h1 = Math.atan2(-nx[a], nz[a]), h2 = Math.atan2(-nx[b], nz[b]);
    let d = h2 - h1; d = Math.atan2(Math.sin(d), Math.cos(d));
    curv[i] = d; // sign: + = turning counter-clockwise in x/z
  }
  // Which width belongs to which side: in tight corners the ideal line runs near the INSIDE edge, so
  // the smaller width is on the inside. Vote over all tight points.
  let vote = 0;
  if (sp.info) for (let i = 0; i < n; i++) if (g[i].radius > 0 && g[i].radius < 120 && Math.abs(curv[i]) > 0.05) vote += Math.sign(curv[i]) * Math.sign(g[i].w4 - g[i].w3);
  const w3IsCCW = vote >= 0; // inside of a CCW turn is the CCW side
  // some layouts carry no usable widths (e.g. Nurburgring Mullenbachschleife: ~0.2 m): fall back to a
  // nominal 10 m road centred on the ideal line, and say so
  const rawW = sp.info ? sp.info.map((q) => q.w3 + q.w4).sort((a, b) => a - b) : [];
  const widthKnown = rawW.length > 0 && rawW[rawW.length >> 1] >= 4;
  if (!widthKnown) for (const q of g) { q.w3 = 5; q.w4 = 5; }
  const left = { x: [], z: [] }, right = { x: [], z: [] }, centre = { x: [], z: [] }, ideal = { x: [], z: [] }, widths = [], radius = [];
  for (let i = 0; i < n; i++) {
    const q = g[i];
    const wc = w3IsCCW ? q.w3 : q.w4, wcw = w3IsCCW ? q.w4 : q.w3;
    const lx = q.x + nx[i] * wc, lz = q.z + nz[i] * wc, rx = q.x - nx[i] * wcw, rz = q.z - nz[i] * wcw;
    left.x.push(lx); left.z.push(lz); right.x.push(rx); right.z.push(rz);
    centre.x.push((lx + rx) / 2); centre.z.push((lz + rz) / 2);
    ideal.x.push(q.x); ideal.z.push(q.z);
    widths.push(wc + wcw); radius.push(q.radius);
  }
  const corners = detectCornersGeo(centre.x, centre.z, step).map((c) => {
    const a = Math.round(c.aD / step), b = Math.min(n - 1, Math.round(c.bD / step)), ap = Math.round(c.apexD / step);
    let minR = Infinity, sgn = 0;
    for (let i = Math.max(a, ap - Math.round(60 / step)); i <= Math.min(b, ap + Math.round(60 / step)); i++) { if (radius[i] > 0) minR = Math.min(minR, radius[i]); sgn += curv[i]; }
    // AC's world is left-handed (maps are drawn with x mirrored): a counter-clockwise turn in raw x/z
    // is a RIGHT turn for the driver
    return { ...c, minRadius: Number.isFinite(minR) ? Math.round(minR) : null, dir: sgn > 0 ? 'right' : 'left' };
  });
  let pit = null;
  try {
    const ps = readSpline(p, l.pit);
    if (ps?.pts.length) { const stepP = Math.max(1, Math.round(ps.pts.length / 400)); pit = { x: [], z: [] }; for (let i = 0; i < ps.pts.length; i += stepP) { pit.x.push(r2(ps.pts[i].x)); pit.z.push(r2(ps.pts[i].z)); } }
  } catch { /* no pit lane */ }
  const sorted = [...widths].sort((a, b) => a - b);
  const R = (o) => ({ x: o.x.map(r2), z: o.z.map(r2) });
  return {
    version: MODEL_VERSION, source: 'AC EVO track data', trackId: t.id, track: t.name, layout: l.name,
    L, step, n, officialLengthM: l.lengthM || null,
    left: R(left), right: R(right), centre: R(centre), ideal: R(ideal), pit,
    corners,
    sectors: gates.slice(0, -1).map((gt) => Math.round(((((gt.s - s0) % L) + L) % L))).sort((a, b) => a - b),
    startFinish: sf ? { x: r2(sf.x), z: r2(sf.z), offLine: r2(sf.dist) } : null,
    width: { min: r1(sorted[0]), median: r1(sorted[sorted.length >> 1]), max: r1(sorted[sorted.length - 1]), known: widthKnown },
    sideVote: vote,
  };
}
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;
