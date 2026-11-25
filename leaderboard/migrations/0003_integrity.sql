-- 2026-11-25 (PL10): leaderboard integrity. Canonical keys, evidence tiers (legacy for every lap stored before),
-- anomaly flags, the moderation trail, suspensions and rate-limit counters. See docs/platform/LEADERBOARD_TRUST.md.
-- NOT applied to the live database yet (needs approval). Apply it BEFORE deploying the PL10 worker.js:
--   npm run wrangler -- d1 execute acevo-paddock-leaderboard --remote --file migrations/0003_integrity.sql
-- Every statement may run more than once: the local runner (local.mjs) runs every migration at each start
-- (a column that already exists is skipped; the updates only fill what is still empty).
-- No semicolons or double dashes inside statements: the local runner splits on them.

-- canonical keys: the name in lower case (ASCII), with spaces and dashes as underscores. Boards group by these.
-- The worker computes them with the same SQL expression (worker.js KEY), so old and new rows always agree.
ALTER TABLE laps ADD COLUMN track_key TEXT;
ALTER TABLE laps ADD COLUMN layout_key TEXT;
ALTER TABLE laps ADD COLUMN car_key TEXT;
UPDATE laps SET track_key = lower(replace(replace(trim(track), ' ', '_'), '-', '_')) WHERE track_key IS NULL;
UPDATE laps SET layout_key = lower(replace(replace(trim(layout), ' ', '_'), '-', '_')) WHERE layout_key IS NULL;
UPDATE laps SET car_key = lower(replace(replace(trim(car), ' ', '_'), '-', '_')) WHERE car_key IS NULL;
CREATE INDEX IF NOT EXISTS laps_board_key ON laps (track_key, layout_key, car_key, lap_ms);
CREATE INDEX IF NOT EXISTS laps_class_key ON laps (track_key, layout_key, car_class, lap_ms);

-- evidence tier (legacy / basic / telemetry / reviewed, see worker.js TIERS). Every lap stored before this
-- migration is labelled legacy: what was checked then was not recorded per lap.
ALTER TABLE laps ADD COLUMN tier TEXT;
UPDATE laps SET tier = 'legacy' WHERE tier IS NULL;
-- anomaly flags found when the lap was stored (JSON array with their evidence), or null. Moderators only.
ALTER TABLE laps ADD COLUMN flags TEXT;

-- when a driver first signed in (players.updated_at is the latest sign-in)
ALTER TABLE players ADD COLUMN first_seen INTEGER;
UPDATE players SET first_seen = updated_at WHERE first_seen IS NULL;

-- the moderation trail: append only (no route updates or deletes a row)
CREATE TABLE IF NOT EXISTS moderation_log (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  lap_id INTEGER,
  subject TEXT,
  reason TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS moderation_lap ON moderation_log (lap_id, at);
CREATE INDEX IF NOT EXISTS moderation_at ON moderation_log (at);

-- drivers who may not send laps or reports. Kept apart from players, so deleting an account does not lift it.
CREATE TABLE IF NOT EXISTS suspensions (steam_id TEXT PRIMARY KEY, reason TEXT, actor TEXT NOT NULL, at INTEGER NOT NULL);

-- rate-limit counters per bucket and time window (IP addresses only as a hash); rows older than 2 hours are deleted
CREATE TABLE IF NOT EXISTS rate_limits (bucket TEXT NOT NULL, win INTEGER NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (bucket, win));
CREATE INDEX IF NOT EXISTS rate_limits_win ON rate_limits (win);
