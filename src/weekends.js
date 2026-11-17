// Race weekend history (P9): sessions Paddock started in the game are recorded as launches, and the sessions driven
// after a race weekend launch are grouped under it. The game reports no "practice / qualifying / race" part, so a
// session belongs to a weekend by time and car + track:
//   - it started after the launch (1 min of slack) and before the next launch of any kind,
//   - within the weekend's planned length (practice + qualifying + warm-up + race) plus WEEKEND_SLACK_MIN of menus,
//   - on the track layout and car of the launch.
import * as db from './db.js';
import * as trackdata from './trackdata.js';
import * as carsDb from './cars.js';
import { describe as describeGoal } from './goals.js';

export const WEEKEND_SLACK_MIN = 90;
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Keep a launch the game confirmed as started (order from src/race.js buildOrder, with its meta). */
export function recordStart(order, at = Date.now()) {
  const m = order?.meta;
  if (!m?.mode) return null; // scans, probes and online joins are not sessions Paddock planned
  return db.addLaunch({ at, mode: m.mode, trackId: m.trackId, layoutKey: m.layoutKey, car: m.car, summary: order.summary, plannedMin: m.plannedMin, goalId: m.goalId ?? null });
}

/** Does a recorded session (the game's names) drive the track layout and car of a launch (catalogue ids)? */
export function matches(session, launch) {
  const h = trackdata.find(session.track, session.layout);
  if (!h || h.track.id !== launch.trackId || (launch.layoutKey && h.layout.key !== launch.layoutKey)) return false;
  const car = carsDb.match(session.car);
  return car ? car.id === launch.car : norm(session.car) === norm(launch.car);
}

/**
 * Group sessions under the race weekend launches. Pure: launches oldest first, sessions as db rows.
 * -> [{launch, sessions: [session rows, oldest first]}], newest weekend first.
 */
export function group(launches, sessions, match = matches) {
  const sorted = [...launches].sort((a, b) => a.at - b.at);
  const out = [];
  sorted.forEach((l, i) => {
    if (l.mode !== 'weekend') return;
    const next = sorted[i + 1]?.at ?? Infinity;
    const end = Math.min(next - 60e3, l.at + ((l.plannedMin || 0) + WEEKEND_SLACK_MIN) * 60e3);
    const mine = sessions.filter((s) => s.started_at >= l.at - 60e3 && s.started_at < end && match(s, l)).sort((a, b) => a.started_at - b.started_at);
    out.push({ launch: l, sessions: mine });
  });
  return out.reverse();
}

/** The race weekends with their sessions' laps and best laps, newest first. */
export function history(laps = db.listLaps().filter((l) => l.source === 'local')) {
  const bySes = new Map();
  for (const l of laps) if (l.session_id != null) { if (!bySes.has(l.session_id)) bySes.set(l.session_id, []); bySes.get(l.session_id).push(l); }
  const reports = new Set(db.reportSessionIds());
  const goalText = (id) => { const g = id != null ? db.getGoal(id) : null; return g ? describeGoal(g) : null; };
  return group(db.listLaunches(), db.listSessions().filter((s) => bySes.has(s.id))).map(({ launch, sessions }) => {
    const rows = sessions.map((s) => {
      const ls = bySes.get(s.id), v = ls.filter((l) => l.valid);
      return { id: s.id, startedAt: s.started_at, type: s.session_type, track: s.track, layout: s.layout, car: s.car, laps: ls.length, validLaps: v.length,
        bestMs: v.length ? Math.min(...v.map((l) => l.lap_time_ms)) : null, hasReport: reports.has(s.id) };
    });
    const best = rows.filter((r) => r.bestMs != null).sort((a, b) => a.bestMs - b.bestMs)[0] || null;
    return { id: launch.id, at: launch.at, summary: launch.summary, plannedMin: launch.plannedMin, sessions: rows,
      laps: rows.reduce((a, r) => a + r.laps, 0), goal: goalText(launch.goalId),
      firstLapAt: rows.length ? Math.min(...sessions.map((s) => Math.min(...bySes.get(s.id).map((l) => l.recorded_at)))) : null, bestMs: best?.bestMs ?? null, bestSession: best?.id ?? null };
  });
}
