// Setup history and comparison (src/setuphistory.js) on laps driven by the mock car, with setups assigned the way
// the setup tracker stores them (a snapshot of the values + setup_info on each lap).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolate, seedRandom } from './helpers.js';

isolate('setuphistory');
seedRandom(7);
const db = await import('../src/db.js');
const sh = await import('../src/setuphistory.js');
const { seedLaps } = await import('../src/mock.js');

await seedLaps(12);
const laps = db.listLaps().sort((a, b) => a.recorded_at - b.recorded_at);
const combo = { track: laps[0].track, layout: laps[0].layout, car: laps[0].car };

// setup A (version 1) on laps 0-3, A edited (version 2) on 4-6, B on 7-9, Standard on 10, lap 11 not recorded
const base = { pressure_FL: 26.5, pressure_FR: 26.5, camber_FL: -3.2, brakesfront_bias: 56, arbs0: 4, front_wing_angle: 3 };
const A1 = { ...base }, A2 = { ...base, pressure_FL: 27.0 }, B = { ...base, camber_FL: -3.6, arbs0: 6, rear_wing_angle: 8 };
db.saveSnapshot('aaaa1', { name: 'Quali', rel: 'car/track/Quali.carsetup', values: A1 });
db.saveSnapshot('aaaa2', { name: 'Quali', rel: 'car/track/Quali.carsetup', values: A2 });
db.saveSnapshot('bbbb1', { name: 'Race', rel: 'car/track/Race.carsetup', values: B });
const ids = (from, to) => laps.slice(from, to).map((l) => l.id);
db.setLapSetups(ids(0, 4), { name: 'Quali', rel: 'car/track/Quali.carsetup', match: 'matched', snap: 'aaaa1' });
db.setLapSetups(ids(4, 7), { name: 'Quali', rel: 'car/track/Quali.carsetup', match: 'matched', snap: 'aaaa2' });
db.setLapSetups(ids(7, 10), { name: 'Race', rel: 'car/track/Race.carsetup', match: 'manual', snap: 'bbbb1' });
db.setLapSetups(ids(10, 11), { name: 'Standard', rel: null, match: 'standard', snap: null });
// lap 11 keeps no setup info (as laps recorded before setups were tracked)
const lap11 = db.listLaps().find((l) => l.id === laps[11].id);
const notRecordedLap = lap11.setup_name == null && lap11.setup_info == null;

const stats = (rows) => {
  const v = rows.filter((l) => l.valid).map((l) => l.lap_time_ms);
  return { laps: rows.length, valid: v.length, best: v.length ? Math.min(...v) : null };
};

test('history: one entry per setup driven, with the lap statistics of exactly its laps', () => {
  const h = sh.history(combo);
  const by = Object.fromEntries(h.map((g) => [g.key, g]));
  const check = (key, from, to) => {
    const s = stats(laps.slice(from, to));
    const g = by[key];
    assert.ok(g, key);
    assert.equal(g.laps, s.laps, `${key} laps`);
    assert.equal(g.validLaps, s.valid, `${key} valid`);
    assert.equal(g.bestMs, s.best, `${key} best`);
    assert.deepEqual(g.lapIds, ids(from, to));
    if (g.cleanLaps) assert.ok(g.medianMs >= g.bestMs);
  };
  check('snap:aaaa1', 0, 4);
  check('snap:aaaa2', 4, 7);
  check('snap:bbbb1', 7, 10);
  check('standard', 10, 11);
  assert.equal(by['snap:bbbb1'].name, 'Race');
  assert.deepEqual(by['snap:bbbb1'].match, ['manual']);
  assert.equal(by.standard.name, 'Standard');
  assert.ok(notRecordedLap, 'the mock recorder stores no setup');
  assert.equal(by.none.name, sh.NOT_RECORDED);
  assert.equal(by.none.laps, 1);
  // newest first
  for (let i = 1; i < h.length; i++) assert.ok(h[i - 1].lastAt >= h[i].lastAt);
});

test('history: the same file driven with other values is a second version', () => {
  const h = sh.history(combo);
  const v1 = h.find((g) => g.key === 'snap:aaaa1'), v2 = h.find((g) => g.key === 'snap:aaaa2');
  assert.deepEqual([v1.version, v1.versions, v2.version, v2.versions], [1, 2, 2, 2]);
  assert.equal(h.find((g) => g.key === 'snap:bbbb1').versions, 1);
});

test('diff: lists exactly the changed values, with labels and the change', () => {
  const d = sh.diff(combo, 'snap:aaaa1', 'snap:bbbb1');
  assert.deepEqual(d.changed.map((c) => c.name).sort(), ['arbs0', 'camber_FL']);
  const cam = d.changed.find((c) => c.name === 'camber_FL');
  assert.deepEqual([cam.a, cam.b, cam.delta, cam.label, cam.corner], [-3.2, -3.6, -0.4, 'Camber', 'FL']);
  assert.equal(d.same, 4);
  assert.deepEqual(d.onlyB, ['rear_wing_angle']);
  assert.deepEqual(d.onlyA, []);
  assert.equal(d.a.source, 'snapshot');
  // version 1 against version 2 of the same file: only the edited pressure
  const v = sh.diff(combo, 'snap:aaaa1', 'snap:aaaa2');
  assert.deepEqual(v.changed.map((c) => [c.name, c.a, c.b]), [['pressure_FL', 26.5, 27]]);
  // identical values: nothing changed
  assert.deepEqual(sh.compareValues(A1, { ...A1 }).changed, []);
});

test('diff: a setup without recorded values says why instead of comparing', () => {
  const d = sh.diff(combo, 'snap:aaaa1', 'standard');
  assert.equal(d.changed, null);
  assert.match(d.reason, /no recorded values/);
  assert.throws(() => sh.diff(combo, 'snap:aaaa1', 'snap:nope'), /not found/);
});

test('forAi: laps split by setup, the engineered setup marked', () => {
  const rows = sh.forAi([combo], 'car/track/Race.carsetup');
  const race = rows.find((r) => r.setup === 'Race');
  assert.equal(race.this_setup, true);
  assert.equal(race.laps, 3);
  assert.ok(rows.some((r) => r.setup === 'Quali (version 2 of 2)'));
  assert.equal(rows.filter((r) => r.this_setup).length, 1);
  assert.ok(JSON.stringify(rows).length < 3000, 'compact for the free tier');
});
