// Driving aids per lap: TC, TC cut, ABS and ESC levels, whether each one can be switched off on this car, whether
// each one acted during the lap, and the game's assist settings (automatic gearbox and clutch, stability control,
// ideal line). Needed so online lap times are compared with laps driven with the same help, and for PRO challenges.
//
// None of this is in shared memory in a form we trust, so it comes from the game's own UI models, read by the
// in-game Paddock HUD (mod/trainerhud) and sent here as "aids" commands through the game log:
//   {t: 'lv',  lap, lv, mod, max}        the levels changed (or the HUD just started)
//   {t: 'use', lap, aid}                 an aid acted for the first time in this lap (tc | abs | esc)
//   {t: 'lap', lap, lv, min, mod, max, used, partial}   a lap ended: the highest / lowest levels during it and what acted
//   {t: 'assists', a}                    the game's assist settings (menu pages; the in-game page may not see them)
// `lap` is the game's completed-lap count while the lap was driven, the same count the recorder sees
// (lap number - 1), so a summary that arrives late (the game log is followed every few hundred ms) still finds its lap.
import * as db from './db.js';

export const AIDS = ['tc', 'tcc', 'abs', 'esc'];
/** The aids that decide the class (TC cut only works with TC on). */
const CLASS_AIDS = ['tc', 'abs', 'esc'];
const KEEP_MS = 15 * 60 * 1000; // a lap summary waits this long for its lap (long tracks, slow log)

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const levels = (o) => (o && typeof o === 'object' ? Object.fromEntries(AIDS.map((k) => [k, num(o[k])])) : null);
const flags = (o) => Object.fromEntries(CLASS_AIDS.map((k) => [k, !!(o && o[k])]));

/** The game's assist preset, as {gearbox, clutch, stability, idealLine} (on = true), or null when not known. */
export function normaliseAssists(a) {
  if (!a || typeof a !== 'object') return null;
  const on = (v) => (v == null ? null : typeof v === 'string' ? /_ON$|^on$|^true$/i.test(v) : typeof v === 'number' ? v > 0 : !!v);
  return {
    gearbox: on(a.automatic_gearbox), clutch: on(a.automatic_clutch), idealLine: on(a.ideal_line),
    stability: num(a.stability_control), preset: typeof a.type === 'string' ? a.type : null,
  };
}

/**
 * The class of a lap from its aids:
 *   'pro'       every aid off and never acting, no automatic gearbox, no stability control
 *   'pro-fixed' as 'pro', except aids this car cannot switch off (a road car's fixed ABS, say). Its own board:
 *               these laps never count as PRO (user decision 2026-11-23)
 *   'assisted'  any aid or assist on
 *   'unknown'   not enough data: no HUD report for the whole lap, or the assist settings were never seen
 * Auto-clutch and the ideal line do not count: they do not make a lap faster.
 */
export function classify(a) {
  if (!a || a.partial || !a.lv) return 'unknown';
  let fixed = false;
  for (const k of CLASS_AIDS) {
    const lv = a.lv[k], mod = a.mod?.[k];
    if (lv == null && !a.used?.[k]) continue; // the car has no such aid
    const on = (lv ?? 0) > 0 || a.used?.[k];
    if (!on) continue;
    if (mod === 0) { fixed = true; continue; } // cannot be switched off on this car
    return 'assisted';
  }
  const s = a.assists;
  if (s && (s.gearbox || (s.stability ?? 0) > 0)) return 'assisted';
  if (!s || s.gearbox == null || s.stability == null) return 'unknown';
  return fixed ? 'pro-fixed' : 'pro';
}

export const CLASS_LABEL = { pro: 'PRO', 'pro-fixed': 'PRO (fixed aids)', assisted: 'Assisted', unknown: 'Unknown' };

/** One tracker per app: fed with the HUD's commands and the recorder's laps. */
export function createAidsTracker({ recorder, now = () => Date.now() }) {
  let cur = null;          // the latest levels {lap, lv, mod, max, at}
  let assists = null;      // the latest assist settings {..., at}
  let usedNow = { lap: null, used: flags(null) }; // what acted in the lap being driven (check panel)
  const summaries = new Map(); // game lap count -> {aids, at}
  const waiting = new Map();   // game lap count -> {id, at}: a saved lap whose summary has not arrived yet
  let lastLap = null;          // the last lap stored {id, aids}

  const prune = () => {
    const t = now();
    for (const m of [summaries, waiting]) for (const [k, v] of m) if (t - v.at > KEEP_MS) m.delete(k);
  };
  const reset = () => { summaries.clear(); waiting.clear(); usedNow = { lap: null, used: flags(null) }; };

  const withClass = (a) => ({ ...a, cls: classify(a) });
  const store = (id, aids) => { const a = withClass(aids); db.setLapAids(id, a); lastLap = { id, aids: a }; return a; };

  function onCommand(arg) {
    if (!arg || typeof arg !== 'object') return;
    const lap = Number.isInteger(arg.lap) ? arg.lap : null;
    if (arg.t === 'assists') { assists = { ...normaliseAssists(arg.a), at: now() }; return; }
    if (arg.t === 'lv') { cur = { lap, lv: levels(arg.lv), mod: levels(arg.mod), max: levels(arg.max), at: now() }; return; }
    if (arg.t === 'use') {
      if (usedNow.lap !== lap) usedNow = { lap, used: flags(null) };
      if (CLASS_AIDS.includes(arg.aid)) usedNow.used[arg.aid] = true;
      return;
    }
    if (arg.t !== 'lap' || lap == null) return;
    prune();
    const aids = {
      v: 1, lv: levels(arg.lv), min: levels(arg.min), mod: levels(arg.mod), max: levels(arg.max), used: flags(arg.used),
      partial: !!arg.partial, assists: assists ? { ...assists, at: undefined } : null,
    };
    if (cur) cur = { ...cur, lap: lap + 1 };
    const w = waiting.get(lap);
    if (w) { waiting.delete(lap); store(w.id, aids); } else summaries.set(lap, { aids, at: now() });
  }

  /** The recorder saved a lap: its aids, from the HUD's summary of that lap or, until that arrives, the latest levels. */
  function onLap(l) {
    prune();
    const c = Number(l.lapNumber) - 1;
    const s = summaries.get(c);
    if (s) { summaries.delete(c); return store(l.id, s.aids); }
    waiting.set(c, { id: l.id, at: now() });
    if (!cur) return null; // no HUD report at all: leave the lap without aids
    return store(l.id, { v: 1, lv: cur.lv, min: cur.lv, mod: cur.mod, max: cur.max, used: flags(null), partial: true,
      assists: assists ? { ...assists, at: undefined } : null });
  }

  if (recorder) {
    recorder.on('lap', onLap);
    recorder.on('session', reset);
  }

  return {
    onCommand,
    onLap,
    /** For the check panel: what the HUD reports right now. */
    live: () => ({
      levels: cur ? { ...cur, ageMs: now() - cur.at } : null,
      assists: assists ? { ...assists, ageMs: now() - assists.at } : null,
      usedThisLap: usedNow.used,
      lastLap: lastLap ? { id: lastLap.id, ...lastLap.aids, label: CLASS_LABEL[lastLap.aids.cls] } : null,
    }),
  };
}
