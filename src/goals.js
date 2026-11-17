// Driver development (P9): goals and challenges per track + car, checked automatically against the laps you drive.
// A goal has no deadline; a challenge is the same thing with one (yours, or suggested by Paddock from your laps).
// Only laps driven after the goal was set count (before its deadline, for a challenge). The first time a goal is met,
// when and by which lap / session is stored, so it stays met.
//
// Kinds (all from verified core telemetry: lap times and the game's valid flag):
//   lap          a valid lap at or under target ms
//   consistency  a finished session whose consistency score (the session report's formula) is at least target
//   streak       target valid laps in a row in one session
//   window       target laps in one session, each within extra.windowMs of extra.refMs (your best when it was set)
import * as db from './db.js';
import * as svc from './service.js';
import * as report from './report.js';
import { fmtMs as fmt } from './ai.js';

export const KINDS = ['lap', 'consistency', 'streak', 'window'];
export const SUGGEST_DAYS = 7;          // a suggested challenge runs this many days
export const SUGGEST_COMBOS = 3;        // suggestions for this many recently driven cars and tracks
const RECENT_MS = 30 * 86400e3;         // "recently driven" for suggestions
const DAY_MS = 86400e3;

let liveSession = () => null;
/** The server says which session is being driven: a consistency goal waits until that session is over. */
export function setLiveSession(fn) { liveSession = fn; }

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const secs = (ms) => `${(ms / 1000).toFixed(2)} s`;
const same = (a, b) => a.track === b.track && a.layout === b.layout && a.car === b.car;
const keyOf = (c) => `${c.track}|${c.layout}|${c.car}`;
const comboOfKey = (k) => { const [track, layout, car] = String(k || '').split('|'); return track && car != null ? { track, layout: layout ?? '', car } : null; };

/** What the goal asks for, in words. */
export function describe(g) {
  if (g.kind === 'lap') return `A valid lap of ${fmt(g.target)} or faster`;
  if (g.kind === 'consistency') return `Consistency score of ${g.target} or more in a session`;
  if (g.kind === 'streak') return `${g.target} valid laps in a row in one session`;
  if (g.kind === 'window') return `${g.target} laps in one session within ${secs(g.extra.windowMs)} of ${fmt(g.extra.refMs)}`;
  return g.kind;
}

/** Check and normalise a new goal (body of POST /api/goals). -> the row to store. */
export function validate(b, now = Date.now()) {
  const combo = b.combo || comboOfKey(b.key);
  if (!combo?.track || !combo.car) throw bad('Pick a track and car');
  if (!KINDS.includes(b.kind)) throw bad('Unknown kind of goal');
  if (!db.lapsForCombo(combo.track, combo.layout, combo.car).length) throw bad('No laps with this car on this track yet');
  const n = Number(b.target);
  const int = (lo, hi, what) => { if (!Number.isInteger(n) || n < lo || n > hi) throw bad(`${what} must be a whole number from ${lo} to ${hi}`); return n; };
  let target, extra = {};
  if (b.kind === 'lap') { if (!(n >= 10e3 && n <= 30 * 60e3)) throw bad('Lap time must be between 0:10 and 30:00'); target = Math.round(n); }
  else if (b.kind === 'consistency') target = int(1, 100, 'The score');
  else if (b.kind === 'streak') target = int(2, 200, 'The number of laps');
  else {
    target = int(2, 100, 'The number of laps');
    const w = Number(b.extra?.windowMs), ref = Number(b.extra?.refMs ?? svc.comboInfo(combo).best?.lap_time_ms);
    if (!(w >= 50 && w <= 5000)) throw bad('The window must be between 0.05 and 5 s');
    if (!(ref >= 10e3 && ref <= 30 * 60e3)) throw bad('No valid lap to measure the window from');
    extra = { windowMs: Math.round(w), refMs: Math.round(ref) };
  }
  let dueAt = null;
  if (b.days != null && b.days !== '') {
    const d = Number(b.days);
    if (!Number.isInteger(d) || d < 1 || d > 90) throw bad('A challenge runs 1 to 90 days');
    dueAt = now + d * DAY_MS;
  }
  const origin = ['me', 'suggested', 'plan'].includes(b.origin) ? b.origin : 'me';
  return { combo, kind: b.kind, target, extra, origin, createdAt: now, dueAt };
}

