// Achievements (P9, decision D3): milestones worked out from your own laps, sessions, goals and race weekends.
// Nothing is stored: every achievement is recomputed from the data, with the time it was reached (the lap or session
// that crossed the line). Locked ones show how far you are. Only verified core telemetry is used (lap times, the
// game's valid flag, track length), plus your goals and the race weekends Paddock started.
import * as db from './db.js';
import { consistencyOf } from './report.js';

const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };

// [id, group, title, what it takes, need, measure]. measure(state) gives the events (times) at which the counter
// went up, oldest first: the achievement is reached at events[need - 1].
const LADDERS = [
  ['laps', 'Laps', [[1, 'First lap', 'Drive your first lap with Paddock running'], [100, 'Century', 'Drive 100 laps'], [500, 'Regular', 'Drive 500 laps'], [1000, 'Thousand laps', 'Drive 1000 laps'], [2500, 'Iron driver', 'Drive 2500 laps']], (s) => s.lapTimes],
  ['valid', 'Laps', [[1, 'Clean start', 'Drive your first valid lap']], (s) => s.validTimes],
  ['km', 'Distance', [[100, '100 km', 'Drive 100 km in saved laps'], [1000, '1000 km', 'Drive 1000 km in saved laps'], [5000, '5000 km', 'Drive 5000 km in saved laps']], (s) => s.kmTimes],
  ['tracks', 'Variety', [[3, 'Explorer', 'Drive 3 different track layouts'], [10, 'Globetrotter', 'Drive 10 different track layouts']], (s) => s.trackTimes],
  ['cars', 'Variety', [[3, 'Garage', 'Drive 3 different cars'], [10, 'Collector', 'Drive 10 different cars']], (s) => s.carTimes],
  ['days', 'Habit', [[7, 'Week of driving', 'Drive on 7 different days'], [30, 'Dedicated', 'Drive on 30 different days']], (s) => s.dayTimes],
  ['pbs', 'Pace', [[10, 'Getting faster', 'Beat your own best lap 10 times (any car and track)'], [50, 'Relentless', 'Beat your own best lap 50 times']], (s) => s.pbTimes],
  ['streak', 'Clean driving', [[10, 'Clean ten', '10 valid laps in a row in one session'], [25, 'Spotless', '25 valid laps in a row in one session']], (s) => s.streakTimes],
  ['stint', 'Endurance', [[30, 'Long stint', '30 laps in one session']], (s) => s.stintTimes],
  ['consistency', 'Consistency', [[80, 'Metronome', 'A session with a consistency score of 80 or more'], [90, 'Like clockwork', 'A session with a consistency score of 90 or more']], (s) => s.scoreTimes],
  ['goals', 'Goals', [[1, 'Goal getter', 'Meet a goal you set'], [10, 'Achiever', 'Meet 10 goals']], (s) => s.goalTimes],
  ['challenges', 'Goals', [[1, 'Challenge accepted', 'Finish a challenge before its deadline'], [5, 'Challenger', 'Finish 5 challenges before their deadline']], (s) => s.challengeTimes],
  ['weekends', 'Racing', [[1, 'Race weekend', 'Drive a race weekend started from Paddock'], [5, 'Season', 'Drive 5 race weekends started from Paddock']], (s) => s.weekendTimes],
];
export const COUNT = LADDERS.reduce((a, l) => a + l[2].length, 0);

/**
 * The events behind the achievements, from the data. Pure: laps = db rows (own laps), goals = goals.status rows,
 * weekends = weekends.history rows, live = id of the session being driven (its score can still change).
 */
