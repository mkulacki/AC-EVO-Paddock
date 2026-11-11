// Car catalogue straight from AC EVO's content.kspkg: every car, its mechanical variants (presets) with
// the game's own spec sheet, drivetrain, gearbox type, liveries, description, and decoded thumbnails.
//
// Files used (protobuf, field numbers observed on the current game build):
//   content\cars\<car>\presets\<mech>.mechanicalcarpreset
//       f1 brand, f2 model, f3 trim, f7 category code, f18 race-car flag, f8[] visual preset paths,
//       f19.f1[] stats {f1 kind, f3 unit, f4 value}: 1 power hp, 2 torque Nm, 4 displacement L, 7 cylinders,
//       8 0-100 km/h s, 9 top speed km/h, 10 gears, 11 weight kg, 18 redline rpm, 19 fuel tank L
//   content\cars\<car>\**\*.drivetrain   f2 layout: absent RWD, 1 FWD, >= 2 AWD
//   content\cars\<car>\**\*.gearbox      f7 = 1 manual (H pattern), f19 = 1 dual clutch / paddles, else sequential
//   content\cars\<car>\generated\thumbnails\<car>-<mech>-<visual>.texture(mips)
//       header f1 width, f2 height, f4 format (34 = BC7), f12 {f1, f2} tile size; data = tiles row-major
//   uiresources\localization\cars\<car>\<mech>.en.loc   description (some variants only)
// Mod cars come from the .kspkg packs in <Saved Games>\ACE\mods (same layout as content.kspkg; their
// descriptions are loose files in mods\uiresources\localization). They carry source 'mod' and the pack
// name; a mod car with an original car's id replaces it, as the game loads mods over its own content.
// A mod disabled in the Mods tab is moved out of mods\, so its car drops out of the list.
import fs from 'node:fs';
import path from 'node:path';
import { archive } from './trackdata.js';
import { Kspkg } from './kspkg.js';
import { ACE } from './gamebridge.js';
import { fields, sub, str, all, one, num } from './pb.js';
import { Worker } from 'node:worker_threads';
import { DATA_DIR } from './db.js';

const VERSION = 3; // bump when the catalogue format changes
const MODS_DIR = path.join(ACE, 'mods');
const CACHE_DIR = path.join(DATA_DIR, 'carcache');
const THUMB_DIR = path.join(CACHE_DIR, 'thumbs');
const STAT = { 1: 'powerHp', 2: 'torqueNm', 4: 'displacementL', 7: 'cylinders', 8: 'zeroTo100', 9: 'topSpeedKmh', 10: 'gears', 11: 'weightKg', 18: 'redlineRpm', 19: 'fuelL' };

let mem = null;

const base = (p) => p.split('\\').pop().replace(/\.[^.]+$/, '');
const safe = (s) => String(s).replace(/[^a-z0-9_.-]+/gi, '_');

function category(code, race) {
  if (code === 42 || code === 55) return 'Formula';
  if (race) return 'Race';
  if (code >= 50 && code < 100) return 'Track';
  if (code >= 100 && code < 200) return 'Tuned';
  return 'Road';
}
function raceClass(trim, model) {
  const s = `${trim} ${model}`;
  const m = s.match(/\bGT[234]\b/i) || s.match(/\b(Cup|Challenge|Trofeo)\b/i);
  return m ? m[0].toUpperCase().replace(/^(CUP|CHALLENGE|TROFEO)$/, (x) => x[0] + x.slice(1).toLowerCase()) : null;
}

