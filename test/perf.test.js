// PL3: recording performance. The bounded diagnostics (src/perf.js), the sliced work-out of a car and track
// (src/service.js comboInfoAsync) giving the same result as before, and the HUD's references loaded in the
// background (src/live.js): errors, a changed session meanwhile (cancellation) and concurrent requests (backpressure).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolate, seedRandom } from './helpers.js';

isolate('perf');
seedRandom(11);
const db = await import('../src/db.js');
const svc = await import('../src/service.js');
const report = await import('../src/report.js');
const { Hist, createPerf, perf } = await import('../src/perf.js');
const { buildIdeal, CHANNELS } = await import('../src/analysis.js');
const { LiveHud } = await import('../src/live.js');
const { Recorder } = await import('../src/recorder.js');
const { seedLaps, MockSource } = await import('../src/mock.js');

const tick = () => new Promise((r) => setImmediate(r));

test('Hist: bounded buckets, percentiles at bucket bounds, max exact', () => {
  const h = new Hist();
  for (let i = 0; i < 1000; i++) h.add(16 + (i % 3) * 0.3);
  h.add(900); h.add(-1); h.add(NaN);
  const s = h.summary();
  assert.equal(s.n, 1001, 'negative and NaN values are ignored');
  assert.equal(s.max, 900);
  assert.equal(s.p50, 17);
  assert.equal(h.b.length, 20, 'fixed number of buckets');
});

test('loop timing: late ticks, missed frames and stalls from an injected clock; nothing kept per sample', () => {
  let t = 0;
  const p = createPerf({ now: () => t });
  const run = (gap, work = 0.5) => { t += gap; const t0 = p.tickStart(); t += work; p.tickEnd(t0); };
  for (let i = 0; i < 600; i++) run(16.7);
  run(100);  // 5 frames missed
  run(400);  // a stall
  const s = p.summary();
  assert.equal(s.tickInterval.n, 601, 'intervals between 602 ticks');
  assert.equal(s.lateTicks, 2);
  assert.equal(s.missedFramesEstimate, 5 + 23);
  assert.equal(s.stalls, 1);
  assert.equal(s.tickWork.max, 0.5);
  assert.equal(s.eventLoopDelay, null, 'the event-loop monitor only runs after start()');
  // slow requests: only the route (two path parts), no query string or odd characters; a ring of 20
  for (let i = 0; i < 50; i++) p.request('GET', `/api/laps/${i}?key=SECRET`, 60 + i);
  p.request('POST', '/api/x', 10); // fast: not kept
  const slow = p.summary().slowest;
  assert.equal(slow.length, 10);
  assert.ok(slow.every((x) => x.what === 'GET /api/laps'), JSON.stringify(slow));
  assert.ok(!JSON.stringify(p.summary()).includes('SECRET'));
  p.record('lapSave', 20); p.record('unknown', 5); p.error('hudRefs'); p.error('nope');
  assert.deepEqual(Object.keys(p.summary().jobs), ['lapSave']);
  assert.deepEqual(p.summary().errors, { hudRefs: 1 });
  p.reset();
  assert.equal(p.summary().tickInterval.n, 0);
});

test('the event-loop monitor starts and stops (shutdown)', async () => {
  const p = createPerf();
  p.start();
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(p.summary().eventLoopDelay, 'measured after start');
  p.stop();
  assert.equal(p.summary().eventLoopDelay, null);
});

await seedLaps(8);
const combo = { track: 'mock_ring', layout: 'gp', car: 'mock_gt3' };
/** The ideal lap as worked out before PL3: every lap's whole trace. */
function idealBefore() {
  const info = svc.comboInfo(combo);
  const own = db.lapsForCombo(combo.track, combo.layout, combo.car, true).filter((l) => l.valid);
  return buildIdeal(own.map((l) => ({ id: l.id, R: svc.getResampled(l.id).R })), info.corners);
}
const sameIdeal = (a, b) => {
  assert.equal(a.timeMs, b.timeMs);
  assert.deepEqual(a.sources, b.sources);
  for (const ch of [...CHANNELS, 'd']) assert.deepEqual(a.R[ch], b.R[ch], ch);
};

test('comboInfo: the ideal lap from the kept corner times is the same as from the whole traces', () => {
  svc.invalidate();
  const info = svc.comboInfo(combo);
  assert.ok(info.ideal && info.corners.length > 3);
  sameIdeal(info.ideal, idealBefore());
});

