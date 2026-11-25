# Community features: design only (PL10)

**Status: not implemented. Needs approval** (backend changes, Cloudflare cost, privacy, moderation load). Nothing in
this document exists in the code. It describes how each feature would fit the current leaderboard
(`leaderboard/worker.js`, D1) and the trust model in `docs/platform/LEADERBOARD_TRUST.md`.

## Ground rules for every feature

1. **Opt-in, separately.** Each feature has its own switch, off by default. Signing in with Steam, sharing laps,
   sharing telemetry (and, if it ever comes, sharing setups) stay separate switches; joining a club or a season never
   switches any of them on.
2. **No new data by default.** Features read what is already on the board (lap and sector times, conditions,
   versions, light telemetry when shared). Anything new (a bio, a club name, a target) is typed by the driver, short,
   and deletable.
3. **Labels follow the evidence.** Results built from leaderboard laps carry the laps' evidence tiers and never call
   a result "official" or "verified". A championship computed from self-reported laps is a ranking of submitted laps.
4. **Deletion first.** Every feature is covered by `POST /v1/me/delete` before it ships: leaving deletes the
   driver's rows; the moderation trail keeps only what moderation needs.
5. **Moderation before scale** (see the prerequisites at the end).

## 1. Clubs

A named group of drivers with their own view of the boards (club-only rankings of the same laps).

- **Data model:** `clubs (id, name, owner_steam_id, created_at, visibility 'listed'|'unlisted', invite_hash)`,
  `club_members (club_id, steam_id, role 'owner'|'admin'|'member', joined_at)`. Club boards are a filter
  (`player_id IN members`) over `laps`; no lap is copied.
- **Privacy:** membership is visible to members only unless the club is listed; joining needs an invite link (the
  link holds a random code, only its hash is stored). Leaving or deleting the account removes the membership.
- **Cost:** two small tables; club boards are the existing board query with one more join. Within the D1 free tier
  for hundreds of clubs.
- **Moderation:** club names are user text: name filter + report button + moderator rename/remove, logged in
  `moderation_log` (`club_rename`, `club_remove`). Club owners can remove members (logged).

## 2. Seasonal championships

A season = a list of rounds (track, layout, car or class, game version, date window); points by place per round.

- **Data model:** `seasons (id, club_id|null, title, starts_at, ends_at, points TEXT, rules TEXT)`,
  `season_rounds (season_id, n, track_key, layout_key, car_key|null, car_class|null, game, opens_at, closes_at)`,
  `season_entries (season_id, steam_id, joined_at)`. Standings are computed from `laps` (best lap per entrant per
  round within the window, not hidden), cached per round after it closes (`season_results`).
