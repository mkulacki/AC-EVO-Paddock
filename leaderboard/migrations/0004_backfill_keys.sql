-- 2026-11-25 (PL10 review): fills the canonical keys (and the legacy tier) of laps that an older worker.js stored
-- after migration 0003 ran but before the PL10 worker was deployed. Updates only: safe to run any number of times.
-- NOT applied to the live database yet (needs approval). Order: backup, 0003 (once), deploy, then this file:
--   npm run wrangler -- d1 execute acevo-paddock-leaderboard --remote --file migrations/0004_backfill_keys.sql
-- (The PL10 worker also does this by itself, at most every 10 minutes: worker.js healKeys.)
-- Do NOT run 0003 twice on D1: its ALTER TABLE lines fail the second time (only the local runner skips them).
UPDATE laps SET track_key = lower(replace(replace(trim(track), ' ', '_'), '-', '_')) WHERE track_key IS NULL;
UPDATE laps SET layout_key = lower(replace(replace(trim(layout), ' ', '_'), '-', '_')) WHERE layout_key IS NULL;
UPDATE laps SET car_key = lower(replace(replace(trim(car), ' ', '_'), '-', '_')) WHERE car_key IS NULL;
UPDATE laps SET tier = 'legacy' WHERE tier IS NULL;
