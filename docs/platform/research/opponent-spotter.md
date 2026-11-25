# Opponent spotter and live relative: feasibility

Status: research only, nothing implemented (RB, 2026-11-25). Nothing here was checked in AC EVO.

## Available interfaces
- **Car world coordinates, per car (x, y, z):** `graphics.carCoordinates` (offset 3124, 12 bytes per car) with `carIds` (offset 3940, 16 bytes per car, scanned for 60 slots). VERIFIED in code: `src/shm.js:22` (offsets), `src/shm.js:125-129` (Paddock reads only the player's slot). Offsets come from a community header (`src/shm.js:2`) and are not guaranteed across game builds.
- **Player's normalised track position:** `npos` (`src/shm.js:20`, read at `:165`). VERIFIED in code for the player only.
- **Opponent speed, lap, gap, name, class, pit state:** no offsets exist in the repo. UNKNOWN; do not invent them.
- **Track model to project coordinates onto a distance:** Paddock builds its own from recorded laps (`src/track.js`, `src/trackdata.js`). VERIFIED that it exists; fit for opponents is untested.
- **Delivery to the HUD:** `src/gamebridge.js` slot files, 16,384 bytes each, one write per 50 ms window (`docs/platform/HUD_BRIDGE.md` section 2). VERIFIED, but a bigger payload raises write time and so eats the collision margin (section 3 there).

## Restrictions
- Coordinates give position, not speed; closing speed would be derived from differences at 60 Hz, so noisy.
- Whether the 60 slots are filled in online sessions, in what order, and how a disconnect empties a slot: UNKNOWN.
- Fairness: some servers may regard extra opponent information as an aid; check their rules.

## Failure modes
- The player's index is found by id match and falls back to 0 (`src/shm.js:124-128`); a relative built on that fallback would show the wrong car.
- Stale or teleporting coordinates (pit, respawn, session change) give false "car alongside" calls. A wrong call is worse than none.
- Layout drift after a game patch silently changes every value (as for all offsets).

## Proof-of-concept scope
1. A debug page that dumps all 60 coordinate slots at 10 Hz during a real race and a replay, to see which slots are live and how ids behave. Read only; no HUD change.
2. Offline: project those coordinates on the recorded track model and compare with the game's on-screen relative for a few minutes.
3. Only if both hold: gap ahead/behind text in the existing board window, behind a switch, labelled unverified.

## Maintenance cost
Medium. One more layout section to recheck per game build, plus bridge budget. No new runtime dependency.

## Verdict
**Feasible for position-only gaps, unverified.** Speeds, names and classes cannot be promised. Start with the slot dump (step 1) and decide after seeing real data.
