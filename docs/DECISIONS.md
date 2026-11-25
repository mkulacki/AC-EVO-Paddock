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

## 2026-11-24: PL1D review round, user decisions

- **D-PL1D-1, current secrets win on restore. DECIDED (user, 2026-11-24)**, a refinement of OD-PL-1 and OD-PL-4. A restore never replaces a non-empty current Gemini key (every `secret` field in `src/sensitive.js`) or a non-empty current server password with the backup's value; it only fills empty ones. Saved servers the install has and the backup lacks (same id, else same host:port, as `mergeRestoredRace` in `src/restore-apply.js` matches them) are kept with their passwords; presets the backup lacks are kept when they hold a password, so no restore path loses a key or password. The before-restore safety backup stays secret-free (OD-PL-4). The leaderboard sign-in is always the current one (OD-PL-1 (b)).
- **D-PL1D-2, Dismiss and Delete copy on the damaged-file notice. DECIDED (user, 2026-11-24).** Dismiss is remembered per kept copy name in `data\notices-dismissed.json` (names only), so a new damaged copy is shown again. Delete copy has an on-page confirm step (no browser dialogs). `POST /api/settings/notice` accepts only names matching `<settings|race|setup-meta>.json.unreadable-<digits>` that exist as files directly in `data\`, behind the existing foreign-request guard; a live file can never be named.
- OD-PL-8 and OD-PL-9 decided, see below.

## 2026-11-24: Platform plan PL2, quality checks

Decisions made in PL2 (`docs/platform/PL2-report.md`) and the open ones it raised.

- **D-PL2-1, no TypeScript or linter for now.** Evaluated with TypeScript 5.9.3 + `@types/node` 22 in a scratch folder (never installed in the repo): `tsc --noEmit --checkJs` on the PL1 data-safety modules found no defect. `src/sensitive.js`, `src/jsonfile.js`, `src/telcodec.js`, `src/restore-apply.js` and `src/analysis.js` were clean; `src/lapfile.js` (3) and `src/zip.js` (2) only had inference noise (number arrays seen as tuples, a spread argument); larger modules show many more of the same kind (`src/leaderboard.js` 62). The cost would be a devDependency plus JSDoc annotations to silence false positives, with no demonstrated benefit. `node --check` (`npm run check`) stays the only static check.
  - **Revisit:** when a module gets a typed public API worth pinning (e.g. PL4 provenance records, PL6 analysis results). Then use `// @ts-check` on that file only, run with a pinned `npx --yes -p typescript@<ver>` (as `npm run wrangler` does), not as a devDependency.
- **D-PL2-2, `npm audit`: assessed, no gate.** On 2026-11-24 a clean `npm ci` shows 0 vulnerabilities in runtime dependencies (`npm audit --omit=dev`) and 6 moderate in build tooling, all one advisory: `minimatch` ReDoS (GHSA-g3hv-75wg-m249) through `electron-builder` 26.18.0. It only runs at build time on the developer's own files, so it is not reachable by users. A blocking audit step would fail CI on advisories outside the project's control; review it at each release instead (CLAUDE.md release step 1 is the natural place, a user decision).
- **D-PL2-3, browser tests without Playwright.** The headless-Edge approach from P2–P9 (DevTools protocol) is enough: `test/browser.flows.js` drives it with Node's own `WebSocket` (Node ≥ 22.4, also in Electron's Node 24). No devDependency. Playwright would only be worth it for cross-browser runs or tracing, which nothing needs now.
- **D-PL2-4, the leaderboard's background work can be switched off.** `createLeaderboard({ background: false })` starts no timers, and `stop()` cancels the pending ones. The app keeps the default (`true`), so its behaviour is unchanged; tests use `false` and call `sync()` themselves (the flaky-test root cause, PL2 report).
- **OD-PL-8, Dependabot. DECIDED (user, 2026-11-24): (a) no Dependabot.** Options: (a) none (today); (b) `.github/dependabot.yml` with monthly, grouped updates for `npm` and `github-actions`, capped at 2 open PRs; (c) security updates only (a repository setting, no file).
  - **Conservative default:** (a). It only acts after a push and opens pull requests on the public repository, which is a user choice. (c) is the low-noise option if wanted.
- **OD-PL-9, CLAUDE.md release step 6 should also set `ACE_DIR`. DECIDED (user, 2026-11-24): yes.** Step 6 now says to use `npm run smoke:packaged`, or by hand to set `$env:ACE_DIR` to a scratch folder too (PL1D). The packaged smoke test showed that a started app installs the ACE UI App Loader and the Paddock HUD into `ACE_DIR` at once (`src/hudinstall.js` `startAuto`, called from `src/server.js:85`). Step 6 only sets `ACEVO_DATA`, so a manual smoke run writes into the real `Saved Games\ACE` (harmless when it holds the same versions, but not a scratch run). `npm run smoke:packaged` sets both. Proposed: step 6 says "run `npm run smoke:packaged`" or adds `$env:ACE_DIR = <scratch>\ACE`. CLAUDE.md is the user's file, so it was not changed.

## 2026-11-24: Platform plan PL3, recording performance

Decisions made in PL3 (`docs/platform/PL3-report.md`, numbers in `docs/platform/PERFORMANCE.md`) and the open ones it raised.

