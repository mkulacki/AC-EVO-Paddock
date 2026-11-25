// PL9: the in-game HUD bridge (src/gamebridge.js) under scheduling stalls and slow disks, and its recovery paths.
// Everything runs in scratch folders (isolate(): ACE_DIR is a temporary folder); nothing touches Saved Games\ACE.
// Results are printed as test diagnostics; docs/platform/HUD_BRIDGE.md records a run.
//
// The safety rule under test: a slot is never being written while the HUD may read it. The HUD reads slot w % 8 only in
// window w (and starts only in its first 20 ms); here the whole 50 ms window counts as a read, to be strict.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { isolate } from './helpers.js';

const env = isolate('hudbridge');
const B = await import('../src/gamebridge.js');
const { WINDOW_MS, SLOTS, AHEAD, SLOW_WRITE_MS, BACKOFF_MS, GameBridge } = B;

const quiet = { log() {}, error() {} };
const appDir = (name) => { const d = path.join(env.ACE_DIR, name); fs.mkdirSync(d, { recursive: true }); return d; };
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// a simulated run: the writer timer every 10 ms, stalls of the whole process, write times from ioMs()
function simulate({ seconds = 120, seed = 1, stallP = 0.002, stallMs = [100, 2000], ioMs = () => 1 + Math.random() * 3 }) {
  const r = rng(seed);
  let t = 1_700_000_000_000;
  const end = t + seconds * 1000;
  const writes = [];
  const br = new GameBridge({ snapshot: () => ({ v: 1, now: t }), onCommand() {}, appDir: appDir('sim'), logDir: path.join(env.ACE_DIR, 'nolog'),
    now: () => t, log: quiet,
    writeSlot: (file, buf) => { const a = t; t += ioMs(r); writes.push({ slot: Number(/live(\d)\.json$/.exec(file)[1]), a, b: t, window: JSON.parse(buf.toString()).window }); } });
  let maxStall = 0;
  while (t < end) {
    if (r() < stallP) { const s = stallMs[0] + r() * (stallMs[1] - stallMs[0]); t += s; maxStall = Math.max(maxStall, s); } else t += 10;
    br.write();
  }
  // collisions: a write of slot s overlapping any window w with w % SLOTS == s
  let collisions = 0, fromSlowWrite = 0;
  for (const w of writes) {
    for (let k = Math.floor(w.a / WINDOW_MS); k <= Math.floor(w.b / WINDOW_MS); k++) {
      if (k % SLOTS === w.slot) { collisions++; if (w.b - w.a > SLOW_WRITE_MS) fromSlowWrite++; break; }
    }
  }
  // the data age the HUD would see at the start of each read window (newest slot content it reads vs. now)
  const bySlot = new Map(); let maxAge = 0, wi = 0;
  const sorted = writes.slice().sort((x, y) => x.b - y.b);
  for (let w = Math.floor(writes[0].a / WINDOW_MS) + AHEAD; w * WINDOW_MS < end; w++) {
    const at = w * WINDOW_MS;
    while (wi < sorted.length && sorted[wi].b <= at) { bySlot.set(sorted[wi].slot, sorted[wi]); wi++; }
    const c = bySlot.get(w % SLOTS);
    if (c && c.window <= w) maxAge = Math.max(maxAge, at - c.a);
  }
  return { stats: br.stats(), writes, collisions, fromSlowWrite, maxStall: Math.round(maxStall), maxAge: Math.round(maxAge) };
}

test('scheduling stalls (100 ms to 2 s, about every 5 s): no write ever overlaps its slot\'s read window', (t) => {
  for (const seed of [1, 2, 3]) {
    const r = simulate({ seed });
    t.diagnostic(`stalls seed ${seed}: windows ${r.stats.windows}, writes ${r.stats.writes}, missed windows ${r.stats.missedWindows}, longest gap ${r.stats.maxGapMs} ms, collisions ${r.collisions}, oldest data at a read ${r.maxAge} ms`);
    assert.equal(r.collisions, 0);
    assert.equal(r.stats.lateWrites, 0);
    assert.ok(r.stats.missedWindows > 0, 'stalls happened');
    // a written slot always names a window ahead of the one it was written in (the HUD's clock-mismatch guard holds)
    for (const w of r.writes) assert.ok(w.window * WINDOW_MS > w.b, 'written before its read window');
  }
});

