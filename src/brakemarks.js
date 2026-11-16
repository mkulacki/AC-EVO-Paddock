// The driver's own brake points ("brake marks"), per track layout and car, for the brake spotter and the HUD.
// A mark's pos is the fraction of the lap from the timing line (0..1).
// Made three ways:
//   - button: while "mark with button" is on, each press of the bound wheel button (or the keyboard shortcut)
//     marks the car's position; a press within MERGE_M of an existing mark moves that mark instead
//   - pedal:  the next full lap is recorded and every point where braking starts becomes a mark
//   - map:    edited on the track page (drag, add, delete, brake/lift, fill from the best lap)
import * as db from './db.js';
import * as trackdata from './trackdata.js';

const MERGE_M = 25;          // button press this close to a mark moves it
const ONSET_BRAKE = 0.1;     // pedal mode: brake above 10 % ...
const OFF_BRAKE = 0.05;      // ... after being below 5 % ...
const OFF_GAP_M = 60;        // ... for at least 60 m
const ONSET_SAMPLES = 3;     // and for 3 frames in a row (~50 ms), so a brush of the pedal is not a mark
export const MAX_MARKS = 60;

/** storage key for a session (catalogue ids when the track is known, the game's names otherwise) */
export function comboOf(s) {
  let h = null;
  try { h = trackdata.find(s.track, s.layout); } catch { /* track data not available */ }
  return { track: h?.track.id ?? s.track, layout: h?.layout.key ?? s.layout, car: s.car };
}
const keyOf = (c) => `${c.track}|${c.layout}|${c.car}`;

const cache = new Map();
export function marksFor(c) {
  const k = keyOf(c);
  if (!cache.has(k)) cache.set(k, db.brakeMarks(c.track, c.layout, c.car));
  return cache.get(k);
}
export function save(c, marks) {
  const clean = marks
    .filter((m) => Number.isFinite(+m.pos) && m.pos >= 0 && m.pos < 1)
    .map((m) => ({ pos: Math.round(+m.pos * 1e6) / 1e6, kind: m.kind === 'lift' ? 'lift' : 'brake' }))
    .sort((a, b) => a.pos - b.pos)
    .slice(0, MAX_MARKS);
  db.setBrakeMarks(c.track, c.layout, c.car, clean);
  cache.delete(keyOf(c));
  return marksFor(c);
}

/** the first mark ahead of pos (wrapping past the line): {mark, ahead (fraction of a lap), wrapped} */
export function nextMark(marks, pos) {
  if (!marks.length) return null;
  const m = marks.find((x) => x.pos > pos);
  return m ? { mark: m, ahead: m.pos - pos, wrapped: false } : { mark: marks[0], ahead: 1 - pos + marks[0].pos, wrapped: true };
}

export function createMarker({ recorder, notify, changed }) {
  let rec = null; // { mode: 'button' | 'pedal', phase, combo, lap, found, ... }
  let frame = null;

  const live = () => (recorder.state.status === 'live' && frame && recorder.session ? recorder.session : null);
  const lapPos = () => {
    const lap = recorder.lap, b = lap?.buf, n = b?.d?.length;
    if (!n || !(frame?.trackLength > 0)) return null;
    return (((b.d[n - 1] / frame.trackLength) % 1) + 1) % 1;
  };
  const status = () => (rec ? { mode: rec.mode, phase: rec.phase, combo: rec.combo, found: rec.found?.length ?? null } : null);
  const announce = () => changed(status());

  function start(mode) {
    rec = mode === 'button' ? { mode, phase: 'on' } : mode === 'pedal' ? { mode, phase: 'waiting', skipLap: recorder.lap, found: [] } : null;
    if (rec && live()) rec.combo = comboOf(live());
    announce();
    return status();
  }

  // a press of the mark button / keyboard shortcut
  function press() {
    if (rec?.mode !== 'button') return { ok: false, reason: 'not marking' };
    const s = live(), pos = lapPos();
    if (!s || pos == null || frame.inPit) { notify('nomark'); return { ok: false, reason: 'not on track' }; }
    const c = comboOf(s), marks = marksFor(c).map((m) => ({ ...m }));
    const L = frame.trackLength, near = marks.findIndex((m) => Math.min(Math.abs(m.pos - pos), 1 - Math.abs(m.pos - pos)) * L < MERGE_M);
    if (near >= 0) marks[near].pos = pos; else marks.push({ pos, kind: 'brake' });
    save(c, marks);
    rec.combo = c;
    notify('mark');
    changed(status(), c);
    return { ok: true, pos };
  }

  // 60 Hz: pedal recording
  function onFrame(f) {
    frame = f;
    if (rec?.mode !== 'pedal') return;
    const s = live(), lap = recorder.lap;
    if (!s || !lap) return;
    if (rec.phase === 'waiting') {
      // start with the next timed lap from the line: not the lap already under way, not an out lap, not in the pits
      if (lap !== rec.skipLap && lap.full && !f.inPit) {
        Object.assign(rec, { phase: 'lap', lap, found: [], combo: comboOf(s), run: 0 });
        notify('recstart'); announce();
      }
      return;
    }
    if (rec.phase !== 'lap') return;
    if (rec.lap.done) return finish(rec.lap.done === 'saved');
    if (lap !== rec.lap) return; // past the line: wait until the recorder has finalized the lap
    const b = lap.buf, n = b.d?.length;
    if (!n) return;
    if (f.inPit) { Object.assign(rec, { phase: 'waiting', skipLap: lap, found: [] }); notify('nomark'); announce(); return; }
    const brk = b.brk[n - 1];
    if (brk < OFF_BRAKE) { rec.run = 0; return; } // pedal released: the next press can be a new mark
    if (brk < ONSET_BRAKE || ++rec.run !== ONSET_SAMPLES) return;
    const at = b.d[Math.max(0, n - ONSET_SAMPLES)], last = rec.found[rec.found.length - 1];
    if (!last || at - last.d >= OFF_GAP_M) { rec.found.push({ d: at }); announce(); }
  }

  // the recorded lap was finalized: saved at the line -> its brake points replace the marks of that car and
  // track; thrown away (pits, restart, incomplete) -> wait for the next lap
  function finish(saved) {
    const L = frame?.trackLength;
    if (!saved || !(L > 0) || !rec.found.length) {
      Object.assign(rec, { phase: 'waiting', skipLap: rec.lap, found: [] });
      notify('nomark'); announce(); return;
    }
    const c = rec.combo, list = rec.found.map((x) => ({ pos: (((x.d / L) % 1) + 1) % 1, kind: 'brake' }));
    save(c, list);
    notify('recsaved');
    rec = null;
    changed(null, c);
  }
  recorder.on('session', () => { if (rec) { rec.combo = null; if (rec.mode === 'pedal') { rec.phase = 'waiting'; rec.skipLap = null; rec.found = []; } announce(); } });

  return { start, press, onFrame, status };
}
