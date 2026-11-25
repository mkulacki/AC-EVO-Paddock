# PL5 report: onboarding and usability

- **Branch:** `platform/pl5-onboarding` (from `4d25a15`, the PL4 merge). Not pushed, not merged.
- **Date:** 2026-11-25
- **Scope:** `docs/platform/BACKLOG.md` PL5: first-run flow, Home additions, session notes / tags / corner bookmarks (DB migration rules), empty states and error recovery, accessible colours, scalable text, visible focus, keyboard use, palette extension, beginner/advanced assessment.

## What changed

| Commit | What |
| --- | --- |
| `8dd13d6` | Schema v2 (`src/db.js`): `session_notes`, `session_tags`, `corner_bookmarks`, `user_version = 2` in one transaction, one `VACUUM INTO` copy per start before upgrading. `src/notes.js` (bounded inputs, summaries, tags, bookmarks), `src/onboarding.js` (guide state, new-driver rule, first comparison), `/api/notes*` and `/api/onboarding` (private GETs), `settings.onboarding`. `test/notes.test.js` against `test/fixtures/db-v1-0.7.0.sql` (the 0.7.0-beta.1 schema). |
| `9c5cf7b` | Home "now" row: last session (tags, note), practice objective, next step with "Why", recent progress (`src/service.js` `nextStep`, `progressSummary`; objective in `/api/dashboard`). |
| `344ff23` | Notes card on session pages (`public/notes.js`), tag chips and a tag filter on Sessions (`#/?tag=`), palette kinds Tag and Bookmark, kind-word fallback, empty-list fix. |
| `5713d78` | Setup guide `#/welcome` (`public/welcome.js`), auto-open for a new driver (`public/app.js` `start()`), health list shared with the Game page (`healthItemsHtml`), Settings entry, smoke tests. |
| `9e60e34` | Contrast tokens in both themes, focus ring on fields, empty states with actions, error card links, `test/a11y.test.js`, browser flows. |
| `88acad5` | Next step opens an unopened report of a long session; new bests counted only against laps from before the window; notes card closed by default. |
| docs commit | This report, `docs/DECISIONS.md` (D-PL5-1…14, OD-PL-19…24), `docs/PHASE_LOG.md`, `docs/DEVELOPMENT_STATE.md`, `docs/platform/BACKLOG.md`, `docs/ARCHITECTURE.md`, `docs/FEATURE_INVENTORY.md`, README, CHANGELOG, `test/fixtures/README.md`. |

New files: `src/notes.js`, `src/onboarding.js`, `public/notes.js`, `public/welcome.js`, `test/notes.test.js`, `test/a11y.test.js`, `test/fixtures/db-v1-0.7.0.sql`.

## Verified findings / rejected assumptions / unresolved

Line numbers refer to `4d25a15` unless marked.

- **Verified:** Home's empty state was the only welcome (`public/home.js:46-52`); it pointed to Race and Tracks only.
- **Verified:** the Sessions empty state suggested `npm run seed` / `npm run mock` (`public/sessions.js:106`), which a desktop-app user cannot run. Replaced.
- **Verified:** the palette's empty list was cut at 14 items (`public/palette.js:93`); since PL4 added "Integration health" as a 14th page, no session showed. Fixed.
- **Verified:** "setup …" as a first word always filtered to kind Setups (`public/palette.js:96-98`), so "setup guide" found nothing. Fallback added.
- **Verified:** WCAG AA failures: dark muted text 3.51:1 on surface-2, light muted 3.41:1 on the page, light `--t-pb` 3.96, `--t-slow` 3.81, `--slower` 3.46, light `--critical` (dark value inherited) 2.92, light `--accent-text` 4.32 (`public/style.css:24,37,61-66`). Fixed; `test/a11y.test.js` guards them.
- **Verified:** fields had `outline: none` with only a 1 px border colour change on focus (`public/style.css:92-93`). A ring was added.
- **Verified:** text scaling already worked in the desktop app (Ctrl +/−/0 in `desktop/main.cjs:76-78`) and the browser; it was not documented. Documented; reflow at 200 % tested.
- **Verified:** the existing migration mechanism (v1, `src/db.js:51-66`) is the recovery path; v2 reuses it. Paddock 0.7.0's `src/db.js` (from the tag) opened a v2 database with a note in it: laps read, `user_version` 2 left alone, note kept (by hand, scratch folder).
- **Rejected:** "notes need a new export path": lap files are built from lap rows only (`src/lapfile.js` `exportLapFile`), the leaderboard upload lists its fields, AI prompts are built from laps/reports: none read the new tables (smoke test checks Diagnostics, board status and the coach context).
- **Rejected:** "Home must read more history": all PL5 Home values come from lists `dashboard()` already built; notes are read from three small tables.
- **Unresolved:** behaviour of the guide with a real AC EVO install (game folder found, HUD installed, live laps on the drive step): checked on the mock source and scratch folders only.

