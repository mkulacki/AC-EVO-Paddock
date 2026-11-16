import { DatabaseSync } from 'node:sqlite';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = path.resolve(process.env.ACEVO_DATA || 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'telemetry.db'));
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY, track TEXT, layout TEXT, car TEXT, session_type INTEGER,
  driver TEXT, started_at INTEGER
);
CREATE TABLE IF NOT EXISTS laps (
  id INTEGER PRIMARY KEY, session_id INTEGER, track TEXT, layout TEXT, car TEXT,
  lap_number INTEGER, lap_time_ms INTEGER, valid INTEGER, driver TEXT,
  source TEXT DEFAULT 'local', recorded_at INTEGER, track_length REAL, samples INTEGER,
  data BLOB
);
CREATE INDEX IF NOT EXISTS laps_combo ON laps(track, layout, car);
CREATE TABLE IF NOT EXISTS analyses (
  id INTEGER PRIMARY KEY, lap_id INTEGER, ref_key TEXT, model TEXT, created_at INTEGER, text TEXT
);
-- (a setups table existed in an unreleased build; setups are the game's own .carsetup files, see setups.js)
DROP TABLE IF EXISTS setups;
`);

// ---------------------------------------------------------------- migrations
// v1: lap distance is measured from the timing line (older laps used the game's npos zero point,
// which can be ~100 m away from the line and left a gap at start/finish).
function normaliseDistance(data, L) {
  const d = data.d, n = d.length;
  if (!n || !(L > 0)) return false;
  const out = new Array(n);
  let wrap = 0;
  for (let i = 0; i < n; i++) {
    if (i) { const jump = d[i] - d[i - 1]; if (jump < -0.5 * L) wrap += L; else if (jump > 0.5 * L) wrap -= L; }
    out[i] = d[i] + wrap;
  }
  const d0 = (Math.max(0, data.spd[0]) / 3.6) * (Math.max(0, data.t[0]) / 1000);
  const shift = d0 - out[0];
  data.d = out.map((v) => Math.round((v + shift) * 100) / 100);
  return Math.abs(shift) > 0.5;
}
{
  const ver = db.prepare('PRAGMA user_version').get().user_version;
  if (ver < 1) {
    const rows = db.prepare('SELECT id, track_length, data FROM laps').all();
    if (rows.length) {
      const backup = path.join(DATA_DIR, `telemetry.backup-v${ver}-${Date.now()}.db`);
      db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
      const upd = db.prepare('UPDATE laps SET data = ? WHERE id = ?');
      let fixed = 0;
      for (const r of rows) {
        const data = JSON.parse(zlib.gunzipSync(r.data).toString());
        if (normaliseDistance(data, r.track_length)) { upd.run(zlib.gzipSync(JSON.stringify(data)), r.id); fixed++; }
      }
      if (fixed) db.exec('DELETE FROM analyses'); // AI answers referred to the old (shifted) distances
      console.log(`[db] migrated to v1: corrected start/finish distance on ${fixed} of ${rows.length} laps (backup: ${backup})`);
    }
    db.exec('PRAGMA user_version = 1');
  }
}

// ---------------------------------------------------------------- setups per lap, conditions per session, reports
// laps.setup_name = what the lap was driven on ("Standard" = no saved setup matched); laps.setup_info = JSON
// {rel, id, match, snap}: snap points into setup_snapshots, a copy of the setup's values when the lap was driven
// (so editing the file later does not change history). sessions.conditions = JSON (temperatures, Race tab weather).
{
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  if (!cols('laps').includes('setup_name')) db.exec('ALTER TABLE laps ADD COLUMN setup_name TEXT; ALTER TABLE laps ADD COLUMN setup_info TEXT;');
  if (!cols('sessions').includes('conditions')) db.exec('ALTER TABLE sessions ADD COLUMN conditions TEXT;');
  db.exec(`CREATE TABLE IF NOT EXISTS setup_snapshots (hash TEXT PRIMARY KEY, data TEXT);
    CREATE TABLE IF NOT EXISTS reports (session_id INTEGER PRIMARY KEY, created_at INTEGER, data TEXT, ai_text TEXT, ai_model TEXT, ai_at INTEGER);`);
}

const LAP_COLS = 'id, session_id, track, layout, car, lap_number, lap_time_ms, valid, driver, source, recorded_at, track_length, samples, setup_name, setup_info';

export const encodeData = (cols) => zlib.gzipSync(JSON.stringify(cols));
export const decodeData = (blob) => JSON.parse(zlib.gunzipSync(blob).toString());

export function createSession(s) {
  const r = db.prepare('INSERT INTO sessions (track, layout, car, session_type, driver, started_at) VALUES (?,?,?,?,?,?)')
    .run(s.track, s.layout, s.car, s.sessionType, s.driver, s.startedAt);
  return Number(r.lastInsertRowid);
}

export function insertLap(l) {
  const su = l.setup || null;
  const r = db.prepare(`INSERT INTO laps (session_id, track, layout, car, lap_number, lap_time_ms, valid, driver, source, recorded_at, track_length, samples, data, setup_name, setup_info)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(l.sessionId ?? null, l.track, l.layout, l.car, l.lapNumber, l.lapTimeMs, l.valid ? 1 : 0, l.driver,
      l.source || 'local', l.recordedAt, l.trackLength, l.data.t.length, encodeData(l.data),
      su?.name ?? null, su ? JSON.stringify(setupInfo(su)) : null);
  return Number(r.lastInsertRowid);
}

