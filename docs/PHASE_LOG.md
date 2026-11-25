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
- **User approval:** **APPROVED** 2026-11-17. Merged into local `main`.

## P3: Application management

- **Started / finished:** 2026-11-17 · branch `phase/p3-app-management` · D2 answered: **check and notify**
- **Implemented:**
  - **Backup:** a zip in `data\backups` with a VACUUM INTO copy of the database plus settings, race presets/servers and setup notes. The key and passwords are left out unless ticked. List, Save as, Delete, and Add a backup file (upload).
  - **Restore:** checks the backup (format, newer version, the database opens, quick_check), makes a safety backup, stages the files and restarts. At the next start, before the database opens, the database is swapped by rename after clearing the old WAL. A failure keeps the current data and retries, and is set aside after 3 starts. The current key and passwords are kept if the backup has none. Refused while on track.
  - **Export:** laps and sessions as CSV, with formula injection neutralised and a BOM for Excel.
  - **Diagnostics:** a JSON or text report, with the key, passwords, driver names and the user folder (all its forms) removed. "Copy for a bug report".
  - **Update check:** GitHub releases once a day, a generic User-Agent, a 15 s timeout, never in mock runs or tests, a nav dot plus a Settings card, and a switch to turn it off. Nothing is downloaded.
  - **API request guard:** foreign origins, other ports, cross-site requests and other host names (DNS rebinding) are refused.
  - `src/zip.js`: a streaming writer (`.part` then rename, never overwrites, errors handled); inflate capped at the declared size.
- **Files:**
  - new: `src/backup.js`, `src/restore-apply.js`, `src/dataexport.js`, `src/diagnostics.js`, `src/updates.js`, `public/system.js`, `test/appmgmt.test.js`;
  - changed: `src/db.js`, `src/zip.js`, `src/server.js`, `src/settings.js`, `public/app.js`, `test/smoke.test.js`, README, CHANGELOG, DECISIONS.
- **Tests performed:**
  - `npm run check`: 73/73. `npm test`: 71/71.
  - Coverage includes:
    - the zip round trip and error paths;
    - backups with and without secrets, and parallel backups;
    - restore staging and apply, including the locked-database failure;
    - merging passwords back;
    - typed manifest values;
    - reserved names and zip bombs;
    - CSV injection;
    - all forms of redaction;
    - the version order and update checks with a stubbed fetch;
    - the request guard.
  - Mutation: disabling the request guard failed the smoke test.
  - End-to-end with the real server (backup, delete a lap, restore, restart: the lap is back and the key is kept), and the same with the packaged Electron app (relaunch).
  - Backups open with .NET ZipFile and Expand-Archive.
  - Settings cards screenshotted with headless Edge: 0 JS errors.
  - Deployed to `E:\AC EVO Paddock` and started; the new routes answer.
- **Known limitations:**
  - VACUUM INTO and quick_check are synchronous: a large database pauses the app for a moment while backing up. Backup and restore are refused while on track, so recording is safe.
  - No Zip64, so the database must be under 3.9 GB.
  - Disabled mods and `mods.json` are not backed up (they describe this PC's game folder).
  - A pending restore is shown only on the Settings page.
  - The `restore-failed-*` folders kept after a failed restore are not cleaned up automatically.
- **Review findings (code-review subagent):**
  - No critical findings. Two high ones were fixed: cross-site request forgery leading to stored XSS and key theft, and a restore that inflated the whole database in memory on the main thread.
  - All 4 medium findings fixed: zip writer errors, an empty database after a failed apply, the Mods manifest being restored, user-folder leaks.
  - Lows: L1–L3, L5, L6 (a size check before writing), L7 and L8 fixed. L4 fixed in part: the server re-checks that you're not on track before committing a restore; the pending banner still shows only on the Settings page.
- **User approval:** **APPROVED** 2026-11-17. Merged into local `main`.

## P4: App shell (navigation, command palette, page states)

- **Started / finished:** 2026-11-17 · branch `phase/p4-shell` · D1 answered: **lime accent + sidebar**
- **Implemented:**
  - **Sidebar:** Race, Sessions, Tracks, Setups | Game, Mods, Settings, each with an icon. The live status sits at the bottom and its text is also the tooltip. It collapses to an icon rail (Ctrl+B or the button, remembered; automatic below 900 px). Nav dots for a new report, a HUD update and a Paddock update still work.
  - **Command palette (Ctrl+K):** pages, Settings sections (scrolls to the card), combos (progress, consistency, best against ideal), the 40 most recent sessions, all tracks and layouts, cars with setups, and three commands. Fuzzy matching; "kind words" filters by kind; fresh data on each open. It never starts the game and stays out of other dialogs.
  - **Shortcuts:** `?` shows the list (focus kept in the dialog); Alt+1…7 by key position; Ctrl+B. Settings warns when the brake-mark key takes one of these.
  - **Page states:** a router loading bar (after 150 ms) on every page; an error card with Try again and a link to Diagnostics; `util.js` loadingHtml / emptyHtml / errorHtml; an empty state on Consistency without valid laps.
  - **`public/app.js` is the shell only (122 lines):** Sessions → `sessions.js`, Compare → `compare.js`, Game → `game.js`, Settings → `settingspage.js`. The split was mechanical, and the reviewer checked it line by line. Each render now has its own cleanup list, so a page that finishes loading after you leave is stopped.
- **Tests performed:**
  - `npm run check`: 79/79. `npm test`: 76/76. New: palette matching and filtering, Alt order equals sidebar order, palette links are routed, shell ids, new modules served.
  - Headless Edge, 0 JS errors throughout:
    - 12 pages with an empty database (empty and error states);
    - 14 pages with demo data;
    - palette queries;
    - the shortcut dialog in dark theme;
    - 860 px and 1024 px windows (the rail, no sideways scroll).
  - Built, deployed to `E:\AC EVO Paddock` and started.
- **Known limitations:**
  - The dialogs don't trap Tab fully (the shortcut list does; the palette's input keeps focus).
  - Mobile phone widths were not targeted (desktop app; the rail works down to about 700 px).
  - Pages other than Consistency already had their own empty states; they keep their wording.