// display name from the folder id, with the casing the game uses in its own strings
function carName(id, brand, models) {
  const words = models.join(' ').split(/[\s"()-]+/).filter(Boolean);
  const brandTokens = new Set(String(brand).toLowerCase().split(/[\s-]+/));
  return id.replace(/^ks_/, '').split('_').filter((t) => !brandTokens.has(t)).map((t) => {
    const w = words.find((x) => x.toLowerCase() === t);
    if (w) return w;
    const pre = words.find((x) => x.length > t.length && x.toLowerCase().startsWith(t) && /^[A-Z0-9]+$/.test(x.slice(0, t.length)));
    if (pre) return pre.slice(0, t.length);                       // "rs" from "RS3"
    if (/^(i|ii|iii|iv|vi)$/.test(t)) return t.toUpperCase();      // roman numerals
    if (/\d/.test(t) || (t.length <= 3 && !/[aeiouy]/.test(t))) return t.toUpperCase();
    return t[0].toUpperCase() + t.slice(1);
  }).join(' ').replace(/\b(\d) (\d)\b/g, '$1.$2');                // "3 6" -> "3.6"
}

function variantName(model) {
  return model.replace(/\s*\bpreset\b.*$/i, '').replace(/\s+\b(base|standard)\b\s*$/i, '').trim() || model;
}

function decodeMech(buf) {
  const fs_ = fields(buf);
  const s = (f) => { const x = one(fs_, f); return x?.wt === 2 ? str(buf, x) : ''; };
  const stats = {};
  for (const st of all(fs_, 19)) for (const it of all(sub(buf, st), 1)) {
    const f = sub(buf, it);
    const k = STAT[num(f, 1)];
    const v = num(f, 4);
    if (k && v != null) stats[k] = Math.round(v * 100) / 100;
  }
  return { brand: s(1), model: s(2), trim: s(3), code: num(fs_, 7, 0), race: num(fs_, 18, 0) === 1, visuals: all(fs_, 8).map((x) => base(str(buf, x))), stats };
}

function firstParsed(p, files, fn) {
  for (const f of files.sort((a, b) => base(a).length - base(b).length)) {
    try { return fn(fields(p.read(f))); } catch { /* next */ }
  }
  return null;
}

// a description shipped by a mod as a loose file in mods\uiresources\localization
function looseText(rel) {
  try { return fs.readFileSync(path.join(MODS_DIR, rel)); } catch { return null; }
}

function build(p, mod = null) {
  const keys = [...p.load().index.keys()];
  const byCar = new Map();
  for (const k of keys) {
    const m = k.match(/^content\\cars\\([^\\]+)\\/);
    if (!m || m[1].startsWith('common')) continue;
    if (!byCar.has(m[1])) byCar.set(m[1], []);
    byCar.get(m[1]).push(k);
  }
  const cars = [];
  for (const [id, files] of byCar) {
    const mechFiles = files.filter((f) => /\\presets\\[^\\]+\.mechanicalcarpreset$/.test(f)).sort();
    if (!mechFiles.length) continue;
    const thumbs = new Set(files.filter((f) => /\\generated\\thumbnails\\.+\.texture$/.test(f)).map(base));
    const variants = [];
    for (const f of mechFiles) {
      let d;
      try { d = decodeMech(p.read(f)); } catch { continue; }
      const mech = base(f);
      let desc = null;
      const locRel = `uiresources\\localization\\cars\\${id}\\${mech}.en.loc`;
      const loc = p.read(locRel) || (mod ? looseText(locRel) : null);
      if (loc) desc = loc.toString('utf8').replace(/\*\*_?|_?\*\*/g, '').replace(/\r/g, '').trim();
      variants.push({
        mech, name: variantName(d.model), trim: d.trim, brand: d.brand, model: d.model, category: category(d.code, d.race), categoryCode: d.code,
        raceClass: d.race ? raceClass(d.trim, d.model) : null, stats: d.stats, description: desc,
        liveries: d.visuals.map((v) => ({ visual: v, thumb: thumbs.has(`${id}-${mech}-${v}`) })),
      });
    }
    if (!variants.length) continue;
    const v0 = variants[0];
    // a variant without some figures (e.g. a limited edition) shows the base variant's
    for (const v of variants.slice(1)) v.stats = { ...v0.stats, ...v.stats };
    const racing = v0.category === 'Race' || v0.category === 'Formula';
    const electric = v0.stats.displacementL == null && v0.stats.cylinders == null;
    const layout = firstParsed(p, files.filter((f) => f.endsWith('.drivetrain')), (fs_) => num(fs_, 2, 0));
    const gb = files.filter((f) => f.endsWith('.gearbox'));
    // f7 = H-pattern manual; f19 = shift by paddles (a dual clutch on road cars, a paddle sequential on race cars)
    const gear = firstParsed(p, gb.filter((f) => !/drift|short|long/i.test(base(f))).concat(gb), (fs_) => (num(fs_, 7) === 1 ? 'Manual'
      : num(fs_, 19) === 1 ? (racing ? 'Sequential (paddles)' : 'Dual-clutch') : electric ? 'Single-speed' : 'Sequential'));
    let brand = v0.brand || id.split('_')[1];
    let name = carName(id, brand, variants.map((v) => v.model));
    if (mod) {
      // mod packs often carry a raw id as the brand ("hina_drift_club") and a numbered folder ("..._01")
      if (/_|^[a-z]/.test(brand)) brand = brand.split('_').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
      name = name.replace(/\s+0\d$/, '') || name;
    }
    cars.push({
      id, brand, name,
      drivetrain: layout == null ? null : layout === 0 ? 'RWD' : layout === 1 ? 'FWD' : 'AWD',
      transmission: gb.some((f) => /automatic/i.test(f)) ? 'Automatic' : gear,
      engine: electric ? 'Electric' : v0.stats.cylinders ? `${v0.stats.displacementL ? v0.stats.displacementL.toFixed(1) + ' L ' : ''}${v0.stats.cylinders} cyl` : null,
      categories: [...new Set(variants.map((v) => v.category))],
      source: mod ? 'mod' : 'original',
      ...(mod ? { mod } : {}),
      variants,
    });
  }
  return cars;
}

// ---------------------------------------------------------------- mod packs
const packs = new Map(); // pack name -> Kspkg (kept while the file is unchanged)
let modScan = { at: 0, list: [] };

/** The .kspkg packs currently in mods\ (re-listed at most every 5 s): [{name, file, stamp}] */
function modFiles() {
  if (Date.now() - modScan.at < 5000) return modScan.list;
  const list = [];
  try {
    for (const n of fs.readdirSync(MODS_DIR)) {
      if (!/\.kspkg$/i.test(n)) continue;
      try { const st = fs.statSync(path.join(MODS_DIR, n)); if (st.isFile()) list.push({ name: n.replace(/\.kspkg$/i, ''), file: path.join(MODS_DIR, n), stamp: `${st.size}-${Math.round(st.mtimeMs)}` }); } catch { /* vanished */ }
    }
  } catch { /* no mods folder */ }
  modScan = { at: Date.now(), list: list.sort((a, b) => a.name.localeCompare(b.name)) };
  return modScan.list;
}
function modPack(name) {
  const m = modFiles().find((x) => x.name === name);
  if (!m) return null;
  const have = packs.get(name);
  if (have?.stamp === m.stamp) return have;
  try { const p = new Kspkg(m.file, { minFiles: 1 }); packs.set(name, p); return p; } catch { return null; }
}
// the archive that holds this car's files
const packOf = (car) => (car?.mod ? modPack(car.mod) : archive());

function modCars(m) {
  const file = path.join(CACHE_DIR, `mod-v${VERSION}-${safe(m.name)}-${m.stamp}.json`);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* build */ }
  let cars = [];
  try {
    const p = modPack(m.name);
    // packs without cars (e.g. UI mods) are remembered as empty
    if (p && [...p.load().index.keys()].some((k) => k.startsWith('content\\cars\\'))) cars = build(p, m.name);
  } catch (e) { console.error(`[cars] mod ${m.name}: ${e.message}`); }
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cars));
  return cars;
}

