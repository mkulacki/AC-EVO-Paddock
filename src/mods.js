// Mods tab: the mods installed in <Saved Games>\ACE (\mods and the App Loader markers in \Video).
// AC EVO loads loose files from mods\ (and .kspkg packs there), so several mods share folders. Every mod
// installed here gets a manifest (data/mods.json) listing its files, so it can be disabled (files moved to
// data/mods-disabled/<id>/), enabled again, or deleted. Mods installed by hand are grouped by name heuristics
// and become managed the first time they are renamed, merged, disabled or deleted.
// Files are only touched while the game is closed: the game's resource loader crashes on a missing file.
import fs from 'node:fs';
import path from 'node:path';
import { ACE } from './gamebridge.js';
import { DATA_DIR } from './db.js';
import { isRunningNow } from './game.js';
import * as zip from './zip.js';

const STORE = path.join(DATA_DIR, 'mods.json');
const OFF = path.join(DATA_DIR, 'mods-disabled');
export const UPLOAD_DIR = path.join(DATA_DIR, 'mod-uploads');
const MODS = path.join(ACE, 'mods');
const VIDEO = path.join(ACE, 'Video');
const APPS = 'mods/uiresources/ACEUIAppLoader/';
const MARKER_RE = /^ACEUIAppLoader-(.+)\.settingspreset$/i;
const JUNK_RE = /(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$|desktop\.ini$)/i;
// folder / file-name parts that say nothing about which mod a loose file belongs to
const GENERIC = new Set(('mods uiresources js css html images img icons branding oem fonts textures content cars tracks data assets audio ' +
  'sounds ui components pages lib libs vendor common shared media system config index main style styles app live readme localization loc en').split(' '));
const NAMES = { aceuiapploader: 'ACE UI App Loader', 'app:trainerhud': 'Paddock HUD' };
const PROTECTED = new Set(['aceuiapploader', 'app:trainerhud']);

class ModError extends Error { constructor(msg, code = 400, extra = {}) { super(msg); this.code = code; Object.assign(this, extra); } }
export { ModError };

