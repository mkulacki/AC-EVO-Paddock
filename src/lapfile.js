// Lap files (.lap.gz, format "acevo-trainer-lap" version 1; the name stays for compatibility, see CLAUDE.md):
// export and a checked import (PL1.2). An import is read within fixed limits (compressed and unpacked size, sample
// and channel counts), every field is checked for type and range, and only a clean copy is stored. Errors are plain
// messages with an HTTP code (400 bad file, 409 already there, 413 too big). No imports from the app.
import zlib from 'node:zlib';

export const FORMAT = 'acevo-trainer-lap';
export const VERSION = 1;
export const LIMITS = {
  fileBytes: 16 * 1024 ** 2, // the .lap.gz as uploaded (a real lap is well under 2 MB)
  jsonBytes: 64 * 1024 ** 2, // unpacked (an 8-minute lap at 60 Hz is about 10 MB)
  samples: 250000, // 60 Hz for over an hour
  minSamples: 20,
  channels: 64,
  lapTimeMs: 4 * 3600e3,
  trackLength: 100000, // metres
  text: 200,
};
const err = (msg, code = 400) => Object.assign(new Error(msg), { code });

/** gunzip with a cap on the output (a small file can unpack to gigabytes). Throws code 413 over the cap. */
export function gunzipLimited(buf, max) {
  try { return zlib.gunzipSync(buf, { maxOutputLength: max }); } catch (e) {
    if (e.code === 'ERR_BUFFER_TOO_LARGE' || e instanceof RangeError) throw err(`The file unpacks to more than ${Math.round(max / 1048576)} MB`, 413);
    throw err('The file is damaged (it cannot be unpacked)');
  }
}

// main channels recorded per sample (src/recorder.js CH), with the range a real value can have; t and d are required
const RANGE = {
  t: [-60e3, LIMITS.lapTimeMs + 60e3], d: [-1e6, 1e6], spd: [-500, 1000], thr: [-0.1, 1.1], brk: [-0.1, 1.1], str: [-1000, 1000],
  gear: [-2, 20], rpm: [-1000, 100000], x: [-1e6, 1e6], z: [-1e6, 1e6], glat: [-100, 100], glon: [-100, 100],
  out: [0, 10], ok: [0, 1], kerb: [-10, 10],
  w0x: [-1e6, 1e6], w0z: [-1e6, 1e6], w1x: [-1e6, 1e6], w1z: [-1e6, 1e6], w2x: [-1e6, 1e6], w2z: [-1e6, 1e6], w3x: [-1e6, 1e6], w3z: [-1e6, 1e6],
};
const OTHER = [-1e9, 1e9]; // a channel this Paddock does not know (a newer one may add some): numbers, same length
const WCH = ['i', 'm', 'o', 'c', 'p', 'b', 'nP', 'nC', 'nB', 's', 'a', 'r', 'l']; // car data per wheel (src/recorder.js)
const BACKWARD_MS = 1000; // the lap clock never runs back; a value up to 1 s below the latest one is tolerated (frame timing)

function numArray(a, name, len, [lo, hi]) {
  if (!Array.isArray(a)) throw err(`Channel "${name}" is not a list of numbers`);
  if (len != null && a.length !== len) throw err(`Channel "${name}" has ${a.length} values, expected ${len} (one per sample)`);
  for (let i = 0; i < a.length; i++) {
    const v = a[i];
    if (typeof v !== 'number' || !Number.isFinite(v)) throw err(`Channel "${name}" has a value that is not a number (sample ${i + 1})`);
    if (v < lo || v > hi) throw err(`Channel "${name}" has a value out of range (${v} at sample ${i + 1})`);
  }
  return a;
}
const text = (v, name, { required = true, dflt = '' } = {}) => {
  if (v == null || v === '') { if (required && v == null) throw err(`The lap's ${name} is missing`); return v === '' ? '' : dflt; }
  if (typeof v !== 'string') throw err(`The lap's ${name} is not text`);
  if (v.length > LIMITS.text) throw err(`The lap's ${name} is too long`);
  return v;
};
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** data.car (10 Hz tyre/brake/suspension data, optional): checked against the main samples. */
function checkCar(car, n) {
  if (!isObj(car)) throw err('The car data in this lap is damaged');
  const k = numArray(car.k, 'car.k', null, [0, n - 1]);
  for (let i = 0; i < k.length; i++) if (!Number.isInteger(k[i]) || (i && k[i] < k[i - 1])) throw err('The car data in this lap is damaged (sample order)');
  const m = k.length;
  if (!Array.isArray(car.w) || car.w.length !== 4 || !car.w.every(isObj)) throw err('The car data in this lap is damaged (wheels)');
  const out = { k, rh0: numArray(car.rh0, 'car.rh0', m, OTHER), rh1: numArray(car.rh1, 'car.rh1', m, OTHER), w: [] };
  for (const w of car.w) {
    const o = {};
    for (const c of WCH) if (w[c] !== undefined) o[c] = numArray(w[c], `car.w.${c}`, m, OTHER);
    out.w.push(o);
  }
  return out;
}

