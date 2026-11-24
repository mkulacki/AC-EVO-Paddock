// Applies a restore staged by src/backup.js. Runs at start, from src/db.js, BEFORE the database is opened: the files
// can only be replaced while nothing holds them. A backup of the data as it was was made when the restore was asked for.
// No imports from the app: db.js imports this first (src/sensitive.js has no imports itself).
//
// Safety: the database is swapped first and by rename (copy next to it, clear the old WAL, then rename over), so a
// failure leaves the current data as it was. If the database cannot be swapped, nothing else is touched and the
// restore stays staged for the next start (a file lock may be gone by then); after 3 failed starts it is set aside.
import fs from 'node:fs';
import path from 'node:path';
import { mergeRestoredSettings } from './sensitive.js';

export const PENDING = 'restore-pending';
// the files a backup may bring back (all directly in data\)
export const RESTORABLE = ['telemetry.db', 'settings.json', 'race.json', 'setup-meta.json'];
const MAX_ATTEMPTS = 3;

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } };

// secrets a backup may leave out are kept from the current files; the leaderboard sign-in is never restored, also
// when an older backup still holds one: the current install's sign-in stays (src/sensitive.js, decision OD-PL-1 (b))
const mergeSettings = mergeRestoredSettings;
// race.json: every {ip, port, password} anywhere (saved servers, presets, the last setup) gets the current password
// for the same server back when the backup had none
function mergeRace(restored, current) {
  const known = new Map();
  const collect = (o) => {
    if (Array.isArray(o)) o.forEach(collect);
    else if (o && typeof o === 'object') {
      if (o.password && o.ip != null) known.set(`${String(o.ip).trim()}:${o.port}`, o.password);
      if (o.password && o.id != null) known.set(`id:${o.id}`, o.password);
      Object.values(o).forEach(collect);
    }
  };
  collect(current);
  const fill = (o) => {
    if (Array.isArray(o)) o.forEach(fill);
    else if (o && typeof o === 'object') {
      if ('password' in o && !o.password) o.password = known.get(`id:${o.id}`) || known.get(`${String(o.ip ?? '').trim()}:${o.port}`) || '';
      Object.values(o).forEach(fill);
    }
  };
  fill(restored);
  return restored;
}

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
      const text = name === 'settings.json' ? JSON.stringify(mergeSettings(readJson(from), readJson(to)), null, 2)
        : name === 'race.json' ? JSON.stringify(mergeRace(readJson(from), readJson(to)), null, 2)
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
