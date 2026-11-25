-- The database layout of AC EVO Paddock 0.7.0-beta.1 (schema v1, PRAGMA user_version = 1), as its src/db.js
-- creates it: dumped from sqlite_master of an empty database made by that release (git tag v0.7.0-beta.1).
-- Schema only, no data. Used by test/notes.test.js to check the v1 -> v2 upgrade (PL5).
CREATE TABLE sessions (
  id INTEGER PRIMARY KEY, track TEXT, layout TEXT, car TEXT, session_type INTEGER,
  driver TEXT, started_at INTEGER
, conditions TEXT);
CREATE TABLE laps (
  id INTEGER PRIMARY KEY, session_id INTEGER, track TEXT, layout TEXT, car TEXT,
  lap_number INTEGER, lap_time_ms INTEGER, valid INTEGER, driver TEXT,
  source TEXT DEFAULT 'local', recorded_at INTEGER, track_length REAL, samples INTEGER,
  data BLOB
, setup_name TEXT, setup_info TEXT, aids TEXT, cond TEXT, board TEXT);
CREATE INDEX laps_combo ON laps(track, layout, car);
CREATE TABLE analyses (
  id INTEGER PRIMARY KEY, lap_id INTEGER, ref_key TEXT, model TEXT, created_at INTEGER, text TEXT
);
CREATE TABLE setup_snapshots (hash TEXT PRIMARY KEY, data TEXT);
CREATE TABLE reports (session_id INTEGER PRIMARY KEY, created_at INTEGER, data TEXT, ai_text TEXT, ai_model TEXT, ai_at INTEGER);
CREATE TABLE brake_marks (
  id INTEGER PRIMARY KEY, track TEXT, layout TEXT, car TEXT, pos REAL, kind TEXT, created_at INTEGER
);
CREATE INDEX brake_marks_combo ON brake_marks(track, layout, car);
CREATE TABLE coach_messages (
  id INTEGER PRIMARY KEY, track TEXT, layout TEXT, car TEXT, role TEXT, text TEXT, model TEXT, created_at INTEGER
);
CREATE INDEX coach_messages_combo ON coach_messages(track, layout, car);
CREATE TABLE training_plans (
  id INTEGER PRIMARY KEY, track TEXT, layout TEXT, car TEXT, from_session INTEGER, from_started_at INTEGER,
  targets TEXT, created_at INTEGER, closed_at INTEGER
);
CREATE INDEX training_plans_combo ON training_plans(track, layout, car);
CREATE TABLE goals (
  id INTEGER PRIMARY KEY, track TEXT, layout TEXT, car TEXT, kind TEXT, target REAL, extra TEXT, origin TEXT,
  created_at INTEGER, due_at INTEGER, met_at INTEGER, met_session INTEGER, met_lap INTEGER, met_value REAL
);
CREATE INDEX goals_combo ON goals(track, layout, car);
CREATE TABLE launches (
  id INTEGER PRIMARY KEY, at INTEGER, mode TEXT, track_id TEXT, layout_key TEXT, car TEXT, summary TEXT, planned_min REAL, goal_id INTEGER
);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
PRAGMA user_version = 1;