## Beginner / advanced presentation: assessment (OD-PL-23)

The sidebar has 11 entries. A new driver needs Home, Race and Sessions; Leaderboards, Setups, Mods and the telemetry debug are advanced. Options: an off-by-default "Simple view" hiding advanced entries, or per-page "more detail" sections. Against building it now: hiding pages hurts discoverability (Alt+digit follows `NAV_ORDER`, so a filtered sidebar would either shift shortcuts or show gaps), and the guide plus Home's single next step already give beginners one path. Recommendation: not now; if wanted, (b) off by default with Alt+digit and Ctrl+K unchanged. Nothing built.

## Tests run and results

| Command | Before (`4d25a15`) | After |
| --- | --- | --- |
| `npm run check` | 124/124 | 130/130 |
| `npm test` (Node 22.23.4) | 280/280 | 299/299 |
| `npm run test:electron` (Node 24.22.2) | 280/280 | 299/299 |
| `npm run test:browser` (headless Edge) | 16/16 | 21/21 (×4 runs) |

New: `test/notes.test.js` (8: v1→v2 upgrade on the 0.7.0 schema, notes, limits, bookmarks, local-only, guide state, new-driver rule, first comparison), dashboard (+3), smoke (+2: notes API incl. cross-site refusal and not in diagnostics/coach context; guide API), shell (+1), `test/a11y.test.js` (5). Browser (+5): the guide for a new driver on a second fresh server, all steps by keyboard (Tab + Enter), AI/online/mods skipped (and undone), Finish → Home and not shown again; Skip the guide + Ctrl+K + Settings for an existing driver; Home next step by keyboard with a visible focus ring; notes/tags/bookmarks by keyboard, autosave on leaving, Sessions tag filter, Ctrl+K tag and bookmark; 200 % reflow on four pages.

## Checks that could not run, and why

- The guide and Home with AC EVO running, the HUD installed and real laps (no game here).
- The packaged app (`npm run smoke:packaged`) and `npm run bench` were not rerun: no change to the telemetry loop or packaging; the upgrade runs once at start.
- Screen readers were not tried; accessibility is checked by DOM assertions, computed styles and the contrast test. The UI was looked at in three headless screenshots (light theme).

## Performance or compatibility impact

- First start of this version on a database with laps: one `VACUUM INTO` copy (time and disk space about the size of `telemetry.db`, once), then the tables. Later starts: nothing.
- `/api/overview` and `/api/dashboard` read the three small notes tables; `/api/onboarding` runs a few indexed counting queries. Opening Paddock without a page address makes one extra small request.
- Downgrade: Paddock 0.7 opens a v2 file; it does not show notes, and they stay in the file.

## Migration and recovery implications

- v1 → v2 in one transaction; on failure nothing changes and Paddock stops with the error, as for v1.
- Recovery: the copy `data\telemetry.backup-v1-<time>.db` (rename over `telemetry.db` with Paddock closed), or a Settings backup. Restoring an older (v1) backup upgrades it again at the next start.
- The copy is not deleted by Paddock (OD-PL-21).

