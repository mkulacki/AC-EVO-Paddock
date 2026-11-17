# Development state

_Last updated: 2026-11-17_

**Status:** P0–P4 approved; **P5 complete, waiting for user approval**.
**Current phase:** P5, Driver home dashboard (done, awaiting approval).
**Branch:** `phase/p5-home` (committed locally, not pushed; deployed to the installed app). Local `main` = P0–P4 (not pushed).

## Phases

| Phase | Name | Status |
| --- | --- | --- |
| P0 | Repository audit + roadmap | Done, approved 2026-11-17 |
| P1 | Test foundation and baseline | Done, approved 2026-11-17 |
| P2 | Data provenance and AI confidence | Done, approved 2026-11-17 |
| P3 | Application management | Done, approved 2026-11-17 (D2: check and notify) |
| P4 | App shell: navigation, command palette, states | Done, approved 2026-11-17 (D1: lime + sidebar) |
| P5 | Driver home dashboard | Done, awaiting approval |
| P6 | Driving technique analysis | Pending |
| P7 | Setup history and comparison | Pending |
| P8 | AI coach upgrade | Pending |
| P9 | Driver development | Pending (D3) |
| P10 | Final regression and release prep | Pending |

## Current task

None. Waiting for the P5 decision (APPROVE / APPROVE WITH NOTES / REVISE / REJECT / PAUSE).

## Known problems

- Shared-memory groups (pit-box readings, temperatures, tyres, brakes, suspension) are unverified until the user checks them in game (Setups → Setup recognition). Slip can't be checked.

## Test results

- `npm run check` 81/81; `npm test` 84/84. Home checked in headless Edge; dashboard 17 ms then 4 ms on the user's data.

## Pending user decisions

- P5 approval.
- D3 (achievements and challenges) is asked at the start of P9.
- D1 accent/navigation (before P4), D2 update mechanism (before P3), D3 gamification (before P9).

## Next action

On APPROVE: merge `phase/p5-home` into local `main`, create `phase/p6-technique`, start P6 (driving technique analysis).

## How to resume

Read this file, then `git status` / `git branch` / `git log -5`. Don't assume the last task finished: check its branch and run `npm test` (from P1 on).
