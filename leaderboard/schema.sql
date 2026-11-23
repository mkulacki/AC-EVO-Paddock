-- AC EVO Paddock online leaderboard (Cloudflare D1 / SQLite).
-- Every lap a driver submits is kept, so a board filtered by conditions can still find each driver's best
-- lap within the filter. The app only submits personal bests, so this stays small.
CREATE TABLE IF NOT EXISTS laps (
  id INTEGER PRIMARY KEY,
  player_id TEXT NOT NULL,      -- random id made by the app (Steam id later)
  player_name TEXT NOT NULL,
  ref TEXT NOT NULL,            -- the app's own lap id: the same lap sent twice is stored once
  track TEXT NOT NULL, layout TEXT NOT NULL, car TEXT NOT NULL,
  lap_ms INTEGER NOT NULL,
  sectors TEXT NOT NULL,        -- JSON array of sector times (ms), adding up to lap_ms
  air_c REAL, road_c REAL,      -- averaged over the lap
  weather TEXT, grip TEXT,      -- when the session was started from Paddock's Race tab, else null
  game TEXT,                    -- AC EVO version
  app TEXT,                     -- Paddock version
  driven_at INTEGER NOT NULL,   -- when the lap was driven (ms)
  received_at INTEGER NOT NULL,
  UNIQUE (player_id, ref)
);
CREATE INDEX IF NOT EXISTS laps_board ON laps (track, layout, car, lap_ms);
CREATE INDEX IF NOT EXISTS laps_player ON laps (player_id, received_at);
