# PL4 report: compatibility, provenance and trustworthy comparisons

- **Branch:** `platform/pl4-compatibility` (from `ab2ba8c`, the PL3 merge). Not pushed, not merged.
- **Date:** 2026-11-25
- **Scope:** `docs/platform/BACKLOG.md` PL4 (4.1 version-aware channel verification, 4.2 comparison compatibility, 4.3 integration health panel).

## What changed

| Commit | What |
| --- | --- |
| `7b94228` | 4.1: version-aware telemetry checks. `src/channels.js` records `{ok, game, adapter, at, method, car}` per group; old booleans (and the 0.5 switch) migrate as legacy records that no longer count; `evaluate()` gives `status`, the three-class `state` (verified / unverified / unsupported), a reason and `needsRecheck`. `PARSER_REV` + `OFFSETS_HASH` tie checks to the `src/shm.js` layout. Server wiring (`channels.configure`, `channels.migrate` at start, live car for per-car groups), Setups shows why a check does not count with **Still matches** / **Forget**, Home asks for a re-check after an update, Diagnostics show the check context, Car & setup evaluates per car, the replay G circle is labelled unconfirmed. |
| `cf0dc21` | 4.2: `src/compat.js` (provenance from a lap row, merge for the ideal lap, classify, mix). `svc.compare` adds `compat` per lap and overall with the channels the charts rest on; Consistency and Progress add `compat` (what varies). Compare page: "Like for like" line, "Compare with care" list (each caveat with "What it changes"), "Not comparable" gate with **Compare anyway**. Consistency and Progress: closed "Mixed laps" note. New laps store `cond.reader`. `leaderboard.health()` (cheap last-known state, used by 4.3). |
| `9a6340e` | 4.3: `src/health.js` + `GET /api/health`; "Integration health" card on the Game page (state in words, details, numbered steps, link; open rows kept open across the 2 s redraw); Ctrl+K entry. Browser tests for caveats, the incompatible gate and the panel. |
| `4c7d2bf` | Audit fix: setup names and temperatures the driver marked as not matching the game are removed from the debrief, coach and setup engineer prompts. |
| `b59541c` | Review fixes 1, 2, 4, 7 and OD-PL-18 (b): `''` is a real layout (merge/classify); setup-history temperatures dropped when marked wrong; the Racing line replay tab gets the same caveats and gate; unconfirmed temperatures/aids are a caveat, not a match; "Different setups" says when recognition is unconfirmed; Mixed laps only when recorded values differ and ignores groups marked wrong. |
| `8703dff` | Review fixes 3, 5, 6, 9 (and the server part of 2): "matches" refused with a reason while the game version or HUD reader is unknown; unknown `channelChecks` keys kept; downgrade behaviour documented; engineer gets `by_setup_data_quality` and no `setup_driven` when recognition is wrong; `/api/health` without folder paths and behind the private-GET guard. |
| `7122012` + review docs commit | This report, `docs/DECISIONS.md` (D-PL4-1…8, OD-PL-12…18), `docs/PHASE_LOG.md`, `docs/DEVELOPMENT_STATE.md`, `docs/platform/BACKLOG.md`, `docs/ARCHITECTURE.md`, `docs/FEATURE_INVENTORY.md`, README, CHANGELOG. |

New files: `src/compat.js`, `src/health.js`, `test/channels-version.test.js`, `test/compat.test.js`, `test/health.test.js`.

## Verified findings / rejected assumptions / unresolved

Line numbers refer to `ab2ba8c` (before PL4) unless marked.

