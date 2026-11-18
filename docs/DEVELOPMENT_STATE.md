# Development state

_Last updated: 2026-11-18_

**Status:** P0–P10 approved and merged into `main`. **0.6.0-beta.1 released 2026-11-18.**
**Current phase:** none (roadmap done).
**Branch:** `main`.

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

## Current task

None. 0.6.0-beta.1 (with the 2026-11-18 test-round changes) is published. SHA-256 of the zip: `3571634D8BC77CC2F3C9F884636F419249F70CDC49D979A2AFED1355FD04F62E`.

## Known problems

- Shared-memory groups (pit-box readings, temperatures, tyres, brakes, suspension) are unverified until the user checks them in game (Setups → Setup recognition). Slip can't be checked.

## Test results

- `npm run check` 93/93; `npm test` 137/137. Packaged exe smoke test passed; release zip verified (no data, no secrets).

## Pending user decisions

- None open. D3 answered 2026-11-17: achievements and challenges yes.
- D1 accent/navigation (before P4), D2 update mechanism (before P3), D3 gamification (before P9).

## Next action

- 0.6.0-beta.1 is released (GitHub pre-release and overtake.gg). Nothing is in progress: wait for the next request, and start each feature on its own branch from `main`.

## How to resume

Read this file, then `git status` / `git branch` / `git log -5`. Don't assume the last task finished: check its branch and run `npm test` (from P1 on).
