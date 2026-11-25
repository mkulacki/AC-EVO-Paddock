# PL3 report: recording reliability and performance

- **Date:** 2026-11-24 · **Branch:** `platform/pl3-recording-perf` (from `e8a6528`, the PL1D merge)
- **Scope:** `docs/platform/BACKLOG.md` PL3: bounded timing diagnostics, mock scenarios with seeded large histories, `docs/platform/PERFORMANCE.md`, fixes only for demonstrated bottlenecks.
- **Result:** complete for what can be measured here. Real shared-memory timing and in-game behaviour are unverified. Nothing pushed.

## What changed

| Commit | Change |
| --- | --- |
| `6871189` | **Measure first.** `src/perf.js`: fixed-size histograms (20 buckets), counters and small rings: tick interval and tick work, late ticks, missed-frame estimate, stalls > 250 ms, `monitorEventLoopDelay` (started by the server, not on import), lap save / lap events / HUD reference times, slow requests (route only, no query), memory once a minute for an hour. Wired into the 60 Hz loop (`src/server.js:271-292`), `src/recorder.js:117-120` and the HTTP server (`:1042`). `GET /api/diagnostics/perf` (matched by the existing `PRIVATE_GET` origin guard) and a `performance` section in `/api/diagnostics`. `test/perf.bench.js` + `npm run bench` (four scenarios, scratch dirs, not in `npm test`). `PADDOCK_HIRES_TIMER` gives a mock run the 1 ms Windows timer a real run has (`src/server.js:59`). |
| `510ab6e` | **Fix: long-history work in slices.** `src/service.js`: `comboSteps` generator (`:67`) run at once by `comboInfo` or in ~8 ms slices by `comboInfoAsync` (`:138`, one shared run per car/track, a result computed while laps changed is returned but not cached); per-lap corner/sector times kept by lap id + grid/corner signature (`lapPoints` `:94`, `lapCornerTimes` `:106`, 100,000 entries); the ideal lap reads only the corner-winning laps in full (`src/analysis.js:325` `pickIdealCorners`, `buildIdeal` with `grid`/`getR`); the resampled-lap cache is LRU. `src/live.js:69-120`: HUD references prepared in the background (kept for the same car/track meanwhile; a failure is logged, counted and retried after the next lap; a session change or new lap drops a running load); sector times via `sectorSteps` (`:415`). `src/report.js`: corner times from the kept values, traces read lazily. `src/server.js:351-370` `warmFor`/`warmSession`: Laps, Home, report and car/track routes warm in slices first; the automatic session report too; track list read 3.5 s after start. `test/perf.test.js` (10 tests), smoke test covers `/api/diagnostics/perf`. |
| `1aa4251` | `progress` (Home trends) uses the kept corner times; report routes also warm the previous session's laps (`src/report.js:174` `previousSession`). |
| `6c1d08a` | **Review fixes** (independent review; items 1–2 reproduced): (1) `invalidate()` drops the running `comboInfoAsync` of that car/track, so a call after a new lap never joins a run that started before it (it returned the old best lap, and the HUD kept it until the next lap); (2) a deleted lap's resampled trace and kept corner/sector times are dropped at once (`db.onLapDeleted` → `src/service.js` `forgetLap`; the kept values are now per lap id), because SQLite gives the id of the newest lap to the next one; (3) a new session on the same car/track keeps only the all-time references while loading (`src/live.js` `withoutSession`); (4) the best or a corner-winning lap deleted during a sliced run gives no best/ideal for that (uncached) run instead of an error. `runInSlices` now always gives the loop a turn at the first yield. 4 regression tests in `test/perf.test.js`, each failing without its fix. |
| (docs commit) | `docs/platform/PERFORMANCE.md`, this report, `docs/DECISIONS.md` (D-PL3-1 … 4, OD-PL-10, OD-PL-11), BACKLOG, ARCHITECTURE (Recording row), FEATURE_INVENTORY, CHANGELOG, PHASE_LOG, DEVELOPMENT_STATE. |

## Verified findings / rejected assumptions / unresolved

| # | Hypothesis / finding | Status | Evidence |
| --- | --- | --- | --- |
| F1 | The HUD's reference load runs inside the 60 Hz tick and scales with the history | **Verified (runtime, mock)**: 0.7 s at 112 laps, 7.4 s at 612 laps on one car/track at session start | `src/live.js` `loadRefs` called from `onFrame` (before: `:64-89`); bench scenario 2 |
| F2 | Past 300 laps on one car/track every lap end re-reads the whole history | **Verified**: 5.0 s per lap end at 612 laps; the 300-entry insertion-order cache was refilled by each ideal-lap calculation | `src/service.js` `getResampled` (cap 300) + `comboInfo` (before: `:40-76`) |
| F3 | Pages hold up recording | **Verified**: first Laps page 3.1 s (1,000 laps) / 36 s (5,000); Home 5–7 s (its trends read every lap of the 3 busiest cars/tracks); live run: 44 s loop stop, ~3,076 frames missed in 75 s, 0 laps saved | bench scenarios 3 and 4 |
| F4 | `zlib.gzipSync` on lap save is a bottleneck | **Rejected for now**: 19.6 ms encode, 21.4 ms with insert for a 75 s lap (one frame); within budget. Long laps scale linearly (OD-PL-10) | scenario 1 |
| F5 | Synchronous `VACUUM INTO` backups stall recording | **Verified cost, already guarded**: 0.5–3.7 s, refused on track | `src/server.js` `busy()` (`/api/backup*` 409 while `inSession()`) |
| F6 | `listLaps()` full scans on report/goal paths | **Rejected as a bottleneck**: 21 ms at 5,000 laps; Development 45 ms | scenario 3 |
| F7 | `JSON.parse` of report blobs | **Rejected**: not visible in any profile; Home with reports 53 ms at 5,000 laps once warm | scenario 3 |
| F8 | The first live frame reads AC EVO's car catalogue (~0.5 s, once per process) | **Verified**, not changed: the app already reads it 3 s after start; PL3 adds the track list at 3.5 s | `src/live.js` `redline` → `src/cars.js`; `src/server.js` listen callback |
| F9 | The mock 60 Hz loop runs at ~55 ticks/s (p50 17–20 ms, p95 25 ms) even when idle | **Verified on mock**, unresolved for real shared memory | scenario 4 after the fix |
| U1 | Real shared-memory timing (game update rate, `koffi` read cost, scheduling with the game running) | **Unresolved**: cannot run here | — |

