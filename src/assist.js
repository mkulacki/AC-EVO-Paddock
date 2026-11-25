// PL9 kill switch: one switch that turns the Paddock HUD and every cue off at once, and on again.
// Reached from the header bar, the command palette (Ctrl+K), the page shortcut Alt+Q, Settings, the tray menu and an
// optional global shortcut of the desktop app (settings.assistKey, empty by default).
//
// Off means: the HUD gets no live data (only {off: true}, its look and the Race tab's launch order), so a HUD from
// 0.15.0 on hides itself and an older one shows an empty strip with no cue; the audio spotter says nothing. Brake-mark
// confirmation beeps still play: they answer a button the driver pressed, they are not cues (D-PL9-3).
//
// The switch acts at once in memory; saving it (so it survives a restart, OD-PL-57) may fail (settings.json locked):
// then it still holds until Paddock quits, and the answer says it was not saved.
import * as settings from './settings.js';

let off = settings.get().assistOff === true;
const listeners = new Set();

export const isOff = () => off;
/** Called with the new state after every change (tray menu, broadcasts). */
export const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

/** -> {off, saved, error?} */
export function set(value) {
  const next = value === 'toggle' ? !off : value === true;
  off = next;
  let saved = true, error;
  try { if (settings.get().assistOff !== next) settings.update({ assistOff: next }); } catch (e) { saved = false; error = e.message; }
  console.log(`[assist] HUD and cues ${off ? 'OFF' : 'on'}${saved ? '' : ` (not saved: ${error})`}`);
  for (const fn of listeners) { try { fn(off); } catch { /* a listener's problem stays there */ } }
  return { off, saved, ...(error ? { error } : {}) };
}

/**
 * The HUD payload with the switch applied: while off, nothing live goes out. Kept: the protocol fields (v, now, game,
 * connected), the look (cfg) and the launch order (order: the Race tab starts sessions through the in-game page).
 */
export function gate(snap, isOffNow = off) {
  if (!isOffNow) return snap;
  const out = { v: snap.v, now: snap.now, game: snap.game, connected: snap.connected, off: true, combo: null, lap: null, delta: null, cue: null };
  if (snap.cfg !== undefined) out.cfg = snap.cfg;
  if (snap.order !== undefined) out.order = snap.order;
  return out;
}
