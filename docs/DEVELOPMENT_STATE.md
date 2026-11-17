# Development state

_Last updated: 2026-11-17_

**Status:** P0–P6 approved and merged into local `main`. **P7 done on `phase/p7-setups`, waiting for approval.**
**Current phase:** P7, Setup history and comparison (approval gate).
**Branch:** `phase/p7-setups` (local, not pushed; the installed app runs the P7 build).

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
| P7 | Setup history and comparison | Done, waiting for approval |
| P8 | AI coach upgrade | Pending |
| P9 | Driver development | Pending (D3) |
| P10 | Final regression and release prep | Pending |

## Current task

P7 approval gate: the user reviews Setup history (Sessions → a combo → Setup history; Setups tab → Your laps here).

## Known problems

- Shared-memory groups (pit-box readings, temperatures, tyres, brakes, suspension) are unverified until the user checks them in game (Setups → Setup recognition). Slip can't be checked.

## Test results

- `npm run check` 85/85; `npm test` 111/111. Setup history checked in headless Edge (0 JS errors); 1–12 ms on the user's data.

## Pending user decisions

- D3 (achievements and challenges) is asked at the start of P9.
- D1 accent/navigation (before P4), D2 update mechanism (before P3), D3 gamification (before P9).

## Next action

On APPROVE: merge `phase/p7-setups` into local `main` (no push), mark P7 approved, then create `phase/p8-coach` and start P8 (AI coach upgrade). On changes requested: fix on the P7 branch, redeploy, report again.

## How to resume

Read this file, then `git status` / `git branch` / `git log -5`. Don't assume the last task finished: check its branch and run `npm test` (from P1 on).
