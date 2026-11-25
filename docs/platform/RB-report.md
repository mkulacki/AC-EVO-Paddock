# RB report: research backlog

Branch `platform/rb-research`, 2026-11-25. Documents only; **nothing was implemented**, no game, network or user data was touched.

## What was written
Nine feasibility reports and an index in `docs/platform/research/` (`README.md`). Each lists interfaces (VERIFIED with a repo `file:line`, or ASSUMED/UNKNOWN), restrictions, failure modes, a proof-of-concept scope, maintenance cost and a verdict. Sources: `src/shm.js`, `src/gamebridge.js` and `HUD_BRIDGE.md`, `src/carsetup.js` and `src/setups.js`, `leaderboard/` and `LEADERBOARD_TRUST.md`, `EXTENSIBILITY_DESIGN.md`, `COMMUNITY_DESIGN.md`. Statements about other simulators are marked ASSUMED. Commit: `d05af7d` plus the report commit.

## Verdicts
| Topic | Verdict |
| --- | --- |
| Opponent spotter / live relative | Feasible for position-only gaps, unverified; start with a slot dump |
| Full race engineer | Narrow pit/stint digest only; full engineer not feasible |
| Fuel / tyre strategy | Fuel feasible after an in-game check; tyre wear prediction not |
| Automatic setup application | Files done; live apply has no known interface |
| In-world ghost car | 3D not feasible; 2D gap bar and map dot feasible |
| Authoritative championship results | Not from client data; organiser-entered only, needs approval |
| Competition-grade verification | Not by software alone; tiers and review exist |
| Mobile companion | Feasible, security-heavy; after the localhost API |
| Multi-sim | Possible, not recommended now |

## Findings worth keeping
- The only per-opponent data known in the repo is world coordinates and ids (`src/shm.js:22`); everything else about other cars is unknown.
- Several proofs depend on the shared-memory groups still unchecked in game.

## Tests
`npm run check` and `npm test`: see the PHASE_LOG entry (no code changed).

## Needs approval
Nothing was prepared. Any proof-of-concept above needs a user decision first; the championship and mobile items also need backend, cost and security approval.
