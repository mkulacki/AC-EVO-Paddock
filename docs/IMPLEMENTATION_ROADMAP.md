# Implementation roadmap

Status: **PROPOSED, waiting for user approval** (2026-11-17). Based on [PRODUCT_AUDIT.md](PRODUCT_AUDIT.md) and [FEATURE_INVENTORY.md](FEATURE_INVENTORY.md).

## Strategy

- **Extend, don't replace.** About half of the requested list already exists. Phases fill gaps around the existing modules (`service.js`, `report.js`, `ai.js`, `setups.js`) instead of adding parallel systems.
- **Safety net first.** There are no tests. Phase 1 adds them before anything else changes.
- **Honest data before more analysis.** Several analyses rest on unverified shared-memory channels. Phase 2 makes provenance visible before more conclusions are built on them.
- **Each phase is one branch** (`phase/<id>-<name>`), small enough to review in one sitting, deployed to the installed app for review, and merged into local `main` only after APPROVE. Pushing and releasing stay separate and need your OK each time (CLAUDE.md).
- **No new runtime dependencies** unless a phase says so. Tests use the built-in `node:test`.

Phase workflow (every phase): prepare → architecture check → implement → QA (`npm test`, syntax check, mock smoke run, build) → independent review by a code-review subagent → report → **your approval gate**.

## Decisions needed from you (asked when their phase starts, not now)

| ID | Question | Default if you don't care | Blocks |
| --- | --- | --- | --- |
| D1 | Accent colour and navigation: keep the lime accent and top nav from the 0.5.0 design pass, or move to an orange accent and sidebar? | keep lime + top nav, add the command palette | P4 |
| D2 | Update mechanism: none / check GitHub releases and notify (one network call, opt-out) / auto-download | check-and-notify, opt-out in Settings | P3 |
| D3 | Gamification: achievements and challenges, yes or no? | no; goals only | P9 |

---

## P1: Test foundation and baseline

- **Objective:** an automated safety net, so later phases can prove they broke nothing.
- **Value:** fewer regressions in releases; makes every later phase reviewable.
- **Features:** `npm test` (node:test), `npm run check` (syntax check from CLAUDE.md as a script), API smoke test against a mock server with seeded data in a temporary data dir.
- **Dependencies:** none.
- **Files:** `test/**` (new), `package.json` scripts, `src/mock.js` (export the seeding function if needed, no behaviour change), CLAUDE.md release checklist (add `npm test`).
- **Plan:** unit tests for `analysis.js` (resample, corners, ideal lap, deltas), `db.js` migrations on a temp DB (v0 → current, data kept), `report.js` / `service.js` on seeded laps, `carsetup.js` read → write → read round trip on a synthetic file, `setupmatch.js`, `zip.js`, `pb.js`. Smoke test: start `server.js --mock` on a free port with `ACEVO_DATA` in a temp dir and hit every GET route.
- **Acceptance:** `npm test` passes on a clean checkout, has no network access, and never touches `data/` or the game folders; it finishes in < 60 s.
- **Testing:** the suite itself; run it twice to show it is deterministic.
- **Risks:** modules with side effects on import (`db.js` opens `DATA_DIR` at import time) need `ACEVO_DATA` set before import. Use child processes or dynamic import.
- **Done:** suite green, documented in README "Contributing", added to the release checklist.

## P2: Data provenance and AI confidence