- **Review findings (code-review subagent):**
  - No critical or high findings.
  - All 3 medium fixed: the kind-filter regex typo (backslash lost in a shell heredoc) hiding the Tracks page; listeners leaking when you left a page during its load; dialogs stacking on the garage and text prompts.
  - All 6 low fixed: stale palette cache, delayed close hitting a new palette, shortcut-list focus and keys, AZERTY Alt+digits, the narrow-window toggle overwriting the stored choice, the status tooltip in the rail, the brake-mark key conflict.
- **User approval:** **APPROVED** 2026-11-17. Merged into local `main`.

## P5: Driver home dashboard

- **Started / finished:** 2026-11-17 · branch `phase/p5-home`
- **Implemented:**
  - **Home (`#/home`) is where Paddock opens; `#/` stays Sessions.** It shows:
    - **Needs attention:** pending or failed restore, missing game folder, HUD update waiting or an install error, loader built for another game version, telemetry readings not checked or marked wrong, update available, no Gemini key. Each has a level word, an icon and a link.
    - **Totals:** laps (valid of all), sessions, combos, time in laps and days, the last 7 and 30 days, the last lap.
    - **Recent sessions** with the report summary (consistency, PB, change against last time).
    - **Next practice targets** from the newest report of the 3 most recent combos, with "met X of Y" last time.
    - **Best lap per day** for the 3 most driven combos: a sparkline drawn like Progress (higher = slower), personal-best dots, and a hover crosshair and tooltip.
    - **Records:** best, ideal, could gain, laps, last driven, with links to Progress and best against ideal.
  - Empty database: a short how-to instead of zeros.
  - `src/service.js` `dashboard()` uses stored laps and reports only. Imported laps are excluded, and a missing value is shown as missing.
  - Per-combo invalidation after a lap, and `progress()` cached per combo.
- **Files:** `src/service.js`, `src/server.js`, `public/home.js` (new), `public/app.js`, `public/index.html`, `public/palette.js`, `public/style.css`, `test/dashboard.test.js` (new), `test/smoke.test.js`, `test/shell.test.js`, README, CHANGELOG, DECISIONS.
- **Tests performed:**
  - `npm run check`: 81/81. `npm test`: 84/84, including:
    - an empty database;
    - totals and records against the stored laps;
    - the report summary;
    - the trend equal to Progress;
    - two driving days;
    - imported laps excluded;
    - a second report with its target check;
    - per-combo invalidation.
  - Headless Edge, 0 JS errors: Home with demo data, empty, dark, and 8 days of data with a hover screenshot. That screenshot caught the sparkline drawn upside down and stretched markers, both fixed.
  - Timing:
    - scratch database with 240 laps: 16 ms cold, 2 ms warm, 14 ms after a new lap;
    - deployed app on the user's 50 laps and 11 combos: 17 ms, then 4 ms.
- **Known limitations:**
  - Fixed layout (no widgets).
  - Trends only for the 3 most driven combos of the last 60 days.
  - "Time in laps" counts saved laps only (no out laps or time in the pits).
- **Review findings (code-review subagent):**
  - No critical findings.
  - The high finding is fixed: a blocking tasklist call on every dashboard request, which reloads after each lap.
  - Both mediums fixed: a full recompute after every lap; no refresh when a report arrives.
  - All 6 lows fixed: calendar days, the first-day PB marker, the target count, touch handling, the HUD error text, the "time" label. Tests extended as suggested.
- **User approval:** **APPROVED** 2026-11-17. Merged into local `main`.

## P6: Driving technique analysis

- **Started / finished:** 2026-11-17 · branch `phase/p6-technique`
- **Implemented:**
  - **Technique metrics per corner** (`src/analysis.js` `techniqueMetrics`, part of `cornerMetrics`):
    - brake: application time, trail braking (m), release time, release re-presses;
    - throttle: apex to full throttle, re-lifts on the exit;
    - steering: big reversals and small corrections ("saw");
    - coasting.
    Every limit is relative to the pass's own peak brake or steering lock. The definitions (`TECHNIQUE`) are the tooltips.
  - **Performance score** (`performanceScore`, formula on the page):
    - 0.5 × pace + 0.3 × consistency + 0.2 × validity;
    - missing (with the reason) below 3 clean laps.
  - **Consistency page:**
    - the score card with its formula;
    - corner rankings (fastest, middle and slowest pass, with lap links);
    - a technique table (typical value and the fastest pass);
    - every technique metric available in *Spread per corner*.
  - **Session report:**
    - a *Driving style* section: typical pass against the fastest pass ever, per corner, plus habits found in 2 or more corners;
    - only with 3 or more valid laps; report format v2.
    - Old reports offer *Regenerate*.
  - **Telemetry map:** Time / Inputs layer (braking, coasting, part and full throttle), remembered per viewer.
  - **Home records:** the score of the last 10 laps per combo.
- **Files:** `src/analysis.js`, `src/service.js`, `src/report.js`, `src/server.js`, `public/consistency.js`, `public/reports.js`, `public/telemetry.js`, `public/home.js`, `public/style.css`, `test/technique.test.js` (new), `test/service.test.js`, README, CHANGELOG, DECISIONS, FEATURE_INVENTORY.
- **Tests performed:**
  - `npm run check` 82/82; `npm test` 103/103.
    - 15 new unit tests on synthetic traces with known answers: ramp and release times, bumps, trail metres, empty instead of zero, pickup, re-lifts (stepped and gradual), steering reversals and saw, relative thresholds, coasting, score formula and missing score.
    - New service tests: technique fields, score, dashboard score, style section, no style with 2 laps.
    - Both review-fix tests were checked to fail on the old code.
  - Headless Edge, 0 JS errors: Consistency (light and dark, steering-saw metric), report tab, Compare with the Inputs layer, Home dark.
  - Deployed to `E:\AC EVO Paddock` and started. On the user's data: Consistency 35 ms for 10 laps; the metrics look plausible.