- **D-PL3-1, time slices on the main thread, no worker and no separate recording process.** The demonstrated stalls were CPU work on one thread (reading and resampling hundreds of laps for the HUD references, the Laps and Home pages and the session report). Running it in slices of about 8 ms (`src/service.js` `comboInfoAsync`, `runInSlices`) brings the longest hold of the 60 Hz loop from seconds to the cost of one lap save (~25 ms) with the same results and no new moving parts (a worker would need its own database connection, its own caches and a message protocol). A separate recording process is not needed on these numbers; it stays the last resort if real shared-memory timing (unverified here) shows otherwise.
- **D-PL3-2, per-lap corner and sector times kept in memory.** `src/service.js` keeps a few numbers per lap (time through each corner, at each sector line), keyed by lap id and the grid/corners they were measured on, up to 100,000 entries (a few MB). Lap data never changes once saved, so they stay valid; a different grid or corner set is a different key. Not persisted (no DB change in PL3, see OD-PL-11).
- **D-PL3-3, the HUD keeps its references while new ones load. CONFIRMED (user, 2026-11-25).** After a lap the HUD keeps the references it had for the same car and track until the new ones are ready (a few frames to a few seconds with a long history); on a new car or track it shows none until ready, as it does with no laps. Before, the 60 Hz loop stopped for that time instead (no telemetry read, no HUD update). A failed load shows no reference, is logged and counted in Diagnostics (`performance.errors.hudRefs`) and is tried again after the next lap. A new session on the same car and track keeps only the all-time references while loading: the previous session's best lap and sector bests are dropped at once (PL3 review fix).
- **D-PL3-4, timing numbers in Diagnostics. CONFIRMED (user, 2026-11-25).** `/api/diagnostics` gains a `performance` section and `/api/diagnostics/perf` returns it alone (a private GET behind the existing origin guard). Numbers only: histograms, counters, the route of slow requests (first two path parts, no query), memory once a minute for the last hour. Nothing is logged per sample.
- **OD-PL-10, compression level of saved laps. DECIDED (user, 2026-11-25): (a) keep gzip level 6.** Saving a lap (`JSON.stringify` + `gzip` level 6 + insert) takes ~21 ms for a 75 s mock lap, inside the 60 Hz tick (one missed frame); it scales with lap length (a 7-minute lap ≈ 5–6× that). Options: (a) keep level 6 (today); (b) gzip level 1 or 3 (measured on one mock lap: gzip alone 12.5 ms → 4.4 ms at level 1 with a 21 % larger blob, 5.7 ms at level 3 with 13 % larger; existing laps unchanged, both read the same way); (c) compress on the libuv thread pool (`zlib.gzip`) and insert when done (no CPU on the loop, but the lap reaches the database a few ms after the lap event, so code that reads it at once must wait).
  - **Conservative default:** (a), unchanged. It meets the PL3 budget (≤ 2 frames per lap end) for laps up to about 2 minutes; (c) is the candidate if real laps or slower PCs show more.
- **OD-PL-11, first open of the Laps and Home pages with a long history. DECIDED (user, 2026-11-25): (a) leave it for now.** The first time after a start, these pages work out every car and track (best, corners, ideal lap): ~8 s for 1,000 laps and ~30 s for 5,000 laps (seeded mock laps). Since PL3 the recording keeps running meanwhile; the page just waits. Options: (a) leave it (today, page waits once per app start); (b) store each lap's corner times in the database (a new table, versioned migration, filled lazily) so a start needs no full read; (c) work everything out in the background a few seconds after start (CPU for that long at each start, also when the driver does not open the pages).
  - **Conservative default:** (a). (b) is a DB change (migration + old-DB fixture test + backup path); (c) spends CPU at every start, possibly while driving.

## 2026-11-25: Platform plan PL4, compatibility and provenance

Made in PL4 without asking; **all confirmed by the user on 2026-11-25** (D-PL4-1 … 8):

- **D-PL4-1, three states over the existing four statuses.** `src/channels.js` keeps `status` (`verified`, `unverified`, `mismatch`; per session also `missing`) so existing pages and saved reports stay valid, and adds `state` with the plan's three classes: `verified`, `unverified`, `unsupported` (= marked as not matching: left out of analysis and AI). The built-in groups keep their development status on every game version (`core` and `trackLimits` verified, `gforce`, `slip`, `windows` unverified): making core telemetry unverified after each update would label every analysis unconfirmed.
- **D-PL4-2, a check is a record.** `settings.channelChecks[group] = {ok, game, adapter, at, method, car}`: the game version from the game's newest log (the same source as `laps.cond.game`; the shared-memory `evoVersion` field is not used, its offset is unverified), the reader (`shm r<PARSER_REV>` for shared memory, `hud <installed version>` for aids and assists), time, method, and the car only for groups whose meaning depends on it (OD-PL-14). Old booleans are rewritten as legacy records once at start (`channels.migrate`). Keys of groups this Paddock does not know are kept as they are (review). Downgrade: Paddock 0.7 and older read every record as "not checked", so there a "does not match" is shown as unconfirmed instead of left out (review: documented, no boolean mirror). No database change: checks live in `settings.json` (non-sensitive, already in backups).
- **D-PL4-3, a "does not match" stays on every version.** It is the cautious state (the readings are left out); after an update it is flagged for a new look and the driver can undo it.
- **D-PL4-4, `PARSER_REV` and `OFFSETS_HASH`.** `test/channels-version.test.js` fails when `src/shm.js` OFFSETS change without a new revision, so a layout fix always invalidates the checks made with the old layout.
- **D-PL4-5, new laps record their reader.** `laps.cond.reader` (`shm r1`) is added next to `game` and `app` (JSON column, no schema change). It is not sent to the leaderboard (the upload lists its fields explicitly). It does go into exported `.lap.gz` files with the rest of `cond` (`src/lapfile.js` exports the lap row): a revision label, no identity.
- **D-PL4-6, data marked as wrong is removed from AI prompts.** The debrief, coach and setup engineer sent setup names and temperatures even when the driver had marked them as not matching (their `data_quality` said "left out"). They are now removed.
- **D-PL4-7, the health panel only shows what Paddock already knows.** No new request to the leaderboard, GitHub or the game; online state is the leaderboard's and the update check's last result. It lives on the Game page (`#gHealth`) and in the Ctrl+K palette ("Integration health"); no new sidebar entry (OD-PL-17).
- **D-PL4-8, session types use the app's names** (`public/util.js` `SESSION_TYPES`: time attack, race, hot stint, cruise).
- **D-PL4-9, no "matches" without a version (review).** While the game version (or, for aids and assists, the installed HUD) is not known, "Matches the game" / "Still matches" is refused (409) and Setups shows why; before, such a check was stored and could never count. "Doesn't match" is always recorded (cautious state).
- **D-PL4-10, unconfirmed is not a match (review).** In comparisons, temperatures within 5 °C and the same aids count as matched only when their readings are checked against the game; otherwise they are a caveat ("Similar temperatures, not confirmed", "Same driving aids, not confirmed"). Groups marked as wrong are ignored by the Mixed laps note and dropped from every AI input (setup history temperatures included).
- **D-PL4-12, one combined line for readings not confirmed yet. DECIDED (user, 2026-11-25).** On both compare tabs (Telemetry and Racing line) the caveats that only say a reading is not checked against the game yet (temperatures, driving aids, setup recognition: `item.unconfirmed` in `src/compat.js`) are shown as one line, "Some readings aren't confirmed yet: …", with a link to Setups → Setup recognition, instead of one caveat each. Strictness unchanged: they never count as a match and the compatibility level stays the same. Real differences stay separate lines.
- **D-PL4-11, error texts on the health panel lose folder paths (review)**, and `/api/health` is a private GET like Diagnostics.

