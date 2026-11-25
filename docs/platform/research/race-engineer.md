# Full race engineer: feasibility

Status: research only, nothing implemented. Nothing here was checked in AC EVO.

## Available interfaces
- **Player telemetry at 60 Hz** (fuel, tyre temperatures and pressures, brake temperatures, suspension, slip, lap times, pit flags): `src/shm.js:9-27` offsets, `:114-173` the frame. VERIFIED to exist in code; the tyre, brake, suspension and pit-box groups are marked "not yet checked in game" (`src/shm.js:11,13,24`; `docs/DEVELOPMENT_STATE.md` known problems). Treat them as UNVERIFIED.
- **Per-lap and per-session records, reports, conditions:** `src/recorder.js`, `src/report.js`, `src/carreport.js`. VERIFIED.
- **Voice/beep cues and HUD text:** `src/spotter.js` and the HUD bridge (`docs/platform/HUD_BRIDGE.md`). VERIFIED.
- **AI explanation:** `src/ai.js`, Gemini, user-supplied key, off by default. VERIFIED.
- **Command channel from the HUD to Paddock:** `[TrainerHUD-cmd]` log lines (`HUD_BRIDGE.md` section 2). VERIFIED.
- **Pit-stop control, strategy calls, radio, damage state, flags, race position, opponents:** no interface in the repo. UNKNOWN; do not assume.

## Restrictions
- Read only: Paddock cannot send inputs or change the car; that would need a game interface not known to exist.
- Online rules: some servers may restrict outside aids. The driver is responsible.
- No race-state channel (position, gaps, flags, damage) is known, so advice is limited to the player's own car.

## Failure modes
- Telemetry freezes while "live" (alt-tab, hitch): the HUD labels this stale after 500 ms (`HUD_BRIDGE.md` section 3); an engineer must go silent then.
- Advice built from unverified channels looks precise and may be wrong. Every message needs a data-quality gate and a visible basis.
- Audio overload while driving: cooldowns and one kill switch are required (PL9 rules).
- AI invention: a model may state numbers that were not measured; only deterministic evidence may be spoken.

## Proof-of-concept scope
A "pit-in digest" only: when the car enters the pit lane (`inPitLane`, `src/shm.js:165`), show 3 lines from existing per-lap data (tyre temperature spread, peak brake temperature, fuel used per lap), each labelled with its verification state. No live radio, nothing about other cars. Evaluate on about 10 real stints.

## Maintenance cost
High if it grows beyond the digest: each message is a claim about game behaviour and needs re-verification per build. The digest alone is low.

## Verdict
**Partly feasible, narrow.** A post-stint or pit digest on the player's own telemetry is realistic once the unverified channel groups are checked in game. A "full race engineer" (strategy, opponents, radio, pit control) is **not feasible** with the interfaces known today.
