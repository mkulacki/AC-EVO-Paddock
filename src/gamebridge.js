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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const LIVE_SIZE = 16384;
export const SLOTS = 8;
export const WINDOW_MS = 50;
export const AHEAD = 4;        // Paddock writes the slot AHEAD windows ahead
export const READ_PHASE_MS = 20; // the HUD only starts a read in the first 20 ms of a window
export const ACE = process.env.ACE_DIR || path.join(os.homedir(), 'Saved Games', 'ACE');
export const APP_DIR = path.join(ACE, 'mods', 'uiresources', 'ACEUIAppLoader', 'trainerhud');
export const LOG_DIR = path.join(ACE, 'Logs');
const CMD_TAG = '[TrainerHUD-cmd] ';
const LAUNCH_TAG = '[TrainerHUD-launch] ';
const CAT_TAG = '[TrainerHUD-cat] '; // chunks of the game catalogue (Race tab scan)

export const slotFile = (k) => path.join(APP_DIR, `live${k}.json`);

export function padLive(json, size = LIVE_SIZE) {
  const buf = Buffer.alloc(size, 0x20);
  const body = Buffer.from(json, 'utf8');
  if (body.length > size) throw new Error('HUD payload too large');
  body.copy(buf);
  return buf;
}

export class GameBridge {
  constructor({ snapshot, onCommand, onLaunchEvent, onCatalogue }) {
    this.snapshot = snapshot;
    this.onCommand = onCommand;
    this.onLaunchEvent = onLaunchEvent || (() => {});
    this.onCatalogue = onCatalogue || (() => {});
    this.log = { file: null, offset: 0, rest: '' };
    this.seen = new Set();
    this.lastErr = null;
    this.lastWindow = -1;
  }

  start() {
    // runs even without the HUD installed: the Mods tab can install it later, and writing starts then
    console.log(fs.existsSync(APP_DIR) ? `[hud] in-game HUD bridge: ${APP_DIR}\\live0-${SLOTS - 1}.json`
      : `[hud] in-game HUD not installed yet (${APP_DIR}): install it from the Mods tab`);
    this.writeTimer = setInterval(() => this.write(), 10);
    this.logTimer = setInterval(() => this.tail(), 250);
    return this;
  }

  // once per window: write the slot AHEAD windows ahead (never one the game may be reading around now)
  write() {
    const w = Math.floor(Date.now() / WINDOW_MS);
    if (w === this.lastWindow) return;
    this.lastWindow = w;
    // the HUD's folder: checked every 2 s (never created here: only the installer makes it, with every file in it)
    if (Date.now() - (this.dirCheckedAt || 0) > 2000) { this.dirCheckedAt = Date.now(); this.dirOk = fs.existsSync(APP_DIR); }
    if (!this.dirOk) return;
    const slot = (w + AHEAD) % SLOTS;
    try {
      fs.writeFileSync(slotFile(slot), padLive(JSON.stringify({ ...this.snapshot(), slot, window: w + AHEAD })));
      // the write must finish inside this window; if the process stalled, the next window simply writes again
      this.lastErr = null;
    } catch (e) {
      if (this.lastErr !== e.code) console.error('[hud] live slot write failed:', e.message);
      this.lastErr = e.code;
    }
  }
  // follow the newest game log for command lines from the HUD
  tail() {
    try {
      const L = this.log;
      if (!L.file || Date.now() - (L.checkedAt || 0) > 2000) {
        L.checkedAt = Date.now();
        const newest = fs.readdirSync(LOG_DIR).filter((f) => /^log-.*\.txt$/.test(f))
          .map((f) => ({ f, t: fs.statSync(path.join(LOG_DIR, f)).mtimeMs })).sort((a, b) => b.t - a.t)[0];
        const file = newest && path.join(LOG_DIR, newest.f);
        if (file && file !== L.file) {
          // a log that existed when we started: skip old content; a new one (game restarted): read from the top
          const first = L.file === null;
          L.file = file; L.rest = '';
          L.offset = first ? fs.statSync(file).size : 0;
        }
      }
      if (!L.file) return;
      const size = fs.statSync(L.file).size;
      if (size < L.offset) L.offset = 0;
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
        try { cmd = JSON.parse(line.slice(i + CMD_TAG.length).trim()); } catch { continue; }
        if (!cmd?.id || this.seen.has(cmd.id)) continue;
        this.seen.add(cmd.id);
        if (this.seen.size > 200) this.seen.delete(this.seen.values().next().value);
        if (Date.now() - Number(cmd.at || 0) > 30000) continue; // stale (old log content)
        this.onCommand(cmd);
      }
    } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'EBUSY') console.error('[hud] log tail failed:', e.message);
    }
  }
}