// ---------------------------------------------------------------- checking
/** Laps of a combo that count for a goal, oldest first, grouped by session (laps without a session stand alone). */
function lapsFor(g) {
  const laps = db.lapsForCombo(g.combo.track, g.combo.layout, g.combo.car)
    .filter((l) => l.recorded_at >= g.createdAt && (g.dueAt == null || l.recorded_at <= g.dueAt))
    .sort((a, b) => a.recorded_at - b.recorded_at);
  const sessions = new Map();
  for (const l of laps) {
    const k = l.session_id ?? `lap${l.id}`;
    if (!sessions.has(k)) sessions.set(k, []);
    sessions.get(k).push(l);
  }
  return { laps, sessions };
}

/** Where a goal stands from the laps: {met: {at, sessionId, lapId, value} | null, best, bestText}. Pure apart from reading laps. */
export function measure(g) {
  const { laps, sessions } = lapsFor(g);
  const hit = (l, value) => ({ at: l.recorded_at, sessionId: l.session_id ?? null, lapId: l.id, value });
  if (g.kind === 'lap') {
    const valid = laps.filter((l) => l.valid);
    const first = valid.find((l) => l.lap_time_ms <= g.target);
    const best = valid.length ? Math.min(...valid.map((l) => l.lap_time_ms)) : null;
    return { met: first ? hit(first, first.lap_time_ms) : null, best, bestText: best != null ? `best since: ${fmt(best)}` : 'no valid lap since' };
  }
  if (g.kind === 'consistency') {
    const live = liveSession();
    let best = null, met = null;
    for (const [sid, ls] of sessions) {
      if (sid === live || typeof sid !== 'number') continue; // a running session can still change; single laps have no score
      const c = report.consistencyOf(ls);
      if (c.score == null) continue;
      if (best == null || c.score > best) best = c.score;
      if (!met && c.score >= g.target) met = hit(ls.at(-1), c.score);
    }
    return { met, best, bestText: best != null ? `best since: ${best}` : 'no finished session with 3 clean laps since' };
  }
  if (g.kind === 'streak' || g.kind === 'window') {
    let best = 0, met = null;
    for (const ls of sessions.values()) {
      let run = 0;
      for (const l of ls) {
        const counts = g.kind === 'streak' ? l.valid : l.valid && l.lap_time_ms <= g.extra.refMs + g.extra.windowMs;
        run = counts ? run + 1 : g.kind === 'streak' ? 0 : run; // a window counts laps in the session, a streak in a row
        if (run > best) best = run;
        if (!met && run >= g.target) met = hit(l, run);
      }
    }
    return { met, best, bestText: `best since: ${best} lap${best === 1 ? '' : 's'}` };
  }
  return { met: null, best: null, bestText: '' };
}

/** A goal with its state: 'met' | 'open' | 'missed' (a challenge past its deadline). Stores a newly met goal. */
export function status(g, now = Date.now()) {
  const m = measure(g);
  let met = g.met;
  let fresh = false;
  if (!met && m.met) { db.setGoalMet(g.id, m.met); met = m.met; fresh = true; }
  const state = met ? 'met' : g.dueAt != null && now > g.dueAt ? 'missed' : 'open';
  return { ...g, text: describe(g), challenge: g.dueAt != null, state, met, fresh, progress: m.best, progressText: m.bestText,
    metInTime: met ? g.dueAt == null || met.at <= g.dueAt : null };
}

/** All goals and challenges with their state, open first. */
export function list(now = Date.now()) {
  const order = { open: 0, met: 1, missed: 2 };
  return db.listGoals().map((g) => status(g, now)).sort((a, b) => order[a.state] - order[b.state] || b.createdAt - a.createdAt);
}

/** After a lap: the goals of its track + car that are met for the first time. */
export function checkAfterLap(combo, now = Date.now()) {
  return db.listGoals().filter((g) => !g.met && same(g.combo, combo)).map((g) => status(g, now)).filter((g) => g.fresh);
}

export function create(body, now = Date.now()) {
  const g = validate(body, now);
  const open = db.listGoals().find((x) => !x.met && same(x.combo, g.combo) && x.kind === g.kind && x.target === g.target && (x.dueAt == null || x.dueAt > now));
  if (open) throw bad('You already have this goal');
  return status(db.getGoal(db.addGoal(g)), now);
}
export function remove(id) {
  if (!db.getGoal(id)) throw Object.assign(new Error('Goal not found'), { status: 404 });
  db.deleteGoal(id);
}

