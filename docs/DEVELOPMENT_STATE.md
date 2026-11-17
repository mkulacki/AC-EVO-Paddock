# Development state

_Last updated: 2026-11-17_

**Status:** audit done; roadmap **proposed, waiting for user approval**.
**Current phase:** none (P0 audit complete).
**Branch:** `docs/audit-roadmap` (audit documents, committed locally, not pushed).

## Phases

| Phase | Name | Status |
| --- | --- | --- |
| P0 | Repository audit + roadmap | Done, awaiting approval |
| P1 | Test foundation and baseline | Pending |
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

None. Waiting for the roadmap decision (APPROVE / APPROVE WITH NOTES / REVISE / REJECT / PAUSE).

## Known problems

- Shared-memory channels for the tyre block, suspension, slip, setup fingerprint and temperatures are unverified in game (see ARCHITECTURE.md).
- No automated tests (P1).

## Test results

Baseline 2026-11-17: syntax check clean; mock server + seed: all main API routes 200. Details in PRODUCT_AUDIT.md.

## Pending user decisions

- Roadmap approval.
- D1 accent/navigation (before P4), D2 update mechanism (before P3), D3 gamification (before P9).

## Next action

On APPROVE: create `phase/p1-tests` from `main` (after merging this docs branch locally) and start P1.

## How to resume

Read this file, then `git status` / `git branch` / `git log -5`. Don't assume the last task finished: check its branch and run `npm test` (from P1 on).