test('slow disk (writes of 80 to 400 ms now and then): back-off after each, collisions only from a write that was itself too slow', (t) => {
  const r = simulate({ seed: 7, stallP: 0.001, ioMs: (rand) => (rand() < 0.01 ? 80 + rand() * 320 : 1 + rand() * 3) });
  t.diagnostic(`slow disk: writes ${r.stats.writes}, slow ${r.stats.slowWrites} (longest ${Math.round(r.stats.maxWriteMs)} ms), paused windows ${r.stats.pausedWindows}, late writes ${r.stats.lateWrites}, collisions ${r.collisions} (all from writes over ${SLOW_WRITE_MS} ms: ${r.fromSlowWrite}), oldest data at a read ${r.maxAge} ms`);
  assert.ok(r.stats.slowWrites > 0);
  assert.equal(r.collisions, r.fromSlowWrite, 'no collision comes from the schedule');
  // after a slow write nothing is written for BACKOFF_MS
  for (let i = 1; i < r.writes.length; i++) {
    const prev = r.writes[i - 1];
    if (prev.b - prev.a > SLOW_WRITE_MS) assert.ok(r.writes[i].a - prev.b >= BACKOFF_MS - 10, `write ${i} came ${r.writes[i].a - prev.b} ms after a slow one`);
  }
  // without the back-off the same disk would put more writes next to reads: compare with a run where every write is slow
  const noBackoff = simulate({ seed: 7, stallP: 0, seconds: 20, ioMs: () => 170 });
  t.diagnostic(`every write 170 ms: writes ${noBackoff.stats.writes} in 20 s (one per ${BACKOFF_MS} ms back-off), collisions ${noBackoff.collisions}`);
  assert.ok(noBackoff.stats.writes <= 20 * 1000 / BACKOFF_MS + 2);
});