**Existing P2 provenance (extended, not replaced):**
- `src/channels.js:15-42` groups with `builtIn` status; `:45-51` `checks()` read `settings.channelChecks` as `{group: true|false}` plus the 0.5 `probeConfirmed` switch; `:53-59` `status()`; `:68-79` `confirm()`; `:82` `usable()`; `:85` `forAi()`. Used by `src/carreport.js:158-161,258-269`, `src/server.js:133,598,603,630,648,653,726,756`, `src/ai.js:122,247`, `src/coach.js:89,269`, `src/diagnostics.js:82`, `public/setups.js:418-433`, `public/util.js:80-95` (`prov()` badges).
- **Verified:** a check was not tied to any game build or reader (`src/channels.js:45-59`). Fixed in `7b94228`.
- **Verified:** lap provenance already exists without a schema change: `laps.cond` `{airC, roadC, weather, grip, game, app}` written after each lap (`src/leaderboard.js:177-185`, column added at `src/db.js:79-81`), `laps.setup_info.snap` (`src/db.js:192`), `laps.aids.cls` (`src/aids.js:43-58`), session type via `sessions.session_type`. Laps from before 0.7, imports and mock laps lack most of it.
- **Verified:** Compare's only compatibility check was the resampled grid size (`src/service.js:258`): a lap of another car on the same layout could be compared silently (by URL or a lap id as reference). Now classified incompatible and gated.
- **Verified (found by a test):** the resample cache keeps the lap row from when it was first read (`src/service.js:58-73`), but `cond` and `aids` are written a moment after the lap event; provenance now re-reads the row (`db.getLapMeta`).
- **Verified:** with setup recognition or temperatures marked as not matching, the AI prompts said "known to be WRONG: left out" but still carried setup names and temperatures (`src/ai.js:247`, `src/coach.js:85`, `src/server.js:132`). Fixed in `4c7d2bf`.
- **Verified:** the replay G circle drew `gforce` (built-in unverified) without a label (`public/replay.js:63`). Labelled.
- **Verified:** the game version Paddock trusts is the one in the game's newest log (`src/game.js:26-35`), the same source as `laps.cond.game`. The shared-memory `evoVersion` (`src/shm.js:31,106`) is read but its offset is not checked in game; PL4 does not use it.
- **Rejected:** "a DB migration is needed" (BACKLOG PL4): no schema change; checks live in `settings.json`, lap provenance in existing JSON columns. The DB migration rules were therefore not exercised.
- **Rejected:** "the health panel needs new data": everything comes from the recorder, `game.status()`, `hudInstall.status({quick})`, `channels.list()`, `perf.summary()` (PL3), `leaderboard` last state and `updates.status()`.
- **Unresolved (needs the game):** whether `evoVersion` matches the log version; how often AC EVO updates change the shared-memory layout; the HUD's aids readings are used for leaderboard class boards while the `aids` group is unverified (pre-existing; PL10 trust model).

## Review round (2026-11-25)

Independent review findings, all fixed with a regression test each:

1. `src/compat.js` `merge()` turned layout `''` (normal for one-layout tracks, `src/shm.js:169`) into `null`, so the ideal lap was "Another track or layout". Fixed: `''` is a value; `null` (not known) and MIXED stay incompatible.
2. `src/setuphistory.js:149` sent `air_c`/`track_c` to the coach and the AI engineer with temperatures marked wrong. Fixed in `setuphistory.forAi`; the engineer also gets `by_setup_data_quality` and no `setup_driven` when recognition is marked wrong.
3. A "matches" made while the game version was unknown was stored with `game: null` and could never count, with a misleading reason. Now refused (409) with the reason in Setups ("start AC EVO once"), also for HUD readings with no HUD installed; such old records say "checked while the game version was not known".
4. The Racing line replay tab (`public/compare.js`) bypassed the gate and showed no caveats. Same list and gate now; "Compare anyway" counts for both tabs.
5. Downgrade: 0.7 reads records as not checked, so a mismatch shows as unconfirmed there. Documented in `confirm()` and D-PL4-2 (no boolean mirror: the key can hold one value).
6. Unknown `channelChecks` keys were dropped on write; now kept, and they never trigger a migration.
7. `mix` ignored marked-wrong groups only partly, unconfirmed temperatures counted as matched, "Different setups" did not say recognition was unconfirmed: fixed (D-PL4-10).
8. `cond.reader` goes into exported lap files: documented (D-PL4-5).
9. `/api/health` passed raw error texts with paths: `noPaths()` keeps the file name only (quoted paths with spaces too); `/api/health` added to `PRIVATE_GET`.

User decisions: OD-PL-12 … 17 (a) as built; OD-PL-18 changed to (b) and implemented; D-PL4-1 … 8 confirmed. Then D-PL4-12 (user): readings not confirmed yet are one combined line on both compare tabs with a link to Setups (commit "PL4: one combined line for unconfirmed readings"); level and strictness unchanged; unit test and the browser caveat flow extended (laps get recorded temperatures in the browser fixture).

## Tests run and results

