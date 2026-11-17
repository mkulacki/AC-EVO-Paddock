// Which setup is the car on? AC EVO does not say (not in shared memory, not in its log), so Paddock takes a
// fingerprint of the car while it stands still in the pits (or at the start of a session): tyre pressures,
// camber, brake bias and fuel, read from shared memory (src/shm.js, frame.probe). The fingerprint is matched
// against the saved .carsetup files of this car and track; the closest one within tolerance is the setup.
// No match = "Standard". The match is stored with every lap (recorder getSetup) together with a copy of the
// setup's values, so editing the file later does not rewrite history.
// Also collects the session's conditions (air / track temperature, the Race tab's weather) for the report.
import crypto from 'node:crypto';
import fs from 'node:fs';
import * as db from './db.js';
import * as setups from './setups.js';
import * as cs from './carsetup.js';
import * as carsDb from './cars.js';
import * as trackdata from './trackdata.js';
import { STATUS } from './shm.js';

export const STANDARD = 'Standard';
// how far a reading may be from the file's value and still count as the same (squared distance <= 1 on average)
const TOL = { pressure: 0.8, camber: 0.3, bias: 1.0, fuel: 2.0 };
const CORNERS = ['FL', 'FR', 'RL', 'RR'];
const MIN_FRAMES = 20;     // ~1/3 s of standing still before a fingerprint is taken
const RECHECK_MS = 2000;   // while standing in the pits: look again this often (a setup loaded in the pit box)

const median = (a) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN; };
const sane = (v, lo, hi) => (Number.isFinite(v) && v >= lo && v <= hi ? v : null);

/** A fingerprint from the frames' probe values: {pressure: [4], camber: [4], bias, fuel}; null where the reading is not plausible. */
function fingerprint(frames) {
  const col = (fn) => median(frames.map(fn));
  const bias = col((f) => f.probe.brakeBias);
  return {
    pressure: CORNERS.map((_, w) => sane(col((f) => f.probe.pressures[w]), 5, 70)),
    camber: CORNERS.map((_, w) => sane(col((f) => f.probe.camber[w]), -10, 5)),
    // shared memory may give the bias as 0..1 or in %
    bias: sane(bias <= 1 ? bias * 100 : bias, 20, 90),
    fuel: sane(col((f) => f.fuel), 0, 300),
  };
}

// a setup file's values as {name: shown value}, cached by file + change time
const valueCache = new Map();
function fileValues(f) {
  const key = `${f.file}|${f.mtime}`;
  if (valueCache.has(key)) return valueCache.get(key);
  let out = null;
  try {
    const r = cs.read(fs.readFileSync(f.file), f.carId);
    if (r.values) { out = {}; for (const v of r.values) if (!v.list) out[v.name] = Math.round(v.value * v.scale * 1e4) / 1e4; }
  } catch { /* unreadable file: not a candidate */ }
  valueCache.set(key, out);
  return out;
}

/** The current values of a saved setup file by its rel path ({name: shown value}), or null (gone or unreadable). */
export function valuesOfRel(rel) {
  const f = rel ? setups.scan().find((x) => x.rel === rel) : null;
  return f ? fileValues(f) : null;
}

/** The saved setups of a car (game car name) on a track (game track / layout names): [{file, values}] */
export function candidates(car, track, layout) {
  const carId = carsDb.match(car)?.id;
  const trackId = trackdata.find(track, layout)?.track.id;
  if (!carId || !trackId) return [];
  return setups.scan().filter((f) => f.carId === carId && f.trackId === trackId)
    .map((f) => ({ file: f, values: fileValues(f) })).filter((c) => c.values);
}

/** Squared, tolerance-scaled distance between a fingerprint and a setup's values; parts = per feature, for the check panel. */
function distance(fp, values, useBias, useFuel) {
  const parts = [];
  CORNERS.forEach((c, w) => {
    if (fp.pressure[w] != null && values[`pressure_${c}`] != null) parts.push({ k: `pressure_${c}`, you: fp.pressure[w], file: values[`pressure_${c}`], tol: TOL.pressure });
    if (fp.camber[w] != null && values[`camber_${c}`] != null) parts.push({ k: `camber_${c}`, you: fp.camber[w], file: values[`camber_${c}`], tol: TOL.camber });
  });
  if (useBias && fp.bias != null && values.brakesfront_bias != null) parts.push({ k: 'brake_bias', you: fp.bias, file: values.brakesfront_bias, tol: TOL.bias });
  if (useFuel && fp.fuel != null && values.fuel != null) parts.push({ k: 'fuel', you: fp.fuel, file: values.fuel, tol: TOL.fuel });
  if (!parts.length) return { d: Infinity, parts };
  const d = parts.reduce((a, p) => a + ((p.you - p.file) / p.tol) ** 2, 0) / parts.length;
  return { d, parts };
}

/**
 * Match a fingerprint to the candidate setups. useFuel: only right after the session starts (later the tank is
 * not what the setup says). -> {name, rel, id, match: 'matched'|'standard'|'guess', snap, alsoMatches, probe, scores}
 */
