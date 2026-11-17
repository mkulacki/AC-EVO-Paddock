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
- **User approval:** **APPROVED** 2026-11-17. Merged into local `main`.

## P2: Data provenance and AI confidence

- **Started / finished:** 2026-11-17 · branch `phase/p2-provenance`
- **Objectives:** follow the data-integrity rules; nothing built on unchecked readings is shown as fact; AI answers rate their confidence.
- **Implemented:**
  - `src/channels.js`: a status per telemetry group.
    - Core telemetry and track limits are verified (checked in game during development).
    - Five groups the driver can check: pit-box readings, temperatures, tyres, brakes, suspension.
    - Slip, G forces and window values can't be checked on any game screen.
    - The old `probeConfirmed` switch carries over.
  - Endpoints: `GET /api/channels`; `POST /api/setupcheck/confirm {group, ok}`, which keeps the old meaning without `group`. `/api/settings` can't set the checks.
  - Car & setup:
    - Every suggestion has a `basis` and a `confirmed` flag; unconfirmed ones are listed under *Unconfirmed hints*.
    - Provenance badges per section; balance bars faded and labels uncoloured while slip is unconfirmed.
    - A tyre-temperature hint no longer states understeer as fact.
  - Session report: badges (Calculated on corner times, setup used, temperatures).
  - Setups → Setup recognition: "Checked against the game" list, with Matches / Doesn't match / Undo per group.
  - AI inputs and output:
    - Coach, debrief and setup engineer get `data_quality`; readings marked wrong are left out of the AI input entirely.
    - The prompts require a confidence rating. `splitConfidence` parses it, tolerating Markdown, lists, ranges, translations and a reason on the next line.
    - The page shows *AI · Confidence: level · basis*, or *Confidence not rated*.
- **Modified files:** `src/channels.js` (new), `src/carreport.js`, `src/ai.js`, `src/server.js`, `src/settings.js`, `public/util.js`, `public/carsetup.js`, `public/reports.js`, `public/setups.js`, `public/telemetry.js`, `public/style.css`, `test/provenance.test.js` (new), `test/smoke.test.js`, README, CHANGELOG, DECISIONS.
- **Tests performed:**
  - `npm run check`: 66/66.
  - `npm test`: 51/51, including:
    - registry and legacy migration;
    - gating of suggestions on seeded mock laps;
    - AI prompts with a stubbed Gemini;
    - 14 confidence-line formats;
    - the confirm endpoint (with and without a group, bad input);
    - saved AI answers served with their confidence.
  - Mutation: always-confirmed suggestions failed 2 tests.
  - Headless Edge (DevTools protocol) on a mock server:
    - screenshots of Car & setup, the report and Setups, with 0 JS errors;
    - clicking "Matches the game" for tyres moved exactly the 2 tyre-only hints into the headline list.
  - Built and deployed to `E:AC EVO Paddock`, started; `/api/channels` answers. The user's data has no earlier check, so everything except core and track limits shows as unconfirmed.
- **Known limitations:**
  - Actual verification needs the user in game. Slip (balance, wheelspin) can never be checked this way.
  - Not badged yet: setup names in the session lap table and the trend tooltip.
  - The unconfirmed hint texts are still worded as advice, but sit under the "Unconfirmed hints" heading.
  - The real Gemini model was not called: the prompt changes are tested with a stub, so whether Gemini follows the format is checked only by the parser's tolerance.
- **Review findings (code-review subagent):**
  - No critical or high findings.
  - Fixed: 3 medium (legacy check lost when changing the other group; the engineer not told whether the recognised setup is trustworthy; the confidence parser missing common formats) and 4 low (old-answer wording, `ok` type check, wrong readings still sent to the AI, dead parameter).
  - Left as limitations: 2 low (balance wording, setup names without a badge in the lap table).
- **User approval:** pending.
