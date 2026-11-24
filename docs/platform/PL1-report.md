# PL1 report: security and data safety

- **Date:** 2026-11-24 · **Branch:** `platform/pl1-data-safety` (from `platform/integration` = `0365ce6`, PL0 merged there; `main` is still `be3b5ef`)
- **Scope:** PL1.1 credential-safe backups, PL1.2 lap import hardening, PL1.3 adjacent boundaries (`docs/platform/BACKLOG.md`, PL1). Line numbers below are from this branch's last code commit (`8039ebf`) unless marked "PL0".
- **Open decisions applied:** the conservative defaults of OD-PL-1 … OD-PL-4 (`docs/DECISIONS.md`); they stay `OPEN (operator)` for confirmation.

## What changed

| Commit | Change |
| --- | --- |
| `665a235` | New `src/sensitive.js`: the one list of sensitive settings (`geminiApiKey` secret; `boardToken`, `boardSteam` sign-in; every `password` in `race.json` secret) with strip / merge / page-view / redaction helpers, dependency-free so `src/restore-apply.js` can use it. Used by `src/backup.js` (`stripSecrets`, `:72`), `src/restore-apply.js` (`mergeSettings`, `:21`), `src/diagnostics.js` (`:40-42`, now also the token and the Steam name), `src/settings.js` (`publicView` via `pageView`) and the settings route (`src/server.js:877`). Backups never hold the sign-in; the manifest gets `signIn: false` (`src/backup.js:111`); the Settings part hint and the restore confirmation say so (`public/system.js`). |
| `0d93ed3` | New `src/jsonfile.js`: `writeFileAtomic` (temp file, fsync, rename, short retry on a Windows `EPERM`/`EBUSY`) and `readJsonSafe` (a damaged file is renamed to `<name>.unreadable-<time>` and logged). Used for `settings.json` (`src/settings.js:67,78`), `race.json` (`src/race.js:34,38`) and `setup-meta.json` (`src/setups.js`). Settings read from disk or a restore are type-normalised (`settings.normalize`, `src/settings.js:54`). |
| `7f224f8` | New `src/lapfile.js`: `parseLapFile` (limits `:9`, bounded `gunzipLimited` `:22`, checks `:78-135`) and `exportLapFile` without `board` (`:138`). `/api/laps/import` (`src/server.js:774-788`) uses it with a 16 MB body cap, a duplicate lookup `db.findSameLap` (`src/db.js:197`) and 400/409/413 answers. Online lap download (`src/leaderboard.js:346-355`): capped gunzip and field checks. |
| `eff137d` | `src/zip.js`: `limitBytes` transform (`:16`); streamed `extract` stops at the stated size and removes the partial file (`:114`); `list` refuses a directory outside the file or over 64 MB (`:51`). Backup uploads capped at `backup.MAX_UPLOAD` (`src/backup.js:25`, `src/server.js:646`). |
| `4eb5cd8` | `src/mods.js` install: replaced files are moved aside (`<file>.paddock-old`) and put back on any failure (`:364-396`); test seam `io.rename` (`:32`). Zip paths with Windows device names or a trailing dot/space are refused (`:267`). `src/setups.js`: device names get an underscore (`:33`); size check before parsing (`:222`). |
| `5b3dc56` | `src/server.js:323-336`: GETs of private data (`/api/backup/file`, `/api/laps/<id>/export`, `/api/export/*`, `/api/diagnostics`, `/api/setups/export`) refuse `Sec-Fetch-Site: cross-site`/`same-site` and foreign `Origin`s. `/api/setups/import` reads at most 64 kB (`:496`). |
| `8039ebf` | `src/backup.js:205-207`: a restored database holding a trigger, view or virtual table is refused (Paddock never creates any). |
| docs commit | This report, `CHANGELOG.md` (Unreleased), `docs/DECISIONS.md` (OD-PL-5 … 7), `docs/PHASE_LOG.md`, `docs/DEVELOPMENT_STATE.md`. |

New tests: `test/secrets.test.js` (9), `test/jsonfile.test.js` (5), `test/lapfile.test.js` (9), `test/mods.test.js` (3); additions to `test/appmgmt.test.js` (+2 tests, more assertions), `test/smoke.test.js` (+1 test, more assertions), `test/leaderboard.test.js` (+1).

## Verified findings / rejected assumptions / unresolved

Each PL0 finding (static only in PL0) now has a runtime regression test on Node 22.

