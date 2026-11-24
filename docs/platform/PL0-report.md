# PL0 report: establish the baseline

- **Date:** 2026-11-24 · **Branch:** `platform/pl0-baseline` (from `main` = `be3b5ef`, 0.7.0-beta.1)
- **Scope:** documentation only. No file under `src/`, `public/`, `desktop/`, `mod/`, `leaderboard/` or `test/` changed.
- **Method:** every finding below is **static only** (read from the code at `be3b5ef`). None was exercised at runtime in PL0. Line numbers are from `be3b5ef`.

## What changed

| File | Change |
| --- | --- |
| `docs/ARCHITECTURE.md` | runtimes (Electron 44.11.1 bundles Node 24.22.2; tests run on Node 22.23.4), leaderboard row, test counts, a new **Integration boundaries** table (recording, DB/migrations, compression, import/export, backup/restore, archives, setup import, channel verification, HUD bridge, leaderboard auth, analysis, AI, local API, diagnostics) with `file:line` |
| `docs/FEATURE_INVENTORY.md` | refreshed for 0.7.0 (leaderboards, Cars page, theme switch; tests now exist) and a **Platform baseline** table mapping PL1–PL11 onto existing phases |
| `docs/platform/PL0-report.md` | this report |
| `docs/platform/BACKLOG.md` | prioritised PL1–PL11 backlog with dependencies and refined scope |
| `docs/DECISIONS.md` | open decisions OD-PL-1 … OD-PL-4, marked `OPEN (operator)` |
| `docs/PHASE_LOG.md`, `docs/DEVELOPMENT_STATE.md` | phase entry; current phase, test counts, next action |

Commits: `09dc787` (ARCHITECTURE), `247e548` (FEATURE_INVENTORY), `4403866` (report + backlog), `2eb8a80` (decisions, phase log, state), and `PL0: review fixes` (reviewer corrections to 1.1-e, 1.2-b/c, 1.3-g, commit list and plan references).

## Verified findings / rejected assumptions / unresolved

Status: **V** = verified (the defect exists in the code), **R** = rejected (the code already handles it), **U** = unresolved (needs a runtime check or more context). All are **static only**.

### PL1.1 credential-safe backups

| # | Hypothesis | Status | Evidence |
| --- | --- | --- | --- |
| 1.1-a | Secret-free backups still contain leaderboard auth credentials | **V** (static only) | `src/backup.js:65-72` `stripSecrets` clears only `settings.geminiApiKey` and every `password` in `race.json`. `boardToken` (`src/settings.js:22`, a 180-day bearer token, `leaderboard/worker.js:31`) and `boardSteam` (`src/settings.js:23`: steamId, name, admin, server URL) are written unchanged by `src/backup.js:100` when `includeSecrets` is false. No test covers it: `test/appmgmt.test.js:42-61` checks the key and passwords only. |
| 1.1-b | Backup manifests are accurate about secrets | **V** (inaccurate) | `src/backup.js:103` writes `includesSecrets: false` for a backup that holds the token; the Settings part hint `src/backup.js:30` names only the Gemini key. |
| 1.1-c | Restoring a secret-free backup requires fresh authentication | **V** (it does not) | `src/restore-apply.js:19-22` `mergeSettings` merges only `geminiApiKey`; the restored `boardToken`/`boardSteam` replace the current ones. A backup made on another PC (or by another person) signs this install in as that Steam account, because the token is used whenever `boardSteam.url` matches the configured URL (`src/leaderboard.js:127-129`). |
| 1.1-d | There is no central inventory of sensitive settings | **V** | the knowledge is spread over `src/backup.js:65-72`, `src/restore-apply.js:19-45`, `src/diagnostics.js:34-43`, `src/settings.js:67` (`publicView`) and `src/server.js:861` (fields the page may not set). Each lists different fields. |
| 1.1-e | An "include secrets" option exists | **V** (exists → audit in PL1.1) | `src/server.js:619-620` (`includeSecrets === true` from the page), `src/backup.js:82`. The automatic **before-restore** safety backup always includes secrets (`src/backup.js:202`) and stays in `data\backups`, downloadable through `/api/backup/file` (`src/server.js:622-627`). That GET is guarded only by the Host check: `foreignRequest` (`src/server.js:318-323`) returns early for GET/HEAD without looking at `Origin` or `Sec-Fetch-Site`, so a cross-site GET is not refused; only the absence of CORS headers stops another site reading the response. Follow-up: BACKLOG PL1 item 8. |
| 1.1-f | The token leaks to the page | **R** | `src/settings.js:67` sets `boardToken: undefined`; tested in `test/leaderboard.test.js:187`. |
| 1.1-g | The token leaks into diagnostics | **R** | `src/diagnostics.js:78-79` lists chosen settings only; no `[board]` log line prints the token (`src/leaderboard.js:168-426`). |
| 1.1-h | Gemini key sent safely | **R** | header `x-goog-api-key`, not the URL (`src/ai.js:57`). |

