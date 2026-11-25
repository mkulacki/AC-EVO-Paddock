# PL10 report: leaderboard integrity (community = design only)

- **Date:** 2026-11-25 · **Branch:** `platform/pl10-leaderboard-integrity` (from `d2d4564`, the PL9 merge) · not pushed, not merged, **not deployed**
- **Scope:** `docs/platform/BACKLOG.md` (PL10). Trust model and rules: `docs/platform/LEADERBOARD_TRUST.md`. Community: `docs/platform/COMMUNITY_DESIGN.md`.

## What changed

| Commit | What |
| --- | --- |
| `e9e30c4` | Server: `leaderboard/migrations/0003_integrity.sql` (new file: canonical keys, `tier` with `legacy` for existing laps, `flags`, `players.first_seen`, `moderation_log`, `suspensions`, `rate_limits`); `leaderboard/worker.js`: evidence tiers, canonical keys for boards / combos / versions / profiles, anomaly flags, moderation queue / evidence / trail / moderate / suspend, own-lap and account deletion, per-IP and per-moderator rate limits, body caps, reason cleaning; `leaderboard/README.md`; `test/leaderboard-integrity.test.js` |
| `59d5009` | App: `src/leaderboard.js` (trust note, moderation and deletion calls, removed laps never re-sent, tier kept locally), `public/leaderboard.js` (Evidence column, trust sentence, moderation queue with flags / evidence / trail / suspension, reasons, Remove, Delete my online data), `src/server.js` routes, `test/leaderboard.test.js` |
| `b7a260c` | Fix: the `PRIVATE_GET` pattern for `/api/board/admin` (`59d5009` broke `src/server.js` syntax: an unescaped `/` in the regex); smoke test for the private moderation GETs |
| `49d854e` | Docs: `LEADERBOARD_TRUST.md`, `COMMUNITY_DESIGN.md`, `DECISIONS.md` (D-PL10-1 … 7, OD-PL-64 … 73) |
| `58649b3` | This report, `PHASE_LOG.md`, `DEVELOPMENT_STATE.md`, `CHANGELOG.md`, `BACKLOG.md` |
| `d3f3a93` | Review fixes (code): `migrations/0004_backfill_keys.sql`, `worker.js` `healKeys`, `RATE_SALT` required, account-deletion limit; app fallbacks for an older server; tests |
| (this commit) | Review fixes (docs): deploy steps in `LEADERBOARD_TRUST.md` §9 and `leaderboard/README.md`, DECISIONS, this report, CHANGELOG |

## Verified findings / rejected assumptions / unresolved

Static inspection of `d2d4564` plus the local board (no live server was contacted):

- **Verified: login proves identity only.** Every lap field comes from the client (`leaderboard/worker.js:45-68` at `d2d4564`, `checkLap`); the only proof is the Steam sign-in (`authed`, `:285-291`). Now stated in `LEADERBOARD_TRUST.md` §1 and on the board.
- **Verified: no record of what was checked per lap.** Laps had no evidence field; hiding was a bare `UPDATE` with no trail (`worker.js:257-266` at `d2d4564`). Fixed: tiers, `legacy` for existing laps, `moderation_log`.
- **Verified: boards split on spelling.** Boards, combos, versions and profiles grouped by raw `track/layout/car` (`worker.js:136, 174-177, 183, 194-200` at `d2d4564`); "Monza" and "monza" were two boards. Fixed with canonical keys (OD-PL-65). Whether real AC EVO names ever differ in spelling is **unresolved** (needs the live data; not queried).
- **Verified: request bodies were read uncapped** (`req.json()` in `submit`, `report`, `adminHide`, `authToken`; `worker.js:107, 233, 261, 362` at `d2d4564`); Cloudflare's own limit (100 MB) applied. Fixed: 256 KB / 4 KB (413).
- **Verified: sign-in routes had no limit.** Each Steam callback makes two outgoing requests (`worker.js:343, 348`) with no per-IP limit. Fixed (OD-PL-71).
- **Verified: drivers could not delete their online data** (no route). Fixed: `/v1/laps/delete`, `/v1/me/delete`.
- **Verified: reports from any signed-in driver, 30 a day** (`worker.js:239-240`). Kept (OD-PL-72), plus suspension.
- **Rejected: "client validation stops cheating".** No such claim was in the code or UI; the client now says the opposite (`src/leaderboard.js` header).
- **Verified: the upload is a whitelist** (`src/leaderboard.js:105-115` at `d2d4564`). Unchanged; a test pins its keys.
- **Unresolved:** how many live laps would be flagged by OD-PL-66 (the live database was not read); whether D1's `lower()` is ICU-aware (avoided by D-PL10-2).

## Tests run and results

| | Before (`d2d4564`) | After |
| --- | --- | --- |
| `npm run check` | 154/154 | 155/155 |
| `npm test` (Node 22.23.4) | 426/426 | 436/436 |
| `npm run test:electron` (Node 24.22.2) | 426/426 | 436/436 |
| `npm run test:browser` | 26/26 | 26/26 |

- New: `test/leaderboard-integrity.test.js` (9 tests: migration on an older database twice, SQL/JS key agreement, tier labels in the Worker and the tab, tiers, canonical keys, anomalies, moderation trail, suspension, deletion, rate limits and body caps, IP hashing), one app test in `test/leaderboard.test.js` (payload keys unchanged, tier, removed lap never re-sent, account deletion), private-GET smoke assertions.
- One run of the full `npm test` had one failure in the PL9 stress test `hud-bridge.test.js` ("a reader thread … with stalls and slow writes", timing under load); it passed in 3 separate runs and in the next full run (436/436). Not touched by PL10.
- Local board started by hand: `BOARD_PORT=8799`, `BOARD_DB` in a scratch folder: `/v1/health` → version 3, empty board, `/v1/admin/log` without a token → 403, all new tables created. Stopped afterwards.

