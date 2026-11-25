# PL8 report: controlled setup experiments

- **Date:** 2026-11-25 · **Branch:** `platform/pl8-setup-experiments` (from `87b3131`, the PL7 merge) · not pushed, not merged
- **Scope:** `docs/platform/BACKLOG.md` (PL8). Rules, thresholds and limits: `docs/platform/EXPERIMENTS.md`.
- **Decisions:** the user asked not to wait on decisions (2026-11-25): every product choice beyond the plan was applied with the recommended (most conservative) option and recorded as OPEN (operator) for review in the app (OD-PL-42 … 53).

## What changed

| Commit | What |
| --- | --- |
| `846622a` | Schema v4 (`src/db.js`): `setup_experiments`, `experiment_entries`, versioned, one pre-upgrade `VACUUM INTO` copy, orphan journal entries pruned at start; `test/fixtures/db-v3-pl7.sql` (schema dump at `87b3131`); v3 → v4 test; newer-database guard tests moved to `user_version` 5 |
| `60f1b36` | `src/experimentstats.js` (pure): stint assignment, exclusions with reasons, matched conditions through `compat.classify`, per-setup summaries, Hodges–Lehmann shift, the result (difference / inconclusive with its reason), confounds, expected outcome, feedback summary, plan progress; `test/experimentstats.test.js` |
| `513c867` | `src/experiments.js` (options from the P7 setup history and this track's saved files, create, stints live or by session, journal, feedback, review, reopen, archive, restore, delete, warnings for edited/missing files and game updates); `/api/experiments` (private GET); `src/setups.js` ancestry (`basedOnRel`, `lineage`, renames carry it); lifecycle and `.carsetup` round-trip tests |
| `64a38a8` | `public/experiments.js` pages `#/experiments` and `#/experiment`, card on Setup history, Ctrl+K entries, styles; browser flow (create, run, review, archive) |
| `c093f31` | `docs/platform/EXPERIMENTS.md`, DECISIONS (D-PL8-1 … 8, OD-PL-42 … 53), inventory, architecture, backlog, changelog; "counted by stint only" row |
| `9aefbc0` | this report, `docs/PHASE_LOG.md`, `docs/DEVELOPMENT_STATE.md` |
| `ea78bdf` | Review fixes 1–7 (see "Review round" below) with regression tests |
| (this commit) | review-round docs |

## Verified findings / rejected assumptions / unresolved

Verified (what PL8 builds on):

- P7 setup history: `src/setuphistory.js:40` `history` groups a car + track's laps by `keyOf` (`snap:<hash>@<rel>`, `file:<rel>`, `standard`, `none`, `:27`), `:88` `valuesOf`, `:104` `compareValues`; values per lap come from `setup_info.snap` → `setup_snapshots` (`src/setupmatch.js` `pick`, sha1 of the values, first 16 hex). Experiments reuse these for the variant list and for "what differs between A and B".
- `.carsetup` editing: `src/setups.js` `saveValues` / `copyTo` / `importFile` / `exportFile` write through temp + rename; `src/carsetup.js:41` `decode` / `:56` `encode` are byte-identical (`test/formats.test.js:39`). PL8 adds only metadata in `data/setup-meta.json` (`basedOnRel`); no `.carsetup` byte changes. Tested: an experiment's whole lifecycle leaves every file byte-identical and adds none; export equals the file; a refused import writes nothing; a rename keeps the bytes and the ancestry.
- Saved setups already recorded their parent by name only (`basedOn`, `src/setups.js` `saveValues` / `copyTo`): not enough for a chain; `basedOnRel` added (older saves end the chain at the name).
- PL4 `compat.classify` (`src/compat.js:78`) works as the matched-condition filter when the reference is the experiment's typical conditions and setup/game version are neutralised; unconfirmed caveats carry `unconfirmed` and never exclude a lap.
- PL6 `src/stats.js` `summary` / `apart` / `theilSen` are enough for the descriptive comparison; one helper added locally (Hodges–Lehmann shift).
- Game version per lap is `laps.cond.game` (`src/leaderboard.js` `onLap`, written for every lap); the current version is `src/game.js` `gameVersion()`.

Rejected: "experiments need their own setup storage" (no: variants point at setup history entries and saved files); "a lap's recognised setup can decide A or B" (setup recognition is unverified until checked in game, PL4; stints decide, recognition only removes contradicting laps, OD-PL-42).

Unresolved: thresholds untested on real AC EVO stints (no game here); whether drivers will start/end stints in Paddock while driving or prefer adding sessions afterwards; no objective corner-phase comparison of A and B (only the driver's feedback).

## Tests run and results

| Suite | Before (`87b3131`) | After |
| --- | --- | --- |
| `npm run check` | 144/144 | 149/149 |
| `npm test` (Node 22.23.4) | 369/369 | 388/388 |
| `npm run test:electron` (Node 24.22.2, Electron 44.11.1) | 369/369 | 388/388 |
| `npm run test:browser` (headless Edge) | 23/23 | 24/24 (2 runs) |

New: `test/experimentstats.test.js` (11: a clear ABBA gap decided on typical laps although A has the best lap; same pace inconclusive; too few laps; one stint each inconclusive with order in bold; every exclusion reason counted; unconfirmed temperatures never exclude; recognition ignored when marked wrong; learning confound; stints by session and window; feedback summary; expected outcomes; patch flag; Hodges–Lehmann), `test/experiments-db.test.js` (8: v3 → v4 upgrade with copy and unchanged tables; storage; options and ancestry; create validation; ABBA from past sessions; live stint, one open per car + track, feedback and journal; review saved, lap deletion flagged, game update warning, follow-up, archive / restore / reopen; `.carsetup` byte-identity). Updated: `test/pl5-review.test.js`, `test/notes.test.js`, `test/practice-db.test.js`, `test/db-migration.test.js` (schema 4, guards at 5). Browser: one PL8 flow.

## Checks that could not run, and why

- `npm run smoke:packaged` and the packaged exe: not run (the user's AC EVO Paddock is running on port 8080; instructed to leave it alone).
- In-game behaviour: no game here. Real stints, setup recognition and temperatures in an experiment are untested; thresholds are tuned on synthetic laps only.
- Setup files with readable values: the car catalogue is not available to the tests' synthetic car, so variants were identified by recorded snapshots (the path for a file Paddock cannot read). A real car's file values go through `setupmatch.candidates`, unchanged code.

## Performance or compatibility impact

- An experiment page reads one car + track's lap rows (no traces) and its journal: the same cost as the Setup history page. Nothing runs in the 60 Hz loop; nothing is worked out in the background.
- Older Paddock: 0.7.0 opens a v4 file (it ignores unknown tables); PL5 … PL7 builds refuse it (newer-database guard: recording off, file untouched).

## Migration and recovery implications

- v3 → v4 adds two empty tables in one transaction after one `telemetry.backup-v3-<time>.db` copy (only when the database holds rows); the copy is the recovery path (restore it with an older Paddock). If the copy cannot be made, the upgrade still runs (new tables only) and the reason is logged.
- `data/setup-meta.json` gains `basedOnRel` / `basedOnTrack` on new saves and copies; older Paddocks ignore unknown keys.

## Needs approval

- Push and merge of `platform/pl8-setup-experiments` (into `platform/integration`, then `main`). Nothing else prepared: no backend, deploy, cost or privacy change.

## Open decisions (added to DECISIONS.md)

OD-PL-42 … 53, each **OPEN (operator), recommended default applied, user reviews in the app**: lap assignment (stints, recognition removes contradictions), default plan (ABBA, 6 laps, 1 warm-up), evidence for a difference (5 laps, apart, 2 stints each), slow laps (3 % of the median), matched conditions (on, certain differences only), unrecognised laps (counted by stint), one running stint per car + track, game updates (left out, follow-up suggested), review (driver's decision, never automatic), where it lives (own pages under Setups), track-only variants, delete only from the archive. D-PL8-1 … 8 record the implementation choices.

## Remaining risks

- Thresholds unchecked on real laps; the 3 % slow-lap rule may keep small traffic losses and the 2-stint rule may feel strict.
- A renamed setup file breaks the link between an experiment and its laps recorded after the rename (said in a warning; laps recognised as "another file" are left out).
- Fuel and tyre state per stint are not observable; only stated as a confound.
- Experiments are not visible to the AI setup engineer (by choice, D-PL8-7).

## Review round (2026-11-25)

An independent review found: (1) identical lap times gave a 0 ms interval, so a 1 ms gap read as a difference: interval floor ±50 ms (D-PL8-9); (2) overlapping stints were accepted and a lap went to the first matching stint: overlaps refused, each lap in one stint, order-independent (D-PL8-10); (3) warm-up was per stint, so the cold lap after a restart inside a stint counted: warm-up per run (session or 5-minute pause, D-PL8-11); (4) no successful `.carsetup` import was tested: import → export → copy now tested byte-identical with a test catalogue (`setups.useCatalogs`, D-PL8-14); (5) laps without recorded conditions could give a clean "difference": now inconclusive with the reason in the verdict (OD-PL-46 refinement, operator default); (6) prototype keys (`constructor`) passed enum lookups and could break the list page: own-key checks (D-PL8-12); (7) a session stint whose laps were deleted showed as driven: "no laps", not counted (D-PL8-13). Fixed in `ea78bdf`. Tests after the review: check 149/149, test 397/397 (Node 22), test:electron 397/397 (Node 24), test:browser 24/24.

## Recommended next phase

PL9 (HUD and live assistance): the HUD could show the running experiment stint (A/B and laps so far) next to the active drill; keep the default assistance frequency.
