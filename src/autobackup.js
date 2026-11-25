// PL11: scheduled, verified backups with retention and a storage forecast (Settings → Backup and restore).
// Built on src/backup.js (the same secret-free zip as "Back up now", reason 'scheduled'); no second backup system.
//
// Rules (docs/platform/DATA_OWNERSHIP.md, decisions OD-PL-74 … 78):
// - off until the driver switches it on; daily or weekly; only while no session is being driven (the database copy
//   is a VACUUM INTO on the main thread, which would stall the lap recording)
// - never fills the disk: a run needs room for the copy, the zip and the verification copy plus a reserve, else it is
//   skipped with a visible notice
// - never into a folder a cloud client syncs (OneDrive, Dropbox, …) unless the driver ticks "back up there anyway"
// - every scheduled backup is verified (src/backupverify.js); one that fails is deleted and the older ones are kept
// - retention removes only older *scheduled* backups, and only after a new one verified; manual, imported and
//   before-restore backups are never removed by Paddock
import fs from 'node:fs';
import path from 'node:path';
import * as db from './db.js';
import * as backup from './backup.js';
import * as settings from './settings.js';
import { list, extract, readEntry } from './zip.js';
import { verifyZip } from './backupverify.js';
import { loadJson, writeJsonAtomic } from './jsonfile.js';

export const DEFAULTS = { on: false, every: 'weekly', keep: 4, allowSynced: false };
export const INTERVALS = { daily: 86400e3, weekly: 7 * 86400e3 };
export const KEEP_MIN = 1, KEEP_MAX = 30;
export const RESERVE = 1024 ** 3; // always leave this much free on the drive (1 GiB)
const STATE_FILE = () => path.join(backup.BACKUP_DIR, 'schedule.json');

/** The schedule from settings.autoBackup, every field checked. */
export function config(raw = settings.get().autoBackup) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const keep = Number.isFinite(+r.keep) ? Math.round(+r.keep) : DEFAULTS.keep;
  return { on: r.on === true, every: Object.hasOwn(INTERVALS, r.every) ? r.every : DEFAULTS.every,
    keep: Math.min(KEEP_MAX, Math.max(KEEP_MIN, keep)), allowSynced: r.allowSynced === true };
}

// ---------------------------------------------------------------- state: last run, last skip, verification results
let state = null;
function loadState() {
  if (state) return state;
  const v = loadJson(STATE_FILE(), {}).value;
  state = { lastOkAt: Number(v?.lastOkAt) || 0, lastRun: v?.lastRun ?? null, skip: v?.skip ?? null, verified: v?.verified && typeof v.verified === 'object' ? v.verified : {} };
  return state;
}
function saveState() {
  // results only for backups that still exist
  const names = new Set(backup.listBackups().map((b) => b.name));
  for (const n of Object.keys(state.verified)) if (!names.has(n)) delete state.verified[n];
  try { fs.mkdirSync(backup.BACKUP_DIR, { recursive: true }); writeJsonAtomic(STATE_FILE(), state); } catch (e) { console.log(`[backup] schedule state not saved: ${e.message}`); }
}
/** The last verification of a backup: {ok, checkedAt, problems} or null. */
export const verification = (name) => loadState().verified[name] ?? null;

// ---------------------------------------------------------------- disk safety
const SYNCED = [
  [/^onedrive( - .+)?$/i, 'OneDrive'], [/^dropbox( \(.+\))?$/i, 'Dropbox'], [/^google ?drive$/i, 'Google Drive'], [/^my drive$/i, 'Google Drive'],
  [/^icloud ?drive$/i, 'iCloud Drive'], [/^pcloud ?drive$/i, 'pCloud'], [/^mega( ?sync)?$/i, 'MEGA'], [/^nextcloud$/i, 'Nextcloud'], [/^owncloud$/i, 'ownCloud'],
  [/^box( sync)?$/i, 'Box'], [/^sync$/i, 'Sync.com'],
];
/** The cloud client that syncs this folder (by a folder name on its path, or the OneDrive folders Windows reports), or null. */
export function syncedFolder(dir, env = process.env) {
  const abs = path.resolve(dir);
  const norm = (p) => path.resolve(p).toLowerCase().replace(/[\\/]+$/, '');
  for (const k of ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']) {
    const root = env[k];
    if (root && (norm(abs) === norm(root) || norm(abs).startsWith(`${norm(root)}${path.sep}`))) return 'OneDrive';
  }
  for (const part of abs.split(/[\\/]+/)) for (const [re, name] of SYNCED) if (re.test(part)) return name;
  return null;
}
/** Free bytes on the drive of dir, or null when it cannot be read. */
export function freeBytes(dir) {
  try { const s = fs.statfsSync(dir); return Number(s.bavail) * Number(s.bsize); } catch { return null; }
}
const fileSize = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };
/** Bytes a backup run needs at most: the database copy and the zip exist together, then the zip and the verification copy. */
export function bytesNeeded(reserve = RESERVE) {
  const dbBytes = fileSize(path.join(db.DATA_DIR, 'telemetry.db')) + fileSize(path.join(db.DATA_DIR, 'telemetry.db-wal'));
  const small = backup.JSON_FILES.reduce((s, f) => s + fileSize(path.join(db.DATA_DIR, f)), 0);
  return 2 * (dbBytes + small) + reserve;
}

