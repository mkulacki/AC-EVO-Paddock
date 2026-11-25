# Fuel and tyre strategy: feasibility

Status: research only, nothing implemented. Nothing here was checked in AC EVO.

## Available interfaces
- **Fuel in tank:** `physics.fuel` offset 12 (`src/shm.js:9`, read at `:157`). VERIFIED in code. Whether it is litres in EVO and whether it counts usable fuel: ASSUMED from the community header, unchecked.
- **Lap counter and times:** `totalLapCount`, `lastLapMs`, `validLap`, `inPitBox`, `inPitLane` (`src/shm.js:20-22`). VERIFIED in code.
- **Tyre state:** EVO's own 256-byte per-wheel block (`src/shm.js:25-27`: pressure, core and surface temperatures, brake temperature, a lock flag, normalised variants). Marked not checked in game (`src/shm.js:24`).
- **Tyre wear, grip, pit-stop time loss, fuel rules, race length in laps or minutes:** no offsets in the repo. UNKNOWN. Setup files carry a compound field and a fuel litres field (`src/carsetup.js:18-19`), which shows setups hold them, not that the game exposes wear live.
- **Race configuration Paddock asked for** in Solo (`src/race.js:1-12`). VERIFIED for what Paddock sent; online races: unknown.
- **History of consumption per car and track:** recorded laps in `src/db.js`. VERIFIED.

## Restrictions
- Fuel burn varies with driving, traffic, safety-car laps and engine map; one average is a guess.
- No wear channel is known, so tyre strategy would have to infer wear from lap-time fade, mixed with fuel load, track temperature and traffic.
- Pit-lane time loss is not available from the game; the driver would measure it.

## Failure modes
- A fuel figure one lap wrong strands the car: show a range with its inputs and sample count, never a single confident number.
- Refuelling in the pits read as negative consumption if in/out laps are not excluded.
- Units or scale differing from the assumption.
- Tyre fade confounded by fuel burn-off: a naive trend blames the tyres.

## Proof-of-concept scope
1. Record fuel at lap start across about 20 real laps in practice and race; compare with the game's own display; decide whether the channel is trustworthy.
2. If yes: "fuel per lap (median, range), laps remaining at this rate" from existing laps, excluding in/out laps and invalid laps, with the sample count shown.
3. Tyres: observed temperatures and lap-time fade across a stint, labelled as correlation, no wear percentage.

## Maintenance cost
Low for the fuel estimate (one channel, existing laps); medium for tyres (confounds, per-build verification).

## Verdict
**Fuel: feasible after one in-game check.** **Tyre strategy as wear prediction: not feasible**; only descriptive stint temperature and fade views are realistic. No pit-window optimisation is promised.