export function catalog() {
  const p = archive();
  if (!p) return [];
  const mods = modFiles();
  const stamp = `${p.stamp}|${mods.map((m) => `${m.name}:${m.stamp}`).join(',')}`;
  if (mem?.stamp === stamp) return mem.cars;
  const file = path.join(CACHE_DIR, `cars-v${VERSION}-${p.stamp}.json`);
  let base = null;
  try { base = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* build */ }
  if (!base) {
    const t0 = Date.now();
    base = build(p);
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(base));
    console.log(`[cars] ${base.length} cars read from content.kspkg in ${Date.now() - t0} ms`);
  }
  const byId = new Map(base.map((c) => [c.id, c]));
  let n = 0;
  for (const m of mods) for (const c of modCars(m)) { byId.set(c.id, c); n++; }
  const cars = [...byId.values()].sort((a, b) => `${a.brand} ${a.name}`.localeCompare(`${b.brand} ${b.name}`));
  if (mem?.modCount !== n) console.log(`[cars] ${n} mod car(s) from ${mods.length} pack(s) in mods\\`);
  mem = { stamp, cars, modCount: n };
  return cars;
}

export const byId = (id) => catalog().find((c) => c.id === id) || null;

// ---------------------------------------------------------------- mod tracks
let modTrackMem = { at: 0, v: null };
/**
 * What mods ship for tracks (re-read at most every 5 s): `folders` = track folder names under
 * content\tracks\ in a mod pack or as loose files in mods\content\tracks, `maps` = loose map drawings
 * (mods\uiresources\images\trackmaps\*.svg, name -> full path), `stamp` changes when either does.
 */
export function modTracks() {
  if (modTrackMem.v && Date.now() - modTrackMem.at < 5000) return modTrackMem.v;
  const folders = new Set(), maps = new Map();
  try { for (const d of fs.readdirSync(path.join(MODS_DIR, 'content', 'tracks'), { withFileTypes: true })) if (d.isDirectory()) folders.add(d.name.toLowerCase()); } catch { /* none */ }
  const packs = modFiles();
  for (const m of packs) {
    try {
      const p = modPack(m.name)?.load();
      for (const k of p ? p.index.keys() : []) { const x = k.match(/^content\\tracks\\([^\\]+)\\/i); if (x) folders.add(x[1].toLowerCase()); }
    } catch { /* unreadable pack */ }
  }
  const mapDir = path.join(MODS_DIR, 'uiresources', 'images', 'trackmaps');
  try { for (const n of fs.readdirSync(mapDir)) if (/\.svg$/i.test(n)) maps.set(n.replace(/\.svg$/i, '').toLowerCase(), path.join(mapDir, n)); } catch { /* none */ }
  const stamp = `${[...folders].sort().join(',')}|${[...maps.keys()].sort().join(',')}|${packs.map((m) => m.stamp).join(',')}`;
  const v = modTrackMem.v?.stamp === stamp ? modTrackMem.v : { folders, maps, stamp };
  modTrackMem = { at: Date.now(), v };
  return v;
}

