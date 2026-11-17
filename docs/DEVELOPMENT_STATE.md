# Development state

_Last updated: 2026-11-17_

**Status:** P0–P8 approved and merged into local `main`. **P9 starting: decision D3 asked.**
**Current phase:** P9, driver development (D3 pending).
**Branch:** `main` (local, not pushed; the installed app runs the P8 build).

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
| P9 | Driver development | Pending (D3) |
| P10 | Final regression and release prep | Pending |

## Current task

P9 start: ask D3 (achievements and challenges), then branch `phase/p9-development`.

## Known problems

- Shared-memory groups (pit-box readings, temperatures, tyres, brakes, suspension) are unverified until the user checks them in game (Setups → Setup recognition). Slip can't be checked.

## Test results

- `npm run check` 88/88; `npm test` 124/124. Coach page checked in headless Edge with a stubbed Gemini (0 JS errors).

## Pending user decisions

- D3 (achievements and challenges) is asked at the start of P9.
- D1 accent/navigation (before P4), D2 update mechanism (before P3), D3 gamification (before P9).

## Next action

Ask D3, record it in DECISIONS.md, then start P9 on `phase/p9-development`.

## How to resume

Read this file, then `git status` / `git branch` / `git log -5`. Don't assume the last task finished: check its branch and run `npm test` (from P1 on).