## Checks that could not run, and why

- Live leaderboard (Cloudflare Worker, D1): not contacted by rule. Migration 0003 never ran against D1; D1-specific behaviour (`RETURNING`, `ON CONFLICT … DO UPDATE`, window functions, row-value `IN`) is tested on node:sqlite only.
- Real Steam sign-in (faked in the tests), real `cf-connecting-ip` values, Cloudflare rate-limiting rules.
- Packaged-app smoke: not run.
- The Leaderboards tab was not opened in a browser by hand; the browser flows (26) do not cover it.

## Performance or compatibility impact

- Each new lap costs 2–3 more D1 queries (anomaly comparison on the same board, one tier read); moderation and sign-in routes one `rate_limits` upsert each. Boards use the new `laps_board_key` / `laps_class_key` indexes.
- Older Paddock versions keep working against the PL10 Worker: same routes and fields, raw names accepted, `/v1/admin/hide` kept. The PL10 Worker does **not** run on a database without migration 0003.
- The new Paddock works against the old Worker for everything it did before; the new moderation and deletion buttons get a 404 until the Worker is deployed (shown as an error message).

## Migration and recovery implications

- Paddock's local database: unchanged (no schema change; `laps.board` JSON gains `tier` and `removed`).
- D1: `0003_integrity.sql` is additive (columns, tables, indexes, `UPDATE … WHERE … IS NULL`) and runs **once** on D1 (its `ALTER TABLE` lines fail a second time; only the local runner skips them). `0004_backfill_keys.sql` (updates only) can run any number of times. Recovery: `wrangler d1 export` before applying; rollback = redeploy the old `worker.js` (it ignores the additions). Deploy order in `LEADERBOARD_TRUST.md` §9 (backup, 0003 once, `RATE_SALT`, deploy, 0004).

## Needs approval (prepared, NOT executed)

1. **Apply D1 migration `leaderboard/migrations/0003_integrity.sql` to the live database, once** (after a `wrangler d1 export` backup). **Not executed.**
2. **Set the Worker secret `RATE_SALT`** (required: without it sign-in is refused). **Not executed.**
3. **Deploy the PL10 Worker** (`npm run board:deploy`), then run `leaderboard/migrations/0004_backfill_keys.sql`. **Not executed.** Needs steps 1 and 2 first.
4. Push / merge of `platform/pl10-leaderboard-integrity`, and a Paddock release with the new Leaderboards tab.
5. Community features (clubs, seasons, skill bands, improvement competitions, reference packs, profiles, Discord summaries): design only in `COMMUNITY_DESIGN.md`; each needs backend, cost and privacy approval and the moderation prerequisites listed there.

## Open decisions (added to DECISIONS.md)

OD-PL-64 … 73, all **OPEN (operator), recommended default applied, user reviews in the app**: tiers shown not ranked (64), canonical keys from names (65), anomaly thresholds (66), flags private and never hiding (67), trail and suspension kept after deletion (68), removed laps never re-sent (69), account deletion switches sharing off (70), rate-limit values (71), who may report (72), reasons asked in the tab, optional in the API (73). Technical: D-PL10-1 … 7.

## Remaining risks

- Fabricated, self-consistent laps with matching telemetry pass every check; tiers say so, but drivers may still read "Telemetry consistent" as more than it is.
- Flags are compared only with drivers already on a board; the first laps on a new board are never flagged.
- The trail is append-only by code only; anyone with D1 access can change it.
- Canonical keys could merge two names that are really different cars (only case, spaces and dashes differ); not seen in tests.
- Forgetting `RATE_SALT` turns sign-in off (503) until it is set; `/v1/health` shows it.
- The PL9 bridge stress test is timing-sensitive under load (one failure in one run).

## Review round (2026-11-25)

| Finding | Fix |
| --- | --- |
| The deploy note said to run 0003 again; its `ALTER TABLE` lines fail a second time on D1, leaving laps stored by the old Worker without keys | `0004_backfill_keys.sql` (updates only, tested 3× on node:sqlite); `worker.js` `healKeys` fills missing keys itself every 10 minutes at most (tested); README and §9: backup → 0003 once → `RATE_SALT` → deploy → 0004 |
| Moderators lost Hide / Show against the old Worker (no `/admin/moderate`) | `adminModerate` falls back to `/v1/admin/hide` on a 404 (tested with a fake old server) |
| A 404 from the old Worker showed "not found" | Remove, Delete my online data, Evidence, Log, Review and Suspend say "The leaderboard server doesn't support this yet (it needs the new server version)" |
| Every row read "Legacy" against the old Worker | No tier from the server shows "–" ("Not reported by the server") |
| `RATE_SALT` optional; account deletion unlimited | `RATE_SALT` required (sign-in 503 without it, health reports it; the local runner salts itself); account deletion 5 an hour. `report()` already refused suspended drivers (now tested) |

Tests after the review: `npm run check` 155/155; `npm test` 439/439; `npm run test:browser` 26/26.

## Recommended next phase

PL11 (data ownership: scheduled verified backups, retention, crash recovery, reports, demo sessions). Before that, the user reviews PL10 and decides on the migration and deploy (Needs approval 1–3).