export function state({ laps, goals = [], weekends = [], live = null }) {
  const L = [...laps].sort((a, b) => a.recorded_at - b.recorded_at);
  const s = { lapTimes: [], validTimes: [], kmTimes: [], trackTimes: [], carTimes: [], dayTimes: [], pbTimes: [], streakTimes: [], stintTimes: [], scoreTimes: [], goalTimes: [], challengeTimes: [], weekendTimes: [] };
  let metres = 0, km = 0;
  const tracks = new Set(), cars = new Set(), days = new Set(), best = new Map(), bySes = new Map();
  for (const l of L) {
    const t = l.recorded_at;
    s.lapTimes.push(t);
    if (l.valid) s.validTimes.push(t);
    metres += Number(l.track_length) > 0 ? Number(l.track_length) : 0;
    while (metres >= (km + 1) * 1000) { km++; s.kmTimes.push(t); }
    const tk = `${l.track}|${l.layout}`;
    if (!tracks.has(tk)) { tracks.add(tk); s.trackTimes.push(t); }
    if (!cars.has(l.car)) { cars.add(l.car); s.carTimes.push(t); }
    if (!days.has(dayKey(t))) { days.add(dayKey(t)); s.dayTimes.push(t); }
    if (l.valid) {
      const ck = `${tk}|${l.car}`, b = best.get(ck);
      if (b != null && l.lap_time_ms < b) s.pbTimes.push(t); // the first valid lap on a combo is not a personal best beaten
      if (b == null || l.lap_time_ms < b) best.set(ck, l.lap_time_ms);
    }
    if (l.session_id != null) { if (!bySes.has(l.session_id)) bySes.set(l.session_id, []); bySes.get(l.session_id).push(l); }
  }
  // per session: the longest valid run and the length reached, as events (one per lap that set a new record)
  let streakRec = 0, stintRec = 0;
  const scores = [];
  for (const [sid, ls] of bySes) {
    let run = 0;
    ls.forEach((l, i) => {
      run = l.valid ? run + 1 : 0;
      while (run > streakRec) { streakRec++; s.streakTimes.push(l.recorded_at); }
      while (i + 1 > stintRec) { stintRec++; s.stintTimes.push(l.recorded_at); }
    });
    if (sid !== live) { const c = consistencyOf(ls).score; if (c != null) scores.push({ score: c, at: ls.at(-1).recorded_at }); }
  }
  s.streakTimes.sort((a, b) => a - b); s.stintTimes.sort((a, b) => a - b);
  // a score ladder: event k = the first session that scored k or more (k = 1..100)
  scores.sort((a, b) => a.at - b.at);
  let top = 0;
  for (const x of scores) while (x.score > top) { top++; s.scoreTimes.push(x.at); }
  s.scoreTimes.sort((a, b) => a - b);
  s.goalTimes = goals.filter((g) => g.met && !g.challenge).map((g) => g.met.at).sort((a, b) => a - b);
  s.challengeTimes = goals.filter((g) => g.met && g.challenge && g.metInTime).map((g) => g.met.at).sort((a, b) => a - b);
  s.weekendTimes = weekends.filter((w) => w.laps > 0).map((w) => w.at).sort((a, b) => a - b);
  return s;
}

/** Every achievement: {id, group, title, text, need, have, unlockedAt | null}. Score ladders report the best score as "have". */
export function compute(input) {
  const s = state(input);
  const out = [];
  for (const [base, group, steps, measure] of LADDERS) {
    const ev = measure(s);
    for (const [need, title, text] of steps) {
      out.push({ id: `${base}-${need}`, group, title, text, need, have: Math.min(ev.length, need), unlockedAt: ev.length >= need ? ev[need - 1] : null });
    }
  }
  return out;
}

/** The achievements plus which are new since you last looked (meta achievementsSeenAt). */
export function withSeen(list) {
  const seen = Number(db.getMeta('achievementsSeenAt')) || 0;
  return { items: list.map((a) => ({ ...a, isNew: a.unlockedAt != null && a.unlockedAt > seen })), seenAt: seen, unlocked: list.filter((a) => a.unlockedAt != null).length, total: list.length };
}
export function markSeen(now = Date.now()) { db.setMeta('achievementsSeenAt', now); }