- **Known limitations:**
  - Technique comes from pedals and steering only (no slip or tyre data, which are unverified).
  - Stored reports get the style section only on *Regenerate*.
  - The score windows differ by design (Home: the last 10 laps; Consistency: the laps in view).
- **Review findings (code-review subagent):**
  - No critical findings.
  - High, fixed: a gradual throttle lift was counted several times (now a two-state hysteresis).
  - Mediums, fixed: an early brake tap was taken as the braking zone (now the application holding the peak); report count medians were rounded up from .5.
  - Lows, fixed: the score test could skip its checks; the Consistency median differed from the report's.
  - Low, accepted: v1 reports have no style section until regenerated.
- **User approval:** **APPROVED** 2026-11-17. Merged into local `main`.

## P7: Setup history and comparison

- **Started / finished:** 2026-11-17 · branch `phase/p7-setups`
- **Implemented:**
  - **Setup history** (`src/setuphistory.js`, page `#/setuphistory?combo=`) per track + car:
    - every setup driven, grouped by the snapshot of values recorded when it was driven, plus its file;
    - an edited file shows as "version n of m";
    - per setup: dates, sessions, laps (valid / all), best lap, typical lap (median of clean laps), spread, air / track temperature;
    - gaps against the fastest setup.
  - **Compare two setups:** best and typical lap side by side, plus exactly the values that differ (label, corner, unit, change).
    - Values come from the snapshot; else from the saved file as it is now, labelled so.
    - Standard and Not recorded entries have no values, and the page says why.
  - **AI setup engineer:**
    - gets `by_setup` (laps split by setup);
    - `this_setup` is set only on the entry driven with the file's current values, `this_setup_other_values` on its other versions;
    - plus a note on whether setup recognition is checked. This removes the old README limitation.
  - **Links:** a *Setup history* button on each Sessions combo, the palette ("history …" or "setup history …"), and *Your laps here* in the Setups tab when a car and track are chosen (`/api/setuphistory/combos`).
- **Files:** `src/setuphistory.js` (new), `src/server.js`, `src/setupmatch.js`, `src/carsetup.js`, `src/setups.js`, `public/setuphistory.js` (new), `public/app.js`, `public/sessions.js`, `public/palette.js`, `public/setups.js`, `test/setuphistory.test.js` (new), `test/shell.test.js`, `test/smoke.test.js`, README, CHANGELOG, DECISIONS, FEATURE_INVENTORY.
- **Tests performed:**
  - `npm run check` 85/85; `npm test` 111/111.
  - Setup history tests (8):
    - stats per setup, including the clean-lap median and spread;
    - versions; an exact diff (only the changed values); a missing-values reason;
    - two files with the same values; engineer marking; both reasons named.
  - Smoke test: the history, diff and combos routes.
  - Palette: "history" and full kind names; "setup" still means Setups.
  - Headless Edge, 0 JS errors: Setup history in light and dark, a 4-setup scratch history with versions, a value diff, and the Standard-against-setup reason.
  - Deployed and started; on the user's data the history answers in 1–12 ms.
- **Known limitations:**
  - On the user's data, every lap so far is Standard or Not recorded (no recognised saved setup driven yet), so Compare has nothing to diff until a saved setup is driven.
  - Recognition is still unconfirmed in game (P2); laps can be corrected in the report.
  - Manual corrections take the file's values at correction time.
- **Review findings (code-review subagent):**
  - No critical or high findings.
  - All 5 medium fixed:
    - two files with the same values merged (keys now include the file);
    - the engineer marked every version of a file;
    - the "file as it is now" note was missing when values matched;
    - the "Not recorded" wording;
    - per-lap catalogue matching (now per combo).
  - Lows fixed: the palette full kind name, versions only for recorded values, both reasons named, A ≠ B by default, thin tests.
- **User approval:** **APPROVED** 2026-11-17. Merged into local `main`.

## P8: AI coach upgrade

- **Started / finished:** 2026-11-17 · branch `phase/p8-coach`
- **Implemented:**
  - **Coach page** (`src/coach.js`, `public/coach.js`, `#/coach?combo=`) per track + car:
    - chat with a compact context: totals, recent sessions, the last 3 reports (weakest corners, style habits, invalid laps), corner times, laps by setup, the plan and its checks, data quality;
    - *What is sent* shows instructions and data; every answer carries a confidence badge;
    - the chat is stored per combo (`coach_messages`) and can be cleared.
  - **Training plan** (`training_plans`): a report's measurable targets, one active plan per combo. Later sessions (latest 10) are checked with `report.checkTargets`; short sessions and the live session are skipped with a reason. Shown on the Coach page (sessions × targets) and in each report ("Make these my training plan").
  - **AI braking points:** per-corner data (zone, fastest and typical pass, current mark). Suggestions are validated (zone across the line for the first corner, ≤ 15 m later than the fastest pass, one per corner) and applied only for ticked corners, replacing only that corner's marks.
  - **`src/ai.js`:** shared `generate()`, error codes and clear messages for no key, network, timeout (90 s), 429 and empty answers.
  - **Links:** a Coach button on each Sessions combo, the palette ("coach …"), and the page list.
- **Files:** `src/coach.js` (new), `src/ai.js`, `src/db.js`, `src/report.js`, `src/server.js`, `public/coach.js` (new), `public/reports.js`, `public/app.js`, `public/sessions.js`, `public/palette.js`, `public/style.css`, `test/coach.test.js` (new), `test/smoke.test.js`, `test/shell.test.js`, README, CHANGELOG, DECISIONS, FEATURE_INVENTORY.
- **Tests performed:**
  - `npm run check` 88/88; `npm test` 124/124.
  - Coach tests (12, Gemini stubbed through `fetch`):
    - context size and contents;
    - no key, network error, 429 and empty answer, each leaving the chat unchanged;
    - history and system prompt sent, key only in the header;
    - plan checks equal `checkTargets`, plan replace and remove;
    - suggestion validation, apply per corner, zone across the line, the 60-mark limit;
    - fenced JSON; short and live sessions skipped.
  - Smoke test: every coach and plan route without calling Gemini, and the key absent from *What is sent*.
  - Headless Edge, 0 JS errors: Coach page in light and dark, desktop and narrow width, chat, plan and braking points with a stubbed Gemini; report plan check.
