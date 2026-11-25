# Automatic setup application: feasibility

Status: research only, nothing implemented. Nothing here was checked in AC EVO.

## Available interfaces
- **Setup files on disk:** `<Saved Games>\ACE\Car Setups\<car>\<track>\<name>.carsetup`, a protobuf without schema; layout and field numbers decoded and documented at `src/carsetup.js:1-22`. Paddock edits adjustable numbers only, keeps unknown bytes, and writes new files (`src/setups.js:210-300`: `writeSetup`, `saveValues`, `copyTo`). VERIFIED in code; the decode was checked against the game's own slider list for one car (`src/carsetup.js:7-8`).
- **Allowed ranges:** `content\cars\<car>\data\setup\*.carsetuplimits` (`src/carsetup.js:4`). VERIFIED.
- **Loading a setup into a running session:** no interface in the repo. UNKNOWN whether the game re-reads a changed file during a session or only when a setup is selected; ASSUMED the latter. The in-game HUD can only read files and write log lines (`HUD_BRIDGE.md` section 1), so it cannot press buttons for this.
- **Race tab launch orders** show the HUD can steer Solo menus (`src/race.js:1-12`), read from the game's UI code for game 0.9.1. That is menu navigation, not setup loading, and nothing says the setup screen offers the same.

## Restrictions
- Project rule since PL8: no setup is applied to the running game automatically (no verified interface). Files are prepared; the driver selects them in game.
- Writing into the game's folders while it runs may race with the game reading them; the HUD bridge exists because a failed file open can crash the game (`HUD_BRIDGE.md` section 1), so new file traffic near the game is a crash risk.
- Online: servers may fix or lock setups.

## Failure modes
- A wrong value in a hand-edited protobuf may be rejected or misread; limits files reduce this but do not remove it.
- A game update changes field meaning or format; unseen fields cannot be interpreted.
- Overwriting a setup the driver cares about; today mitigated by saving as new names (`src/setups.js:314` lineage) and by backups.

## Proof-of-concept scope
Already implemented: writing a new `.carsetup` next to existing ones, with lineage, and PL8 experiments. The one research step left: by hand, with the game closed and then open, check whether a newly written setup appears in the setup list without a restart and whether editing a loaded file changes anything mid-session. Record the result; build nothing until known.

## Maintenance cost
Medium and ongoing for the file side (format drift per build). Live application would be high and depends on an interface that is not known.

## Verdict
**File preparation: already done. Automatic live application: not feasible with known interfaces.** Revisit only if a setup-loading call becomes documented.
