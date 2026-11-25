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
import vm from 'node:vm';
import { isolate, ROOT } from './helpers.js';

const env = isolate('hudbridge');
const B = await import('../src/gamebridge.js');
const { WINDOW_MS, SLOTS, AHEAD, GUARD_MS, BACKOFF_MS, GameBridge } = B;
// the HUD's own rule for older copies (mod/trainerhud/trainerhud.js isOlder), loaded as the HUD tests do
const T = (() => { const ctx = { window: { location: { search: '', pathname: '/hud.html' } }, document: { getElementById: () => null }, console, setTimeout, clearTimeout, setInterval, clearInterval };
  vm.createContext(ctx); vm.runInContext(`${fs.readFileSync(path.join(ROOT, 'mod/trainerhud/trainerhud.js'), 'utf8')}
;globalThis.__T = TrainerHud;`, ctx); return ctx.__T; })();

const quiet = { log() {}, error() {} };
const appDir = (name) => { const d = path.join(env.ACE_DIR, name); fs.mkdirSync(d, { recursive: true }); return d; };
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// a simulated run: the writer timer every 10 ms, stalls of the whole process, write times from ioMs(); onTick(t) can
// change the state (the kill switch). The HUD is modelled too: a read every 200 ms of slot w % 8 at 5 ms into its
// window, keeping the newer copy (isOlder, HUD 0.15.0).
function simulate({ seconds = 120, seed = 1, stallP = 0.002, stallMs = [100, 2000], ioMs = () => 1 + Math.random() * 3, onTick = () => {}, state = { off: false } }) {
  const r = rng(seed);
  let t = 1_700_000_000_000;
  const start = t, end = t + seconds * 1000;
  const writes = [];
  const br = new GameBridge({ snapshot: () => ({ v: 1, now: t, ...(state.off ? { off: true } : {}), cfg: { scale: 100 } }), onCommand() {}, appDir: appDir('sim'),
    logDir: path.join(env.ACE_DIR, 'nolog'), now: () => t, mono: () => t, log: quiet,
    writeSlot: (file, buf) => { const a = t; t += ioMs(r); const j = JSON.parse(buf.toString()); writes.push({ slot: Number(/live(\d)\.json$/.exec(file)[1]), a, b: t, window: j.window, now: j.now, off: j.off === true }); } });
  let maxStall = 0;
  while (t < end) {
    onTick(t);
    if (r() < stallP) { const s = stallMs[0] + r() * (stallMs[1] - stallMs[0]); t += s; maxStall = Math.max(maxStall, s); } else t += 10;
    br.write();
  }
  // collisions: a write of slot s overlapping any window w with w % SLOTS == s
  let collisions = 0, fromSlowWrite = 0;
  for (const w of writes) {
    for (let k = Math.floor(w.a / WINDOW_MS); k <= Math.floor(w.b / WINDOW_MS); k++) {
      if (k % SLOTS === w.slot) { collisions++; if (w.b - w.a > SAFE_MS) fromSlowWrite++; break; }
    }
  }
  // the HUD's reads
  const reads = [];
  const sorted = writes.slice().sort((x, y) => x.b - y.b);
  const bySlot = new Map();
  let wi = 0, shown = null, shownAt = 0;
  for (let w = Math.floor(start / WINDOW_MS) + 8; w * WINDOW_MS < end; w += 4) {
    const at = w * WINDOW_MS + 5;
    while (wi < sorted.length && sorted[wi].b <= at) { bySlot.set(sorted[wi].slot, sorted[wi]); wi++; }
    const c = bySlot.get(w % SLOTS);
    if (c && !T.isOlder(shown, c, shownAt, at)) { shown = c; shownAt = at; }
    if (shown) reads.push({ at, age: at - shown.now, off: shown.off });
  }
  const ages = reads.map((x) => x.age).sort((a, b) => a - b);
  const share = (ms) => ages.filter((a) => a > ms).length / Math.max(1, ages.length);
  return { stats: br.stats(), writes, reads, collisions, fromSlowWrite, maxStall: Math.round(maxStall), maxAge: Math.round(ages[ages.length - 1] ?? 0), over1s: share(1000), over3s: share(3000) };
}
const SAFE_MS = 150; // the least margin a write has before its slot's read window (written 4 windows ahead, at the latest at the end of its window)

