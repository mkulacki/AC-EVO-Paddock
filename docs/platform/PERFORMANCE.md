# Recording performance (PL3)

How fast Paddock records and how long its bigger jobs take, measured on the mock telemetry source with seeded data.
Numbers before and after the PL3 changes, the budgets they are held to, and how to measure again.

> **Not verified here:** real shared-memory timing (the game's update rate, `koffi` read cost, Windows scheduling while
> AC EVO runs), behaviour in game, and slower PCs. Everything below comes from `--mock` and synthetic laps on one
> development PC. The mock produces frames on demand, so it cannot show frames the game publishes and Paddock misses
> for reasons outside its own event loop.

## Method

- **Command:** `npm run bench` (about 4 minutes; `-- --quick` ~1 minute, `-- --only lapsave,tick,history,live`,
  `-- --out file.json`). Not part of `npm test`. Source: `test/perf.bench.js`.
- **Data:** a scratch data dir and AC EVO user folder under `%TEMP%\paddock-tests` (`test/helpers.js` `isolate`);
  never `data\`, the installed app's `data\` or `Saved Games\ACE`. Never real shared memory. The game's
  `content.kspkg` is **read** if AC EVO is installed (car and track catalogue), as the tests already do.
- **Laps:** 12 laps driven by the mock car (`src/mock.js` `seedLaps`, `Math.random` seeded with 7), full density:
  4,542 samples at 60 Hz plus 649 car samples at 10 Hz, 652 kB of JSON, 129 kB gzipped (a 75 s lap). Large histories
  are copies of these rows with new ids (so nothing is cached for them), spread over sessions of 15 laps and, for the
  history scenario, over 40 cars/tracks.
- **Scenarios:**
  1. **lap save:** `JSON.stringify`, `db.encodeData` (JSON + gzip), `db.decodeData` and `db.insertLap` of one lap, 20 times.
  2. **tick:** what the 60 Hz tick does for the recorder and the HUD (`Recorder.onFrame`, `LiveHud.onFrame`,
     `LiveHud.snapshot`), frame after frame as fast as possible with a turn of the event loop between frames, for 3 laps,
     with 0 / 100 / 300 / 600 laps of history on the same car and track. *hold* = how long the loop was busy before a
     frame could run (its own work plus background work in between), i.e. what a 60 Hz tick would have waited.
  3. **history:** routes and jobs over 1,000 and 5,000 laps (122 MB and 616 MB database): lap list, Laps page
     (`overview`), Home (`dashboard`), Development, consistency, progress, session report, CSV export, lap export and
     import parse, `VACUUM INTO` and a full backup.
  4. **live:** the real server (`src/server.js --mock 4`, with `PADDOCK_HIRES_TIMER=1` so the mock gets the same 1 ms
     Windows timer as a real run) on the history of the earlier scenarios, for 75 s, with a page loaded every 2 s
     (Laps, Home, Development, status, HUD); then its own `/api/diagnostics/perf`.
- **Machine:** Windows 10 Pro 22H2, Node 22.23.4 (the Electron app ships Node 24.22.2). One run per table; two full runs of the
  baseline differed by under 5 % on the long times (e.g. Laps page cold at 5,000 laps 35.1 s vs 36.1 s) and up to
  ~20 % on single-digit milliseconds. The numbers are indicative, not a specification of the user's PC.
- **In the app:** `src/perf.js` keeps the same kind of numbers while Paddock runs (Settings → Diagnostics, or
  `GET /api/diagnostics/perf`): tick interval and tick work histograms, late ticks, an estimate of missed frames,
  stalls (> 250 ms), event-loop delay (`perf_hooks.monitorEventLoopDelay`, 10 ms resolution), lap save / lap events /
  HUD reference load times, failures of the HUD reference load, the 20 most recent slow requests (≥ 50 ms, by route,
  no query) and memory once a minute for the last hour. All fixed-size; nothing is logged per sample.

## Budgets

| What | Budget | Why |
| --- | --- | --- |
| Tick work, normal frame | p99 ≤ 1 ms | 6 % of a 16.7 ms frame; leaves room for the HUD bridge (10 ms timer) and HTTP |
| Longest hold of the 60 Hz loop while driving (lap end, session start, any page) | ≤ 33 ms (2 frames) | at most one frame lost; the recorder interpolates by distance, so one missing sample at 60 Hz is not visible in analysis |
| Lap save inside the tick | ≤ 33 ms for a lap up to ~2 min | same as above; a lap save is once per lap |
| HUD references ready after a session start | ≤ 5 s for 600 laps on the car and track | the out lap takes longer than that; until then the HUD shows no reference, as with no laps |
| Pages (Laps, Home, report) | no hold over 33 ms; first open may take longer (OD-PL-11) | the recording must not depend on what the driver opens |
| Backup / `VACUUM INTO` | none: refused on track (`src/server.js` `busy()`) | 0.5–2.7 s of synchronous work |
| Memory of the new caches | ≤ ~25 MB (100,000 small entries) | the resampled-lap cache (300 laps, ~75 MB) is unchanged |

## Results

"Before" = commit `6871189` (diagnostics and bench only, no fix); "after" = `1aa4251`. Times in ms.

### 1. Lap save (unchanged)

| Step | Median | Max of 20 |
| --- | --- | --- |
| `JSON.stringify` of the lap | 7.0 | 7.3 |
| `encodeData` (stringify + gzip level 6) | 19.6 | 24.3 |
| `decodeData` (gunzip + parse) | 6.3 | 10.5 |
| `insertLap` (encode + SQLite insert, WAL) | 21.4 | 37.9 |

gzip alone on the same JSON: level 6 12.5 ms / 128.6 kB, level 3 5.7 ms / 145.9 kB (+13 %), level 1 4.4 ms / 156.4 kB
(+22 %). Within budget for a 75 s lap; scales with lap length. Not changed: OD-PL-10 in `docs/DECISIONS.md`.

### 2. Telemetry tick with history on the same car and track

| History | Longest hold, before | Longest hold, after | Lap end hold, before → after | HUD references ready after |
| --- | --- | --- | --- | --- |
| 12 laps | 638 ¹ | 527 ¹ | 37 → 25 | 0.6 s before (in the tick) → 0.6 s ¹ |
| 112 | 666 | **26** | 35 → 25 | 0.7 s → 0.7 s (background) |
| 312 | 1,537 | **25** | 37 → 25 | 1.5 s → 1.5 s (background) |
| 612 | **7,424** | **26** | **4,980** → 25 | 7.4 s → 2.5 s (background) |

Normal frames: p99 ≤ 0.25 ms (the smallest histogram bucket) before and after.
¹ The first live frame of the process reads AC EVO's car catalogue from `content.kspkg` (~0.5 s, once per process). In
the app this already happens 3 s after start (`cars.warmThumbnails`), and since PL3 the track list too
(`src/server.js` listen callback), so it only falls in a session that starts in the first 3 s.
Past 300 laps the lap-end hold was a cache thrash: the resampled-lap cache (300 entries, insertion order) was emptied
and refilled by every ideal-lap calculation, so every lap end read the whole history again.

### 3. Large history (routes and jobs)

| Job | 1,000 laps before | 1,000 laps after | 5,000 laps before | 5,000 laps after |
| --- | --- | --- | --- | --- |
| Laps page, first open: hold | 3,127 | **22** (ready in 3.2 s) | 36,063 | **55** (ready in 29.6 s) |
| Home, first open: hold | 5,152 | **14** | 6,705 | **58** |
| Session report, first: hold | 100 | **25–64** | 894 | 84 ² |
| Laps page after a lap is deleted (everything worked out again) | not measured | 575 | not measured | 2,270 ³ |
| Lap list (`listLaps`) | 2.1 | 2.1 | 21 | 21 |
| Development page | 6.7 | 6.5 | 45 | 44 |
| Consistency (warm / first) | 7.9 / 19 | 7.9 / 9 | 43 / 43 | 43 / 89 |
| Laps CSV export | 8.6 | 8.4 | 49 | 48 |
| Lap export / import parse | 28 / 7.3 | 28 / 7.4 | 28 / 7.2 | 28 / 7.3 |
| `VACUUM INTO` (backup copy, synchronous) | 538 | 572 | 2,673 | 2,767–3,741 |
| Full backup (zip, mostly asynchronous) | 3,884 | 3,951 | 19,843 | 19,341 |

² Measured in a fresh process after the track list was read; one run inside the long bench showed a single 0.66 s
hold that did not reproduce (probably a garbage collection after the 30 s Laps warm-up; not confirmed). The report
itself still runs at once: ~80 ms of technique metrics for the session's laps, over the 33 ms budget but only at the end
of a session or when the report page is opened.
³ `svc.invalidate()` after a delete or import: synchronous, but only the best and the corner-winning laps are read
again (the kept corner times stay valid). Deleting laps is a menu action.

### 4. Live server (75 s, `--mock 4`, ~5,000 laps of history, ~600 on the driven car and track, a page every 2 s)

| Number (`/api/diagnostics/perf`) | Before | After |
| --- | --- | --- |
| Longest tick interval | **44,046** | 576 ¹ |
| Event-loop delay max / p99 | 44,057 / 12 | 582 ¹ / 22 |
| Late ticks / missed frames (estimate) / stalls > 250 ms | 10 / 3,076 / 2 | 24 / 133 / 1 ¹ |
| Ticks in 75 s | 1,477 | 4,191 |
| HUD reference load | 10,730 inside the tick | 100 – 16,365 in the background (shares the loop with the Laps warm-up) |
| Laps page / Home answered after | 33,293 / 6,718 (loop blocked) | 44,726 / 122 (loop running) |
| Laps saved in the run | 0 | 3 |
| Memory (RSS / heap) after 1–2 min | 384 → 283 MB / 118 MB | 181 → 489 MB / 128 MB |

Even without stalls the mock loop's interval is p50 17–20 ms and p95 25 ms (mean 18.2 ms, ~55 ticks/s instead of 60)
with the 1 ms Windows timer. That is how Node's `setInterval(…, 1000 / 60)` runs on Windows; it is unchanged by PL3 and
unverified against real shared memory (whether the game's own update rate makes a missed tick visible in a lap).

## Remaining over budget or unverified

- Consistency page and the AI coach context still read every lap of a car and track at once (they need whole traces):
  ~8 ms per lap not in the 300-lap cache, so seconds with hundreds of laps if opened while driving.
- Lap save in the tick (OD-PL-10) for long laps; the first Laps/Home open with a long history (OD-PL-11).
- Session report ~80 ms at once (above).
- Real shared-memory timing, the game's own frame rate and slower PCs: not measured.