| PL0 # | Status after PL1 | Fix / evidence | Regression test |
| --- | --- | --- | --- |
| 1.1-a token in secret-free backups | **Fixed** | `stripSettings` always empties the sign-in (`src/sensitive.js:34`) | `secrets.test.js` "secret-free backup …" (raw zip bytes and entries checked for key, token, password, Steam id) |
| 1.1-b manifest inaccurate | **Fixed** | `includesSecrets` now true only with key/passwords; `signIn: false`; hint updated | same test, plus "manifest lists exactly the files in the zip" |
| 1.1-c restore brings the sign-in | **Fixed** (OD-PL-1 a) | `mergeRestoredSettings` clears `boardToken`/`boardSteam`, keeps the current key when the backup has none (`src/sensitive.js:77`) | "restoring a secret-free backup …", "an older backup that still holds a token …" |
| 1.1-d no central inventory | **Fixed** | `src/sensitive.js` | "inventory: …" |
| 1.1-e "include secrets" / safety backups | **Audited**: the option stays (no new one added); it now never includes the token; safety backups keep key + passwords (OD-PL-4) | `src/backup.js:213` | "\"include secrets\" backup …", "before-restore safety backup …" |
| 1.1-e follow-up: GETs not origin-checked | **Fixed** for private downloads | `src/server.js:323-336` | `smoke.test.js` "only Paddock pages …" (5 routes × 3 refusals; same-origin, `none` and plain GETs allowed) |
| 1.1-f/g/h | Rejected in PL0; still hold | page view tested again; diagnostics now also redact token + Steam name | "the page never sees the token", "diagnostics: …" |
| 1.2-a unbounded gunzip | **Fixed** | `maxOutputLength` 64 MB; body 16 MB | `lapfile.test.js` "decompression bomb" (65 MB in under 1 MB → 413); smoke 70 MB bomb → 413 |
| 1.2-b no schema checks | **Fixed** | format, version, meta types/ranges, channel arrays (equal length, finite, per-channel range), sample and channel limits, lap clock not running back (> 1 s below its latest value), samples' time span ≤ lap time + 60 s, optional `car` data checked against the samples | "invalid details", "invalid telemetry", "truncated …", "versions" |
| 1.2-c partial records | Rejected in PL0; still one `INSERT`; invalid content is now refused before it | — | — |
| 1.2-d duplicates | **Fixed** (OD-PL-3) | `findSameLap` on track, layout, car, lap time, recorded time, sample count; only when the file has a recorded time | "duplicates …"; smoke: re-import → 409 naming the lap; changed time → 200 |
| 1.2-e raw 500s | **Fixed** | 400/409/413 with plain messages; unexpected errors logged as `[import]`, answered with a generic message | smoke: no `[import] lap import failed` in the log |
| 1.2-f online lap download | **Fixed** | capped gunzip (≈0.9 MB, a 100 km lap), track/layout/car/lapMs checked | `leaderboard.test.js` "downloading an online lap (PL1.2) …" |
| 1.2-g identity in exports | **Fixed** (OD-PL-2) | `exportLapFile` leaves out `board` | "export: same format as before …" |
| 1.3-b streamed extraction uncapped | **Fixed** | `limitBytes(entry.size)` | `appmgmt.test.js` "crafted zips …" (streamed path) |
| 1.3-c directory size | **Fixed** | `cdOff + cdSize ≤ file size`, ≤ 64 MB | "crafted zips: a central directory said to be bigger …" |
| 1.3-d upload size | **Fixed for backups**; mods deferred (OD-PL-6) | `MAX_UPLOAD` | "limitBytes …" (unit; a 4 GB upload is not run) |
| 1.3-f mod paths with device names | **Fixed conservatively** (refused) | `DEVICE` + trailing dot/space | `mods.test.js` "zip paths with Windows device names …" |
| 1.3-g mod overwrite rollback | **Fixed** | move aside, put back | `mods.test.js` "install with overwrite: a rename refused midway …" |
| 1.3-h setup names with device names | **Fixed conservatively** (`CON` → `CON_`) | `SAFE` | `mods.test.js` "setups: …" |
| 1.3-i setup import parsed before size check | **Fixed** | size first; route reads ≤ 64 kB | "setups: …"; smoke 200 kB → 413/closed |
| 1.3-k restored JSON trusted | **Fixed** (types) | `settings.normalize`; unknown keys kept | `jsonfile.test.js` "settings from disk …" |
| 1.3-l restored DB triggers/views | **Resolved → fixed**: Paddock creates none (`grep` of `src/`), so any is refused | `src/backup.js:205` | `appmgmt.test.js` "restore: staged …" (trigger, view) |
| 1.3-n non-atomic JSON, silent reset | **Fixed** | `src/jsonfile.js` | `jsonfile.test.js` (damaged settings and race kept aside, failed write leaves old file, no temp files) |
| 1.3-o Steam names in diagnostics | **Fixed** | sign-in name added to the redaction names; downloaded drivers' names were already covered (laps' `driver`) | "diagnostics: …" |

