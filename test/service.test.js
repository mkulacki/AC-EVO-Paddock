// Lap storage, compare, consistency, progress and session reports on laps driven by the mock car (seeded, so
// every run drives the same laps). Values are checked against what the stored laps say, not against fixed numbers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolate, seedRandom } from './helpers.js';

isolate('service');
seedRandom(42);
const db = await import('../src/db.js');
const svc = await import('../src/service.js');
const report = await import('../src/report.js');
const { seedLaps } = await import('../src/mock.js');

const N = 8;
await seedLaps(N);
const laps = db.listLaps();
const combo = { track: laps[0].track, layout: laps[0].layout, car: laps[0].car };
const valid = laps.filter((l) => l.valid);
const bestMs = Math.min(...valid.map((l) => l.lap_time_ms));

test('the mock car saved N laps in one session, with data', () => {
  assert.equal(laps.length, N);
  assert.equal(db.listSessions().length, 1);
  assert.ok(valid.length >= 3, 'enough valid laps for a report');
  const full = db.getLap(laps[0].id);
  for (const ch of ['t', 'd', 'spd', 'thr', 'brk', 'x', 'z']) assert.ok(full.data[ch]?.length > 100, `channel ${ch}`);
  assert.ok(full.data.car, '10 Hz car data recorded');
});

test('overview: best lap is the fastest valid lap; ideal is not slower than it', () => {
  const o = svc.overview();
  assert.equal(o.combos.length, 1);
  const c = o.combos[0];
  assert.equal(c.laps, N);
  assert.equal(c.validLaps, valid.length);
  assert.equal(c.bestMs, bestMs);
  assert.ok(c.idealMs <= bestMs, `ideal ${c.idealMs} vs best ${bestMs}`);
  assert.ok(c.corners >= 3, `${c.corners} corners`);
});

test('compare: a lap against the best lap, delta ends at the lap-time difference', () => {
  const best = valid.find((l) => l.lap_time_ms === bestMs);
  const other = valid.find((l) => l.id !== best.id);
  const r = svc.compare([other.id], 'best');
  assert.equal(r.ref.id, best.id);
  assert.equal(r.laps.length, 1);
  const end = r.laps[0].delta.at(-1);
  assert.ok(Math.abs(end - (other.lap_time_ms - bestMs) / 1000) < 0.01, `delta at the line ${end}`);
  assert.equal(r.laps[0].corners.length, r.corners.length);
  assert.ok(svc.compare([other.id], 'ideal').ref.lapTimeMs <= bestMs);
});

test('consistency: every valid lap with per-corner metrics', () => {
  const r = svc.consistency(combo);
  assert.equal(r.laps.length, valid.length);
  assert.equal(r.bestMs, bestMs);
  assert.ok(r.laps.every((l) => l.corners.length === r.corners.length));
  assert.equal(svc.consistency(combo, 'all', true).laps.length, N);
});

test('progress: one driving day with the session best', () => {
  const r = svc.progress(combo);
  assert.equal(r.days.length, 1);
  assert.equal(r.days[0].bestMs, bestMs);
  assert.equal(r.laps, N);
});

test('session report: matches the stored laps', () => {
  const sid = laps[0].session_id;
  const r = report.make(sid);
  const data = r.data ?? r;
  assert.equal(data.laps.total, N);
  assert.equal(data.laps.valid, valid.length);
  assert.equal(data.best.ms, bestMs);
  const score = data.consistency.score;
  assert.ok(score == null || (score >= 0 && score <= 100));
  assert.ok(db.getReport(sid), 'saved');
  assert.equal(typeof report.headline(data), 'string');
});

test('deleting a lap drops its session report and updates the best', () => {
  const sid = laps[0].session_id;
  const best = valid.find((l) => l.lap_time_ms === bestMs);
  db.deleteLap(best.id);
  svc.invalidate();
  assert.equal(db.getReport(sid), null);
  assert.ok(svc.overview().combos[0].bestMs > bestMs || valid.filter((l) => l.lap_time_ms === bestMs).length > 1);
});
