# Product audit

Date: 2026-11-17 · Repo: `mkulacki/AC-EVO-Paddock` · Branch audited: `main` @ `de836d2` (v0.5.0-beta.1, clean working tree).

## Summary

AC EVO Paddock is a mature, local-first Windows app (Electron + Node, vanilla JS frontend, SQLite). It already covers most of the "telemetry engineering" and "garage" parts of the requested list, and adds things the list doesn't mention: a Content-Manager-style launcher, an in-game HUD, an audio spotter and a mod manager. The real gaps are:

1. **No automated tests.** Every release relies on manual checks.
2. **Data provenance.** Part of the car data (tyre block, suspension, slip angles, setup fingerprint, temperatures) comes from unverified shared-memory offsets, but the Car & setup report already draws conclusions from them (understeer/oversteer, tyre windows). Some text says "to be confirmed in game"; AI output carries no confidence.
3. **No overview.** There is no home dashboard, no global search or command palette, and no cross-combo records, warnings or next actions in one place.
4. **Application management.** No backup/restore, no bulk export, no diagnostics bundle, no update notification.
5. **Missing analysis layers.** No driving-style metrics, no setup history or comparison, and no long-term goals or training plans.

## Baseline (2026-11-17)

| Check | Result |
| --- | --- |
| Syntax check (CLAUDE.md step 2, all JS files) | pass, 0 failures |
| `npm run seed` (10 mock laps, scratch data dir) | pass |
| `server.js --mock 4`, GET `/`, `/api/status`, `/overview`, `/reports`, `/tracks`, `/cars`, `/game`, `/mods`, `/settings`, `/progress`, `/compare`, `/consistency`, `/report`, `/carreport`, `/ai/summary` | all 200 (compare payload 337 KB in 32 ms; tracks 1.0 s on first read of content.kspkg) |
| Automated test suite | none exists |
| Lint / type check | none configured |
| Electron build | not run in the audit (no code changed); covered in P1/P10 |
| Node | v22.23.4 |

Note: the mock run reads (read-only) the real game catalogue and `Saved Games\ACE\mods` for the car list. It writes nothing there unless `ACE_BRIDGE` is set.

## Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Unverified shared-memory offsets drive setup advice | wrong advice presented as fact | P2 provenance registry + labels; verification needs one in-game session by the user |
| No tests | regressions in the analysis, migrations or setup file writer (which writes the game's files) | P1 first |
| Game crash on file access (live files, mods) | game crash | hard constraints in ARCHITECTURE.md; no phase touches the bridge timing |
| AC EVO updates change formats (kspkg, carsetup, loader) | features break after a game update | existing fallbacks + read-back checks; release checklist step 1 |
| `server.js` / `app.js` growth | slower changes, merge conflicts | split gradually when a phase touches them (P4 splits the Sessions page) |
| Gemini free-tier limits / API changes | AI features fail | handled errors, compact context; AI stays optional |
| Restore/backup handling user data | data loss | automatic pre-restore backup, swap at restart, round-trip test |

## Technical dependencies

- P1 (tests) → all later phases.
- P2 (provenance) → P5 warnings, P6 labels, P7 engineer input, P8 AI confidence.
- P4 (shell/states) → P5 home.
- P6 (style metrics) + P7 (setup split) → P8 (AI coach context).
- P5 + P8 → P9 (goals and plans on the home page).

See [IMPLEMENTATION_ROADMAP.md](IMPLEMENTATION_ROADMAP.md) for the phases, [FEATURE_INVENTORY.md](FEATURE_INVENTORY.md) for the per-feature status, and [ARCHITECTURE.md](ARCHITECTURE.md) for the system.