// ---------------------------------------------------------------- storage forecast
/**
 * How much room the laps and the scheduled backups take, and how fast that grows (from the laps of the last 90 days).
 * -> {dbBytes, perLapBytes, lapsPer30d, growthPer30d, backupBytes, retainedBytes, freeBytes, daysUntilFull, scheduledCount}
 */
export function forecast(now = Date.now()) {
  const raw = db.raw;
  const dbBytes = fileSize(path.join(db.DATA_DIR, 'telemetry.db')) + fileSize(path.join(db.DATA_DIR, 'telemetry.db-wal'));
  const since = now - 90 * 86400e3;
  let recent = { n: 0, bytes: 0 }, all = { n: 0, bytes: 0 };
  try {
    recent = raw.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(length(data)), 0) AS bytes FROM laps WHERE recorded_at >= ?').get(since);
    all = raw.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(length(data)), 0) AS bytes FROM laps').get();
  } catch { /* an empty in-memory database (src/db.js blocked) */ }
  // a lap's share of the database: its telemetry plus the rest of the file spread over all laps
  const perLapBytes = all.n ? Math.round(dbBytes / all.n) : 0;
  // laps per 30 days over the part of the last 90 days that had laps (a new install has less history)
  let first = since;
  try { first = Math.max(since, raw.prepare('SELECT MIN(recorded_at) AS t FROM laps WHERE recorded_at >= ?').get(since).t ?? now); } catch { /* none */ }
  const days = Math.max(7, (now - first) / 86400e3);
  const lapsPer30d = recent.n ? Math.round((recent.n / days) * 30) : 0;
  const growthPer30d = lapsPer30d * perLapBytes;
  const cfg = config();
  const scheduled = backup.listBackups().filter((b) => b.ok && b.reason === 'scheduled');
  const backupBytes = scheduled[0]?.size ?? Math.round(dbBytes * 0.9); // a zip of a database compresses little: lap telemetry is gzipped already
  const allBackups = backup.listBackups().reduce((s, b) => s + b.size, 0);
  const retainedBytes = cfg.keep * backupBytes;
  const free = freeBytes(fs.existsSync(backup.BACKUP_DIR) ? backup.BACKUP_DIR : db.DATA_DIR);
  // each 30 days the database grows by growthPer30d, and the kept backups (keep copies of it) by keep times that
  const perDay = (growthPer30d * (1 + (cfg.on ? cfg.keep : 0))) / 30;
  const daysUntilFull = free != null && perDay > 0 ? Math.max(0, Math.floor((free - RESERVE) / perDay)) : null;
  return { dbBytes, perLapBytes, lapsPer30d, growthPer30d, backupBytes, retainedBytes, allBackupsBytes: allBackups, scheduledCount: scheduled.length, freeBytes: free, daysUntilFull };
}

// ---------------------------------------------------------------- one run
let running = null;
const skip = (reason, text) => {
  const s = loadState();
  const same = s.skip?.reason === reason;
  s.skip = { reason, text, at: Date.now() };
  saveState();
  if (!same) console.log(`[backup] scheduled backup skipped: ${text}`);
  return { ran: false, skipped: reason, text };
};

/**
 * Run the schedule once: makes a backup when one is due (or force), verifies it and applies retention.
 * isIdle(): false while a session is being driven. -> {ran, skipped?, text?, backup?, verification?, removed?}
 */
