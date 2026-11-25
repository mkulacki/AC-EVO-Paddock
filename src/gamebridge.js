// Bridge between Paddock and the in-game Paddock HUD.
// AC EVO's UI (Coherent Gameface) cannot make HTTP or WebSocket requests: http:// URLs fail inside the
// engine. It can (1) read files under mods\uiresources afresh on every request (outside js/, which the
// game caches at start) and (2) write to the game log. So:
//   Paddock -> game: liveN.json files in the app folder (fixed size, padded with spaces)
//   game -> Paddock: the HUD logs "[TrainerHUD-cmd] {json}" lines; we tail the newest game log.
//
// CRASH SAFETY: if the game's resource loader fails to open a file ("Failed to open file for reading",
// e.g. a sharing violation while we write it), the C++ exception CRASHES AC EVO. Writing in place or
// replacing by rename both still collided (~1 in 2,500 reads). So reader and writer never touch the same
// file at the same time, by time-slotting on the shared system clock:
//   time is cut into WINDOW_MS windows w = floor(now / WINDOW_MS);
//   in window w the HUD reads only slot w % SLOTS, and only in the first READ_PHASE_MS of the window;
//   in window w Paddock writes only slot (w + AHEAD) % SLOTS.
// A slot is therefore last written ~150 ms before its read window and next written ~180 ms after it.
//
// PL9 audit (docs/platform/HUD_BRIDGE.md): the protocol above is unchanged. What the writer adds:
//   - stats (windows written, missed windows after a stall, write times, writes that ended inside or after their
//     slot's read window, errors): Integration health and Diagnostics show them;
//   - which slot: in window w the writer writes slot w+4 as before, or w+5 (read 250 ms ahead, last read 150 ms ago)
//     when w+5 is behind and w+4 is not: w+5 still holds a state from before a change of the kill switch or the look
//     (stateKey), or was not written for 9 windows. With one write per window that is always w+4, the old schedule; when windows are skipped (slow writes, stalls) no slot is
//     left behind, so the HUD keeps getting fresh data and every slot gets the new state within 8 writes (review fix);
//   - a back-off: a write that ended less than GUARD_MS before its slot's read window (it came near the real safety
//     margin of at least 150 ms; a disk or antivirus stall) pauses writing for BACKOFF_MS. Not writing can never
//     collide with a read; a write that is already running cannot be stopped. A disk that is only a little slow
//     (e.g. 70 ms a write) is not paused (review fix: pausing it made the data seconds old). The pause runs on a
//     monotonic clock, so a system clock step does not stretch it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import koffi from 'koffi';
import * as settings from './settings.js';

export const LIVE_SIZE = 16384;
export const SLOTS = 8;
export const WINDOW_MS = 50;
export const AHEAD = 4;        // Paddock writes the slot AHEAD windows ahead
export const READ_PHASE_MS = 20; // the HUD only starts a read in the first 20 ms of a window
export const SLOW_WRITE_MS = 60; // counted as slow (a slot write is normally well under 5 ms); not paused for by itself
export const GUARD_MS = 30;      // a write that ends closer than this to its slot's read window starts the back-off
export const BACKOFF_MS = 1000;  // after such a write, no slot is written for this long
// the parts of the payload whose change must reach every slot (the kill switch, the look); see write()
export const stateKey = (snap) => `${snap?.off === true}|${JSON.stringify(snap?.cfg ?? null)}`;
// AC EVO's user folder (mods, setups, logs, HUD files). Windows lets people move "Saved Games" (e.g. to
// I:\JMC\Parties enregistrées), so ask Windows for the real place instead of assuming <home>\Saved Games.
// Order: ACE_DIR env, the "Game files folder" setting, the Saved Games known folder, <home>\Saved Games.
export function savedGamesDir() {
  try {
    const GUID = koffi.struct('PaddockGUID', { a: 'uint32_t', b: 'uint16_t', c: 'uint16_t', d: koffi.array('uint8_t', 8) });
    const getPath = koffi.load('shell32.dll').func('int32_t __stdcall SHGetKnownFolderPath(const PaddockGUID *rfid, uint32_t flags, void *token, _Out_ void **path)');
    const free = koffi.load('ole32.dll').func('void __stdcall CoTaskMemFree(void *p)');
    const out = [null];
    // FOLDERID_SavedGames {4C5C32FF-BB9D-43B0-B5B4-2D72E54EAAA4}
    const hr = getPath({ a: 0x4C5C32FF, b: 0xBB9D, c: 0x43B0, d: [0xB5, 0xB4, 0x2D, 0x72, 0xE5, 0x4E, 0xAA, 0xA4] }, 0, null, out);
    if (hr === 0 && out[0]) {
      const dir = koffi.decode(out[0], 'char16_t', -1);
      free(out[0]);
      if (dir) return dir;
    }
  } catch { /* not Windows, or the call failed: use the default below */ }
  return path.join(os.homedir(), 'Saved Games');
}
// A setting may name the ACE folder itself or the Saved Games folder that holds it.
function fromSetting(dir) {
  if (!dir) return '';
  return path.basename(dir).toLowerCase() !== 'ace' && fs.existsSync(path.join(dir, 'ACE')) ? path.join(dir, 'ACE') : dir;
}
export const ACE_AUTO = path.join(savedGamesDir(), 'ACE');
export const ACE = process.env.ACE_DIR || fromSetting(settings.get().aceDir) || ACE_AUTO;
export const APP_DIR = path.join(ACE, 'mods', 'uiresources', 'ACEUIAppLoader', 'trainerhud');
export const LOG_DIR = path.join(ACE, 'Logs');
const CMD_TAG = '[TrainerHUD-cmd] ';
const LAUNCH_TAG = '[TrainerHUD-launch] ';
const CAT_TAG = '[TrainerHUD-cat] '; // chunks of the game catalogue (Race tab scan)

