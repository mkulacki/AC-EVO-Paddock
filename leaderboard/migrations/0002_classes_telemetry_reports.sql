-- 2026-11-23: class boards, light telemetry per lap, reports and hidden laps.
-- Live database:  npm run wrangler -- d1 execute acevo-paddock-leaderboard --remote --file migrations/0002_classes_telemetry_reports.sql
-- (the local runner, local.mjs, applies every file here by itself; a column that already exists is skipped)
ALTER TABLE laps ADD COLUMN car_class TEXT;                    -- GT3 / GT4 / GT2, or null: one-make and road cars have only their car board
ALTER TABLE laps ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0; -- 1 = hidden by an admin (a reported, impossible lap)
ALTER TABLE laps ADD COLUMN has_tel INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS laps_class ON laps (track, layout, car_class, lap_ms);

-- light telemetry of a lap (see worker.js TELEMETRY): gzip, base64
CREATE TABLE IF NOT EXISTS telemetry (lap_id INTEGER PRIMARY KEY, data TEXT NOT NULL);

-- "this lap looks wrong": one report per driver and lap
CREATE TABLE IF NOT EXISTS reports (lap_id INTEGER NOT NULL, reporter TEXT NOT NULL, reason TEXT, at INTEGER NOT NULL, PRIMARY KEY (lap_id, reporter));
