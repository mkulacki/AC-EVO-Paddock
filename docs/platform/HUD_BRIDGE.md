# Paddock HUD bridge: protocol audit, recovery and stress results (PL9)

Written in PL9 (2026-11-25). Covers `src/gamebridge.js` (Paddock side) and `mod/trainerhud/trainerhud.js` (the in-game
HUD, 0.15.0). **The protocol is unchanged by PL9**: same files, slot count, window, lead and read phase, same
`[TrainerHUD-cmd|launch|cat]` log tags. Nothing here was verified inside AC EVO: the in-game numbers below come from
simulations and from real files read by a second thread on this PC, not from the game's resource loader. This is not a
claim that the bridge cannot crash the game.

## 1. Why the protocol looks like this

AC EVO's UI (Coherent Gameface) cannot make HTTP or WebSocket requests. It can read files under `mods\uiresources`
again on every request, and it can write to the game log. If the game's resource loader fails to open a file (for
example a sharing violation while Paddock writes it), the C++ exception **crashes AC EVO**. Writing in place and
replace-by-rename both still collided (about 1 read in 2,500), so reader and writer are kept apart in time.

## 2. Protocol (audited, `src/gamebridge.js:1-30`, `mod/trainerhud/trainerhud.js` `readSlot`)

| Item | Value | Where |
| --- | --- | --- |
| Data files | `live0.json` … `live7.json` in `<ACE>\mods\uiresources\ACEUIAppLoader\trainerhud\`, each padded with spaces to 16,384 bytes | `LIVE_SIZE`, `SLOTS`, `padLive` |
| Window | `w = floor(now / 50 ms)` on the shared system clock | `WINDOW_MS` |
| Writer | in window `w`, Paddock writes only slot `(w + 4) % 8`, once per window, from a 10 ms timer | `AHEAD`, `write()` |
| Reader | in window `w`, the HUD reads only slot `w % 8`, and only starts in the first 20 ms; at most 5 reads a second (200 ms) | `READ_PHASE_MS`, `poll` |
| Margin | a slot is written 150–200 ms before its read window and next written ~180 ms after it | |
| Clock guard | a slot naming a window later than the reader's (`json.window > w`) stops file reads on that page for good | `slotUnsafe` |
| Liveness | `json.now` older than 3 s = "Paddock not running" (fallback to the game's own delta) | `readSlot` |
| Commands | the HUD logs `[TrainerHUD-cmd] {id, at, cmd, arg}` plus two `[TrainerHUD-pad]` lines (flush the log's 4 KB block); Paddock tails the newest `Logs\log-*.txt` every 250 ms | `tail()` |
| Install | slot files are created by the installer only, never by the writer; the HUD folder is replaced only while the game is closed | `src/hudinstall.js` |

## 3. Failure modes and recovery

| Failure | What happens | Recovery | Test |
| --- | --- | --- | --- |
| Paddock's event loop stalls (long job, GC, antivirus) | windows pass without a write; the next write is for the window it runs in, so the margin is there again | automatic; counted as `missedWindows` / `maxGapMs`; the HUD labels data over 1 s old (PL9) | `hud-bridge` "scheduling stalls" |
| A slot write is slow (disk, antivirus) | a write longer than ~150 ms can still be running when the HUD may read that slot: the crash risk | **PL9 back-off:** a write over 60 ms (`SLOW_WRITE_MS`) pauses writing for 1 s (`BACKOFF_MS`); not writing can never collide; counted as `slowWrites`, `lateWrites` (ended inside the read window), shown in Integration health | "slow disk" |
| A write fails (EBUSY, EPERM) | nothing is written to that slot this window | counted (`errors`), logged once per run of the same error, next window writes again | "recovery: … failed writes" |
| HUD folder missing (not installed, removed) | nothing is written, nothing created | checked every 2 s; writing starts when the installer has made it | "recovery: the HUD folder appears later" |
| Game log rotates (game restarted) | a new `log-*.txt` is newest | followed within 2 s, read from the top; ids already seen are not run twice | "command log" |
| Log cut back (shorter than the offset) | | read again from the top (`logResets`) | "command log" |
| Log rewritten to the same or a larger size | **not noticed** (the offset is size-based); commands written meanwhile can be missed | none; the game starts a new file per run, so this is not expected | documented here |
| Partial log line | | kept until the rest arrives | "command log" |
| Old or repeated commands | | over 30 s old dropped (`staleCommands`), ids kept (last 200) | "command log" |
| Unparsable command | | dropped (`badLines`) | "command log" |
| System clock steps **backwards** | the HUD can find a slot naming a later window and stops reading files on that page until the page is reloaded (a game menu change) | none automatic: the guard is a crash guard and is kept as it is | static only |
| Paddock not running / crashed | slots keep their last content; `now` ages | the HUD shows "Paddock offline" after 3 s and falls back to the game's own delta; between 1 and 3 s it labels the data as old (PL9) | `hud-live` HUD labels |
| Telemetry frozen while "live" (game hitch, alt-tab) | the delta would sit still | PL9: after 500 ms without a new packet the HUD says "TELEMETRY STALE", gets no countdown, and the spotter says nothing; after 3 s the session ends as before | `hud-live` "snapshot labels stale telemetry" |

## 4. What PL9 added (writer side only)

- `GameBridge.stats()`: windows, writes, errors, missed windows and the longest gap, slow writes and the longest write,
  late writes, paused windows, commands, bad lines, stale commands, log switches and resets. Shown in Integration
  health (Game page) when something is off, and in Diagnostics.
- The slow-write back-off (above). Its cost: on a disk that is slow all the time, the HUD gets one update a second
  and labels it "DATA … OLD".
- Injectable clock, writer and folders (tests only), so stalls and slow disks can be simulated.
- The HUD (0.15.0) labels data quality and hides on the kill switch; it reads the same files the same way.

## 5. Stress results (`test/hud-bridge.test.js`, run 2026-11-25, Windows 10, Node 22.23.4)

Simulated runs: 120 s of the 10 ms writer timer with whole-process stalls of 100 ms – 2 s about every 5 s; a write
counts as a collision if it overlaps **any** part of a 50 ms window in which the HUD may read that slot (stricter than
the real 20 ms read phase).

| Scenario | Writes | Missed windows / longest gap | Slow / late writes | Collisions | Oldest data at a read |
| --- | --- | --- | --- | --- | --- |
| Stalls, seed 1 | 2,042 | 359 / 1,900 ms | 0 / 0 | **0** | 2,199 ms |
| Stalls, seed 2 | 2,220 | 181 / 1,950 ms | 0 / 0 | **0** | 2,198 ms |
| Stalls, seed 3 | 1,979 | 422 / 1,850 ms | 0 / 0 | **0** | 2,200 ms |
| Slow disk (1 % of writes 80–400 ms) | 1,547 | – | 29 (longest 392 ms) / 23 | 23, **all** from writes that themselves took over 150 ms | 4,198 ms |
| Every write 170 ms, 20 s | 17 (back-off: one a second) | – | – | 0 | – |

Real files (4 s): the writer on the main thread with stalls of 150–600 ms every 700 ms and every 15th write delayed
20–65 ms; a worker thread reading by the HUD's rules (first 20 ms of its window, every 200 ms): 19 reads, **0**
unparsable or partial, **0** future-window slots, **0** open errors; writer: 46 writes, 26 missed windows, 1 slow write
(65 ms), 0 late writes. A worker thread is not the game's resource loader: Windows file sharing may differ for it.

Reading: scheduling stalls never break the slot discipline (the writer always works out the window it runs in); the
only remaining collision path is a single write slower than the ~150 ms margin, which the writer cannot stop once
started; the back-off keeps it from repeating while the disk stays slow, and Integration health names it. The data
the HUD shows after a stall is old, and from 0.15.0 the HUD says so.

## 6. Not verified (needs the game)

- Whether Gameface's file reads behave like the worker thread's (sharing mode, caching).
- The real write times on the user's disk and antivirus (Integration health shows them after a session).
- That 0.15.0 renders the new chips and hides on the kill switch inside AC EVO (checked only in the browser overlay
  and preview code paths and by unit tests of the pure helpers).
