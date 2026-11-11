import * as db from './db.js';
import { cornersOnGrid } from './track.js';
import * as trackdata from './trackdata.js';
import { resample, detectCorners, cornerMetrics, lapStats, deltaSeries, buildIdeal, gridStep, CHANNELS,
  lateralOffsets, turnSign, envelope } from './analysis.js';

const comboKey = (m) => `${m.track}|${m.layout}|${m.car}`;
export const parseCombo = (key) => { const [track, layout, car] = key.split('|'); return { track, layout, car }; };

// --- caches -------------------------------------------------------------
const resampleCache = new Map(); // lapId -> {R, meta}
const comboCache = new Map();    // comboKey -> {version, best, corners, ideal}
const modelCache = new Map();    // 'track|layout' -> track model data | null
let version = 0;
export const invalidate = () => { version++; comboCache.clear(); modelCache.clear(); };

// Shared track model (edges, centre line, corners, gates) for a track/layout, read from AC EVO's own
// track data (content.kspkg), or null when the game data has no such track (e.g. the mock track).
export function trackModel(track, layout) {
  const key = `${track}|${layout}`;
  if (!modelCache.has(key)) {
    let m = null;
    try { m = trackdata.model(track, layout); } catch (e) { console.error('[tracks]', e.message); }
    modelCache.set(key, m);
  }
  return modelCache.get(key);
}
function comboLength(meta) {
  // all laps of a combo share one grid; use the length of the best own lap (or the lap itself)
  const laps = db.lapsForCombo(meta.track, meta.layout, meta.car, false);
  const lens = laps.map((l) => l.track_length).filter((x) => x > 0).sort((a, b) => a - b);
  return lens.length ? lens[Math.floor(lens.length / 2)] : meta.track_length;
}

export function getResampled(id) {
  if (resampleCache.has(id)) return resampleCache.get(id);
  const lap = db.getLap(id);
  if (!lap) return null;
  const L = comboLength(lap);
  // scale distance if this lap's length slightly differs (e.g. imported lap)
  const scale = lap.track_length > 0 ? L / lap.track_length : 1;
  const data = scale !== 1 ? { ...lap.data, d: lap.data.d.map((d) => d * scale) } : lap.data;
  const R = resample(data, L, lap.lap_time_ms, gridStep(L));
  const { data: _, ...meta } = lap;
  const entry = { R, meta };
  resampleCache.set(id, entry);
  if (resampleCache.size > 300) resampleCache.delete(resampleCache.keys().next().value);
  return entry;
}

export function comboInfo(m) {
  const key = comboKey(m);
  const cached = comboCache.get(key);
  if (cached && cached.version === version) return cached;
  const own = db.lapsForCombo(m.track, m.layout, m.car, true).filter((l) => l.valid);
  const info = { version, key, best: null, corners: [], cornersSource: 'speed', ideal: null, validLaps: own.length };
  if (own.length) {
    info.best = own.reduce((a, b) => (b.lap_time_ms < a.lap_time_ms ? b : a));
    const bestR = getResampled(info.best.id).R;
    // corners: the shared track model (same T1..Tn in every car) when recorded, else from this car's best lap
    const model = trackModel(m.track, m.layout);
    if (model?.corners?.length) { info.corners = cornersOnGrid(model, bestR); info.cornersSource = 'track'; }
    else info.corners = detectCorners(bestR);
    const laps = own.map((l) => ({ id: l.id, R: getResampled(l.id).R }));
    info.ideal = buildIdeal(laps, info.corners);
  }
  comboCache.set(key, info);
  return info;
}

// Overview for the laps page: combos with best / ideal / lap counts.
export function overview() {
  const laps = db.listLaps();
  const combos = new Map();
  for (const l of laps) {
    const key = comboKey(l);
    if (!combos.has(key)) combos.set(key, { key, track: l.track, layout: l.layout, car: l.car, laps: 0, lastAt: l.recorded_at });
    combos.get(key).laps++;
  }
  const out = [];
  for (const c of combos.values()) {
    const info = comboInfo(c);
    out.push({ ...c, bestLapId: info.best?.id ?? null, bestMs: info.best?.lap_time_ms ?? null,
      idealMs: info.ideal?.timeMs ?? null, validLaps: info.validLaps, corners: info.corners.length });
  }
  return { combos: out, sessions: db.listSessions(), laps };
}

