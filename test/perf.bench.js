// Recording and history performance benchmark (PL3): `npm run bench` (add `-- --quick` for a short run,
// `-- --out file.json` to keep the numbers). Not part of `npm test`: it takes a few minutes.
//
// Everything runs on the mock telemetry source with seeded random numbers, in a scratch data dir (test/helpers.js):
// never on real shared memory, never in data\ or Saved Games\ACE. Method and results: docs/platform/PERFORMANCE.md.
//
// Scenarios:
//  1. lap save      encode (JSON + gzip) and insert of one full-density mock lap
//  2. tick          the telemetry tick (Recorder + LiveHud, as in src/server.js) driven frame by frame as fast as
//                   possible, with H laps of history on the same car and track; the slow frames are the lap ends
//  3. history       routes and jobs over a large history (N laps over many cars and tracks)
//  4. live          the real server (--mock) for a while, with pages loaded meanwhile; its own /api/diagnostics/perf
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { isolate, seedRandom, ROOT } from './helpers.js';

const argv = process.argv.slice(2);
const QUICK = argv.includes('--quick');
const OUT = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : null;
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1].split(',') : null;
const want = (s) => !only || only.includes(s);
const LIVE_S = Number(argv.includes('--live-seconds') ? argv[argv.indexOf('--live-seconds') + 1] : QUICK ? 20 : 75);

const env = isolate('bench');
seedRandom(7);
const db = await import('../src/db.js');
const { Recorder } = await import('../src/recorder.js');
const { MockSource, seedLaps } = await import('../src/mock.js');
const { LiveHud } = await import('../src/live.js');
const { Hist } = await import('../src/perf.js');
const svc = await import('../src/service.js');

const now = () => performance.now();
const r2 = (v) => Math.round(v * 100) / 100;
const stats = (xs) => { const s = xs.slice().sort((a, b) => a - b); return { n: s.length, median: r2(s[Math.floor(s.length / 2)]), p90: r2(s[Math.floor(s.length * 0.9)]), max: r2(s[s.length - 1]) }; };
const timeIt = (fn, n = 5) => { const xs = []; for (let i = 0; i < n; i++) { const t = now(); fn(); xs.push(now() - t); } return stats(xs); };
const results = { when: new Date().toISOString(), node: process.versions.node, electron: process.versions.electron ?? null, quick: QUICK, platform: `${process.platform} ${process.arch}` };
const log = (k, v) => { results[k] = v; console.log(`\n## ${k}\n${JSON.stringify(v, null, 1)}`); };

// ---------------------------------------------------------------- base laps (real mock laps, full density)
const base = [];
await seedLaps(QUICK ? 6 : 12, (l) => base.push(l.id));
const baseLaps = base.map((id) => db.getLap(id));
const COLS = 'session_id, track, layout, car, lap_number, lap_time_ms, valid, driver, source, recorded_at, track_length, samples, data, setup_name, setup_info';
/** Copies of the base laps (new ids, so nothing is cached for them): count laps on one combo, in sessions of perSession. */
function cloneLaps(count, { track = 'mock_ring', layout = 'gp', car = 'mock_gt3', perSession = 15, at = Date.now() - 86400e3 * 30 } = {}) {
  const ins = db.raw.prepare(`INSERT INTO laps (${COLS}) SELECT ?, ?, ?, ?, lap_number, lap_time_ms, valid, driver, source, ?, track_length, samples, data, setup_name, setup_info FROM laps WHERE id = ?`);
  db.raw.exec('BEGIN');
  let sid = null;
  for (let i = 0; i < count; i++) {
    if (i % perSession === 0) sid = db.createSession({ track, layout, car, sessionType: 0, driver: 'Mock Driver', startedAt: at + i * 120e3 });
    ins.run(sid, track, layout, car, at + i * 120e3, base[i % base.length]);
  }
  db.raw.exec('COMMIT');
}

