// Setups tab: the library IS the game's own setup files:
//   <Saved Games>\ACE\Car Setups\<car name>\<track name>\<setup name>.carsetup
// Setups are loaded and saved in the game (its own setup screen); Paddock reads and edits the files (src/carsetup.js),
// adds notes, sharing (the .carsetup file itself, usable without Paddock) and the AI setup engineer.
// Paddock never talks to the game about setups: edits are written as files, which the game reads when it lists or
// loads setups. Every write goes through a temp file + rename, so the game never sees a half-written file.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as db from './db.js';
import * as cs from './carsetup.js';
import * as carsDb from './cars.js';
import * as trackdata from './trackdata.js';
import { ACE } from './gamebridge.js';

export const ROOT = path.join(ACE, 'Car Setups');
const EXT = '.carsetup';
const META_FILE = path.join(db.DATA_DIR, 'setup-meta.json');

// ---------------------------------------------------------------- Paddock's notes per file (data/setup-meta.json)
const readJson = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; } };
let meta = readJson(META_FILE, { files: {} });
if (!meta.files) meta = { files: {} };
let metaT = null;
const saveMeta = () => { clearTimeout(metaT); metaT = setTimeout(() => { try { fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 1)); } catch (e) { console.log(`[setup] notes not saved: ${e.message}`); } }, 300); };
const metaFor = (rel) => (meta.files[rel] ||= {});

// ---------------------------------------------------------------- the files
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const idOf = (rel) => crypto.createHash('sha1').update(rel.toLowerCase()).digest('hex').slice(0, 12);
const relOf = (car, track, name) => `${car}/${track}/${name}${EXT}`;
const SAFE = (s) => String(s ?? '').replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 80);

export const filePreset = cs.presetOf;
function carOfFile(carFolder, preset) {
  const cat = carsDb.catalog();
  if (preset) {
    const byId = cat.filter((c) => preset === c.id || preset.startsWith(`${c.id}_`)).sort((a, b) => b.id.length - a.id.length)[0];
    if (byId) return byId;
  }
  return cat.find((c) => norm(`${c.brand} ${c.name}`) === norm(carFolder)) || carsDb.match(carFolder) || null;
}
const trackOfFolder = (folder) => trackdata.catalog().find((t) => norm(t.name) === norm(folder)) || null;

