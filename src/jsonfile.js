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

const TRANSIENT = ['EBUSY', 'EPERM', 'EACCES', 'EAGAIN']; // antivirus, OneDrive, another program briefly holding the file
const sleepSync = (ms) => { const until = Date.now() + ms; while (Date.now() < until) { /* sync by design: runs at start */ } };

/** Temp files of writes that never finished (a crash): they can hold a secret, so they go when the file is loaded. */
function removeStaleTemps(file) {
  const dir = path.dirname(file), base = path.basename(file);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const n of names) {
    const m = n.startsWith(`${base}.`) && /^(\d+)\.\d+\.tmp$/.exec(n.slice(base.length + 1));
    if (m && Number(m[1]) !== process.pid) fs.rmSync(path.join(dir, n), { force: true });
  }
}

// files loadJson found damaged or unreadable in this run, by full path (decision OD-PL-5: the Settings page names them).
// Only the file name and the name of the kept copy are recorded, never the folder or what was in the file.
const issues = new Map();
// (not the parse error either: JSON.parse quotes a piece of the file, which may be a key)
const noteIssue = (file, { state, aside = null, damaged = false }) => {
  if (state === 'ok' || state === 'missing') issues.delete(file);
  else issues.set(file, { file: path.basename(file), state, damaged: state === 'aside' || damaged, keptAs: aside ? path.basename(aside) : null, at: Date.now() });
};
/**
 * Files that were damaged ('aside': kept as keptAs, defaults used) or could not be read ('failed': not saved over;
 * damaged = it was damaged but could not be moved aside, else it could not be read at all), this run; dir: only that folder's.
 */
export const fileIssues = (dir = null) => [...issues].filter(([f]) => !dir || path.dirname(f) === path.resolve(dir)).map(([, x]) => ({ ...x }));

/**
 * Loads a JSON file. -> {value, state, canSave}
 *   missing  → dflt, canSave
 *   ok       → the value, canSave
 *   aside    → damaged (bad JSON, or not the expected kind of value): renamed to <name>.unreadable-<time> so a save
 *              cannot overwrite what was in it; dflt, canSave
 *   failed   → could not be read even after retries (locked, no permission), or damaged and could not be moved aside:
 *              dflt, and canSave = false: the caller must not write the file (it would replace the driver's data)
 * accept(value) says whether the parsed value is the expected kind (default: a plain object).
 */
export function loadJson(file, dflt, opts = {}) {
  const out = load(file, dflt, opts);
  noteIssue(file, out);
  return { value: out.value, state: out.state, canSave: out.canSave };
}
function load(file, dflt, { accept = (v) => !!v && typeof v === 'object' && !Array.isArray(v), log = console.error, retries = 5 } = {}) {
  removeStaleTemps(file);
  let text;
  for (let k = 0; ; k++) {
    try { text = fs.readFileSync(file, 'utf8'); break; } catch (e) {
      if (e.code === 'ENOENT') return { value: dflt, state: 'missing', canSave: true };
      if (k < retries && TRANSIENT.includes(e.code)) { sleepSync(50 * (k + 1)); continue; }
      log(`[data] ${path.basename(file)} cannot be read (${e.code || e.message}): using defaults, and it will not be saved over until it can be read`);
      return { value: dflt, state: 'failed', canSave: false };
    }
  }
  let v, why = null;
  try { v = JSON.parse((text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)); if (!accept(v)) why = 'unexpected content'; } catch (e) { why = e.message; }
  if (!why) return { value: v, state: 'ok', canSave: true };
  const aside = `${file}.unreadable-${Date.now()}`;
  try { fs.renameSync(file, aside); } catch (e) {
    log(`[data] ${path.basename(file)} is damaged (${why}) and could not be kept aside (${e.code || e.message}): using defaults, not saving over it`);
    return { value: dflt, state: 'failed', canSave: false, damaged: true };
  }
  log(`[data] ${path.basename(file)} is damaged (${why}): kept as ${path.basename(aside)}, using defaults`);
  return { value: dflt, state: 'aside', canSave: true, aside };
}

/** loadJson's value only (for files whose loss costs nothing). */
export const readJsonSafe = (file, dflt, opts) => loadJson(file, dflt, opts).value;

/** The error a module throws instead of saving over a file it could not read. */
export const notSaved = (file) => Object.assign(new Error(`${path.basename(file)} could not be read when Paddock started, so it is not saved over (your data in it is kept). Close programs that may hold it (antivirus, OneDrive) and restart Paddock.`), { code: 503 });