| Command | Before (PL3 + review) | After |
| --- | --- | --- |
| `npm run check` | 119/119 | 124/124 (124/124 after review) |
| `npm test` (Node 22.23.4) | 240/240 | 272/272 → 279/279 after review → 280/280 after D-PL4-12 |
| `npm run test:electron` (Node 24.22.2) | 240/240 | 272/272 → 279/279 after review → 280/280 after D-PL4-12 |
| `npm run test:browser` (headless Edge) | 13/13 | 16/16 (replay-tab gate added to an existing flow) |

New coverage: version-aware records, migration, damaged records, per-car checks, mismatch persistence, OFFSETS revision guard (`test/channels-version.test.js`, 10); compatibility classes, caveat effects, unknowns, channel quality, ideal-lap merge, payloads of compare/consistency/progress (`test/compat.test.js`, 13); health states (`test/health.test.js`, 7); `/api/health` and check context in the smoke test (a fake game log gives the version); AI prompts drop data marked wrong (`test/provenance.test.js`); browser: caveats open from the keyboard, the incompatible gate and **Compare anyway**, the health panel (state words, Enter toggles, open state kept across redraws, palette entry).

## Checks that could not run, and why

- In game: no AC EVO here. Real game versions, shared memory, the HUD data feed, per-car aids and suspension checks and the health panel with a running game are unverified; the panel was checked against the mock source and synthetic inputs only.
- The panel and the compare cards were checked through DOM assertions, not looked at in both themes (they use the existing tokens: `--accent-soft`, `--warning`, `--critical`, `--border`).
- `npm run bench` and `npm run smoke:packaged` were not rerun: nothing in the 60 Hz loop changed (only a new route and per-request work on Compare).

## Performance or compatibility impact

- Compare does a few more small queries per lap (`getLapMeta`, `getSession`; for the ideal lap one per source lap, usually ≤ 15). Consistency and Progress parse three JSON columns per lap they already read. No change to the telemetry loop.
- `channels.currentGame()` reads the game log at most every 5 s.
- **Behaviour change (OD-PL-12):** groups checked with an older Paddock show as unconfirmed until the driver confirms them once more. An older Paddock reading the new records shows them as not checked.
- Old laps and imports show a "Not recorded for one of the laps" caveat on Compare (OD-PL-15). The Mixed laps note appears only when recorded values differ (OD-PL-18 (b)).
- While AC EVO's log is not found (game never started on this PC), no group can be confirmed as matching (D-PL4-9).

## Migration and recovery implications

- No database change. `settings.json`: `channelChecks` booleans are rewritten once at start as legacy records (atomic write, `src/jsonfile.js`); the information kept is the same (ok + "legacy"), so going back loses nothing. Undo: the old boolean meaning is `record.ok`. Backups carry the records like any other non-sensitive setting.
- `laps.cond` gains `reader` for new laps only; old laps are untouched.

## Needs approval

- Push and merge of `platform/pl4-compatibility` (and the earlier branches, see `docs/DEVELOPMENT_STATE.md`). Nothing deployed, no network or privacy default changed.

## Open decisions (added to DECISIONS.md)

None open. OD-PL-12 … 17 decided (a) as built, OD-PL-18 decided (b) (user, 2026-11-25); D-PL4-1 … 8 confirmed; D-PL4-9 … 11 added in the review round.

## Remaining risks

- Re-check fatigue: every AC EVO or HUD update asks for new checks (OD-PL-13 (a)); drivers may stop checking, which leaves hints unconfirmed rather than wrong.
- "Not recorded" caveats are nearly universal on old histories and may be ignored (OD-PL-15). With temperatures and aids unconfirmed (the usual state), most comparisons also carry the combined "Some readings aren't confirmed yet" line until the driver checks them once (D-PL4-12).
- The game version comes from the newest log file: if AC EVO stops writing `version x.y.z,` at the top of its log, every check counts as not checked (cautious, but silent); the health panel then shows "game version not known".
- `PARSER_REV` relies on the OFFSETS hash test; offsets read outside `OFFSETS` would not be caught.

## Recommended next phase

PL6 (actionable lap analysis) can now exclude or label laps by `src/compat.js` classes (`mix`, `classify`); or PL5 (onboarding) reusing `/api/health` for the "verify integrations" step. Decide OD-PL-12/13/15 first: they change what PL6 counts as comparable.
