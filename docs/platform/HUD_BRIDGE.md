# Paddock HUD bridge: protocol audit, recovery and stress results (PL9)

Written in PL9 (2026-11-25). Covers `src/gamebridge.js` (Paddock side) and `mod/trainerhud/trainerhud.js` (the in-game
HUD, 0.15.0). **The HUD's read rules are unchanged by PL9**: same files, slot count, window and read phase, same
`[TrainerHUD-cmd|launch|cat]` log tags. Nothing here was verified inside AC EVO: the in-game numbers below come from
simulations and from real files read by a second thread on this PC, not from the game's resource loader. This is not a
claim that the bridge cannot crash the game. The writer may now also write one window further ahead (slot w+5) when that
slot is behind (review fix, §4).

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
| Writer | in window `w`, Paddock writes slot `(w + 4) % 8`, once per window, from a 10 ms timer; since the PL9 review it may write `(w + 5) % 8` instead when that slot is behind (§4) | `AHEAD`, `write()` |
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
| A slot write is slow (disk, antivirus) | a write longer than ~150 ms can still be running when the HUD may read that slot: the crash risk | **PL9 back-off:** a write that ends less than 30 ms (`GUARD_MS`) before its slot's read window pauses writing for 1 s (`BACKOFF_MS`, monotonic clock); not writing can never collide; counted as `backoffs`, `slowWrites` (over 60 ms) and `lateWrites` (ended inside the read window), shown in Integration health | "slow disk" |
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

## 4. What PL9 added (writer side; read rules unchanged)

- `GameBridge.stats()`: windows, writes (and how many went to w+5), errors, missed windows and the longest gap, slow
  writes (over 60 ms), back-offs, the longest write, late writes, paused windows, commands, bad lines, stale commands,
  log switches and resets. Shown in Integration health (Game page) when something is off, and in Diagnostics.
- **The back-off (after the review):** only a write that ended less than 30 ms (`GUARD_MS`) before its slot's read
  window pauses writing for 1 s; the pause runs on a monotonic clock (`performance.now`), so a system clock step does
  not stretch it. The first version paused after any write over 60 ms: on a disk at a steady 70 ms a write that cut
  writes from ~1,200 to ~55 a minute, left 69 % of HUD reads over 1 s old and 29 % over 3 s ("Paddock not running").
- **Which slot (after the review):** in window `w` the writer writes slot `w+4` as before, or `w+5` when `w+5` is
  behind and `w+4` is not: it still holds the state from before a change of the kill switch or the look
  (`stateKey`: the `off` flag and `cfg`), or it was not written for 9 windows. `w+5` is read 250 ms later and was last
  read 150 ms earlier (the read itself starts in the first 20 ms of that window), against 200 ms / 200 ms for `w+4`:
  closer to the previous read than the original schedule, still far from both reads. With one write per window it is
  always `w+4`, the original schedule (tested). The slot names its own read window (`window` field), so the HUD's
  clock guard is unchanged. When windows are skipped (slow writes, stalls) no slot is left holding old data.
- **The HUD (0.15.0) never steps back to an older copy** (a slot that was not rewritten for a while holds older data
  than the slot it read before): such a read is dropped while the newer copy is less than 3 s old. This stops the
  HUD from showing itself again for a moment after the kill switch hid it, and from showing older numbers.
- Injectable clocks, writer and folders (tests only), so stalls and slow disks can be simulated.
- The HUD (0.15.0) labels data quality and hides on the kill switch; it reads the same files the same way.

## 5. Stress results (`test/hud-bridge.test.js`, after the review fixes, 2026-11-25, Windows 10, Node 22.23.4)

Simulated runs with the real `GameBridge` and a fake clock: the 10 ms writer timer, whole-process stalls of 100 ms – 2 s
about every 5 s where stated; a write counts as a collision if it overlaps **any** part of a 50 ms window in which the
HUD may read that slot (stricter than the real 20 ms read phase). The HUD is modelled reading every 200 ms, 5 ms into
its window, with its keep-the-newer-copy rule.

| Scenario | Writes | Missed windows / longest gap | Back-offs / late writes | Collisions | HUD reads over 1 s old / oldest |
| --- | --- | --- | --- | --- | --- |
| Stalls, seed 1 (120 s) | 2,043 (58 to w+5) | 358 / 1,900 ms | 0 / 0 | **0** | 6.7 % / 2,002 ms |
| Stalls, seed 2 | 2,221 (8 to w+5) | 180 / 1,950 ms | 0 / 0 | **0** | 3.5 % / 2,196 ms |
| Stalls, seed 3 | 1,980 (105 to w+5) | 421 / 1,800 ms | 0 / 0 | **0** | 8.5 % / 2,004 ms |
| Every write 70 ms (60 s, no stalls) | 750 a minute (373 to w+5) | – | 0 / 0 | **0** | **0 %** / 635 ms |
| Slow disk (1 % of writes 80–400 ms, 120 s) | 1,770 | – | 20 / 17 | 17, **all** from writes over 150 ms | 12.5 % / 3,401 ms |
| Every write 200 ms (20 s) | 20 | – | 17 / – | 17, **all** from writes over 150 ms | – |

Old HUD data after a stall is what the stall costs (the data cannot be newer than the last write); the HUD labels it.

Kill switch (switched 20 s into a 40 s run): at 70 ms a write every slot carries `off` after 10 writes (800 ms) and
the modelled HUD hides after 205 ms and never shows again; no slot is written with the old state after the switch.
At 200 ms a write (every write too slow, paused after most) every slot carries it after 9 writes (6.9 s) and the HUD
hides after 2.5 s: the back-off comes first, because a write that slow can overlap the game's read.

Real files (4 s): the writer on the main thread with stalls of 150–600 ms every 700 ms and every 15th write delayed
20–65 ms; a worker thread reading by the HUD's rules (first 20 ms of its window, every 200 ms): 19 reads, **0**
unparsable or partial, **0** future-window slots, **0** open errors; writer: 54 writes, 28 missed windows, 1 slow write
(66 ms), 0 late writes. A worker thread is not the game's resource loader: Windows file sharing may differ for it.

Reading: scheduling stalls never break the slot discipline (the writer always works out the window it runs in); the
only remaining collision path is a single write slower than the ~150 ms margin, which the writer cannot stop once
started; the back-off keeps it from repeating while the disk stays that slow, and Integration health names it. A disk
that is only a little slow keeps the HUD fresh. The data the HUD shows after a stall is old, and from 0.15.0 the HUD
says so.

## 6. Not verified (needs the game)

- Whether Gameface's file reads behave like the worker thread's (sharing mode, caching).
- The real write times on the user's disk and antivirus (Integration health shows them after a session).
- That 0.15.0 renders the new chips and hides on the kill switch inside AC EVO (checked only in the browser overlay
  and preview code paths and by unit tests of the pure helpers).
