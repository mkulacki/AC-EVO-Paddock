import { DatabaseSync } from 'node:sqlite';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { applyPendingRestore } from './restore-apply.js';

export const DATA_DIR = path.resolve(process.env.ACEVO_DATA || 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
// a restore asked for in Settings is applied now, before the database is opened (src/backup.js)
export const restoreResult = applyPendingRestore(DATA_DIR);

/** The newest database layout this Paddock knows (user_version). */
export const SCHEMA_VERSION = 2;
// A database made by a newer Paddock (user_version above SCHEMA_VERSION) is never upgraded or written: this Paddock
// would not know what its new parts mean. It is closed again at once (nothing written: the version is read before any
// other statement) and Paddock runs on an empty database in memory, saving nothing, while Home, Integration health
// and Settings → Backup say why (review, PL5). Backups and restores are refused meanwhile.
let db = new DatabaseSync(path.join(DATA_DIR, 'telemetry.db'));
/** null, or {version, supported, message} when telemetry.db was made by a newer Paddock and is left alone. */
export const blocked = (() => {
  const v = db.prepare('PRAGMA user_version').get().user_version;
  if (v <= SCHEMA_VERSION) return null;
  db.close();
  db = new DatabaseSync(':memory:');
  const message = `Your laps database (data\telemetry.db) was made by a newer Paddock (database version ${v}; this Paddock knows up to ${SCHEMA_VERSION}). It is left untouched, and nothing you drive now is saved. Update Paddock to use it.`;
  console.error(`[db] ${message}`);
  return { version: v, supported: SCHEMA_VERSION, message };
})();
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
let preMigrationCopy = null; // the copy made before an upgrade at this start (one is enough for several steps)
// any row in any table: a database with goals or coach messages but no laps is worth a copy too (plan rule 9)
function hasUserRows() {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()
    .some((t) => db.prepare(`SELECT 1 FROM "${t.name.replace(/"/g, '""')}" LIMIT 1`).get());
}
{
  const ver = db.prepare('PRAGMA user_version').get().user_version;
  if (ver < 1) {
    const rows = db.prepare('SELECT id, track_length, data FROM laps').all();
    if (rows.length || hasUserRows()) {
      const backup = path.join(DATA_DIR, `telemetry.backup-v${ver}-${Date.now()}.db`);
      db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
      preMigrationCopy = backup;
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
  // laps.aids = JSON: TC / ABS / ESC levels, what acted, assist settings and the lap's class (src/aids.js)
  if (!cols('laps').includes('aids')) db.exec('ALTER TABLE laps ADD COLUMN aids TEXT;');
  // laps.cond = JSON: the lap's own conditions for the leaderboard {airC, roadC, weather, grip, game, app} (src/leaderboard.js)
  // laps.board = JSON: its leaderboard upload {at, ok, rank, of, error, retry}
  if (!cols('laps').includes('cond')) db.exec('ALTER TABLE laps ADD COLUMN cond TEXT; ALTER TABLE laps ADD COLUMN board TEXT;');
  if (!cols('sessions').includes('conditions')) db.exec('ALTER TABLE sessions ADD COLUMN conditions TEXT;');
  db.exec(`CREATE TABLE IF NOT EXISTS setup_snapshots (hash TEXT PRIMARY KEY, data TEXT);
    CREATE TABLE IF NOT EXISTS reports (session_id INTEGER PRIMARY KEY, created_at INTEGER, data TEXT, ai_text TEXT, ai_model TEXT, ai_at INTEGER);`);
}

const LAP_COLS = 'id, session_id, track, layout, car, lap_number, lap_time_ms, valid, driver, source, recorded_at, track_length, samples, setup_name, setup_info, aids, cond, board';

/** A consistent copy of the whole database in a new file (backups): safe while Paddock keeps using it. */
export function vacuumInto(file) {
  fs.rmSync(file, { force: true });
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
}
/** The database handle, for modules that keep their own small tables (carstats.js: lap_stats). */
export const raw = db;
/** Bytes per table (indexes counted with their table), or null when SQLite has no dbstat. */
export function tableSizes() {
  try {
    const idx = new Map(db.prepare("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index'").all().map((r) => [r.name, r.tbl_name]));
    const out = {};
    for (const r of db.prepare('SELECT name, SUM(pgsize) AS s FROM dbstat GROUP BY name').all()) { const t = idx.get(r.name) || r.name; out[t] = (out[t] || 0) + Number(r.s); }
    return out;
  } catch { return null; }
}
export const counts = () => ({
  laps: db.prepare('SELECT COUNT(*) AS n FROM laps').get().n,
  sessions: db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,
  reports: db.prepare('SELECT COUNT(*) AS n FROM reports').get().n,
  brakeMarks: db.prepare('SELECT COUNT(*) AS n FROM brake_marks').get().n,
  notes: db.prepare('SELECT COUNT(*) AS n FROM session_notes').get().n,
  bookmarks: db.prepare('SELECT COUNT(*) AS n FROM corner_bookmarks').get().n,
  schema: db.prepare('PRAGMA user_version').get().user_version,
});

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

// called with the id of each deleted lap (src/service.js forgets what it kept for it: SQLite reuses the highest id)
const lapDeletedFns = [];
export const onLapDeleted = (fn) => { lapDeletedFns.push(fn); };
export function deleteLap(id) {
  for (const fn of lapDeletedFns) fn(id);
  const sid = db.prepare('SELECT session_id FROM laps WHERE id = ?').get(id)?.session_id ?? null;
  db.exec('BEGIN');
  try {
    // its session's report is out of date: dropped (made again on request)
    if (sid != null) db.prepare('DELETE FROM reports WHERE session_id = ?').run(sid);
    db.prepare('DELETE FROM laps WHERE id = ?').run(id);
    db.prepare('DELETE FROM analyses WHERE lap_id = ?').run(id);
    // the session's last lap gone: its notes, tags and bookmarks go with it (user decision D-PL5-15)
    if (sid != null && !db.prepare('SELECT 1 FROM laps WHERE session_id = ? LIMIT 1').get(sid)) dropSessionNotes(sid);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
function dropSessionNotes(sid) {
  for (const t of ['session_notes', 'session_tags', 'corner_bookmarks']) db.prepare(`DELETE FROM ${t} WHERE session_id = ?`).run(sid);
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
const setupInfo = (su) => ({ rel: su.rel ?? null, id: su.id ?? null, match: su.match, snap: su.snap ?? null, probe: su.probe ?? null, stock: su.stock ?? null });
export function setLapAids(id, aids) { db.prepare('UPDATE laps SET aids = ? WHERE id = ?').run(aids ? JSON.stringify(aids) : null, id); }
export function setLapCond(id, c) { db.prepare('UPDATE laps SET cond = ? WHERE id = ?').run(c ? JSON.stringify(c) : null, id); }
export function setLapBoard(id, b) { db.prepare('UPDATE laps SET board = ? WHERE id = ?').run(b ? JSON.stringify(b) : null, id); }
/** The fastest valid own lap per track / layout / car / game version, among laps that carry their conditions (leaderboard). */
export const boardBests = () => db.prepare(`SELECT ${LAP_COLS} FROM laps l WHERE source = 'local' AND valid = 1 AND cond IS NOT NULL
  AND id = (SELECT id FROM laps m WHERE m.source = 'local' AND m.valid = 1 AND m.cond IS NOT NULL AND m.track = l.track AND m.layout = l.layout
    AND m.car = l.car AND json_extract(m.cond, '$.game') IS json_extract(l.cond, '$.game') ORDER BY m.lap_time_ms, m.id LIMIT 1)`).all();
/** A stored lap that is the same lap (import duplicate check, OD-PL-3): same combo, lap time, recorded time and sample count. */
export const findSameLap = (l) => db.prepare('SELECT id, driver, source, lap_time_ms, recorded_at FROM laps WHERE track = ? AND layout = ? AND car = ? AND lap_time_ms = ? AND recorded_at = ? AND samples = ? LIMIT 1')
  .get(l.track, l.layout, l.car, l.lapTimeMs, l.recordedAt, l.data.t.length) || null;
/** A leaderboard lap downloaded before (source 'online', laps.board = {online: its id on the server}). */
export const findOnlineLap = (remoteId) => db.prepare(`SELECT ${LAP_COLS} FROM laps WHERE source = 'online' AND json_extract(board, '$.online') = ?`).get(remoteId);
export const getLapAids = (id) => { const r = db.prepare('SELECT aids FROM laps WHERE id = ?').get(id); return r?.aids ? JSON.parse(r.aids) : null; };
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
export const reportSessionIds = () => db.prepare('SELECT session_id FROM reports').all().map((r) => r.session_id);
export function saveReportAi(sessionId, text, model) { db.prepare('UPDATE reports SET ai_text = ?, ai_model = ?, ai_at = ? WHERE session_id = ?').run(text, model, Date.now(), sessionId); }

// ---------------------------------------------------------------- AI coach (P8): chat per track + car, training plans
// coach_messages: the conversation with the coach per combo (the game's track / layout / car names, as in the laps);
// role 'driver' or 'coach'. training_plans: targets taken from a session report, checked against later sessions;
// closed_at set when replaced or ended. Both additive: older databases just get the new tables.
db.exec(`CREATE TABLE IF NOT EXISTS coach_messages (
  id INTEGER PRIMARY KEY, track TEXT, layout TEXT, car TEXT, role TEXT, text TEXT, model TEXT, created_at INTEGER
);
CREATE INDEX IF NOT EXISTS coach_messages_combo ON coach_messages(track, layout, car);
CREATE TABLE IF NOT EXISTS training_plans (
  id INTEGER PRIMARY KEY, track TEXT, layout TEXT, car TEXT, from_session INTEGER, from_started_at INTEGER,
  targets TEXT, created_at INTEGER, closed_at INTEGER
);
CREATE INDEX IF NOT EXISTS training_plans_combo ON training_plans(track, layout, car);`);
export const coachMessages = (c) =>
  db.prepare('SELECT id, role, text, model, created_at FROM coach_messages WHERE track = ? AND layout = ? AND car = ? ORDER BY id').all(c.track, c.layout, c.car);
export function addCoachMessages(c, msgs) {
  const st = db.prepare('INSERT INTO coach_messages (track, layout, car, role, text, model, created_at) VALUES (?,?,?,?,?,?,?)');
  db.exec('BEGIN');
  try { for (const m of msgs) st.run(c.track, c.layout, c.car, m.role, m.text, m.model ?? null, m.at ?? Date.now()); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
}
export const clearCoachMessages = (c) => db.prepare('DELETE FROM coach_messages WHERE track = ? AND layout = ? AND car = ?').run(c.track, c.layout, c.car);

const planRow = (r) => (r ? { id: r.id, combo: { track: r.track, layout: r.layout, car: r.car }, fromSession: r.from_session, fromStartedAt: r.from_started_at,
  targets: JSON.parse(r.targets), createdAt: r.created_at, closedAt: r.closed_at } : null);
export const activePlan = (c) => planRow(db.prepare('SELECT * FROM training_plans WHERE track = ? AND layout = ? AND car = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1').get(c.track, c.layout, c.car));
export const getPlan = (id) => planRow(db.prepare('SELECT * FROM training_plans WHERE id = ?').get(id));
export function createPlan(c, p) {
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE training_plans SET closed_at = ? WHERE track = ? AND layout = ? AND car = ? AND closed_at IS NULL').run(Date.now(), c.track, c.layout, c.car);
    const r = db.prepare('INSERT INTO training_plans (track, layout, car, from_session, from_started_at, targets, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(c.track, c.layout, c.car, p.fromSession, p.fromStartedAt, JSON.stringify(p.targets), Date.now());
    db.exec('COMMIT');
    return Number(r.lastInsertRowid);
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
export const setPlanTargets = (id, targets) => db.prepare('UPDATE training_plans SET targets = ? WHERE id = ?').run(JSON.stringify(targets), id);
export const closePlan = (id) => db.prepare('UPDATE training_plans SET closed_at = ? WHERE id = ? AND closed_at IS NULL').run(Date.now(), id);

// ---------------------------------------------------------------- driver development (P9): goals + challenges, launches, notes
// goals: a target per track + car (the game's names, as in the laps), checked against laps driven after created_at.
// kind lap (target = ms), consistency (target = score 0-100), streak (target = valid laps in a row in one session),
// window (target = laps in one session within extra.windowMs of extra.refMs). due_at set = a challenge (a deadline).
// met_* is stored the first time it is met, so later deleting laps does not take it back.
// launches: sessions Paddock started in the game (Race tab, hotlap, planner), for the race weekend history.
// meta: small values Paddock keeps for itself (e.g. when the achievements were last looked at).
db.exec(`CREATE TABLE IF NOT EXISTS goals (
  id INTEGER PRIMARY KEY, track TEXT, layout TEXT, car TEXT, kind TEXT, target REAL, extra TEXT, origin TEXT,
  created_at INTEGER, due_at INTEGER, met_at INTEGER, met_session INTEGER, met_lap INTEGER, met_value REAL
);
CREATE INDEX IF NOT EXISTS goals_combo ON goals(track, layout, car);
CREATE TABLE IF NOT EXISTS launches (
  id INTEGER PRIMARY KEY, at INTEGER, mode TEXT, track_id TEXT, layout_key TEXT, car TEXT, summary TEXT, planned_min REAL, goal_id INTEGER
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);`);
const goalRow = (r) => (r ? { id: r.id, combo: { track: r.track, layout: r.layout, car: r.car }, kind: r.kind, target: r.target,
  extra: r.extra ? JSON.parse(r.extra) : {}, origin: r.origin, createdAt: r.created_at, dueAt: r.due_at,
  met: r.met_at ? { at: r.met_at, sessionId: r.met_session, lapId: r.met_lap, value: r.met_value } : null } : null);
export const listGoals = () => db.prepare('SELECT * FROM goals ORDER BY id DESC').all().map(goalRow);
export const getGoal = (id) => goalRow(db.prepare('SELECT * FROM goals WHERE id = ?').get(id));
export function addGoal(g) {
  const r = db.prepare('INSERT INTO goals (track, layout, car, kind, target, extra, origin, created_at, due_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(g.combo.track, g.combo.layout, g.combo.car, g.kind, g.target, JSON.stringify(g.extra || {}), g.origin || 'me', g.createdAt ?? Date.now(), g.dueAt ?? null);
  return Number(r.lastInsertRowid);
}
export const setGoalMet = (id, m) => db.prepare('UPDATE goals SET met_at = ?, met_session = ?, met_lap = ?, met_value = ? WHERE id = ? AND met_at IS NULL')
  .run(m.at, m.sessionId ?? null, m.lapId ?? null, m.value ?? null, id);
export const deleteGoal = (id) => db.prepare('DELETE FROM goals WHERE id = ?').run(id);

export function addLaunch(l) {
  const r = db.prepare('INSERT INTO launches (at, mode, track_id, layout_key, car, summary, planned_min, goal_id) VALUES (?,?,?,?,?,?,?,?)')
    .run(l.at ?? Date.now(), l.mode, l.trackId ?? null, l.layoutKey ?? null, l.car ?? null, l.summary ?? null, l.plannedMin ?? null, l.goalId ?? null);
  return Number(r.lastInsertRowid);
}
export const listLaunches = () => db.prepare('SELECT * FROM launches ORDER BY at').all()
  .map((r) => ({ id: r.id, at: r.at, mode: r.mode, trackId: r.track_id, layoutKey: r.layout_key, car: r.car, summary: r.summary, plannedMin: r.planned_min, goalId: r.goal_id }));

// ---------------------------------------------------------------- v2 (PL5): the driver's own notes, tags and corner bookmarks
// session_notes: free text per session; session_tags: short labels per session (stored in lower case, one row each, so
// the Sessions page can filter by one); corner_bookmarks: a corner the driver wants to come back to, per track + car
// (the game's names, as in the laps), with the session it was noted in and a short note.
// Local only: never sent to the leaderboard, the AI or anyone else, and not in lap files (src/lapfile.js); they are in
// the database, so a Settings backup holds them. Sizes are bounded by src/notes.js.
// Versioned: user_version 2. New tables only, nothing existing changes, so an older Paddock can still open the file
// (it ignores tables it does not know). A copy of the database is made first, as for v1 (telemetry.backup-v1-<time>.db):
// the recovery path if the upgrade ever has to be undone (one copy per start: a v0 file upgraded to v2 in one go
// keeps the v0 copy). If that copy cannot be made (a full disk), the upgrade
// still runs: it only adds empty tables, in one transaction, and the reason is logged.
{
  const ver = db.prepare('PRAGMA user_version').get().user_version;
  if (ver < 2) {
    if (!preMigrationCopy && hasUserRows()) {
      const backup = path.join(DATA_DIR, `telemetry.backup-v${ver}-${Date.now()}.db`);
      try { vacuumInto(backup); console.log(`[db] before the v2 upgrade (notes, tags, bookmarks): copy kept as ${path.basename(backup)}`); }
      catch (e) { console.error(`[db] the copy before the v2 upgrade could not be made (${e.code || e.message}); upgrading anyway (it only adds new tables)`); }
    }
    db.exec('BEGIN');
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS session_notes (session_id INTEGER PRIMARY KEY, text TEXT NOT NULL DEFAULT '', updated_at INTEGER);
        CREATE TABLE IF NOT EXISTS session_tags (session_id INTEGER NOT NULL, tag TEXT NOT NULL, PRIMARY KEY (session_id, tag));
        CREATE INDEX IF NOT EXISTS session_tags_tag ON session_tags(tag);
        CREATE TABLE IF NOT EXISTS corner_bookmarks (id INTEGER PRIMARY KEY, session_id INTEGER, track TEXT, layout TEXT, car TEXT,
          corner TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_at INTEGER);
        CREATE INDEX IF NOT EXISTS corner_bookmarks_combo ON corner_bookmarks(track, layout, car);
        CREATE INDEX IF NOT EXISTS corner_bookmarks_session ON corner_bookmarks(session_id);
        PRAGMA user_version = 2;`);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  // notes, tags and bookmarks of sessions that have no lap left (deleted before deleteLap cleaned them up): removed
  // at start, in one transaction; cheap (one pass over laps.session_id)
  const live = 'SELECT DISTINCT session_id FROM laps WHERE session_id IS NOT NULL';
  db.exec('BEGIN');
  try {
    let n = 0;
    for (const t of ['session_notes', 'session_tags', 'corner_bookmarks']) n += Number(db.prepare(`DELETE FROM ${t} WHERE session_id IS NULL OR session_id NOT IN (${live})`).run().changes);
    db.exec('COMMIT');
    if (n) console.log(`[db] removed ${n} note, tag or bookmark row(s) of sessions without laps`);
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export const getMeta = (key) => db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
export const setMeta = (key, value) => db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
