# PL2 report: automated quality and release checks

- **Date:** 2026-11-24 · **Branch:** `platform/pl2-quality` (from `platform/integration` = `f5cbaa0`, PL1 merged there; `main` is still `be3b5ef`)
- **Scope:** `docs/platform/BACKLOG.md` PL2: CI workflow, tests on Electron's Node, `npm run verify`, packaged-app smoke script, headless-Edge browser flows, fixture provenance, `engines`, `npm audit` assessment, lint/type-check assessment; plus the flaky leaderboard test and the stale `docs/ARCHITECTURE.md` line references left by PL1.
- **Result:** complete. Nothing pushed; CI has not run on GitHub.

## What changed

| Commit | Change |
| --- | --- |
| `3b61ccd` | **Flaky test fixed at its root** (see below). `src/leaderboard.js`: every deferred job (sync after a lap `:184`, after a sign-in `:436`, the places after a send `:225` and after a sign-in `:437`, the check 5 s after start `:382`) goes through `later()` (`:121-128`), which keeps its timer; `stop()` (`:448`) clears them and the periodic sync; `createLeaderboard({ background: false })` starts none. The app keeps the default, so its behaviour is unchanged (D-PL2-4). `test/leaderboard.test.js`: the 9 app instances use `background: false`; new test "background work (PL2)" proves with mock timers that a valid lap schedules a sync and that `stop()` cancels everything pending. |
| `e99fed6` | `test/electron-node.js` + `npm run test:electron`: the suite on Electron's own Node (`ELECTRON_RUN_AS_NODE=1`, prints the runtime version; extra arguments pick files). `test/smoke.test.js:19-20` keeps `ELECTRON_RUN_AS_NODE` for its child processes when it runs under Electron (they are started with `process.execPath`, which is then `electron.exe`; without it they opened as GUI apps and 12 smoke tests failed). `npm run verify`. |
| `18a6ce4` | `test/packaged-smoke.js` + `npm run smoke:packaged [-- --build]`: CLAUDE.md release step 6 as a script. Skips (exit 0) off Windows and when 127.0.0.1:8080 is busy; `--build` = `rm -rf dist` + `npx electron-builder --win dir` (never `npm run dist`, never deploys); clears `ELECTRON_RUN_AS_NODE`; scratch `ACEVO_DATA` **and** `ACE_DIR` under `%TEMP%\paddock-tests`; refuses a build that already holds `data\`; checks GET `/` = 200 with title "AC EVO Paddock" and the log file; stops only its own process tree (`taskkill /PID … /T`); checks `dist/win-unpacked/data` does not exist afterwards. |
| `105c06c` | `.github/workflows/ci.yml`: `windows-latest` (Node 22, `npm ci`, check, test, test:electron) and `ubuntu-latest` (check + 17 platform-neutral test files; the 5 excluded ones are named with the reason in the file). `engines: { node: ">=22.13" }` in `package.json` and the lock's root entry. |
| `eac9f50` | `test/browser.flows.js` + `npm run test:browser`: headless Edge driven over the DevTools protocol with Node's own `WebSocket` (no dependency; D-PL2-3). Six tests: Home opens with its title; Sessions → a session report; Compare of two laps draws its charts; lap import through the page's own button (broken file and duplicate refused with a reason and nothing stored, then a valid file added after deleting its lap); Settings saves a driver name and never shows a key; keyboard (Alt+0/Alt+1, Ctrl+K palette with typed search and Enter, Esc, `?` shortcuts list, Tab). Every test asserts no uncaught exception and no `console.error` in the page. Skips without Edge/Chrome. Part of `verify`. |
| `c079f7c` | `test/fixtures/README.md`: provenance of every synthetic fixture (all generated in code, seeds, where used) and the known environment dependences. Browser flows step in CI. |
| `fd4f53c` | `README.md`: requirement corrected to Node 22.13 (see findings); Contributing documents `npm run verify` and each test command, the CI file and the packaged smoke. `docs/ARCHITECTURE.md`: integration-boundary table rewritten with current line references (PL1 moved most of them) plus a "Sensitive settings" row; runtime and tooling summary updated. `docs/DECISIONS.md`: D-PL2-1 … 4, OD-PL-8, OD-PL-9. |
| `5568ba7` | `CHANGELOG.md` (Unreleased, PL2), `docs/FEATURE_INVENTORY.md` (engineering rows). |
| (this commit) | This report, `docs/PHASE_LOG.md`, `docs/DEVELOPMENT_STATE.md`. |

## Verified findings / rejected assumptions / unresolved

### The flaky leaderboard test (verified, fixed)

- **Symptom (reported):** `test/leaderboard.test.js` "app: a login and a "sent" mark belong to one server" failed about 1 run in 15 with `0 !== 1` on its first `(await app.sync()).sent`.
- **Root cause:** shared state + leaked timers. Each test creates its own `createLeaderboard()` instance, but they all share one database and one `settings.json`. An instance schedules background work on plain `setTimeout`s it could never cancel: a sync 500 ms after a sign-in (`src/leaderboard.js:427` before the fix), a sync 1.5 s after a valid lap (`:174`), the places 500 ms after a send (`:215`) and 3 s after a sign-in (`:428`), and a start check after 5 s (`:372`). The test before the failing one ("a lap sent anonymously …") signs in and ends within a few milliseconds, leaving its 500 ms sync pending. When it fires during the next test, after that test has stored its lap and before its own `sync()`, the old instance (reading the current settings: same server, same Steam account) sends the new lap first, so the test's `sync()` finds it already sent: `sent` 0. It needs the next test's sign-in round trips to take long enough, hence the rare failure, and more often on a busy machine. The test was wrong to assume no other instance was working; the code was wrong to offer no way to stop its timers.
- **Reproduced before the fix:** 0 failures in 30 sequential runs of the file on an idle machine, but **7 of 40** runs failed when 10 copies ran in parallel (CPU contention). All 7 hit the same mechanism in another test: "app: beaten notices…" `:372` `seen.length` 0 instead of 1, because an earlier instance's leftover rank check had already written the new places to the shared `board-ranks.json`, so the test's own check saw no change.
- **After the fix:** 0/30 sequential, **0/50 under the same 10-parallel stress**, full `npm test` 0/8 failures, plus `npm run verify` and the Node 24 run. The fix is deterministic: with `background: false` no timer exists, so there is nothing to race.

### Other findings

| # | Finding | Status | Evidence |
| --- | --- | --- | --- |
| F1 | README said Node ≥ 22.5, but `node:sqlite` needs `--experimental-sqlite` before 22.13 and `npm start` passes no such flag | **Verified (static; 22.5–22.12 not installed here)**, fixed in README and `engines` | `README.md:23`; `package.json` `scripts.start` |
| F2 | The smoke test cannot run under Electron's Node | **Verified (runtime)**, fixed | it deleted `ELECTRON_RUN_AS_NODE` for children that run on `process.execPath` (`test/smoke.test.js:18` before) |
| F3 | The whole suite passes on the shipped runtime | **Verified (runtime)**: 214/214 on Node 24.22.2 (Electron 44.11.1), ~3 s | `npm run test:electron` |
| F4 | Starting the packaged app writes the App Loader and HUD into `ACE_DIR` at once | **Verified (runtime)**: the scratch `ACE` folder got `mods\ACEUIAppLoader.kspkg`, `mods\uiresources\ACEUIAppLoader\trainerhud\`, `Video\ACEUIAppLoader-trainerhud.settingspreset` | `src/server.js:84-85` → `src/hudinstall.js` `startAuto`. CLAUDE.md step 6 sets only `ACEVO_DATA` (OD-PL-9) |
| F5 | The pages' critical flows work and throw no JavaScript error | **Verified (runtime, headless Edge)**, no defect found | `test/browser.flows.js` 6/6, 10 repeated runs 0 failures |
| F6 | Type checking would pay off now | **Rejected** for now: no defect found, only inference noise | D-PL2-1 |
| F7 | `npm audit` problems reach users | **Rejected**: runtime 0; 6 moderate in build tooling (one `minimatch` advisory via `electron-builder`) | D-PL2-2 |
| F8 | `engines` breaks `npm ci` | **Rejected (runtime)**: `npm ci` on a clean `git archive` export with the new `package.json`/lock works; `check` and `npm test` pass there (Electron binary download skipped) | scratch run |
| U1 | The Ubuntu CI job passes | **Unresolved**: no Linux or WSL distro here. The same 17-file list passes on Windows (163/163); none of them reaches `tasklist` or the Windows-only DLL calls (`koffi` loads `kernel32` lazily in `src/shm.js:41`, `src/gamebridge.js:31-45` catches) | first CI run |

## Tests run and results

| Check | Before (PL1) | After (PL2) |
| --- | --- | --- |
| `npm run check` | 112/112 | 115/115 (+ `test/electron-node.js`, `test/packaged-smoke.js`, `test/browser.flows.js`) |
| `npm test` (Node 22.23.4) | 213/213, 22 files | 214/214, 22 files |
| `npm run test:electron` (Node 24.22.2 / Electron 44.11.1) | not possible (202/214, smoke failed under Electron) | 214/214 |
| `npm run test:browser` (headless Edge) | none | 6/6 (also on Node 24) |
| `npm run verify` | none | pass |
| `npm run smoke:packaged -- --build` | manual only | pass: GET 127.0.0.1:8080/ 200, title "AC EVO Paddock", log 7 lines with no errors, no `dist/win-unpacked/data` |
| leaderboard file, sequential × 30 / 10-parallel × 4–5 | 0/30 / **7/40 failed** | 0/30 / 0/50 |
| CI YAML | none | parsed with `js-yaml`; job and step structure checked; the Ubuntu file list cross-checked against `test/` (17 included + 5 excluded = 22) |

## Checks that could not run, and why

- **The GitHub workflow itself:** it only runs after a push, which needs approval. Both jobs are unverified on GitHub; the Ubuntu one has also never run on Linux (U1).
- Game, shared memory, in-game HUD, Steam login, the live Cloudflare leaderboard: unchanged by this phase and not available here.
- `npm audit` was read on a clean scratch install; no audit runs in CI (D-PL2-2).
- Node 22.5–22.12 not installed, so F1 is static (release-notes knowledge of `node:sqlite`), but the new `engines` floor is the conservative side.

## Performance or compatibility impact

- App behaviour: unchanged. The leaderboard's background timers run as before (default `background: true`); they are now tracked in a `Set` and `unref`'d as before.
- `npm test` duration unchanged (~2–4 s). `test:electron` ~3 s, `test:browser` ~5–10 s, `smoke:packaged --build` ~1–2 min.
- `engines: node >=22.13`: `npm` only warns on an older Node (no `engine-strict`); the packaged app is unaffected (Electron's Node 24).

## Migration and recovery implications

None: no database, settings or file-format change. The packaged smoke script never touches `data\`, the installed app or `Saved Games\ACE`; it removes nothing outside `dist/` (and only with `--build`).

## Needs approval

- **Push** of `platform/pl2-quality` (and the integration/main merges): the CI workflow, the README and the changelog become public, and CI starts running on GitHub. After the first push, check both jobs; fix or narrow the Ubuntu list if it fails (U1).
- **OD-PL-8 Dependabot** (adds automated pull requests on the public repository).
- **OD-PL-9**: a CLAUDE.md release-checklist change (step 6: run `npm run smoke:packaged`, or also set `ACE_DIR`). CLAUDE.md was not edited.

## Open decisions (added to DECISIONS.md)

- **OD-PL-8, Dependabot. OPEN (operator).** Default: none.
- **OD-PL-9, `ACE_DIR` in release step 6. OPEN (operator).** Default: CLAUDE.md unchanged; the script does it right.
- Decided within the plan: D-PL2-1 (no TypeScript/linter yet), D-PL2-2 (audit without a gate), D-PL2-3 (CDP, no Playwright), D-PL2-4 (leaderboard `background` switch and `stop()`).
- Still open from earlier phases: OD-PL-1 … OD-PL-7.

## Remaining risks

- CI has never run: a first run may need small fixes (Ubuntu paths or line endings, the Electron download on `windows-latest`, Edge availability for `test:browser`).
- The browser flows depend on page structure (`#imp`, `.sess-row`, `#driverName`, `.palette`, `.palette.shortcuts`, the `paddock:rendered` event). A UI change in PL5 will need to update them; that is intended.
- The packaged smoke uses the fixed port 8080 (as the app does). It skips rather than fails when the port is busy, so a release run with Paddock open proves nothing: the script says SKIP.
- `src/leaderboard.js` `stop()` is not called by `src/server.js` on shutdown (the process exits anyway); harmless today.

## Recommended next phase

**PL3, recording reliability and performance** on a new branch from `platform/integration` after this one is merged: bounded timing diagnostics in the 60 Hz loop (`src/server.js:267-286`), mock scenarios with seeded large histories, numbers in `docs/platform/PERFORMANCE.md`. `npm run verify` is the gate for each step.