export const slotFile = (k, dir = APP_DIR) => path.join(dir, `live${k}.json`);

export function padLive(json, size = LIVE_SIZE) {
  const buf = Buffer.alloc(size, 0x20);
  const body = Buffer.from(json, 'utf8');
  if (body.length > size) throw new Error('HUD payload too large');
  body.copy(buf);
  return buf;
}

export class GameBridge {
  // appDir / logDir / now / writeSlot / log: for tests (scratch folders, a simulated clock, slow or failing writes)
  constructor({ snapshot, onCommand, onLaunchEvent, onCatalogue, appDir = APP_DIR, logDir = LOG_DIR, now = Date.now,
    mono = () => performance.now(), writeSlot = (file, buf) => fs.writeFileSync(file, buf), log = console }) {
    this.snapshot = snapshot;
    this.onCommand = onCommand;
    this.onLaunchEvent = onLaunchEvent || (() => {});
    this.onCatalogue = onCatalogue || (() => {});
    this.appDir = appDir; this.logDir = logDir; this.now = now; this.mono = mono; this.writeSlot = writeSlot; this.out = log;
    this.slotAt = new Array(SLOTS).fill(-Infinity); // when each slot was last written (wall clock)
    this.slotKey = new Array(SLOTS).fill(null);     // the stateKey each slot holds
    this.log = { file: null, offset: 0, rest: '' };
    this.seen = new Set();
    this.lastErr = null;
    this.lastWindow = -1;
    this.pauseUntil = 0;
    this.st = { windows: 0, writes: 0, errors: 0, missedWindows: 0, maxGapMs: 0, slowWrites: 0, backoffs: 0, maxWriteMs: 0, lateWrites: 0, aheadWrites: 0,
      pausedWindows: 0, lastWriteAt: 0, lastError: null, commands: 0, badLines: 0, staleCommands: 0, logSwitches: 0, logResets: 0 };
  }

  start() {
    // runs even without the HUD installed: the Mods tab can install it later, and writing starts then
    this.out.log(fs.existsSync(this.appDir) ? `[hud] in-game HUD bridge: ${this.appDir}\\live0-${SLOTS - 1}.json`
      : `[hud] in-game HUD not installed yet (${this.appDir}): install it from the Mods tab`);
    this.writeTimer = setInterval(() => this.write(), 10);
    this.logTimer = setInterval(() => this.tail(), 250);
    return this;
  }
  stop() { clearInterval(this.writeTimer); clearInterval(this.logTimer); }

  /** What the writer and the log reader have seen since Paddock started (PL9; Integration health, Diagnostics). */
  stats() { return { ...this.st, pausedNow: this.mono() < this.pauseUntil, windowMs: WINDOW_MS, slots: SLOTS, ahead: AHEAD }; }

