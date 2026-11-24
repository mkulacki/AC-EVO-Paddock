// Backup and restore of Paddock's data (Settings → Backup and restore).
// A backup is a zip in data\backups: manifest.json, a consistent copy of telemetry.db (laps, sessions, reports, brake
// points, AI answers) and the driver's own small files (settings, Race tab presets and servers, setup notes). The
// driver picks which of these parts (PARTS) go in; a restore brings back only the parts the backup holds.
// Left out: caches (track/car data, thumbnails), the game catalogue the HUD read, the Mods tab manifest (it describes
// the files in this PC's game folder, so restoring it elsewhere or later would not match the disk), disabled mods,
// logs and the backups themselves. The Gemini key and saved server passwords are left out unless asked for; the
// leaderboard sign-in (token and Steam identity) is never in a backup (src/sensitive.js, decision OD-PL-1).
// Restore: the backup is checked and unpacked to data\restore-pending, a backup of the current data is made first,
// and the files are swapped at the next start (src/restore-apply.js), before the database is opened. That safety
// backup holds no secrets at all (decision OD-PL-4): undoing a restore with it keeps the key, passwords and sign-in
// the install has then, because a restore keeps every secret a backup leaves out (src/sensitive.js).
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as db from './db.js';
import { writeZip, list, extract, readEntry } from './zip.js';
import { PENDING, RESTORABLE } from './restore-apply.js';
import { stripSettings, stripRace } from './sensitive.js';

export const BACKUP_DIR = path.join(db.DATA_DIR, 'backups');
export const FORMAT = 'acevo-paddock-backup';
const FORMAT_VERSION = 1;
export const JSON_FILES = RESTORABLE.filter((f) => f !== 'telemetry.db');
const MAX_DB = 3.9 * 1024 ** 3; // the zip has no Zip64: a bigger database cannot be backed up this way
// an uploaded backup can be at most this big (the largest backup Paddock makes, plus room for the small files)
export const MAX_UPLOAD = Math.ceil(MAX_DB + 256 * 1024 ** 2);

const p2 = (n) => String(n).padStart(2, '0');
const stamp = (d = new Date()) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
const err = (msg, code = 400) => Object.assign(new Error(msg), { code });

// What a backup can hold, chosen in Settings: each part is one file in data\.
export const PARTS = [
  { id: 'laps', file: 'telemetry.db', label: 'Laps, sessions and reports', hint: 'every lap with its telemetry, sessions, reports, brake marks, goals and saved AI answers' },
  { id: 'settings', file: 'settings.json', label: 'Settings', hint: 'your driver name, HUD and spotter settings, folders (the Gemini key only if you include it; never the leaderboard sign-in)' },
  { id: 'race', file: 'race.json', label: 'Race tab presets and servers', hint: 'saved presets, online servers (passwords only if you include them) and the last setup' },
  { id: 'setupNotes', file: 'setup-meta.json', label: 'Setup notes', hint: "your notes on setups and where they came from (the setup files themselves stay in the game's folder)" },
];
const fileSize = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };
// tables of the laps database, grouped for the size breakdown (track caches are rebuilt from the game files)
const DB_GROUPS = [
  { label: 'lap telemetry', tables: ['laps'] },
  { label: 'track caches', tables: ['track_edges', 'track_models', 'analyses'] },
];
/** The parts with their size now: [{id, label, hint, size, exists, breakdown?: [{label, size}], counts?}] */
export function parts() {
  return PARTS.map((p) => {
    const file = path.join(db.DATA_DIR, p.file);
    const exists = fs.existsSync(file);
    const out = { id: p.id, label: p.label, hint: p.hint, exists, size: exists ? fileSize(file) + (p.id === 'laps' ? fileSize(`${file}-wal`) : 0) : 0 };
    if (p.id === 'laps' && exists) {
      const t = db.tableSizes();
      if (t) {
        const used = new Set(DB_GROUPS.flatMap((g) => g.tables));
        out.breakdown = [...DB_GROUPS.map((g) => ({ label: g.label, size: g.tables.reduce((s, n) => s + (t[n] || 0), 0) })),
          { label: 'sessions, reports and the rest', size: Object.entries(t).filter(([n]) => !used.has(n)).reduce((s, [, v]) => s + v, 0) }];
      }
      out.counts = db.counts();
    }
    return out;
  });
}

// left-overs of an interrupted backup, upload or zip write (each can be a full database copy)
try {
  for (const n of fs.readdirSync(BACKUP_DIR)) if (/^\.(backup|upload)-|\.part$|\.tmp$/.test(n)) fs.rmSync(path.join(BACKUP_DIR, n), { force: true });
} catch { /* no backups yet */ }

/**
 * The copy of a data file that goes into a backup: the leaderboard sign-in always goes; the Gemini key and server
 * passwords (anywhere in race.json) go unless keepSecrets. Other files are returned as they are.
 */
