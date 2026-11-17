// Driver development (P9): goals and challenges checked against laps, suggestions, achievements, race weekend grouping
// and the launch record a Race tab order carries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolate, seedRandom } from './helpers.js';

isolate('development');
seedRandom(5);
const db = await import('../src/db.js');
const goals = await import('../src/goals.js');
const ach = await import('../src/achievements.js');
const weekends = await import('../src/weekends.js');
const { seedLaps } = await import('../src/mock.js');

// a combo with exact lap times (synthetic laps: only the lap list matters to goals)
const C = { track: 'test_track', layout: 'gp', car: 'test_car' };
const T0 = Date.UTC(2026, 9, 1, 12);
let sid = null;
function session(at) { sid = db.createSession({ ...C, sessionType: 0, driver: 'Me', startedAt: at }); return sid; }
function lap(at, ms, valid = true, s = sid, combo = C) {
  return db.insertLap({ sessionId: s, ...combo, lapNumber: 1, lapTimeMs: ms, valid, driver: 'Me', recordedAt: at, trackLength: 5000, data: { t: [0], d: [0], spd: [0] } });
}
const mk = (kind, target, extra = {}, createdAt = T0, dueAt = null) => db.getGoal(db.addGoal({ combo: C, kind, target, extra, createdAt, dueAt }));

// sessions: before the goals, then two after
session(T0 - 3600e3); lap(T0 - 3500e3, 99000);
const sA = session(T0 + 60e3);
[101000, 100500, 100400, 100300, 100800].forEach((ms, i) => lap(T0 + 120e3 + i * 101e3, ms));
const sB = session(T0 + 86400e3);
[100200, 100100, 0, 100150].forEach((ms, i) => lap(T0 + 86400e3 + 60e3 + i * 101e3, ms || 120000, ms !== 0));

test('lap goal: only laps after it was set count; met by the first lap at or under the target, stored once', () => {
  const g = mk('lap', 100300);
  const s = goals.status(g, T0 + 2 * 86400e3);
  assert.equal(s.state, 'met', 'the 1:39.000 from before the goal does not count, the 1:40.300 does');
  assert.equal(s.met.value, 100300);
  assert.equal(s.met.sessionId, sA);
  assert.equal(db.getGoal(g.id).met.value, 100300, 'stored');
  const tough = goals.status(mk('lap', 99500), T0 + 2 * 86400e3);
  assert.equal(tough.state, 'open');
  assert.equal(tough.progress, 100100, 'best since it was set');
  assert.match(tough.progressText, /1:40\.100/);
});

test('challenge: laps after the deadline do not count; past the deadline it is missed', () => {
  const c = mk('lap', 100150, {}, T0, T0 + 3600e3); // ends before session B
  assert.equal(goals.status(c, T0 + 2 * 86400e3).state, 'missed');
  const ok = goals.status(mk('lap', 100400, {}, T0, T0 + 3600e3), T0 + 2 * 86400e3);
  assert.equal(ok.state, 'met');
  assert.equal(ok.metInTime, true);
  assert.equal(ok.challenge, true);
});

test('streak, window and consistency goals use one session at a time', () => {
  const now = T0 + 2 * 86400e3;
  assert.equal(goals.status(mk('streak', 5), now).state, 'met', 'session A: 5 valid in a row');
  const s6 = goals.status(mk('streak', 6), now);
  assert.equal(s6.state, 'open', 'session B breaks the run; runs do not join across sessions');
  assert.equal(s6.progress, 5);
  // window: laps within 0.25 s of 1:40.000 in one session: A has 0, B has 3 (100200, 100100, 100150)
  const w = goals.status(mk('window', 3, { windowMs: 250, refMs: 100000 }), now);
  assert.equal(w.state, 'met');
  assert.equal(w.met.sessionId, sB);
  assert.equal(goals.status(mk('window', 4, { windowMs: 250, refMs: 100000 }), now).state, 'open');
  // consistency: session A's clean laps score well; the session being driven is not counted until it ends
  const cg = mk('consistency', 90);
  goals.setLiveSession(() => sA);
  const live = goals.status(cg, now);
  goals.setLiveSession(() => null);
  assert.equal(live.state === 'met' && live.met.sessionId === sA, false, 'not from the live session');
  const done = goals.status(db.getGoal(cg.id), now);
  assert.equal(done.state, 'met');
  assert.ok(done.met.value >= 90);
});

