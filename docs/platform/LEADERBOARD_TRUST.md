# Leaderboard trust model (PL10)

What the online leaderboard (`leaderboard/worker.js`, Cloudflare Worker + D1) can and cannot know about a lap, how each
lap is labelled, and how moderators act. Code: `leaderboard/worker.js`, `leaderboard/migrations/0003_integrity.sql`,
`src/leaderboard.js`, `public/leaderboard.js`. Tests: `test/leaderboard-integrity.test.js`, `test/leaderboard.test.js`.

> **Status:** written and tested against the local board only (`npm run board`, `leaderboard/local.mjs`). Migration
> 0003 is **not** applied to the live database and the PL10 Worker is **not** deployed (both need approval).

## 1. What a lap on the board proves

| Claim | Proven? | By what |
| --- | --- | --- |
| Who sent the lap | **Yes**, to the strength of a Steam sign-in | Steam OpenID 2.0, confirmed with Steam (`check_authentication`); the app gets a login token (only its SHA-256 is stored) |
| That the lap was driven in AC EVO, as sent | **No** | Nothing. The repo is public, the app holds no secret, and every field comes from the driver's PC |
| That the times are self-consistent | Yes | Sectors add up to the lap time (±2 ms), ranges, dates, sizes (`checkLap`) |
| That the light telemetry fits the lap | Yes, when telemetry is sent | Format, track length, lap time (±5 ms in the header, ±1.5 s at the last sample), speed range (`checkTel`) |
| That a lap is plausible against the field | Partly | Anomaly flags (section 4); a flag is a question for a moderator, not a verdict |

**Login proves identity, not lap authenticity.** A determined driver can send any self-consistent lap, with matching
telemetry, from a modified client or by hand. Client-side checks in Paddock (valid lap, sector split, conditions) catch
mistakes; they are not cheat-proof, and nothing a PC sends can be. The design goal is therefore not prevention but:
labels that never claim more than the evidence, cheap detection of the obvious, and moderation that is fair,
recorded and reversible.

## 2. Identity, telemetry and setup sharing stay separate

| Switch (Leaderboards tab) | Default | What it sends |
| --- | --- | --- |
| Steam sign-in | signed out | Nothing by itself; it lets laps be sent under the Steam name |
| Share my best laps (`boardShare`) | **off** | The fastest valid lap per track, layout, car and game version: name, times, sectors, temperatures, weather/grip (Race tab only), game and Paddock versions |
| With light telemetry (`boardTel`) | on, but only when sharing is on | Speed, pedals, steering, gear, revs and line every 2 m (about 10 KB) |
| Setups | never | No setup data goes to the leaderboard |

PL10 adds **no** new uploaded field (the payload whitelist in `src/leaderboard.js` `payload()` is unchanged; a test
pins its keys) and changes **no** default. `cond.reader` (PL4) stays local.

## 3. Canonical IDs

Boards group by canonical keys, computed by one SQL expression (`worker.js` `KEY`) used by the migration, every
insert and every query, so old and new rows always agree:

`lower(replace(replace(trim(name), ' ', '_'), '-', '_'))`, ASCII lower case; spaces and dashes become underscores.

- `track_key`, `layout_key`, `car_key` columns (migration 0003 fills them for existing laps).
- "Monza GP", "monza-gp" and "MONZA_GP" share one board. Query parameters are canonicalised the same way, so older
  Paddock versions keep working with raw names.
- The name shown is the first spelling stored (`MIN`); each driver's own row shows their own spelling.
- Car classes are canonical (`GT2`, `GT3`, `GT4`; `gt3` is read as `GT3`). A car keeps the class it was first sent with.
- Not merged: genuinely different names for the same car or track (e.g. a renamed car after a game update). That would
  need a curated alias table; see OD-PL-65.

## 4. Evidence tiers

Each lap carries a tier (`laps.tier`). Labels (in `worker.js` `TIERS` and the Leaderboards tab) say only what was
checked; none says "verified", "genuine" or "legit" (a test pins this).

