# Platform run summary (PL0–PL11, RB)

Run dates: 2026-11-24 to 2026-11-25. Started from `main` at `be3b5ef` (0.7.0-beta.1).
All work is on local branches. **Nothing was pushed, tagged, released or deployed**, and `main` is unchanged.

Result on `platform/integration`: syntax check 104 → **164/164** files, tests 175 → **467/467** on Node 22 and on Electron's Node 24, browser flows **26/26**. 172 files changed (+17,590 / −511).

## Phases

| Phase | What it delivered | Merge | Tests | Fix rounds |
|---|---|---|---|---|
| PL0 Baseline | Architecture and feature inventory refreshed, verified defect list, prioritised backlog | `0365ce6` | 175 | 1 |
| PL1 Data safety | Secret-free backups, atomic settings writes, bounded lap import, safer zip/mod/setup handling | `f5cbaa0` | 213 | 1 |
| PL1D Your decisions | Restore keeps current secrets and sign-in, secret-free safety backup, damaged-file notice | `e8a6528` | 226 | 3 (third approved by you) |
| PL2 Quality | `npm run verify`, Node 24 test run, browser flows, packaged smoke test, CI workflow | `675441f` | 215 | 1 |
| PL3 Recording performance | Worst 60 Hz stall 7.4 s → ~25 ms; bounded diagnostics; `npm run bench` | `ab2ba8c` | 240 | 1 |
| PL4 Compatibility | Version-aware channel checks, comparison warnings, integration health panel | `4d25a15` | 280 | 1 |
| PL5 Onboarding | Setup guide, session notes/tags/bookmarks (schema v2), Home next step, accessibility | `c65fa65` | 307 | 1 |
| PL6 Lap analysis | Lap analysis page: top-3 corner opportunities, target lap, trends (no AI) | `ff85248` | 346 | 1 |
| PL7 Structured practice | Drills judged by behaviour, corner mastery (schema v3) | `87b3131` | 369 | 1 |
| PL8 Setup experiments | A/B stint experiments with honest statistics (schema v4); setups stay read-only | `9bab779` | 397 | 1 |
| PL9 HUD and live | Kill switch, HUD layouts, stale-data labels, HUD 0.15.0, bridge audit | `d2d4564` | 426 | 1 |
| PL10 Leaderboard integrity | Evidence tiers, moderation trail, flags, rate limits, own-data deletion (**not deployed**) | `d97a278` | 439 | 1 |
| PL11 Data ownership | Verified scheduled backups, crash recovery, offline HTML report, demo mode | `6e06801` | 467 | 1 |
| RB Research | Nine feasibility reports with verdicts (`docs/platform/research/`) | `aab645a` | 467 | 0 |

Each phase has its own report: `docs/platform/PL<n>-report.md`, `PL1D-report.md`, `RB-report.md`.

## Needs your approval (prepared, not executed)

1. **Merge and push.** Review, then merge `platform/integration` into `main` and push. CI (`.github/workflows/ci.yml`) has never run on GitHub; the first run may need small fixes.
2. **Release.** A release would ship the database upgrade to schema v4 (with a one-time copy first) and **HUD 0.15.0** to players. Follow the CLAUDE.md release checklist (its step 6 now uses a scratch `ACE_DIR`).
3. **Leaderboard server, in this order** (see `docs/platform/LEADERBOARD_TRUST.md` §9): back up D1 (`wrangler d1 export`) → apply migration `0003_integrity.sql` once → set the `RATE_SALT` secret (sign-in returns 503 without it) → deploy the Worker → run `0004_backfill_keys.sql` (safe to repeat). Until then, the new app degrades gracefully against the old server.
4. **Design-only work, if you want it built:** community features (`COMMUNITY_DESIGN.md`), local API, plugins, sync, signed releases (needs a signing certificate or service) and animation export (`EXTENSIBILITY_DESIGN.md`).

## Decisions

- **OD-PL-1 … OD-PL-41: decided by you** during the run (see `docs/DECISIONS.md`, marked `DECIDED (user)`).
- **OD-PL-42 … OD-PL-82: the recommended (most conservative) option was applied** at your request, for you to review in the app. Each entry in `docs/DECISIONS.md` lists the options and the one applied.

| Area | Decisions to review |
|---|---|
| Setup experiments (PL8) | OD-PL-42 – 53: lap assignment, ABBA plan (6 laps, 1 warm-up), evidence rule (5 laps, 2 stints each, ±50 ms floor), 3 % slow-lap rule, matched conditions (unknown → inconclusive), one running stint, game-update handling, driver decides at review, pages under Setups, this track's setups only, delete from archive only |
| HUD and live (PL9) | OD-PL-54 – 63: profiles off, post-lap summary off, live spread off, kill switch survives restart, three built-in layouts, stale thresholds 500 ms / 1 s, slow-write back-off, kill-switch access (no in-game key), spotter quiet time 0 s, cue time 6 s |
| Leaderboard (PL10) | OD-PL-64 – 73: tiers shown not ranked, canonical keys, flag thresholds, flags for moderators only, trail kept after deletion, removed laps never re-sent, deletion switches sharing off, rate limits in D1, any signed-in driver may report, reasons required in the tab |
| Data ownership (PL11) | OD-PL-74 – 82: scheduled backups off by default, weekly keep 4, free-space rule, skip cloud folders, delete a backup that fails its check, crash lap not kept, report extras only when ticked, demo in its own folder, animation export design only |

## What could not be verified here

- **In-game:** nothing was run in AC EVO. Shared-memory timing, HUD 0.15.0 in Gameface, the kill switch hiding the HUD, stale thresholds against real packet rates, and the game-version detection from the game log are all unverified.
- **Thresholds** in lap analysis, drills and experiments were tuned on synthetic and mock laps only.
- **CI** has not run (needs a push). **Cloudflare** (D1 migrations, Worker) was never contacted; D1-specific SQL was exercised on `node:sqlite` only.
- **Visual check:** colour changes (both themes) and new pages were checked by DOM and contrast tests, not by eye. No screen-reader run.
- **Large data:** multi-GB backups were not timed; the first open of Laps/Home with thousands of laps is still slow (your choice, OD-PL-11).
- The leaderboard is **not cheat-proof**: login proves identity, not lap authenticity; a fabricated lap with matching telemetry still passes.

## Follow-ups noted

- HUD bridge: re-check the time right before each slot write, for a very slow snapshot (PL9 review nit).
- Consistency page and AI coach context still read every lap of a car/track at once.
- Scheduled backups run `VACUUM INTO` on the main thread (only while idle); untimed on multi-GB databases.

## How to review

```
git log --first-parent --oneline main..platform/integration    # one merge per phase
git diff main...platform/integration --stat                    # everything
git diff 6e06801 aab645a                                       # one phase (here RB): previous merge → its merge
```

Per phase: `git diff <merge>^1 <merge>` using the merge commits in the table above. All `platform/*` branches are kept.
