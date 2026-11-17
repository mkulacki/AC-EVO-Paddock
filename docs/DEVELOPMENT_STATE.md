# Development state

_Last updated: 2026-11-17_

**Status:** P0–P5 approved and merged into local `main`. **P6 not started.**
**Current phase:** none in progress. Next: P6, Driving technique analysis.
**Branch:** `main` (local, not pushed since v0.5.0-beta.1; the installed app runs the P5 build).

## Phases

| Phase | Name | Status |
| --- | --- | --- |
| P0 | Repository audit + roadmap | Done, approved 2026-11-17 |
| P1 | Test foundation and baseline | Done, approved 2026-11-17 |
| P2 | Data provenance and AI confidence | Done, approved 2026-11-17 |
| P3 | Application management | Done, approved 2026-11-17 (D2: check and notify) |
| P4 | App shell: navigation, command palette, states | Done, approved 2026-11-17 (D1: lime + sidebar) |
| P5 | Driver home dashboard | Done, approved 2026-11-17 |
| P6 | Driving technique analysis | Pending |
| P7 | Setup history and comparison | Pending |
| P8 | AI coach upgrade | Pending |
| P9 | Driver development | Pending (D3) |
| P10 | Final regression and release prep | Pending |

## Current task

None. P6 is ready to start (the user continues in a new chat).

## Known problems

- Shared-memory groups (pit-box readings, temperatures, tyres, brakes, suspension) are unverified until the user checks them in game (Setups → Setup recognition). Slip can't be checked.

## Test results

- `npm run check` 81/81; `npm test` 84/84. Home checked in headless Edge; dashboard 17 ms then 4 ms on the user's data.

## Pending user decisions

- D3 (achievements and challenges) is asked at the start of P9.
- D1 accent/navigation (before P4), D2 update mechanism (before P3), D3 gamification (before P9).

## Next action

Create `phase/p6-technique` from `main` and start P6 (driving technique analysis): Step A in docs/IMPLEMENTATION_ROADMAP.md, then the usual workflow: tests, headless-Edge check, review subagent, deploy, report and approval gate.

## How to resume

Read this file, then `git status` / `git branch` / `git log -5`. Don't assume the last task finished: check its branch and run `npm test` (from P1 on).
