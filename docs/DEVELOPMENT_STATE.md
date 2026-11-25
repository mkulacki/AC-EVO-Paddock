# Development state

_Last updated: 2026-11-25 (PL11)_

**Status:** P0–P10 done; **0.7.0-beta.1 released 2026-11-23**. Platform plan PL0–PL11 (the local operator plan, not in the repo; phase scopes are summarised in `docs/platform/BACKLOG.md`) started.
**Current phase:** PL11 (data ownership) done on `platform/pl11-data-ownership` (2026-11-25); operator defaults OD-PL-74 … 82 await the user's review. PL10 is merged locally (`d97a278`); its D1 migration 0003 and Worker deploy are still prepared, **not executed**.
**Branch:** `platform/pl11-data-ownership` (from `d97a278`; not pushed, not merged).

## Phases

| Phase | Name | Status |
| --- | --- | --- |
| P0 | Repository audit + roadmap | Done, approved 2026-11-17 |
| P1 | Test foundation and baseline | Done, approved 2026-11-17 |
| P2 | Data provenance and AI confidence | Done, approved 2026-11-17 |
| P3 | Application management | Done, approved 2026-11-17 (D2: check and notify) |
| P4 | App shell: navigation, command palette, states | Done, approved 2026-11-17 (D1: lime + sidebar) |
| P5 | Driver home dashboard | Done, approved 2026-11-17 |
| P6 | Driving technique analysis | Done, approved 2026-11-17 |
| P7 | Setup history and comparison | Done, approved 2026-11-17 |
| P8 | AI coach upgrade | Done, approved 2026-11-17 |
| P9 | Driver development | Done, approved 2026-11-17 (D3: yes) |
| P10 | Final regression and release prep | Done, approved 2026-11-18, released |
| PL0 | Platform baseline (docs only) | Done 2026-11-24, merged into `platform/integration` |
| PL1 | Security and data safety | Done 2026-11-24, merged into `platform/integration` |
| PL2 | Quality and release checks | Done 2026-11-24, merged (`675441f`) |
| PL1D | User decisions on OD-PL-1 … 9 + review round | Done 2026-11-24, review pending |
| PL3 | Recording reliability and performance | Done 2026-11-24, merged locally (`ab2ba8c`) |
| PL4 | Compatibility and provenance | Done 2026-11-25, review fixes applied (`b59541c`, `8703dff`) |
| PL5 | Onboarding and usability | Done 2026-11-25, review fixes applied (`5395369`, `9abd626`) |
| PL6 | Actionable lap analysis | Done 2026-11-25, review fixes applied (`76bb4ec`) (`docs/platform/PL6-report.md`) |
| PL7 | Structured practice | Done 2026-11-25, review fixes applied (`d0097a2`) (`docs/platform/PL7-report.md`) |
| PL8 | Setup experiments | Done 2026-11-25, review fixes applied (`ea78bdf`), awaiting the user's review (`docs/platform/PL8-report.md`) |
| PL9 | HUD and live assistance | Done 2026-11-25, review fixes applied (`f2d4e9f`, `eee30ee`, `d5da044`), awaiting the user's review (`docs/platform/PL9-report.md`, `docs/platform/HUD_BRIDGE.md`) |
| PL10 | Leaderboard integrity | Done 2026-11-25, awaiting the user's review; migration and deploy need approval (`docs/platform/PL10-report.md`, `docs/platform/LEADERBOARD_TRUST.md`, `docs/platform/COMMUNITY_DESIGN.md`) |
| PL11 | Data ownership | Done 2026-11-25, awaiting the user's review (`docs/platform/PL11-report.md`, `docs/platform/DATA_OWNERSHIP.md`, design only: `docs/platform/EXTENSIBILITY_DESIGN.md`) |

## Current task

None in progress. PL11 is committed on `platform/pl11-data-ownership`: scheduled verified backups (off by default), retention and storage forecast, crash recovery of interrupted sessions, report files (Save as HTML), the demo (`data\demo`); report `docs/platform/PL11-report.md`. The live leaderboard is still unchanged: PL10's `leaderboard/migrations/0003_integrity.sql` is not applied and its `worker.js` is not deployed.

## Known problems