## Tests run and results

- `npm run check`: 116/116 → **119/119** (`src/perf.js`, `test/perf.bench.js`, `test/perf.test.js`).
- After the review fixes: `npm test` **240/240**, `npm run test:electron` **240/240**, `npm run check` 119/119, `npm run test:browser` 13/13; bench tick scenario unchanged (longest hold 25–26 ms).
- `npm test` (Node 22.23.4): 226/226 → **236/236** (new `test/perf.test.js`: histogram bounds, loop timing from an injected clock, event-loop monitor start/stop, ideal-lap equivalence with the whole-trace calculation, `comboInfoAsync` equivalence + event loop turns + one shared run, no caching after a change meanwhile, report corner times, HUD references in the background, cancellation on session change, unreadable lap data → no reference + Diagnostics count + recovery after a lap; smoke test: `/api/diagnostics/perf` numbers only, refused cross-site/same-site).
- `npm run test:electron` (Node 24.22.2, Electron 44.11.1): **236/236**.
- `npm run test:browser` (headless Edge): **13/13**.
- `npm run bench`: three full runs (before, after, after the follow-up) plus partial runs; results in `docs/platform/PERFORMANCE.md`.

## Checks that could not run

- Real shared memory and AC EVO itself (timing, the in-game HUD reading the slot files while references load). Windows-only behaviour was measured on this one PC; no slower hardware.
- `npm run smoke:packaged` was not rerun (no packaging change; port 8080 left alone).

## Performance or compatibility impact

- Longest hold of the 60 Hz loop: 7.4 s → 26 ms (612 laps, session start), 5.0 s → 25 ms (lap end), 36 s → 55 ms (Laps page, 5,000 laps), 6.7 s → 58 ms (Home). Live run: longest tick gap 44 s → 0.58 s (the one-off catalogue read at start), missed frames 3,076 → 133.
- Same results: equivalence tests for the ideal lap, the async path and report corner times. The HUD shows its references 0.6–2.5 s after a session start in the background (before: the loop stopped that long); after a lap it keeps the old references until new ones are ready (D-PL3-3).
- Memory: new caches ≤ ~25 MB worst case; RSS in the live run 489 MB with 5,000 laps after the Laps page warm-up (before: 283–384 MB with the loop blocked, different moment of measurement).
- API: `/api/diagnostics` gains `performance`; new `/api/diagnostics/perf`. No change to the HUD protocol, `trainerhud` files or the lap format.

## Migration and recovery implications

- **No DB change**: no migration, no new table, `user_version` stays 1. The kept per-lap values live in memory only and are rebuilt after a restart. OD-PL-11 (b) would be the first PL3-related DB change and would need the migration rules.
- A failed background reference load leaves the HUD without a reference (as with no laps), logs `[hud] reference load failed`, counts `performance.errors.hudRefs` and retries after the next lap or session.

## Needs approval

- Nothing to push, deploy or pay for. Push/merge of `platform/pl3-recording-perf` is the usual user decision.

## Open decisions (added to `docs/DECISIONS.md`; decided by the user on 2026-11-25: OD-PL-10 (a), OD-PL-11 (a); D-PL3-3 and D-PL3-4 confirmed)

- **OD-PL-10, compression level of saved laps.** (a) keep gzip 6 (default); (b) level 1 or 3 (4.4 / 5.7 ms instead of 12.5 ms gzip, +22 % / +13 % blob size); (c) gzip on the thread pool, insert when done (no CPU on the loop; the lap reaches the DB a few ms after its event).
- **OD-PL-11, first open of Laps/Home with a long history** (~8 s at 1,000 laps, ~30 s at 5,000; recording unaffected since PL3). (a) leave it (default); (b) persist per-lap corner times in the DB (migration); (c) warm everything in the background after start.

## Remaining risks

- Consistency page and AI coach context still read every lap of a car/track at once (whole traces needed): seconds with hundreds of laps if opened while driving.
- Session report ~80 ms at once; lap save scales with lap length (a 7-minute lap ≈ 100+ ms).
- The ~55 ticks/s mock loop rate and the effect of a missed tick on real data are unverified.
- Numbers come from one PC and synthetic laps (copies of 12 mock laps), so cache and compression behaviour on varied real laps may differ.

## Recommended next phase

PL4 (compatibility and provenance): the health panel (4.3) can show the new `performance` numbers (late ticks, stalls, reference load failures) next to telemetry freshness. Decide OD-PL-10/11 first if long laps or very large histories matter to the user.