test('comboInfoAsync: the same result in slices, the event loop runs meanwhile; concurrent calls share one run', async () => {
  // copies of the laps on another track: new lap ids, nothing read yet
  const other = { ...combo, track: 'mock_copy' };
  db.raw.prepare(`INSERT INTO laps (session_id, track, layout, car, lap_number, lap_time_ms, valid, driver, source, recorded_at, track_length, samples, data)
    SELECT session_id, 'mock_copy', layout, car, lap_number, lap_time_ms, valid, driver, source, recorded_at, track_length, samples, data FROM laps WHERE track = 'mock_ring'`).run();
  let turns = 0;
  const iv = setInterval(() => { turns++; }, 0);
  const [a, b] = [svc.comboInfoAsync(other), svc.comboInfoAsync(other)];
  const [ia, ib] = await Promise.all([a, b]);
  clearInterval(iv);
  assert.equal(ia, ib, 'one run for both callers (no queue of duplicate work)');
  assert.ok(svc.comboReady(other));
  const own = db.lapsForCombo(other.track, other.layout, other.car, true).filter((l) => l.valid);
  sameIdeal(ia.ideal, buildIdeal(own.map((l) => ({ id: l.id, R: svc.getResampled(l.id).R })), ia.corners));
  assert.equal(ia.ideal.timeMs, svc.comboInfo(combo).ideal.timeMs, 'same laps, same ideal');
  assert.ok(turns > 0, 'the event loop ran between slices');
});

test('comboInfoAsync: laps changed meanwhile, the result is not kept', async () => {
  svc.invalidate();
  const run = svc.comboInfoAsync(combo);
  svc.invalidate(combo); // a lap was saved while it ran
  await run;
  assert.equal(svc.comboReady(combo), false, 'worked out again on the next call');
  await svc.comboInfoAsync(combo);
  assert.equal(svc.comboReady(combo), true);
});

test('session report: corner times from the kept values match the lap traces', () => {
  const info = svc.comboInfo(combo);
  for (const l of db.lapsForCombo(combo.track, combo.layout, combo.car, true).filter((x) => x.valid)) {
    const R = svc.getResampled(l.id).R;
    assert.deepEqual(svc.lapCornerTimes(info, l.id), { n: R.n, dts: info.corners.map((c) => R.t[c.b] - R.t[c.a]) });
  }
  const r = report.build(db.listSessions()[0].id);
  assert.ok(r.corners.all.length > 3 && r.corners.all.every((c) => c.bestEverMs > 0));
});

/** A Recorder + LiveHud in a session on the mock track, without driving a lap. */
function liveSession() {
  const rec = new Recorder(() => 'Mock Driver');
  const hud = new LiveHud(rec);
  const src = new MockSource();
  for (let i = 0; i < 5; i++) { src.step(); const f = src.frame(); rec.onFrame(f); }
  return { rec, hud };
}

test('HUD references: loaded in the background, the telemetry frame does not wait for them', async () => {
  svc.invalidate();
  const { rec, hud } = liveSession();
  assert.equal(hud.loadRefs(), null, 'nothing yet: a new car and track');
  assert.ok(hud.loading, 'loading');
  for (let i = 0; i < 200 && !hud.refs; i++) await tick();
  assert.ok(hud.refs?.best && hud.refs.ideal && hud.refs.sectors, 'ready after a few turns of the event loop');
  assert.equal(hud.loadRefs(), hud.refs);
  rec.endSession();
});

test('HUD references: a changed session meanwhile drops the old load (cancellation)', async () => {
  svc.invalidate();
  const { rec, hud } = liveSession();
  hud.loadRefs();
  const first = hud.loading;
  rec.emit('session', rec.session); // as the recorder does for a new session
  assert.equal(hud.loading, null);
  for (let i = 0; i < 200; i++) await tick();
  assert.equal(hud.refs, null, 'the dropped load did not set references');
  assert.ok(first);
  hud.loadRefs();
  for (let i = 0; i < 200 && !hud.refs; i++) await tick();
  assert.ok(hud.refs?.best);
  rec.endSession();
});

test('HUD references: unreadable lap data shows no reference, is counted in Diagnostics and tried again after a lap', async () => {
  svc.invalidate();
  const before = perf.summary().errors.hudRefs || 0;
  const best = svc.comboInfo(combo).best.id;
  const blob = db.raw.prepare('SELECT data FROM laps WHERE id = ?').get(best).data;
  // a copy of the best lap, one ms faster, whose data cannot be read
  const r = db.raw.prepare(`INSERT INTO laps (session_id, track, layout, car, lap_number, lap_time_ms, valid, driver, source, recorded_at, track_length, samples, data)
    SELECT session_id, track, layout, car, lap_number, lap_time_ms - 1, valid, driver, source, recorded_at, track_length, samples, ? FROM laps WHERE id = ?`).run(Buffer.from('broken'), best);
  svc.invalidate();
  const { rec, hud } = liveSession();
  const origError = console.error; console.error = () => {};
  try {
    hud.loadRefs();
    for (let i = 0; i < 200 && hud.loading; i++) await tick();
  } finally { console.error = origError; }
  assert.equal(hud.refs, null);
  assert.equal(hud.loading, null, 'not retried on every frame');
  assert.equal(perf.summary().errors.hudRefs, before + 1);
  db.deleteLap(Number(r.lastInsertRowid)); svc.invalidate();
  hud.onLap({ id: 0, lapTimeMs: 1, valid: false }); // the next lap: loaded again
  hud.loadRefs();
  for (let i = 0; i < 200 && !hud.refs; i++) await tick();
  assert.ok(hud.refs?.best, 'recovered');
  assert.notEqual(blob.length, 0);
  rec.endSession();
});
