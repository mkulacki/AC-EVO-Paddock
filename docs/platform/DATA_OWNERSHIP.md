# Data ownership (PL11): what is built

Everything here is local: no cloud, no network request, no new dependency. The design-only parts of PL11 (local API,
plugins, sync, signed releases and updates, animation export) are in `docs/platform/EXTENSIBILITY_DESIGN.md`.
Decisions: OD-PL-74 … 82 in `docs/DECISIONS.md`.

## 1. Scheduled verified backups (`src/autobackup.js`, `src/backupverify.js`)

Settings → Backup and restore → **Scheduled backups**. Built on `src/backup.js`: a scheduled backup is the same zip as
"Back up now" (manifest, a `VACUUM INTO` copy of `telemetry.db`, the small files) with the reason `scheduled`.

| Rule | How |
| --- | --- |
| Off by default | `settings.autoBackup` is `null` → off (OD-PL-74). Daily or weekly (default weekly), keep 1 … 30 (default 4) (OD-PL-75). |
| Only while idle | Checked every 10 minutes (first 2 minutes after start); a run waits while a session is being driven (the copy is a `VACUUM INTO` on the main thread). Idle is asked again right before the copy; a session that started meanwhile defers the run without a notice. |
| Secret-free | `backup.create({ reason: 'scheduled' })` never includes the Gemini key, server passwords or the sign-in (PL1). The verification also fails a backup whose files hold one it should not. |
| Verified | The zip is checked (`inspect`), `telemetry.db` is unpacked next to the backups and opened **read-only in a worker thread**: `PRAGMA integrity_check`, then the row counts of laps, sessions, reports and brake marks are compared with the manifest. The small files must parse. The copy is deleted afterwards. The manifest counts are taken in the same synchronous step as the copy, so laps saved later never make a good backup fail. |
| A failed check | The new backup is deleted (it cannot be trusted), the older ones stay, and Home and Settings say why (OD-PL-78). |
| Never fills the disk | A run needs `2 × (database + small files) + 1 GiB` free on the drive (`fs.statfsSync`); otherwise it is skipped with a notice on Home and in Settings (OD-PL-76). Temp files (`.backup-*`, `.verify-*`) are removed on failure and at the next start. |
| No cloud folder by surprise | When the backups folder is inside OneDrive (by the `OneDrive*` environment folders or a folder name), Dropbox, Google Drive, iCloud Drive, pCloud, MEGA, Nextcloud, ownCloud, Box or Sync.com, scheduled runs are skipped with a notice unless the driver ticks **Back up there anyway** (OD-PL-77). Manual backups are unchanged. |
| Retention | After a new scheduled backup verified, only the newest `keep` **verified scheduled** backups this install made (named `…-scheduled.zip` / `…-scheduled-2.zip`) stay. Manual, imported (also a scheduled backup imported from another PC, which keeps its manifest reason) and before-restore backups are never deleted by Paddock. |
| Any backup | **Verify** on each row runs the same check on demand; the result (verified / check failed) is kept in `data\backups\schedule.json` with the schedule's last run and skip. |

**Storage forecast** (same card): the laps database size, laps per 30 days and growth per 30 days (laps of the last
90 days, at least a week counted; each lap's share of the database file), the room the kept scheduled backups take, the
free space on the drive and how many days that lasts at this rate (database growth plus `keep` copies of it).

Not done: backups to another folder or drive chosen in Settings (the backups stay in `data\backups`, as before; copy
them elsewhere by hand, or point a synced folder at them deliberately).

## 2. Crash recovery of partial sessions (`src/recovery.js`)

- Every lap is committed to SQLite (WAL) when it is saved, so a crash, a kill or a power cut keeps every saved lap.
  What used to be lost was the end of the session: its conditions, its report and the follow-up on Home.
- A journal `data\session-open.json` is written (atomically) when a session saves its first lap and removed after the
  session ended and its report was attempted.
- At the next start, a journal that matches a session in the database (same id, track, car and start time) means the
  session was interrupted: its report is made (when it has 3 laps and a valid one) and Home says once that the session
  was closed and its laps kept. A journal that does not match (for example after a restore) is ignored and removed.
  The recovered journal is removed only if it still names that session (a new session may have written its own).
- The desktop app's **Quit** now ends a session being driven first (`__paddockBeforeQuit`), so a lap that crossed the
  line less than a second before (waiting for the official lap time) is saved; its report follows at the next start.
- **Not recoverable** (by design, OD-PL-79): the lap being driven at the moment of a crash. Its samples live only in
  memory until the line; writing them to disk during the lap would add disk work to the 60 Hz loop (PL3).
- Tested by killing a real server (`TerminateProcess`) after three saved laps and starting it again
  (`test/recovery.test.js`).

## 3. Self-contained analysis reports (`src/reportexport.js`)

Session report → **Save as HTML…**: one `.html` file that opens in any browser, offline.

- Contents: the key numbers, a lap-time chart (inline SVG), the lap list, the corner table, where the time goes, next
  practice targets, the last session's targets, setups, conditions and invalid laps by corner.
- Offline by construction: inline CSS and SVG only, no scripts, no fonts, images or links that load anything, and a
  Content-Security-Policy (`default-src 'none'; style-src 'unsafe-inline'; img-src data:`) both in the file and on the
  download response.
- Private by default (OD-PL-80): no driver name, no Steam name or ID, no session notes and no AI debrief unless the
  driver ticks them. Never a key, token, password or folder path. All text is escaped.
- `GET /api/report/export?session=<id>[&identity=1][&notes=1][&ai=1]` is a private GET (refused cross-site).

## 4. Replayable demo sessions (`src/demo.js`)

Settings → **Demo → Try the demo** (desktop app; `npm run demo` from source).

- Paddock starts again with `--demo`. `src/db.js` then uses `data\demo` as the data folder: its own laps database,
  settings, backups and journal. The driver's `telemetry.db` is not opened, so demo laps can never be mixed into real
  laps, stats, goals, backups or the leaderboard (OD-PL-81).
- The first demo start adds two synthetic sessions (6 and 8 laps, two days and one day ago, driver "Demo driver") with
  their reports; the mock car (`src/mock.js`, a fictional circuit) then drives live, in real time, so the live pages,
  the desktop overlay and the spotter can be watched.
- Every page shows a **Demo** banner with **Leave the demo** (starts Paddock again normally).
- Refused in the demo (409): starting the game and the Race tab, writing setups, the Mods tab, the HUD and loader
  installs, every leaderboard action, restores, backup uploads and lap imports. No scheduled backups, no update check
  (a mock run), no in-game HUD bridge.
- To reset the demo: leave it and delete `data\demo`.
- `PADDOCK_DEMO=1` in the environment also starts the demo; Leave the demo clears it for the relaunched app.
- Read from the real data folder in the demo: only the `hud-removed` / `loader-removed` flags (`src/hudinstall.js`, `src/loaderinstall.js`, which use `ACEVO_DATA` directly). They are read, never written: the routes that change them are refused in the demo.
