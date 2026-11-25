// PL6 lap analysis end to end (src/service.js lapAnalysisAsync): synthetic laps with known patterns (test/lapfixtures.js)
// in a scratch database, through resampling, corner detection, the per-lap metrics and src/opportunities.js.
//
// 12 laps in 3 sessions on the fixture circuit:
//   T1 (hairpin)  8 of 12 laps brake early and soft (brake factor 0.75): the loss is on the entry
//   T2            8 of 12 laps hold half throttle for 50 m after the corner, a gear taller: the loss is on the exit
//   T3            the same in every lap: no opportunity
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolate } from './helpers.js';
import { COMBO, insertLap, lapData } from './lapfixtures.js';

isolate('lapanalysis');
const db = await import('../src/db.js');
const svc = await import('../src/service.js');
const notes = await import('../src/notes.js');

const params = (i) => ({ brake: [i % 3 !== 0 ? 0.75 : 1, 1, 1], hold: [0, i % 3 !== 1 ? 50 : 0, 0], gear: [0, i % 3 !== 1 ? 1 : 0, 0] });
const sessions = [];
for (let s = 0; s < 3; s++) sessions.push(db.createSession({ ...COMBO, sessionType: 0, driver: 'Me', startedAt: 1e9 + s * 1e6 }));
const ids = [];
for (let i = 1; i <= 12; i++) ids.push(insertLap(db, { sessionId: sessions[Math.floor((i - 1) / 4)], lapNumber: i, recordedAt: 1e9 + i * 1e5, params: params(i) }));
svc.invalidate();

test('the known patterns come out: T1 lost on the entry by braking early, T2 on the exit by holding the throttle', async () => {
  const r = await svc.lapAnalysisAsync(COMBO);
  assert.equal(r.corners.length, 3);
  assert.deepEqual(r.corners.map((c) => c.name), ['T1', 'T2', 'T3']);
  assert.equal(r.sample.laps, 12);
  assert.deepEqual(r.opportunities, ['T2', 'T1'], 'the held throttle costs more than the early braking');
  const [t1, t2, t3] = r.corners;
  assert.equal(t1.mainPhase, 'entry');
  assert.ok(t1.findings.some((f) => f.key === 'brakePoint' && /later/.test(f.observation)), JSON.stringify(t1.findings));
  assert.equal(t2.mainPhase, 'exit');
  const keys = t2.findings.map((f) => f.key);
  assert.ok(keys.includes('holdMs') && keys.includes('exitSpeed') && keys.includes('minGear'), keys.join());
  assert.ok(t3.gain.realisticMs < 30, `T3 gain ${t3.gain.realisticMs} ms: a few ms carried over from the T2 exit, under the 30 ms floor`);
  assert.equal(t3.rank, undefined);
  // the top cards and their links point at real laps of this corner
  assert.equal(r.top[0].name, 'T2');
  assert.ok(ids.includes(r.top[0].links.typicalLapId) && ids.includes(r.top[0].links.fastLapId));
  // target lap between the ideal and the typical lap; the theoretical ideal is the existing one (comboInfo)
  assert.ok(r.target.targetMs >= r.target.sampleIdealMs && r.target.targetMs <= r.target.medianSumMs);
  assert.equal(r.target.idealMs, svc.comboInfo(COMBO).ideal.timeMs);
  // what the numbers rest on is reported (PL4)
  assert.ok(r.basis.some((b) => b.id === 'core'));
  assert.equal(r.compat.level, 'compatible');
});

test('trend over the 3 sessions and the PB against the previous best', async () => {
  const r = await svc.lapAnalysisAsync(COMBO);
  assert.equal(r.trends.sufficient, true);
  assert.equal(r.trends.sessions.length, 3);
  assert.equal(r.pb.lapId, svc.comboInfo(COMBO).best.id);
  if (r.pb.prev) assert.ok(r.pb.deltaMs < 0);
});