export function runOnce(opts = {}) {
  if (running) return running;
  running = runNow(opts).finally(() => { running = null; });
  return running;
}
async function runNow({ isIdle = () => true, appVersion = null, force = false, now = Date.now(), env = process.env, reserve = RESERVE } = {}) {
  const cfg = config();
  if (!cfg.on && !force) return { ran: false, skipped: 'off' };
  const s = loadState();
  if (!force && s.lastOkAt && now - s.lastOkAt < INTERVALS[cfg.every]) return { ran: false, skipped: 'not-due' };
  if (db.blocked) return skip('blocked', db.blocked.message);
  if (db.DEMO) return skip('demo', 'The demo makes no scheduled backups.');
  if (!isIdle()) return { ran: false, skipped: 'driving' }; // not a notice: tried again when the session ends
  const cloud = syncedFolder(backup.BACKUP_DIR, env);
  if (cloud && !cfg.allowSynced) return skip('synced', `The backups folder (${backup.BACKUP_DIR}) is inside ${cloud}, which uploads every backup. Scheduled backups are off there unless you tick "Back up there anyway".`);
  fs.mkdirSync(backup.BACKUP_DIR, { recursive: true });
  const free = freeBytes(backup.BACKUP_DIR), need = bytesNeeded(reserve);
  if (free == null) return skip('space-unknown', 'The free space on the drive could not be read, so no scheduled backup was made.');
  if (free < need) return skip('space', `Not enough free space for a scheduled backup: ${gb(free)} free, ${gb(need)} needed (a copy of the laps database, its zip and a reserve of ${gb(reserve)}). Free some space or delete old backups.`);
  let made;
  try { made = await backup.create({ reason: 'scheduled', appVersion }); }
  catch (e) { return skip('failed', `The scheduled backup failed: ${e.message}`); }
  const v = await verify(made.name);
  s.lastRun = { at: Date.now(), name: made.name, ok: v.ok, problems: v.problems };
  if (!v.ok) {
    // a backup that does not check out is worth nothing and takes room: removed; the older ones stay
    try { backup.remove(made.name); } catch { /* already gone */ }
    return skip('verify', `The scheduled backup ${made.name} did not pass its check and was deleted: ${v.problems.join('; ')}. Your older backups are kept.`);
  }
  s.lastOkAt = Date.now(); s.skip = null;
  const removed = prune(cfg.keep);
  saveState();
  console.log(`[backup] scheduled backup ${made.name} verified${removed.length ? `; removed ${removed.length} older scheduled backup(s)` : ''}`);
  return { ran: true, backup: made, verification: v, removed };
}
const gb = (n) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`);

/** Verify a backup zip and remember the result. */
export async function verify(name) {
  const file = backup.fileOf(name);
  const v = await verifyZip(file, { inspect: backup.inspect, list, extract, readEntry }, backup.BACKUP_DIR);
  loadState().verified[name] = { ok: v.ok, checkedAt: v.checkedAt, problems: v.problems.slice(0, 5) };
  saveState();
  return v;
}

/** Keep the newest `keep` scheduled backups that verified; older scheduled ones go. Other backups are never touched. */
export function prune(keep) {
  const s = loadState();
  const scheduled = backup.listBackups().filter((b) => b.ok && b.reason === 'scheduled');
  const good = scheduled.filter((b) => s.verified[b.name]?.ok);
  const removed = [];
  for (const b of good.slice(keep)) { try { backup.remove(b.name); removed.push(b.name); } catch { /* in use: next time */ } }
  return removed;
}

/** For Settings: the schedule, its last run and skip, when the next one is due, and the forecast. */
export function status() {
  const cfg = config(), s = loadState();
  return { config: cfg, lastOkAt: s.lastOkAt || null, lastRun: s.lastRun, skip: cfg.on ? s.skip : null,
    nextDueAt: cfg.on ? (s.lastOkAt ? s.lastOkAt + INTERVALS[cfg.every] : Date.now()) : null,
    synced: syncedFolder(backup.BACKUP_DIR), forecast: forecast(), demo: db.DEMO };
}

/** The skip notice for Home (cheap: no listing, no forecast), or null. */
export function notice() {
  const cfg = config(), s = loadState();
  return cfg.on && s.skip && s.skip.reason !== 'demo' ? s.skip : null;
}

/** Change the schedule (Settings). */
export function setConfig(patch) {
  const next = config({ ...config(), ...(patch && typeof patch === 'object' ? patch : {}) });
  settings.update({ autoBackup: next });
  if (!next.on) { const s = loadState(); s.skip = null; saveState(); }
  return status();
}

/** Check every 10 minutes (first after 2 minutes); runOnce decides whether a backup is due. */
export function schedule({ isIdle, appVersion }) {
  const go = () => runOnce({ isIdle, appVersion }).catch((e) => console.log(`[backup] scheduled backup: ${e.message}`));
  setTimeout(go, 120e3).unref?.();
  setInterval(go, 600e3).unref?.();
}

/** For tests: forget the cached state. */
export const _reset = () => { state = null; };