Decided by the user on 2026-11-25 (OD-PL-12 … 17 as built, OD-PL-18 changed to (b)):

- **OD-PL-12, checks made before PL4 (game version not recorded). DECIDED (user, 2026-11-25): (a).** Options: (a) they no longer count; Setups shows "checked before Paddock recorded the game version" with a one-click **Still matches** (today, conservative); (b) keep them verified, labelled "game version not known"; (c) stamp them with the game version found at the first start after the update.
  - **Default:** (a). The plan says unknown provenance is treated as unverified. Effect: a driver who checked groups before sees them as unconfirmed again until one click each.
- **OD-PL-13, what makes a check stale. DECIDED (user, 2026-11-25): (a).** Options: (a) any change of the game version string, of the shared-memory layout revision, or of the installed HUD version for aids and assists (today); (b) only reader changes (a game update keeps checks); (c) only major.minor game versions, and a separate HUD "aids protocol" revision instead of the HUD version.
  - **Default:** (a). Most cautious; it asks for a re-check after every AC EVO update and every HUD update.
- **OD-PL-14, groups checked per car. DECIDED (user, 2026-11-25): (a).** Options: (a) suspension (some cars' displays show it, others not) and driving aids (levels differ per car) count only for the car they were checked with (today); (b) no group per car; (c) every checkable group per car.
  - **Default:** (a).
- **OD-PL-15, how strict comparison caveats are. DECIDED (user, 2026-11-25): (a).** Today: temperatures more than 5 °C apart (track or air) differ; anything not recorded for either lap becomes one "Not recorded" caveat (old laps, imports and mock laps almost always show it); a setup recognised as the same counts as a caveat while setup recognition is not checked against the game. Options: (a) as today; (b) quieter: no caveat for factors Paddock did not record at the time (laps before 0.7), unconfirmed recognition counts as the same setup; (c) a different temperature limit.
  - **Default:** (a). The plan says unknown never counts as a match.
- **OD-PL-16, what is incompatible. DECIDED (user, 2026-11-25): (a).** The gate applies to the Telemetry and the Racing line replay tab alike (review). Today only another car or another track layout; the page asks before showing it ("Compare anyway", remembered until the page is left). Laps of other drivers (imports, online) are not a caveat by themselves. Options: (a) as today; (b) also a caveat "another driver's lap"; (c) remember "Compare anyway" per pair across visits.
  - **Default:** (a).
- **OD-PL-17, where the health panel lives. DECIDED (user, 2026-11-25): (a).** Options: (a) a card on the Game page plus a palette entry (today); (b) its own page in the sidebar; (c) also a summary line on Home when something is not OK (Home already lists several of the same warnings).
  - **Default:** (a), the smallest change to the shell.
- **OD-PL-18, the "Mixed laps" note on Consistency and Progress. DECIDED (user, 2026-11-25): (b), implemented in the review round.** The note appears only when recorded values differ (game versions, setups, aids); what is not recorded is no longer shown there. It lists what varies between the laps (game versions, setups, aids) and what is not recorded for some of them; with a history from before 0.7 it shows on almost every combo. Options: (a) show it, closed (today); (b) show it only when recorded values differ; (c) let the page filter to like-for-like laps (more work, PL6).
  - **Default:** (a).

## 2026-11-25: Platform plan PL5, onboarding and usability

Made in PL5 without asking; **D-PL5-1 … 14 confirmed by the user on 2026-11-25** (D-PL5-5 and -6 as changed by OD-PL-24 (c) and OD-PL-22 (b)):

- **D-PL5-1, schema v2 is additive and versioned.** `session_notes`, `session_tags`, `corner_bookmarks`; `PRAGMA user_version = 2` set in the same transaction as the tables. Before upgrading a database that has any user rows (laps, goals, coach messages…; review), one `VACUUM INTO` copy is kept (`telemetry.backup-v<old>-<time>.db`, the v1 mechanism; one copy per start, so a v0 file upgraded straight to v2 gets one copy). If that copy cannot be made (full disk), the upgrade still runs and logs why: it only adds empty tables. Paddock 0.7's `src/db.js` opens a v2 file and ignores the new tables (checked by hand; a test checks that no existing table changed).
- **D-PL5-2, input limits, refused rather than cut:** note 4000 characters, 12 tags of at most 32 characters, corner name 60, bookmark note 280, 60 bookmarks per session (400 with a plain message; the page's fields have the same `maxlength`). Control characters are dropped (line breaks kept in notes). Tags are stored in lower case, without a leading `#`, with single spaces.
- **D-PL5-3, notes are local.** Not in lap files (`src/lapfile.js` exports lap rows only), not in leaderboard uploads, not in any AI prompt, not in Diagnostics (counts only). `/api/notes*` and `/api/onboarding` are private GETs (refused cross-site). They are in Settings backups because the backup copies the whole database (OD-PL-20).
- **D-PL5-4, a bookmark belongs to a track + layout + car** (the game's names, as laps) and remembers the session it was made in; it is listed on every later session page of that combo. Any corner name can be typed; the report's corner names are suggested.
- **D-PL5-5, where the guide is offered:** Home and Sessions while there are no laps, Settings and Ctrl+K. *Superseded by OD-PL-24 (c):* it never opens by itself (the first build opened it for a new driver).
- **D-PL5-6, skipping a guide step records the choice** (`settings.onboarding.skipped`); skipping AI or online changes no setting. *Changed by OD-PL-22 (b):* skipping game mods also switches off the automatic HUD and App Loader install, and Undo switches it on again. "Skip the guide" stores `dismissed`; Finish or opening the suggested comparison stores `done`.
- **D-PL5-7, one next step on Home, from the last session's car and track only,** by fixed rules (no report and too short → drive 3+ laps; long enough but never opened → open its report; weakest corners and a faster ideal lap → compare best with ideal at the weakest corner; a faster ideal lap → compare; else Progress). The "Why" text quotes stored values only. It is a normal button: the lime action stays "Set up a session".
- **D-PL5-8, practice objective order:** an open goal or challenge on the last car and track → its training plan → its newest report targets → any open goal.
- **D-PL5-9, recent progress:** over 30 days, a car and track counts as a new personal best only if it had valid laps before the window (a first visit is not progress).
- **D-PL5-10, colour tokens changed for contrast** (WCAG AA 4.5:1 for text on the page and panels; `test/a11y.test.js` reads them from `style.css`): dark `--text-muted` #757d7a → #8a918e, `--critical` #ff4757 → #ff505f; light `--text-muted` #7b8288 → #666c71, `--t-pb`/`--good` → #0f7c43, `--t-slow`/`--warning` → #896600, `--faster` → #256bbe, `--slower` → #bf3d3c, new light `--critical` #bf3d3c, `--mod` → #0d786e, `--accent-text` #4e7d00 → #477300. Fields get a 1 px focus ring on top of the border colour.
- **D-PL5-11, text size = the browser's / desktop app's own zoom** (Ctrl + / − / 0, already wired in `desktop/main.cjs`), now listed under `?` and in Settings; no separate setting. Reflow is tested at 200 % (700 px wide).
- **D-PL5-12, palette:** new kinds Tag and Bookmark, a "Setup guide" page and command; a first word that names a kind falls back to plain text when that kind has no match ("setup guide"); the empty list shows every page and the 6 newest sessions (the fixed 14-item cut hid sessions since PL4 added a 14th page).
- **D-PL5-13, the notes card is closed by default** (its summary shows tags, the note's first line and the bookmark count) and opens from Home's "Add a note" link; it saves 0.9 s after typing stops, on tag changes, with Save / Ctrl+Enter, and when the page is left.
- **D-PL5-14, empty states** on Sessions, Progress, Coach and Setup history say what to do, with a button; the Sessions empty state no longer suggests `npm run seed` / `npm run mock` (developer commands) but the guide and Integration health. Error cards link to Home and Integration health.

- **D-PL5-15, notes of a session go with its last lap. DECIDED (user, 2026-11-25).** When the last lap of a session is deleted, its notes, tags and corner bookmarks are deleted in the same transaction (`src/db.js` `deleteLap`); rows left by sessions without laps (from before this fix) are removed once at each start, in one transaction. Sessions themselves are never deleted.
- **D-PL5-16, a database from a newer Paddock is left untouched (review).** `user_version` above `SCHEMA_VERSION` (2): the version is read before any other statement, the file is closed again and Paddock runs on an empty in-memory database (nothing is saved, nothing written to the file, no WAL switch). Home (Needs attention) and Integration health (Recording: Not working) say a newer Paddock made it and what to do; backups and restores are refused (409). Restores compare a backup's database with `SCHEMA_VERSION`, not the live file's version.
- **D-PL5-17, notes stay private on every route (review).** `/api/overview` and `/api/dashboard` (they carry tags and note first lines) are private GETs like `/api/notes`; note and bookmark POST bodies are capped at 64 KB; a tag list longer than twice the limit is refused before it is cleaned.
- **D-PL5-18, Settings → In-game HUD (OD-PL-22 (b)).** A checkbox for the automatic install of the HUD and the App Loader. It and the guide's skip use the existing `data/hud-removed` / `data/loader-removed` flags (the Mods tab's and tray's Remove), no new setting. Off installs and updates nothing (also not an outdated HUD); files already in the game folder stay until removed in the Mods tab. Existing installs keep the automatic install unless the driver turns it off. Health says "switched off (Mods tab or setup guide)".
- **D-PL5-19, recording is off on a newer database. DECIDED (user, 2026-11-25).** With `user_version` above `SCHEMA_VERSION` the file stays untouched (D-PL5-16) and recording is switched off: the 60 Hz loop only notes that the game is there (status `recording off`); the recorder, setup tracker, leaderboard, HUD references, brake marks and spotter get no frames, and the recorder never inserts a lap. Home, Integration health (Recording: "Recording is off: your data was made by a newer Paddock. Install that newer version to record.") and the sidebar status say so. Settings and the other pages stay usable.

Open in the first build; decided by the user on 2026-11-25:

- **OD-PL-19, notes in lap exports. DECIDED (user, 2026-11-25): (a).** Options: (a) never (built); (b) an opt-in "include my notes" on export; (c) always.
  - **Default:** (a). Lap files are made to be shared.
- **OD-PL-20, notes in Settings backups. DECIDED (user, 2026-11-25): (a).** Options: (a) yes, as part of the database copy (built); (b) left out (needs a filtered database copy); (c) a separate backup part.
  - **Default:** (a). Backups are the driver's own local files and the recovery path for notes.
- **OD-PL-21, the copy before an additive upgrade. DECIDED (user, 2026-11-25): (a).** Options: (a) a full copy before v2, as the plan's migration rule says (built; costs disk space equal to the database once, kept until deleted by hand); (b) no copy for upgrades that only add tables; (c) a copy that Paddock deletes after a few good starts.
  - **Default:** (a).
- **OD-PL-22, skipping "game mods" in the guide. DECIDED (user, 2026-11-25): (b), implemented (D-PL5-18).** Options: (a) records the choice only; the HUD and App Loader are still installed while the game is closed, the step says so and links to Mods (built); (b) skipping also turns the HUD off (the Mods tab's "removed" state), so nothing is put into the game folder.
  - **Default:** (a). No behaviour changes from a guide click.
- **OD-PL-23, a beginner / advanced presentation. DECIDED (user, 2026-11-25): (a), not now.** Options: (a) not now (built); (b) an off-by-default "Simple view" that hides Leaderboards, Setups, Mods and the Telemetry debug from the sidebar (Alt+digit and Ctrl+K unchanged); (c) per-page "more detail" sections.
  - **Default:** (a). Assessment in `docs/platform/PL5-report.md`.
- **OD-PL-24, when the guide opens by itself. DECIDED (user, 2026-11-25): (c), implemented: never by itself.** Options: (a) only for a new driver (built, D-PL5-5); (b) also once after an update, as a "what's new" page; (c) never by itself, only offered.
  - **Default:** (a).

## 2026-11-25: Platform plan PL6, actionable lap analysis

Made in PL6 without asking; **D-PL6-1 … 9 confirmed by the user on 2026-11-25** (D-PL6-8 as corrected in the review round):

- **D-PL6-1, one new page, not a new sidebar entry.** `#/analysis?combo=…` ("Lap analysis") sits under Sessions in the navigation; it is reached from the Sessions page's car + track row (**Analysis**), the Consistency page (**Lap analysis**) and Ctrl+K (kind "Analysis"). Compare, Consistency and Progress are unchanged apart from that button.
- **D-PL6-2, own valid local laps only,** as the ideal lap: imported, online and invalid laps are never analysed.
- **D-PL6-3, the anchor is the newest valid lap.** Laps `incompatible` with it (PL4) are left out and listed with the reason; laps with caveats are used and the mix is labelled (`compat.mix`). Trends and the PB explanation use every lap of the filtered set, not only the window.
- **D-PL6-4, "faster passes" = the quickest quarter** (passes at or under the first quartile), compared by medians with all passes; findings never rest on a single pass (except the PB explanation, which says so).
- **D-PL6-5, phases are fixed distances**: entry / apex / exit split 25 m either side of the best lap's slowest point (`APEX_HALF_M`), the same grid points for every lap.
- **D-PL6-6, throttle hesitation is a new technique metric** (`holdMs`, `src/analysis.js` `TECHNIQUE`), so it also appears in the Consistency page's technique table and spread chart. Session reports are unchanged (report version stays 2; their style notes do not use it).
- **D-PL6-7, uncertainty as words and ranges:** gains to 0.01 s with "up to" the fastest-pass gain, the median's interval (1.58 × IQR / √n) on every corner, the target lap ± its interval to 0.1 s, and a confidence word by sample size; trends say "faster" / "slower" only when the first and latest sessions' median intervals do not overlap.
- **D-PL6-8, channel limits are said, not guessed (corrected in review):** the brake channel is called the pedal position (no pressure reading); laps driven with the automatic gearbox (`laps.aids.assists.gearbox`, from the Paddock HUD) are left out of gear comparisons, and laps whose gearbox setting was not recorded (or whose assist readings are marked as wrong) are used but labelled; a top card with a braking or gear finding carries the matching caveat; laps without gear (or pedal) data are left out of what needs it; the whole page is off when the core readings are marked as wrong. (The first text said Paddock does not record the gearbox setting: wrong, it does.)
- **D-PL6-9, no DB change:** per-lap numbers live in the PL3 in-memory lap-points cache; nothing is stored, so no migration.

Operator decisions, **all DECIDED (user, 2026-11-25): (a)**, as built:

- **OD-PL-25, which laps by default. DECIDED (user, 2026-11-25): (a).** Options: (a) the newest 30 valid laps (built); (b) all valid laps; (c) the last session only. A selector offers "All valid laps"; the trend always uses every session.
- **OD-PL-26, minimum samples and confidence words. DECIDED (user, 2026-11-25): (a).** Options: (a) 5 passes before anything is concluded about a corner, confidence low 5–9 / medium 10–19 / high 20+; gear groups 3 passes; trends 3 sessions of 3 or more valid laps, newest 10 (built); (b) stricter: 8 passes, high from 30; (c) looser: 3 passes (the session report's style minimum).
- **OD-PL-27, what "realistic gain" and the target lap mean. DECIDED (user, 2026-11-25): (a) the quickest quarter.** Options: (a) the first quartile: what you already reach in 1 pass out of 4 (built); (b) the median of your 3 fastest passes; (c) your fastest pass (= the ideal; shown as "up to" anyway).
- **OD-PL-28, the smallest gain listed as an opportunity. DECIDED (user, 2026-11-25): (a) 30 ms.** Options: (a) 30 ms (built); (b) 50 ms; (c) none: rank every corner.
- **OD-PL-29, thresholds for naming a difference. DECIDED (user, 2026-11-25): (a) fixed thresholds.** Options: (a) fixed levels, the session report's where they exist (5 m braking, 2 km/h apex, 8 m throttle, 3 km/h exit, 150 ms to full throttle) and new ones (5 m brake off, 100 ms / 25 % release time, 150 ms hesitation) (built); (b) scaled with each corner's own spread; (c) per car class.
- **OD-PL-30, interpretation sentences. DECIDED (user, 2026-11-25): (a) shown, hedged.** Options: (a) shown by default as "What it may mean", apart from "What was measured", always worded as a possibility, with the causation note (built); (b) hidden behind a "possible causes" toggle; (c) not shown: observations only.
- **OD-PL-31, Home's next step and the opportunities. DECIDED (user, 2026-11-25): (a) Home unchanged.** Options: (a) not now: `nextStep` unchanged (built; the analysis reads full traces and runs only on demand); (b) a new rule "work on the top opportunity" when an analysis is already kept in memory; (c) work the analysis out in the background after each session and feed `nextStep` (and PL7 practice).

**PL6 review round (2026-11-25)**, fixes made without a new product choice:

- **D-PL6-10, a gear finding needs a clear gear on both sides:** at least 3 passes (`gearGroupMin`) in the most used gear of the typical passes and of the quicker quarter, and no tie; otherwise no gear finding.
- **D-PL6-11, "same setup" follows setup recognition as `compat.classify` does:** pit-box readings marked as wrong = every setup unknown, so the filter is not applied and the page says so; not checked yet = applied and labelled.
- **D-PL6-12, a trend needs a minimum change:** "faster" / "slower" only when the first and latest sessions' median intervals do not overlap **and** the change is at least 100 ms (lap) or 30 ms (corner) (`RULES.trendMinMs`).
- **D-PL6-13, numbers shown only as precise as they are:** median intervals only for corners with 5 or more passes; counts (brake re-applications, re-lifts) as whole numbers (the median rounded down); the target lap's ± is a rough range from each corner's first-quartile interval (distribution-free, from the order of its passes), labelled "rough".
- **D-PL6-14, no stale analysis:** a run during which the car + track's laps changed is worked out again before it answers (up to 3 times); what the core, setup and assist readings are worth is part of the cache key, so a changed check gives a new result. `/api/analysis` is a private GET (refused cross-site).

## 2026-11-25: Platform plan PL7, structured practice

Made in PL7 without asking (rules in `docs/platform/PRACTICE.md`); **D-PL7-1 … 7 confirmed by the user on 2026-11-25**:

- **D-PL7-1, drills are P9 goals:** a `goals` row of kind `drill` (prescription in `extra`, `met_*` when met) plus a new `drill_events` table (schema v3, one pre-upgrade copy). The P9 goal lists, Home, achievements, suggestions and the session planner ignore drills (`src/goals.js` `goalsOnly`); the P8 training plan is unchanged.
- **D-PL7-2, target from recent repeatability:** the quicker quarter's median of the metric in the newest 30 valid laps; tolerance half of the analysis's naming threshold (`RULES.diff`), so a pass must close at least half the gap; counts aim at 0, gears at the quicker passes' clear gear. Refused when half of the "before" passes already reach it.
- **D-PL7-3, drills only from ranked opportunities and from the default analysis view** (newest laps, any game version or setup), so the server can look the finding up again; numbers are never taken from the request.
- **D-PL7-4, the corner is found again by its apex** (within 40 m) when the best lap and its corner list change; otherwise "cannot be checked".
- **D-PL7-5, the corner time is context, not the criterion:** before → now with the analysis-trend rule (intervals apart and ≥ 30 ms).
- **D-PL7-6, "Renew target from my latest laps"** at a review point = a new drill on the same corner and behaviour from the newest analysis, replacing the old one; **Delete** removes a drill and its history; the newest 30 drills are listed.
- **D-PL7-7, wording:** "Practise this", "Practice drills", the six labelled parts (Observed issue, Evidence, Exercise, Success when, Minimum evidence, Review point) plus "Why it may help … (a possibility, not a proven cause)".

Operator decisions, **all DECIDED (user, 2026-11-25): (a)**, as built:

- **OD-PL-32, the success criterion. DECIDED (user, 2026-11-25): (a).** Options: (a) at least half of the newest 10 passes reach the target, judged from 5 passes (built); (b) the median of every pass since the start; (c) stricter: 70 % of the newest 10.
- **OD-PL-33, the review point. DECIDED (user, 2026-11-25): (a).** Options: (a) after 10 passes without meeting it, with Keep practising / Renew target / Stop (built); (b) at the end of each session; (c) after 20 passes.
- **OD-PL-34, laps on another game version. DECIDED (user, 2026-11-25): (a).** Options: (a) left out of the drill and its "before" (built; since the review round a lap whose version was not recorded is left out too, D-PL7-9); (b) counted with a caveat.
- **OD-PL-35, how many drills at a time. DECIDED (user, 2026-11-25): (a).** Options: (a) one active drill per car + track; a new one asks to replace it (built); (b) up to three per car + track; (c) one overall.
- **OD-PL-36, where drills are offered. DECIDED (user, 2026-11-25): (a).** Options: (a) "Practise this" next to the findings of the top three Lap analysis cards only (built); (b) also in every ranked corner's details; (c) Paddock proposes one drill by itself (still started by the driver).
- **OD-PL-37, Home and achievements. DECIDED (user, 2026-11-25): (a).** Options: (a) unchanged: drills are not goals for Home's objective, next step (OD-PL-31), goal lists or the goal achievements (built); (b) the active drill becomes Home's practice objective; (c) met drills count for the Goals achievements.
- **OD-PL-38, when a met drill counts as slipping. DECIDED (user, 2026-11-25): (a).** Options: (a) fewer than 25 % of the newest 10 passes (at least 5) after it was met reach the target (built); (b) fewer than 50 %; (c) no revisit suggestions.
- **OD-PL-39, corner mastery labels. DECIDED (user, 2026-11-25): (a).** Options: (a) Not enough passes / Time to find / Practising / Revisit / Steady, no "mastered" (built); (b) add "Mastered" for a steady corner with high confidence and a met drill; (c) no mastery badges.
- **OD-PL-40, AI and drills. DECIDED (user, 2026-11-25): (a).** Options: (a) no AI in the practice loop; drills are not sent to the AI coach (built); (b) the coach context gets the active drill's prescription and numbers, listed under "What is sent" before anything is sent (no new provider).
- **OD-PL-41, when drills are worked out. DECIDED (user, 2026-11-25): (a).** Options: (a) on demand, when Development or Lap analysis opens; the met time is the pass's own time (built); (b) also after each lap in the background, with a "drill met" notice while driving.

**PL7 review round (2026-11-25)**, fixes made without a new product choice:

- **D-PL7-8, a drill follows its corner by where it is:** corner names are positions (`T1`, `T2` … from the start line, `src/analysis.js` `detectCorners`), so a new best lap with one more corner renames the ones after it. A drill keeps the apex distance of its corner and is matched to the current corners by apex (within 40 m) everywhere: its passes, the name shown ("T3 (T2 when the drill started)"), mastery, "your drill", superseded drills and Renew / Practise again. A corner not found any more shows its old name and cannot be renewed.
- **D-PL7-9, unknown game version never matches (OD-PL-34 applied strictly):** a lap without a recorded version counts neither in the "before" nor in the drill; how many analysed laps were left out is written in the evidence; a drill cannot be made when the newest lap has no version.
- **D-PL7-10, safe against an older Paddock:** Paddock 0.7.0 has no newer-database guard; it can delete a drill's goals row and leave its events, and goals ids are reused. Events of goals that are gone are removed at every start, and a new drill's id starts with no events.
- **D-PL7-11, "met" is recorded in turn with Stop, Keep and new drills** (one queue), so a drill is never both met and stopped.
- **D-PL7-12, sample sizes beside the shares:** before → after reads "33 % of 12 passes before → 100 % of 5 after".
- **D-PL7-13, saying why a drill cannot be made. DECIDED (user, 2026-11-25).** The strict rule stays (laps without a recorded game version never count). When the newest lap has no recorded version, **Practise this** (Lap analysis) and **Renew target** / **Practise again** (drill cards) are disabled, with the visible reason "This lap has no recorded game version, so a drill can't be checked" (referenced by the control's `aria-describedby`) and a link to Integration health on the Game page. `GET /api/practice` returns `ready` for a car + track and `versionOk` per drill (`src/drills.js` `versionReady`).

## 2026-11-25: Platform plan PL8, controlled setup experiments

Rules and limits: `docs/platform/EXPERIMENTS.md`. The user asked (2026-11-25) not to wait on any decision: each product choice beyond the plan below is **OPEN (operator), recommended default applied, user reviews in the app**, with the options and the default that was built.

Made in PL8 without asking (implementation choices):

- **D-PL8-1, experiments get their own tables (schema v4):** `setup_experiments` (status, parent, JSON data) and `experiment_entries` (journal, feedback, events), versioned upgrade with one pre-upgrade copy, `test/fixtures/db-v3-pl7.sql`; newer-database guard tests move to `user_version` 5. Not stored as P9 goals: an experiment has two setups, stints and a journal, which goals rows do not fit.
- **D-PL8-2, built on the P7 setup history, read-only towards setups:** A and B come from `setuphistory.history` and `setupmatch.candidates` (this car + track), identified by file path and the hash of their values (the setup snapshot recipe); experiments never write a `.carsetup` file and never touch the running game.
- **D-PL8-3, setup ancestry in `data/setup-meta.json`:** saving a setup from another one (or copying it to another track) now records the parent's path (`basedOnRel`, `basedOnTrack`) beside the existing `basedOn` name; renames carry it over. The `.carsetup` bytes are unchanged (import/export tested byte-identical). Older saves name their parent only, so a chain ends there.
- **D-PL8-4, statistics:** median, IQR and the median's ~95 % interval per setup (PL6 `src/stats.js`), the difference of medians plus the Hodges–Lehmann shift, "apart" = non-overlapping intervals; Theil–Sen for the learning confound. The best lap is shown, labelled as not used.
- **D-PL8-5, the result is saved at review** (with the lap ids, times and reasons), so it stays readable when laps are deleted later; the page says when the laps changed since. Reopening drops it (the journal keeps a line).
- **D-PL8-6, the matched-condition filter reuses `compat.classify`** against the experiment's typical conditions, ignoring setup and game version (checked separately); only certain differences leave a lap out (an "unconfirmed" caveat never does).
- **D-PL8-7, AI:** experiments are not sent to the AI setup engineer or coach (no new data leaves the PC); the P7 `by_setup` input is unchanged.
- **D-PL8-8, wording:** "Inconclusive" is a first-class result with its reason; "A difference … suggests, but does not prove, that the setup caused it"; "Paddock never loads a setup into the game" on every experiment page.

Operator decisions, **all OPEN (operator), recommended default applied, user reviews in the app**:

- **OD-PL-42, how laps are assigned to A and B. OPEN (operator), recommended default applied, user reviews in the app.** Options: (a) by stints the driver starts and ends in Paddock or by past sessions, with setup recognition used only to leave out laps it puts on the other setup (built); (b) by setup recognition alone (no stints); (c) by stints only, recognition ignored.
- **OD-PL-43, the default stint plan. OPEN (operator), recommended default applied, user reviews in the app.** Options: (a) ABBA, 6 laps a stint, the first lap of each stint left out as warm-up (built; ABAB, ABA and AB selectable); (b) ABAB; (c) AB with 10 laps a stint.
- **OD-PL-44, the evidence needed for "A difference". OPEN (operator), recommended default applied, user reviews in the app.** Options: (a) at least 5 counted laps per setup, non-overlapping median intervals, and each setup in at least 2 stints (built); (b) the same without the 2-stint rule (one stint each can show a difference, with the order confound in bold); (c) stricter: 8 laps per setup.
- **OD-PL-45, slow laps. OPEN (operator), recommended default applied, user reviews in the app.** Options: (a) a lap more than 3 % slower than its setup's typical lap is left out as "traffic, a mistake or an off" (built); (b) the setup history's rule, within 7 % of the best lap; (c) no slow-lap rule (spreads carry them).
- **OD-PL-46, matched conditions. OPEN (operator), recommended default applied, user reviews in the app.** Options: (a) on by default, per experiment switchable: other temperatures (> 5 °C), weather, grip, aids or session type left out when certain (built); (b) off by default, differences only listed; (c) on, and laps with unknown conditions left out too.
- **OD-PL-47, laps in a stint with no recognised setup (Standard or not recorded). OPEN (operator), recommended default applied, user reviews in the app.** Options: (a) counted by the stint and shown as "counted by stint only" (built); (b) left out.
- **OD-PL-48, one running stint at a time. OPEN (operator), recommended default applied, user reviews in the app.** Options: (a) one running stint per car + track across all experiments (built: a lap can only belong to one experiment's live stint); (b) one per experiment.
- **OD-PL-49, game updates. OPEN (operator), recommended default applied, user reviews in the app.** Options: (a) an experiment keeps its game version (at creation, else its first lap's); laps on another or an unknown version are left out; a warning suggests a follow-up experiment on the new version (built); (b) count them with a caveat.
- **OD-PL-50, review and decision. OPEN (operator), recommended default applied, user reviews in the app.** Options: (a) the driver saves the result with a decision (Keep A, Keep B, Test again, No decision) and a conclusion; Paddock never decides or changes a setup by itself (built); (b) Paddock proposes the decision from the result.
- **OD-PL-51, where experiments live. OPEN (operator), recommended default applied, user reviews in the app.** Options: (a) own pages `#/experiments` and `#/experiment` under Setups in the sidebar, a card on Setup history, Ctrl+K entries (built); (b) a section on Development; (c) a tab on the Setups page.
- **OD-PL-52, which setups an experiment can use. OPEN (operator), recommended default applied, user reviews in the app.** Options: (a) this track's only (setups driven here and this car's saved files for this track), plus a named Standard; other tracks' setups are copied in Setups first, which records the ancestry (built); (b) any setup of the car.
- **OD-PL-53, deleting. OPEN (operator), recommended default applied, user reviews in the app.** Options: (a) Delete only from the archive, with a confirmation; laps and setup files are never touched (built); (b) delete from any state.

**PL8 review round (2026-11-25)**, fixes made without a new product choice unless marked:

- **D-PL8-9, a floor on the median interval:** each setup's interval counts as at least ±50 ms (`RULES.minCiMs`): identical or millisecond-resolution lap times give an IQR of 0, which made a 1 ms gap "beyond the noise".
- **D-PL8-10, stints never overlap:** a session whose laps lie in a stint's time window, and a new stint while another window ends after now, are refused with the stint named; `assign` gives each lap to one stint only (a session stint keeps its session's laps, windows take laps of other sessions, oldest window first), whatever the stint order.
- **D-PL8-11, warm-up per run:** the warm-up laps are left out at the start of every run inside a stint: a new session (game or Paddock restarted) or a pause of 5 minutes or more (`RULES.segmentGapMs`).
- **D-PL8-12, own keys only:** patterns, measures, directions, phases, balances, decisions and setups (A/B) from a request are checked as own keys (`Object.hasOwn`), so `constructor` or `toString` are refused or fall back to the default.
- **D-PL8-13, an empty stint is not driven:** a finished stint without laps (deleted, or ended before a lap) is listed with "no laps" and does not count towards the plan.
- **D-PL8-14, a real `.carsetup` round trip in the tests:** `src/setups.js` `useCatalogs` lets tests supply a car and track catalogue; import → file → export → copy to another track are byte-identical.
- **OD-PL-46 refinement, laps without recorded conditions. OPEN (operator), recommended default applied, user reviews in the app.** When more than half of either setup's counted laps have no recorded conditions (no temperature, weather or grip), the result is "Inconclusive" with that reason in the verdict itself, never a clean "difference". Options: (a) inconclusive, reason in the verdict (built); (b) "difference" with the missing conditions as a bold confound; (c) leave those laps out.

## PL9: HUD and live assistance (2026-11-25)

Made without asking (technical or within the plan; the user may still object):

- **D-PL9-1, the bridge protocol is unchanged.** Same slot files, 8 slots, 50 ms windows, writer 4 windows ahead, 20 ms read phase, same log tags. PL9 only adds writer-side counters and a back-off (OD-PL-60); audit and stress results in `docs/platform/HUD_BRIDGE.md`.
- **D-PL9-2, nothing is counted down from stale data.** With telemetry stale (OD-PL-59) Paddock sends no `cue` / `ahead` and the spotter says nothing; the HUD draws no countdown from data over 1 s old and stops extrapolating the lap clock and delta.
- **D-PL9-3, brake-mark beeps are not cues.** With the kill switch on, the mark / recording confirmation beeps still play: they answer a button the driver pressed.
- **D-PL9-4, older HUDs and the kill switch.** Paddock sends only `{off: true}`, the look and the launch order: HUD 0.15.0 hides; an older HUD (≤ 0.14.0) shows an empty strip with no cue until Paddock updates it with the game closed.
- **D-PL9-5, HUD 0.15.0.** The HUD changed, so its version is bumped. Under OD-PL-13 (a) (decided) the aids and assists checks made with HUD 0.14.0 need to be confirmed again once 0.15.0 is installed; the aids reading code is unchanged.
- **D-PL9-6, the kill switch has its own route** (`POST /api/assist`, Paddock's pages only): it acts in memory first, so it works even when `settings.json` cannot be saved; `/api/settings` ignores `assistOff` and `hudLayouts` (layouts go through `/api/hudlayouts`, checked there).
- **D-PL9-7, a layout is parts, size and background only;** the cue result time is not part of it.
- **D-PL9-8, the spotter's Test button** ignores the kill switch and the quiet time (the driver asked for it).
- **D-PL9-9, the HUD does not show the active drill or the running experiment stint** (optional in the backlog): not built, to keep the payload and the strip unchanged; drills stay checked when pages open (OD-PL-41).

Operator decisions, **all OPEN (operator), recommended default applied, user reviews in the app**:

- **OD-PL-54, context profiles. OPEN (operator), recommended default applied, user reviews in the app.** Options: (a) off by default; when switched on, the layout chosen for a session type (time attack, race, hot stint, cruise; or "keep the current look") is applied when such a session starts (built); (b) on by default with Race → "Race"; (c) profiles by car class or track as well.
- **OD-PL-55, post-lap summary. OPEN (operator), recommended default applied, user reviews in the app.** Options: (a) a HUD part, off by default: lap time, the difference to the reference in use, the corner that gained most and the one that lost most, shown 8 s (built); (b) on by default; (c) also spoken by the spotter.
- **OD-PL-56, live consistency. OPEN (operator), recommended default applied, user reviews in the app.** PL6 supports lap-time distributions with a 5-sample minimum and confidence words; per-corner live consistency would rest on thresholds tuned on synthetic laps only. Options: (a) a HUD part, off by default: the spread (IQR) of this session's valid lap times from 5 laps on, with the PL6 confidence word, lap times only (built); (b) not at all; (c) per-corner spread live.
- **OD-PL-57, the kill switch survives a restart. OPEN (operator), recommended default applied, user reviews in the app.** Options: (a) yes, it stays off until switched on, and the sidebar shows it in amber (built); (b) back on at every start.
- **OD-PL-58, built-in layouts. OPEN (operator), recommended default applied, user reviews in the app.** Options: (a) Default (today's look), Minimal (lap, reference, delta, current lap, cues, status), Race (no brake cues, corners or ideal lap; fuel, target, board, sectors on) (built); (b) only Default; (c) more presets.
- **OD-PL-59, when data counts as stale. OPEN (operator), recommended default applied, user reviews in the app.** Options: (a) telemetry: 500 ms without a new packet while live; HUD data: older than 1 s (a normal in-game read is 0.2–0.45 s old); "offline" stays at 3 s (built); (b) 250 ms / 750 ms; (c) 1 s / 2 s.
- **OD-PL-60, slow slot writes. OPEN (operator), recommended default applied, user reviews in the app.** Options: (a) a write over 60 ms pauses writing for 1 s, counted in Integration health (built); (b) only count them; (c) stop writing until restart after repeated slow writes.
- **OD-PL-61, how the kill switch is reached. OPEN (operator), recommended default applied, user reviews in the app.** Options: (a) the sidebar button, Alt+Q (also in a field), Ctrl+K, Settings, the tray menu, and an optional global shortcut of the desktop app (none by default); no in-game key (the loader's key handling for an unset key could not be checked) (built); (b) also an in-game key in the HUD's settings window; (c) a default global shortcut.
- **OD-PL-62, the spotter's quiet time. OPEN (operator), recommended default applied, user reviews in the app.** Options: (a) a setting from 0 (default, as before) to 3 s: a word that would come sooner after the last one is dropped, it never adds any; for audio cues only (the HUD's countdown is a display) (built); (b) a default of 1 s; (c) per corner instead of per word.
- **OD-PL-63, the cue result time. OPEN (operator), recommended default applied, user reviews in the app.** Options: (a) a setting from 2 to 10 s, 6 s by default as before (built); (b) fixed at 6 s.

**PL9 review round (2026-11-25)**, fixes made without a new product choice unless marked:

- **OD-PL-60 refinement, when the writer backs off and which slot it writes. OPEN (operator), recommended default applied, user reviews in the app.** The first rule (pause 1 s after any write over 60 ms) starved a disk at a steady 70 ms a write (55 writes a minute, 29 % of HUD reads over 3 s old). Options: (a) pause only when a write ended less than 30 ms before its slot's read window (the real margin is at least 150 ms), on a monotonic clock; write slot w+5 instead of w+4 when w+5 still holds the state from before a kill-switch or look change, or was not written for 9 windows (built; one write per window is still exactly the old schedule); (b) pause after any write over 100 ms, slots unchanged; (c) no pause at all, counters only.
- **D-PL9-10, the HUD never steps back to an older copy** of its data (within 3 s of the newer one): with slots written in turn, one read can bring older data; taking it made the HUD show itself again for a moment after the kill switch hid it.
- **D-PL9-11, no reference-pedal markers from stale data:** they are hidden like the countdown, not moved along with the car.
- **D-PL9-12, `/api/hudlayouts` and `/api/assist` are Paddock's pages only:** outside the HUD's open-CORS routes, refused for cross-site and same-site reads; built-in layout names are looked up as own keys only (`constructor` is not a layout).
