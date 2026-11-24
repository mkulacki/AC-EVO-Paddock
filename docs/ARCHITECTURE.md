# Architecture: AC EVO Paddock

Audited 2026-11-17 at `main` = `de836d2` (v0.5.0-beta.1); refreshed 2026-11-17 after the P1–P9 roadmap (0.6.0-beta.1); refreshed again 2026-11-24 for platform phase PL0 at `be3b5ef` (0.7.0-beta.1: online leaderboards, board window, theme switch). This describes the code as it is, not as planned. Line numbers below are from `be3b5ef` and drift as code changes.

## Stack

| Layer | Technology | Notes |
| --- | --- | --- |
| Runtime | Node.js ≥ 22.5, ES modules | `node:sqlite` (built in) for storage, no ORM |
| Desktop shell | Electron 44.11.1 (`desktop/main.cjs`) | imports `src/server.js` **in-process**; tray, notifications, log file, overlay window. Electron 44 bundles **Node 24.22.2** (Chromium 152), while `npm test` runs on the developer's Node (22.23.4 at PL0): the shipped runtime is not the tested one |
| HTTP/API | hand-written router in `src/server.js` (`node:http`) | `127.0.0.1:8080`, JSON API + static files + SSE (`/api/events`) |
| Frontend | vanilla ES modules in `public/`, no build step, no framework | hash router in `public/app.js`; charts with uPlot; fonts from `@fontsource` |
| Native | `koffi` FFI | Windows shared memory (`src/shm.js`), joystick buttons (`src/wheel.js`), `timeBeginPeriod(1)` |
| In-game HUD | `mod/trainerhud/` (Gameface UI app for the community ACE UI App Loader) | talks to Paddock via files + game log, never via network |
| Packaging | electron-builder `--win dir`, `asar: false`, unsigned | portable zip; `data\` next to the exe |
| AI | Google Gemini REST (`src/ai.js`), user's own key | optional; only compact summaries are sent; key in the `x-goog-api-key` header (`src/ai.js:57`) |
| Online leaderboard | Cloudflare Worker + D1 (`leaderboard/worker.js`, `schema.sql`, `migrations/`), client `src/leaderboard.js` | opt-in (`boardShare: false`); Steam OpenID sign-in → 180-day bearer token; `npm run board` runs it locally |

Runtime dependencies: 4 (`koffi` 3.3.7, `uplot`, two font packages). Dev: `electron` 44.11.1, `electron-builder` 26.18.0. No `engines` field in `package.json` (the README says Node ≥ 22.5). Tests: built-in `node:test` (`npm test`, 175 tests in 17 files at PL0, temp data dirs, mock car, API smoke test, local leaderboard) and `npm run check` (syntax of 104 shipped scripts). No lint, type-check, CI workflow (`.github/` holds only `FUNDING.yml`) or `npm audit` gate.

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
  - Driver development (P9): `goals` (goals and challenges, met state stored once), `launches` (sessions Paddock started, for race weekends), `meta` (small values such as when achievements were last seen). Achievements are not stored: recomputed from the data.
  - Migrations: `PRAGMA user_version` (v1 distance normalisation, with an automatic `VACUUM INTO` backup) plus additive `ALTER TABLE … ADD COLUMN` checks.
- JSON files: `settings.json` (holds the Gemini key), `race.json` (server passwords), `setup-meta.json`, `mods.json`, `game-catalogue.json`, `game-applied.json`.
- Caches: `trackcache/`, `carcache/` (safe to delete). Logs: `logs/paddock.log` (desktop only).

### Game-data readers (read-only, in place)

`src/kspkg.js` (XOR'd archive table) → `src/pb.js` (protobuf) → `src/trackdata.js` (track models, corners, gates), `src/cars.js` (car catalogue, specs), `src/bc7.js` + `src/thumbworker.js` (thumbnails in a worker thread). `src/carsetup.js` reads/writes `.carsetup` against `.carsetuplimits`.

### Frontend structure

`public/app.js` is the shell: the router (`#/home`, `#/`, `#/report`, `#/compare`, `#/progress`, `#/consistency`, `#/setuphistory`, `#/coach`, `#/development`, `#/race`, `#/setups`, `#/tracks`, `#/track`, `#/game`, `#/mods`, `#/settings`), the status line and nav dots; `public/palette.js` holds the sidebar toggle, the command palette and the shortcuts. Each render gets its own cleanup list. One module per page (`sessions.js`, `compare.js`, `game.js`, `settingspage.js`,  (`race.js`, `setups.js`, `reports.js`, `telemetry.js`, `replay.js`, `carsetup.js`, …), with shared helpers in `util.js`. The design tokens are CSS custom properties in `style.css` (dark first, light via `prefers-color-scheme`).

## Integration boundaries (PL0, static inspection)

Where data enters or leaves Paddock, and what guards it. "Static" = read from the code, not exercised at runtime in PL0.

