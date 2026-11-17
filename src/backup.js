// Backup and restore of Paddock's data (Settings → Backup and restore).
// A backup is a zip in data\backups: manifest.json, a consistent copy of telemetry.db (laps, sessions, reports, brake
// points, AI answers) and the driver's own small files (settings, Race tab presets and servers, setup notes).
// Left out: caches (track/car data, thumbnails), the game catalogue the HUD read, the Mods tab manifest (it describes
// the files in this PC's game folder, so restoring it elsewhere or later would not match the disk), disabled mods,
// logs and the backups themselves. The Gemini key and saved server passwords are left out unless asked for.
// Restore: the backup is checked and unpacked to data\restore-pending, a backup of the current data is made first,
// and the files are swapped at the next start (src/restore-apply.js), before the database is opened.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as db from './db.js';
import { writeZip, list, extract, readEntry } from './zip.js';
import { PENDING, RESTORABLE } from './restore-apply.js';

export const BACKUP_DIR = path.join(db.DATA_DIR, 'backups');
export const FORMAT = 'acevo-paddock-backup';
const FORMAT_VERSION = 1;
export const JSON_FILES = RESTORABLE.filter((f) => f !== 'telemetry.db');
const MAX_DB = 3.9 * 1024 ** 3; // the zip has no Zip64: a bigger database cannot be backed up this way

const p2 = (n) => String(n).padStart(2, '0');
const stamp = (d = new Date()) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
const err = (msg, code = 400) => Object.assign(new Error(msg), { code });

// left-overs of an interrupted backup, upload or zip write (each can be a full database copy)
try {
  for (const n of fs.readdirSync(BACKUP_DIR)) if (/^\.(backup|upload)-|\.part$|\.tmp$/.test(n)) fs.rmSync(path.join(BACKUP_DIR, n), { force: true });
} catch { /* no backups yet */ }

/** The secrets a shared or uploaded backup should not carry: Gemini key, server passwords (anywhere in race.json). */
export function stripSecrets(name, obj) {
  if (name === 'settings.json' && obj.geminiApiKey) obj.geminiApiKey = '';
  if (name === 'race.json') (function walk(o) {
    if (Array.isArray(o)) o.forEach(walk);
    else if (o && typeof o === 'object') for (const k of Object.keys(o)) { if (k === 'password') o[k] = ''; else walk(o[k]); }
  })(obj);
  return obj;
}

// one backup at a time: two at once (a click and a restore's safety copy) would pick the same name
let queue = Promise.resolve();
/** Make a backup. -> {name, size, createdAt, ...manifest} */
export function create(opts = {}) {
  const run = queue.then(() => createNow(opts));
  queue = run.catch(() => {});
  return run;
}
async function createNow({ includeSecrets = false, reason = 'manual', appVersion = null }) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const dbFile = path.join(db.DATA_DIR, 'telemetry.db');
  if (fs.existsSync(dbFile) && fs.statSync(dbFile).size > MAX_DB) throw err('The laps database is over 3.9 GB, too big for a backup zip. Copy the data folder by hand while Paddock is closed.', 413);
  const now = new Date();
  let name = `paddock-backup-${stamp(now)}${reason === 'manual' ? '' : `-${reason}`}.zip`;
  for (let k = 2; fs.existsSync(path.join(BACKUP_DIR, name)); k++) name = name.replace(/(-\d+)?\.zip$/, `-${k}.zip`);
  const tmpDb = path.join(BACKUP_DIR, `.backup-${process.pid}-${Date.now()}.db`);
  try {
    db.vacuumInto(tmpDb);
    const entries = [{ name: 'telemetry.db', file: tmpDb }];
    for (const f of JSON_FILES) {
      const file = path.join(db.DATA_DIR, f);
      if (!fs.existsSync(file)) continue;
      let text = fs.readFileSync(file, 'utf8');
      if (!includeSecrets) { try { text = JSON.stringify(stripSecrets(f, JSON.parse(text)), null, 2); } catch { continue; } } // unreadable: left out
      entries.push({ name: f, data: text });
    }
    const manifest = { format: FORMAT, version: FORMAT_VERSION, app: appVersion, createdAt: now.getTime(), reason, includesSecrets: !!includeSecrets,
      files: entries.map((e) => e.name), counts: db.counts() };
    await writeZip(path.join(BACKUP_DIR, name), [{ name: 'manifest.json', data: JSON.stringify(manifest, null, 2) }, ...entries]);
    return describe(name);
  } finally { fs.rmSync(tmpDb, { force: true }); }
}

