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

## 2026-11-17: P5, the home dashboard

- **Home is where Paddock opens** (an empty address opens `#/home`). `#/` stays Sessions, so every existing link, back button and bookmark keeps working.
- **One request, real data only:** `service.dashboard()` aggregates the stored laps and reports (no new metric), and the server adds the "Needs attention" list from the state it already tracks. A value that doesn't exist is shown as missing ("no valid lap", "no report yet"), never as 0.
- **Trend = best lap per driving day** from the existing `progress()`, for the 3 combos driven most in the last 60 days. It is drawn the same way up as the Progress page (higher = slower), with new personal bests marked in the timing purple.
  - **Rejected:** a composite "performance score" on Home. It is planned for P6 with its formula shown, not before.
- **Fixed layout** rather than customisable widgets (as planned in the roadmap).

## 2026-11-17: P6, driving technique

- **Technique metrics live in `cornerMetrics`** (src/analysis.js `techniqueMetrics`), so Compare, Consistency and the report get them without a second pass over the laps. They use only core telemetry (pedals, steering, speed), which is verified, so they are labelled *Calculated*.
- **Relative limits:** every threshold is a share of the pass's own peak (90 % of peak brake, 20 % / 25 % / 2 % of peak steering lock), and the report compares each corner with that corner's fastest pass. Absolute steering units differ by car and wheel; this keeps the counts comparable.
  - **Rejected:** fixed thresholds per metric (they would suit only some cars, the roadmap risk).
- **Performance score** = 0.5 pace + 0.3 consistency + 0.2 validity, each 0–100. Pace = 100 − 2000 × (median clean lap − ideal) / ideal (5 % off the ideal = 0); consistency uses the session report's formula, so the two never disagree. Needs 3 clean laps; otherwise the reason is shown, not a number. Home uses the last 10 laps per combo; Consistency uses the laps in view.
  - **Rejected:** best lap instead of the median (one lucky lap would carry the score); a hidden or learned weighting (not explainable on the page).
- **Report style section** only with 3+ valid laps in the session; report format version 2. Stored v1 reports are not rebuilt automatically (their targets must stay as set); the page offers *Regenerate*.
- **Inputs heatmap** is drawn in the browser from the trace the Compare payload already carries (no new endpoint); the choice Time / Inputs is remembered per viewer.

## 2026-11-17: P7, setup history and comparison

- **A history entry = what was driven:** laps are grouped by the snapshot of values stored when they were driven (`setup_info.snap`) together with the file (`snap:<hash>@<rel>`), not by file name alone: two files saved with the same values stay two setups. A saved file edited between sessions shows as "version 1 of 2", "version 2 of 2", so lap times are never credited to values that were not on the car. Laps without a snapshot fall back to the file (`file:<rel>`), "Standard" (no match) or "Not recorded" (before setup tracking).
  - **Rejected:** grouping by file name only (it would mix two different setups under one name).
