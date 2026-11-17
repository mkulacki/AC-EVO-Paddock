// Home dashboard data (src/service.js dashboard): every number traceable to the stored laps and reports; nothing
// invented when there is no data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolate, seedRandom } from './helpers.js';

isolate('dashboard');
seedRandom(5);
const db = await import('../src/db.js');
const svc = await import('../src/service.js');
const report = await import('../src/report.js');
const { seedLaps } = await import('../src/mock.js');

test('no laps: zeros and empty lists, no made-up values', () => {
  const d = svc.dashboard();
  assert.equal(d.totals.laps, 0);
  assert.equal(d.totals.lastAt, null);
  assert.deepEqual([d.recentSessions, d.records, d.trends, d.targets], [[], [], [], []]);
});

await seedLaps(6);
const sid = db.listSessions()[0].id;
report.make(sid);
svc.invalidate();

test('totals and records match the stored laps', () => {
  const laps = db.listLaps();
  const valid = laps.filter((l) => l.valid);
  const d = svc.dashboard();
  assert.equal(d.totals.laps, laps.length);
  assert.equal(d.totals.validLaps, valid.length);
  assert.equal(d.totals.sessions, 1);
  assert.equal(d.totals.drivingMs, laps.reduce((a, l) => a + l.lap_time_ms, 0));
  assert.equal(d.totals.last7, laps.length);
  assert.equal(d.records.length, 1);
  const r = d.records[0];
  assert.equal(r.bestMs, Math.min(...valid.map((l) => l.lap_time_ms)));
  assert.equal(r.idealMs, svc.overview().combos[0].idealMs);
  assert.ok(r.idealMs <= r.bestMs);
});

test('recent sessions carry the report summary', () => {
  const d = svc.dashboard();
  const s = d.recentSessions[0];
  const rep = db.getReport(sid).data;
  assert.equal(s.id, sid);
  assert.equal(s.bestMs, rep.best.ms);
  assert.equal(s.report.consistency, rep.consistency.score);
  assert.equal(s.report.avgCleanMs, rep.average.cleanMs);
});

test('trend = best lap per driving day (from Progress); targets from the newest report', () => {
  const d = svc.dashboard();
  assert.equal(d.trends.length, 1);
  const p = svc.progress(d.trends[0]);
  assert.deepEqual(d.trends[0].days.map((x) => x.bestMs), p.days.map((x) => x.bestMs));
  assert.equal(d.targets.length, 1);
  assert.deepEqual(d.targets[0].targets.map((t) => t.text), db.getReport(sid).data.targets.map((t) => t.text));
  assert.equal(d.targets[0].lastCheck, null, 'the first report has no earlier targets to check');
});

test('old laps fall out of "last 7 days" by the clock given', () => {
  const d = svc.dashboard({ now: Date.now() + 8 * 86400e3 });
  assert.equal(d.totals.last7, 0);
  assert.equal(d.totals.last30, d.totals.laps);
});
