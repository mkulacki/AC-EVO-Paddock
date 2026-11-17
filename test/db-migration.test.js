// src/db.js migrations, run on a database in the old (v0, 0.1.0) layout: data kept, distances corrected,
// a backup made, new columns and tables added. The DB is built before db.js is imported.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { isolate } from './helpers.js';

const { ACEVO_DATA } = isolate('migration');
const L = 1000;

// lap 1: distance from the game's npos zero, ~125 m after the timing line, wrapping to 0 mid-lap (needs fixing)
// lap 2: already measured from the timing line (left alone)
const lap = (d0) => {
  const t = [], d = [], spd = [];
  for (let i = 0; i < 6000; i++) { t.push(i * 1000 / 60); d.push((d0 + i * 10 / 60) % L); spd.push(36); }
  return { t, d, spd, thr: t.map(() => 1), brk: t.map(() => 0) };
};
{
  const old = new DatabaseSync(path.join(ACEVO_DATA, 'telemetry.db'));
  old.exec(`CREATE TABLE sessions (id INTEGER PRIMARY KEY, track TEXT, layout TEXT, car TEXT, session_type INTEGER, driver TEXT, started_at INTEGER);
    CREATE TABLE laps (id INTEGER PRIMARY KEY, session_id INTEGER, track TEXT, layout TEXT, car TEXT, lap_number INTEGER, lap_time_ms INTEGER,
      valid INTEGER, driver TEXT, source TEXT DEFAULT 'local', recorded_at INTEGER, track_length REAL, samples INTEGER, data BLOB);
    CREATE TABLE analyses (id INTEGER PRIMARY KEY, lap_id INTEGER, ref_key TEXT, model TEXT, created_at INTEGER, text TEXT);
    INSERT INTO sessions VALUES (1, 'trk', 'gp', 'car', 0, 'Driver', 1);`);
  const ins = old.prepare('INSERT INTO laps (session_id, track, layout, car, lap_number, lap_time_ms, valid, driver, recorded_at, track_length, samples, data) VALUES (1,?,?,?,?,?,1,?,?,?,?,?)');
  ins.run('trk', 'gp', 'car', 1, 100000, 'Driver', 10, L, 6000, zlib.gzipSync(JSON.stringify(lap(125))));
  ins.run('trk', 'gp', 'car', 2, 100000, 'Driver', 20, L, 6000, zlib.gzipSync(JSON.stringify(lap(0))));
  old.exec("INSERT INTO analyses (lap_id, ref_key, model, created_at, text) VALUES (1, 'best', 'm', 1, 'old answer')");
  old.close();
}

const db = await import('../src/db.js');

test('v0 → v1: laps and sessions are kept', () => {
  assert.equal(db.listLaps().length, 2);
  assert.equal(db.listSessions().length, 1);
});

test('v0 → v1: a backup of the old database is made first', () => {
  const backups = fs.readdirSync(ACEVO_DATA).filter((f) => /^telemetry\.backup-v0-\d+\.db$/.test(f));
  assert.equal(backups.length, 1);
  const b = new DatabaseSync(path.join(ACEVO_DATA, backups[0]), { readOnly: true });
  assert.equal(b.prepare('SELECT COUNT(*) AS n FROM laps').get().n, 2);
  b.close();
});

test('v0 → v1: distance starts at the timing line and increases without the wrap', () => {
  const { data } = db.getLap(1);
  assert.ok(Math.abs(data.d[0]) < 0.5, `starts at ${data.d[0]} m`);
  for (let i = 1; i < data.d.length; i++) assert.ok(data.d[i] > data.d[i - 1], `increasing at ${i}`);
  assert.ok(Math.abs(data.d.at(-1) - 6000 * 10 / 60) < 1);
  // the lap already measured from the line is unchanged
  assert.deepEqual(db.getLap(2).data.d, lap(0).d.map((v) => v));
});

test('v0 → v1: AI answers about the old distances are dropped', () => {
  assert.equal(db.getAnalysis(1, 'best'), undefined);
});

test('additive columns and tables exist and work', () => {
  db.setLapSetups([1], { name: 'Quali', rel: 'a/b.carsetup', match: 'manual' });
  assert.equal(db.getLapMeta(1).setup_name, 'Quali');
  db.setSessionConditions(1, { airTemp: 20 });
  assert.equal(JSON.parse(db.getSession(1).conditions).airTemp, 20);
  db.setBrakeMarks('trk', 'gp', 'car', [{ pos: 0.2, kind: 'brake' }, { pos: 0.6, kind: 'lift' }]);
  assert.deepEqual(db.brakeMarks('trk', 'gp', 'car').map((m) => m.kind), ['brake', 'lift']);
  db.saveSnapshot('h1', { values: { a: 1 } });
  assert.deepEqual(db.getSnapshot('h1'), { values: { a: 1 } });
});

test('migration is not repeated on the next start', async () => {
  // a second import in a new process would see user_version = 1; check the stored version directly
  const raw = new DatabaseSync(path.join(ACEVO_DATA, 'telemetry.db'), { readOnly: true });
  assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 1);
  raw.close();
});