// ---------------------------------------------------------------- suggestions
/** Longest run of valid laps in one session, and the most laps within windowMs of refMs in one session, over these laps. */
function history(laps, refMs, windowMs) {
  const bySes = new Map();
  for (const l of [...laps].sort((a, b) => a.recorded_at - b.recorded_at)) {
    const k = l.session_id ?? `lap${l.id}`;
    if (!bySes.has(k)) bySes.set(k, []);
    bySes.get(k).push(l);
  }
  let streak = 0, within = 0, score = null;
  for (const [k, ls] of bySes) {
    let run = 0, n = 0;
    for (const l of ls) { run = l.valid ? run + 1 : 0; streak = Math.max(streak, run); if (l.valid && refMs && l.lap_time_ms <= refMs + windowMs) n++; }
    within = Math.max(within, n);
    if (typeof k === 'number') { const c = report.consistencyOf(ls).score; if (c != null && (score == null || c > score)) score = c; }
  }
  return { streak, within, score };
}

/**
 * Challenges Paddock suggests from your laps, for the most driven cars and tracks of the last 30 days: a bit faster
 * than your best (towards your ideal lap), laps close to your best, a longer clean run, a better consistency score.
 * Plus the lap target of an active training plan (P8), as a goal. Those you already have open are left out.
 */
export function suggest(now = Date.now(), plans = () => null) {
  const laps = db.listLaps().filter((l) => l.source === 'local');
  const recent = new Map();
  for (const l of laps) if (now - l.recorded_at < RECENT_MS) recent.set(keyOf(l), (recent.get(keyOf(l)) || 0) + 1);
  const open = db.listGoals().filter((g) => !g.met && (g.dueAt == null || g.dueAt > now));
  const has = (combo, kind) => open.some((g) => same(g.combo, combo) && g.kind === kind);
  const out = [];
  for (const [key] of [...recent].sort((a, b) => b[1] - a[1]).slice(0, SUGGEST_COMBOS)) {
    const combo = comboOfKey(key);
    let info; try { info = svc.comboInfo(combo); } catch { continue; } // lap data unreadable: no suggestion here
    const B = info.best?.lap_time_ms;
    if (!B) continue;
    const I = info.ideal?.timeMs ?? null;
    const h = history(laps.filter((l) => keyOf(l) === key), B, 500);
    const add = (kind, target, extra, why, origin = 'suggested', days = SUGGEST_DAYS) => {
      if (has(combo, kind)) return;
      const g = { combo, kind, target, extra };
      out.push({ key, combo, kind, target, extra, days, origin, text: describe(g), why });
    };
    const plan = plans(combo)?.targets?.find((t) => t.kind === 'lap');
    if (plan) add('lap', plan.ms, {}, 'The lap target of your training plan.', 'plan', null);
    else {
      const gap = I != null ? B - I : 0;
      const step = gap >= 200 ? Math.min(500, Math.round(gap / 2 / 10) * 10) : 100;
      add('lap', B - step, {}, I != null && gap >= 200 ? `Your best is ${fmt(B)}; your ideal lap (best corners put together) is ${fmt(I)}.` : `Your best is ${fmt(B)}.`);
    }
    if (h.within >= 5) {
      const h3 = history(laps.filter((l) => keyOf(l) === key), B, 300);
      add('window', h3.within >= 5 ? 8 : 5, { windowMs: 300, refMs: B }, `You have done ${h.within} laps within 0.50 s of your best in one session.`);
    } else add('window', 5, { windowMs: 500, refMs: B }, h.within ? `Your most laps within 0.50 s of your best in one session: ${h.within}.` : 'Laps close to your best, again and again: the base of a good race pace.');
    const want = h.streak < 5 ? 5 : h.streak < 10 ? 10 : h.streak < 20 ? 20 : h.streak + 10;
    add('streak', want, {}, h.streak ? `Your longest run of valid laps here is ${h.streak}.` : 'No valid laps in a row yet.');
    if (h.score != null && h.score < 98) add('consistency', Math.min(98, Math.max(h.score + 3, 70)), {}, `Your best session here scored ${h.score}.`);
  }
  return out;
}