export const listLaps = () => db.prepare(`SELECT ${LAP_COLS} FROM laps ORDER BY recorded_at DESC`).all();
export const listSessions = () => db.prepare('SELECT * FROM sessions ORDER BY started_at DESC').all();
export const getLapMeta = (id) => db.prepare(`SELECT ${LAP_COLS} FROM laps WHERE id = ?`).get(id);

export function getLap(id) {
  const row = db.prepare('SELECT * FROM laps WHERE id = ?').get(id);
  if (!row) return null;
  const { data, ...meta } = row;
  return { ...meta, data: decodeData(data) };
}

export const lapsForCombo = (track, layout, car, ownOnly = true) =>
  db.prepare(`SELECT ${LAP_COLS} FROM laps WHERE track = ? AND layout = ? AND car = ? ${ownOnly ? "AND source = 'local'" : ''}`)
    .all(track, layout, car);

export const bestLapOfSession = (sessionId) =>
  db.prepare(`SELECT ${LAP_COLS} FROM laps WHERE session_id = ? AND valid = 1 ORDER BY lap_time_ms LIMIT 1`).get(sessionId);

export function deleteLap(id) {
  // its session's report is out of date: dropped (made again on request)
  db.prepare('DELETE FROM reports WHERE session_id = (SELECT session_id FROM laps WHERE id = ?)').run(id);
  db.prepare('DELETE FROM laps WHERE id = ?').run(id);
  db.prepare('DELETE FROM analyses WHERE lap_id = ?').run(id);
}

export function saveAnalysis(lapId, refKey, model, text) {
  db.prepare('INSERT INTO analyses (lap_id, ref_key, model, created_at, text) VALUES (?,?,?,?,?)')
    .run(lapId, refKey, model, Date.now(), text);
}
export const getAnalysis = (lapId, refKey) =>
  db.prepare('SELECT * FROM analyses WHERE lap_id = ? AND ref_key = ? ORDER BY created_at DESC LIMIT 1').get(lapId, refKey);

// ---------------------------------------------------------------- brake marks
// The driver's own brake / lift points, per track layout and car (track = catalogue id, layout = layout key).
// pos is the fraction of the lap from the timing line (0..1), so it fits laps, live data and the track map alike.
db.exec(`CREATE TABLE IF NOT EXISTS brake_marks (
  id INTEGER PRIMARY KEY, track TEXT, layout TEXT, car TEXT, pos REAL, kind TEXT, created_at INTEGER
);
CREATE INDEX IF NOT EXISTS brake_marks_combo ON brake_marks(track, layout, car);`);
export const brakeMarks = (track, layout, car) =>
  db.prepare('SELECT id, pos, kind FROM brake_marks WHERE track = ? AND layout = ? AND car = ? ORDER BY pos').all(track, layout, car);
export const brakeMarkCars = (track, layout) =>
  db.prepare('SELECT car, COUNT(*) AS n FROM brake_marks WHERE track = ? AND layout = ? GROUP BY car ORDER BY car').all(track, layout);
export function setBrakeMarks(track, layout, car, marks) {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM brake_marks WHERE track = ? AND layout = ? AND car = ?').run(track, layout, car);
    const ins = db.prepare('INSERT INTO brake_marks (track, layout, car, pos, kind, created_at) VALUES (?,?,?,?,?,?)');
    for (const m of marks) ins.run(track, layout, car, m.pos, m.kind, Date.now());
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// ---------------------------------------------------------------- setups per lap, conditions, reports
export function saveSnapshot(hash, values) { db.prepare('INSERT OR IGNORE INTO setup_snapshots (hash, data) VALUES (?, ?)').run(hash, JSON.stringify(values)); }
export const getSnapshot = (hash) => { const r = db.prepare('SELECT data FROM setup_snapshots WHERE hash = ?').get(hash); return r ? JSON.parse(r.data) : null; };
const setupInfo = (su) => ({ rel: su.rel ?? null, id: su.id ?? null, match: su.match, snap: su.snap ?? null, probe: su.probe ?? null });
export function setLapSetups(ids, su) {
  const st = db.prepare('UPDATE laps SET setup_name = ?, setup_info = ? WHERE id = ?');
  for (const id of ids) st.run(su.name, JSON.stringify(setupInfo(su)), id);
}
export const getSession = (id) => db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
export const lapsOfSession = (id) => db.prepare(`SELECT ${LAP_COLS} FROM laps WHERE session_id = ? ORDER BY recorded_at`).all(id);
export function setSessionConditions(id, cond) { db.prepare('UPDATE sessions SET conditions = ? WHERE id = ?').run(JSON.stringify(cond), id); }
export function saveReport(sessionId, data) {
  db.prepare(`INSERT INTO reports (session_id, created_at, data) VALUES (?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET created_at = excluded.created_at, data = excluded.data`).run(sessionId, Date.now(), JSON.stringify(data));
}
export function getReport(sessionId) {
  const r = db.prepare('SELECT * FROM reports WHERE session_id = ?').get(sessionId);
  return r ? { createdAt: r.created_at, data: JSON.parse(r.data), ai: r.ai_text ? { text: r.ai_text, model: r.ai_model, at: r.ai_at } : null } : null;
}
export const listReports = () => db.prepare('SELECT session_id, created_at, data FROM reports ORDER BY created_at DESC').all()
  .map((r) => ({ sessionId: r.session_id, createdAt: r.created_at, data: JSON.parse(r.data) }));
export function saveReportAi(sessionId, text, model) { db.prepare('UPDATE reports SET ai_text = ?, ai_model = ?, ai_at = ? WHERE session_id = ?').run(text, model, Date.now(), sessionId); }