test('reproducible: worked out again from nothing, the result is the same', async () => {
  const a = await svc.lapAnalysisAsync(COMBO);
  svc.invalidate();
  const b = await svc.lapAnalysisAsync(COMBO);
  assert.notEqual(a, b, 'worked out again');
  assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
  assert.equal(await svc.lapAnalysisAsync(COMBO), b, 'kept until the laps change');
});

test('it runs in slices: the event loop gets turns while it works', async () => {
  // another car: none of its laps has been read yet
  const other = { ...COMBO, car: 'fixture_gt_cold' };
  const s = db.createSession({ ...other, sessionType: 0, driver: 'Me', startedAt: 1e9 });
  for (let i = 1; i <= 12; i++) insertLap(db, { sessionId: s, recordedAt: 1e9 + i, params: params(i), combo: other });
  svc.invalidate();
  let turns = 0, done = false;
  const spin = () => { if (!done) { turns++; setImmediate(spin); } };
  setImmediate(spin);
  const r = await svc.lapAnalysisAsync(other, { window: 'all' });
  done = true;
  assert.equal(r.sample.laps, 12);
  assert.ok(turns >= 2, `event loop turns while working: ${turns}`);
});

test('match the newest lap: laps of another game version are left out and listed', async () => {
  for (const id of ids) db.setLapCond(id, { game: id === ids[ids.length - 1] || id === ids[ids.length - 2] ? '0.9.1' : '0.9.0' });
  svc.invalidate(COMBO);
  const any = await svc.lapAnalysisAsync(COMBO);
  assert.equal(any.sample.laps, 12);
  assert.ok(any.compat.items.some((i) => i.key === 'game'), 'the mix of versions is labelled');
  const same = await svc.lapAnalysisAsync(COMBO, { match: 'game' });
  assert.equal(same.sample.laps, 2);
  assert.equal(same.sample.excluded.filter((e) => e.reason === 'another game version').length, 10);
  assert.ok(same.corners.every((c) => !c.sufficient), 'two laps are not enough to conclude anything');
  for (const id of ids) db.setLapCond(id, null);
  svc.invalidate(COMBO);
});

test('a lap without a gear channel: gear comparisons use only laps that have one', async () => {
  const s = db.createSession({ ...COMBO, sessionType: 0, driver: 'Me', startedAt: 2e9 });
  const extra = [];
  for (let i = 0; i < 3; i++) extra.push(insertLap(db, { sessionId: s, recordedAt: 2e9 + i, params: { ...params(2), noGear: true } }));
  svc.invalidate(COMBO);
  const r = await svc.lapAnalysisAsync(COMBO);
  assert.equal(r.noGear, 3);
  const t2 = r.corners[1];
  assert.equal(t2.gears.groups.reduce((a, g) => a + g.passes, 0), r.sample.laps - 3, 'laps without gear are not counted in a gear');
  for (const id of extra) db.deleteLap(id);
  svc.invalidate(COMBO);
});

test('corner bookmarks of this car and track are counted per corner', async () => {
  notes.addBookmark(sessions[0], { corner: 'T2', note: 'exit' });
  svc.invalidate(COMBO);
  const r = await svc.lapAnalysisAsync(COMBO);
  assert.deepEqual(r.bookmarks, { T2: 1 });
});

test('window: the newest laps only, or all of them', async () => {
  const r = await svc.lapAnalysisAsync(COMBO, { window: 'all' });
  assert.equal(r.window, 'all');
  assert.equal((await svc.lapAnalysisAsync(COMBO, { window: 'bogus' })).window, 'recent', 'an unknown window falls back to the default');
  assert.equal(svc.ANALYSIS_WINDOW, 30);
});

test('no valid lap: a plain error, not a made-up analysis', async () => {
  await assert.rejects(svc.lapAnalysisAsync({ track: 'nowhere', layout: '', car: 'none' }), /No valid laps/);
  assert.ok(lapData().lapTimeMs > 0);
});