/** A backup's manifest, checked: throws if the file is not a Paddock backup. */
export function inspect(file) {
  let raw;
  try { raw = readEntry(file, 'manifest.json'); } catch (e) { throw err(`Not a backup file: ${e.message}`); }
  if (!raw) throw err('Not a Paddock backup: there is no manifest.json in it');
  let m; try { m = JSON.parse(raw.toString('utf8')); } catch { throw err('Not a Paddock backup: its manifest.json cannot be read'); }
  if (!m || m.format !== FORMAT) throw err('Not a Paddock backup (unknown format)');
  if (!(m.version <= FORMAT_VERSION)) throw err('This backup was made by a newer Paddock: update Paddock first');
  if (!Array.isArray(m.files) || !m.files.includes('telemetry.db')) throw err('This backup has no laps database');
  if (!list(file).some((e) => e.name === 'telemetry.db')) throw err('This backup is damaged: the laps database is missing');
  return m;
}

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i; // Windows device names
const safeName = (name) => {
  const n = String(name || '');
  if (path.basename(n) !== n || !/^[\w .()+-]+\.zip$/i.test(n) || RESERVED.test(n)) throw err('Unknown backup');
  return n;
};
// a manifest comes from a file that may have been made elsewhere: only plain, typed values reach the page
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v, max = 40) => (typeof v === 'string' ? v.slice(0, max) : null);
const describe = (name) => {
  const file = path.join(BACKUP_DIR, name);
  const { size, mtimeMs } = fs.statSync(file);
  try {
    const m = inspect(file);
    const c = m.counts && typeof m.counts === 'object' ? m.counts : null;
    return { name, size, createdAt: num(m.createdAt) ?? mtimeMs, app: str(m.app), reason: str(m.reason), includesSecrets: m.includesSecrets === true,
      counts: c ? { laps: num(c.laps), sessions: num(c.sessions), reports: num(c.reports), brakeMarks: num(c.brakeMarks) } : null, ok: true };
  } catch (e) { return { name, size, createdAt: mtimeMs, ok: false, error: e.message }; }
};
export const fileOf = (name) => path.join(BACKUP_DIR, safeName(name));

/** All backups, newest first. */
export function listBackups() {
  let names = [];
  try { names = fs.readdirSync(BACKUP_DIR).filter((n) => /\.zip$/i.test(n) && !RESERVED.test(n)); } catch { /* none yet */ }
  return names.map(describe).sort((a, b) => b.createdAt - a.createdAt);
}

export function remove(name) { fs.rmSync(fileOf(name)); }

/** A backup file the driver uploaded (e.g. from another PC): checked, then kept with the others. */
export function importUpload(tmpFile) {
  inspect(tmpFile);
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  let name = `paddock-backup-imported-${stamp()}.zip`;
  for (let k = 2; fs.existsSync(path.join(BACKUP_DIR, name)); k++) name = name.replace(/(-\d+)?\.zip$/, `-${k}.zip`);
  fs.copyFileSync(tmpFile, path.join(BACKUP_DIR, name));
  return describe(name);
}

/** Is there a restore waiting for the next start? */
export const pending = () => fs.existsSync(path.join(db.DATA_DIR, PENDING, 'manifest.json'));

/**
 * Prepare a restore from a backup: check it, unpack it, back up the current data, and leave it for the next start.
 * stillIdle: asked again right before the restore is committed (a lap started meanwhile would be lost).
 * -> {before: name of the safety backup, manifest}
 */
export async function stageRestore(name, { appVersion = null, stillIdle = () => true } = {}) {
  const file = fileOf(name);
  const manifest = inspect(file);
  const dir = path.join(db.DATA_DIR, PENDING);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  try {
    const files = [];
    for (const e of list(file)) {
      if (!RESTORABLE.includes(e.name) || !manifest.files.includes(e.name)) continue; // only the known top-level files
      await extract(file, e, path.join(dir, e.name)); // streamed: the database can be large
      files.push(e.name);
    }
    // the laps database must open and look like Paddock's, and not come from a newer Paddock
    const t = new DatabaseSync(path.join(dir, 'telemetry.db'), { readOnly: true });
    try {
      const tables = new Set(t.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
      if (!tables.has('laps') || !tables.has('sessions')) throw err('The database in this backup is not a Paddock laps database');
      if (t.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw err('The database in this backup is damaged');
      if (t.prepare('PRAGMA user_version').get().user_version > db.counts().schema) throw err('This backup was made by a newer Paddock: update Paddock first');
    } finally { t.close(); }
    const before = await create({ includeSecrets: true, reason: 'before-restore', appVersion });
    if (!stillIdle()) throw err('You went on track meanwhile: restore when you are in the menus or AC EVO is closed.', 409);
    // written last: its presence is what makes the next start apply the restore
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ ...manifest, files, from: name, stagedAt: Date.now(), before: before.name, attempts: 0 }, null, 2));
    return { before: before.name, manifest };
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

/** Cancel a restore that has not been applied yet. */
export function cancelRestore() { fs.rmSync(path.join(db.DATA_DIR, PENDING), { recursive: true, force: true }); }
