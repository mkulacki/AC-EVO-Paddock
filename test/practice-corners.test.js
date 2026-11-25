// PL7 review fixes: a drill follows its corner by where it is when a new best lap renumbers the corners (fix 1);
// drill events left for a reused goals id are ignored and pruned (fix 2); laps without a recorded game version never
// count (fix 3); "met" is recorded in turn with Stop (fix 4); before/after carry their pass counts (fix 5).
// Synthetic laps with known patterns (test/lapfixtures.js); the new best lap lifts on the first straight, which adds
// one speed minimum (a corner) before every other one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolate } from './helpers.js';
import { COMBO, insertLap } from './lapfixtures.js';

isolate('practice-corners');
const db = await import('../src/db.js');
const svc = await import('../src/service.js');
const drills = await import('../src/drills.js');

const params = (i) => ({ brake: [i % 3 !== 0 ? 0.75 : 1, 1, 1], hold: [0, i % 3 !== 1 ? 50 : 0, 0], gear: [0, i % 3 !== 1 ? 1 : 0, 0] });
const sid = db.createSession({ ...COMBO, sessionType: 0, driver: 'Me', startedAt: 1e9 });
for (let i = 1; i <= 12; i++) {
  const id = insertLap(db, { sessionId: sid, lapNumber: i, recordedAt: 1e9 + i * 1e5, params: params(i) });
  if (i !== 5) db.setLapCond(id, { game: '1.0' }); // lap 5: no game version recorded (an older Paddock)
}
// the newest lap: no game version yet
const newest = insertLap(db, { sessionId: sid, lapNumber: 13, recordedAt: 1e9 + 13 * 1e5, params: params(13) });
svc.invalidate();
const T0 = 2e9;
let n = 100;
function drive(k, at, p, game = '1.0') {
  const s = db.createSession({ ...COMBO, sessionType: 0, driver: 'Me', startedAt: at });
  const ids = [];
  for (let i = 1; i <= k; i++) { const id = insertLap(db, { sessionId: s, lapNumber: n++, recordedAt: at + i * 1e5, params: p }); if (game) db.setLapCond(id, { game }); ids.push(id); }
  svc.invalidate(COMBO);
  return ids;
}
let d;

test('fix 3: no drill when the newest lap has no game version; laps without one are left out of the "before" and said', async () => {
  // D-PL7-13: the pages are told why, before anything is tried
  assert.deepEqual(drills.versionReady(COMBO), { ok: false, game: null, reason: "This lap has no recorded game version, so a drill can't be checked" });
  assert.equal((await drills.list({ combo: COMBO })).ready.ok, false);
  await assert.rejects(drills.create({ combo: COMBO, corner: 'T2', key: 'holdMs' }, T0), (e) => e.status === 409 && e.code === 'noVersion' && e.message === "This lap has no recorded game version, so a drill can't be checked.");
  db.setLapCond(newest, { game: '1.0' });
  svc.invalidate(COMBO);
  // fix 2: events an older Paddock left for a deleted goal whose id the new drill gets (goals ids are reused)
  db.addDrillEvent(1, 'stopped', null, 1);
  d = await drills.create({ combo: COMBO, corner: 'T2', key: 'holdMs' }, T0);
  assert.equal(d.id, 1);
  assert.equal(d.active, true, 'the old "stopped" event is not inherited');
  assert.equal(db.drillEvents().get(1), undefined);
  assert.equal(d.prescription.before.n, 12, '13 analysed laps, lap 5 left out');
  assert.equal(d.prescription.evidence.leftOut, 1);
  assert.match(d.prescription.evidence.text, /1 of the 13 analysed laps was left out of the "before" \(another or unrecorded game version\)\.$/);
  // a drill lap without a game version does not count either
  drive(1, T0 + 1e6, { hold: [0, 0, 0] }, null);
  const listed = await drills.list({ combo: COMBO });
  assert.equal(listed.drills[0].versionOk, false, 'the newest lap has no version: Renew / Practise again are disabled on the page');
  const e = listed.drills[0].eval;
  assert.equal(e.passes, 0);
  assert.deepEqual(e.excludedReasons, ['game version not recorded']);
});

test('fix 1: a new best lap with a corner before the drilled one renumbers the corners; the drill follows its corner', async () => {
  const before = await svc.cornerListAsync(COMBO);
  assert.deepEqual(before.map((c) => c.name), ['T1', 'T2', 'T3']);
  // the new best lap: later braking everywhere, a lift on the first straight
  const [best] = drive(1, T0 + 2e6, { brake: [2, 2, 2], dip: { at: 250, kmh: 200 } });
  assert.equal(svc.comboInfo(COMBO).best.id, best);
  const now = await svc.cornerListAsync(COMBO);
  assert.equal(now.length, 4, JSON.stringify(now));
  const out = await drills.list({ combo: COMBO });
  const x = out.drills[0];
  assert.equal(x.cornerAtStart, 'T2');
  assert.equal(x.corner, 'T3', 'the same corner, found by its apex');
  assert.ok(Math.abs(now[2].apex - x.apex) <= 40);
  const m = await drills.masteryFor(COMBO, out.drills);
  assert.equal(m.find((c) => c.name === 'T3').level, 'practising');
  assert.notEqual(m.find((c) => c.name === 'T2').level, 'practising', 'the new T2 is the corner after the lift, not the drilled one');
});

test('fix 4 + 5: Stop and a page working it out at the same time: met once, never also stopped; counts with the shares', async () => {
  drive(5, T0 + 3e6, { hold: [0, 0, 0] });
  const [stopped, listed] = await Promise.allSettled([drills.stop(d.id, T0 + 4e6), drills.list({ combo: COMBO })]);
  assert.equal(stopped.status, 'rejected', 'the passes had met it: there is nothing to stop');
  assert.equal(stopped.reason.status, 409);
  assert.equal(listed.value.drills[0].state, 'met');
  assert.deepEqual(db.drillEvents().get(d.id).map((e) => e.kind), ['met']);
  const r = listed.value.summary.results[0];
  assert.deepEqual([r.corner, r.nBefore, r.nAfter], ['T3', 12, 5]);
});

test('fix 2: at start, events of goals that are gone are removed', () => {
  db.addDrillEvent(999, 'stopped', null, 1);
  db.addDrillEvent(d.id, 'restart', null, 2);
  assert.equal(db.pruneDrillEvents(), 1);
  assert.deepEqual(db.drillEvents().get(d.id).map((e) => e.kind).sort(), ['met', 'restart'], 'a drill that exists keeps its events');
  db.raw.prepare('DELETE FROM goals WHERE id = ?').run(d.id); // what Paddock 0.7.0's deleteGoal does
  assert.equal(db.pruneDrillEvents(), 2);
});
