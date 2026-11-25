# In-world ghost car: feasibility

Status: research only, nothing implemented. Nothing here was checked in AC EVO.

## Available interfaces
- **Recorded laps with world position per sample:** the player's x/y/z comes from the car coordinates (`src/shm.js:167`) and laps are stored as channel traces (`src/telcodec.js`, `src/recorder.js`). VERIFIED in code that position is read; storage detail not re-checked here.
- **Comparison inside Paddock** (ideal line, delta, "Beat it"): `src/live.js`, `src/track.js`. VERIFIED, drawn in Paddock's web UI and the 2D in-game HUD, not in the 3D world.
- **HUD surface:** the in-game HUD is a Gameface/HTML app: a 2D overlay that can read files, with no HTTP (`docs/platform/HUD_BRIDGE.md` section 1). VERIFIED.
- **Spawning or moving a car or 3D object inside the sim:** no interface in the repo and no known public mod API. UNKNOWN; do not assume.
- **Camera pose and field of view** (needed to place a 2D marker over a 3D position): no channel in `src/shm.js`. UNKNOWN.

## Restrictions
- A true in-world ghost needs the game to render a car; the only verified drawing surface is a 2D HTML overlay.
- Online: a ghost cannot exist in a shared session; even an overlay of the own best line might count as an aid on some servers.
- Writing files for the game to load as a ghost is unsupported and near the game's known crash path (`HUD_BRIDGE.md` section 1).

## Failure modes
- A 2D marker projected without camera data sits in the wrong place and misleads.
- Aligning by lap time rather than track position drifts after pit or invalid laps.
- Any workaround that injects files could crash the game.

## Proof-of-concept scope
2D alternatives using verified data only: (a) a "ghost gap" bar in the existing HUD showing metres ahead or behind the chosen reference at the same track position (`npos`, `src/shm.js:20`); (b) a mini track map with the ghost dot, which the web UI can already draw. Neither needs a new game interface. For the 3D ghost: record as a dead end until an official interface appears.

## Maintenance cost
2D gap and map: low (same data as the existing delta). 3D: not applicable.

## Verdict
**3D in-world ghost: not feasible with known interfaces.** A 2D ghost gap and map dot is feasible and cheap, but it is an extension of what exists, not the feature requested.
