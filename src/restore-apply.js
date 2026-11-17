// Applies a restore staged by src/backup.js. Runs at start, from src/db.js, BEFORE the database is opened: the files
// can only be replaced while nothing holds them. A backup of the data as it was was made when the restore was asked for.
// No imports from the app: db.js imports this first.
import fs from 'node:fs';
import path from 'node:path';

export const PENDING = 'restore-pending';

// secrets a backup may leave out: kept from the current files
function mergeSettings(restored, current) {
  if (!restored.geminiApiKey && current.geminiApiKey) restored.geminiApiKey = current.geminiApiKey;
  return restored;
}
function mergeRace(restored, current) {
  const pw = new Map((current.servers || []).filter((s) => s.password).map((s) => [s.id ?? `${s.ip}:${s.port}`, s.password]));
  for (const s of restored.servers || []) if (!s.password) s.password = pw.get(s.id ?? `${s.ip}:${s.port}`) || pw.get(`${s.ip}:${s.port}`) || '';
  return restored;
}
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } };

/** -> null (nothing to do) or {ok, files, error} */
export function applyPendingRestore(dataDir) {
  const dir = path.join(dataDir, PENDING);
  const manifestFile = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestFile)) return null;
  const done = [];
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    for (const name of manifest.files || []) {
      const from = path.join(dir, name), to = path.join(dataDir, name);
      if (!fs.existsSync(from) || path.dirname(to) !== dataDir) continue; // only top-level files of data\
      if (name === 'telemetry.db') for (const ext of ['', '-wal', '-shm']) fs.rmSync(to + ext, { force: true });
      if (name === 'settings.json') fs.writeFileSync(to, JSON.stringify(mergeSettings(readJson(from), readJson(to)), null, 2));
      else if (name === 'race.json') fs.writeFileSync(to, JSON.stringify(mergeRace(readJson(from), readJson(to)), null, 2));
      else fs.copyFileSync(from, to);
      done.push(name);
    }
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`[backup] restored ${done.join(', ')} from the backup of ${manifest.createdAt ? new Date(manifest.createdAt).toISOString() : '?'}`);
    return { ok: true, files: done };
  } catch (e) {
    // never retried in a loop: the staged files are kept aside for a look, the pre-restore backup holds the old data
    try { fs.renameSync(dir, path.join(dataDir, `restore-failed-${Date.now()}`)); } catch { /* ignore */ }
    console.error(`[backup] restore failed after ${done.length} file(s): ${e.message}`);
    return { ok: false, files: done, error: e.message };
  }
}
