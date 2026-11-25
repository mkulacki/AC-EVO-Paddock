-- The database layout of AC EVO Paddock after PL7 (schema v3, PRAGMA user_version = 3), as its src/db.js creates it:
-- dumped from sqlite_master of an empty database made by src/db.js at commit 87b3131 (the PL7 merge), before PL8.
-- Schema only, no data. Used by test/experiments-db.test.js to check the v3 -> v4 upgrade (PL8).
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
CREATE TABLE session_notes (session_id INTEGER PRIMARY KEY, text TEXT NOT NULL DEFAULT '', updated_at INTEGER);
CREATE TABLE session_tags (session_id INTEGER NOT NULL, tag TEXT NOT NULL, PRIMARY KEY (session_id, tag));
CREATE INDEX session_tags_tag ON session_tags(tag);
CREATE TABLE corner_bookmarks (id INTEGER PRIMARY KEY, session_id INTEGER, track TEXT, layout TEXT, car TEXT,
          corner TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_at INTEGER);
CREATE INDEX corner_bookmarks_combo ON corner_bookmarks(track, layout, car);
CREATE INDEX corner_bookmarks_session ON corner_bookmarks(session_id);
CREATE TABLE drill_events (id INTEGER PRIMARY KEY, goal_id INTEGER NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT);
CREATE INDEX drill_events_goal ON drill_events(goal_id);
PRAGMA user_version = 3;