// ------------------------------------------------------------------ manifest store
function load() {
  try { const s = JSON.parse(fs.readFileSync(STORE, 'utf8')); return { mods: Array.isArray(s.mods) ? s.mods : [] }; }
  catch { return { mods: [] }; }
}
function save(s) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STORE + '.tmp', JSON.stringify(s, null, 1));
  fs.renameSync(STORE + '.tmp', STORE);
}
const newId = () => `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const abs = (rel) => path.join(ACE, ...rel.split('/'));
const offAbs = (id, rel) => path.join(OFF, id, ...rel.split('/'));

// ------------------------------------------------------------------ disk scan + grouping
function walk(dir, rel, out) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name), r = `${rel}/${e.name}`;
    if (e.isDirectory()) walk(p, r, out);
    else if (e.isFile()) { try { const st = fs.statSync(p); out.set(r, { size: st.size, mtime: st.mtimeMs }); } catch { /* vanished */ } }
  }
}
function scanDisk() {
  const out = new Map();
  walk(MODS, 'mods', out);
  try {
    for (const f of fs.readdirSync(VIDEO)) if (MARKER_RE.test(f)) {
      const st = fs.statSync(path.join(VIDEO, f)); out.set(`Video/${f}`, { size: st.size, mtime: st.mtimeMs });
    }
  } catch { /* no Video folder */ }
  return out;
}

// which mod a file most likely belongs to: { key, label }
function keyOf(rel) {
  const marker = rel.startsWith('Video/') && rel.slice(6).match(MARKER_RE);
  if (marker) return { key: `app:${marker[1].toLowerCase()}`, label: marker[1] };
  if (rel.toLowerCase().startsWith(APPS.toLowerCase())) {
    const rest = rel.slice(APPS.length);
    if (rest.includes('/')) { const a = rest.split('/')[0]; return { key: `app:${a.toLowerCase()}`, label: a }; }
    return { key: 'aceuiapploader', label: 'ACEUIAppLoader' }; // the loader's own note file
  }
  const kp = rel.match(/^mods\/([^/]+)\.kspkg$/i);
  if (kp) return { key: kp[1].toLowerCase(), label: kp[1] };
  const segs = rel.split('/').slice(1);
  for (const s of segs.slice(0, -1)) if (!GENERIC.has(s.toLowerCase())) return { key: s.toLowerCase(), label: s };
  const prefix = segs[segs.length - 1].split(/[-_.\s]/)[0];
  if (prefix.length >= 3 && !GENERIC.has(prefix.toLowerCase())) return { key: prefix.toLowerCase(), label: prefix };
  return { key: 'loose', label: 'Other loose files' };
}

function appTitle(folder) {
  try {
    const a = JSON.parse(fs.readFileSync(abs(`${APPS}${folder}/app.json`), 'utf8').replace(/^﻿/, ''));
    return a.name || a.title || null;
  } catch { return null; }
}
function kindOf(files) {
  if (files.some((f) => /\.kspkg$/i.test(f))) return 'Package';
  if (files.some((f) => f.toLowerCase().startsWith(APPS.toLowerCase()) && f.slice(APPS.length).includes('/'))) return 'App Loader app';
  return 'UI files';
}

// the full picture: managed mods (enabled or disabled) plus detected groups of everything else
export function list() {
  const store = load();
  const disk = scanDisk();
  const owned = new Set();
  const out = [];
  const byKey = new Map(); // heuristic key -> enabled managed mod that claims it
  for (const m of store.mods) {
    const files = [];
    if (m.enabled) {
      for (const f of m.files) if (disk.has(f) && !owned.has(f)) { owned.add(f); files.push({ path: f, ...disk.get(f) }); }
      for (const k of m.keys || []) if (!byKey.has(k)) byKey.set(k, files);
    } else {
      for (const f of m.files) { try { const st = fs.statSync(offAbs(m.id, f)); files.push({ path: f, size: st.size, mtime: st.mtimeMs }); } catch { /* lost */ } }
    }
    out.push({ id: m.id, name: m.name, managed: true, enabled: !!m.enabled, source: m.source, file: m.file || null,
      installedAt: m.installedAt || null, keys: m.keys || [], files });
  }
  const groups = new Map();
  for (const [rel, st] of disk) {
    if (owned.has(rel)) continue;
    const { key, label } = keyOf(rel);
    if (byKey.has(key)) { byKey.get(key).push({ path: rel, ...st }); continue; }
    if (!groups.has(key)) groups.set(key, { label, files: [] });
    groups.get(key).files.push({ path: rel, ...st });
  }
  for (const [key, g] of groups) {
    const name = NAMES[key] || (key.startsWith('app:') ? appTitle(g.label) || g.label : g.label);
    out.push({ id: `auto:${key}`, name, managed: false, enabled: true, source: 'detected', file: null, installedAt: null, keys: [key], files: g.files });
  }
  return out.map((m) => {
    const paths = m.files.map((f) => f.path);
    return { ...m, kind: kindOf(paths), size: m.files.reduce((a, f) => a + f.size, 0),
      modifiedAt: m.files.reduce((a, f) => Math.max(a, f.mtime || 0), 0) || null,
      protected: m.keys.some((k) => PROTECTED.has(k)) || paths.some((p) => PROTECTED.has(keyOf(p).key)),
      files: m.files.map(({ path: p, size }) => ({ path: p, size })).sort((a, b) => a.path.localeCompare(b.path)) };
  }).sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name));
}

// a detected group becomes a managed mod (with the files it has right now); a managed one gets the
// files its keys picked up since it was installed
function materialize(store, id) {
  const cur = list().find((m) => m.id === id);
  if (!cur) throw new ModError('Mod not found', 404);
  let m = store.mods.find((x) => x.id === id);
  if (!m) {
    m = { id: newId(), name: cur.name, files: [], keys: cur.keys, enabled: true, source: 'detected', installedAt: Date.now() };
    store.mods.push(m);
  }
  if (m.enabled) m.files = cur.files.map((f) => f.path);
  return { m, cur };
}

// ------------------------------------------------------------------ file moves
function guardGame() {
  if (isRunningNow()) throw new ModError('AC EVO is running. Close the game first: changing mod files while it runs can crash it.', 409);
}
function moveFile(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try { fs.renameSync(src, dst); }
  catch (e) {
    if (e.code !== 'EXDEV') throw e; // data\ and Saved Games may be on different drives
    fs.copyFileSync(src, dst); fs.unlinkSync(src);
  }
}
// move a set of files; on any failure, put back what already moved
function moveAll(pairs) {
  const done = [];
  try { for (const [a, b] of pairs) { moveFile(a, b); done.push([a, b]); } }
  catch (e) {
    for (const [a, b] of done.reverse()) { try { moveFile(b, a); } catch { /* best effort */ } }
    throw new ModError(`Could not move ${path.basename(e.path || '')}: ${e.message}. Nothing was changed.`, 500);
  }
}
// remove folders left empty, up to (not including) mods\ and Video\
function prune(rels, base = ACE, stops = [MODS, VIDEO]) {
  const dirs = [...new Set(rels.map((r) => path.dirname(path.join(base, ...r.split('/')))))].sort((a, b) => b.length - a.length);
  for (let d of dirs) {
    while (!stops.includes(d) && d.startsWith(base + path.sep)) {
      try { if (fs.readdirSync(d).length) break; fs.rmdirSync(d); } catch { break; }
      d = path.dirname(d);
    }
  }
}
const needForce = (cur, force) => {
  if (cur.protected && !force) throw new ModError(`${cur.name} is required by Paddock. Confirm to continue.`, 409, { needsConfirm: true });
};

export function disable(id, { force } = {}) {
  guardGame();
  const store = load();
  const { m, cur } = materialize(store, id);
  if (!m.enabled) return list();
  needForce(cur, force);
  moveAll(m.files.map((f) => [abs(f), offAbs(m.id, f)]));
  prune(m.files);
  m.enabled = false;
  save(store);
  return list();
}

export function enable(id) {
  guardGame();
  const store = load();
  const m = store.mods.find((x) => x.id === id);
  if (!m) throw new ModError('Mod not found', 404);
  if (m.enabled) return list();
  const files = m.files.filter((f) => fs.existsSync(offAbs(m.id, f)));
  const clash = files.filter((f) => fs.existsSync(abs(f)));
  if (clash.length) throw new ModError(`Another mod now uses ${clash.length} of its file(s): ${clash.slice(0, 5).join(', ')}${clash.length > 5 ? ', …' : ''}. Disable that mod first.`, 409);
  moveAll(files.map((f) => [offAbs(m.id, f), abs(f)]));
  fs.rmSync(path.join(OFF, m.id), { recursive: true, force: true });
  m.files = files; m.enabled = true;
  save(store);
  return list();
}

export function remove(id, { force } = {}) {
  guardGame();
  const store = load();
  const cur = list().find((x) => x.id === id);
  if (!cur) throw new ModError('Mod not found', 404);
  needForce(cur, force);
  if (cur.enabled) {
    const failed = [];
    for (const f of cur.files) { try { fs.rmSync(abs(f.path), { force: true }); } catch (e) { failed.push(`${f.path}: ${e.message}`); } }
    prune(cur.files.map((f) => f.path));
    if (failed.length) throw new ModError(`Some files could not be deleted:\n${failed.slice(0, 5).join('\n')}`, 500);
  } else {
    fs.rmSync(path.join(OFF, id), { recursive: true, force: true });
  }
  store.mods = store.mods.filter((x) => x.id !== id);
  save(store);
  return list();
}

export function rename(id, name) {
  name = String(name || '').trim().slice(0, 80);
  if (!name) throw new ModError('Enter a name');
  const store = load();
  const { m } = materialize(store, id);
  m.name = name;
  save(store);
  return list();
}

// put all files of mod `id` into mod `into` (to fix a wrong automatic grouping)
export function merge(id, into) {
  if (id === into) throw new ModError('Pick a different mod');
  const store = load();
  const { m: a } = materialize(store, id);
  const { m: b } = materialize(store, into);
  if (!a.enabled || !b.enabled) throw new ModError('Enable both mods before merging them');
  b.files = [...new Set([...b.files, ...a.files])];
  b.keys = [...new Set([...(b.keys || []), ...(a.keys || [])])];
  store.mods = store.mods.filter((x) => x !== a);
  save(store);
  return list();
}

// ------------------------------------------------------------------ install
const cleanSegs = (p) => {
  const segs = p.split('/').filter(Boolean);
  if (segs.some((s) => s === '.' || s === '..' || s.includes(':'))) return null;
  return segs;
};
const lower = (a) => a.map((s) => s.toLowerCase());

// where each zip entry goes: [{ entry, rel }], plus skipped names
function planZip(entries, zipName) {
  const files = entries.filter((e) => !e.dir && !JUNK_RE.test(e.name));
  const items = files.map((e) => ({ e, segs: cleanSegs(e.name) }));
  const bad = items.filter((x) => !x.segs);
  if (bad.length) throw new ModError(`Unsafe path in the zip: ${bad[0].e.name}`);
  const plan = [], skipped = [];
  const findSeg = (name) => { for (const x of items) { const i = lower(x.segs).indexOf(name); if (i >= 0 && i < x.segs.length - 1) return x.segs.slice(0, i); } return null; };
  const under = (segs, prefix) => segs.length > prefix.length && lower(prefix).every((s, i) => s === segs[i].toLowerCase());
  const kspkgLoose = (x) => /\.kspkg$/i.test(x.e.name) ? plan.push({ entry: x.e, rel: `mods/${x.segs[x.segs.length - 1]}` }) : skipped.push(x.e.name);

  let prefix;
  if ((prefix = findSeg('mods'))) { // laid out like Saved Games\ACE
    for (const x of items) {
      if (!under(x.segs, prefix)) { kspkgLoose(x); continue; }
      const rest = x.segs.slice(prefix.length), top = rest[0].toLowerCase();
      if (top === 'mods') plan.push({ entry: x.e, rel: ['mods', ...rest.slice(1)].join('/') });
      else if (top === 'video' && rest.length === 2 && /\.settingspreset$/i.test(rest[1])) plan.push({ entry: x.e, rel: `Video/${rest[1]}` });
      else skipped.push(x.e.name);
    }
  } else if ((prefix = findSeg('uiresources'))) { // laid out like ACE\mods
    for (const x of items) {
      if (under(x.segs, prefix)) plan.push({ entry: x.e, rel: ['mods', ...x.segs.slice(prefix.length)].join('/') });
      else kspkgLoose(x);
    }
  } else if (items.some((x) => /\.kspkg$/i.test(x.e.name))) {
    items.forEach(kspkgLoose);
  } else {
    // a bare App Loader app: app.json at the top or in one folder
    const aj = items.filter((x) => x.segs[x.segs.length - 1].toLowerCase() === 'app.json').sort((a, b) => a.segs.length - b.segs.length)[0];
    const leaf = (x) => x.segs[x.segs.length - 1];
    const exe = items.find((x) => /\.(exe|msi)$/i.test(x.e.name));
    if (!aj && exe) {
      throw new ModError(`This download is an installer (${leaf(exe)}), not a plain mod. Close AC EVO, extract the zip to a folder and run ${leaf(exe)}: ` +
        'installers can also put files outside Saved Games\\ACE (e.g. a track into the game folder), which the Mods tab does not manage. ' +
        'Afterwards its files show up in this list.');
    }
    const inner = items.filter((x) => /\.zip$/i.test(x.e.name));
    if (!aj && inner.length) {
      throw new ModError(`This zip only contains other zip files (${inner.slice(0, 3).map(leaf).join(', ')}). Extract it and install the inner zip instead.`);
    }
    if (!aj || aj.segs.length > 2) {
      throw new ModError('Could not tell where this mod goes: the zip has no mods\\ or uiresources\\ folder, no .kspkg file and no App Loader app.json.');
    }
    const root = aj.segs.slice(0, -1);
    const app = (root[0] || zipName).replace(/[^\w.-]+/g, '_');
    for (const x of items) {
      if (under(x.segs, root) || !root.length) plan.push({ entry: x.e, rel: `${APPS}${app}/${x.segs.slice(root.length).join('/')}` });
      else skipped.push(x.e.name);
    }
  }
  if (!plan.length) throw new ModError('Nothing in this zip can be installed into AC EVO.');
  return { plan, skipped };
}

// tmpFile: the uploaded file; origName: its name in the browser
export async function install(tmpFile, origName, { overwrite = false } = {}) {
  guardGame();
  const base = path.basename(String(origName || 'mod'));
  const ext = path.extname(base).toLowerCase();
  const name = base.slice(0, base.length - ext.length).replace(/[_]+/g, ' ').trim() || 'Mod';
  let plan, skipped = [];
  if (ext === '.kspkg') {
    if (!/^[\w .()+-]+\.kspkg$/i.test(base)) throw new ModError('Unusual characters in the file name');
    plan = [{ entry: null, rel: `mods/${base}` }];
  } else if (ext === '.zip') {
    ({ plan, skipped } = planZip(zip.list(tmpFile), name));
  } else throw new ModError('Upload a .zip or .kspkg file');

  // App Loader apps need an empty marker in Video\ as well, or the loader does not see them
  const relsLower = new Set(plan.map((p) => p.rel.toLowerCase()));
  const apps = new Set(plan.map((p) => p.rel.toLowerCase().startsWith(APPS.toLowerCase()) && p.rel.slice(APPS.length).split('/'))
    .filter((s) => s && s.length > 1).map((s) => s[0]));
  for (const a of apps) {
    const rel = `Video/ACEUIAppLoader-${a}.settingspreset`;
    if (!relsLower.has(rel.toLowerCase()) && !fs.existsSync(abs(rel))) plan.push({ entry: null, empty: true, rel });
  }
  // duplicates inside the zip (e.g. a .kspkg twice in different folders)
  const seen = new Set();
  plan = plan.filter((p) => { const k = p.rel.toLowerCase(); if (seen.has(k)) { skipped.push(p.entry?.name || p.rel); return false; } seen.add(k); return true; });

  const current = list();
  const ownerOf = new Map();
  for (const m of current) if (m.enabled) for (const f of m.files) ownerOf.set(f.path.toLowerCase(), m);
  const conflicts = plan.filter((p) => fs.existsSync(abs(p.rel))).map((p) => ({ path: p.rel, owner: ownerOf.get(p.rel.toLowerCase())?.name || null }));
  if (conflicts.length && !overwrite) {
    throw new ModError(`${conflicts.length} file(s) already exist`, 409, { conflicts });
  }

  // extract next to the destination, then swap in
  const written = [];
  try {
    for (const p of plan) {
      const dst = abs(p.rel), part = `${dst}.part`;
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      if (p.empty) fs.writeFileSync(part, '');
      else if (p.entry) await zip.extract(tmpFile, p.entry, part);
      else fs.copyFileSync(tmpFile, part);
      written.push(part);
    }
    for (const p of plan) fs.renameSync(`${abs(p.rel)}.part`, abs(p.rel));
  } catch (e) {
    for (const f of written) fs.rmSync(f, { force: true });
    prune(plan.map((p) => p.rel));
    throw e instanceof ModError ? e : new ModError(`Install failed: ${e.message}`, 500);
  }

  // the new mod owns its files now; drop them from the mods that had them, and drop mods left empty
  const store = load();
  const mine = new Set(plan.map((p) => p.rel.toLowerCase()));
  for (const m of store.mods) if (m.enabled) m.files = m.files.filter((f) => !mine.has(f.toLowerCase()));
  store.mods = store.mods.filter((m) => !m.enabled || m.files.length);
  const keys = [...new Set(plan.map((p) => keyOf(p.rel).key).filter((k) => k !== 'loose'))];
  const id = newId();
  store.mods.push({ id, name, files: plan.map((p) => p.rel), keys, enabled: true, source: 'upload', file: base, installedAt: Date.now() });
  save(store);
  return { id, installed: plan.length, skipped, replaced: conflicts.length, mods: list() };
}
