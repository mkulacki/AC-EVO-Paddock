# PL1D report: the user's decisions on the PL1 open questions

- **Date:** 2026-11-24 · **Branch:** `platform/pl1-decisions` (from `675441f`, the PL2 merge)
- **Scope:** apply the user's answers (2026-11-24) to OD-PL-1 … OD-PL-7 (`docs/DECISIONS.md`). OD-PL-8 and OD-PL-9 stay open.
- **Result:** complete, including the review round (below). Nothing pushed or merged.

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

- **Undo restore (verified by test):** restoring the secret-free safety backup keeps the current key, passwords and sign-in because restores already keep every secret a backup leaves out (`src/sensitive.js` `mergeRestoredSettings`, `src/restore-apply.js` `mergeRace` `:24`). First-round consequence (superseded by decision A in the review round): if the restored backup brought another key, undoing kept that key. Since "current secrets win", a restore never replaces a key or password in the first place, and servers missing from a backup are kept, so nothing needs to come back from the safety backup.
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

- None new. OD-PL-8 (no Dependabot) and OD-PL-9 (scratch `ACE_DIR` in step 6) were decided by the user in the review round.

## Review round (independent review + user decisions A–C, 2026-11-24)

| Commit | Change |
| --- | --- |
| `9ca4649` | **Decision A, current secrets win** (fixes the important finding: a restore of a backup *with* secrets replaced the current key and passwords, and servers missing from the backup were dropped with theirs). `src/sensitive.js` `mergeRestoredSettings`: a non-empty current secret always stays; only an empty one is filled from the backup. `src/restore-apply.js` `mergeRestoredRace` (exported): every password takes the current one of the same server (id, else host:port; saved servers first), only an empty one keeps the backup's; current servers absent from the backup are kept; current presets absent from the backup are kept when they hold a password. Confirm text (`public/system.js:123`), README, CHANGELOG. Tests: restoring a with-secrets backup keeps the current key/passwords and the extra server and preset; empty ones are filled; id vs host:port matching. |
| `901c537` | **Decision B**: Dismiss (persisted per copy name in `data\notices-dismissed.json`, pruned of copies that are gone) and Delete copy (on-page confirm row, focus on "Keep it", Esc cancels; no `confirm()`). `POST /api/settings/notice` (`src/server.js`, behind `foreignRequest`) → `src/settings.js` `dismissNotice` / `deleteKeptCopy`: name must match the kept-copy pattern, equal its own basename and be a regular file in `data\`. **Nits 2–3**: Save is disabled with the reason when `canSave` is false (the error path stays); the notice is `role="note"`. Tests: unit (dismissal per copy, new copy shown, live files / traversal / folders / other names refused), browser (keyboard Dismiss, confirm step and Esc, API refusals incl. foreign origin, Save state). The test helper's Enter now carries `"\r"`, as a real key press does. |
| `f981b82` | **Nit 4, flaky keyboard browser test, root cause:** `public/system.js` backup and update cards draw after their API answers and look up their parts by id (`$('#bkTotal')`, `$('#updOn')`). When the driver leaves Settings before the answer arrives (the test's Alt+0 then Alt+1), the lookups return null and throw a TypeError, which the test's "no page errors" check caught about 1 run in 5 (seen as `TypeError … at total (system.js:91)`). The cards now draw only while still on the page (`box.isConnected`). New browser test delays the two answers and leaves at once: fails without the fix, passes with it. |
| `6df2d09` | **Decision C (OD-PL-9):** `CLAUDE.md` release step 6 says to use `npm run smoke:packaged`, or by hand to set `$env:ACE_DIR` to a scratch folder too. |
| (this commit) | DECISIONS (D-PL1D-1, D-PL1D-2, OD-PL-8 and OD-PL-9 decided, the OD-PL-4 line fixed), this report, PHASE_LOG, DEVELOPMENT_STATE. |

Tests after the review round: `npm run check` 116/116; `npm test` **222/222**; `npm run test:electron` **222/222** (Node 24.22.2); `npm run test:browser` **11/11 in 10 consecutive runs, 0 failures**.

## Remaining risks

- A damaged copy (`settings.json.unreadable-*`) can hold the Gemini key in plain text in `data\` until deleted (as since PL1; backups never include it). The notice tells the driver to delete it when done.
- `src/restore-apply.js` reads the current `settings.json` with a plain parse; if it is damaged at restore time the current key and sign-in are not kept (pre-existing, unchanged; restore and damage together are unlikely).
- (Resolved in the review round: the notice can be dismissed per copy, or the copy deleted from the page.)

## Recommended next phase

- Review and merge PL1D with PL2 into `platform/integration`, then PL3 (recording reliability and performance), see `docs/platform/BACKLOG.md`.
