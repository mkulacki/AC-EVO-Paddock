// Applies a restore staged by src/backup.js. Runs at start, from src/db.js, BEFORE the database is opened: the files
// can only be replaced while nothing holds them. A backup of the data as it was was made when the restore was asked for.
// No imports from the app: db.js imports this first (src/sensitive.js and src/jsonfile.js have no imports themselves).
//
// Safety: the database is swapped first and by rename (copy next to it, clear the old WAL, then rename over), so a
// failure leaves the current data as it was. If the database cannot be swapped, nothing else is touched and the
// restore stays staged for the next start (a file lock may be gone by then); after 3 failed starts it is set aside.
import fs from 'node:fs';
import path from 'node:path';
import { mergeRestoredSettings } from './sensitive.js';
import { loadJson } from './jsonfile.js';

export const PENDING = 'restore-pending';
// the files a backup may bring back (all directly in data\)
export const RESTORABLE = ['telemetry.db', 'settings.json', 'race.json', 'setup-meta.json'];
const MAX_ATTEMPTS = 3;

// The JSON files a restore merges are read like everywhere else (src/jsonfile.js loadJson: a BOM is fine, e.g. a file
// saved by Notepad). The current file is never silently taken as empty: a damaged one is kept aside as
// <name>.unreadable-<time> (the Settings page names it, and the key in it stays recoverable), and one that cannot be
// read at all (locked) is not replaced. -> the parsed object, or throws (that file is then not restored).
function readCurrent(file) {
  const r = loadJson(file, {});
  if (r.state === 'failed') throw new Error('the current file could not be read, so it was not replaced (what is in it is kept)');
  return r.value; // ok, missing ({}), or aside ({}: the damaged file is kept next to it)
}
function readStaged(file) {
  const r = loadJson(file, null, { log: () => {} });
  if (r.state !== 'ok') throw new Error('the copy in the backup cannot be read');
  return r.value;
}

// Current secrets win (decision OD-PL-1/OD-PL-4 refinement, 2026-11-24): a restore never replaces a key or password
// the install has, it only fills empty ones from the backup; the leaderboard sign-in is never restored (src/sensitive.js).
const mergeSettings = mergeRestoredSettings;
const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
const hostKey = (o) => `${String(o?.ip ?? '').trim()}:${o?.port}`;
const holdsPassword = (o) => Array.isArray(o) ? o.some(holdsPassword) : isObj(o) && Object.entries(o).some(([k, v]) => (k === 'password' ? !!v : holdsPassword(v)));
/**
 * race.json brought back by a restore, merged with the current one, so that no restore loses a password:
 * - every {password} anywhere (saved servers, presets, the last setup) takes the current password of the same server
 *   (same id, else same host:port) when the install has one; only an empty one keeps the backup's;
 * - saved servers the install has and the backup lacks (same id or host:port) are kept, with their passwords;
 * - presets the install has and the backup lacks (same id) are kept when they hold a password.
 */
export function mergeRestoredRace(restored, current) {
  const out = isObj(restored) ? restored : {};
  const cur = isObj(current) ? current : {};
  const known = new Map();
  const collect = (o) => {
    if (Array.isArray(o)) o.forEach(collect);
    else if (isObj(o)) {
      if (o.password && o.ip != null && !known.has(hostKey(o))) known.set(hostKey(o), o.password);
      if (o.password && o.id != null) known.set(`id:${o.id}`, o.password);
      Object.values(o).forEach(collect);
    }
  };
  collect(cur.servers); collect(cur); // saved servers first: their password is the one in use for that address
  const fill = (o) => {
    if (Array.isArray(o)) o.forEach(fill);
    else if (isObj(o)) {
      if ('password' in o) o.password = known.get(`id:${o.id}`) || known.get(hostKey(o)) || o.password || '';
      Object.values(o).forEach(fill);
    }
  };
  fill(out);
  if (Array.isArray(cur.servers)) {
    if (!Array.isArray(out.servers)) out.servers = [];
    const ids = new Set(out.servers.filter(isObj).map((s) => s.id).filter((v) => v != null));
    const hosts = new Set(out.servers.filter(isObj).map(hostKey));
    for (const s of cur.servers) if (isObj(s) && !ids.has(s.id) && !hosts.has(hostKey(s))) out.servers.push(s);
  }
  if (Array.isArray(cur.presets)) {
    if (!Array.isArray(out.presets)) out.presets = [];
    // the same preset = same id, else same name (src/race.js savePreset matches by name): never two of one name
    const ids = new Set(out.presets.filter(isObj).map((p) => p.id).filter((v) => v != null));
    const names = new Set(out.presets.filter(isObj).map((p) => String(p.name ?? '').trim()).filter(Boolean));
    for (const p of cur.presets) {
      if (isObj(p) && !ids.has(p.id) && !names.has(String(p.name ?? '').trim()) && holdsPassword(p)) out.presets.push(p);
    }
  }
  return out;
}
const mergeRace = mergeRestoredRace;