test('validate: kinds, ranges, combo with laps, deadline in days', () => {
  const v = goals.validate({ combo: C, kind: 'lap', target: 100000, days: 7 }, T0);
  assert.equal(v.dueAt, T0 + 7 * 86400e3);
  assert.equal(goals.validate({ key: 'test_track|gp|test_car', kind: 'streak', target: 10 }).combo.car, 'test_car');
  const bad = (b, re) => assert.throws(() => goals.validate(b), (e) => e.status === 400 && re.test(e.message));
  bad({ combo: C, kind: 'fly', target: 1 }, /Unknown kind/);
  bad({ combo: { ...C, car: 'nope' }, kind: 'lap', target: 100000 }, /No laps/);
  bad({ combo: C, kind: 'lap', target: 5 }, /Lap time/);
  bad({ combo: C, kind: 'streak', target: 2.5 }, /whole number/);
  bad({ combo: C, kind: 'consistency', target: 101 }, /from 1 to 100/);
  bad({ combo: C, kind: 'window', target: 5, extra: { windowMs: 10, refMs: 100000 } }, /window/);
  bad({ combo: C, kind: 'lap', target: 100000, days: 365 }, /1 to 90 days/);
  assert.match(goals.describe({ kind: 'window', target: 5, extra: { windowMs: 500, refMs: 100000 } }), /5 laps in one session within 0\.50 s of 1:40\.000/);
});

test('a goal flips to met from a real lap (mock car, recorder) and is reported once', async () => {
  await seedLaps(1); // learn the mock combo
  const m = db.listLaps().find((l) => l.source === 'local' && l.track !== C.track);
  const combo = { track: m.track, layout: m.layout, car: m.car };
  const id = db.addGoal({ combo, kind: 'lap', target: 30 * 60e3 - 1, extra: {}, createdAt: Date.now() });
  assert.equal(goals.checkAfterLap(combo).length, 0, 'the earlier lap does not count');
  const fresh = [];
  await seedLaps(2, (l) => { if (l.valid) fresh.push(...goals.checkAfterLap(combo)); });
  const s = goals.status(db.getGoal(id));
  assert.equal(s.state, 'met', 'met from a lap driven after it was set');
  assert.equal(fresh.filter((g) => g.id === id).length, 1, 'announced once');
  assert.equal(goals.checkAfterLap(combo).length, 0);
});

test('create refuses a duplicate open goal; remove deletes it', () => {
  const g = goals.create({ combo: C, kind: 'streak', target: 40 });
  assert.throws(() => goals.create({ combo: C, kind: 'streak', target: 40 }), /already/);
  goals.remove(g.id);
  assert.equal(db.getGoal(g.id), null);
  assert.throws(() => goals.remove(g.id), (e) => e.status === 404);
});

test('suggestions: from recent laps of real combos, skip kinds already open, take the training plan lap target', async () => {
  await seedLaps(4);
  const m = db.listLaps().find((l) => l.track !== C.track);
  const combo = { track: m.track, layout: m.layout, car: m.car };
  db.addGoal({ combo, kind: 'lap', target: 10000, extra: {}, createdAt: Date.now() }); // open (too fast to be met)
  const sug = goals.suggest(Date.now()).filter((s) => s.combo.track === combo.track);
  assert.ok(sug.some((s) => s.kind === 'window') && sug.some((s) => s.kind === 'streak'));
  assert.ok(sug.every((s) => s.text && s.why && s.days === goals.SUGGEST_DAYS));
  assert.ok(!sug.some((s) => s.kind === 'lap'), 'a lap goal is already open on this combo');
  for (const s of sug) assert.doesNotThrow(() => goals.validate({ combo: s.combo, kind: s.kind, target: s.target, extra: s.extra, days: s.days }), s.text);
  const C2 = { track: 'x', layout: 'y', car: 'z' };
  assert.equal(goals.suggest(Date.now(), () => null).some((s) => s.combo.track === C2.track), false);
  // with an open plan and no open lap goal: the plan's lap target
  for (const g of db.listGoals().filter((x) => x.kind === 'lap' && x.combo.track === combo.track)) db.deleteGoal(g.id);
  const fromPlan = goals.suggest(Date.now(), (c) => (c.track === combo.track ? { targets: [{ kind: 'lap', ms: 123456 }] } : null)).find((s) => s.kind === 'lap' && s.combo.track === combo.track);
  assert.equal(fromPlan.target, 123456);
  assert.equal(fromPlan.origin, 'plan');
  assert.equal(fromPlan.days, null, 'a goal, not a challenge');
});