### PL1.2 lap import hardening (`acevo-trainer-lap` v1)

| # | Hypothesis | Status | Evidence |
| --- | --- | --- | --- |
| 1.2-a | Decompression is unbounded | **V** | `src/server.js:763` `zlib.gunzipSync(buf)` without `maxOutputLength`; the body may be up to 50 MB (`src/server.js:296-300`), so the output is limited only by memory. |
| 1.2-b | No structural/schema validation | **V** | `src/server.js:765` checks `format` and that `data.t` / `data.d` are truthy. Not checked: `version` (ignored), `meta` presence (missing `meta` → TypeError at `src/server.js:767` → 500 with the raw JS message via `:981`), array types and equal lengths, finite numbers and ranges, sample count, duration, ordering of `t`/`d`, `lap_time_ms` vs `t`. Malformed input mostly fails at the insert instead of being stored: a non-array `data.t` (no `length`) or a missing required meta field (`track`, `layout`, `lap_number`, `lap_time_ms`, `track_length`) makes `node:sqlite` throw "Provided value cannot be bound to SQLite parameter" in `src/db.js:124-128`, so the import ends in a 500 with that raw message and nothing is stored. *Runtime-checked by the PL0 reviewer on Node 22 (not the packaged Electron / Node 24 app); the rest of this row is static only.* |
| 1.2-c | Partial records on failure | **R** | one `INSERT` per import (`src/db.js:122-130`); a single statement is atomic in SQLite. When the required meta fields are present and `data.t` is an array, invalid content (mismatched array lengths, non-finite or out-of-range values, unordered `t`/`d`) is stored *whole* and fails later in analysis (1.2-b; static only). |
| 1.2-d | Duplicate imports are detected | **V** (not detected) | no lookup before `db.insertLap` (`src/server.js:767`); importing the same file twice gives two laps. |
| 1.2-e | Error messages are useful and non-sensitive | **V** (not useful; not sensitive) | parse/TypeErrors surface as raw messages with status 500 (`src/server.js:981`). Nothing secret is in them. |
| 1.2-f | Other import formats | **V** (one more path) | the online lap download `src/leaderboard.js:336-351` gunzips the server's telemetry without a cap (`:343`) and decodes it with `decodeTel`; the server URL is user-settable (`boardUrl`). The Worker caps its own gunzip (`leaderboard/worker.js:71`). |
| 1.2-g | Exports carry identity data | **V** (privacy, not a credential) | `src/server.js:755` exports every lap column as `meta`, including `board` (own laps: `steamId`, server URL, rank, `src/leaderboard.js:194`; downloaded laps: the other driver's id and name, `:348`), `aids`, `cond`, `setup_info`. See OD-PL-2. |

### PL1.3 adjacent boundaries

| # | Boundary / risk | Status | Evidence |
| --- | --- | --- | --- |
| 1.3-a | Backup restore: path traversal | **R** | only the four top-level `RESTORABLE` names listed in the manifest are extracted (`src/backup.js:185-189`, `src/restore-apply.js:13`). |
| 1.3-b | Zip extraction: oversized output | **V** | `src/zip.js:86-101` `extract` streams `createInflateRaw()` to disk with no output cap and checks the size only **after** writing. A crafted backup (`src/backup.js:187`) or mod zip (`src/mods.js:366`) can fill the disk before failing. The sync path is capped (`src/zip.js:79`, tested `test/appmgmt.test.js:194`). |
| 1.3-c | Zip directory size | **V** (low) | `src/zip.js:37` allocates `cdSize` bytes from the file (up to 4 GB, more with Zip64) before parsing. |
| 1.3-d | Upload size | **V** (low; local origin only) | `/api/mods/upload` and `/api/backup/upload` stream to disk with no cap (`src/server.js:510`, `:633`). |
| 1.3-e | Mod zip: path traversal | **R** | `src/mods.js:263-267` `cleanSegs` rejects `.`, `..` and any `:`; leading `/` is dropped; `\` is normalised to `/` (`src/zip.js:46`). |
| 1.3-f | Mod zip: Windows device names / trailing dots or spaces in segments (`CON`, `aux.txt`, `foo.`) | **U** | not rejected by `cleanSegs`; the effect on Windows needs a runtime test. |
| 1.3-g | Mod install: unsafe overwrite on partial failure | **V** | `src/mods.js:370` renames `.part` files over the targets one by one; if a rename fails midway, earlier targets are already replaced (with `overwrite=1` their originals are gone, no copy kept) and the catch (`:371-375`) removes only the remaining `.part` files. |
| 1.3-h | Setup import: path traversal | **R** | `SAFE` (`src/setups.js:32`) strips `<>:"/\|?*` and control characters and trailing dots/spaces; car and track folders come from the catalogue. Device names (`CON`) are not handled: **U**, same as 1.3-f. |
| 1.3-i | Setup import: oversized file | **V** (low) | `src/setups.js:217-218` parses the buffer (`filePreset`) before the 64 KB check; the body can be 50 MB. |
| 1.3-j | Setup write: partial write | **R** | temp file + rename (`src/setups.js:200-202`). |
| 1.3-k | Restored JSON is trusted as is | **V** (low) | `src/restore-apply.js:81-85` writes the backup's `settings.json` with any keys (`boardUrl`, `aceDir`, `gamePath`, `port`); `settings.js` normalises only `hud` and `spotter`. |
| 1.3-l | Restored database content | **U** | `src/backup.js:193-199` checks tables, `quick_check` and `user_version`; triggers or views in a crafted database are not checked. Impact needs analysis (no extension loading in `node:sqlite` by default). |
| 1.3-m | Restore: recovery from partial writes | **R** | DB swapped by copy + rename, WAL cleared first, retried 3×, then set aside (`src/restore-apply.js:47-99`); safety backup first (`src/backup.js:202`). Tested `test/appmgmt.test.js:98-145`. |
| 1.3-n | Settings/race files: partial writes | **V** | `src/settings.js:63` and `src/race.js:37` write in place (no temp + rename; `src/mods.js:41` does it right). A crash mid-write leaves invalid JSON; `src/settings.js:52` then silently falls back to defaults, and the next `update` overwrites the file, losing the Gemini key, token and preferences. |
| 1.3-o | Diagnostics: credential leakage | **R** for credentials (1.1-g); **V** for a name | Steam display names logged by `src/leaderboard.js:349` and `:416` are not in the redaction list (`src/diagnostics.js:41`, driver names from settings and laps only). |

## Tests run and results

| Check | Before (baseline, `be3b5ef`) | After (this branch) |
| --- | --- | --- |
| `npm run check` | 104/104 | 104/104 |
| `npm test` | 175/175 (17 files) | 175/175 |

No pre-existing failures. Node 22.23.4 (developer shell).

## Checks that could not run, and why

- **AC EVO in game:** shared memory, HUD bridge (`live0..7.json`, `[TrainerHUD-cmd]`), launches, race weekends, channel groups (needs the game and the user).
- **Steam sign-in and the live leaderboard:** needs a browser login and the Cloudflare deployment; not touched. `npm run board` (local Worker) is exercised by `npm test` only.
- **Cloudflare / D1:** never deployed or queried (plan rule 5).
- **Packaged exe smoke test:** not needed for a docs-only phase; not run.
- **Tests under Electron's Node 24.22.2:** not run (PL2 item).
- **`npm audit`:** not run (network; PL2 assesses it).
- **Windows device-name behaviour (1.3-f, 1.3-h):** needs a runtime test (PL1.3).

## Performance or compatibility impact

None (documentation only). Noted for later phases: the tested Node (22.x) is not the shipped Electron Node (24.22.2).

## Migration and recovery implications

None in PL0. PL1.1 changes what a backup holds and what a restore does; PL1 must keep old backups restorable (a backup that still carries a token must restore without it) and say so in the phase report.

## Needs approval

- Push of `platform/pl0-baseline` and merge into `main` (not done).
- Nothing else: no backend, cost or privacy change was prepared.

## Open decisions (added to `docs/DECISIONS.md`)

- **OD-PL-1:** leaderboard token in "include secrets" backups and on restore. Conservative default for PL1: never back up the token; a restore clears the sign-in (fresh Steam login).
- **OD-PL-2:** strip `board` (Steam id, server URL) from `.lap.gz` exports. Conservative default: strip.
- **OD-PL-3:** duplicate lap import. Conservative default: refuse and name the existing lap.
- **OD-PL-4:** before-restore safety backups hold secrets. Conservative default: keep them (they make a restore undoable) minus the token; the list already badges them "with key" (`public/system.js:80`).

## Remaining risks

- All findings are static; PL1 must turn each verified one into a failing regression test first.
- Shared-memory offsets for the unverified groups are still unchecked in game (unchanged since P2).
- Line numbers drift as PL1 edits code; the reports cite the commit they were read at.

## Recommended next phase

**PL1** (security and data safety), in this order: 1.1 (central sensitive-settings inventory, token stripping, restore clears sign-in, manifest accuracy) → 1.3-n atomic JSON writes → 1.2 (bounded gunzip, schema validation, duplicates) → 1.3-b/g (bounded streamed extraction, safe mod overwrite) → the low items. See `docs/platform/BACKLOG.md`.
