# PL11 report: Data ownership and extensibility

Branch `platform/pl11-data-ownership` (from `d97a278`, the PL10 merge), 2026-11-25. Not pushed, not merged.
What is built: `docs/platform/DATA_OWNERSHIP.md`. Design only: `docs/platform/EXTENSIBILITY_DESIGN.md`.

## What changed

| Commit | What |
| --- | --- |
| `201122f` | Scheduled verified backups: `src/autobackup.js` (schedule, idle only, free-space and synced-folder skips, retention of verified scheduled backups, storage forecast, Home notice), `src/backupverify.js` (zip check, `integrity_check` + row counts in a worker thread, secret check), routes `/api/backup/schedule`, `/schedule/run`, `/verify`; Settings card; `settings.autoBackup`; `test/autobackup.test.js` |
| `14441b1` | Crash recovery: `src/recovery.js` (journal `data\session-open.json`, interrupted session closed at the next start with its report, Home notice); desktop Quit ends a session first (`desktop/main.cjs`, `__paddockBeforeQuit`); `test/recovery.test.js` (includes a real server killed mid-session) |
| `2a32a25` | Report file: `src/reportexport.js`, `GET /api/report/export` (private GET), Save as HTML on the session report (`public/reports.js`); `test/reportexport.test.js`, smoke test |
| `604ee48` | Demo: `src/demo.js`, `--demo` in `src/db.js` (`data\demo`), mock source, seeded sessions, write guard in `route`, `/api/demo`, desktop relaunch (`__paddockDemo`), banner (`public/app.js`), Settings card (`public/system.js`), `npm run demo`; `test/demo.test.js` |
| `b08f8cd` | Docs: DATA_OWNERSHIP, EXTENSIBILITY_DESIGN, DECISIONS (D-PL11-1 … 4, OD-PL-74 … 82), FEATURE_INVENTORY, ARCHITECTURE |
| (this commit) | This report, PHASE_LOG, DEVELOPMENT_STATE, BACKLOG |

## Verified findings / rejected assumptions / unresolved

- **Verified (runtime):** a saved lap survives a hard kill. Each lap is inserted when it is finalized (`src/recorder.js:118`) into a WAL database (`src/db.js:33`); `test/recovery.test.js` kills a real server (TerminateProcess) after three saved laps and finds all of them after the restart.
- **Verified (static, fixed):** a crash or kill lost the end of the session: conditions, report and Home follow-up are done in the `sessionEnd` handler (`src/server.js:302`), which never ran. Now closed at the next start.
- **Verified (static, fixed):** the desktop app's Quit did not end a session (`desktop/main.cjs:165` only set `quitting`), so a lap waiting for its official time (`src/recorder.js:163`, up to 60 frames) was lost.
- **Verified (static):** backups had no free-space check (`src/backup.js:88`); manual backups are unchanged, scheduled ones check first.
- **Unresolved by design (OD-PL-79):** the lap being driven at a crash is in memory only and cannot be recovered.
- **Rejected:** that crash recovery needs a schema change: a journal file is enough (D-PL11-3); schema stays v4.
- **Not checked:** synced-folder detection is by folder names and the OneDrive environment variables; other sync clients with unusual folder names are not recognised.

## Tests run and results

