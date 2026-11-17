# Development state

_Last updated: 2026-11-17_

**Status:** P0–P9 approved and merged into local `main`. **P10 done on `phase/p10-release`, waiting for approval and the go to publish.**
**Current phase:** P10, final regression and release preparation.
**Branch:** `phase/p10-release` (local, not pushed).

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
| P10 | Final regression and release prep | Done, waiting for approval |

## Current task

The user is testing the 0.6.0-beta.1 build locally (installed at `E:AC EVO Paddock`) and will give **go / no-go** in a new chat. P10 is not merged into `main` yet. Nothing is pushed, tagged or released (no local tag either).

## Known problems

- Shared-memory groups (pit-box readings, temperatures, tyres, brakes, suspension) are unverified until the user checks them in game (Setups → Setup recognition). Slip can't be checked.

## Test results

- `npm run check` 93/93; `npm test` 137/137. Packaged exe smoke test passed; release zip verified (no data, no secrets).

## Pending user decisions

- None open. D3 answered 2026-11-17: achievements and challenges yes.
- D1 accent/navigation (before P4), D2 update mechanism (before P3), D3 gamification (before P9).

## Next action

- **No-go (changes wanted):** fix on `phase/p10-release` (or a branch from it), run `npm test` and `npm run check`, redeploy (stop the app only if the game is not running, `rm -rf dist && npx electron-builder --win dir`, `node desktop/deploy.mjs`, clear `ELECTRON_RUN_AS_NODE`, start the installed exe). Then rebuild and re-verify the release zip (CLAUDE.md steps 5–7): the SHA-256 changes, so update it in `release/notes-v0.6.0-beta.1.md` and in PHASE_LOG P10. Add the changes to the CHANGELOG under 0.6.0-beta.1.
- **Go:** confirm each public step with the user, then:
  1. merge `phase/p10-release` into `main` (`--no-ff`), and mark P10 approved in PHASE_LOG and here;
  2. push `main`;
  3. tag `v0.6.0-beta.1` (annotated) and push the tag;
  4. `gh release create v0.6.0-beta.1 release/AC-EVO-Paddock-v0.6.0-beta.1-win64.zip -R mkulacki/ac-evo-paddock --prerelease --title "AC EVO Paddock v0.6.0-beta.1" --notes-file release/notes-v0.6.0-beta.1.md`, then check that the asset state is `uploaded`;
  5. optional: the overtake.gg update (`.claude/overtake/README.md`).
- **Before publishing,** check that the zip is unchanged: SHA-256 `BFA36F50169D2B183C37ABC480CA32C8BA370340D9539F4AA7B1AFA7A1B2E4F0` (`Get-FileHash`).

## How to resume

Read this file, then `git status` / `git branch` / `git log -5`. Don't assume the last task finished: check its branch and run `npm test` (from P1 on).
