// 2026-11-19 feedback round: backups of chosen parts, car statistics, the game's own setups.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolate, seedRandom } from './helpers.js';

const { ACEVO_DATA } = isolate('feedback');
fs.writeFileSync(path.join(ACEVO_DATA, 'settings.json'), JSON.stringify({ driverName: 'Test Driver' }));
fs.writeFileSync(path.join(ACEVO_DATA, 'race.json'), JSON.stringify({ servers: [] }));
seedRandom(5);
const db = await import('../src/db.js');
const zip = await import('../src/zip.js');
const backup = await import('../src/backup.js');
const carstats = await import('../src/carstats.js');
const setups = await import('../src/setups.js');
const { seedLaps } = await import('../src/mock.js');
await seedLaps(3);

// ---------------------------------------------------------------- backup parts
test('backup parts: sizes listed; the laps database has a breakdown and lap counts', () => {
  const parts = backup.parts();
  assert.deepEqual(parts.map((p) => p.id), ['laps', 'settings', 'race', 'setupNotes']);
  const laps = parts.find((p) => p.id === 'laps');
  assert.ok(laps.exists && laps.size > 0);
  assert.equal(laps.counts.laps, 3);
  if (laps.breakdown) assert.ok(laps.breakdown.some((b) => b.label === 'lap telemetry' && b.size > 0));
  assert.equal(parts.find((p) => p.id === 'setupNotes').exists, false, 'no setup notes yet');
});

test('backup of chosen parts only: no laps database in it, restore keeps the current laps', async () => {
  const b = await backup.create({ parts: ['settings', 'race'] });
  assert.ok(b.ok, b.error);
  assert.deepEqual(b.parts, ['settings', 'race']);
  assert.equal(b.counts, null);
  const names = zip.list(backup.fileOf(b.name)).map((e) => e.name);
  assert.ok(!names.includes('telemetry.db'));
  assert.ok(names.includes('settings.json') && names.includes('race.json'));
  const r = await backup.stageRestore(b.name);
  assert.ok(backup.pending());
  const staged = JSON.parse(fs.readFileSync(path.join(ACEVO_DATA, 'restore-pending', 'manifest.json'), 'utf8'));
  assert.deepEqual(staged.files.sort(), ['race.json', 'settings.json']);
  const safety = backup.listBackups().find((x) => x.name === r.before);
  assert.ok(safety.parts.includes('laps'), 'the safety backup before a restore holds everything');
  backup.cancelRestore();
});

test('backup: nothing chosen is refused; unknown part names are ignored', async () => {
  await assert.rejects(backup.create({ parts: [] }), /at least one/);
  await assert.rejects(backup.create({ parts: ['nope'] }), /at least one/);
});

// ---------------------------------------------------------------- car statistics
test('lapNumbers: top speed, time-weighted pedal shares, gear changes per km', () => {
  const n = 101, t = [], d = [], spd = [], thr = [], brk = [], gear = [], out = [];
  for (let i = 0; i < n; i++) {
    t.push(i * 100); d.push(i * 10); spd.push(100 + i); out.push(0);
    thr.push(i < 50 ? 1 : 0); brk.push(i >= 50 && i < 75 ? 0.8 : 0); gear.push(i < 30 ? 3 : 4);
  }
  const s = carstats.lapNumbers({ t, d, spd, thr, brk, gear, out });
  assert.equal(s.topKmh, 200);
  assert.equal(s.fullThr, 49); // samples 1..49 of 100 intervals
  assert.equal(s.brake, 25);
  assert.equal(s.coast, 26);
  assert.equal(s.shiftsPerKm, 1); // one change over 1 km
  assert.equal(carstats.lapNumbers({ t: [0, 1] }), null);
});

test('car overview: your laps add up per car (cars not in the game list are listed apart)', () => {
  const o = carstats.overview();
  const all = [...o.cars.filter((c) => c.mine).map((c) => c.mine), ...o.unknown];
  assert.equal(all.reduce((s, c) => s + c.laps, 0), 3);
  for (const c of all) { assert.ok(c.km > 0); assert.ok(c.drivingMs > 0); }
});

// ---------------------------------------------------------------- the game's own setups
test("game setups are read-only: no rename, delete or overwrite", () => {
  assert.throws(() => setups.update('game:x:1', { name: 'a' }), /game's own setup/);
  assert.throws(() => setups.remove('game:x:1'), /game's own setup/);
  assert.deepEqual(setups.gameList('no_such_car'), []);
  assert.equal(setups.setupOfSession(999999), null);
  assert.ok(db.raw);
});