- Baseline at `d97a278`: `npm run check` 155/155, `npm test` 439/439.
- After: `npm run check` **164/164**; `npm test` **462/462** (Node 22.23.4); `npm run test:electron` **462/462** (Node 24.22.2); `npm run test:browser` **26/26**.
- `npm run smoke:packaged -- --build` passed (port 8080 was free); the packaged exe was also started with `--demo` on a scratch data folder: demo on, 2 reports, `data\demo\telemetry.db` made, no real `telemetry.db` created, no `data\` in the build.
- New tests: scheduled backups (off by default, due/not due, secret-free, idle only, free space, synced folder, retention, damaged database, wrong counts, leaked key, forecast); recovery (journal, mismatch, failing report, real kill); report file (offline, private by default, escaping, file name, private GET, headers); demo (own folder, real database byte-identical, refused writes).

## Checks that could not run, and why

- Nothing in AC EVO: recovery was tested with the mock source only; real shared-memory sessions end the same way (`recorder.endSession`), not checked in game.
- A real full disk and real OneDrive/Dropbox folders: simulated (reserve override, environment variables).
- The demo's relaunch from Settings in the desktop app (`app.relaunch` with `--demo`) was not clicked through; the packaged exe started with `--demo` directly works.
- Scheduled backups of a multi-GB database: timing of `VACUUM INTO` is as in P3 (main thread, idle only); verification of a large copy runs in a worker, not measured on GBs.

## Performance or compatibility impact

- Telemetry loop: one small journal write per session (after the first lap, in `setImmediate`); nothing per sample.
- Scheduled backups only when idle; the integrity check in a worker thread. Off by default.
- Old installs: `settings.autoBackup` missing = off; no schema change; backups made by PL11 are the same format (version 1), readable by 0.7.
- Demo: a separate folder; the real database is not opened.

## Migration and recovery implications

- No database migration (schema v4).
- A journal from a crash is consumed at the next start; a journal that does not match the database (e.g. after a restore) is ignored and removed.
- A failed scheduled backup is deleted; older backups stay. Retention never touches manual, imported or before-restore backups.
- Demo reset: leave the demo and delete `data\demo`.

## Needs approval (prepared, NOT executed)

- Push and merge of `platform/pl11-data-ownership`.
- Everything in `EXTENSIBILITY_DESIGN.md` (local API, plugins, sync, signed releases and recoverable updates, animation export): design only. Signing needs a certificate or signing service (cost, identity) and the key kept out of the repo.

## Open decisions (added to DECISIONS.md)

OD-PL-74 … 82, all OPEN (operator), recommended default applied, user reviews in the app: scheduled backups off by default; weekly, keep 4; 2× database + 1 GiB free; skip synced folders unless allowed; delete a backup that fails its check; lap in progress not kept; report file private by default; demo as a separate data folder; animation export design only. D-PL11-1 … 4 to confirm.

## Remaining risks

- `VACUUM INTO` of a very large database still runs on the main thread (as for manual backups since P3); a run starts only when no session is being driven, but a session started during the copy waits for it.
- Free space is checked once before the run; another program filling the disk during it can still make the backup fail (it is then cleaned up and reported).
- Synced-folder detection can miss clients with other folder names.
- The demo shares the desktop app's browser storage (remembered page choices) with the real app.
- The crash journal is only as good as the start-time check: two Paddock instances on one data folder are prevented by the desktop single-instance lock, not by the source runs.

## Review round (2026-11-25)

Light review by the coordinator; fixes in one commit (`PL11: review fixes`), each with a regression test:

1. **Retention could delete an imported backup** (important): a scheduled backup imported from another PC keeps the manifest reason `scheduled`. Retention (and the forecast count) now take only files this install made on schedule (`isOwnScheduled`: name `paddock-backup-<time>-scheduled(-n).zip`).
2. **Recovery could delete a new session's journal:** the recovered journal is removed only when it still names the recovered session.
3. **Count mismatch race:** checked: the counts were already taken with no await after `VACUUM INTO`, so no lap could be saved in between; they are now taken explicitly right after the copy, and a test saves a lap after the copy and still verifies.
4. **Idle re-checked right before the copy** (`backup.create` `beforeCopy`): a session started meanwhile defers the run without a notice.
5. **Demo:** Leave the demo clears `PADDOCK_DEMO` for the relaunched app; the real folder's `hud-removed` / `loader-removed` flags are read-only in the demo (documented).

Tests after the review: `npm run check` 164/164, `npm test` 467/467 (Node 22.23.4), `npm run test:electron` 467/467 (Node 24.22.2), `npm run test:browser` 26/26.

## Recommended next phase

The user reviews PL8–PL11 in the app (OD-PL-42 … 82), then merges the platform branches. After that, the research
reports (RB) or, if wanted, the read-only local API from `EXTENSIBILITY_DESIGN.md` §1 as the first extensibility step.
