# Development state

_Last updated: 2026-11-17_

**Status:** roadmap approved; **P1 complete, waiting for user approval**.
**Current phase:** P1, Test foundation and baseline (done, awaiting approval).
**Branch:** `phase/p1-tests` (committed locally, not pushed). Local `main` has the merged audit docs (not pushed).

## Phases

| Phase | Name | Status |
| --- | --- | --- |
| P0 | Repository audit + roadmap | Done, approved 2026-11-17 |
| P1 | Test foundation and baseline | Done, awaiting approval |
| P2 | Data provenance and AI confidence | Pending |
| P3 | Application management | Pending (D2) |
| P4 | App shell: navigation, command palette, states | Pending (D1) |
| P5 | Driver home dashboard | Pending |
| P6 | Driving technique analysis | Pending |
| P7 | Setup history and comparison | Pending |
| P8 | AI coach upgrade | Pending |
| P9 | Driver development | Pending (D3) |
| P10 | Final regression and release prep | Pending |

## Current task

None. Waiting for the P1 decision (APPROVE / APPROVE WITH NOTES / REVISE / REJECT / PAUSE).

## Known problems

- Shared-memory channels for the tyre block, suspension, slip, setup fingerprint and temperatures are unverified in game (see ARCHITECTURE.md). P2 addresses the labelling.

## Test results

- `npm run check` 64/64; `npm test` 38/38 (about 1.8 s, deterministic). Packaged exe smoke test OK. Details in PHASE_LOG.md.

## Pending user decisions

- P1 approval.
- D1 accent/navigation (before P4), D2 update mechanism (before P3), D3 gamification (before P9).

## Next action

On APPROVE: merge `phase/p1-tests` into local `main`, create `phase/p2-provenance`, start P2 (data provenance and AI confidence).

## How to resume

Read this file, then `git status` / `git branch` / `git log -5`. Don't assume the last task finished: check its branch and run `npm test` (from P1 on).