## Needs approval

- Push / merge of `platform/pl5-onboarding` (and the earlier platform branches).
- The colour token changes are a visible change in both themes (D-PL5-10): look at them in the app.

## Open decisions (added to DECISIONS.md)

OD-PL-19 notes in lap exports (default: never), OD-PL-20 notes in backups (default: yes), OD-PL-21 pre-upgrade copy (default: full copy), OD-PL-22 skipping game mods (default: records only), OD-PL-23 beginner/advanced (default: not now), OD-PL-24 when the guide opens (default: new driver only). D-PL5-1 … 14 to be confirmed.

## Remaining risks

- The full-copy backup before v2 can be slow and large for a multi-GB history (one time); if the disk is full the upgrade continues without it (logged).
- The next step is rule-based on one car and track; it can point at a comparison the driver has already studied. PL6/PL7 can make it richer.
- Notes autosave on leaving a page uses the page's cleanup; closing the window within 0.9 s of typing can lose the last characters.

## Recommended next phase

PL6 (actionable lap analysis): its ranked opportunities can feed Home's next step, and corner bookmarks can mark corners on the analysis. Gate with `npm run verify`.

## Review round (2026-11-25)

Independent review findings and the user's decisions, fixed on the same branch with a regression test each (`test/pl5-review.test.js`, plus additions to notes, dashboard, smoke and browser tests):

| # | Finding | Fix |
| --- | --- | --- |
| 1 | `deleteLap` (`src/db.js:157-162`) left a session's notes, tags and bookmarks behind; they stayed in Ctrl+K, the tag filter and "Earlier on this track and car". | User decision D-PL5-15: deleted with the session's last lap, in the same transaction; leftovers removed once at each start. |
| 2 | A database with `user_version` 3 was opened and written; restores compared with the live file's version (`src/backup.js:211`). | `user_version > SCHEMA_VERSION`: the file is closed unread and unchanged, Paddock runs on an empty in-memory database, Home and Integration health say why, backups/restores refused; restores compare with `SCHEMA_VERSION` (D-PL5-16). |
| 3 | `/api/overview` and `/api/dashboard` now carry tags and note lines but were not private GETs. | Added to `PRIVATE_GET` (D-PL5-17). |
| 4 | Notes POSTs used the 50 MB body default; long tag arrays were cleaned before being refused. | 64 KB cap; over-long lists refused first. |
| 5 | The next step's Progress fallback claimed "best matches ideal" without an ideal lap. | Says so only when both are known; otherwise "no ideal lap yet". |
| 6 | The pre-v2 copy was made only when `laps` had rows. | Made when any table has rows (plan rule 9). |

User decisions: OD-PL-19 (a), OD-PL-20 (a), OD-PL-21 (a), OD-PL-23 (a); **OD-PL-22 → (b)**: skipping game mods switches off the automatic HUD + App Loader install, using the existing `hud-removed` / `loader-removed` flags (new Settings → In-game HUD checkbox; existing users unchanged unless they turn it off; D-PL5-18). **OD-PL-24 → (c)**: the guide never opens by itself (Home's empty state, Sessions, Settings and Ctrl+K offer it). D-PL5-1 … 14 confirmed.

Commits: `5395369` (fixes 1, 2, 4, 6), `9abd626` (fixes 3, 4, 5, OD-PL-22 (b), OD-PL-24 (c)), plus the docs commit.

Tests after the review round: `npm run check` 131/131; `npm test` 306/306 (Node 22.23.4); `npm run test:electron` 306/306 (Node 24.22.2); `npm run test:browser` 21/21 in 3 runs.

Remaining: with a newer database Paddock still records into memory during that run (lost on exit, as the message says); a HUD already in the game folder when game mods are skipped stays until removed in the Mods tab.