test('scheduling stalls (100 ms to 2 s, about every 5 s): no write ever overlaps its slot\'s read window', (t) => {
  for (const seed of [1, 2, 3]) {
    const r = simulate({ seed });
    t.diagnostic(`stalls seed ${seed}: windows ${r.stats.windows}, writes ${r.stats.writes} (${r.stats.aheadWrites} to w+5), missed windows ${r.stats.missedWindows}, longest gap ${r.stats.maxGapMs} ms, collisions ${r.collisions}, HUD reads over 1 s old ${(r.over1s * 100).toFixed(1)} %, oldest ${r.maxAge} ms`);
    assert.equal(r.collisions, 0);
    assert.equal(r.stats.lateWrites, 0);
    assert.equal(r.stats.backoffs, 0);
    assert.ok(r.stats.missedWindows > 0, 'stalls happened');
    // a written slot always names its own read window, after the write ended (the HUD's clock-mismatch guard holds)
    for (const w of r.writes) { assert.ok(w.window * WINDOW_MS > w.b, 'written before its read window'); assert.equal(w.window % SLOTS, w.slot); }
  }
});

test('one write per window: the schedule is exactly the old one (slot w+4)', () => {
  const r = simulate({ seconds: 10, stallP: 0, ioMs: () => 1 });
  assert.equal(r.stats.aheadWrites, 0);
  for (const w of r.writes) assert.equal(w.window - Math.floor(w.a / WINDOW_MS), AHEAD);
});

test('review fix: a disk that is a little slow (70 ms a write) is not paused and the HUD data stays fresh', (t) => {
  const r = simulate({ seconds: 60, seed: 3, stallP: 0, ioMs: () => 70 });
  t.diagnostic(`70 ms a write: writes ${r.stats.writes}/min (${r.stats.aheadWrites} to w+5), back-offs ${r.stats.backoffs}, collisions ${r.collisions}, HUD reads over 1 s old ${(r.over1s * 100).toFixed(1)} %, over 3 s ${(r.over3s * 100).toFixed(1)} %, oldest ${r.maxAge} ms`);
  assert.equal(r.stats.backoffs, 0);
  assert.equal(r.collisions, 0);
  assert.ok(r.stats.writes > 600, `${r.stats.writes} writes a minute`);
  assert.equal(r.over1s, 0);
  assert.ok(r.maxAge < 700, `oldest data ${r.maxAge} ms`);
});

// the kill switch at a time; -> the writes after it, and what the HUD showed
function killSwitch(ioMs, seed) {
  const state = { off: false };
  let at = null;
  const r = simulate({ seconds: 40, seed, stallP: 0, ioMs: () => ioMs, state, onTick: (t) => { if (at === null && t >= 1_700_000_000_000 + 20000) { state.off = true; at = t; } } });
  const after = r.writes.filter((w) => w.a >= at);
  const reached = new Set(); let n = 0;
  for (const w of after) { if (reached.size === SLOTS) break; n++; if (w.off) reached.add(w.slot); }
  const hudReads = r.reads.filter((x) => x.at >= at);
  const firstOff = hudReads.findIndex((x) => x.off);
  return { r, at, after, reached, n, hudReads, firstOff };
}

