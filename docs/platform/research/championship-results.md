# Authoritative championship results: feasibility

Status: research only, nothing implemented. Nothing here was checked in AC EVO.

## Available interfaces
- **Client-side race data:** laps, session type and weekend grouping of Paddock's own launches (`src/weekends.js:12-48`, `src/race.js`). VERIFIED. They describe the local driver only.
- **Online leaderboard Worker:** Cloudflare Worker with D1 (`leaderboard/worker.js`, `leaderboard/migrations/`). Steam sign-in proves identity (`docs/platform/LEADERBOARD_TRUST.md` section 1). VERIFIED. It stores laps, not race results.
- **Server-side race results from the game or a dedicated server** (positions, penalties, DNFs): no feed in the repo. UNKNOWN whether AC EVO writes a results file or has a server API.
- **Community design** for clubs and seasonal championships: `docs/platform/COMMUNITY_DESIGN.md`, design only, needs backend and cost approval. VERIFIED that it exists.

## Restrictions
- "Authoritative" needs a source only the organiser controls: the game server's own result output or a human steward. Anything uploaded from a driver's PC is client-supplied and can be edited (`LEADERBOARD_TRUST.md` section 1).
- Penalties, disqualifications and points rules are human decisions; software would record them, not decide them.
- Privacy and moderation prerequisites come first (COMMUNITY_DESIGN).

## Failure modes
- Treating uploaded results as official lets a modified client rewrite a championship.
- Disputes without an audit trail: the moderation trail covers laps only (`LEADERBOARD_TRUST.md` section 6).
- Partial standings when a driver does not run Paddock.
- Season data lost without backups; D1 changes need migrations and approval.

## Proof-of-concept scope
1. With the game and a hosted or dedicated server, find out whether any results file or log is written and what it holds. Keep a sample; parse nothing until it has been seen.
2. A manual "steward entry" model: an organiser enters results, and drivers' own sessions attach as non-authoritative evidence. Design only, as an extension of COMMUNITY_DESIGN.
3. No leaderboard schema change before step 1.

## Maintenance cost
High: moderation, disputes, hosting, cost, and a result-source format that follows game updates.

## Verdict
**Not feasible as authoritative from client data.** Feasible only as an organiser-entered championship with Paddock data as supporting evidence, and only if a trustworthy results source is found. Needs approval for backend and cost.
