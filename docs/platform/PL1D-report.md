# PL1D report: the user's decisions on the PL1 open questions

- **Date:** 2026-11-24 · **Branch:** `platform/pl1-decisions` (from `675441f`, the PL2 merge)
- **Scope:** apply the user's answers (2026-11-24) to OD-PL-1 … OD-PL-7 (`docs/DECISIONS.md`). OD-PL-8 and OD-PL-9 stay open.
- **Result:** complete. Nothing pushed or merged.

## Decisions applied

| Decision | Answer | Change |
| --- | --- | --- |
| OD-PL-1 sign-in in backups/restores | (b) | A restore keeps the install's current sign-in instead of signing out |
| OD-PL-2 identity data in `.lap.gz` | default confirmed | none |
| OD-PL-3 duplicate lap import | default confirmed (refuse, name the lap) | none |
| OD-PL-4 secrets in the before-restore backup | none at all | The safety backup is made without secrets |
| OD-PL-5 damaged settings file | (b) | Settings shows a notice |
| OD-PL-6 mod upload size cap | (a) no cap, confirmed | none |
| OD-PL-7 unknown lap channels | (a) keep, max 64, confirmed | none |

## What changed

| Commit | Change |
| --- | --- |
| `e119946` | **OD-PL-1 (b).** `src/sensitive.js` `mergeRestoredSettings` (`:78`): the sign-in fields always come from the current install, token and Steam identity together (half a sign-in is dropped), never from the backup, including an older backup that still holds a token. Restore confirm text in `public/system.js:123-124`, `CHANGELOG.md`, `README.md` and the comment in `src/restore-apply.js:19-20` updated. Tests in `test/secrets.test.js` changed from "sign-in cleared" to "current sign-in kept", plus cases for a signed-out install, a legacy token and half a sign-in. |
| `90020d0` | **OD-PL-4.** `src/backup.js` `stageRestore` makes the safety backup with `includeSecrets: false`, so it holds no Gemini key, no server passwords and no sign-in, and the list shows no "with key" badge for it (`public/system.js:80` is driven by the manifest; older safety backups that hold secrets keep the badge, which is still right for them). Header comment, README, ARCHITECTURE and CHANGELOG updated. Tests: the safety backup's settings, race.json and raw zip hold none of the key, password, token or Steam id; **undoing a restore** with it keeps the key, the saved server's password and the sign-in the install has then (`test/secrets.test.js`); `test/appmgmt.test.js:87` now expects `includesSecrets: false`. |
| `cb5ff43` | **OD-PL-5 (b).** `src/jsonfile.js` records each file `loadJson` kept aside or could not read (`fileIssues` `:55`: file name, state, damaged, name of the copy kept, time; never the folder, the contents or the parse error, which can quote the file). `src/settings.js` `fileNotices` (`:108`) keeps the three own files in `data\` and adds damaged copies left from earlier runs (`<name>.unreadable-<ms>`), newest first, max 10. `/api/settings` (existing route, `src/server.js`) returns `fileNotices` and `canSave`. `public/settingspage.js` shows a notice under the Settings title (`note-warn`, `role="status"`, theme tokens, plain text and links only): which file, where the copy is (`data/<name>`), how to recover (repair it or rename it back, or enter the settings again; links to the Race / Setups tabs), and, for a file that could not be read, that saving it is refused until it can be. Tests: `test/jsonfile.test.js` (damaged settings/race named with their copies, no folder or content, other folders ignored, earlier copies listed until deleted), `test/settings-locked.test.js` (unreadable: `failed` + `savesRefused`, gone once readable), `test/browser.flows.js` (damaged `setup-meta.json` before start: the API reports it and the page renders the notice with the copy name and a Setups link, no full path). |
| (this commit) | `docs/DECISIONS.md` (OD-PL-1 … 7 `DECIDED (user, 2026-11-24)`), this report, `docs/PHASE_LOG.md`, `docs/DEVELOPMENT_STATE.md`. |

## Verified findings / rejected assumptions / unresolved

- **Undo restore (verified by test):** restoring the secret-free safety backup keeps the current key, passwords and sign-in because restores already keep every secret a backup leaves out (`src/sensitive.js` `mergeRestoredSettings`, `src/restore-apply.js` `mergeRace` `:24`). Consequence, by design of OD-PL-4: what was in place *before* the restore cannot come back from the safety backup. If the restored backup brought another key, undoing keeps that key; a saved password for a server the install no longer lists stays empty (tested on a preset).
- **The "with key" badge** needed no code change: it follows `includesSecrets` in each backup's manifest.
- **Earlier damaged copies** are not part of the decision text; listing them is the read-only reading of "where the damaged copy was kept": a copy made in an earlier run (after a restart the original state is gone) is still named until the driver deletes it. No new state or delete button was added.

## Tests run and results

- `npm run check`: 116/116 (unchanged).
- `npm test`: 215/215 → **218/218** on Node 22.23.4.
- `npm run test:electron`: **218/218** on Node 24.22.2 (Electron 44.11.1).
- `npm run test:browser`: 6/6 → **7/7** (headless Edge).

## Checks that could not run

- No visual check of the notice beyond the DOM assertions in the browser test (light/dark themes use the existing `note-warn` tokens).
- No game, Steam or Cloudflare checks (not touched).

## Performance or compatibility impact

- `/api/settings` reads the `data\` folder listing once per call (Settings page only). `/api/status` is unchanged.
- Backups: format unchanged. Old safety backups with secrets still restore as before.

## Migration and recovery implications

- No DB change. Recovery from a damaged file is now explained on the Settings page; the kept copy is never deleted by Paddock.

## Needs approval

- Push / merge of `platform/pl1-decisions`.

## Open decisions

- None new. OD-PL-8 and OD-PL-9 stay **OPEN (operator)**.

## Remaining risks

- A damaged copy (`settings.json.unreadable-*`) can hold the Gemini key in plain text in `data\` until deleted (as since PL1; backups never include it). The notice tells the driver to delete it when done.
- `src/restore-apply.js` reads the current `settings.json` with a plain parse; if it is damaged at restore time the current key and sign-in are not kept (pre-existing, unchanged; restore and damage together are unlikely).
- The notice for earlier copies stays until the file is deleted by hand; drivers who keep the copy see it every time they open Settings.

## Recommended next phase

- Review and merge PL1D with PL2 into `platform/integration`, then PL3 (recording reliability and performance), see `docs/platform/BACKLOG.md`.
