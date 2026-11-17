# Development state

_Last updated: 2026-11-17_

**Status:** P0–P7 approved and merged into local `main`. **P8 done on `phase/p8-coach`, waiting for approval.**
**Current phase:** P8, AI coach upgrade (approval gate).
**Branch:** `phase/p8-coach` (local, not pushed; the installed app runs the P8 build).

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
| P8 | AI coach upgrade | Done, waiting for approval |
| P9 | Driver development | Pending (D3) |
| P10 | Final regression and release prep | Pending |

## Current task

P8 approval gate: the user reviews the Coach page (Sessions → a combo → Coach), the training plan on reports, and AI braking points.

## Known problems

- Shared-memory groups (pit-box readings, temperatures, tyres, brakes, suspension) are unverified until the user checks them in game (Setups → Setup recognition). Slip can't be checked.

## Test results

- `npm run check` 88/88; `npm test` 124/124. Coach page checked in headless Edge with a stubbed Gemini (0 JS errors).

## Pending user decisions

- D3 (achievements and challenges) is asked at the start of P9.
- D1 accent/navigation (before P4), D2 update mechanism (before P3), D3 gamification (before P9).

## Next action

On APPROVE: merge `phase/p8-coach` into local `main` (no push), mark P8 approved, then ask decision D3 (achievements and challenges) and start P9 on `phase/p9-development`. On changes requested: fix on the P8 branch, redeploy, report again.

## How to resume

Read this file, then `git status` / `git branch` / `git log -5`. Don't assume the last task finished: check its branch and run `npm test` (from P1 on).