- **Objective:** follow the data-integrity rules: every number and conclusion shows whether it is measured, calculated, unverified or AI-interpreted.
- **Value:** you can trust what the app says; no understeer verdicts without confirmed data.
- **Features:** one channel registry (`src/channels.js`) listing every telemetry channel with status `verified | unverified | missing`, seeded from current knowledge and updated by the existing *Setup recognition → confirm* flow; provenance badges in the Car & setup report, session report and setup engineer; conclusions built on unverified channels are shown as "unconfirmed" and kept out of headline suggestions; AI prompts get the provenance and must return a confidence (high/medium/low) and the basis for each recommendation, shown in the UI.
- **Dependencies:** P1.
- **Files:** `src/channels.js` (new), `src/carreport.js`, `src/report.js`, `src/ai.js`, `src/server.js` (setupcheck confirm), `public/carsetup.js`, `public/reports.js`, `public/setups.js`, `style.css`.
- **Acceptance:** with no confirmed channels, the Car & setup tab shows no balance or tyre verdict as fact; AI answers show a confidence and basis; confirming channels in Setup recognition lifts the labels; tests cover the registry and the gating.
- **Risks:** the AI may ignore the output format, so parse defensively and fall back to "confidence not given". No game run is needed to build this, but **real verification still needs you in game** (one stint with Setup recognition open).
- **Done:** criteria met; README "Checking shared memory" updated.

## P3: Application management

- **Objective:** protect your data and make support easier.
- **Features:** **Backup & restore**: a zip of `telemetry.db` (consistent copy via `VACUUM INTO`) and the JSON files, without caches; the Gemini key and server passwords are left out by default (opt-in). Restore asks for confirmation and first backs up the current data automatically. **Bulk export:** laps/sessions as CSV and JSON. **Diagnostics page:** version, data dir, DB size and counts, game/Saved Games paths, loader/HUD state, telemetry source status, channel registry, last 200 log lines, and "Copy diagnostics" with secrets removed. **Update check** as decided in D2.
- **Dependencies:** P1 (tests for backup/restore round trip). P2 is optional (diagnostics shows the registry if it exists).
- **Files:** `src/backup.js`, `src/diagnostics.js` (new), `src/zip.js` (writer, if missing), `src/server.js` routes, `public/settings` section or new `public/system.js`, `desktop/main.cjs` (log path to diagnostics).
- **Acceptance:** backup → wipe temp data → restore gives an identical lap set (test); restore never runs while recording; diagnostics text contains no API key, password or driver name unless chosen.
- **Risks:** restoring while the DB is open, so restore swaps files at restart (as `restartApp` does). Data loss is mitigated by the automatic pre-restore backup.

## P4: App shell: navigation, command palette, consistent states

- **Objective:** find anything fast; consistent behaviour on every page.
- **Features:** a **Command palette** (Ctrl+K) with global search over pages, tracks/layouts, cars, sessions, setups and actions (start hotlap, open last report, compare best vs ideal); a **shortcut help** overlay (`?`); shared `loading / empty / error` helpers in `util.js` applied to every page; navigation and accent as decided in **D1**; a responsive pass down to 1024 px.
- **Dependencies:** P1. D1 answered.
- **Files:** `public/palette.js` (new), `public/util.js`, `public/app.js` (shell split from the Sessions page into `public/sessions.js`), `public/index.html`, `style.css`, page modules (state helpers only).
- **Acceptance:** every page has a visible loading, empty and error state; the palette finds a track, a car, a session and a setup in ≤ 3 keystrokes; there are no dead controls; existing routes and deep links keep working.
- **Risks:** touching every page; keep changes mechanical, and the smoke test checks routes.

## P5: Driver home dashboard

- **Objective:** one page that answers "how am I doing, and what should I do next?"
- **Features:** a new home (`#/home`; Sessions stays one click away): recent sessions, personal records across all combos, a trend per most-driven combo, consistency, open practice targets from the latest reports, and warnings in one list (HUD/loader state, game-version mismatch, unverified channels, missing Gemini key when AI was used). Every tile comes from existing services; empty states guide a new user to their first lap.
- **Dependencies:** P4 (states, shell). P2 (warnings about unverified channels).
- **Files:** `public/home.js` (new), `src/service.js` (`dashboard()` aggregation), `src/server.js` route, `style.css`.
- **Acceptance:** with an empty DB it shows onboarding; with seeded data every tile shows real values traceable to sessions; no tile has fake or placeholder numbers.

## P6: Driving technique analysis

