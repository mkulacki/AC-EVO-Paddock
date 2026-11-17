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

// ---------------------------------------------------------------- home dashboard
// Everything the home page shows, from the stored laps and session reports only: totals, recent sessions, personal
// records per track + car, the best lap per driving day for the most driven combos, and the open practice targets.
// No number is made up: a value that does not exist (no report, no valid lap) is null and the page says so.
const DAY_MS = 86400e3;
const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
export function dashboard({ now = Date.now(), recent = 5, trends = 3, trendDays = 20 } = {}) {
  const laps = db.listLaps().filter((l) => l.source === 'local');
  const valid = laps.filter((l) => l.valid);
  const bySession = new Map();
  for (const l of laps) if (l.session_id != null) { if (!bySession.has(l.session_id)) bySession.set(l.session_id, []); bySession.get(l.session_id).push(l); }
  const reports = new Map(db.listReports().map((r) => [r.sessionId, r.data]));

  const totals = {
    laps: laps.length, validLaps: valid.length, sessions: bySession.size,
    combos: new Set(laps.map(comboKey)).size, days: new Set(laps.map((l) => dayKey(l.recorded_at))).size,
    drivingMs: laps.reduce((a, l) => a + (l.lap_time_ms || 0), 0),
    last7: laps.filter((l) => now - l.recorded_at < 7 * DAY_MS).length, last30: laps.filter((l) => now - l.recorded_at < 30 * DAY_MS).length,
    lastAt: laps.length ? Math.max(...laps.map((l) => l.recorded_at)) : null,
  };

  // personal records: per track + car, the best valid lap and the ideal lap (best corners stitched together)
  const combos = new Map();
  for (const l of laps) {
    const k = comboKey(l);
    if (!combos.has(k)) combos.set(k, { key: k, track: l.track, layout: l.layout, car: l.car, laps: 0, validLaps: 0, lastAt: 0, best: null });
    const c = combos.get(k);
    c.laps++; c.lastAt = Math.max(c.lastAt, l.recorded_at);
    if (l.valid) { c.validLaps++; if (!c.best || l.lap_time_ms < c.best.lap_time_ms) c.best = l; }
  }
  const records = [...combos.values()].sort((a, b) => b.lastAt - a.lastAt).map((c) => {
    let idealMs = null;
    try { idealMs = c.best ? comboInfo(c).ideal?.timeMs ?? null : null; } catch { /* lap data unreadable: no ideal */ }
    return { key: c.key, track: c.track, layout: c.layout, car: c.car, laps: c.laps, validLaps: c.validLaps, lastAt: c.lastAt,
      bestMs: c.best?.lap_time_ms ?? null, bestLapId: c.best?.id ?? null, bestAt: c.best?.recorded_at ?? null, idealMs };
  });

  // recent sessions: the report's summary when there is one, else what the laps say
  const sessions = db.listSessions().filter((s) => bySession.has(s.id)).sort((a, b) => b.started_at - a.started_at).slice(0, recent).map((s) => {
    const ls = bySession.get(s.id), r = reports.get(s.id);
    const v = ls.filter((l) => l.valid);
    return { id: s.id, track: s.track, layout: s.layout, car: s.car, startedAt: s.started_at, laps: ls.length, validLaps: v.length,
      bestMs: v.length ? Math.min(...v.map((l) => l.lap_time_ms)) : null, report: r ? {
        avgCleanMs: r.average?.cleanMs ?? null, consistency: r.consistency?.score ?? null, newPb: !!r.improvement?.newPb,
        bestDeltaMs: r.improvement?.bestDeltaMs ?? null, weakest: (r.corners?.weakest || []).map((w) => w.name).slice(0, 3) } : null };
  });

  // trends: the most driven combos of the last 60 days (else of all time), best lap per driving day
  const since = now - 60 * DAY_MS;
  const busy = [...combos.values()].map((c) => ({ c, n: laps.filter((l) => comboKey(l) === c.key && l.recorded_at >= since).length }))
    .sort((a, b) => b.n - a.n || b.c.laps - a.c.laps).filter((x) => x.c.validLaps > 0).slice(0, trends);
  const trendList = busy.map(({ c }) => {
    const p = progress(c);
    const days = p.days.filter((d) => d.bestMs != null).slice(-trendDays).map((d) => ({ day: d.day, bestMs: d.bestMs, newBest: d.newBest, laps: d.laps }));
    return { key: c.key, track: c.track, layout: c.layout, car: c.car, bestMs: p.bestMs, idealMs: p.idealMs, days };
  });

  // open practice targets: the newest report per combo, for the 3 most recently driven combos; a report has no
  // check of its own targets yet (the next session's report checks them)
  const latestReport = new Map();
  for (const [sid, r] of reports) {
    const k = comboKey(r.combo || {});
    const at = r.startedAt ?? 0;
    if (!latestReport.has(k) || latestReport.get(k).at < at) latestReport.set(k, { sid, at, r });
  }
  const targets = [...latestReport.values()].sort((a, b) => b.at - a.at).slice(0, 3)
    .filter((x) => Array.isArray(x.r.targets) && x.r.targets.length)
    .map((x) => ({ sessionId: x.sid, startedAt: x.at, track: x.r.combo.track, layout: x.r.combo.layout, car: x.r.combo.car,
      targets: x.r.targets.map((t) => ({ kind: t.kind, text: t.text })),
      lastCheck: x.r.prevTargets?.items?.length ? { met: x.r.prevTargets.items.filter((t) => t.met === true).length, of: x.r.prevTargets.items.length } : null }));

  return { generatedAt: now, totals, recentSessions: sessions, records, trends: trendList, targets };
}

export { CHANNELS };
