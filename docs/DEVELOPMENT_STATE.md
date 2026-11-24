# Development state

_Last updated: 2026-11-24_

**Status:** P0–P10 done; **0.7.0-beta.1 released 2026-11-23**. Platform plan PL0–PL11 (the local operator plan, not in the repo; phase scopes are summarised in `docs/platform/BACKLOG.md`) started.
**Current phase:** PL1 (security and data safety) done on `platform/pl1-data-safety`, awaiting review. Next: PL2.
**Branch:** `platform/pl1-data-safety` (from `platform/integration`, which holds the PL0 merge; not pushed, not merged).

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
| PL1 | Security and data safety | Done 2026-11-24, review pending |
| PL2–PL11 | Platform plan | Not started; see `docs/platform/BACKLOG.md` |

## Current task

None in progress. PL1 is committed on `platform/pl1-data-safety`: report `docs/platform/PL1-report.md`.

## Known problems

- Shared-memory groups (pit-box readings, temperatures, tyres, brakes, suspension) are unverified until the user checks them in game (Setups → Setup recognition). Slip can't be checked.
- PL1 fixed the PL0 data-safety defects (sign-in in backups, lap import, zip extraction, mod rollback, atomic settings writes); each has a regression test. Left open: mod uploads have no size cap (OD-PL-6); a damaged settings file is only logged, not shown in the page (OD-PL-5).
- Tests run on Node 22.x; the packaged app runs Electron 44 / Node 24.22.2 (PL2).

## Test results

- PL0 baseline (2026-11-24, `be3b5ef`): `npm run check` 104/104; `npm test` 175/175.
- PL1 (2026-11-24, `platform/pl1-data-safety`): `npm run check` 111/111; `npm test` 205/205 (21 files).

## Pending user decisions

- OD-PL-1 … OD-PL-4 (defaults implemented in PL1, to confirm) and OD-PL-5 … OD-PL-7 in `docs/DECISIONS.md` (`OPEN (operator)`).
- Push / merge of `platform/pl1-data-safety` (into `platform/integration`, then `main`).

## Next action

- After review and merge of PL1 into `platform/integration`, start PL2 on a new branch (e.g. `platform/pl2-quality`) from `platform/integration`: CI workflow (validated locally only), `npm test` under Electron's Node 24, `npm run verify`, packaged smoke script, and refresh the `docs/ARCHITECTURE.md` line references changed by PL1. See `docs/platform/BACKLOG.md` PL2.

## How to resume

Read this file, then `git status` / `git branch` / `git log -5`. Don't assume the last task finished: check its branch and run `npm run check` and `npm test`.