| Tier | Label | Evidence | How a lap gets it |
| --- | --- | --- | --- |
| `legacy` | Legacy | The checks of the time ran, but nothing was recorded per lap | Every lap stored before migration 0003; a lap with no tier |
| `basic` | Format checked | Signed-in sender; times add up and are in range | A new lap without (accepted) telemetry |
| `telemetry` | Telemetry consistent | The above, plus its light telemetry passed `checkTel` | A new lap with telemetry that passed; or a `basic` lap re-sent with passing telemetry |
| `reviewed` | Reviewed | A moderator looked at the evidence and kept the lap | Moderator action `review`; `unreview` returns to the tier before the review (from the trail; `legacy` when unknown) |

A legacy lap is never upgraded automatically (its checks were not recorded). Tiers are shown, not used for ranking:
every non-hidden lap counts on its board as before (OD-PL-64).

## 5. Anomaly detection

Run once, when a lap is first stored (`anomalies()`), against the other drivers on the same car board (canonical
keys, not hidden, same game version when the lap has one). Thresholds are operator defaults (OD-PL-66) in `ANOMALY`.

| Flag | Rule | Evidence stored |
| --- | --- | --- |
| `tel_rejected` | Telemetry was sent but failed `checkTel` (the lap still counts, as before) | The reason |
| `far_ahead` | At least 3 other drivers, and the lap is more than 2 % faster than all their bests | Lap, board best, drivers, % |
| `sector_ahead` | At least 3 other drivers with the same sector count, and a sector more than 3 % faster than all their bests of that sector | Sector, time, board best, drivers, % |
| `clock_ahead` | The lap is dated more than 10 minutes after it was received | Driven / received times |

- Flags are stored on the lap (`laps.flags`, JSON) and logged once as a `flag` entry by `system`.
- **A flag never hides a lap** and is never shown publicly (board rows carry no flags; OD-PL-67). Moderators see them
  in the queue and in each lap's evidence.
- Known blind spots: the first laps on a new board (fewer than 3 other drivers), a slow but fabricated lap, a lap
  that is fast but within the thresholds, a board where everybody's laps are fabricated.

## 6. Moderation

