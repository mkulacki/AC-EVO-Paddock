# Development state

_Last updated: 2026-11-24_

**Status:** P0–P10 done; **0.7.0-beta.1 released 2026-11-23**. Platform plan PL0–PL11 (`.claude/skills/paddock-operator/PLAN.md`) started.
**Current phase:** PL0 (platform baseline) done on `platform/pl0-baseline`, awaiting review. Next: PL1.
**Branch:** `platform/pl0-baseline` (not pushed, not merged).

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
| PL0 | Platform baseline (docs only) | Done 2026-11-24, review pending |
| PL1–PL11 | Platform plan | Not started; see `docs/platform/BACKLOG.md` |

## Current task

None in progress. PL0 is committed on `platform/pl0-baseline`: report `docs/platform/PL0-report.md`, backlog `docs/platform/BACKLOG.md`.

## Known problems

- Shared-memory groups (pit-box readings, temperatures, tyres, brakes, suspension) are unverified until the user checks them in game (Setups → Setup recognition). Slip can't be checked.
- PL0 verified (static only) defects for PL1: leaderboard token in secret-free backups and restores; unbounded lap-import gunzip and no schema checks; unbounded streamed zip extraction; mod overwrite rollback; non-atomic `settings.json`/`race.json` writes. Details: PL0 report.
- Tests run on Node 22.x; the packaged app runs Electron 44 / Node 24.22.2 (PL2).

## Test results

- PL0 baseline (2026-11-24, `be3b5ef` and this branch): `npm run check` 104/104; `npm test` 175/175.

## Pending user decisions

- OD-PL-1 … OD-PL-4 in `docs/DECISIONS.md` (`OPEN (operator)`), each with a conservative default PL1 will use if not answered.
- Push / merge of `platform/pl0-baseline`.

## Next action

- Start PL1 on a new branch (e.g. `platform/pl1-security`) from `platform/pl0-baseline` (or `main` after the merge), in the order of `docs/platform/BACKLOG.md` PL1: sensitive-settings inventory → backups/restore → atomic JSON writes → lap import → archives → mod overwrite → low items. Write a failing regression test for each verified finding first.

## How to resume

Read this file, then `git status` / `git branch` / `git log -5`. Don't assume the last task finished: check its branch and run `npm run check` and `npm test`.