- **Known limitations:**
  - AI answers were checked only against a stubbed Gemini here; the real model's quality depends on the user's key and model.
  - Braking points rest on the best lap's corner zones; a brake point before the start/finish line is only seen through the user's marks (lap data starts at the line).
- **Review findings (code-review subagent):**
  - No critical or high findings.
  - Mediums, all fixed:
    - short and live sessions were checked, and their reports rebuilt on every request (now skipped, and the built reports cached);
    - braking zones did not wrap the start/finish line;
    - the chat touched the next page after navigation.
  - Lows fixed: the `parseJson` regex, error status mapping, older sessions labelled "other plan", session-less laps counted as sessions, the 60-mark limit, the unconditional 15 m test.
  - Accepted: corners matched by name; the 90 s timeout (documented).
- **User approval:** **APPROVED** 2026-11-17. Merged into local `main`.

## P9: Driver development

- **Started / finished:** 2026-11-17 · branch `phase/p9-development` · D3 answered: achievements and challenges **yes**.
- **Implemented:**
  - **Goals and challenges** (`src/goals.js`, table `goals`): lap time, laps within a window of a time in one session, valid laps in a row, session consistency score (`report.consistencyOf`), per track + car. Checked against laps driven after setting (before the deadline for a challenge); the first time met is stored and announced once (page event + desktop notification), wherever it is noticed. Consistency goals wait for the end of the live session.
  - **Suggested challenges** for the 3 most driven combos of the last 30 days, plus the active training plan's lap target as a goal.
  - **Achievements** (`src/achievements.js`): 28 in ladders, recomputed from laps, goals and weekends with the time each was reached; "new" since last viewed (`meta`); the first run does not mark old ones new.
  - **Race weekends** (`src/weekends.js`, table `launches`): sessions Paddock started are recorded from the order's `meta` once the HUD reports "started"; sessions are grouped under weekend launches by time window, next launch, track layout and car.
  - **Session planner:** a driven combo + goal + Race tab preset / hotlap / practice, built with `race.buildOrder` and started like the Race tab.
  - **UI:** Development page (sidebar after Sessions; Alt+1…9), Home goals + achievements card, palette entry, nav dot on new events.