  // once per window: write the slot AHEAD windows ahead (never one the game may be reading around now)
  write() {
    const t = this.now();
    const w = Math.floor(t / WINDOW_MS);
    if (w === this.lastWindow) return;
    if (this.lastWindow >= 0 && w > this.lastWindow + 1) {
      // the process was held up (a stall): those windows were not written; the next one is, as always
      this.st.missedWindows += w - this.lastWindow - 1;
      this.st.maxGapMs = Math.max(this.st.maxGapMs, (w - this.lastWindow) * WINDOW_MS);
    }
    this.lastWindow = w;
    this.st.windows++;
    // the HUD's folder: checked every 2 s (never created here: only the installer makes it, with every file in it)
    if (t - (this.dirCheckedAt || 0) > 2000) { this.dirCheckedAt = t; this.dirOk = fs.existsSync(this.appDir); }
    if (!this.dirOk) return;
    if (this.mono() < this.pauseUntil) { this.st.pausedWindows++; return; } // backing off after a write near its read window
    try {
      const snap = this.snapshot(), key = stateKey(snap);
      // slot w+4, as always, unless w+5 is behind and w+4 is not: w+5 still holds an older state, or was not written
      // for more than one round of the slots (8 windows) plus one window. In a steady run w+4 is always taken.
      const behind = (slot) => (this.slotKey[slot] !== key ? 2 : t - this.slotAt[slot] > (SLOTS + 1) * WINDOW_MS ? 1 : 0);
      const s4 = (w + AHEAD) % SLOTS, s5 = (w + AHEAD + 1) % SLOTS;
      const pick = behind(s5) > behind(s4) ? { k: AHEAD + 1, slot: s5 } : { k: AHEAD, slot: s4 };
      const slot = pick.slot, readAt = (w + pick.k) * WINDOW_MS;
      const buf = padLive(JSON.stringify({ ...snap, slot, window: w + pick.k }));
      const t0 = this.now();
      this.writeSlot(slotFile(slot, this.appDir), buf);
      const t1 = this.now(), ms = t1 - t0;
      // the write must finish well before the HUD may read this slot (readAt); if the process stalled before it
      // started, w is simply the window it runs in, so the margin is there again
      this.st.writes++; this.st.lastWriteAt = t1;
      if (pick.k !== AHEAD) this.st.aheadWrites++;
      this.slotAt[slot] = t1; this.slotKey[slot] = key;
      if (ms > this.st.maxWriteMs) this.st.maxWriteMs = ms;
      if (t1 >= readAt) this.st.lateWrites++;
      if (ms > SLOW_WRITE_MS) this.st.slowWrites++;
      if (t1 > readAt - GUARD_MS) {
        this.st.backoffs++;
        this.pauseUntil = this.mono() + BACKOFF_MS;
        if (this.st.backoffs === 1 || this.st.backoffs % 100 === 0) this.out.error(`[hud] live slot write took ${Math.round(ms)} ms, too close to the game's read: writes paused for ${BACKOFF_MS} ms (${this.st.backoffs} so far)`);
      }
      this.lastErr = null;
    } catch (e) {
      this.st.errors++; this.st.lastError = e.code || e.message;
      if (this.lastErr !== e.code) this.out.error('[hud] live slot write failed:', e.message);
      this.lastErr = e.code;
    }
  }
  // follow the newest game log for command lines from the HUD
  tail() {
    try {
      const L = this.log;
      if (!L.file || this.now() - (L.checkedAt || 0) > 2000) {
        L.checkedAt = this.now();
        const newest = fs.readdirSync(this.logDir).filter((f) => /^log-.*\.txt$/.test(f))
          .map((f) => ({ f, t: fs.statSync(path.join(this.logDir, f)).mtimeMs })).sort((a, b) => b.t - a.t)[0];
        const file = newest && path.join(this.logDir, newest.f);
        if (file && file !== L.file) {
          // a log that existed when we started: skip old content; a new one (game restarted): read from the top
          const first = L.file === null;
          if (!first) this.st.logSwitches++;
          L.file = file; L.rest = '';
          L.offset = first ? fs.statSync(file).size : 0;
        }
      }
      if (!L.file) return;
      const size = fs.statSync(L.file).size;
      if (size < L.offset) { L.offset = 0; L.rest = ''; this.st.logResets++; } // the log was cut back or rewritten
      if (size === L.offset) return;
      const fd = fs.openSync(L.file, 'r');
      const buf = Buffer.alloc(Math.min(size - L.offset, 4 << 20));
      fs.readSync(fd, buf, 0, buf.length, L.offset);
      fs.closeSync(fd);
      L.offset += buf.length;
      const lines = (L.rest + buf.toString('utf8')).split('\n');
      L.rest = lines.pop();
      for (const line of lines) {
        const li = line.indexOf(LAUNCH_TAG);
        if (li >= 0) { try { this.onLaunchEvent(JSON.parse(line.slice(li + LAUNCH_TAG.length).trim())); } catch { /* partial line */ } continue; }
        const ci = line.indexOf(CAT_TAG);
        if (ci >= 0) { try { this.onCatalogue(JSON.parse(line.slice(ci + CAT_TAG.length).trim())); } catch { /* partial line */ } continue; }
        const i = line.indexOf(CMD_TAG);
        if (i < 0) continue;
        let cmd;
        try { cmd = JSON.parse(line.slice(i + CMD_TAG.length).trim()); } catch { this.st.badLines++; continue; }
        if (!cmd?.id || this.seen.has(cmd.id)) continue;
        this.seen.add(cmd.id);
        if (this.seen.size > 200) this.seen.delete(this.seen.values().next().value);
        if (this.now() - Number(cmd.at || 0) > 30000) { this.st.staleCommands++; continue; } // stale (old log content)
        this.st.commands++;
        this.onCommand(cmd);
      }
    } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'EBUSY') this.out.error('[hud] log tail failed:', e.message);
    }
  }
}