// match a car name as shared memory reports it (e.g. "Mazda MX-5 NA", sometimes truncated) to a catalogue car
const nrm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
export const aliases = (c) => [...new Set([c.id, `${c.brand} ${c.name}`, c.name, ...c.variants.flatMap((v) => [`${c.brand} ${v.model}`, `${c.brand} ${v.name}`, v.model])].map(nrm).filter((x) => x.length >= 3))];
export function match(display) {
  const n = nrm(display);
  if (!n) return null;
  const cars = catalog();
  return cars.find((c) => aliases(c).includes(n))
    || cars.find((c) => n.length >= 8 && aliases(c).some((a) => a.startsWith(n) || n.startsWith(a)))
    || fuzzy(display, cars);
}
// last resort for truncated / reworded names ("BMW M3 E30 Sport Evo (Evolution"): same brand, most words in common
function fuzzy(display, cars) {
  const words = (s) => String(s ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2);
  const want = words(display);
  let best = null, score = 0;
  for (const c of cars) {
    if (!want.includes(words(c.brand)[0])) continue;
    const have = new Set(words([c.id, c.name, ...c.variants.map((v) => v.model)].join(' ')));
    const s = want.filter((w) => have.has(w)).length / want.length;
    if (s > score) { score = s; best = c; }
  }
  return score >= 0.6 ? best : null;
}

// ---------------------------------------------------------------- thumbnails
// Decoded in a worker thread (thumbworker.js), cached as PNG in data\carcache\thumbs.
let worker = null, seq = 0;
const waiting = new Map(); // job id -> {resolve}
const jobs = new Map();    // png file -> Promise<file|null>

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./thumbworker.js', import.meta.url));
  worker.unref();
  worker.on('message', ({ id, png, error }) => { const w = waiting.get(id); waiting.delete(id); w?.resolve(error ? null : Buffer.from(png)); });
  worker.on('error', (e) => { console.error('[cars] thumbnail worker:', e.message); for (const w of waiting.values()) w.resolve(null); waiting.clear(); worker = null; });
  return worker;
}

/** Path of the PNG for this car / variant / livery (any variant's livery as a fallback), or null. */
export function thumbnail(id, mech, visual) {
  const car = byId(id);
  if (!car) return Promise.resolve(null);
  const v = car.variants.find((x) => x.mech === mech) || car.variants[0];
  const liv = (v.liveries.find((l) => l.visual === visual && l.thumb) && { mech: v.mech, visual })
    || (v.liveries.find((l) => l.thumb) && { mech: v.mech, visual: v.liveries.find((l) => l.thumb).visual })
    || car.variants.flatMap((x) => x.liveries.filter((l) => l.thumb).map((l) => ({ mech: x.mech, visual: l.visual })))[0];
  if (!liv) return Promise.resolve(null);
  const name = `${id}-${liv.mech}-${liv.visual}`;
  const p = packOf(car);
  if (!p) return Promise.resolve(null);
  const file = path.join(THUMB_DIR, `${safe(name)}-${p.stamp}.png`);
  if (fs.existsSync(file)) return Promise.resolve(file);
  if (jobs.has(file)) return jobs.get(file);
  const job = new Promise((resolve) => {
    const hdr = p.read(`content\\cars\\${id}\\generated\\thumbnails\\${name}.texture`);
    const data = p.read(`content\\cars\\${id}\\generated\\thumbnails\\${name}.texturemips`);
    if (!hdr || !data) return resolve(null);
    const h = fields(hdr);
    const W = num(h, 1), H = num(h, 2), fmt = num(h, 4);
    const tile = one(h, 12) ? sub(hdr, one(h, 12)) : null;
    const tw = (tile && num(tile, 1)) || W, th = (tile && num(tile, 2)) || H;
    if (fmt !== 34 || W % tw || H % th || data.length < W * H) return resolve(null);
    const jid = ++seq;
    waiting.set(jid, { resolve: (png) => {
      if (!png) return resolve(null);
      fs.mkdirSync(THUMB_DIR, { recursive: true });
      fs.writeFileSync(file, png);
      resolve(file);
    } });
    getWorker().postMessage({ id: jid, data, W, H, tw, th });
  }).finally(() => jobs.delete(file));
  jobs.set(file, job);
  return job;
}

/** Build every car's default thumbnail in the background (one at a time), so the garage opens fast. */
export async function warmThumbnails() {
  for (const c of catalog()) { try { await thumbnail(c.id); } catch { /* skip */ } }
}
