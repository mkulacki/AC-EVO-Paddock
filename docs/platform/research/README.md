# Research backlog (RB): feasibility reports

Reports only; nothing was implemented or run against the game. Interfaces are marked VERIFIED (with a repo `file:line`) or ASSUMED/UNKNOWN. Verdicts are assessments, not commitments.

| Report | One-line verdict |
| --- | --- |
| [opponent-spotter.md](opponent-spotter.md) | Position-only gaps possible from car coordinates, unverified; start with a read-only dump of the 60 slots. |
| [race-engineer.md](race-engineer.md) | Only a narrow pit/stint digest on the player's own data is realistic; a full engineer is not. |
| [fuel-tyre-strategy.md](fuel-tyre-strategy.md) | Fuel per lap feasible after one in-game check; tyre wear prediction not; descriptive tyre views only. |
| [auto-setup-apply.md](auto-setup-apply.md) | Writing setup files is done; applying to the running game has no known interface. |
| [ghost-car.md](ghost-car.md) | 3D in-world ghost not feasible; a 2D ghost gap bar and map dot is. |
| [championship-results.md](championship-results.md) | Not authoritative from client data; only organiser-entered results with Paddock evidence, needs approval. |
| [competition-verification.md](competition-verification.md) | Not achievable by software alone; honest tiers and review exist, a trusted external source does not. |
| [mobile-companion.md](mobile-companion.md) | Feasible but security-heavy; after the localhost API, read-only LAN reports first. |
| [multi-sim.md](multi-sim.md) | Possible at the telemetry layer; not recommended, against the EVO-native data decision. |

Related: `docs/platform/HUD_BRIDGE.md`, `docs/platform/LEADERBOARD_TRUST.md`, `docs/platform/EXTENSIBILITY_DESIGN.md`, `docs/platform/COMMUNITY_DESIGN.md`.
