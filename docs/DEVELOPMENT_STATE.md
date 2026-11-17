# Development state

_Last updated: 2026-11-17_

**Status:** P0–P6 approved and merged into local `main`. **P7 in progress.**
**Current phase:** P7, Setup history and comparison.
**Branch:** `phase/p7-setups` (local, not pushed; the installed app runs the P6 build).

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
| P7 | Setup history and comparison | In progress |
| P8 | AI coach upgrade | Pending |
| P9 | Driver development | Pending (D3) |
| P10 | Final regression and release prep | Pending |

## Current task

P7 started on `phase/p7-setups`: reading the existing setup code (src/setups.js, setupmatch.js, db snapshots, public/setups.js).

## Known problems

- Shared-memory groups (pit-box readings, temperatures, tyres, brakes, suspension) are unverified until the user checks them in game (Setups → Setup recognition). Slip can't be checked.

## Test results

- `npm run check` 82/82; `npm test` 103/103. P6 pages checked in headless Edge (0 JS errors); Consistency 35 ms on the user's data.

## Pending user decisions

- D3 (achievements and challenges) is asked at the start of P9.
- D1 accent/navigation (before P4), D2 update mechanism (before P3), D3 gamification (before P9).

## Next action

Implement P7 (docs/IMPLEMENTATION_ROADMAP.md): setup history per car + track, compare two setups, performance by setup, laps split by setup for the setup engineer. Then the usual workflow: tests, headless-Edge check, review subagent, deploy, report and approval gate.

## How to resume

Read this file, then `git status` / `git branch` / `git log -5`. Don't assume the last task finished: check its branch and run `npm test` (from P1 on).