// ---------------------------------------------------------------- 1. lap save
if (want('lapsave')) {
  const lap = baseLaps[1];
  const blob = db.encodeData(lap.data);
  const meta = { sessionId: lap.session_id, track: 'bench_save', layout: 'x', car: 'x', lapNumber: 1, lapTimeMs: lap.lap_time_ms, valid: true, driver: 'Mock Driver', recordedAt: Date.now(), trackLength: lap.track_length, data: lap.data };
  log('1 lap save', {
    samples: lap.data.t.length, carSamples: lap.data.car?.k?.length ?? 0,
    jsonBytes: JSON.stringify(lap.data).length, gzipBytes: blob.length,
    stringifyMs: timeIt(() => JSON.stringify(lap.data), 20),
    encodeMs: timeIt(() => db.encodeData(lap.data), 20),
    decodeMs: timeIt(() => db.decodeData(blob), 20),
    insertLapMs: timeIt(() => db.insertLap(meta), 20),
  });
  db.raw.exec("DELETE FROM laps WHERE track = 'bench_save'");
}

// ---------------------------------------------------------------- 2. telemetry tick with history on the same combo
/** Drive laps of the mock car through a Recorder + LiveHud; per-frame time of what the 60 Hz tick does for them. */
function driveTick(laps) {
  const rec = new Recorder(() => 'Mock Driver');
  const hud = new LiveHud(rec);
  const src = new MockSource();
  const all = new Hist(); const ends = [];
  let first = null, saved = 0, after = -1, worst = 0;
  rec.on('lap', () => { saved++; });
  while (saved < laps) {
    src.step();
    const f = src.frame();
    const before = saved;
    const t = now();
    rec.onFrame(f); hud.onFrame(f); hud.snapshot();
    const ms = now() - t;
    all.add(ms);
    if (first == null && hud.refs) first = ms; // the first frame with references: a cold start of the session
    if (saved !== before) { after = 3; worst = 0; }
    if (after >= 0) { worst = Math.max(worst, ms); if (after-- === 0) ends.push(worst); }
  }
  // lapEnd: the worst of the frame that saved a lap and the 3 after it (the HUD reloads its references on the next one)
  rec.endSession();
  return { frames: all.summary(), firstRefsFrameMs: first == null ? null : r2(first), lapEndFrameMs: stats(ends) };
}
if (want('tick')) {
  const out = {};
  let have = db.lapsForCombo('mock_ring', 'gp', 'mock_gt3').length;
  for (const H of QUICK ? [0, 100] : [0, 100, 300, 600]) {
    if (H > have) { cloneLaps(H - have); have = H; }
    svc.invalidate();
    const t = now();
    const res = driveTick(QUICK ? 2 : 3);
    out[`history ${H}`] = { ...res, wallMs: Math.round(now() - t) };
    have = db.lapsForCombo('mock_ring', 'gp', 'mock_gt3').length;
  }
  log('2 tick', out);
}

// ---------------------------------------------------------------- 3. large history: routes and jobs
if (want('history')) {
  const out = {};
  const report = await import('../src/report.js');
  const goals = await import('../src/goals.js');
  const achievements = await import('../src/achievements.js');
  const weekends = await import('../src/weekends.js');
  const dataexport = await import('../src/dataexport.js');
  const backup = await import('../src/backup.js');
  const lapfile = await import('../src/lapfile.js');
  for (const N of QUICK ? [1000] : [1000, 5000]) {
    const have = db.counts().laps;
    if (N > have) {
      const per = Math.ceil((N - have) / 40);
      for (let c = 0; c < 40 && db.counts().laps < N; c++) cloneLaps(Math.min(per, N - db.counts().laps), { track: `bench_track_${c % 10}`, car: `bench_car_${Math.floor(c / 10)}` });
    }
    const sid = db.listSessions().find((s) => s.track === 'bench_track_0')?.id;
    const combo = { track: 'bench_track_0', layout: 'gp', car: 'bench_car_0' };
    const lapId = db.lapsForCombo(combo.track, combo.layout, combo.car)[0].id;
    const exp = lapfile.exportLapFile(db.getLap(lapId));
    out[`${db.counts().laps} laps`] = {
      dbMb: r2(fs.statSync(path.join(env.ACEVO_DATA, 'telemetry.db')).size / 1048576),
      listLapsMs: timeIt(() => db.listLaps()),
      overviewMs: timeIt(() => svc.overview()),
      dashboardMs: timeIt(() => svc.dashboard()),
      developmentMs: timeIt(() => { const laps = db.listLaps().filter((l) => l.source === 'local'); const list = goals.list(); achievements.compute({ laps, goals: list, weekends: weekends.history(laps), live: null }); }, 3),
      comboInfoColdMs: (() => { svc.invalidate(); const t = now(); svc.comboInfo(combo); return r2(now() - t); })(),
      consistencyMs: timeIt(() => svc.consistency(combo), 3),
      progressMs: (() => { svc.invalidate(); const t = now(); svc.progress(combo); return r2(now() - t); })(),
      reportBuildMs: timeIt(() => report.build(sid), 3),
      lapsCsvMs: timeIt(() => dataexport.lapsCsv(), 3),
      lapExportMs: timeIt(() => lapfile.exportLapFile(db.getLap(lapId)), 5),
      lapImportParseMs: timeIt(() => lapfile.parseLapFile(exp), 5),
      vacuumIntoMs: timeIt(() => db.vacuumInto(path.join(env.dir, 'vacuum.db')), 1),
    };
    const t = now(); const b = await backup.create(); out[`${db.counts().laps} laps`].backupCreateTotalMs = r2(now() - t); backup.remove(b.name);
  }
  log('3 history', out);
}

