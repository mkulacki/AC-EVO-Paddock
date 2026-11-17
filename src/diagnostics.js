// Diagnostics (Settings → Diagnostics): what a bug report needs, in one place, with private data taken out:
// the Gemini key, saved server passwords, the driver name and the Windows user folder never appear in it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as db from './db.js';
import * as settings from './settings.js';
import * as channels from './channels.js';

const LOG_FILE = path.join(db.DATA_DIR, 'logs', 'paddock.log'); // written by the desktop app (desktop/main.cjs)

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Removes private values from any text: secrets and names given, the user folder, anything that looks like a key. */
export function redact(text, { secrets = [], names = [] } = {}) {
  let t = String(text ?? '');
  for (const s of secrets.filter((x) => x && String(x).length >= 4)) t = t.replace(new RegExp(esc(String(s)), 'g'), '[secret]');
  for (const n of names.filter((x) => x && String(x).trim().length >= 2)) t = t.replace(new RegExp(esc(String(n).trim()), 'gi'), '[driver]');
  const home = os.homedir();
  if (home) for (const h of new Set([home, home.replace(/\\/g, '/')])) t = t.replace(new RegExp(esc(h), 'gi'), '%USERPROFILE%');
  const user = os.userInfo?.().username;
  if (user && user.length >= 3) t = t.replace(new RegExp(`([\\\\/]Users[\\\\/])${esc(user)}(?=[\\\\/]|$)`, 'gi'), '$1[user]');
  // Google API keys and GitHub tokens that are not in settings (e.g. pasted into a log line)
  return t.replace(/AIza[0-9A-Za-z_-]{20,}/g, '[secret]').replace(/\bAQ\.[A-Za-z0-9_-]{20,}/g, '[secret]').replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[secret]');
}

/** Private values to take out: the key, server passwords, driver names (settings and recorded laps). */
function privateValues() {
  const s = settings.get();
  const secrets = [s.geminiApiKey];
  try {
    const race = JSON.parse(fs.readFileSync(path.join(db.DATA_DIR, 'race.json'), 'utf8'));
    (function walk(o) { if (Array.isArray(o)) o.forEach(walk); else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { if (k === 'password' && v) secrets.push(v); else walk(v); } })(race);
  } catch { /* no saved servers */ }
  const names = [s.driverName, ...new Set(db.listLaps().map((l) => l.driver))].filter((n) => n && n !== 'Mock Driver');
  return { secrets, names };
}

function logTail(lines = 200) {
  try {
    const st = fs.statSync(LOG_FILE);
    const fd = fs.openSync(LOG_FILE, 'r');
    try {
      const len = Math.min(st.size, 256 * 1024);
      const b = Buffer.alloc(len);
      fs.readSync(fd, b, 0, len, st.size - len);
      return b.toString('utf8').split(/\r?\n/).slice(-lines).join('\n');
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}

const dirSize = (dir) => {
  let n = 0;
  try { for (const e of fs.readdirSync(dir, { withFileTypes: true })) n += e.isDirectory() ? dirSize(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size; } catch { /* gone */ }
  return n;
};
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

/**
 * The report. parts = what only the server knows: {version, source, recorder, game, loader, hud, paths}.
 * -> {data (JSON, redacted), text (redacted, to paste into an issue)}
 */
export function build(parts) {
  const s = settings.get();
  const dbFile = path.join(db.DATA_DIR, 'telemetry.db');
  const data = {
    generatedAt: new Date().toISOString(),
    paddock: { version: parts.version, desktopApp: !!process.versions.electron, electron: process.versions.electron ?? null, node: process.versions.node },
    system: { os: `${os.type()} ${os.release()} ${os.arch()}`, memoryGb: Math.round(os.totalmem() / 1073741824), cpus: os.cpus()?.length ?? null },
    data: { folder: db.DATA_DIR, databaseSize: fs.existsSync(dbFile) ? mb(fs.statSync(dbFile).size) : 'missing', backupsSize: mb(dirSize(path.join(db.DATA_DIR, 'backups'))),
      cacheSize: mb(dirSize(path.join(db.DATA_DIR, 'trackcache')) + dirSize(path.join(db.DATA_DIR, 'carcache'))), ...db.counts() },
    settings: { geminiKey: s.geminiApiKey ? 'set' : 'not set', geminiModel: s.geminiModel, language: s.language, port: s.port, gamePath: s.gamePath || 'automatic',
      aceDir: s.aceDir || 'automatic', updateCheck: s.updateCheck !== false, spotter: s.spotter?.on ? 'on' : 'off', markButton: s.markButton ? 'set' : 'none' },
    telemetry: { source: parts.source, status: parts.recorder?.status, lastFrame: parts.recorder?.lastFrameAt ? new Date(parts.recorder.lastFrameAt).toISOString() : null, savedLapsThisRun: parts.recorder?.savedLaps },
    checkedAgainstGame: channels.summary(),
    game: parts.game, loader: parts.loader, hud: parts.hud, paths: parts.paths,
  };
  const priv = privateValues();
  // value by value (in a JSON string the path separators are escaped and would slip through)
  const deep = (v) => (typeof v === 'string' ? redact(v, priv) : Array.isArray(v) ? v.map(deep)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)])) : v);
  const json = deep(data);
  const log = logTail();
  const text = [
    `AC EVO Paddock diagnostics, ${json.generatedAt}`,
    'Private data removed: Gemini key, server passwords, driver names, Windows user folder.',
    '',
    ...Object.entries(json).filter(([k]) => k !== 'generatedAt').map(([k, v]) => `## ${k}\n${typeof v === 'object' && v ? Object.entries(v).map(([a, b]) => `- ${a}: ${typeof b === 'object' && b !== null ? JSON.stringify(b) : b}`).join('\n') : v}`),
    '',
    `## log (last ${log ? log.split('\n').length : 0} lines)`,
    log ? redact(log, priv) : '(no log file: the log is written by the desktop app)',
  ].join('\n');
  return { data: json, text };
}
