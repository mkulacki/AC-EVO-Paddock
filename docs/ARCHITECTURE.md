# Architecture: AC EVO Paddock

Audited 2026-11-17 at `main` = `de836d2` (v0.5.0-beta.1); refreshed 2026-11-17 after the P1–P9 roadmap (0.6.0-beta.1); refreshed again 2026-11-24 for platform phase PL0 at `be3b5ef` (0.7.0-beta.1: online leaderboards, board window, theme switch). This describes the code as it is, not as planned. Line numbers below are from `be3b5ef` and drift as code changes.

## Stack

| Layer | Technology | Notes |
| --- | --- | --- |
| Runtime | Node.js ≥ 22.13, ES modules | `node:sqlite` (built in) for storage, no ORM |
| Desktop shell | Electron 44.11.1 (`desktop/main.cjs`) | imports `src/server.js` **in-process**; tray, notifications, log file, overlay window. Electron 44 bundles **Node 24.22.2** (Chromium 152), `npm test` runs on the developer's Node (22.x); since PL2 `npm run test:electron` runs the same suite on the shipped Node 24 (214/214 at PL2) |
| HTTP/API | hand-written router in `src/server.js` (`node:http`) | `127.0.0.1:8080`, JSON API + static files + SSE (`/api/events`) |
| Frontend | vanilla ES modules in `public/`, no build step, no framework | hash router in `public/app.js`; charts with uPlot; fonts from `@fontsource` |
| Native | `koffi` FFI | Windows shared memory (`src/shm.js`), joystick buttons (`src/wheel.js`), `timeBeginPeriod(1)` |
| In-game HUD | `mod/trainerhud/` (Gameface UI app for the community ACE UI App Loader) | talks to Paddock via files + game log, never via network |
| Packaging | electron-builder `--win dir`, `asar: false`, unsigned | portable zip; `data\` next to the exe |
| AI | Google Gemini REST (`src/ai.js`), user's own key | optional; only compact summaries are sent; key in the `x-goog-api-key` header (`src/ai.js:57`) |
| Online leaderboard | Cloudflare Worker + D1 (`leaderboard/worker.js`, `schema.sql`, `migrations/`), client `src/leaderboard.js` | opt-in (`boardShare: false`); Steam OpenID sign-in → 180-day bearer token; `npm run board` runs it locally |

Runtime dependencies: 4 (`koffi` 3.3.7, `uplot`, two font packages). Dev: `electron` 44.11.1, `electron-builder` 26.18.0. `engines`: Node ≥ 22.13 (PL2; `node:sqlite` without a flag). Tests: built-in `node:test` (`npm test`, 214 tests in 22 files at PL2, temp data dirs, mock car, API smoke test, local leaderboard), `npm run check` (syntax of every shipped script and test helper), `npm run test:electron` (Node 24), `npm run test:browser` (headless Edge over the DevTools protocol), all four in `npm run verify`; `npm run smoke:packaged` for the built app. CI: `.github/workflows/ci.yml` (PL2; not yet run on GitHub). No lint or type-check (evaluated in PL2, decision D-PL2-1), no `npm audit` gate (D-PL2-2).

## Process and data flow

```
AC EVO shared memory ──(koffi, 60 Hz loop in server.js)──> src/shm.js ──frames──> src/recorder.js
        (or src/mock.js simulated car)                                         │  lap complete (valid/out/pit rules)
                                                                               ▼
                                                       src/db.js  (SQLite: sessions, laps[gzip JSON blob], reports…)
                                                                               │
  src/analysis.js (resample to distance grid, corners, metrics, ideal lap) <───┤
  src/service.js  (combo cache, compare, consistency, progress)          <─────┤
  src/report.js   (session report)  src/carreport.js (tyres/brakes/susp.) <────┘
                    │
  src/server.js  JSON API  ──>  public/*.js pages (hash routes)
                    │
  src/live.js (live HUD model: delta, cues) ──> src/gamebridge.js ──> live0..7.json (time-slotted) ──> in-game HUD
                                                                  <── [TrainerHUD-cmd|launch|cat] lines in game log
  src/spotter.js (when to speak) ──SSE──> public/spotter.js (plays audio)
```

### Storage (`data/`, override with `ACEVO_DATA`)

- `telemetry.db` (SQLite, WAL)
  - `sessions(id, track, layout, car, session_type, driver, started_at, conditions JSON)`
  - `laps(id, session_id, track, layout, car, lap_number, lap_time_ms, valid, driver, source, recorded_at, track_length, samples, data BLOB, setup_name, setup_info JSON)`. `data` is gzip'd JSON of column arrays: `t spd thr brk str gear rpm x z glat glon d …` at 60 Hz, plus `data.car` (10 Hz tyre/brake/suspension traces since 0.5.0).
  - `analyses` (saved AI coach answers), `reports` (session report JSON + AI debrief), `setup_snapshots` (setup values at the time a lap was driven), `brake_marks`.
  - AI coach (P8): `coach_messages` (chat per track + car), `training_plans` (targets from a report, checked against later sessions).
  - Driver development (P9): `goals` (goals and challenges, met state stored once; PL7 practice drills are goals of kind `drill`, with `drill_events` for their later history), `launches` (sessions Paddock started, for race weekends), `meta` (small values such as when achievements were last seen). Achievements are not stored: recomputed from the data.
  - Migrations: `PRAGMA user_version` (v1 distance normalisation, with an automatic `VACUUM INTO` backup; v2 (PL5) session notes, tags and corner bookmarks; v3 (PL7) `drill_events`; new tables only, one `VACUUM INTO` copy per start before upgrading) plus additive `ALTER TABLE … ADD COLUMN` checks.
- JSON files: `settings.json` (holds the Gemini key), `race.json` (server passwords), `setup-meta.json`, `mods.json`, `game-catalogue.json`, `game-applied.json`.
- Caches: `trackcache/`, `carcache/` (safe to delete). Logs: `logs/paddock.log` (desktop only).

### Game-data readers (read-only, in place)

`src/kspkg.js` (XOR'd archive table) → `src/pb.js` (protobuf) → `src/trackdata.js` (track models, corners, gates), `src/cars.js` (car catalogue, specs), `src/bc7.js` + `src/thumbworker.js` (thumbnails in a worker thread). `src/carsetup.js` reads/writes `.carsetup` against `.carsetuplimits`.

### Frontend structure

`public/app.js` is the shell: the router (`#/home`, `#/`, `#/report`, `#/compare`, `#/progress`, `#/consistency`, `#/setuphistory`, `#/coach`, `#/development`, `#/race`, `#/setups`, `#/tracks`, `#/track`, `#/game`, `#/mods`, `#/settings`), the status line and nav dots; `public/palette.js` holds the sidebar toggle, the command palette and the shortcuts. Each render gets its own cleanup list. One module per page (`sessions.js`, `compare.js`, `game.js`, `settingspage.js`,  (`race.js`, `setups.js`, `reports.js`, `telemetry.js`, `replay.js`, `carsetup.js`, …), with shared helpers in `util.js`. The design tokens are CSS custom properties in `style.css` (dark first, light via `prefers-color-scheme`).

## Integration boundaries (PL0, line references refreshed in PL2)

Where data enters or leaves Paddock, and what guards it. "Static" = read from the code, not exercised at runtime in PL0. Line numbers are as of PL2 (2026-11-24); search for the named function if they drift.

| Boundary | Where | How it works | Guards / gaps |
| --- | --- | --- | --- |
| Recording | `src/server.js:270-293` (60 Hz `setInterval`, timed by `src/perf.js`), `src/shm.js` (`OFFSETS`, koffi, kernel32 loaded lazily), `src/recorder.js` `onFrame`, lap saved (`perf.time('lapSave')`) and `'lap'` emitted at `:117-120` | one in-process timer reads a frame and feeds recorder, setup tracker, leaderboard, HUD, marker and spotter in turn; a stale packet id for 3 s ends the session | timing histograms, late/missed frames and event-loop delay since PL3 (`/api/diagnostics/perf`); the long-history work (HUD references `src/live.js:69-120`, Laps/Home/report pages `src/server.js:351-370` `warmFor`) runs in ~8 ms slices (`src/service.js:128` `runInSlices`); lap save stays in the tick (OD-PL-10); exceptions are logged per frame |
| Database + migrations | `src/db.js` (WAL `:14`; `PRAGMA user_version` v1 at `:51-66` with `VACUUM INTO` backup at `:56`; additive `ALTER TABLE` checks `:76-82`; `CREATE TABLE IF NOT EXISTS` for later tables) | single `DatabaseSync`, synchronous | versioned: v1 (distances) and v2 (PL5 notes: `session_notes`, `session_tags`, `corner_bookmarks`; `SCHEMA_VERSION`); other later schema changes are additive and unversioned. Paddock 0.7 opens a v2 file (it ignores the new tables; checked by hand) |
| Compression | lap blob = gzip'd JSON (`src/db.js:114` `decodeData`); leaderboard telemetry = `src/telcodec.js` (PLT1, 2 m grid) gzip'd | local blobs are trusted (`gunzipSync` without a cap); the downloaded online lap goes through `gunzipLimited` (`src/lapfile.js:22`, cap `ONLINE_TEL_BYTES` `src/leaderboard.js:28`, used at `:361`) | the Worker caps its own gunzip (`leaderboard/worker.js:71`) |
| Lap import / export | routes `src/server.js:765-787`; format in `src/lapfile.js` (`acevo-trainer-lap` v1, gzip JSON `{format, version, meta, data}`; `LIMITS` `:9`, `parseLapFile` `:78`, `exportLapFile` `:138`) | export leaves out the leaderboard data (OD-PL-2); import = bounded gunzip, schema and range checks, one INSERT; a lap already present is refused with 409 (OD-PL-3) | PL1.2 |
| Backup / restore | `src/backup.js` (zip of `VACUUM INTO` copy + JSON files, `stripSecrets` `:72` over `src/sensitive.js`; restored DBs with triggers/views/virtual tables refused `:203-206`), `src/restore-apply.js` (swap at next start, from `src/db.js:10`; `mergeSettings` `:21`), routes `src/server.js:625-656` (upload capped by `backup.MAX_UPLOAD` `:642-646`) | restore = stage → safety backup (no secrets, OD-PL-4) → swap before the DB opens; a restore never brings back a leaderboard sign-in and keeps the current one (OD-PL-1 b) | PL1.1, PL1.3 |
| Sensitive settings | `src/sensitive.js` (`SETTINGS_FIELDS` `:13`, `RACE_SECRET_KEY` `:19`, `stripSettings` `:34`, `pageView` `:58`, `mergeRestoredSettings` `:78`); atomic JSON writes in `src/jsonfile.js` (`writeFileAtomic` `:10`, `fileIssues` `:55`, `loadJson` `:67`); damaged-file notice `src/settings.js` `fileNotices` `:108` → `/api/settings` `fileNotices` → `public/settingspage.js` | one list used by backups, restores, diagnostics, the page view and the settings route; an unreadable `settings.json` is never saved over; Settings names a damaged or unreadable `settings.json` / `race.json` / `setup-meta.json` and the copy kept (OD-PL-5) | — |
| Archive extraction | `src/zip.js` `list` `:31` (directory size checked `:51`), `extractSync` `:82`, `extract` `:101` (both stop at the entry's stated size), `readEntry` `:195` (1 MB cap), `limitBytes` `:16` | used by backups, mods (`src/mods.js` `install` `:333`, files replaced are moved aside and rolled back `:368-399`), the bundled loader/HUD | mod paths cleaned by `cleanSegs` (`src/mods.js:268`) |
| Setup import | `src/setups.js:222` `importFile` (size checked first against `MAX_SETUP_BYTES` `:38`), `writeSetup` `:200` (temp + rename), `SAFE` `:35` | `.carsetup` ≤ 64 KB, car must be installed | route reads at most `MAX_SETUP_BYTES + 1` (`src/server.js:496`) |
| Channel verification | `src/channels.js` (groups, `builtIn` status, `settings.channelChecks {group: {ok, game, adapter, at, method, car}}`, `PARSER_REV`) | user confirms groups in Setups → Setup recognition | a check counts only on the game version and reader it was made with (PL4.1); comparison compatibility in `src/compat.js` (PL4.2); integration health in `src/health.js` + `GET /api/health` (PL4.3) |
| HUD bridge | `src/gamebridge.js` (8 time-slotted `live0..7.json`: `SLOTS` `:23`, `slotFile` `:59`, write `:92-100`; `[TrainerHUD-cmd]` lines tailed from the game log), `src/hudinstall.js`, `src/loaderinstall.js` | files only, no network from the game | constraint 1 below |
| Leaderboard auth + submissions | client `src/leaderboard.js` (`call` `:148`, bearer only over https or to this PC; sign-in `loginUrl` `:416` / `finishLogin` `:426`; sign-out `:440`; background timers and `stop()` since PL2), server `leaderboard/worker.js` (`checkLap` `:45`, 60 laps/h `:24`, token hash in D1, 180-day tokens `:31`) | Steam OpenID proves identity only; lap checks are plausibility checks, not proof | client-side lap validation is not cheat-proof (PL10) |
| Deterministic analysis | `src/analysis.js`, `src/service.js`, `src/opportunities.js` + `src/stats.js` (PL6 lap analysis, `docs/platform/ANALYSIS.md`), `src/practice.js` + `src/drills.js` (PL7 practice drills, `docs/platform/PRACTICE.md`), `src/report.js`, `src/carreport.js`, `src/goals.js`, `src/achievements.js` | pure functions over stored laps | |
| AI coaching | `src/ai.js` (Gemini REST, 90 s timeout, key in the `x-goog-api-key` header `:58`), `src/coach.js` (context ≤ 9 kB, never raw telemetry) | `data_quality` from `src/channels.js` goes with every prompt | user's own key; optional |
| Local HTTP API | `src/server.js:324-341` `foreignRequest` (private GETs `PRIVATE_GET` `:323` refuse cross-site), body limit 50 MB `readBody` `:298`, server on 127.0.0.1 `:1003` | `/api/hud*` is CORS `*` for the in-game HUD (`:357-358`) | `/api/mods/upload` (`:517`) has no size cap (OD-PL-6) |
| Diagnostics | `src/diagnostics.js` (`redact` `:15`, `privateValues` `:38`) | value-by-value redaction + log tail (256 kB); driver and Steam names redacted | |

## Hard constraints (do not break)

1. **Game crash on file access:** the game crashes if it cannot open a file it reads. Live files use 8 time-slotted files (50 ms windows). Never add a file the game reads while Paddock writes it, and never change mods while the game runs.
2. **No network from the game UI:** the HUD only reads local files and writes log lines.
3. **Protocol IDs stay:** `trainerhud`, `[TrainerHUD-*]`, `ace-trainerhud`, `acevo-trainer-lap`, `TRAINER_SUPERVISED`, `ACEVO_DATA` (see CLAUDE.md).
4. **EVO-native data only:** track data comes from AC EVO itself, never AC1 files.
5. **Bundle only:** no runtime downloads (loader, assets) without a user decision.
6. **Secrets:** `data/` is never committed or packaged.
7. **Local API only for Paddock's pages:** `src/server.js` `foreignRequest` refuses other host names and cross-site/foreign-origin writes. New pages must be served from the same origin.
8. **Data swaps happen before the database opens:** restores are applied by `src/restore-apply.js`, called at the top of `src/db.js`. Nothing replaces `telemetry.db` while it is open.

## Known architectural weaknesses

- Packaging: `asar: false` and unsigned builds (accepted, CLAUDE.md); SmartScreen warns on first run. The shipped runtime is Electron 44.11.1 = Node 24.22.2; since PL2 the suite also runs on it (`npm run test:electron`), next to Node 22 (`npm test`).
- `src/server.js` (~1040 lines at PL2) mixes the router, the telemetry loop, game orchestration and session-end handling. It works, but every new feature adds a route there.
- **Shared-memory offsets are community-sourced and only partly verified in game** (`src/shm.js` `OFFSETS`). Verified: speed, pedals, gear, lap time, npos, x/z, track-limit channels. **Not verified:** setup fingerprint (pressures, camber, bias, fuel), air/road temperature, the tyre block, suspension travel and slip angles. The Car & setup report and its understeer/oversteer verdicts depend on them.
- Tests cover the server modules and the API; since PL2 a few critical page flows run in headless Edge (`test/browser.flows.js`: session, compare, lap import, settings, keyboard). Not covered: the in-game HUD, most pages' DOM (checked with headless screenshots during development), and driving in game (shared memory, launches, race weekends), which is checked by hand. Test commands: README, Contributing.