test('race weekend grouping: by time window, next launch, car and track', () => {
  const H = 3600e3, at = T0 + 10 * 86400e3;
  const launches = [
    { id: 1, at: at - 5 * H, mode: 'hotlap', trackId: 't', layoutKey: 'gp', car: 'c' },
    { id: 2, at, mode: 'weekend', trackId: 't', layoutKey: 'gp', car: 'c', plannedMin: 100 },
    { id: 3, at: at + 6 * H, mode: 'weekend', trackId: 't', layoutKey: 'gp', car: 'c', plannedMin: 60 },
  ];
  const S = (id, off, track = 'T', car = 'c') => ({ id, started_at: at + off, track, layout: 'gp', car });
  const sessions = [S(10, -2 * H), S(11, 30e3), S(12, 0.6 * H), S(13, 1.6 * H), S(14, 2 * H, 'Other'), S(15, 3.2 * H), S(16, 6 * H + 60e3), S(17, 6.5 * H, 'T', 'd')];
  const match = (s, l) => s.track === 'T' && s.car === l.car;
  const g = weekends.group(launches, sessions, match);
  assert.deepEqual(g.map((w) => w.launch.id), [3, 2], 'weekends only, newest first');
  assert.deepEqual(g[1].sessions.map((s) => s.id), [11, 12, 13], 'inside 100 + 90 min; not the other track, not before, not after');
  assert.deepEqual(g[0].sessions.map((s) => s.id), [16], 'the other car is left out');
  // a launch in between ends the weekend early
  const cut = weekends.group([...launches, { id: 4, at: at + H, mode: 'practice', trackId: 't', layoutKey: 'gp', car: 'c' }], sessions, match);
  assert.deepEqual(cut.find((w) => w.launch.id === 2).sessions.map((s) => s.id), [11, 12]);
});

test('recordStart keeps Paddock-started sessions only', () => {
  assert.equal(weekends.recordStart({ kind: 'scan', summary: 'x' }), null);
  const id = weekends.recordStart({ summary: 'Race weekend · Monza', meta: { mode: 'weekend', trackId: 'monza', layoutKey: 'gp', car: 'ks_car', plannedMin: 75, goalId: 3 } }, T0);
  const l = db.listLaunches().find((x) => x.id === id);
  assert.deepEqual([l.mode, l.trackId, l.plannedMin, l.goalId, l.at], ['weekend', 'monza', 75, 3, T0]);
});

test('achievements: reached at the lap that crossed the line, progress for locked ones', () => {
  const D = 86400e3;
  const L = (i, ms, valid = true, s = 1, extra = {}) => ({ id: i, session_id: s, track: 'a', layout: 'b', car: 'c', lap_time_ms: ms, valid: valid ? 1 : 0, recorded_at: T0 + i * 1000, track_length: 5000, ...extra });
  const laps = [L(1, 100000, false), L(2, 101000), L(3, 100000), L(4, 99000)];
  for (let i = 5; i <= 14; i++) laps.push(L(i, 99500, true, 2));
  laps.push(L(15, 90000, true, 3, { track: 'z', car: 'q', recorded_at: T0 + 3 * D }));
  const list = ach.compute({ laps, goals: [{ met: { at: T0 + 5 }, challenge: false }, { met: { at: T0 + 9 }, challenge: true, metInTime: false }], weekends: [{ at: T0, laps: 3 }, { at: T0, laps: 0 }] });
  const get = (id) => list.find((a) => a.id === id);
  assert.equal(list.length, ach.COUNT);
  assert.equal(get('laps-1').unlockedAt, T0 + 1000);
  assert.equal(get('valid-1').unlockedAt, T0 + 2000, 'the first valid lap, not the first lap');
  assert.deepEqual([get('laps-100').unlockedAt, get('laps-100').have], [null, 15]);
  assert.equal(get('streak-10').unlockedAt, T0 + 14000, 'session 2: 10 valid laps in a row');
  assert.equal(get('km-100').have, 75, '15 laps of 5 km');
  assert.equal(get('tracks-3').have, 2);
  assert.equal(get('days-7').have, 2);
  assert.equal(get('goals-1').unlockedAt, T0 + 5);
  assert.equal(get('challenges-1').unlockedAt, null, 'met after its deadline does not count');
  assert.equal(get('weekends-1').unlockedAt, T0, 'a weekend without laps does not count');
  assert.ok(get('consistency-80').unlockedAt != null, 'session 2 is very consistent');
  const live = ach.compute({ laps, live: 2 });
  assert.equal(live.find((a) => a.id === 'consistency-80').unlockedAt, null, 'not from the session being driven');
  // personal bests: lap 3 and 4 beat the combo's best (lap 2 is the first valid one, not a PB beaten)
  assert.equal(get('pbs-10').have, 2);
});

test('achievements seen: new until marked seen', () => {
  const list = [{ id: 'x', unlockedAt: Date.now() - 1000 }, { id: 'y', unlockedAt: null }];
  assert.equal(ach.withSeen(list).items[0].isNew, true);
  ach.markSeen();
  const w = ach.withSeen(list);
  assert.equal(w.items[0].isNew, false);
  assert.deepEqual([w.unlocked, w.total], [1, 2]);
});
