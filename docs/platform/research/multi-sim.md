# Multi-sim support: feasibility

Status: research only, nothing implemented. Everything about other simulators below is ASSUMED from general knowledge and was not checked.

## Available interfaces
- **AC EVO shared memory:** three mappings (`Local\acevo_pmf_physics`, `_graphics`, `_static`, `src/shm.js:6-33`) laid out after a community header, with a `ShmSource` class whose `read()` returns one normalised frame (`src/shm.js:89-173`). VERIFIED. A mock source also exists (`src/mock.js`), so the source is already a replaceable object.
- **Frame shape consumed downstream:** pedals, gear, rpm, speed, position, lap times, car and track names (`src/shm.js:153-171`), used by the recorder and analysis modules. VERIFIED.
- **Other sims:** ASSUMED that some expose a shared-memory structure similar to AC's and that others use UDP or plugin interfaces. Formats, units and licences were not checked.
- **Track and car catalogues, canonical ids:** AC EVO-specific (`src/cars.js`, `src/trackdata.js`, `docs/platform/LEADERBOARD_TRUST.md` section 3). VERIFIED.
- **HUD, setup files, launch orders:** specific to AC EVO's UI and file formats (`src/carsetup.js`, `src/race.js`, `HUD_BRIDGE.md`). VERIFIED.

## Restrictions
- Recorded project decision: track data comes from AC EVO telemetry only, not from other-sim files ("EVO-native data only").
- Each sim needs its own channel verification, units, track model, car data and a check of the vendor's terms; the "unverified until checked in game" model (`src/compat.js`) would apply per sim.
- Leaderboards are keyed on canonical EVO car and track ids; mixing sims needs a sim dimension and a migration.
- Product identity and the README are AC EVO Paddock; a rename is a separate decision.

## Failure modes
- The same field name with a different meaning (slip, load, fuel) produces silently wrong analysis.
- Session and opponent semantics differ; thresholds tuned on EVO laps (OD-PL-26..29, `docs/DEVELOPMENT_STATE.md`) would not transfer.
- One maintainer, N games: every patch becomes N patches.

## Proof-of-concept scope
A second `Source` that reads one other sim into the same frame, 20 recorded laps with the sim id kept beside each lap, outside the real database and board. Observe what in the analysis breaks. Decide on a schema dimension only if that survives.

## Maintenance cost
High and roughly linear in the number of sims: channel verification, tests, catalogues, HUD equivalents, per-version compatibility records.

## Verdict
**Technically possible at the telemetry layer, not recommended now.** It conflicts with the EVO-native data decision and multiplies maintenance; revisit on explicit demand once the EVO feature set is verified in game.