test('real files: a reader thread following the HUD rules never sees a partial or future slot, with stalls and slow writes', async (t) => {
  const dir = appDir('real');
  for (let k = 0; k < SLOTS; k++) fs.writeFileSync(B.slotFile(k, dir), B.padLive('{}'));
  const busy = (ms) => { const e = Date.now() + ms; while (Date.now() < e) { /* the event loop is held, as by a long job */ } };
  let n = 0;
  const br = new GameBridge({ snapshot: () => ({ v: 1, now: Date.now(), pad: 'x'.repeat(6000) }), onCommand() {}, appDir: dir, logDir: path.join(env.ACE_DIR, 'nolog'), log: quiet,
    writeSlot: (file, buf) => { if (++n % 15 === 0) busy(20 + (n % 4) * 15); fs.writeFileSync(file, buf); } });
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const fs = require('node:fs'), path = require('node:path');
    const r = { reads: 0, bad: 0, future: 0, errors: 0, maxAge: 0, empty: 0 };
    const end = Date.now() + workerData.ms;
    (function loop() {
      const now = Date.now(), phase = now % 50;
      if (now > end) return parentPort.postMessage(r);
      if (phase >= 20) return setTimeout(loop, 50 - phase + 1);
      const w = Math.floor(now / 50);
      try {
        const txt = fs.readFileSync(path.join(workerData.dir, 'live' + (w % 8) + '.json'), 'utf8');
        r.reads++;
        let j = null; try { j = JSON.parse(txt); } catch { r.bad++; }
        if (j && j.window > w) r.future++;
        if (j && j.now) r.maxAge = Math.max(r.maxAge, Date.now() - j.now); else if (j) r.empty++;
      } catch { r.errors++; }
      setTimeout(loop, 200);
    })();`, { eval: true, workerData: { dir, ms: 4000 } });
  const done = new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
  br.start();
  // the main thread stalls now and then (150 to 600 ms), like a slow job on the telemetry loop
  const stalls = setInterval(() => busy(150 + Math.floor(Math.random() * 450)), 700);
  const res = await done;
  clearInterval(stalls); br.stop();
  const st = br.stats();
  t.diagnostic(`real files 4 s: reads ${res.reads}, partial/unparsable ${res.bad}, future window ${res.future}, open errors ${res.errors}, oldest data ${res.maxAge} ms; writer: writes ${st.writes}, missed windows ${st.missedWindows}, slow ${st.slowWrites}, late ${st.lateWrites}, longest write ${Math.round(st.maxWriteMs)} ms`);
  assert.ok(res.reads > 10);
  assert.equal(res.bad, 0);
  assert.equal(res.future, 0);
  assert.equal(res.errors, 0);
  assert.equal(st.lateWrites, 0);
});

test('recovery: the HUD folder appears later (writes start within 2 s); failed writes are counted, logged once, and recover', () => {
  let t = 1_700_000_000_000;
  const dir = path.join(env.ACE_DIR, 'later');
  const errors = [];
  let fail = false;
  const br = new GameBridge({ snapshot: () => ({ v: 1, now: t }), onCommand() {}, appDir: dir, logDir: path.join(env.ACE_DIR, 'nolog'), now: () => t,
    log: { log() {}, error: (...a) => errors.push(a.join(' ')) },
    writeSlot: (file, buf) => { if (fail) throw Object.assign(new Error('locked'), { code: 'EBUSY' }); fs.writeFileSync(file, buf); } });
  for (let i = 0; i < 100; i++) { t += 50; br.write(); }
  assert.equal(br.stats().writes, 0); // no folder: nothing written, nothing created
  assert.equal(fs.existsSync(dir), false);
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 41; i++) { t += 50; br.write(); }
  assert.ok(br.stats().writes > 0, 'writing started once the folder was there');
  fail = true;
  for (let i = 0; i < 20; i++) { t += 50; br.write(); }
  assert.equal(br.stats().errors, 20);
  assert.equal(errors.length, 1, 'one log line for a run of the same error');
  fail = false;
  const before = br.stats().writes;
  t += 50; br.write();
  assert.equal(br.stats().writes, before + 1);
});

test('recovery: the command log is read past old content, across partial lines, a new log file, a cut-back log; duplicates and stale commands are dropped', () => {
  let t = Date.now();
  const logDir = path.join(env.ACE_DIR, 'Logs-test');
  fs.mkdirSync(logDir, { recursive: true });
  const f1 = path.join(logDir, 'log-1.txt');
  const cmd = (id, at = t) => `[TrainerHUD-cmd] ${JSON.stringify({ id, at, cmd: 'ref', arg: 'cycle' })}\n`;
  fs.writeFileSync(f1, cmd('old-1')); // there before Paddock started: skipped
  const got = [];
  const br = new GameBridge({ snapshot: () => ({}), onCommand: (c) => got.push(c.id), appDir: appDir('x'), logDir, now: () => t, log: quiet });
  br.tail();
  assert.deepEqual(got, []);
  fs.appendFileSync(f1, cmd('a') + cmd('a') + '[TrainerHUD-cmd] {not json\n' + cmd('stale', t - 60000));
  const half = cmd('b');
  fs.appendFileSync(f1, half.slice(0, 20));
  br.tail();
  fs.appendFileSync(f1, half.slice(20));
  br.tail();
  assert.deepEqual(got, ['a', 'b']);
  assert.equal(br.stats().badLines, 1);
  assert.equal(br.stats().staleCommands, 1);
  // the game restarted: a newer log is read from the top
  const f2 = path.join(logDir, 'log-2.txt');
  fs.writeFileSync(f2, `${cmd('c')}some other game log line\n`);
  fs.utimesSync(f2, new Date(), new Date(Date.now() + 5000));
  t += 2500; br.tail();
  assert.deepEqual(got, ['a', 'b', 'c']);
  assert.equal(br.stats().logSwitches, 1);
  // the log was rewritten shorter: read again from the top (ids already seen are not run twice). A rewrite to the same or a
  // larger size is not noticed (the offset is size-based): documented in HUD_BRIDGE.md; the game starts a new file per run
  fs.writeFileSync(f2, cmd('d'));
  br.tail();
  assert.deepEqual(got, ['a', 'b', 'c', 'd']);
  assert.equal(br.stats().logResets, 1);
  // the log folder disappears: no throw, nothing logged as an error
  fs.rmSync(logDir, { recursive: true, force: true });
  t += 2500;
  assert.doesNotThrow(() => br.tail());
});