- **Trust:** results are labelled "from submitted laps" with the tier mix shown (for example "8 of 12 laps telemetry
  consistent"). An organiser may require telemetry (`tier IN ('telemetry','reviewed')`) per season. A round closes
  for moderation 48 h after `closes_at` (reports and flags handled) before its result is frozen.
- **Privacy:** entering is explicit per season; standings show Steam names already public on the boards.
- **Cost:** standings queries are bounded by the round window; cached results keep reads cheap.
- **Moderation:** organisers can disqualify an entry in their season (logged, with reason); moderators override.

## 3. Skill bands

Drivers grouped by pace (for example within 101 %, 103 %, 106 % of the board's reference) so a newcomer sees
peers, not only P1.

- **Data model:** none stored. Bands are computed per board from the existing rows (percentiles of each driver's
  best); shown in the app next to the board.
- **Trust:** a fabricated fast lap moves the reference: bands use the median of the top 5 drivers, not P1, and
  ignore flagged-but-unreviewed laps.
- **Privacy:** no new data. **Cost:** none on the server (computed in Paddock from `/v1/board`).
- **Moderation:** none beyond the boards'.

## 4. Improvement competitions

Ranked by improvement, not pace: "most time found at Spa in the GT3 over two weeks".

- **Data model:** `competitions (id, club_id|null, title, track_key, layout_key, car_key|car_class, game, starts_at,
  ends_at, metric 'best_delta'|'median_delta')`. Needs each entrant's baseline at the start: the best lap before
  `starts_at` (from `laps`) and the best within the window. `median_delta` would need more than one lap per driver on
  the server, which today stores mostly bests: **not possible without sending more laps**, which is a privacy and
  cost change. Only `best_delta` fits the current data.
- **Trust:** improvement is the easiest metric to game (a deliberately slow baseline). Mitigations: the baseline must
  be older than the competition announcement; entrants need a baseline lap from before `starts_at`; deltas over a
  set limit (for example 5 %) are flagged for review.
- **Privacy:** opt-in per competition. **Cost:** small.

## 5. Reference packs

A curated set of laps (with light telemetry) for a track and car, for drivers to compare against: "a clean lap at
each pace band".

- **Data model:** `packs (id, title, track_key, layout_key, car_key, game, curator, created_at)`,
  `pack_laps (pack_id, lap_id, note)`. Laps stay in `laps`/`telemetry`; a pack references them.
- **Consent:** a lap enters a pack only if its driver allowed it: a new per-lap or per-account switch "my shared
  laps may be used in reference packs" (off by default). Removing the lap or the account removes it from packs.
- **Trust:** only `telemetry` or `reviewed` laps; the curator reviews each one (logged).
- **Cost:** telemetry downloads are already cached for a day (`cache-control`); packs add reads, not storage.

## 6. Privacy-controlled profiles

Today `/v1/driver?id=` shows every car board a driver is on, to anyone. A profile adds control.

- **Data model:** `profiles (steam_id, visibility 'public'|'boards_only'|'hidden', bio TEXT(200), country TEXT(2),
  updated_at)`. `hidden` keeps the driver's rows on boards (they chose to share laps) but removes the profile page
  and the driver link; `boards_only` shows boards without bio/country.
- **Privacy:** default `boards_only` for new profiles, matching what is shown today, so nothing becomes more visible
  by itself. Bio and country are optional, typed by the driver, deletable.
- **Moderation:** bio is user text: report + moderator clear (logged).
- **Cost:** one small table.

## 7. Discord summaries

A daily or weekly summary of new records and changes on chosen boards, posted to a Discord channel by webhook.

- **Data model:** `webhooks (id, club_id, url_encrypted, boards TEXT, schedule, created_by)`. The webhook URL is a
  secret: stored encrypted with a Worker secret, never returned by any route, deletable by the club owner.
- **How:** a Cloudflare Cron Trigger reads changes since the last run (`received_at`) and posts one message per
  webhook. Names are the public Steam names already on the boards; only laps not hidden and older than the moderation
  delay (for example 6 h) are posted, so an obvious fake is less likely to be announced.
- **Privacy:** only drivers who share laps appear; a driver with a `hidden` profile is named "a driver".
- **Cost:** a cron run a day, a few D1 reads and one outgoing request per webhook. Discord rate limits apply (one
  message per webhook per run).
- **Moderation:** a summary can be wrong if a lap is hidden later; the next summary says so.

## Cost estimate (all features, order of magnitude)

Current use is far inside the Workers free tier (100 000 requests a day) and the D1 free tier (5 GB, 5 M rows read
a day). The features above add small tables and bounded queries. The expensive parts would be: improvement
competitions with more than best laps (more laps stored: a change to what Paddock sends, so out of scope),
reference-pack telemetry downloads at scale (cached), and season standings without caching. If use grows past the
free tiers, the Workers paid plan (about USD 5 a month at the time of writing, check Cloudflare's current pricing)
covers this design many times over. **Any paid plan needs the owner's approval.**

## Moderation prerequisites (before any of this ships)

1. PL10 deployed: migration 0003, tiers, flags, the moderation trail, suspensions, rate limits, own-data deletion.
2. More than one moderator, and a written moderation policy (what is hidden, how to appeal, how long the trail is
   kept), linked from the Leaderboards tab.
3. An appeal path (an email or a form) and a response time the owner can keep.
4. Moderator tooling for user text (club names, bios, season titles): report, rename/clear, logged.
5. `RATE_SALT` set; Cloudflare rate-limiting rules on public read routes if traffic grows.
6. A backup routine for the D1 database (`wrangler d1 export`) and a tested restore.
7. A deletion test for each new table, added to the account-deletion route before the feature ships.

## Needs approval

Each feature above: backend tables and routes, Cloudflare cost beyond the free tier, any new data sent from
Paddock (reference-pack consent switch, profile fields), and the moderation policy. None is implemented.