- **Objective:** measure *how* you drive, not only how fast.
- **Features:** per-corner style metrics from 60 Hz inputs: brake application rate and peak, **trail-braking overlap** (brake still on while steering), release smoothness, throttle pickup (time from apex to full throttle, re-lifts), steering corrections (sign changes and saw), coasting. **Corner rankings** across all your passes (best, median, worst per corner, with lap links). **Input heatmap** layer on the track map (brake / throttle / coast). A **performance score** whose formula is shown on the page (pace vs ideal + consistency + validity), labelled "calculated".
- **Dependencies:** P1, P2 (labels), P5 (score tile on home).
- **Files:** `src/analysis.js` (metrics), `src/service.js`, `src/report.js` (style section), `public/telemetry.js` (heatmap layer), `public/consistency.js` (rankings), tests.
- **Acceptance:** metrics unit-tested on synthetic traces with known answers; each metric has a tooltip with its definition; the report shows the style section only when data is sufficient.
- **Risks:** thresholds may suit only some cars, so make them relative to each corner's own reference pass.

## P7: Setup history and comparison

- **Objective:** know which setup is faster, from your own laps.
- **Features:** **setup history** per car + track (every snapshot actually driven, with dates and laps); **compare two setups** side by side (values diff, from `setup_snapshots` or files); **performance by setup** across sessions (best, median clean lap, lap count, conditions); the setup engineer gets laps **split by setup** (removes the README limitation).
- **Dependencies:** P1. P2 (provenance for the engineer input).
- **Files:** `src/setups.js`, `src/db.js` (queries), `src/ai.js`, `public/setups.js`, tests.
- **Acceptance:** with two setups driven on one combo, the page shows both with correct lap stats; the diff lists exactly the changed values.
- **Risks:** fingerprint recognition is unverified (P2 labels it); "Standard" laps are grouped together.

## P8: AI coach upgrade

- **Objective:** a coach that knows your history and is honest about certainty.
- **Features:** **combo-level chat** (track + car) with context from reports, style metrics (P6) and setup split (P7), with "what is sent" transparency as today; a **training plan** saved as structured targets (from the debrief) that the next sessions check automatically; **AI braking-point suggestions** that can be applied to your brake marks after review (never automatically).
- **Dependencies:** P2, P6, P7.
- **Files:** `src/ai.js`, `src/db.js` (plans and chat tables, additive migration), `src/report.js` (target checks), `public/reports.js`, a new chat panel, tests with a stubbed Gemini.
- **Acceptance:** chat works without a key (clear message) and with network errors (handled); a plan's targets show met/not met after the next session; every AI claim shows confidence and basis.
- **Risks:** Gemini free-tier limits, so keep the context compact and reuse `buildSummary`.

## P9: Driver development

- **Objective:** long-term motivation and structure.
- **Features:** **goals** (target lap time, consistency score, or clean-lap streak per combo) tracked automatically from real laps; **session planner** (pick combo + goal + Race-tab preset, start it); **race weekend history** (sessions grouped by Race-tab weekend launches); achievements/challenges only if D3 = yes.
- **Dependencies:** P5 (home shows goals), P8 (plans feed goals).
- **Files:** `src/goals.js` (new), `src/db.js` (additive table), `src/race.js` (weekend grouping), `public/goals.js`, `public/home.js`.
- **Acceptance:** a goal flips to met from a real lap in a test; weekend grouping is correct for a seeded weekend.

## P10: Final regression and release preparation

- Full test suite, build, smoke test on the packaged exe (CLAUDE.md steps 5–6), docs refresh (README, CHANGELOG, ARCHITECTURE, FEATURE_INVENTORY), final report. The release itself (tag, GitHub, overtake.gg) only on your explicit go.

## Out of scope / not feasible

- **In-game ghost car:** the game has no API for it (the desktop replay ghost already exists).
- **Applying a setup inside the game:** the game loads setups only in its own screen (README limitation).
- **Customizable widget dashboard:** deferred; a fixed, well-chosen home (P5) first.
- **Fixing the unverified shared-memory channels:** needs you in game; P2 makes the gap visible and tracks it.