| Boundary | Where | How it works | Guards / gaps |
| --- | --- | --- | --- |
| Recording | `src/server.js:265-284` (60 Hz `setInterval`), `src/shm.js` (`OFFSETS`, koffi), `src/recorder.js:122` `onFrame`, lap saved and `'lap'` emitted at `:119` | one in-process timer reads a frame and feeds recorder, setup tracker, leaderboard, HUD, marker and spotter in turn; a stale packet id for 3 s ends the session | no timing/jitter metrics; all post-lap work shares the event loop (P9 debounced goals 3 s); exceptions are logged per frame |
| Database + migrations | `src/db.js` (WAL `:14`; `PRAGMA user_version` v1 at `:51-66` with `VACUUM INTO` backup at `:56`; additive `ALTER TABLE` checks `:76-84`; `CREATE TABLE IF NOT EXISTS` for later tables) | single `DatabaseSync`, synchronous | only one versioned migration; later schema changes are additive and unversioned |
| Compression | lap blob = gzip'd JSON (`src/db.js:114` `decodeData`); leaderboard telemetry = `src/telcodec.js` (PLT1, 2 m grid) gzip'd | `zlib.gunzipSync` without `maxOutputLength` on local blobs (trusted) and on the downloaded online lap (`src/leaderboard.js:343`) | the Worker caps its own gunzip (`leaderboard/worker.js:71`) |
| Lap import / export | `src/server.js:752-772` (`acevo-trainer-lap` v1, gzip JSON `{format, version, meta, data}`) | export = every lap column except `id`/`session_id`/`data` as `meta` (includes `board`, `aids`, `cond`, `setup_info`) | import: see PL0 report, PL1.2 (unbounded gunzip, no schema checks) |
| Backup / restore | `src/backup.js` (zip of `VACUUM INTO` copy + JSON files, `stripSecrets` `:65-72`), `src/restore-apply.js` (swap at next start, from `src/db.js:10`), routes `src/server.js:613-644` | restore = stage → safety backup with secrets → swap before DB opens; `mergeSettings`/`mergeRace` keep the current Gemini key / server passwords when the backup has none | see PL0 report, PL1.1 and PL1.3 |
| Archive extraction | `src/zip.js` `list` `:18`, `extractSync` `:67` (bounded inflate), `extract` `:86` (streamed, **not** bounded), `readEntry` `:174` (1 MB cap) | used by backups, mods (`src/mods.js:262-387`), the bundled loader/HUD | mod paths cleaned by `cleanSegs` (`src/mods.js:263`) |
| Setup import | `src/setups.js:216` `importFile`, `writeSetup` `:194` (temp + rename), `SAFE` `:32` | `.carsetup` ≤ 64 KB, car must be installed | size checked after parsing (`:217-218`) |
| Channel verification | `src/channels.js` (groups, `builtIn` status, `settings.channelChecks {group: bool}`) | user confirms groups in Setups → Setup recognition | not tied to a game build or parser version (PL4.1) |
| HUD bridge | `src/gamebridge.js` (8 time-slotted `live0..7.json` `:23,:59,:98-100`; `[TrainerHUD-cmd]` lines tailed from the game log), `src/hudinstall.js`, `src/loaderinstall.js` | files only, no network from the game | constraint 1 below |
| Leaderboard auth + submissions | client `src/leaderboard.js` (`call` `:134`, bearer only over https or to this PC; sign-in `:398-416`; sign-out `:424`), server `leaderboard/worker.js` (`checkLap` `:45`, 60 laps/h `:24`, token hash in D1, 180-day tokens `:31`) | Steam OpenID proves identity only; lap checks are plausibility checks, not proof | client-side lap validation is not cheat-proof (PL10) |
| Deterministic analysis | `src/analysis.js`, `src/service.js`, `src/report.js`, `src/carreport.js`, `src/goals.js`, `src/achievements.js` | pure functions over stored laps | |
| AI coaching | `src/ai.js` (Gemini REST, 90 s timeout), `src/coach.js` (context ≤ 9 kB, never raw telemetry) | `data_quality` from `src/channels.js` goes with every prompt | user's own key; optional |
| Local HTTP API | `src/server.js:318-330` `foreignRequest`, body limit 50 MB `:296-301`, server on 127.0.0.1 `:987` | `/api/hud*` is CORS `*` for the in-game HUD (`:347-350`) | streamed uploads (`/api/mods/upload`, `/api/backup/upload`) have no size cap |
| Diagnostics | `src/diagnostics.js` (`redact` `:14`, `privateValues` `:34`) | value-by-value redaction + log tail (256 kB) | Steam display names in `[board]` log lines are not redacted |

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

- Packaging: `asar: false` and unsigned builds (accepted, CLAUDE.md); SmartScreen warns on first run. The tested Node (22.x) differs from the shipped Electron Node (24.22.2).
- `src/server.js` (~1020 lines at PL0) mixes the router, the telemetry loop, game orchestration and session-end handling. It works, but every new feature adds a route there.
- **Shared-memory offsets are community-sourced and only partly verified in game** (`src/shm.js` `OFFSETS`). Verified: speed, pedals, gear, lap time, npos, x/z, track-limit channels. **Not verified:** setup fingerprint (pressures, camber, bias, fuel), air/road temperature, the tyre block, suspension travel and slip angles. The Car & setup report and its understeer/oversteer verdicts depend on them.
- Tests cover the server modules and the API, not the in-game HUD or the pages' DOM (pages are checked with headless screenshots during development). Driving in game (shared memory, launches, race weekends) is checked by hand.
