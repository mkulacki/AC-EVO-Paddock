# Development state

_Last updated: 2026-11-17_

**Status:** P0–P2 approved; **P3 complete, waiting for user approval**.
**Current phase:** P3, Application management (done, awaiting approval).
**Branch:** `phase/p3-app-management` (committed locally, not pushed; deployed to the installed app). Local `main` = P0–P2 (not pushed).

## Phases

| Phase | Name | Status |
| --- | --- | --- |
| P0 | Repository audit + roadmap | Done, approved 2026-11-17 |
| P1 | Test foundation and baseline | Done, approved 2026-11-17 |
| P2 | Data provenance and AI confidence | Done, approved 2026-11-17 |
| P3 | Application management | Done, awaiting approval (D2: check and notify) |
| P4 | App shell: navigation, command palette, states | Pending (D1) |
| P5 | Driver home dashboard | Pending |
| P6 | Driving technique analysis | Pending |
| P7 | Setup history and comparison | Pending |
| P8 | AI coach upgrade | Pending |
| P9 | Driver development | Pending (D3) |
| P10 | Final regression and release prep | Pending |

## Current task

None. Waiting for the P3 decision (APPROVE / APPROVE WITH NOTES / REVISE / REJECT / PAUSE).

## Known problems

- Shared-memory groups (pit-box readings, temperatures, tyres, brakes, suspension) are unverified until the user checks them in game (Setups → Setup recognition). Slip can't be checked.

## Test results

- `npm run check` 73/73; `npm test` 71/71 (about 2 s). End-to-end restore OK with the server and the packaged app. Details in PHASE_LOG.md.

## Pending user decisions

- P3 approval.
- D1 (accent colour and navigation) is asked at the start of P4.
- D1 accent/navigation (before P4), D2 update mechanism (before P3), D3 gamification (before P9).

## Next action

On APPROVE: merge `phase/p3-app-management` into local `main`, ask D1 (accent and navigation), create `phase/p4-shell`, start P4.

## How to resume

Read this file, then `git status` / `git branch` / `git log -5`. Don't assume the last task finished: check its branch and run `npm test` (from P1 on).
