# Decisions

Earlier product decisions (Race tab, Mods, setups, spotter, brake marks, reports, loader bundling, EVO-native data) are recorded in the README and the commit history. This file records decisions made from the 2026-11-17 audit onward.

## 2026-11-17: Extend the existing stack, no framework migration

- **Decision:** keep vanilla ES modules (no build step), the hand-written Node router and SQLite via `node:sqlite`.
- **Why:** the stack works, ships as a portable zip without a bundler, and the app has 4 runtime dependencies. A React/TypeScript rewrite would put the whole app at risk for no user-visible gain.
- **Rejected:** React + Vite; TypeScript conversion; Express.

## 2026-11-17: Tests with the built-in `node:test`

- **Decision:** `node:test` + `node:assert`, no Jest/Vitest.
- **Why:** zero new dependencies; Node 22 is already required.

## 2026-11-17: One branch per phase, merged locally after approval

- **Decision:** each phase is built on `phase/<id>-<name>`, committed in small steps, deployed to the installed app for review, and merged into local `main` after APPROVE. Push, PR, tag and release only on the user's explicit OK.
- **Why:** the user's feature-branch rule and the CLAUDE.md publishing rules.

## 2026-11-17: Provenance before more analysis

- **Decision:** put data-provenance labelling (P2) ahead of new analysis features.
- **Why:** some current conclusions (balance, tyre windows) depend on unverified shared-memory offsets; the data-integrity rules forbid presenting them as fact.

## 2026-11-17: Open product decisions

- D1 accent/navigation, D2 update mechanism, D3 gamification. See IMPLEMENTATION_ROADMAP.md. Each is asked when its phase starts.

## 2026-11-17: P2, how provenance works

- **Decision:** one registry, `src/channels.js`, with a status per telemetry *group*, not per value. Built-in `verified`: core telemetry (speed, pedals, steering, gear, RPM, lap timing, position) and track limits, both checked in game during development. The driver can confirm five groups against what the game shows: pit-box readings, temperatures, tyres, brakes, suspension. Slip angles/ratios, G forces and the game's "window" values can't be checked on any game screen, so they stay unconfirmed.
- **Decision:** conclusions carry a `basis` (the groups they rest on). A conclusion counts as confirmed only if every group in its basis is verified. Unconfirmed conclusions stay visible but separate ("Unconfirmed hints"); they are not deleted, because they can still be useful and the user wanted the data.
- **Decision:** AI answers end with `Confidence: high|medium|low - <basis>` (free text), or have JSON fields (setup engineer). Paddock parses that and shows a badge; "Confidence not given" when the model leaves it out. The prompts get `data_quality` with each group's status.
- **Why:** this follows the data-integrity rules (measured, calculated, interpreted and missing are shown apart) without hiding features the user built.
- **Rejected:** hiding unconfirmed data entirely (it would lose the Car & setup tab until verified, and slip can never be verified); a numeric confidence score for rule-based hints (it would suggest a precision the rules don't have).
- **Backward compatibility:** `settings.probeConfirmed` (≤ 0.5) still counts as checking the pit-box readings and the temperatures; the confirm endpoint without `group` keeps its old meaning.

## 2026-11-17: P3, application management

- **D2, update mechanism (user's choice): check and notify.** Once a day, one anonymous request to the GitHub releases API with a generic User-Agent. Nothing is downloaded or installed, and it can be switched off (`updateCheck`). Beta users are offered betas; stable users only stable releases. Never in mock runs or tests.
  - **Rejected:** auto-download and install (unsigned builds, more risk); no check (the user's choice).
- **Backups:** a zip in `data\backups` with a `VACUUM INTO` copy of telemetry.db and the small JSON files. Secrets are out by default. Caches, logs, disabled mods and the backups themselves are excluded.
  - **Why:** one file is easy to keep or move, and `VACUUM INTO` gives a consistent copy while the app keeps running.
  - **Rejected:** copying the data folder (inconsistent while the database is open; caches can be large).
- **Restore = stage, then swap at the next start** (`src/restore-apply.js`, called from db.js before the database opens), with an automatic backup of the current data first.
  - **Why:** an open SQLite database can't be replaced safely; the safety backup means a restore can always be undone.
  - A failed apply moves the staging aside instead of retrying at every start.
- **Backup and restore refused while on track:** `VACUUM` is synchronous and would stall the 60 Hz loop.
- **Diagnostics redaction** is done value by value: the key, passwords, driver names (settings and laps), the Windows user folder, and anything that looks like a Google key or GitHub token.
- **The zip writer** is part of src/zip.js (deflate, data descriptors, no Zip64), so there are no new dependencies. Verified readable by .NET ZipFile and Expand-Archive.

## 2026-11-17: P4, the app shell

- **D1 (user's choice): lime accent + sidebar.** The 0.5.0 palette and the lime accent stay; the top tab bar became a sidebar with icons that collapses to a rail (Ctrl+B, remembered; automatic below 900 px).
  - **Rejected:** orange accent (it is a chart series colour here); keeping the top bar.
- **Command palette:** a client-side fuzzy match over data the app already has (/api/overview, /api/tracks, /api/setups), cached for 30 s and dropped when a lap is saved. **Nothing in it starts the game:** launching stays a deliberate click on the Race tab.
- **Page states:** the router shows a loading bar (after 150 ms, so fast pages do not flash) and an error card with *Try again*; pages use `util.js` loadingHtml / emptyHtml / errorHtml for their own parts.
  - **Rejected:** a full-page spinner per navigation, because it flashed on every fast page.
- **`public/app.js` is the shell only.** Sessions, Compare, Game and Settings moved to their own modules by a mechanical split (no behaviour change), following the existing `viewX(view, params, cleanup)` pattern.
- **Page order in the sidebar:** grouped as driving (Race, Sessions, Tracks, Setups), then the app (Game, Mods, Settings). Setups moved after Tracks.
