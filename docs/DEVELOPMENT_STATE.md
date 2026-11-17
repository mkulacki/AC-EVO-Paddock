# Development state

_Last updated: 2026-11-17_

**Status:** P0–P3 approved; **P4 complete, waiting for user approval**.
**Current phase:** P4, App shell (done, awaiting approval).
**Branch:** `phase/p4-shell` (committed locally, not pushed; deployed to the installed app). Local `main` = P0–P3 (not pushed).

## Phases

| Phase | Name | Status |
| --- | --- | --- |
| P0 | Repository audit + roadmap | Done, approved 2026-11-17 |
| P1 | Test foundation and baseline | Done, approved 2026-11-17 |
| P2 | Data provenance and AI confidence | Done, approved 2026-11-17 |
| P3 | Application management | Done, approved 2026-11-17 (D2: check and notify) |
| P4 | App shell: navigation, command palette, states | Done, awaiting approval (D1: lime + sidebar) |
| P5 | Driver home dashboard | Pending |
| P6 | Driving technique analysis | Pending |
| P7 | Setup history and comparison | Pending |
| P8 | AI coach upgrade | Pending |
| P9 | Driver development | Pending (D3) |
| P10 | Final regression and release prep | Pending |

## Current task

None. Waiting for the P4 decision (APPROVE / APPROVE WITH NOTES / REVISE / REJECT / PAUSE).

## Known problems

- Shared-memory groups (pit-box readings, temperatures, tyres, brakes, suspension) are unverified until the user checks them in game (Setups → Setup recognition). Slip can't be checked.

## Test results

- `npm run check` 79/79; `npm test` 76/76 (about 2.4 s). UI swept with headless Edge (empty and demo data, light and dark, 860 and 1024 px), 0 JS errors.

## Pending user decisions

- P4 approval.
- D3 (achievements and challenges) is asked at the start of P9.
- D1 accent/navigation (before P4), D2 update mechanism (before P3), D3 gamification (before P9).

## Next action

On APPROVE: merge `phase/p4-shell` into local `main`, create `phase/p5-home`, start P5 (driver home dashboard).

## How to resume

Read this file, then `git status` / `git branch` / `git log -5`. Don't assume the last task finished: check its branch and run `npm test` (from P1 on).
