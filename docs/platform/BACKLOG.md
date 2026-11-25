# Platform backlog (PL1–PL11)

Written in PL0 (2026-11-24) from the local operator plan (not in the repo) and the PL0 findings (`docs/platform/PL0-report.md`). This file is the in-repo summary of every phase's scope and refines the plan; where they differ, this file is the newer word, and anything beyond the plan is an open decision in `docs/DECISIONS.md`.

Priority: **P0** = data safety / must do next · **P1** = trust and reliability · **P2** = product value · **P3** = design only or optional.
Finding IDs (1.1-a …) refer to the PL0 report.

## Order and dependencies

```
PL1 ──> PL2 ──> PL3 ──> PL4 ──┬──> PL6 ──> PL7
                              ├──> PL8 (needs PL6 stats helpers)
                              ├──> PL9 (needs PL3 timing, PL6 for live consistency)
                              └──> PL5 (health panel from PL4.3; notes/tags need a migration)
PL10 (needs PL2 CI for the Worker tests; independent of PL4–PL9)
PL11 (needs PL1 backup inventory; scheduled backups need PL3 numbers for the on-track stall)
RB research reports: any time, no code
```

| Phase | Priority | Depends on | Size |
| --- | --- | --- | --- |
| PL1 Security and data safety | P0 | – | M |
| PL2 Quality and release checks | P0 | PL1 (its tests land first) | M |
| PL3 Recording reliability | P1 | PL2 (`npm run verify`) | M |
| PL4 Compatibility and provenance | P1 | PL3 (health data), P2 `src/channels.js` | M |
| PL5 Onboarding and usability | P2 | PL4.3 (health panel) | M–L |
| PL6 Actionable lap analysis | P1 | PL4.2 (compatibility classes) | L |
| PL7 Structured practice | P2 | PL6, P8/P9 | M |
| PL8 Setup experiments | P2 | PL6, PL4.2, P7 | M |
| PL9 HUD and live assistance | P2 | PL3, PL6 | M |
| PL10 Leaderboard integrity | P1 (code) / P3 (community) | PL2 | M |
| PL11 Data ownership | P2 | PL1, PL3 | M |

## PL1: Security and data safety (P0)

Refined scope, in commit order:

1. **Sensitive-settings inventory** (one module, e.g. `src/secrets.js`, or an export of `src/settings.js`): `geminiApiKey` (secret), `boardToken` (credential), `boardSteam` (identity, tied to the token), every `password` in `race.json` (secret). Used by `backup.stripSecrets`, `restore-apply.mergeSettings`, `diagnostics.privateValues`, `settings.publicView` and the server's protected fields (1.1-d). `restore-apply.js` cannot import app modules (it runs before `db.js`), so the inventory must be a dependency-free module.
2. **Backups:** strip `boardToken` and `boardSteam` in secret-free backups (1.1-a); `includesSecrets` and the part hints become accurate (1.1-b). Apply OD-PL-1 for "include secrets" and before-restore backups.
3. **Restore:** a restore never brings a sign-in from a backup; current sign-in handling per OD-PL-1 (1.1-c). Old backups that hold a token must still restore (the token is dropped on apply).
4. **Atomic JSON writes** for `settings.json` and `race.json` (temp + rename, as `src/mods.js:41`), and no silent fallback that overwrites an unreadable `settings.json` (keep the bad file aside) (1.3-n).
5. **Lap import** (1.2): `gunzipSync` with `maxOutputLength`; body cap for this route lower than 50 MB; schema check (format, version ≤ 1, `meta` fields and types, channel arrays of equal length, finite numbers, field ranges, sample-count and duration limits, `t` increasing, `d` non-decreasing, optional channels and `data.car` tolerated); duplicates per OD-PL-3; 400 with a plain message. The online lap download gets the same cap (1.2-f). Export per OD-PL-2 (1.2-g).
6. **Archives** (1.3-b/c): a byte-counting transform in `zip.extract` that stops at `entry.size`; a sanity cap on `cdSize`. Upload caps for mods and backups (1.3-d) only if a sensible ceiling exists (a laps database can be GBs: cap backups by `MAX_DB` + margin).
7. **Mod install overwrite** (1.3-g): move replaced files aside first and roll them back on failure.
8. **Low items:** setup import size check before parsing (1.3-i); Windows device names in mod/setup paths after a runtime test (1.3-f/h); Steam names in diagnostics redaction (1.3-o); restored `settings.json` normalised to known keys and types (1.3-k); sensitive GETs (`/api/backup/file`, exports, diagnostics) refuse cross-site requests with a `Sec-Fetch-Site` / `Origin` check like writes already have (`src/server.js:318-330`; 1.1-e).
9. **Deferred to backlog** (larger): crafted restored databases (1.3-l): analyse whether triggers/views matter; if so, rebuild the restored DB by copying tables.

Tests: one failing regression test per verified finding before its fix, plus the plan's list (provider keys, tokens, passwords, missing/legacy settings, round trips, manifests, bombs, mismatched arrays, duplicates, unsupported versions).

## PL2: Quality and release checks (P0)

