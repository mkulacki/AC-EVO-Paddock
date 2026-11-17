# Phase log

## P0: Repository audit and roadmap

- **Started / finished:** 2026-11-17
- **Objectives:** understand the real repository; inventory features; propose phases.
- **Changes:** added `docs/` (PRODUCT_AUDIT, ARCHITECTURE, FEATURE_INVENTORY, IMPLEMENTATION_ROADMAP, DEVELOPMENT_STATE, PHASE_LOG, DECISIONS). No code changed.
- **Tests:** syntax check on every JS file (pass); mock server with seeded laps in a scratch data dir, main GET routes (all 200).
- **Known limitations:** Electron build not run (no code changed); in-game behaviour not tested (needs the user and the game).
- **Review findings:** n/a (documentation only).
- **User approval:** **APPROVED** 2026-11-17. `docs/audit-roadmap` merged into local `main`.

## P1: Test foundation and baseline

- **Started / finished:** 2026-11-17 · branch `phase/p1-tests`
- **Objectives:** an automated safety net before any feature work.
- **Implemented:**
  - `npm test`: `node --test test/*.test.js` (built-in runner, no new dependencies), 38 tests in 6 files, about 1.8 s:
    - `analysis.test.js`: resampling, smoothing, corner detection, corner metrics, lap stats and ideal lap, on synthetic traces with known answers.
    - `db-migration.test.js`: a real v0 database is migrated (data kept, distances fixed, one backup, old AI answers dropped, new columns and tables usable, no second migration on the next start).
    - `formats.test.js`: protobuf reader, the `.carsetup` codec (byte-identical round trip), `readLimits`, `snap`, the zip reader (stored and deflated).
    - `setupmatch.test.js`: matched, Standard, guess, and identical-setup cases.
    - `service.test.js`: overview, compare, consistency, progress, session report and lap delete on seeded mock laps.
    - `smoke.test.js`: the real server on a free port with seeded data. It checks every read-only GET route, that the Gemini key is masked on every route, and that no file outside `public/` is served.
  - `npm run check`: the syntax check, as a script.
  - `src/mock.js` exports `seedLaps()`; the `--seed` CLI is unchanged.
  - Isolation: every test uses temporary `ACEVO_DATA` / `ACE_DIR` under `%TEMP%\paddock-tests` and a seeded `Math.random`.
- **Modified files:** `package.json`, `src/mock.js`, `test/*` (new), `CLAUDE.md` (release step 2; smoke-test URL), `README.md` (Contributing, layout).
- **Tests performed:**
  - `npm run check`: 64/64.
  - `npm test`: 38/38, twice (deterministic).
  - Mutation checks: an inverted ideal-lap choice and a broken migration wrap failed 4 tests; exposing the raw Gemini key failed the smoke test.
  - Electron build OK, and `test/` is not packaged.
  - Packaged exe with scratch `ACEVO_DATA` + `ACE_DIR`: HTTP 200, title "AC EVO Paddock", no `dist/win-unpacked/data`.
  - The project's `data/telemetry.db` was unchanged by the test runs.
- **Known limitations:**
  - Not covered: the `.carsetup` read/write against real car limits (needs game files), the HUD/game bridge, Electron UI and browser pages (no UI test runner), POST routes that start the game.
  - The path-traversal test checks behaviour only; the server's URL parsing makes its `startsWith(public)` guard unreachable from outside.
- **Review findings (code-review subagent):**
  - No critical or high findings.
  - Fixed: 3 medium findings (the key test couldn't fail, the traversal test couldn't fail, the "no second migration" test was weak) and 4 low ones (unseeded smoke data, port-race readiness check, cleanup stopped by one locked folder, teardown not awaited).
- **User approval:** pending.