// ---------------------------------------------------------------- 4. the live server
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
if (want('live')) {
  // history for this run: at least LIVE_COMBO laps on the mock car and track, and LIVE_TOTAL laps in all
  const LIVE_COMBO = QUICK ? 100 : 400, LIVE_TOTAL = QUICK ? 600 : 2000;
  const onCombo = db.lapsForCombo('mock_ring', 'gp', 'mock_gt3').length;
  if (onCombo < LIVE_COMBO) cloneLaps(LIVE_COMBO - onCombo);
  for (let c = 0; db.counts().laps < LIVE_TOTAL; c++) cloneLaps(Math.min(50, LIVE_TOTAL - db.counts().laps), { track: `live_track_${c % 10}`, car: `live_car_${Math.floor(c / 10)}` });
  const port = await freePort();
  const childEnv = { ...process.env, ...env, PADDOCK_TEST_SEED: '7', PORT: String(port), PADDOCK_HIRES_TIMER: '1' };
  if (!process.versions.electron) delete childEnv.ELECTRON_RUN_AS_NODE;
  const server = spawn(process.execPath, ['--no-warnings', '--import', pathToFileURL(path.join(ROOT, 'test/preload-seed.js')).href, path.join(ROOT, 'src/server.js'), '--mock', '4'], { env: childEnv, cwd: ROOT });
  let out = '';
  server.stdout.on('data', (b) => { out += b; }); server.stderr.on('data', (b) => { out += b; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 30000);
    const poll = setInterval(() => { if (out.includes(`running: http://localhost:${port}`)) { clearInterval(poll); clearTimeout(timer); resolve(); } }, 50);
  });
  const base = `http://127.0.0.1:${port}`;
  const get = (p) => fetch(base + p).then((r) => r.text());
  const end = Date.now() + LIVE_S * 1000;
  const pages = ['/api/overview', '/api/dashboard', '/api/development', '/api/status', '/api/hud'];
  let k = 0;
  // a page load every 2 s (someone browsing Paddock while driving) plus the HUD's own reads
  while (Date.now() < end) { await get(pages[k++ % pages.length]).catch(() => {}); await new Promise((r) => setTimeout(r, 2000)); }
  const perfNow = JSON.parse(await get('/api/diagnostics/perf'));
  server.kill();
  log('4 live', { seconds: LIVE_S, historyLaps: db.counts().laps, mockComboLaps: db.lapsForCombo('mock_ring', 'gp', 'mock_gt3').length, savedLapsInRun: (out.match(/\[lap\]/g) || []).length, perf: perfNow });
}

if (OUT) fs.writeFileSync(OUT, JSON.stringify(results, null, 1));
console.log('\nbench done');
process.exit(0);