- **Files:** `src/goals.js`, `src/achievements.js`, `src/weekends.js`, `public/development.js` (new); `src/db.js`, `src/report.js`, `src/race.js`, `src/game.js`, `src/server.js`, `public/app.js`, `public/home.js`, `public/index.html`, `public/palette.js`, `public/style.css`; `test/development.test.js` (new), `test/smoke.test.js`, `test/shell.test.js`; README, CHANGELOG, DECISIONS, FEATURE_INVENTORY, IMPLEMENTATION_ROADMAP.
- **Tests performed:**
  - `npm run check` 93/93; `npm test` 137/137.
  - Development tests (12): goal kinds and windows, deadlines, a goal flipping to met from a real (mock recorder) lap and announced once, announce on page load, validation, duplicates, suggestions (incl. plan target), weekend grouping (time window, next launch, other car/track, the minute before a launch), launch record, achievement unlock times and live-session exclusion, seen state.
  - Smoke test: `/api/development`, goal create/duplicate/remove, seen, planner refusals, dashboard `development`.
  - Headless Edge, 0 JS errors: Development (light, dark), Home with goals.
  - Benchmark (reviewer's, 10.5k laps): post-lap goal check 3 ms; development data ≈ 150 ms warm, run 3 s after the lap (debounced) and cached for Home.
- **Known limitations:**
  - The game does not say which part of a race weekend a session is; the history lists sessions in order.
  - Race weekend grouping and the planner were checked with unit tests and refusals only, not with a real launch in game.
  - Planner goal is shown only on race weekends (hotlap/practice launches have no history view).
- **Review findings (code-review subagent):**
  - No critical or high findings.
  - Mediums, both fixed: post-lap work blocked the telemetry loop (now debounced 3 s after the lap, met goals not re-measured, report ids without parsing reports, laps read once, result cached); a consistency goal could be met silently when a page load noticed it first (now announced wherever it is stored).
  - Lows fixed: planner text vs. stored goal (weekends now show their goal), unreachable "met late", 500 on malformed goal bodies, weekend achievement time = first lap, a session in two weekends, imported-only combos offered, page re-rendering on every event (debounced, not while the form is open); nits: "days left" rounding, first run marking all achievements new.
- **User approval:** **APPROVED** 2026-11-17. Merged into local `main`.

## P10: Final regression and release preparation

- **Started / finished:** 2026-11-17 · branch `phase/p10-release`
- **Done:**
  - Version **0.6.0-beta.1** (`package.json`, both `package-lock.json` entries). The in-game HUD did not change since 0.5.0-beta.1 (`mod/` unchanged), so `app.json` stays 0.11.0. The bundled loader (0.27.0) matches the installed game (0.9.1+release.6).
  - CHANGELOG: the unreleased entries moved under 0.6.0-beta.1, and the shortcut text was corrected. ARCHITECTURE refreshed: tests, P8/P9 tables, routes, known weaknesses.
  - Release checklist steps 2–3 and 5–7 (CLAUDE.md):
    - tests 137/137, check 93/93;
    - secret scans clean (the only key-scan hit is CLAUDE.md quoting the pattern);
    - `electron-builder --win dir`;
    - packaged exe on a throwaway data dir: 200, title "AC EVO Paddock", version 0.6.0-beta.1, clean log, no `dist/win-unpacked/data`;
    - zip `release/AC-EVO-Paddock-v0.6.0-beta.1-win64.zip` (676 entries, 155.8 MB): no data, settings, db or race.json entries, and neither the key prefix nor the driver name in the staged folder. SHA-256 `BFA36F50169D2B183C37ABC480CA32C8BA370340D9539F4AA7B1AFA7A1B2E4F0` (replaced after the test round, see below).
  - Release notes drafted in `release/notes-v0.6.0-beta.1.md` (gitignored).
  - The installed app runs the 0.6.0-beta.1 build.
- **User test round (2026-11-18), changes asked for and made on `feature/open-last-session`, merged here:**
  - Paddock comes to the front on the session just driven when AC EVO closes (Settings switch, on by default; only a session with saved laps from that game run).
  - Session/Compare telemetry: a bigger track map, see-through race-car icons (each car on its own layer, 50–80 % opaque by car count), **+ / −** map zoom up to 8× that follows the car, and checkboxes for every chart.
  - Re-run: check 93/93, tests 137/137, packaged smoke test on a throwaway data dir (200, clean log, no `dist/win-unpacked/data`). Zip rebuilt and re-verified (676 entries, 155.8 MB, no data/settings/db/race.json, no key prefix or driver name). New SHA-256 `3571634D8BC77CC2F3C9F884636F419249F70CDC49D979A2AFED1355FD04F62E`.
- **User approval:** **APPROVED** 2026-11-18 ("you may release changes on github and overtake"). Merged into `main`, pushed, tagged `v0.6.0-beta.1`, GitHub pre-release, overtake.gg update.

## PL0: Platform baseline (no production behaviour change)

- **Started / finished:** 2026-11-24 · branch `platform/pl0-baseline` (from `main` = `be3b5ef`, 0.7.0-beta.1) · the local operator plan (not in the repo); phase scopes are summarised in `docs/platform/BACKLOG.md`
- **Objectives:** inventory features, architecture and integration boundaries for the PL1–PL11 platform plan; verify the PL1.1–1.3 hypotheses statically; write a prioritised backlog.
- **Changes:** documentation only. `docs/ARCHITECTURE.md` (runtimes, integration-boundary table with `file:line`), `docs/FEATURE_INVENTORY.md` (0.7.0 refresh, plan mapping), `docs/platform/PL0-report.md`, `docs/platform/BACKLOG.md` (new), `docs/DECISIONS.md` (OD-PL-1…4, `OPEN (operator)`), this entry, `docs/DEVELOPMENT_STATE.md`. Nothing under `src/`, `public/`, `desktop/`, `mod/`, `leaderboard/` or `test/` changed.
- **Findings (all static only, details in the PL0 report):**
  - Verified: secret-free backups keep the leaderboard token and Steam identity (`src/backup.js:65-72`), the manifest says `includesSecrets: false`, and a restore brings the sign-in along (`src/restore-apply.js:19-22`); no central sensitive-settings list.
  - Verified: lap import gunzips without a cap and checks only `format`, `data.t`, `data.d` (`src/server.js:763-765`); a non-array `data.t` or a missing required meta field fails at the insert with a raw 500 and stores nothing (runtime-checked by the reviewer on Node 22); duplicates are stored twice; exports carry the `board` Steam id.
  - Verified: streamed zip extraction is not size-capped (`src/zip.js:86-101`); mod install can lose overwritten files on a mid-way failure (`src/mods.js:370`, catch `:371-375`); `settings.json`/`race.json` are written in place and an unreadable `settings.json` is silently replaced by defaults (`src/settings.js:52,63`).
  - Rejected: path traversal in backup restore, mod zips and setup import; the token reaching the page or diagnostics; partial lap records.
  - Unresolved: Windows device names in mod/setup paths; triggers/views in a restored database.
  - Runtime gap: tests run on Node 22.23.4, the packaged app on Electron 44.11.1 / Node 24.22.2.
- **Tests:** `npm run check` 104/104 → 104/104; `npm test` 175/175 → 175/175. No pre-existing failures.
- **Known limitations:** no game, shared memory, in-game HUD, Steam login, Cloudflare, packaged exe or `npm audit` run (docs-only phase; see the report).
- **Review findings:** n/a (documentation only).
- **User approval:** pending. Push/merge not done.

## PL1: Security and data safety

- **Started / finished:** 2026-11-24 · branch `platform/pl1-data-safety` (from `platform/integration` = `0365ce6`) · scope in `docs/platform/BACKLOG.md` (PL1); report `docs/platform/PL1-report.md`
- **Objectives:** credential-safe backups with one sensitive-settings list; hardened lap import; audit and fix the adjacent boundaries (archives, mod installs, setup import, restore, diagnostics, settings files).
- **Changes:**
  - `src/sensitive.js` (new): the one list of secrets and sign-in fields, used by backups, restore, diagnostics, the page's settings view and the settings route. Backups never hold the leaderboard token or Steam identity; a restore clears the sign-in (OD-PL-1), keeps the current Gemini key when the backup has none; manifests are accurate (`signIn: false`).
  - `src/jsonfile.js` (new): atomic writes and damaged-file quarantine for `settings.json`, `race.json`, `setup-meta.json`; settings type-normalised on load.
  - `src/lapfile.js` (new): bounded lap import (16 MB file, 64 MB unpacked via `maxOutputLength`, 250 000 samples, 64 channels), full meta/channel checks, duplicates refused (OD-PL-3), 400/409/413 messages; exports without `board` (OD-PL-2); online lap downloads capped.
  - `src/zip.js`: streamed extraction stops at the stated size; directory size check; backup uploads capped. `src/mods.js`: install rollback restores replaced files; device names refused. `src/setups.js`: size check first, device names escaped. `src/backup.js`: restored DBs with triggers/views refused. `src/server.js`: private GETs refuse cross-site requests.
  - Commits: `665a235`, `0d93ed3`, `7f224f8`, `eff137d`, `4eb5cd8`, `5b3dc56`, `8039ebf`, `3600bb7` (docs), and `1a694d4` (review fixes).
- **Review findings (independent review):** 1 important, fixed: a `settings.json` locked at start could be overwritten with defaults (now: retry, then saves refused until readable). 6 nits, fixed: memory changed before the write; stale `*.tmp` files with the key; `GET /api/race` returned `presets`/`last` with passwords; mod install deleted an existing `.paddock-old`, could fail after the swap on cleanup, and rejected zips for odd names in skipped entries.
- **Findings:** every PL0 1.1–1.3 verified finding fixed with a regression test; 1.3-f/h (device names) fixed conservatively by refusal; 1.3-l resolved (Paddock creates no triggers/views) and fixed. Details and `file:line` in the report.
- **Tests:** `npm run check` 104/104 → 112/112; `npm test` 175/175 → 213/213 (17 → 22 files). No failures.
- **Known limitations:** not run in game, on the live leaderboard, in the packaged exe or under Electron's Node 24; Windows rename retries and a real 4 GB upload not exercised.
- **Open decisions:** OD-PL-1 … 4 defaults applied (still open for confirmation); new OD-PL-5 (damaged-file notice), OD-PL-6 (mod upload cap), OD-PL-7 (unknown lap channels).
- **User approval:** pending. Push/merge not done.

## PL2: Automated quality and release checks

- **Started / finished:** 2026-11-24 · branch `platform/pl2-quality` (from `platform/integration` = `f5cbaa0`) · scope in `docs/platform/BACKLOG.md` (PL2); report `docs/platform/PL2-report.md`
- **Objectives:** CI workflow; the suite on the shipped runtime; one verification command; packaged-app smoke script; browser tests of critical flows; fixture provenance; dependency and type-check assessment; fix the flaky leaderboard test; refresh `docs/ARCHITECTURE.md` line references.
- **Changes:**
  - Flaky test: `src/leaderboard.js` keeps its background timers (`later()`, `stop()`, `background` option; app default unchanged); the leaderboard tests switch background work off; a mock-timer test covers scheduling and `stop()`.
  - `npm run test:electron` (`test/electron-node.js`), `npm run test:browser` (`test/browser.flows.js`, headless Edge over the DevTools protocol, no dependency), `npm run verify` (check + test + test:electron + test:browser), `npm run smoke:packaged [-- --build]` (`test/packaged-smoke.js`, skips when 8080 is busy, scratch `ACEVO_DATA` and `ACE_DIR`).
  - `.github/workflows/ci.yml` (Windows: everything; Ubuntu: 17 platform-neutral files, 5 named exclusions); `engines` node ≥ 22.13; `test/fixtures/README.md`; README, ARCHITECTURE, FEATURE_INVENTORY, CHANGELOG, DECISIONS updated.
  - Commits: `3b61ccd`, `e99fed6`, `18a6ce4`, `105c06c`, `eac9f50`, `c079f7c`, `fd4f53c`, `5568ba7`, `04f30e6` (report and docs), `8c58e04` (review fixes: final `stop()`, CI push on main only, Ubuntu job = all tests minus named Windows-only files, smoke fails without a build).
- **Findings:** flaky-test root cause = leaked, uncancellable timers of earlier leaderboard instances acting on the shared DB/settings (reproduced 7/40 under parallel load, 0/50 after). README's Node 22.5 floor was too low (`node:sqlite` unflagged in 22.13). The smoke test could not run under Electron's Node (fixed). The packaged app installs the loader and HUD into `ACE_DIR` at start (OD-PL-9). Type checking and an audit gate not adopted (D-PL2-1, D-PL2-2).
- **Tests:** `npm run check` 112/112 → 116/116; `npm test` 213/213 → 215/215 (Node 22.23.4); `npm run test:electron` 215/215 (Node 24.22.2); `npm run test:browser` 6/6; packaged smoke passed (200, title, log, no `dist/win-unpacked/data`).
- **Known limitations:** CI not run on GitHub (no push); the Ubuntu job never ran on Linux; no game, Steam or Cloudflare checks.
- **Open decisions:** OD-PL-8 (Dependabot), OD-PL-9 (`ACE_DIR` in release step 6).
- **User approval:** pending. Push/merge not done.

## PL1D: The user's decisions on the PL1 open questions

- **Started / finished:** 2026-11-24 · branch `platform/pl1-decisions` (from `675441f`, the PL2 merge) · report `docs/platform/PL1D-report.md`
- **Objectives:** apply the user's answers to OD-PL-1 … OD-PL-7.
- **Changes:**
  - OD-PL-1 (b): a restore keeps the current leaderboard sign-in (token and identity together) and never takes one from a backup (`src/sensitive.js` `mergeRestoredSettings`).
  - OD-PL-4: the before-restore safety backup holds no secrets (`src/backup.js` `stageRestore`); undoing a restore with it keeps the install's current key, passwords and sign-in.
  - OD-PL-5 (b): `/api/settings` returns `fileNotices` and `canSave`; the Settings page names a damaged or unreadable `settings.json` / `race.json` / `setup-meta.json`, the copy kept and how to recover (`src/jsonfile.js` `fileIssues`, `src/settings.js` `fileNotices`, `public/settingspage.js`).
  - OD-PL-2, -3, -6, -7 confirmed as implemented. DECISIONS, README, ARCHITECTURE, CHANGELOG updated.
  - Commits: `e119946`, `90020d0`, `cb5ff43`, plus the docs commit.
- **Tests:** `npm run check` 116/116; `npm test` 215/215 → 218/218 (Node 22.23.4); `npm run test:electron` 218/218 (Node 24.22.2); `npm run test:browser` 6/6 → 7/7.
- **Known limitations:** the notice was checked through DOM assertions only, not looked at; undoing a restore cannot bring back secrets that were replaced by the restore (by design of OD-PL-4).
- **Review round (2026-11-24):** user decisions A (current secrets win on restore; servers and presets with passwords missing from the backup are kept), B (Dismiss / Delete copy on the notice, `POST /api/settings/notice`), C (CLAUDE.md step 6 scratch `ACE_DIR`); OD-PL-8/9 decided; nits: Save disabled when `canSave` is false, `role="note"`, flaky keyboard browser test fixed at its root (Settings cards drew after the page was left). Commits `9ca4649`, `901c537`, `f981b82`, `6df2d09` + docs. Tests: check 116/116, test 222/222, test:electron 222/222, test:browser 11/11 ×10.
- **Round 3 (user-approved, the last):** restore reads current files through `loadJson` (BOM fine, damaged kept aside, locked not replaced); presets matched by id, else name; confirm text per part (`settings` vs `race`); Check now after leaving Settings; dismissals cached and not a settings-file issue; CLAUDE.md step 6 skip warning. Commits `19f381b`, `e36b256`, `205af33`, `fd04d11` + docs. Tests: check 116/116, test 226/226, test:electron 226/226, test:browser 13/13 ×5.
- **Open decisions:** none open from PL0–PL2.
- **User approval:** pending. Push/merge not done.

## PL3: Recording reliability and performance

- **Started / finished:** 2026-11-24 · branch `platform/pl3-recording-perf` (from `e8a6528`) · scope in `docs/platform/BACKLOG.md` (PL3); report `docs/platform/PL3-report.md`; numbers in `docs/platform/PERFORMANCE.md`
- **Objectives:** measure the 60 Hz loop and the bigger jobs on the mock source with seeded large histories; bounded diagnostics; fix only demonstrated bottlenecks.
- **Changes:**
  - `src/perf.js` (fixed histograms, counters, rings; `monitorEventLoopDelay`), wired into the tick, lap save and HTTP; `/api/diagnostics/perf` behind the origin guard and a `performance` section in Diagnostics.
  - `npm run bench` (`test/perf.bench.js`: lap save, tick with 0–600 laps of history, 1,000/5,000-lap routes and jobs, 75 s live server).
  - Long-history work in ~8 ms slices (`src/service.js` `comboInfoAsync`, `runInSlices`), per-lap corner/sector times kept in memory, LRU lap cache; HUD references prepared in the background (`src/live.js`); Laps/Home/report routes and the automatic report warm first (`src/server.js` `warmFor`); report and progress use the kept corner times.
  - Commits: `6871189`, `510ab6e`, `1aa4251`, plus the docs commit.
- **Findings:** the stalls came from reading the lap history synchronously (HUD references 7.4 s at 612 laps, 5 s at every lap end past 300 laps from cache thrash, Laps page 36 s at 5,000 laps, Home 6.7 s), not from the backlog suspects (lap gzip 20 ms, `listLaps` 21 ms, report JSON). After: longest hold 25–58 ms; live run 44 s → 0.58 s longest gap, 3,076 → 133 missed frames.
- **Tests:** `npm run check` 116/116 → 119/119; `npm test` 226/226 → 236/236 (Node 22.23.4); `npm run test:electron` 236/236 (Node 24.22.2); `npm run test:browser` 13/13.
- **Known limitations:** real shared-memory timing and in-game behaviour unverified; one PC; Consistency page and coach context still read all laps at once; no DB change.
- **Review round (2026-11-25):** stale joined async run after `invalidate()`, kept values of a deleted lap served for a reused id (both reproduced), session refs kept across a new session, best lap deleted mid-run: fixed in `6c1d08a` with 4 regression tests. Tests: check 119/119, test 240/240, test:electron 240/240, test:browser 13/13.
- **Open decisions:** OD-PL-10 → (a) keep gzip 6, OD-PL-11 → (a) leave it (user, 2026-11-25); D-PL3-3/4 confirmed.
- **User approval:** pending. Push/merge not done.

## PL4: Compatibility, provenance and trustworthy comparisons

- **Started / finished:** 2026-11-25 · branch `platform/pl4-compatibility` (from `ab2ba8c`, the PL3 merge) · scope in `docs/platform/BACKLOG.md` (PL4); report `docs/platform/PL4-report.md`
- **Objectives:** version-aware channel verification (4.1), comparison compatibility classes (4.2), one integration health panel (4.3), extending the P2 provenance code.
- **Changes:**
  - `src/channels.js`: checks are records `{ok, game, adapter, at, method, car}`; old booleans migrate as legacy records that no longer count (OD-PL-12); a check counts only on the same game version and reader (`PARSER_REV`, guarded by an OFFSETS hash test; HUD version for aids/assists); suspension and aids per car; three-class `state` (verified / unverified / unsupported). Setups shows why with **Still matches**; Home asks for a re-check after an update.
  - `src/compat.js`: compatible / caveats / incompatible from recorded provenance (car, layout, game version, setup identity, conditions, aids, session type, channel quality); unknown never matches; each caveat says what it changes. Compare: "Like for like", "Compare with care", "Not comparable" gate with **Compare anyway**; Consistency and Progress: "Mixed laps". New laps store `cond.reader`.
  - `src/health.js` + `GET /api/health`: Game page "Integration health" (game connection, telemetry freshness, recording, HUD/loader, telemetry checks, online services, steps), Ctrl+K entry; no network request.
  - AI prompts drop setup names and temperatures marked as wrong; replay G circle labelled unconfirmed.
  - Commits: `7b94228`, `cf0dc21`, `9a6340e`, `4c7d2bf`, plus the docs commit.
- **Findings:** checks were not tied to a version (`src/channels.js:45-59` at `ab2ba8c`); Compare only checked the grid size, so another car's lap compared silently; AI prompts carried data labelled "left out"; lap provenance already existed in `laps.cond` / `setup_info` / `aids` (no DB change needed).
- **Tests:** `npm run check` 119/119 → 124/124; `npm test` 240/240 → 272/272 (Node 22.23.4); `npm run test:electron` 272/272 (Node 24.22.2); `npm run test:browser` 13/13 → 16/16.
- **Known limitations:** no game here (versions, HUD feed, per-car checks, panel with a live game unverified); UI checked by DOM assertions only; bench and packaged smoke not rerun (loop unchanged).
- **Review round (2026-11-25):** layout `''` merged as unknown (ideal lap incompatible on one-layout tracks); setup-history temperatures sent to the AI while marked wrong; "matches" stored with an unknown game version (never counted); replay tab bypassed the gate; unknown `channelChecks` keys dropped; unconfirmed temperatures/aids counted as matched; health error texts with paths. Fixed in `b59541c`, `8703dff` with regression tests; downgrade and `cond.reader` in lap exports documented. User decisions: OD-PL-12 … 17 (a), OD-PL-18 → (b) (implemented), D-PL4-1 … 8 confirmed. Tests: check 124/124, test 279/279, test:electron 279/279, test:browser 16/16.
- **Open decisions:** none.
- **User approval:** pending. Push/merge not done.

## PL5: Onboarding and usability

- **Started / finished:** 2026-11-25 · branch `platform/pl5-onboarding` (from `4d25a15`, the PL4 merge) · scope in `docs/platform/BACKLOG.md` (PL5); report `docs/platform/PL5-report.md`
- **Objectives:** first-run flow, Home additions, session notes/tags/corner bookmarks under the migration rules, empty states and error recovery, accessible colours, scalable text, visible focus, keyboard use, palette extension; assess beginner/advanced.
- **Changes:**
  - Schema v2 (`src/db.js`, `src/notes.js`): notes, tags, corner bookmarks; versioned, additive, one pre-upgrade copy; bounded inputs; local only (not in lap files, uploads, AI or diagnostics; in Settings backups).
  - Setup guide `#/welcome` (`src/onboarding.js`, `public/welcome.js`): game → health (reuses `/api/health`) → privacy and optional services (AI, online, mods skippable; skips change nothing) → first session → first comparison. Opens by itself only for a new driver; Settings and Ctrl+K otherwise.
  - Home: last session, practice objective, next step with evidence, recent progress (`src/service.js` `nextStep`).
  - Session page notes card, Sessions tag chips and filter, palette Tag/Bookmark kinds and kind-word fallback; contrast tokens, focus rings, empty states with actions, error card links.
  - Commits: `8dd13d6`, `9c5cf7b`, `344ff23`, `5713d78`, `9e60e34`, `88acad5`, plus the docs commit.
- **Findings:** palette hid sessions since PL4 (14-item cut); "setup guide" found nothing; muted and light-theme timing colours below 4.5:1; fields had no focus ring; Sessions empty state suggested developer commands. Paddock 0.7 opens a v2 database (checked by hand).
- **Tests:** `npm run check` 124/124 → 130/130; `npm test` 280/280 → 299/299 (Node 22.23.4); `npm run test:electron` 299/299 (Node 24.22.2); `npm run test:browser` 16/16 → 21/21 (×4).
- **Known limitations:** no game here (guide and Home with a live game unverified); no screen-reader run; packaged smoke and bench not rerun (loop unchanged).
- **Review round (2026-11-25):** orphaned notes after deleting a session's laps (D-PL5-15, user: deleted with the last lap, leftovers cleaned at start); a newer database (`user_version` 3) was opened and written, now left untouched with an in-memory database and a message, restores checked against `SCHEMA_VERSION` (D-PL5-16); `/api/overview` and `/api/dashboard` private, 64 KB notes bodies, early tag-list check (D-PL5-17); truthful Progress fallback; pre-v2 copy for any user rows. User decisions: OD-PL-19/20/21/23 (a); OD-PL-22 → (b) skipping game mods switches off the automatic HUD/loader install via the existing flags, Settings → In-game HUD (D-PL5-18); OD-PL-24 → (c) the guide never opens by itself; D-PL5-1 … 14 confirmed. Commits `5395369`, `9abd626` + docs. Tests: check 131/131, test 306/306, test:electron 306/306, test:browser 21/21 ×3.
- **Open decisions:** none.
- **User approval:** pending. Push/merge not done.

## PL6: Actionable lap analysis

- **Started / finished:** 2026-11-25 · branch `platform/pl6-analysis` (from `c65fa65`, the PL5 merge) · scope in `docs/platform/BACKLOG.md` (PL6); report `docs/platform/PL6-report.md`; algorithms in `docs/platform/ANALYSIS.md`
- **Objectives:** ranked corner opportunities with entry/apex/exit split, brake release, throttle hesitation and delayed acceleration, gear choice, corner distributions, PB explanation, multi-session trends, a repeatability target lap next to the ideal; deterministic, minimum samples, PL4 classes, no fabricated channels.
- **Changes:**
  - `src/stats.js` (quantiles, median interval, Theil–Sen); `src/analysis.js` `holdMs`, `phaseTimes`, `channelPresence`; `src/opportunities.js` (pure aggregation, `RULES`).
  - `src/service.js` `lapAnalysisAsync` in slices with per-lap numbers in the PL3 cache, anchor = newest valid lap (incompatible laps left out and listed, mix labelled, optional same game version / setup), `GET /api/analysis`.
  - `public/analysis.js` Lap analysis page: top three cards (headline, confidence, phase bar, "What was measured" apart from "What it may mean", links to Compare at the corner), all corners with distribution strips and details, target lap, PB card, trends; links from Sessions, Consistency, Ctrl+K.
  - Commits: `a288182`, `271bcb7`, `3a95dfc`, `afe65c2`, `6dddedb`, `76cd6c2`, `197737f`, plus the docs commit.
- **Findings:** the report and Consistency compare with a single fastest pass (`src/report.js:44`, `public/consistency.js:42`); missing channels resample as zeros (`src/analysis.js:17`); no brake pressure and no per-lap automatic-gearbox record (labelled); the first version held the loop 41 ms with cached traces (fixed, 12.7 ms); the browser import flow re-imported the oldest lap overall (now a mock lap).
- **Tests:** `npm run check` 131/131 → 138/138; `npm test` 307/307 → 337/337 (Node 22.23.4); `npm run test:electron` 337/337 (Node 24.22.2); `npm run test:browser` 21/21 → 22/22 (×2).
- **Known limitations:** thresholds tuned on synthetic and mock laps only (no game here); associations, not causes; packaged smoke and bench not rerun (port 8080 busy; loop unchanged); no DB change.
- **Open decisions:** OD-PL-25 … 31 (conservative defaults built); D-PL6-1 … 9 made without asking.
- **User approval:** pending. Push/merge not done.
