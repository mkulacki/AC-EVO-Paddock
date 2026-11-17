# Architecture: AC EVO Paddock

Audited 2026-11-17 at `main` = `de836d2` (v0.5.0-beta.1). This describes the code as it is, not as planned.

## Stack

| Layer | Technology | Notes |
| --- | --- | --- |
| Runtime | Node.js ≥ 22.5, ES modules | `node:sqlite` (built in) for storage, no ORM |
| Desktop shell | Electron 44 (`desktop/main.cjs`) | imports `src/server.js` **in-process**; tray, notifications, log file, overlay window |
| HTTP/API | hand-written router in `src/server.js` (`node:http`) | `127.0.0.1:8080`, JSON API + static files + SSE (`/api/events`) |
| Frontend | vanilla ES modules in `public/`, no build step, no framework | hash router in `public/app.js`; charts with uPlot; fonts from `@fontsource` |
| Native | `koffi` FFI | Windows shared memory (`src/shm.js`), joystick buttons (`src/wheel.js`), `timeBeginPeriod(1)` |
| In-game HUD | `mod/trainerhud/` (Gameface UI app for the community ACE UI App Loader) | talks to Paddock via files + game log, never via network |
| Packaging | electron-builder `--win dir`, `asar: false`, unsigned | portable zip; `data\` next to the exe |
| AI | Google Gemini REST (`src/ai.js`), user's own key | optional; only compact summaries are sent |

Runtime dependencies: 4 (`koffi`, `uplot`, two font packages). Dev: `electron`, `electron-builder`. No test, lint or type-check tooling exists.

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
  - `analyses` (saved AI coach answers), `reports` (session report JSON + AI debrief), `setup_snapshots` (setup values at the time a lap was driven), brake marks.
  - Migrations: `PRAGMA user_version` (v1 distance normalisation, with an automatic `VACUUM INTO` backup) plus additive `ALTER TABLE … ADD COLUMN` checks.
- JSON files: `settings.json` (holds the Gemini key), `race.json` (server passwords), `setup-meta.json`, `mods.json`, `game-catalogue.json`, `game-applied.json`.
- Caches: `trackcache/`, `carcache/` (safe to delete). Logs: `logs/paddock.log` (desktop only).

### Game-data readers (read-only, in place)

`src/kspkg.js` (XOR'd archive table) → `src/pb.js` (protobuf) → `src/trackdata.js` (track models, corners, gates), `src/cars.js` (car catalogue, specs), `src/bc7.js` + `src/thumbworker.js` (thumbnails in a worker thread). `src/carsetup.js` reads/writes `.carsetup` against `.carsetuplimits`.

### Frontend structure

`public/app.js` owns the shell, the router (`#/`, `#/report`, `#/compare`, `#/progress`, `#/consistency`, `#/race`, `#/setups`, `#/tracks`, `#/track`, `#/game`, `#/mods`, `#/settings`), the status bar and the Sessions list. One module per page (`race.js`, `setups.js`, `reports.js`, `telemetry.js`, `replay.js`, `carsetup.js`, …), with shared helpers in `util.js`. The design tokens are CSS custom properties in `style.css` (dark first, light via `prefers-color-scheme`).

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

- `src/server.js` (643 lines) mixes the router, the telemetry loop, game orchestration and session-end handling. It works, but every new feature adds a route there.
- `public/app.js` mixes the shell, the router and the Sessions page.
- **Shared-memory offsets are community-sourced and only partly verified in game** (`src/shm.js` `OFFSETS`). Verified: speed, pedals, gear, lap time, npos, x/z, track-limit channels. **Not verified:** setup fingerprint (pressures, camber, bias, fuel), air/road temperature, the tyre block, suspension travel and slip angles. The Car & setup report and its understeer/oversteer verdicts depend on them.
- No automated tests. The only checks are `node --check` and manual runs with `npm run mock` / `npm run seed`.