// Resolve a reference spec: 'best' | 'ideal' | lap id
export function resolveRef(spec, combo) {
  const info = comboInfo(combo);
  if (spec === 'ideal') {
    if (!info.ideal) return null;
    return { id: 'ideal', label: 'Ideal lap', lapTimeMs: info.ideal.timeMs, R: info.ideal.R, sources: info.ideal.sources, info };
  }
  const id = spec === 'best' || !spec ? info.best?.id : Number(spec);
  if (!id) return null;
  const e = getResampled(id);
  if (!e) return null;
  return { id, label: id === info.best?.id ? 'Best lap' : `Lap #${id}`, lapTimeMs: e.meta.lap_time_ms, R: e.R, meta: e.meta, info };
}

const round = (arr, p) => arr.map((v) => Math.round(v * p) / p);
function packTrace(R) {
  return { d: round(R.d, 10), t: round(R.t, 1), spd: round(R.spd, 10), thr: round(R.thr, 1000), brk: round(R.brk, 1000),
    str: round(R.str, 1000), gear: R.gear, rpm: round(R.rpm, 1), x: round(R.x, 100), z: round(R.z, 100),
    glat: round(R.glat, 100), glon: round(R.glon, 100) };
}

// Convert a signed (left +) offset into "+ = towards the outside of the corner" per corner segment.
function toWide(off, corners, turns) {
  const wide = new Array(off.length).fill(0);
  corners.forEach((c, k) => { for (let i = c.a; i <= c.b && i < off.length; i++) wide[i] = -turns[k] * off[i]; });
  return wide;
}

// Used-track-width band around a reference line, from all own valid laps of the combo (cached).
function trackBand(info, ref) {
  info.bands ??= new Map();
  if (info.bands.has(ref.id)) return info.bands.get(ref.id);
  const own = db.lapsForCombo(...info.key.split('|'), true).filter((l) => l.valid)
    .sort((a, b) => b.recorded_at - a.recorded_at).slice(0, 40);
  const offs = own.map((l) => getResampled(l.id)?.R).filter((R) => R && R.n === ref.R.n).map((R) => lateralOffsets(R, ref.R));
  const env = envelope(ref.R, offs);
  const band = { laps: offs.length, left: { x: round(env.left.x, 10), z: round(env.left.z, 10) }, right: { x: round(env.right.x, 10), z: round(env.right.z, 10) },
    source: { left: 'used', right: 'used' } };
  const [track, layout] = info.key.split('|');
  // real track edges from the game's track data replace the used-width band
  const model = trackModel(track, layout);
  if (model) Object.assign(band, { left: model.left, right: model.right, source: { left: 'track', right: 'track' } });
  info.bands.set(ref.id, band);
  return band;
}
// Full comparison payload for the browser.
export function compare(lapIds, refSpec) {
  const first = getResampled(lapIds[0]);
  if (!first) throw new Error('Lap not found');
  const combo = first.meta;
  const ref = resolveRef(refSpec, combo);
  if (!ref) throw new Error('No reference available (no valid laps for this track/car yet)');
  const corners = ref.info.corners;
  const turns = corners.map((c) => turnSign(ref.R, c.apexIdx));
  const refMetrics = corners.map((c) => cornerMetrics(ref.R, c, new Array(ref.R.n).fill(0)));
  const laps = lapIds.filter((id) => id !== ref.id).map((id) => {
    const e = getResampled(id);
    if (!e) return null;
    if (e.R.n !== ref.R.n) throw new Error('Laps are from different tracks/layouts');
    const offset = lateralOffsets(e.R, ref.R);
    const wide = toWide(offset, corners, turns);
    return {
      id, meta: e.meta, trace: packTrace(e.R), delta: deltaSeries(e.R, ref.R), stats: lapStats(e.R),
      offset: round(offset, 100), corners: corners.map((c) => cornerMetrics(e.R, c, wide)),
    };
  }).filter(Boolean);
  return {
    combo: { track: combo.track, layout: combo.layout, car: combo.car },
    ref: { id: ref.id, label: ref.label, lapTimeMs: ref.lapTimeMs, meta: ref.meta ?? null, sources: ref.sources ?? null,
      trace: packTrace(ref.R), stats: lapStats(ref.R), corners: refMetrics },
    corners: corners.map((c, k) => ({ n: c.n, name: c.name, apex: Math.round(ref.R.d[c.apexIdx]), start: Math.round(ref.R.d[c.a]), end: Math.round(ref.R.d[c.b]), turn: turns[k] })),
    band: trackBand(ref.info, ref), cornersSource: ref.info.cornersSource,
    bestMs: ref.info.best?.lap_time_ms ?? null, idealMs: ref.info.ideal?.timeMs ?? null,
    laps,
  };
}