Moderators are the SteamIDs in the `ADMINS` Worker secret (unchanged). Routes (all need a moderator's token):

| Route | What |
| --- | --- |
| `GET /v1/admin/reports` | The queue: reported **or** flagged laps; open ones first (not hidden, not reviewed), newest first; tier, flags, reports |
| `GET /v1/admin/lap?id=` | One lap's evidence: every field, canonical keys, flags, every report, its trail, the driver's first sign-in, lap count and suspension |
| `GET /v1/admin/log[?lap][&before][&limit]` | The moderation trail, newest first, paged |
| `POST /v1/admin/moderate {lapId, action, reason}` | `hide`, `show`, `review`, `unreview` |
| `POST /v1/admin/hide {lapId, hidden[, reason]}` | Older Paddock versions; same as `hide` / `show`, also logged |
| `POST /v1/admin/suspend {driver, suspended, reason[, hideLaps]}` | Suspend (no new laps or reports; reason required; optionally hide all their laps) or lift it |

Rules:

- **Hiding is the strongest action on a lap.** Moderators never delete laps (hidden laps can be shown again); only the
  driver can delete their own data (section 7).
- A moderator cannot suspend themselves. Suspensions live in their own table, so deleting an account does not lift one.
- In the Leaderboards tab every moderation action asks for a reason (the API accepts none for older clients; the trail
  records `null` then).

### The trail (`moderation_log`)

Append-only by construction: no route updates or deletes a row (a test checks that the log has no write route).
Each entry: time, actor (moderator SteamID, the driver for their own deletions, or `system` for flags), action
(`flag`, `hide`, `show`, `review`, `unreview`, `suspend`, `unsuspend`, `self_delete`, `account_delete`), lap id,
subject (the driver concerned), reason, and detail (state before and after, the lap's track/layout/car/time,
flags, lap counts). D1 has no row-level protection against someone with database access (Cloudflare dashboard,
`wrangler d1 execute`): the trail is tamper-evident only to the extent that those credentials are kept to the owner.
SQLite triggers that refuse UPDATE/DELETE were left out because the local runner splits migrations on `;` (D-PL10-3).

## 7. A driver's own data

| Route | What |
| --- | --- |
| `POST /v1/laps/delete {lapId}` | Removes one own lap, its telemetry and the reports on it. The trail keeps that it existed (combo and time) |
| `POST /v1/me/delete` | Removes the account: every lap and its telemetry, the reports they made and the reports on their laps, sign-in tokens and codes, and the name. Logged as `account_delete` with the lap count |

In Paddock: **Remove** on your own row of a board, and **Delete my online data** next to Sign out. Paddock marks the
local laps as removed, so they are never sent again by themselves (not even by Send all again); account deletion also
signs out and switches sharing off. Local laps are never deleted. Kept after deletion: the moderation trail entries
(they name the SteamID and the lap's combo and time, no telemetry) and a suspension (OD-PL-68).

## 8. Rate limits, auth and abuse handling

| Limit | Value | Where |
| --- | --- | --- |
| Laps sent per driver | 60 an hour | `laps` table (unchanged) |
| Reports per driver | 30 a day | `reports` table (unchanged) |
| Steam sign-in answers per IP | 20 an hour | `rate_limits` (each answer makes two requests to Steam) |
| Code-to-token swaps per IP | 30 an hour | `rate_limits` |
| Moderation actions per moderator | 120 an hour | `rate_limits` (limits the harm of a stolen moderator token) |
| Own-lap deletions per driver | 60 an hour | `rate_limits` |
| Account deletions per driver | 5 an hour | `rate_limits` |
| Request bodies | 256 KB for laps, 4 KB elsewhere | `readJson` (413) |
| Reasons | one line, 200 characters, control characters removed | `cleanReason` |

- IP addresses are used only as a 16-hex SHA-256 prefix of `ip|RATE_SALT` (`cf-connecting-ip`). **`RATE_SALT` is a
  required Worker secret:** an unsalted hash of an IPv4 address can be reversed by brute force, so without it the
  sign-in routes answer 503 and log an error, and `/v1/health` shows `configured.rateSalt: false`. The local runner
  makes a random salt at each start (`BOARD_RATE_SALT` to fix one). Rows older than two hourly windows are deleted
  (on about 1 in 20 counted requests).
- Auth: tokens are random 256-bit values, only their SHA-256 is stored, they expire after ~6 months and end on sign-out
  or account deletion. One-time login codes live 2 minutes and work once. The sign-in only returns to an address on the
  driver's PC. Sending a token from Paddock needs https (or a server on the PC).
- CORS stays `*`: every route that matters needs the bearer token, which browsers do not attach by themselves. In
  Paddock, `/api/board/admin/*` GETs are private (refused cross-site, `PRIVATE_GET`) because they carry reporters'
  SteamIDs; POSTs already were.
- Suspended drivers can still sign in, read boards and delete their own data; they cannot send laps or reports.
- Paddock against a server older than PL10: moderators' Hide / Show fall back to the old `/v1/admin/hide` (not
  logged there); Remove, Delete my online data, Evidence, Review and Suspend say "The leaderboard server doesn't
  support this yet"; the Evidence column shows "–" (no tier from the server), not Legacy.
- Not done (needs a decision or Cloudflare configuration): Cloudflare's own rate-limiting rules or WAF for read routes,
  a minimum account age or lap count before reporting, automatic hiding.

## 9. Deploy order (when approved)

1. Back up the live database (`wrangler d1 export`).
2. Apply `migrations/0003_integrity.sql` **once** (`npm run wrangler -- d1 execute acevo-paddock-leaderboard --remote --file migrations/0003_integrity.sql`).
   Its `ALTER TABLE` lines fail on a second run on D1 (only the local runner skips them). The old Worker keeps working
   on the migrated database (it ignores the new columns), but laps it stores in between get no keys and no tier.
3. **Required:** `npm run wrangler -- secret put RATE_SALT` (any long random text). Without it sign-in is refused.
4. `npm run board:deploy`. The PL10 Worker **needs** migration 0003 (it reads the new columns and tables). Check
   `/v1/health`: `version: 3`, `configured.rateSalt: true`.
5. Run `migrations/0004_backfill_keys.sql` (updates only, safe to run any number of times): it fills the keys and
   the `legacy` tier of laps the old Worker stored between steps 2 and 4. The PL10 Worker also does this by itself
   (`healKeys`, at most every 10 minutes per instance), so 0004 only makes it immediate.
6. Release a Paddock version with the new Leaderboards tab. Older Paddock versions keep working against the new Worker
   (same routes and fields; `/v1/admin/hide` is kept).

Rollback: redeploy the previous `worker.js`; the added columns and tables do no harm to it.