export function stripSecrets(name, obj, { keepSecrets = false } = {}) {
  if (name === 'settings.json') return stripSettings(obj, { keepSecrets });
  if (name === 'race.json') return stripRace(obj, { keepSecrets });
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
async function createNow({ includeSecrets = false, reason = 'manual', appVersion = null, parts: want = null }) {
  // which parts: all of them unless the driver picked some (automatic backups always take everything)
  const pick = new Set(Array.isArray(want) ? PARTS.filter((p) => want.includes(p.id)).map((p) => p.file) : PARTS.map((p) => p.file));
  if (!pick.size) throw err('Choose at least one thing to back up');
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const dbFile = path.join(db.DATA_DIR, 'telemetry.db');
  if (pick.has('telemetry.db') && fs.existsSync(dbFile) && fs.statSync(dbFile).size > MAX_DB) throw err('The laps database is over 3.9 GB, too big for a backup zip. Copy the data folder by hand while Paddock is closed.', 413);
  const now = new Date();
  let name = `paddock-backup-${stamp(now)}${reason === 'manual' ? '' : `-${reason}`}.zip`;
  for (let k = 2; fs.existsSync(path.join(BACKUP_DIR, name)); k++) name = name.replace(/(-\d+)?\.zip$/, `-${k}.zip`);
  const tmpDb = path.join(BACKUP_DIR, `.backup-${process.pid}-${Date.now()}.db`);
  try {
    const entries = [];
    if (pick.has('telemetry.db')) { db.vacuumInto(tmpDb); entries.push({ name: 'telemetry.db', file: tmpDb }); }
    for (const f of JSON_FILES) {
      const file = path.join(db.DATA_DIR, f);
      if (!pick.has(f) || !fs.existsSync(file)) continue;
      let text = fs.readFileSync(file, 'utf8');
      // settings and race.json are always rewritten (the sign-in never goes in); an unreadable one is left out
      if (f === 'settings.json' || f === 'race.json') {
        try { text = JSON.stringify(stripSecrets(f, JSON.parse(text), { keepSecrets: !!includeSecrets }), null, 2); } catch { continue; }
      }
      entries.push({ name: f, data: text });
    }
    // includesSecrets: the Gemini key and passwords are in it. signIn: false = no leaderboard login (never, since PL1)
    const manifest = { format: FORMAT, version: FORMAT_VERSION, app: appVersion, createdAt: now.getTime(), reason, includesSecrets: !!includeSecrets, signIn: false,
      files: entries.map((e) => e.name), counts: pick.has('telemetry.db') ? db.counts() : null };
    if (!entries.length) throw err('Nothing to back up: the chosen files do not exist yet');
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
  // a backup may hold only some parts (chosen when it was made), but at least one Paddock knows
  if (!Array.isArray(m.files) || !m.files.some((f) => RESTORABLE.includes(f))) throw err('This backup holds nothing Paddock can restore');
  const inZip = new Set(list(file).map((e) => e.name));
  const missing = m.files.filter((f) => RESTORABLE.includes(f) && !inZip.has(f));
  if (missing.length) throw err(`This backup is damaged: ${missing.includes('telemetry.db') ? 'the laps database is' : `${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'}`} missing`);
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
    const files = m.files.filter((f) => RESTORABLE.includes(f));
    return { name, size, createdAt: num(m.createdAt) ?? mtimeMs, app: str(m.app), reason: str(m.reason), includesSecrets: m.includesSecrets === true,
      parts: PARTS.filter((p) => files.includes(p.file)).map((p) => p.id),
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
    // the laps database (when the backup has one) must open and look like Paddock's, and not come from a newer Paddock;
    // a backup without it restores only its other parts and keeps the current laps
    if (files.includes('telemetry.db')) {
      const t = new DatabaseSync(path.join(dir, 'telemetry.db'), { readOnly: true });
      try {
        const tables = new Set(t.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
        if (!tables.has('laps') || !tables.has('sessions')) throw err('The database in this backup is not a Paddock laps database');
        // Paddock never makes triggers, views or virtual tables: one in a backup would run code on Paddock's own queries
        const odd = t.prepare("SELECT type, name FROM sqlite_master WHERE type IN ('trigger', 'view') OR (type = 'table' AND sql LIKE 'CREATE VIRTUAL%') LIMIT 1").get();
        if (odd) throw err(`The database in this backup contains a ${odd.type === 'table' ? 'virtual table' : odd.type} Paddock never makes (${String(odd.name).slice(0, 40)}): not restored`);
        if (t.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw err('The database in this backup is damaged');
        if (t.prepare('PRAGMA user_version').get().user_version > db.counts().schema) throw err('This backup was made by a newer Paddock: update Paddock first');
      } finally { t.close(); }
    }
    if (!files.length) throw err('This backup holds nothing Paddock can restore');
    // no secrets in it (OD-PL-4): restoring it later keeps the install's own key, passwords and sign-in
    const before = await create({ includeSecrets: false, reason: 'before-restore', appVersion });
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