let scanCache = { at: 0, files: [] };
/** Every .carsetup file: [{id, rel, file, carFolder, trackFolder, name, carId, carName, trackId, size, mtime}] */
export function scan(force = false) {
  if (!force && Date.now() - scanCache.at < 1500) return scanCache.files;
  const out = [];
  const presetCache = new Map();
  let cars = [];
  try { cars = fs.readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { /* no setups saved yet */ }
  for (const c of cars) {
    let tracks = [];
    try { tracks = fs.readdirSync(path.join(ROOT, c.name), { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { continue; }
    for (const t of tracks) {
      let files = [];
      try { files = fs.readdirSync(path.join(ROOT, c.name, t.name)).filter((f) => f.toLowerCase().endsWith(EXT)); } catch { continue; }
      for (const f of files) {
        const file = path.join(ROOT, c.name, t.name, f);
        let st; try { st = fs.statSync(file); } catch { continue; }
        let preset = presetCache.get(c.name);
        if (preset === undefined) { try { preset = filePreset(fs.readFileSync(file)); } catch { preset = null; } presetCache.set(c.name, preset); }
        const car = carOfFile(c.name, preset);
        const tr = trackOfFolder(t.name);
        const rel = relOf(c.name, t.name, f.slice(0, -EXT.length));
        out.push({ id: idOf(rel), rel, file, carFolder: c.name, trackFolder: t.name, name: f.slice(0, -EXT.length),
          carId: car?.id || `folder:${c.name}`, carName: car ? `${car.brand} ${car.name}` : c.name, trackId: tr?.id || null, trackName: tr?.name || t.name,
          size: st.size, mtime: st.mtimeMs });
      }
    }
  }
  scanCache = { at: Date.now(), files: out };
  return out;
}
export const byId = (id) => scan().find((f) => f.id === id) || null;

function describeFile(f, track) {
  const m = meta.files[f.rel] || {};
  return { id: f.id, name: f.name, carId: f.carId, carName: f.carName, carFolder: f.carFolder, track: { id: f.trackId, name: f.trackName, folder: f.trackFolder },
    notes: m.notes || '', from: m.from || null, basedOn: m.basedOn || null, updatedAt: f.mtime, forTrack: !!(track?.id && f.trackId === track.id) };
}

/** The setups of a car: this track's first (newest first), then the other tracks' setups grouped by track. */
export function list(carId, track = null) {
  const items = scan().filter((f) => f.carId === carId).map((f) => describeFile(f, track));
  items.sort((a, b) => (b.forTrack - a.forTrack) || (a.forTrack ? 0 : a.track.name.localeCompare(b.track.name)) || b.updatedAt - a.updatedAt);
  return items;
}
/** Cars that have setups: [{carId, carName, count}] */
export function cars() {
  const m = new Map();
  for (const f of scan()) { const e = m.get(f.carId) || { carId: f.carId, carName: f.carName, count: 0, last: 0 }; e.count++; e.last = Math.max(e.last, f.mtime); m.set(f.carId, e); }
  return [...m.values()].sort((a, b) => b.last - a.last).map(({ last, ...e }) => e);
}
/** A setup with its values as the game's setup screen shows them (null values: this car's limits are unknown). */
export function detail(id) {
  const f = byId(id);
  if (!f) return null;
  let r = { values: null, preset: null };
  try { r = cs.read(fs.readFileSync(f.file), f.carId); } catch (e) { r.error = e.message; }
  return { ...describeFile(f, null), preset: r.preset, values: r.values && r.values.map((v) => ({ ...v, tip: cs.tipFor(v) || undefined })), error: r.error || (r.values ? null : "This car's setup limits were not found in the game files") };
}

// ---------------------------------------------------------------- file changes (the game reads these only when it lists / loads setups)
function moveMeta(fromRel, toRel) { if (meta.files[fromRel]) { meta.files[toRel] = meta.files[fromRel]; delete meta.files[fromRel]; saveMeta(); } }

export function update(id, { name, notes } = {}) {
  let f = byId(id);
  if (!f) throw new Error('Setup not found');
  if (notes !== undefined) { metaFor(f.rel).notes = String(notes).slice(0, 4000); saveMeta(); }
  if (name !== undefined && SAFE(name) !== f.name) {
    const n = SAFE(name);
    if (!n) throw new Error('Give the setup a name');
    const to = path.join(path.dirname(f.file), n + EXT);
    if (fs.existsSync(to)) throw new Error(`"${n}" already exists for this car and track`);
    fs.renameSync(f.file, to);
    moveMeta(f.rel, relOf(f.carFolder, f.trackFolder, n));
    f = scan(true).find((x) => x.file === to);
  } else scan(true);
  return detail(f.id);
}
export function remove(id) {
  const f = byId(id);
  if (!f) throw new Error('Setup not found');
  fs.rmSync(f.file, { force: true });
  delete meta.files[f.rel]; saveMeta();
  scan(true);
}
/** Write a .carsetup into <car>\<track>\ under a free name; the game only sees the finished file (temp + rename). */
function writeSetup(carFolder, trackFolder, wanted, buf) {
  const dir = path.join(ROOT, SAFE(carFolder), SAFE(trackFolder));
  fs.mkdirSync(dir, { recursive: true });
  const base = SAFE(wanted) || 'Setup';
  let name = base, i = 2;
  while (fs.existsSync(path.join(dir, name + EXT))) name = `${base} (${i++})`;
  const tmp = path.join(dir, `.${name}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, path.join(dir, name + EXT));
  scan(true);
  return { name, rel: relOf(SAFE(carFolder), SAFE(trackFolder), name) };
}

// ---------------------------------------------------------------- sharing: the game's own file
export function exportFile(id) {
  const f = byId(id);
  if (!f) throw new Error('Setup not found');
  return { buf: fs.readFileSync(f.file), filename: `${f.carFolder} - ${f.trackFolder} - ${f.name}${EXT}` };
}
/** A .carsetup from a friend: its car comes from the file; the track from the file name "<car> - <track> - <name>" or the picked one. */
export function importFile(buf, { filename = '', trackId = null } = {}) {
  const preset = filePreset(buf);
  if (!preset || buf.length > 64 * 1024) throw new Error('Not an AC EVO setup file (.carsetup)');
  const car = carOfFile('', preset);
  if (!car) throw new Error(`This setup is for a car that is not installed (${preset.split('_preset')[0]})`);
  const parts = String(filename).replace(/\.carsetup$/i, '').split(' - ');
  const fromName = parts.length >= 3 ? trackOfFolder(parts[1]) : null;
  const track = (trackId && trackdata.catalog().find((t) => t.id === trackId)) || fromName;
  if (!track) { const e = new Error('Which track is this setup for?'); e.needsTrack = true; e.car = `${car.brand} ${car.name}`; throw e; }
  const name = parts.length >= 3 ? parts.slice(2).join(' - ') : parts.join(' - ') || 'Shared setup';
  const carFolder = scan().find((f) => f.carId === car.id)?.carFolder || `${car.brand} ${car.name}`;
  const w = writeSetup(carFolder, track.name, name, buf);
  metaFor(w.rel).from = 'shared'; saveMeta();
  return { id: idOf(w.rel), name: w.name, carId: car.id, track: track.name };
}

// ---------------------------------------------------------------- editing values
/**
 * Change values of a setup: {name: value} in stored units (as detail().values gives them). Saved as a new file
 * next to it (asName), or over the file itself when asName is not given. -> the saved setup's detail
 */
export function saveValues(id, changes, { asName = null, notes = null, from = 'paddock' } = {}) {
  const f = byId(id);
  if (!f) throw new Error('Setup not found');
  const { buf, changed } = cs.write(fs.readFileSync(f.file), f.carId, changes);
  if (asName == null && !changed.length) return detail(id);
  let rel;
  if (asName != null) {
    const w = writeSetup(f.carFolder, f.trackFolder, asName, buf);
    rel = w.rel;
    Object.assign(metaFor(rel), { from, basedOn: f.name, changes: changed, ...(notes ? { notes: String(notes).slice(0, 4000) } : {}) });
  } else {
    const tmp = path.join(path.dirname(f.file), `.${f.name}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, f.file);
    rel = f.rel;
    if (notes) metaFor(rel).notes = String(notes).slice(0, 4000);
  }
  saveMeta();
  scan(true);
  return detail(idOf(rel));
}

/** The game lists and loads only the current track's setups: a copy for another track, as "<name> [<from track>]". */
export function copyTo(id, trackId) {
  const f = byId(id);
  if (!f) throw new Error('Setup not found');
  const track = trackdata.catalog().find((t) => t.id === trackId);
  if (!track) throw new Error('Pick a track');
  if (norm(track.name) === norm(f.trackFolder)) throw new Error(`"${f.name}" is already a ${track.name} setup`);
  const w = writeSetup(f.carFolder, track.name, `${f.name} [${f.trackFolder}]`, fs.readFileSync(f.file));
  Object.assign(metaFor(w.rel), { from: 'copy', basedOn: `${f.name} (${f.trackFolder})`, notes: meta.files[f.rel]?.notes || '' });
  saveMeta();
  return detail(idOf(w.rel));
}

export const status = () => ({ folder: ROOT });