- `.github/workflows/ci.yml` (windows-latest, Node 22, `npm ci`, check, test). YAML validated locally only; CI cannot run before a push (needs approval).
- **Add a job or script that runs `npm test` under Electron's Node** (`ELECTRON_RUN_AS_NODE=1 electron --test …`): the shipped runtime is Node 24.22.2, tests run on 22.x. If it can't be done cleanly, record the gap.
- `npm run verify` = check + test (+ optional packaged smoke when port 8080 is free).
- Packaged-app smoke script per CLAUDE.md step 6.
- Headless-Edge CDP flows (session, compare, import valid/invalid, settings, keyboard).
- `test/fixtures/README.md`; add an `engines` field (`node >=22.5`) only if it does not break `npm ci` for users.
- `npm audit` assessment written down; no blocking gate.

## PL3: Recording reliability (P1)

- Bounded diagnostics in the 60 Hz loop (`src/server.js:265-284`): interval jitter histogram, late/dropped frames, `monitorEventLoopDelay`, DB insert latency, post-lap work time.
- Scenarios on `--mock` with seeded large histories; method in `docs/platform/PERFORMANCE.md`; real shared-memory timing stays unverified.
- Known suspects to measure first (not to fix blind): synchronous `VACUUM INTO` backups (already refused on track), `zlib.gzipSync` of a lap on save, `listLaps()` full scans on report/goal paths, `JSON.parse` of report blobs.
- **Done 2026-11-24** (`docs/platform/PL3-report.md`, numbers in `docs/platform/PERFORMANCE.md`). The real bottleneck was none of the suspects but reading the lap history synchronously (HUD references, Laps/Home pages, session report, progress). Follow-ups left: the Consistency page and the AI coach still read every lap of a car and track in one go (full traces needed); lap save stays in the tick (OD-PL-10); first open of the Laps/Home pages with a long history (OD-PL-11); one-off catalogue read (~0.5 s) if a session starts in the first 3 s after Paddock starts.

## PL4: Compatibility and provenance (P1)

- 4.1: channel checks (`settings.channelChecks`) become records with game build (from `laps.cond` / game version), parser version (`src/shm.js` OFFSETS revision), method and time; old booleans migrate as "verified, build unknown" and are treated conservatively.
- 4.2: compatibility classes for Compare/Consistency/Progress/goals from car, track/layout, game version, setup identity (P7 snap), conditions (`cond`), aids (`laps.aids`), channel availability.
- 4.3: one health panel (game connection, telemetry freshness, recording, HUD + loader version, unverified channels, leaderboard reachability), reusing `/api/diagnostics` data.
- **Done 2026-11-25** (`docs/platform/PL4-report.md`): no DB change was needed (checks in `settings.json`, lap provenance in `laps.cond` / `setup_info` / `aids`). Compare, Consistency and Progress carry `compat`; goals do not yet (PL6/PL7 should use `src/compat.js`). Leaderboard reachability is the last known state only (no probe request).

## PL5: Onboarding and usability (P2)

- First-run flow over the existing pages (Home's empty state is the only welcome today). Session notes, tags, corner bookmarks: new tables with a versioned migration (`PRAGMA user_version` 2) and an old-DB fixture test.
- Accessibility pass on both themes; extend the P4 palette rather than adding a second command surface.

## PL6: Actionable lap analysis (P1)

- Extend `src/analysis.js` `cornerMetrics`/`techniqueMetrics` and `src/report.js`: ranked opportunities with entry/apex/exit split, brake release, throttle hesitation, gear choice, corner distributions, PB explanation, multi-session trend, repeatability target lap.
- `docs/platform/ANALYSIS.md`; fixtures with known answers; minimum-sample rules; PL4.2 classes respected.

## PL7: Structured practice (P2)

- Prescriptions (issue, evidence, exercise, success criterion, minimum evidence, review point) on top of P8 `training_plans` and P9 `goals`; works with AI off.

## PL8: Setup experiments (P2)

- Experiment object over P7 setup history (`setup_info.snap`): A/B stints, hypothesis, journal, matched-condition filter, descriptive stats, "inconclusive". `.carsetup` round trips unchanged; never applies setups to the game.

## PL9: HUD and live assistance (P2)

- HUD profiles, freshness indicator, cue cooldowns, post-lap summary, one kill switch; bridge stress test on the slot files (PL3 harness). Bump `mod/trainerhud/app.json` if the HUD changes. In-game behaviour unverifiable here.

## PL10: Leaderboard integrity (P1 code, P3 community)

- `docs/platform/LEADERBOARD_TRUST.md`; canonical IDs; verification tiers and legacy labels; anomaly flags; moderation audit trail; new D1 migration files only (`leaderboard/migrations/0003_…`), tested with `npm run board`. Never `board:schema`/`board:deploy`.
- Community features: `docs/platform/COMMUNITY_DESIGN.md` only; Needs approval.

## PL11: Data ownership (P2)

- Implement: scheduled verified backups (idle only; reuse `src/backup.js` and the PL1 inventory), retention, storage forecast, partial-session recovery, self-contained report export, replayable demo sessions (from `src/mock.js`).
- Design only: local read-only API, plugins, sync, signed releases/updates, animation export.

## RB: research reports

One short report each in `docs/platform/research/` (spotter/relative, race engineer, fuel/tyre strategy, automatic setup application, in-world ghost, championship results, competition-grade verification, mobile companion, multi-sim). No code.