Not verified at runtime: Windows behaviour of an actual `CON` file (the names are refused before any write, so no write test was needed); the packaged Electron/Node 24 runtime.

## Tests run and results

| Check | Before (`0365ce6`) | After (`8039ebf` + docs) |
| --- | --- | --- |
| `npm run check` | 104/104 | 111/111 |
| `npm test` | 175/175 (17 files) | 205/205 (21 files) |

Node 22.23.4. No failures, no skips (the mod tests skip themselves only while AC EVO is running).

## Checks that could not run, and why

- **AC EVO / shared memory / in-game HUD:** not touched by PL1.
- **Steam sign-in on the live leaderboard:** the sign-out on restore was tested with the local board and fake values only.
- **Packaged exe and Electron's Node 24.22.2:** not run (PL2 adds a Node-24 run). `zlib` `maxOutputLength` and `fs.fsyncSync` exist in both.
- **A real 4 GB backup upload:** not run; the cap is tested through `limitBytes`.
- **Windows file locks during `writeFileAtomic`:** the retry path (`EPERM`/`EBUSY`) is not exercised; the failure path is (target is a folder).

## Performance or compatibility impact

- **Compatible:** existing `.lap.gz` exports import unchanged (tested with a real export of a seeded lap, and legacy files without `version`, `driver`, `recorded_at`, `car` or the newer channels). Old backups still list and restore; one that still holds a token restores without it. The export format (`acevo-trainer-lap` v1) is unchanged apart from `meta.board` being left out.
- **Behaviour changes (user-visible, in `CHANGELOG.md`):** restoring settings signs the leaderboard out; duplicate lap imports are refused (409); a damaged settings file is kept aside instead of being overwritten; cross-site GETs of private downloads get 403.
- **Cost:** lap import validates every sample once (O(samples × channels), milliseconds for a normal lap); settings saves add an `fsync`. Nothing on the 60 Hz recording path changed.

## Migration and recovery implications

- No database schema change, no migration.
- A damaged `settings.json` / `race.json` / `setup-meta.json` is recoverable from `data\<name>.unreadable-<time>` (by hand; OD-PL-5).
- A failed mod install now leaves the game folder as it was; if even the put-back fails, the originals stay as `<file>.paddock-old` and the error says so.
- Backups made before PL1 that hold a token stay as they are on disk; they never sign anyone in on restore. The driver can delete them to remove the token from disk.

## Needs approval

- Push of `platform/pl1-data-safety`, its merge into `platform/integration`, and of that into `main` (none done).
- Nothing else: no backend, cost or privacy-default change was prepared (the sign-in and export changes make the defaults stricter, per OD-PL-1/2).

## Open decisions (in `docs/DECISIONS.md`)

- OD-PL-1 … OD-PL-4: defaults implemented, still `OPEN (operator)` for confirmation.
- **OD-PL-5:** notice in the page for a damaged settings file (default: log only).
- **OD-PL-6:** size cap for mod uploads (default: none).
- **OD-PL-7:** unknown numeric channels in lap files (default: keep, ≤ 64 channels).

## Remaining risks

- Import limits (16 MB file, 64 MB unpacked, 250 000 samples, 4 h lap, 100 km track, 1 s clock tolerance, value ranges) are based on the recorder's code, not on real laps of every car/track; a real lap outside a range would be refused with a message naming the channel. The steering (`str`) and rpm ranges are wide because their units are not verified in game.
- Mod uploads are still unbounded on disk (OD-PL-6); extraction is bounded.
- `writeFileAtomic` falls back to throwing after 5 refused renames; the caller's error handling is unchanged (settings saves still throw to the route).
- `docs/ARCHITECTURE.md`'s integration table still cites PL0 line numbers; refresh it in PL2 with the doc corrections.

## Recommended next phase

**PL2** (quality and release checks): CI workflow, a test run under Electron's Node 24, `npm run verify`, and the packaged smoke script. See `docs/platform/BACKLOG.md`.