export function match(fp, cands, { useFuel = false } = {}) {
  const usable = fp && (fp.pressure.some((v) => v != null) || fp.camber.some((v) => v != null));
  if (!usable) {
    // the readings make no sense (shared memory layout not as expected): best guess = the newest saved setup
    const newest = cands.slice().sort((a, b) => b.file.mtime - a.file.mtime)[0];
    return newest ? pick(newest, 'guess', fp, []) : { name: STANDARD, rel: null, id: null, match: 'standard', snap: null, probe: fp, scores: [] };
  }
  // brake bias may be reported with a car-specific offset: use it only if some setup is close to it
  const useBias = fp.bias != null && cands.some((c) => c.values.brakesfront_bias != null && Math.abs(c.values.brakesfront_bias - fp.bias) <= 5 * TOL.bias);
  const scored = cands.map((c) => ({ c, ...distance(fp, c.values, useBias, useFuel) })).sort((a, b) => a.d - b.d || b.c.file.mtime - a.c.file.mtime);
  const scores = scored.map((s) => ({ name: s.c.file.name, d: Math.round(s.d * 100) / 100, parts: s.parts }));
  const ok = scored.filter((s) => s.d <= 1);
  if (!ok.length) return { name: STANDARD, rel: null, id: null, match: 'standard', snap: null, probe: fp, scores };
  // equal fingerprints (files that differ only in things the fingerprint cannot see): the newest one, the others named
  const same = ok.filter((s) => s.d - ok[0].d < 0.05);
  return pick(same[0].c, 'matched', fp, scores, same.slice(1).map((s) => s.c.file.name));
}
function pick(c, how, fp, scores, alsoMatches = []) {
  const snap = crypto.createHash('sha1').update(JSON.stringify(c.values)).digest('hex').slice(0, 16);
  db.saveSnapshot(snap, { name: c.file.name, rel: c.file.rel, values: c.values });
  return { name: c.file.name, rel: c.file.rel, id: c.file.id, match: how, snap, alsoMatches, probe: fp, scores };
}

/** A setup the driver picked in the report (rel of a saved file, or null = Standard). */
export function manual(rel) {
  if (!rel) return { name: STANDARD, rel: null, id: null, match: 'manual', snap: null };
  const f = setups.scan().find((x) => x.rel === rel);
  if (!f) throw new Error('Setup not found');
  const values = fileValues(f);
  return values ? { ...pick({ file: f, values }, 'manual', null, []), probe: null, scores: undefined } : { name: f.name, rel: f.rel, id: f.id, match: 'manual', snap: null };
}

// ---------------------------------------------------------------- live tracking (one per app)
export function createSetupTracker({ recorder, launchConditions = () => null }) {
  let key = null, current = null, frames = [], lastCheck = 0, lastFp = null, firstDone = false;
  let cond = null, live = null; // live = the latest fingerprint and its scores, for the check panel

  const reset = (s) => {
    key = s?.key ?? null; current = null; frames = []; lastCheck = 0; lastFp = null; firstDone = false;
    cond = s ? { air: null, road: null, launch: launchConditions() } : null;
  };
  const addTemp = (slot, v) => {
    if (!Number.isFinite(v) || v < -40 || v > 90) return;
    const t = cond[slot] ||= { min: v, max: v, sum: 0, n: 0 };
    t.min = Math.min(t.min, v); t.max = Math.max(t.max, v); t.sum += v; t.n++;
  };

  function decide(f) {
    const fp = fingerprint(frames);
    const s = recorder.session;
    const cands = candidates(s.car, s.track, s.layout);
    const m = match(fp, cands, { useFuel: !firstDone });
    live = { at: Date.now(), car: s.car, track: s.track, layout: s.layout, fingerprint: fp, result: m, candidates: cands.length };
    lastCheck = Date.now();
    if (!current) { current = m; firstDone = true; lastFp = fp; log(m); return; }
    if (m.rel === current.rel) { lastFp = fp; return; }
    // hot tyres in a pit stop read higher than the setup: without a saved match, only call it a new setup if
    // something the heat does not change (camber, bias) moved
    if (m.match !== 'matched') {
      const moved = lastFp && (fp.camber.some((v, w) => v != null && lastFp.camber[w] != null && Math.abs(v - lastFp.camber[w]) > TOL.camber)
        || (fp.bias != null && lastFp.bias != null && Math.abs(fp.bias - lastFp.bias) > TOL.bias));
      if (!moved) return;
    }
    current = m; lastFp = fp; log(m);
    void f;
  }
  const log = (m) => console.log(`[setup] ${m.name} (${m.match}${m.alsoMatches?.length ? `, same as ${m.alsoMatches.join(', ')}` : ''})`);

  return {
    onFrame(f) {
      const s = recorder.session;
      if (!s || !f || f.status !== STATUS.LIVE) { if (!s) reset(null); return; }
      if (s.key !== key) reset(s);
      if (f.probe) { addTemp('air', f.probe.airTemp); addTemp('road', f.probe.roadTemp); }
      if (!f.probe) return;
      // standing still in the pits, or the very start of the session (a hotlap may start rolling)
      const still = f.speed < 1 && f.inPit;
      const start = !firstDone;
      if (!still && !start) { frames = []; return; }
      frames.push(f);
      if (frames.length > 120) frames.shift();
      if (start && frames.length >= (f.speed < 1 ? MIN_FRAMES : 3)) decide(f);
      else if (still && frames.length >= MIN_FRAMES && Date.now() - lastCheck > RECHECK_MS) decide(f);
    },
    /** for the recorder: the setup right now (null until the first fingerprint) */
    current: () => current,
    /** the session's conditions so far: {airC: {min, max, avg}, roadC, launch} */
    conditions() {
      if (!cond) return null;
      const t = (x) => (x ? { min: Math.round(x.min * 10) / 10, max: Math.round(x.max * 10) / 10, avg: Math.round((x.sum / x.n) * 10) / 10 } : null);
      return { airC: t(cond.air), roadC: t(cond.road), launch: cond.launch };
    },
    /** the latest fingerprint and how it compared with each saved setup (Setups tab check panel) */
    live: () => live,
  };
}