- Shared-memory groups (pit-box readings, temperatures, tyres, brakes, suspension) are unverified until the user checks them in game (Setups → Setup recognition). Slip can't be checked. Since PL4 a check counts only on the game version (and reader) it was made with; checks from before PL4 count as not checked until confirmed again (OD-PL-12).
- PL1 fixed the PL0 data-safety defects (sign-in in backups, lap import, zip extraction, mod rollback, atomic settings writes); each has a regression test. PL1D applied the user's decisions: restores keep the current sign-in and never replace a current key or password (current secrets win), the before-restore backup holds no secrets, and Settings names a damaged data file with Dismiss / Delete copy (OD-PL-1, -4, -5); mod uploads stay uncapped by choice (OD-PL-6).
- The database is at schema v4 since PL8 (v2: notes, tags, bookmarks; v3: `drill_events`; v4: `setup_experiments`, `experiment_entries`). Setup-experiment thresholds (OD-PL-42 … 53) are operator defaults tuned on synthetic laps only. The first start after an upgrade makes one copy `telemetry.backup-v<old>-<time>.db` when the database holds user rows (OD-PL-21). Practice-drill thresholds (OD-PL-32 … 41) are tuned on synthetic laps only; drills need laps with a recorded game version.
- The Lap analysis thresholds (OD-PL-26 … 29) are tuned on synthetic and mock laps only; not checked against real AC EVO laps. The Consistency page and the AI coach still read every lap's full trace at once.
- CI (`.github/workflows/ci.yml`) has never run: it needs a push. The Ubuntu job has never run on Linux.
- The packaged app installs the loader and HUD into `ACE_DIR` at start; CLAUDE.md step 6 now uses a scratch `ACE_DIR` too (OD-PL-9, decided).

## Test results

- PL0 baseline (2026-11-24, `be3b5ef`): `npm run check` 104/104; `npm test` 175/175.
- PL1 with review fixes (2026-11-24, `platform/pl1-data-safety`): `npm run check` 112/112; `npm test` 213/213 (22 files).
- PL2 (2026-11-24, `platform/pl2-quality`): `npm run check` 116/116; `npm test` 215/215 on Node 22.23.4; `npm run test:electron` 215/215 on Node 24.22.2; `npm run test:browser` 6/6; `npm run smoke:packaged -- --build` passed. One command: `npm run verify`.
- PL1D after round 3 (2026-11-24, `platform/pl1-decisions`): `npm run check` 116/116; `npm test` 226/226; `npm run test:electron` 226/226; `npm run test:browser` 13/13 in 5 consecutive runs (11/11 ×10 after round 2).
- PL3 (2026-11-24, `platform/pl3-recording-perf`): `npm run check` 119/119; `npm test` 236/236; `npm run test:electron` 236/236; `npm run test:browser` 13/13. `npm run bench` (not in the suite): longest 60 Hz hold 7.4 s → 26 ms with 612 laps on one car/track, live run 44 s → 0.58 s. After the review fixes (`6c1d08a`, 2026-11-25): test 240/240, test:electron 240/240, check 119/119, test:browser 13/13.
- PL4 (2026-11-25, `platform/pl4-compatibility`): `npm run check` 124/124; `npm test` 272/272 (Node 22.23.4); `npm run test:electron` 272/272 (Node 24.22.2); `npm run test:browser` 16/16. After the review fixes: check 124/124, test 279/279, test:electron 279/279, test:browser 16/16.
- PL5 (2026-11-25, `platform/pl5-onboarding`): baseline at `4d25a15` check 124/124, test 280/280; after: `npm run check` 130/130; `npm test` 299/299 (Node 22.23.4); `npm run test:electron` 299/299 (Node 24.22.2); `npm run test:browser` 21/21 (4 runs). After the review fixes: check 131/131, test 306/306, test:electron 306/306, test:browser 21/21 (3 runs).
- PL6 (2026-11-25, `platform/pl6-analysis`): baseline at `c65fa65` check 131/131, test 307/307, test:browser 21/21; after: `npm run check` 138/138; `npm test` 337/337 (Node 22.23.4); `npm run test:electron` 337/337 (Node 24.22.2); `npm run test:browser` 22/22 (2 runs). Lap analysis of 30 laps: longest hold 12.7 ms. After the review fixes: check 138/138, test 346/346, test:electron 346/346, test:browser 22/22 (2 runs).
- PL8 (2026-11-25, `platform/pl8-setup-experiments`): baseline at `87b3131` check 144/144, test 369/369, test:browser 23/23; after: `npm run check` 149/149; `npm test` 388/388 (Node 22.23.4); `npm run test:electron` 388/388 (Node 24.22.2); `npm run test:browser` 24/24 (2 runs). Packaged smoke not run (port 8080 in use). After the review fixes: check 149/149, test 397/397, test:electron 397/397, test:browser 24/24.
- PL9 (2026-11-25, `platform/pl9-hud-live`): baseline at `9bab779` check 149/149, test 397/397, test:browser 24/24; after: `npm run check` 154/154; `npm test` 418/418 (Node 22.23.4); `npm run test:electron` 418/418 (Node 24.22.2); `npm run test:browser` 26/26. Packaged smoke and bench not run (port 8080 in use). After the review fixes (`f2d4e9f` … `31285e9`): check 154/154, test 426/426, test:electron 426/426, test:browser 26/26.
- PL10 (2026-11-25, `platform/pl10-leaderboard-integrity`): baseline at `d2d4564` check 154/154, test 426/426, test:browser 26/26; after: `npm run check` 155/155; `npm test` 436/436 (Node 22.23.4; one run had one timing failure of the PL9 bridge stress test, passed on rerun); `npm run test:electron` 436/436 (Node 24.22.2); `npm run test:browser` 26/26. Local board on port 8799 with a scratch database; nothing against Cloudflare. After the review fixes (`d3f3a93`): check 155/155, test 439/439, test:browser 26/26.
- PL11 (2026-11-25, `platform/pl11-data-ownership`): baseline at `d97a278` check 155/155, test 439/439; after: `npm run check` 164/164; `npm test` 462/462 (Node 22.23.4); `npm run test:electron` 462/462 (Node 24.22.2); `npm run test:browser` 26/26; `npm run smoke:packaged -- --build` passed; packaged exe with `--demo` checked on a scratch folder.
- PL7 (2026-11-25, `platform/pl7-practice`): baseline at `ff85248` check 138/138, test 346/346, test:browser 22/22; after: `npm run check` 143/143; `npm test` 365/365 (Node 22.23.4); `npm run test:electron` 365/365 (Node 24.22.2); `npm run test:browser` 23/23. After the review fixes: check 144/144, test 369/369, test:electron 369/369, test:browser 23/23.

