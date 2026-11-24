// Safe reading and writing of the driver's own JSON files in data\ (settings.json, race.json, setup-meta.json).
// Written to a temp file next to the target and renamed over it, so a crash or a full disk never leaves a
// half-written file. A file that exists but cannot be read is kept aside (never silently overwritten by defaults).
// No imports from the app (usable from any module).
import fs from 'node:fs';
import path from 'node:path';

let seq = 0;
/** Writes text to file through <file>.<pid>.<n>.tmp + rename. A rename that Windows refuses (file briefly held) is retried. */
export function writeFileAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${++seq}.tmp`;
  try {
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    for (let k = 0; ; k++) {
      try { fs.renameSync(tmp, file); return; } catch (e) {
        if (k >= 4 || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e;
        const until = Date.now() + 20 * (k + 1); while (Date.now() < until) { /* short wait, sync by design */ }
      }
    }
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

export const writeJsonAtomic = (file, obj, space = 2) => writeFileAtomic(file, JSON.stringify(obj, null, space));

/**
 * Reads a JSON file. Missing → dflt. Unreadable (damaged JSON, not the expected kind of value) → the file is renamed
 * to <name>.unreadable-<time> so the next save cannot overwrite what was in it, a line is logged, and dflt is returned.
 * accept(value) says whether the parsed value is the expected kind (default: a plain object).
 */
export function readJsonSafe(file, dflt, { accept = (v) => !!v && typeof v === 'object' && !Array.isArray(v), log = console.error } = {}) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return dflt;
    log(`[data] ${path.basename(file)} cannot be read (${e.code || e.message}): using defaults for now`);
    return dflt; // locked or no permission: left where it is
  }
  let v, why = null;
  try { v = JSON.parse(text.replace(/^﻿/, '')); if (!accept(v)) why = 'unexpected content'; } catch (e) { why = e.message; }
  if (!why) return v;
  const aside = `${file}.unreadable-${Date.now()}`;
  try { fs.renameSync(file, aside); } catch { /* could not move: a later save still replaces it atomically */ }
  log(`[data] ${path.basename(file)} is damaged (${why}): kept as ${path.basename(aside)}, using defaults`);
  return dflt;
}