function swapDatabase(from, to) {
  const next = `${to}.restoring`;
  fs.copyFileSync(from, next);
  // an old WAL next to the new database would be replayed into it: it must go first, or nothing changes
  for (const ext of ['-wal', '-shm']) fs.rmSync(to + ext, { force: true });
  fs.renameSync(next, to);
}

/** -> null (nothing to do) or {ok, files, error} */
export function applyPendingRestore(dataDir) {
  const dir = path.join(dataDir, PENDING);
  const manifestFile = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestFile)) return null;
  const done = [];
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch (e) { return setAside(dataDir, dir, done, `unreadable staging: ${e.message}`); }
  const files = (manifest.files || []).filter((n) => RESTORABLE.includes(n) && fs.existsSync(path.join(dir, n)));
  // 1. the database, or nothing
  if (files.includes('telemetry.db')) {
    try { swapDatabase(path.join(dir, 'telemetry.db'), path.join(dataDir, 'telemetry.db')); done.push('telemetry.db'); }
    catch (e) {
      fs.rmSync(path.join(dataDir, 'telemetry.db.restoring'), { force: true });
      const attempts = (manifest.attempts || 0) + 1;
      if (attempts >= MAX_ATTEMPTS) return setAside(dataDir, dir, done, `the laps database could not be replaced (${e.message})`);
      try { fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, attempts }, null, 2)); } catch { /* next start counts again */ }
      console.error(`[backup] restore postponed (attempt ${attempts} of ${MAX_ATTEMPTS}): ${e.message}`);
      return { ok: false, files: done, error: `The laps database could not be replaced (${e.message}). Your data is unchanged; Paddock tries again at the next start.` };
    }
  }
  // 2. the small files (a failure here leaves that one file as it was)
  const errors = [];
  for (const name of files.filter((n) => n !== 'telemetry.db')) {
    const from = path.join(dir, name), to = path.join(dataDir, name);
    try {
      // the backup's copy first: when it cannot be read, the current file is not touched at all
      const text = name === 'settings.json' ? (() => { const b = readStaged(from); return JSON.stringify(mergeSettings(b, readCurrent(to)), null, 2); })()
        : name === 'race.json' ? (() => { const b = readStaged(from); return JSON.stringify(mergeRace(b, readCurrent(to)), null, 2); })()
          : fs.readFileSync(from, 'utf8');
      fs.writeFileSync(`${to}.restoring`, text);
      fs.renameSync(`${to}.restoring`, to);
      done.push(name);
    } catch (e) { errors.push(`${name}: ${e.message}`); }
  }
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`[backup] restored ${done.join(', ')} from the backup of ${manifest.createdAt ? new Date(manifest.createdAt).toISOString() : '?'}${errors.length ? `; not restored: ${errors.join('; ')}` : ''}`);
  return errors.length ? { ok: false, files: done, error: `Not restored: ${errors.join('; ')}` } : { ok: true, files: done };
}

// never retried forever: the staged files are kept aside for a look; the pre-restore backup holds the old data
function setAside(dataDir, dir, done, why) {
  try { fs.renameSync(dir, path.join(dataDir, `restore-failed-${Date.now()}`)); } catch { fs.rmSync(dir, { recursive: true, force: true }); }
  console.error(`[backup] restore given up: ${why}`);
  return { ok: false, files: done, error: why };
}