- **Comparison values** come from the snapshot; only when there is none, from the saved file as it is now, labelled "file as it is now". Standard and Not recorded entries have no values: the page says so instead of comparing.
- **Typical lap = median of clean laps** (valid, within 7 % of that setup's best), the same rule as the report and Progress, so the numbers agree across pages.
- **Its own page** (`#/setuphistory?combo=`), reached from the Sessions combo, the palette ("history …") and the Setups tab (*Your laps here*), because laps are keyed by game track/car names and setups by catalogue ids; `/api/setuphistory/combos` maps one to the other.
- **AI engineer** gets `by_setup` (compact rows; `this_setup` only on the entry driven with the file's current values, `this_setup_other_values` on its older or unknown versions, so old lap times are not credited to new values) plus a note on whether setup recognition is checked in game.

## 2026-11-17: P8, AI coach upgrade

- **One Coach page per track + car** (`#/coach?combo=`), from the Sessions combo, the palette ("coach …") and the page list. The chat is kept per combo (`coach_messages`); the per-lap coach on Compare stays as it was.
- **Context = summaries, never telemetry:** totals, the last 6 sessions, the last 3 reports (weakest corners with reasons, style habits, invalid laps, targets met), corner times of the latest report, laps by setup (P7), the training plan with its checks, the number of brake marks, and data quality. Under 9 kB (tested), sent as the system instruction; the last 12 messages go along as history. *What is sent* shows the instructions and the data.
  - **Rejected:** sending lap traces or every report (the free tier's token limits).
- **A chat turn is saved only when the answer came back:** a missing key, no network, a quota error or an empty answer leave the chat as it was, and the question stays in the box.
- **Training plan = a report's measurable targets** (lap, corner, consistency, track limits: the kinds `checkTargets` checks), one active plan per combo, replaced by a new one. Every later session (up to the latest 10) is checked with the same rules as the report's "last session's targets"; sessions without a stored report are checked from a report built on the fly (not stored).
  - **Rejected:** AI-written targets (free text that cannot be checked automatically). The debrief still writes a plan in words; the structured plan is the report's targets.
- **AI braking points** are validated by Paddock before they are shown: inside the corner's zone (previous apex to this apex, on the best lap), at most 15 m later than the driver's fastest recent pass, one per corner. Applying replaces only the marks inside the ticked corners' zones. Nothing is saved by asking.
- **AI errors carry a code** (nokey → 400, network/http/empty/format → 502) and say what to do; 429 says the free-tier limit is reached.
- **Review follow-ups:** a plan is not checked against sessions under 3 laps (no stored report) or the session being driven; those show "–" with the reason. Only the latest 10 later sessions count, and the page says how many older ones are left out. The first corner's braking zone runs across the start/finish line, so a mark placed before the line belongs to it. Applying never silently passes the 60-mark limit. Gemini calls (coach, debrief, setup engineer) time out after 90 s.
  - **Accepted:** corners are matched by name (T1…Tn are unique by construction).

## 2026-11-17: D3, gamification

- **Decision (user):** achievements and challenges: **yes**, alongside goals (the roadmap default was "no; goals only").

## 2026-11-17: P9, driver development

- **Goals are checked from lap times and the game's valid flag only** (verified core telemetry): lap time, laps within a window of a reference time in one session, valid laps in a row in one session, session consistency score (the report's formula, `report.consistencyOf`). Only laps driven after the goal was set count. The first time a goal is met, the time, lap and session are stored, so deleting laps later does not take it back.
  - **Rejected:** corner or technique goals (they rest on detected corners and would move when the track model changes); goals over all cars (a lap time only means something per car and track).
- **A challenge is a goal with a deadline** (one table, `due_at`): laps after the deadline do not count, and a challenge met after it would never be "met in time". Paddock suggests challenges (7 days) for the 3 most driven combos of the last 30 days: a lap time halfway from the best towards the ideal lap (at most 0.5 s, at least 0.1 s), laps within 0.5 s (0.3 s once that is done) of the best, a longer valid run, a consistency score 3 points higher. An active training plan's lap target is offered as a goal (P8 plans feed goals). Suggestions skip kinds already open on that combo.
- **A consistency goal waits for the end of the session** being driven (its score can still change); the other kinds can be met mid-session, because more laps never undo them.
- **Achievements are not stored:** they are recomputed from laps, goals and weekends, with the time of the event that crossed each threshold, so they are always consistent with the data (a restore or deleted laps change them accordingly). Only "seen at" is kept (`meta`), for the "new" badge. 28 achievements in ladders; the page shows reached steps plus the next one of each ladder (all on request).
  - **Rejected:** stored unlocks (they would disagree with the data after deleting laps or restoring a backup); points or levels (not asked for, and they invite comparing numbers that mean nothing across cars).
- **Race weekends:** Paddock records every session it started (`launches`, from the order's `meta` once the HUD reports "started"). A session belongs to a weekend launch if it started after it, before the next launch, within the planned length + 90 min, on the launch's track layout and car. The game does not say which part of the weekend (practice, qualifying, race) a session was, so the history lists the sessions in order with their game session type.
- **Session planner** builds the same order as the Race tab: a driven combo's catalogue track and car + a Race tab preset's session settings (or hotlap / 30 min practice with clear weather and optimum grip), with the goal id in the order's meta. Online presets are refused (they join a server). Starting asks before ending a running session, like *Start hotlap*.
- **Notifications:** a goal met or an achievement reached is broadcast to the page (Home refreshes, a dot on Development) and shown as a desktop notification. Achievements already reached when Paddock starts are not announced.
- **Sidebar:** Development sits after Sessions; Alt+1…9 follow the sidebar, so the later pages moved one number up.

## 2026-11-24: Platform plan PL0, open decisions

Raised in PL0 (`docs/platform/PL0-report.md`). Each has a conservative default that PL1 implements unless the user decides otherwise.

- **OD-PL-1, leaderboard sign-in in backups and restores. DECIDED (user, 2026-11-24): option (b).** Secret-free backups carry `boardToken` and `boardSteam` today (finding 1.1-a), and a restore brings them back (1.1-c). Options: (a) never back up the token, a restore clears the sign-in and the driver signs in with Steam again; (b) as (a), but keep the current install's sign-in when the backup has none (like the Gemini key); (c) include the token in "include secrets" backups.
  - **Conservative default (PL1):** (a) for every backup, including "include secrets" and before-restore backups. A token is a 180-day login and can be renewed with one Steam sign-in, so dropping it costs little.
  - **Decision:** (b). No backup ever holds the token or Steam identity; a restore keeps the current install's sign-in (token and identity together, never half of one) and never takes one from a backup, also from an older backup that still holds one. Implemented in PL1D (`src/sensitive.js` `mergeRestoredSettings`; `docs/platform/PL1D-report.md`).
- **OD-PL-2, identity data in `.lap.gz` exports. DECIDED (user, 2026-11-24): the default confirmed.** An exported lap carries the `board` column (Steam id, leaderboard URL, rank; for downloaded laps the other driver's id and name) (1.2-g). It is not a credential, but a shared file reveals it.
  - **Conservative default:** leave `board` out of exports; keep `aids`, `cond` and `setup_info` (analysis needs them). Import already ignores `board`.
- **OD-PL-3, importing a lap that is already there. DECIDED (user, 2026-11-24): the default confirmed (refuse, naming the existing lap).** Today it is stored twice (1.2-d). Options: refuse, skip silently, import again.
  - **Conservative default:** refuse with a message naming the existing lap (match on track, layout, car, lap time, recorded time and sample count).
- **OD-PL-4, secrets in before-restore safety backups. DECIDED (user, 2026-11-24): no secrets at all.** They always include secrets (1.1-e) so that undoing a restore gives back the key and passwords.
  - **Conservative default:** keep them with secrets (minus the token, OD-PL-1), and keep the existing "with key" badge (`public/system.js:80`) ("Contains your Gemini key and server passwords", which stays accurate once the token is out). Not uploaded anywhere.
  - **Decision:** the safety backup holds no Gemini key, no server passwords and no sign-in, so it gets no "with key" badge (the badge stays right for older safety backups that do hold them). Undoing a restore with it keeps the key, passwords and sign-in the install has at that moment (OD-PL-1 (b) and the existing "keep what the backup leaves out" rule). Since the "current secrets win" refinement below, no restore replaces a key or password, so the safety backup never has to bring one back. Implemented in PL1D (`src/backup.js` `stageRestore`).

## 2026-11-24: Platform plan PL1, defaults applied and new open decisions

PL1 implemented the conservative defaults of OD-PL-1 … OD-PL-4 (`docs/platform/PL1-report.md`). The user decided OD-PL-1 … OD-PL-7 on 2026-11-24: OD-PL-2, -3, -6 and -7 as implemented; OD-PL-1, -4 and -5 changed in PL1D (`docs/platform/PL1D-report.md`).

- **OD-PL-5, telling the driver about a damaged settings file. DECIDED (user, 2026-11-24): option (b).** When `settings.json`, `race.json` or `setup-meta.json` cannot be read, PL1 keeps it aside as `<name>.unreadable-<time>` and logs a `[data]` line; the page shows nothing. Options: (a) log only; (b) a notice in Settings with the file name and how to recover it.
  - **Conservative default (PL1):** (a). (b) is a UI addition beyond the plan; candidate for PL4.3 (health panel) or PL5 (error recovery).
  - **Decision:** (b). `/api/settings` returns `fileNotices` (file name, state, the name of the copy kept, whether saves are refused; never the folder or the file's contents) and `canSave`; the Settings page shows a notice under its title with how to recover. Damaged copies left from an earlier run are listed too, until the driver deletes them. Implemented in PL1D (`src/jsonfile.js` `fileIssues`, `src/settings.js` `fileNotices`, `public/settingspage.js`).
- **OD-PL-6, size cap for mod uploads. DECIDED (user, 2026-11-24): (a) no cap, confirmed.** Backup uploads are capped at the largest backup Paddock can make (PL1). Mod uploads (`/api/mods/upload`) stay uncapped: a `.kspkg` pack can be several GB and there is no natural ceiling; extraction itself is now bounded by the sizes the zip states. Options: (a) no cap; (b) a fixed cap (e.g. 8 GB); (c) a cap from free disk space.
  - **Conservative default:** (a), local origin only (writes already refuse other sites).
- **OD-PL-7, channels a newer Paddock might add to lap files. DECIDED (user, 2026-11-24): (a) keep them (max 64), confirmed.** A version-1 lap file with an unknown array is imported if it has one finite number per sample (kept as is); anything else that is not a channel is dropped. Options: (a) keep such channels (forward compatible); (b) drop every unknown key.
  - **Conservative default:** (a), with the 64-channel cap. Nothing reads an unknown channel.

## 2026-11-24: Platform plan PL2, quality checks

Decisions made in PL2 (`docs/platform/PL2-report.md`) and the open ones it raised.

- **D-PL2-1, no TypeScript or linter for now.** Evaluated with TypeScript 5.9.3 + `@types/node` 22 in a scratch folder (never installed in the repo): `tsc --noEmit --checkJs` on the PL1 data-safety modules found no defect. `src/sensitive.js`, `src/jsonfile.js`, `src/telcodec.js`, `src/restore-apply.js` and `src/analysis.js` were clean; `src/lapfile.js` (3) and `src/zip.js` (2) only had inference noise (number arrays seen as tuples, a spread argument); larger modules show many more of the same kind (`src/leaderboard.js` 62). The cost would be a devDependency plus JSDoc annotations to silence false positives, with no demonstrated benefit. `node --check` (`npm run check`) stays the only static check.
  - **Revisit:** when a module gets a typed public API worth pinning (e.g. PL4 provenance records, PL6 analysis results). Then use `// @ts-check` on that file only, run with a pinned `npx --yes -p typescript@<ver>` (as `npm run wrangler` does), not as a devDependency.
- **D-PL2-2, `npm audit`: assessed, no gate.** On 2026-11-24 a clean `npm ci` shows 0 vulnerabilities in runtime dependencies (`npm audit --omit=dev`) and 6 moderate in build tooling, all one advisory: `minimatch` ReDoS (GHSA-g3hv-75wg-m249) through `electron-builder` 26.18.0. It only runs at build time on the developer's own files, so it is not reachable by users. A blocking audit step would fail CI on advisories outside the project's control; review it at each release instead (CLAUDE.md release step 1 is the natural place, a user decision).
- **D-PL2-3, browser tests without Playwright.** The headless-Edge approach from P2–P9 (DevTools protocol) is enough: `test/browser.flows.js` drives it with Node's own `WebSocket` (Node ≥ 22.4, also in Electron's Node 24). No devDependency. Playwright would only be worth it for cross-browser runs or tracing, which nothing needs now.
- **D-PL2-4, the leaderboard's background work can be switched off.** `createLeaderboard({ background: false })` starts no timers, and `stop()` cancels the pending ones. The app keeps the default (`true`), so its behaviour is unchanged; tests use `false` and call `sync()` themselves (the flaky-test root cause, PL2 report).
- **OD-PL-8, Dependabot. OPEN (operator).** Options: (a) none (today); (b) `.github/dependabot.yml` with monthly, grouped updates for `npm` and `github-actions`, capped at 2 open PRs; (c) security updates only (a repository setting, no file).
  - **Conservative default:** (a). It only acts after a push and opens pull requests on the public repository, which is a user choice. (c) is the low-noise option if wanted.
- **OD-PL-9, CLAUDE.md release step 6 should also set `ACE_DIR`. OPEN (operator).** The packaged smoke test showed that a started app installs the ACE UI App Loader and the Paddock HUD into `ACE_DIR` at once (`src/hudinstall.js` `startAuto`, called from `src/server.js:85`). Step 6 only sets `ACEVO_DATA`, so a manual smoke run writes into the real `Saved Games\ACE` (harmless when it holds the same versions, but not a scratch run). `npm run smoke:packaged` sets both. Proposed: step 6 says "run `npm run smoke:packaged`" or adds `$env:ACE_DIR = <scratch>\ACE`. CLAUDE.md is the user's file, so it was not changed.