// Per-lap corner metrics for many laps (consistency page). Baseline = best lap.
export function consistency(combo, session = 'all', includeInvalid = false) {
  const info = comboInfo(combo);
  if (!info.best) throw new Error('No valid laps for this track/car yet');
  const ref = getResampled(info.best.id).R;
  const corners = info.corners;
  const turns = corners.map((c) => turnSign(ref, c.apexIdx));
  const all = db.lapsForCombo(combo.track, combo.layout, combo.car, true).sort((a, b) => a.recorded_at - b.recorded_at);
  const laps = all.filter((l) => (includeInvalid || l.valid) && (session === 'all' || String(l.session_id) === String(session)))
    .map((l) => {
      const R = getResampled(l.id)?.R;
      if (!R || R.n !== ref.n) return null;
      const wide = toWide(lateralOffsets(R, ref), corners, turns);
      return { id: l.id, lapNumber: l.lap_number, sessionId: l.session_id, lapTimeMs: l.lap_time_ms, valid: !!l.valid,
        recordedAt: l.recorded_at, isBest: l.id === info.best.id, corners: corners.map((c) => cornerMetrics(R, c, wide)) };
    }).filter(Boolean);
  const sessionIds = new Set(all.map((l) => l.session_id));
  return {
    combo: { track: combo.track, layout: combo.layout, car: combo.car },
    bestId: info.best.id, bestMs: info.best.lap_time_ms, idealMs: info.ideal?.timeMs ?? null,
    corners: corners.map((c) => ({ n: c.n, name: c.name, apex: Math.round(ref.d[c.apexIdx]) })),
    sessions: db.listSessions().filter((s) => sessionIds.has(s.id)).map((s) => ({ id: s.id, startedAt: s.started_at, type: s.session_type })),
    laps,
  };
}

// Progress over time for one track + car: per driving day (local time) the day's best lap, the all-time
// best and the ideal lap as they stood at the end of that day, and how repeatable the day's laps were.
// "Clean" laps = valid laps within 7 % of the day's best (leaves out laps with a big mistake or traffic).
const CLEAN_WITHIN = 1.07;
export function progress(combo) {
  const info = comboInfo(combo);
  const all = db.lapsForCombo(combo.track, combo.layout, combo.car, true).sort((a, b) => a.recorded_at - b.recorded_at);
  const p2 = (n) => String(n).padStart(2, '0');
  const dayOf = (t) => { const d = new Date(t); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; };
  const byDay = new Map();
  for (const l of all) { const k = dayOf(l.recorded_at); if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(l); }
  const corners = info.corners;
  const refN = info.best ? getResampled(info.best.id).R.n : null;
  const cornerBest = corners.map(() => Infinity); // fastest pass of each corner so far (= the ideal lap's parts)
  let allTime = null;
  const days = [];
  for (const [day, laps] of byDay) {
    const valid = laps.filter((l) => l.valid);
    const best = valid.length ? valid.reduce((a, b) => (b.lap_time_ms < a.lap_time_ms ? b : a)) : null;
    const improved = !!best && (allTime == null || best.lap_time_ms < allTime);
    if (improved) allTime = best.lap_time_ms;
    for (const l of valid) {
      const R = getResampled(l.id)?.R;
      if (!R || R.n !== refN) continue;
      corners.forEach((c, k) => { const dt = R.t[c.b] - R.t[c.a]; if (dt < cornerBest[k]) cornerBest[k] = dt; });
    }
    const ideal = corners.length && cornerBest.every(Number.isFinite) ? Math.round(cornerBest.reduce((a, b) => a + b, 0)) : null;
    const clean = best ? valid.map((l) => l.lap_time_ms).filter((t) => t <= best.lap_time_ms * CLEAN_WITHIN).sort((a, b) => a - b) : [];
    const mean = clean.length ? clean.reduce((a, b) => a + b, 0) / clean.length : null;
    days.push({
      day, at: laps[0].recorded_at, laps: laps.length, validLaps: valid.length, sessions: new Set(laps.map((l) => l.session_id)).size,
      bestMs: best?.lap_time_ms ?? null, bestLapId: best?.id ?? null, newBest: improved, allTimeBestMs: allTime, idealMs: ideal,
      cleanLaps: clean.length, medianMs: clean.length ? clean[Math.floor((clean.length - 1) / 2)] : null,
      sdMs: clean.length >= 3 ? Math.round(Math.sqrt(clean.reduce((a, b) => a + (b - mean) ** 2, 0) / clean.length)) : null,
    });
  }
  return { combo: { track: combo.track, layout: combo.layout, car: combo.car }, bestMs: info.best?.lap_time_ms ?? null, bestLapId: info.best?.id ?? null,
    idealMs: info.ideal?.timeMs ?? null, laps: all.length, validLaps: all.filter((l) => l.valid).length, cleanWithinPct: Math.round((CLEAN_WITHIN - 1) * 100), days };
}

export { CHANNELS };