for (const ms of [70, 200]) {
  test(`review fix: with ${ms} ms a write the kill switch reaches every slot within one round of writes (8, plus up to two where both safe slots already had it), and the HUD never shows the old state again`, (t) => {
    const k = killSwitch(ms, 5);
    const firstWrite = k.after[0];
    t.diagnostic(`${ms} ms a write: all 8 slots off after ${k.n} writes (${Math.round(k.after[k.n - 1].b - k.at)} ms; first write ${Math.round(firstWrite.a - k.at)} ms after the switch), HUD hidden after ${Math.round(k.hudReads[k.firstOff].at - k.at)} ms, back-offs ${k.r.stats.backoffs}`);
    assert.equal(k.reached.size, SLOTS);
    assert.ok(k.n <= SLOTS + 2, `${k.n} writes`);
    assert.ok(k.after.every((w) => w.off), 'no slot is written with the old state after the switch');
    assert.ok(k.firstOff >= 0);
    assert.ok(k.hudReads.slice(k.firstOff).every((x) => x.off), 'once hidden, the HUD stays hidden (no flicker)');
    if (ms === 70) { assert.ok(k.after[k.n - 1].b - k.at <= 1000, 'every slot within 1 s'); assert.ok(k.hudReads[k.firstOff].at - k.at < 1000); }
  });
}

test('slow disk (writes of 80 to 400 ms now and then): back-off only near the read window; collisions only from a write longer than the margin', (t) => {
  const r = simulate({ seed: 7, stallP: 0.001, ioMs: (rand) => (rand() < 0.01 ? 80 + rand() * 320 : 1 + rand() * 3) });
  t.diagnostic(`slow disk: writes ${r.stats.writes}, slow ${r.stats.slowWrites} (longest ${Math.round(r.stats.maxWriteMs)} ms), back-offs ${r.stats.backoffs}, paused windows ${r.stats.pausedWindows}, late writes ${r.stats.lateWrites}, collisions ${r.collisions} (from writes over ${SAFE_MS} ms: ${r.fromSlowWrite}), HUD reads over 1 s old ${(r.over1s * 100).toFixed(1)} %, oldest ${r.maxAge} ms`);
  assert.ok(r.stats.slowWrites > r.stats.backoffs, 'writes slow but far from the read window are not paused for');
  assert.equal(r.collisions, r.fromSlowWrite, 'no collision comes from the schedule');
  // after a write that came near its read window nothing is written for BACKOFF_MS
  for (let i = 1; i < r.writes.length; i++) {
    const prev = r.writes[i - 1];
    if (prev.b > prev.window * WINDOW_MS - GUARD_MS) assert.ok(r.writes[i].a - prev.b >= BACKOFF_MS - 10, `write ${i} came ${r.writes[i].a - prev.b} ms after one near its read window`);
  }
  const everySlow = simulate({ seed: 7, stallP: 0, seconds: 20, ioMs: () => 200 });
  t.diagnostic(`every write 200 ms: writes ${everySlow.stats.writes} in 20 s, back-offs ${everySlow.stats.backoffs}, collisions ${everySlow.collisions} (all from writes over ${SAFE_MS} ms: ${everySlow.fromSlowWrite})`);
  assert.ok(everySlow.stats.backoffs > 0);
  assert.ok(everySlow.stats.writes < 20 * 1000 / 200 / 2, 'paused most of the time');
  assert.equal(everySlow.collisions, everySlow.fromSlowWrite);
});

test('review fix: the back-off runs on a monotonic clock: a system clock step back does not stretch it', () => {
  let t = 1_700_000_000_000, m = 0;
  const writes = [];
  const br = new GameBridge({ snapshot: () => ({ v: 1, now: t }), onCommand() {}, appDir: appDir('mono'), logDir: path.join(env.ACE_DIR, 'nolog'), now: () => t, mono: () => m, log: quiet,
    writeSlot: () => { const d = writes.length === 0 ? 200 : 1; t += d; m += d; writes.push(t); } });
  br.write(); // a 200 ms write: back-off
  assert.equal(br.stats().backoffs, 1);
  t -= 10000; // the wall clock steps back 10 s
  for (let i = 0; i < 120; i++) { t += 10; m += 10; br.write(); }
  assert.ok(writes.length > 1, 'writing resumed about 1 s later by the monotonic clock');
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
