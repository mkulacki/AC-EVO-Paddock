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

const LAP_COLS = 'id, session_id, track, layout, car, lap_number, lap_time_ms, valid, driver, source, recorded_at, track_length, samples';

export const encodeData = (cols) => zlib.gzipSync(JSON.stringify(cols));
export const decodeData = (blob) => JSON.parse(zlib.gunzipSync(blob).toString());

export function createSession(s) {
  const r = db.prepare('INSERT INTO sessions (track, layout, car, session_type, driver, started_at) VALUES (?,?,?,?,?,?)')
    .run(s.track, s.layout, s.car, s.sessionType, s.driver, s.startedAt);
  return Number(r.lastInsertRowid);
}

export function insertLap(l) {
  const r = db.prepare(`INSERT INTO laps (session_id, track, layout, car, lap_number, lap_time_ms, valid, driver, source, recorded_at, track_length, samples, data)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(l.sessionId ?? null, l.track, l.layout, l.car, l.lapNumber, l.lapTimeMs, l.valid ? 1 : 0, l.driver,
      l.source || 'local', l.recordedAt, l.trackLength, l.data.t.length, encodeData(l.data));
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
  db.prepare('DELETE FROM laps WHERE id = ?').run(id);
  db.prepare('DELETE FROM analyses WHERE lap_id = ?').run(id);
}

export function saveAnalysis(lapId, refKey, model, text) {
  db.prepare('INSERT INTO analyses (lap_id, ref_key, model, created_at, text) VALUES (?,?,?,?,?)')
    .run(lapId, refKey, model, Date.now(), text);
}
export const getAnalysis = (lapId, refKey) =>
  db.prepare('SELECT * FROM analyses WHERE lap_id = ? AND ref_key = ? ORDER BY created_at DESC LIMIT 1').get(lapId, refKey);