/**
 * Reads an uploaded lap file (gzip or plain JSON). -> {lap: fields for db.insertLap (no sessionId/source), recordedAtGiven}
 * Throws {code, message}.
 */
export function parseLapFile(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) throw err('The file is empty');
  if (buf.length > LIMITS.fileBytes) throw err(`The file is too big (over ${LIMITS.fileBytes / 1048576} MB)`, 413);
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipLimited(buf, LIMITS.jsonBytes);
  else if (buf.length > LIMITS.jsonBytes) throw err('The file is too big', 413);
  let obj;
  try { obj = JSON.parse(buf.toString('utf8').replace(/^﻿/, '')); } catch { throw err('Not a Paddock lap file (it is not readable JSON)'); }
  if (!isObj(obj) || obj.format !== FORMAT) throw err('Not a Paddock lap file (.lap.gz exported from Paddock)');
  if (obj.version !== undefined && obj.version !== VERSION) {
    throw err(typeof obj.version === 'number' && obj.version > VERSION ? 'This lap file was made by a newer Paddock: update Paddock first' : 'Unsupported lap file version');
  }
  const mt = obj.meta, data = obj.data;
  if (!isObj(mt)) throw err('The lap file has no lap details (meta)');
  if (!isObj(data)) throw err('The lap file has no telemetry (data)');

  // the lap's details
  const track = text(mt.track, 'track'), layout = text(mt.layout, 'layout'), car = text(mt.car, 'car');
  if (!track || !car) throw err('The lap file does not say which track and car');
  const lapTimeMs = mt.lap_time_ms;
  if (typeof lapTimeMs !== 'number' || !(lapTimeMs > 0 && lapTimeMs <= LIMITS.lapTimeMs)) throw err('The lap time in this file is missing or out of range');
  const trackLength = mt.track_length;
  if (typeof trackLength !== 'number' || !(trackLength > 0 && trackLength <= LIMITS.trackLength)) throw err('The track length in this file is missing or out of range');
  const lapNumber = mt.lap_number;
  if (!Number.isInteger(lapNumber) || lapNumber < 0 || lapNumber > 1e6) throw err('The lap number in this file is missing or out of range');
  const driver = text(mt.driver, 'driver name', { required: false, dflt: '' }) || 'Imported';
  const ra = mt.recorded_at;
  const recordedAtGiven = typeof ra === 'number' && Number.isFinite(ra) && ra > 0 && ra < Date.now() + 86400e3;

  // the samples: every channel one value per sample, numbers in range
  if (!Array.isArray(data.t)) throw err('The lap file has no timing channel (t)');
  const n = data.t.length;
  if (n < LIMITS.minSamples) throw err(`The lap has too few samples (${n})`);
  if (n > LIMITS.samples) throw err(`The lap has too many samples (${n}, at most ${LIMITS.samples})`, 413);
  const keys = Object.keys(data);
  if (keys.length > LIMITS.channels) throw err(`The lap has too many channels (${keys.length})`, 413);
  if (!Array.isArray(data.d)) throw err('The lap file has no distance channel (d)');
  const clean = {};
  for (const c of keys) {
    if (c === 'car') continue;
    if (!RANGE[c] && !Array.isArray(data[c])) continue; // something that is not a channel: not stored
    clean[c] = numArray(data[c], c, n, RANGE[c] || OTHER);
  }
  for (let i = 1, top = clean.t[0]; i < n; i++) {
    if (clean.t[i] < top - BACKWARD_MS) throw err(`The lap's timing goes backwards (sample ${i + 1})`);
    top = Math.max(top, clean.t[i]);
  }
  if (clean.t[n - 1] - clean.t[0] > lapTimeMs + 60e3) throw err('The samples cover much more time than the lap time');
  if (data.car !== undefined && data.car !== null) clean.car = checkCar(data.car, n);

  return {
    lap: { track, layout, car, lapNumber, lapTimeMs, valid: mt.valid === true || mt.valid === 1, driver,
      recordedAt: recordedAtGiven ? ra : Date.now(), trackLength, data: clean },
    recordedAtGiven,
  };
}

/**
 * A lap (db.getLap) as an export file (gzipped JSON). Left out (decision OD-PL-2): the leaderboard data (`board`: Steam
 * id, server, rank; for downloaded laps the other driver's id), and the local ids.
 */
export function exportLapFile(lap) {
  const { data, id, session_id, board, ...meta } = lap;
  return zlib.gzipSync(JSON.stringify({ format: FORMAT, version: VERSION, meta, data }));
}
