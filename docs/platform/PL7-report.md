# PL7 report: structured practice

- **Date:** 2026-11-25 · **Branch:** `platform/pl7-practice` (from `ff85248`, the PL6 merge) · not pushed, not merged
- **Scope:** `docs/platform/BACKLOG.md` (PL7). Rules, thresholds and limits: `docs/platform/PRACTICE.md`.

## What changed

| Commit | What |
| --- | --- |
| `9e2b190` | Schema v3 (`src/db.js`): `drill_events` table, versioned, one pre-upgrade `VACUUM INTO` copy (the v2 step now records its copy too, so one copy per start); `test/fixtures/db-v2-pl6.sql`; newer-database tests moved to `user_version` 4 |
| `4a9c335` | `src/practice.js` (pure: prescription, `meets`, `evaluate`, `change`, `slipping`, `mastery`, `progressSummary`), `src/drills.js` (drills as goals of kind `drill`; create / keep / stop / remove; one active per car + track), `svc.drillPassesAsync` in slices, `matchCorner`; `src/goals.js` keeps drills out of goal lists, Home, achievements and suggestions; `row.gearChoice` in `src/opportunities.js`; `GET/POST /api/practice` (private GET); `test/practice.test.js`, `test/practice-db.test.js` |
| `ba8ee9b` | `public/practice.js` drill card; Lap analysis: **Practise this** next to card findings, drill section, corner mastery badges; Development: Practice drills section (active, revisit, progress, finished) |
| `a7bac8d` | Browser flow: drill made from a card, met by laps driven after it, shown on Development, narrow window; fix: the analysis page's redraw called `window.dispatchEvent` on a shadowing local `window` (the lap-window string) |
| `d6400ef` | A met drill is recorded and announced once when two pages evaluate at the same moment (`setGoalMet` changes = 1); regression test |
| `01a26fb` | `docs/platform/PRACTICE.md`, DECISIONS (D-PL7-1 … 7, OD-PL-32 … 41), fixtures README, inventory, architecture, backlog, changelog |
| (this commit) | this report, `docs/PHASE_LOG.md`, `docs/DEVELOPMENT_STATE.md` |

## Verified findings / rejected assumptions / unresolved

Verified (what PL7 builds on):

- P9 goals: table `src/db.js:308`, met stored once `src/db.js:327` (`WHERE met_at IS NULL`), `src/goals.js:93` `measure` / `:132` `status` are synchronous over lap rows only, so a corner-metric goal cannot be checked there without breaking the PL3 rule; drills are evaluated asynchronously in `src/drills.js` instead and only reuse the table and met fields.
- P8 training plans: `src/db.js:270`, `src/coach.js:177` `planStatus` / `:191` `createPlan` check session-report targets per later session. Left unchanged: a drill judges passes of one corner, a plan judges whole sessions; the two coexist on the same car + track.
- PL6 findings (`src/opportunities.js` `differences`) carry key, observation and interpretation but not the gears behind a gear finding: added `row.gearChoice` (additive).
- Home's objective and next step read `goals.list()` (`src/server.js` `development()`); with drills filtered out there (`src/goals.js:145` `goalsOnly`), Home is unchanged (OD-PL-31 respected).
- Within one car + track `compat.classify` can only give caveats (incompatible = other car / layout, `src/compat.js:78`), so the only exclusion rule PL7 adds is the game version (OD-PL-34); other differences are shown with `compat.mix`.

Bug found: `public/analysis.js` shadows the global `window` with the lap-window string, so any `window.*` call in `viewAnalysis` fails (fixed for the redraw in `a7bac8d`).

Rejected: "exercises need a new goal system" (no: goals rows + one event table); "AI needed for prescriptions" (no: all six parts are fixed sentences over stored numbers).

Unresolved: thresholds and exercise wording are untested on real AC EVO laps (no game here); whether drivers can follow "N m later than usual" without an on-track marker (PL9 HUD could show it).

## Tests run and results

| Suite | Before (`ff85248`) | After |
| --- | --- | --- |
| `npm run check` | 138/138 | 143/143 |
| `npm test` (Node 22.23.4) | 346/346 | 365/365 |
| `npm run test:electron` (Node 24.22.2) | 346/346 | 365/365 |
| `npm run test:browser` | 22/22 | 23/23 |

New: `test/practice.test.js` (10, pure rules), `test/practice-db.test.js` (9: v2 → v3 upgrade with copy and unchanged tables, six-part prescription quoting the analysis, one-at-a-time, met on the 5th pass, slipping / revisit / mastery, review → keep → stop, game-version exclusion and replace, concurrent met recorded once, no AI import), one browser flow.

## Checks that could not run

- `smoke:packaged` and the packaged exe: port 8080 is in use by the user's running app (not touched).
- In-game behaviour with real laps (no game here); `npm run bench` not rerun (nothing in the telemetry loop changed; drill evaluation runs on demand in slices).

## Performance or compatibility impact

- Drill evaluation runs only when Development or Lap analysis opens, in `runInSlices`, reusing the per-lap numbers of the analysis; worst case on a long history is reading the corner passes of the laps since each listed drill started (newest 30 drills; slipping checks read at most 30 laps after each met drill). Lap analysis now also requests `/api/practice`.
- Paddock 0.7.0 (no newer-database guard) still opens a v3 file; it would list a drill as an open goal named "drill". PL5/PL6 builds refuse it (newer database → recording off), as designed.

## Migration and recovery

Schema v3 adds `drill_events` only, in one transaction, after a `VACUUM INTO` copy `telemetry.backup-v2-<time>.db` when the database holds any user row (one copy per start; a v1 file keeps only its v1 copy). Recovery: replace `telemetry.db` with the copy while Paddock is closed. Drill rows live in `goals` and are in Settings backups with the database.

## Needs approval

Nothing new: no push, deploy, upload, paid service or privacy change. The branch is not pushed or merged.

## Open decisions (added to DECISIONS.md, OPEN (operator), default built)

OD-PL-32 success criterion (a: half of newest 10 passes, from 5) · OD-PL-33 review point (a: 10 passes, keep / renew / stop) · OD-PL-34 other game versions (a: left out) · OD-PL-35 drills at a time (a: one per car + track) · OD-PL-36 where offered (a: top-3 card findings only) · OD-PL-37 Home / achievements (a: unchanged) · OD-PL-38 slipping (a: < 25 % of newest 10) · OD-PL-39 mastery labels (a: no "mastered") · OD-PL-40 AI and drills (a: none) · OD-PL-41 when evaluated (a: on demand). Choices made without asking: D-PL7-1 … 7.

## Remaining risks

- Thresholds (tolerance = half the naming threshold, 50 %, 25 %, 10 / 5 passes) rest on synthetic laps only.
- A drill's corner is found by its apex within 40 m; a big change of the best lap can make a drill "cannot be checked" (it can be stopped).
- Met drills are noticed when a page opens, not while driving (OD-PL-41); the met time is still the pass's own time.

## Recommended next phase

PL8 (controlled setup experiments): reuse `src/stats.js`, the PL4 classes and the PL7 before/after pattern (judged passes, minimum evidence, "no clear change"). PL9 could show the active drill in the HUD.