## Pending user decisions

- None open from PL0–PL2: OD-PL-1 … 9 and the review-round decisions (D-PL1D-1, D-PL1D-2) were decided by the user on 2026-11-24.
- None open from PL3: OD-PL-10 (a) and OD-PL-11 (a) decided, D-PL3-3/4 confirmed by the user on 2026-11-25.
- None open from PL4: OD-PL-12 … 17 (a) and OD-PL-18 (b) decided, D-PL4-1 … 8 confirmed by the user on 2026-11-25.
- None open from PL5: OD-PL-19 … 24 decided (22 → (b), 24 → (c), implemented), D-PL5-1 … 14 confirmed, D-PL5-15 (user) built.
- None open from PL6: OD-PL-25 … 31 decided (a) by the user on 2026-11-25; D-PL6-1 … 9 confirmed (D-PL6-8 corrected); D-PL6-10 … 14 from the review round.
- None open from PL7: OD-PL-32 … 41 decided (a) by the user on 2026-11-25; D-PL7-1 … 7 confirmed; D-PL7-8 … 12 from the review round.
- PL8: OD-PL-42 … 53 (setup experiments) applied as operator defaults, **OPEN for the user's review in the app**; D-PL8-1 … 8 to confirm.
- PL9: OD-PL-54 … 63 and the OD-PL-60 refinement (HUD and live assistance) applied as operator defaults, **OPEN for the user's review in the app**; D-PL9-1 … 12 to confirm.
- PL10: OD-PL-64 … 73 (leaderboard integrity) applied as operator defaults, **OPEN for the user's review**; D-PL10-1 … 9 to confirm. **Needs approval:** backup, apply D1 migration 0003 once, set `RATE_SALT` (required), deploy the Worker, then `0004_backfill_keys.sql`; community features (design only).
- PL11: OD-PL-74 … 82 (data ownership) applied as operator defaults, **OPEN for the user's review in the app**; D-PL11-1 … 4 to confirm. Design only, needs approval: local API, plugins, sync, signed releases and updates, animation export (`docs/platform/EXTENSIBILITY_DESIGN.md`).
- Push / merge of `platform/pl11-data-ownership`, `platform/pl10-leaderboard-integrity`, `platform/pl9-hud-live`, `platform/pl8-setup-experiments`, `platform/pl7-practice`, `platform/pl6-analysis`, `platform/pl5-onboarding`, `platform/pl1-decisions`, `platform/pl3-recording-perf` and `platform/pl4-compatibility` (into `platform/integration`, then `main`); after the first push, check both CI jobs.

## Next action

- User reviews PL9 in the app (OD-PL-54 … 63), ideally with one drive on HUD 0.15.0 (kill switch, labels, Integration health bridge counters; aids / assists checks need confirming again), then merge.
- User reviews PL10 (OD-PL-64 … 73) and decides on the D1 migration and Worker deploy (order in `docs/platform/LEADERBOARD_TRUST.md` §9).
- User reviews PL11 in the app (OD-PL-74 … 82): Settings → Backup and restore (Scheduled backups, Verify, forecast), a session report → Save as HTML, Settings → Try the demo. Then the research reports (RB) or the local API design. Gate each step with `npm run verify`.

## How to resume

Read this file, then `git status` / `git branch` / `git log -5`. Don't assume the last task finished: check its branch and run `npm run verify`.
