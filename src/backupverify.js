// PL11: verifying a backup zip. The laps database is unpacked next to the backups, opened read-only in a worker thread
// (an integrity check of a large database takes seconds and must not hold up the 60 Hz telemetry loop) and its row
// counts are compared with the manifest's. The small files must parse, and a backup made without secrets must hold none.
// Used by src/autobackup.js (every scheduled backup) and by "Verify" in Settings → Backup and restore.
import fs from 'node:fs';
import path from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';

// ---------------------------------------------------------------- worker side: open the copy, check it, count rows
const COUNTED = { laps: 'laps', sessions: 'sessions', reports: 'reports', brakeMarks: 'brake_marks' };
function checkDbFile(file) {
  const t = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = t.prepare('PRAGMA integrity_check(20)').all().map((r) => Object.values(r)[0]);
    const tables = new Set(t.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
    const counts = {};
    for (const [k, table] of Object.entries(COUNTED)) counts[k] = tables.has(table) ? t.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n : null;
    return { integrity: rows.length === 1 && rows[0] === 'ok' ? 'ok' : rows.slice(0, 5).join('; '), counts, schema: t.prepare('PRAGMA user_version').get().user_version };
  } finally { t.close(); }
}
if (!isMainThread && workerData?.verifyDb) {
  try { parentPort.postMessage({ ok: true, result: checkDbFile(workerData.verifyDb) }); }
  catch (e) { parentPort.postMessage({ ok: false, error: e.message }); }
}

// ---------------------------------------------------------------- main side
/** Check a database file in a worker thread. -> {integrity: 'ok' | problems, counts, schema} (rejects if it cannot be opened) */
export function checkDb(file) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL(import.meta.url), { workerData: { verifyDb: file } });
    let done = false;
    w.once('message', (m) => { done = true; if (m.ok) resolve(m.result); else reject(new Error(m.error)); });
    w.once('error', (e) => { done = true; reject(e); });
    w.once('exit', (code) => { if (!done) reject(new Error(`the check stopped (exit ${code})`)); });
  });
}

/**
 * Verify one backup zip. deps: {inspect, list, extract, readEntry} from src/backup.js and src/zip.js (passed in, so this
 * module has no cycle with backup.js). tmpDir: where the database copy is unpacked (removed again afterwards).
 * -> {ok, checkedAt, problems: [text], counts, integrity}
 */
export async function verifyZip(file, { inspect, list, extract, readEntry }, tmpDir) {
  const out = { ok: false, checkedAt: Date.now(), problems: [], counts: null, integrity: null };
  let m;
  try { m = inspect(file); } catch (e) { out.problems.push(e.message); return out; }
  const entries = list(file);
  // the small files: must parse; a backup made without secrets must not hold the Gemini key, a sign-in or a password
  for (const name of ['settings.json', 'race.json', 'setup-meta.json']) {
    if (!m.files.includes(name)) continue;
    let obj;
    try { obj = JSON.parse(readEntry(file, name, { maxSize: 64 * 1024 * 1024 }).toString('utf8')); }
    catch (e) { out.problems.push(`${name} cannot be read (${e.message})`); continue; }
    if (name === 'settings.json') {
      if (obj?.boardToken || obj?.boardSteam) out.problems.push('settings.json holds a leaderboard sign-in');
      if (!m.includesSecrets && obj?.geminiApiKey) out.problems.push('settings.json holds a Gemini key although the backup says it has none');
    }
    if (name === 'race.json' && !m.includesSecrets && /"password"\s*:\s*"[^"]/.test(JSON.stringify(obj))) out.problems.push('race.json holds a server password although the backup says it has none');
  }
  const dbEntry = m.files.includes('telemetry.db') ? entries.find((e) => e.name === 'telemetry.db') : null;
  if (dbEntry) {
    const tmp = path.join(tmpDir, `.verify-${process.pid}-${Date.now()}.db`);
    try {
      await extract(file, dbEntry, tmp);
      const r = await checkDb(tmp);
      out.integrity = r.integrity; out.counts = r.counts;
      if (r.integrity !== 'ok') out.problems.push(`the laps database is damaged: ${r.integrity}`);
      // the counts the backup was made with must be the counts in the copy
      const c = m.counts && typeof m.counts === 'object' ? m.counts : null;
      if (c) for (const k of Object.keys(COUNTED)) if (Number.isFinite(c[k]) && r.counts[k] !== c[k]) out.problems.push(`${k}: ${r.counts[k] ?? 'none'} in the copy, ${c[k]} when it was made`);
    } catch (e) { out.problems.push(`the laps database cannot be opened: ${e.message}`); }
    finally { fs.rmSync(tmp, { force: true }); }
  }
  out.ok = !out.problems.length;
  return out;
}
