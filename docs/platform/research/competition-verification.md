# Competition-grade verification: feasibility

Status: research only, nothing implemented. Nothing here was checked in AC EVO.

## Available interfaces
- **What exists today:** a trust model where login proves identity and not lap authenticity; format checks; telemetry consistency; anomaly flags; a reviewed tier; an auditable moderation trail (`docs/platform/LEADERBOARD_TRUST.md` sections 1, 4-6; `leaderboard/worker.js` `TIERS`, `checkLap`, `checkTel`, `anomalies`). VERIFIED. Tier labels deliberately say only what was checked.
- **Client evidence Paddock can attach:** game version, setup identity, conditions, telemetry trace, the `validLap` flag (`src/shm.js:166`). VERIFIED as recorded.
- **Game- or server-signed attestation of a lap:** no such interface is known. UNKNOWN.
- **Replay files, anti-cheat hooks:** nothing in the repo. UNKNOWN.

## Restrictions
- The repo is public and the app holds no secret, so any client-side check can be reproduced by a modified client (`LEADERBOARD_TRUST.md` section 1). No client check can be called cheat-proof.
- Competition-grade needs evidence the driver cannot fabricate: a game-signed result, an organiser-run server, or human review of full replay or video. None is available through known interfaces.
- Heavier evidence (video, full telemetry) raises privacy, storage and cost, each a separate approval.

## Failure modes
- False confidence: a "verified" badge on self-reported data. Tier names are pinned by a test not to say verified or genuine.
- False positives: statistical flags need 3 other drivers on a board and can punish unusual but real laps; moderators need the evidence view and a reversible trail.
- Moderator load grows with the field; rate limits exist but nothing has run against Cloudflare yet.

## Proof-of-concept scope
Document a ladder, not a product: today's tiers; reviewed with telemetry; reviewed with replay or stream evidence supplied by the driver; organiser-hosted session. Test only the review workflow on the local board (`npm run board`) with synthetic laps. The first realistic trial would be a single organised event with human stewards.

## Maintenance cost
High and human: stewards, appeals, evidence storage. The code is the smaller part.

## Verdict
**Not feasible by software alone.** Paddock can offer honest labelled evidence tiers and a review workflow (built, not deployed); "competition-grade" needs a source of truth outside the driver's PC that is not known to exist.
