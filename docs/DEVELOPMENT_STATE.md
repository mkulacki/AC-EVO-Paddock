# Development state

_Last updated: 2026-11-24_

**Status:** P0–P10 done; **0.7.0-beta.1 released 2026-11-23**. Platform plan PL0–PL11 (the local operator plan, not in the repo; phase scopes are summarised in `docs/platform/BACKLOG.md`) started.
**Current phase:** PL1D (the user's decisions on OD-PL-1 … 9, plus the review round) done on `platform/pl1-decisions`, awaiting review. PL2 is merged into it (`675441f`). Next: PL3.
**Branch:** `platform/pl1-decisions` (from `675441f`; not pushed, not merged).

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
| PL1 | Security and data safety | Done 2026-11-24, merged into `platform/integration` |
| PL2 | Quality and release checks | Done 2026-11-24, merged (`675441f`) |
| PL1D | User decisions on OD-PL-1 … 9 + review round | Done 2026-11-24, review pending |
| PL3–PL11 | Platform plan | Not started; see `docs/platform/BACKLOG.md` |

## Current task

None in progress. PL1D is committed on `platform/pl1-decisions`: report `docs/platform/PL1D-report.md`.

## Known problems

- Shared-memory groups (pit-box readings, temperatures, tyres, brakes, suspension) are unverified until the user checks them in game (Setups → Setup recognition). Slip can't be checked.
- PL1 fixed the PL0 data-safety defects (sign-in in backups, lap import, zip extraction, mod rollback, atomic settings writes); each has a regression test. PL1D applied the user's decisions: restores keep the current sign-in and never replace a current key or password (current secrets win), the before-restore backup holds no secrets, and Settings names a damaged data file with Dismiss / Delete copy (OD-PL-1, -4, -5); mod uploads stay uncapped by choice (OD-PL-6).
- CI (`.github/workflows/ci.yml`) has never run: it needs a push. The Ubuntu job has never run on Linux.
- The packaged app installs the loader and HUD into `ACE_DIR` at start; CLAUDE.md step 6 now uses a scratch `ACE_DIR` too (OD-PL-9, decided).

## Test results

- PL0 baseline (2026-11-24, `be3b5ef`): `npm run check` 104/104; `npm test` 175/175.
- PL1 with review fixes (2026-11-24, `platform/pl1-data-safety`): `npm run check` 112/112; `npm test` 213/213 (22 files).
- PL2 (2026-11-24, `platform/pl2-quality`): `npm run check` 116/116; `npm test` 215/215 on Node 22.23.4; `npm run test:electron` 215/215 on Node 24.22.2; `npm run test:browser` 6/6; `npm run smoke:packaged -- --build` passed. One command: `npm run verify`.
- PL1D after round 3 (2026-11-24, `platform/pl1-decisions`): `npm run check` 116/116; `npm test` 226/226; `npm run test:electron` 226/226; `npm run test:browser` 13/13 in 5 consecutive runs (11/11 ×10 after round 2).

## Pending user decisions

- None open from PL0–PL2: OD-PL-1 … 9 and the review-round decisions (D-PL1D-1, D-PL1D-2) were decided by the user on 2026-11-24.
- Push / merge of `platform/pl1-decisions` (into `platform/integration`, then `main`); after the first push, check both CI jobs.

## Next action

- After review and merge of PL1D into `platform/integration`, start PL3 (recording reliability and performance) on a new branch from `platform/integration`: bounded timing diagnostics in the 60 Hz loop, mock scenarios with seeded large histories, `docs/platform/PERFORMANCE.md`. Gate each step with `npm run verify`. See `docs/platform/BACKLOG.md` PL3.

## How to resume

Read this file, then `git status` / `git branch` / `git log -5`. Don't assume the last task finished: check its branch and run `npm run verify`.
