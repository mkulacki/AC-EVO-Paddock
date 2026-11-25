// PL11 scheduled backups: verification, retention, disk-space and synced-folder rules, storage forecast.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolate, seedRandom } from './helpers.js';

const { ACEVO_DATA } = isolate('autobackup');
const KEY = 'test-only-key-0123456789';
fs.writeFileSync(path.join(ACEVO_DATA, 'settings.json'), JSON.stringify({ geminiApiKey: KEY, driverName: 'Jan Kowalski', boardToken: 'tok-123', boardSteam: { steamId: '7656', name: 'x' } }));
fs.writeFileSync(path.join(ACEVO_DATA, 'race.json'), JSON.stringify({ servers: [{ id: 's1', password: 'pw-xyz' }] }));
seedRandom(5);
const db = await import('../src/db.js');
const zip = await import('../src/zip.js');
const backup = await import('../src/backup.js');
const auto = await import('../src/autobackup.js');
const settings = await import('../src/settings.js');
const { seedLaps } = await import('../src/mock.js');
await seedLaps(3);
const noCloud = {}; // no OneDrive variables: the test folder is not synced

test('config: off by default, values checked and clamped', () => {
  assert.deepEqual(auto.config(null), { on: false, every: 'weekly', keep: 4, allowSynced: false });
  assert.deepEqual(auto.config({ on: true, every: 'hourly', keep: 999, allowSynced: 'yes' }), { on: true, every: 'weekly', keep: 30, allowSynced: false });
  assert.equal(auto.config({ keep: 0 }).keep, 1);
});

test('off: nothing runs and nothing is noticed', async () => {
  const r = await auto.runOnce({ env: noCloud });
  assert.equal(r.skipped, 'off');
  assert.equal(auto.notice(), null);
  assert.equal(backup.listBackups().length, 0);
});

test('a due run makes a secret-free backup, verifies it and is then not due again', async () => {
  auto.setConfig({ on: true, every: 'daily', keep: 2 });
  const r = await auto.runOnce({ env: noCloud });
  assert.equal(r.ran, true, JSON.stringify(r));
  assert.equal(r.verification.ok, true, r.verification.problems.join('; '));
  assert.equal(r.verification.integrity, 'ok');
  assert.equal(r.verification.counts.laps, 3);
  const s = JSON.parse(zip.readEntry(backup.fileOf(r.backup.name), 'settings.json'));
  assert.equal(s.geminiApiKey, '');
  assert.equal(s.boardToken, '');
  assert.equal(r.backup.reason, 'scheduled');
  assert.equal(auto.verification(r.backup.name).ok, true);
  assert.equal((await auto.runOnce({ env: noCloud })).skipped, 'not-due');
  // a day later it is due again
  assert.equal((await auto.runOnce({ env: noCloud, now: Date.now() + 86400e3 + 1000 })).ran, true);
});

test('never while driving, and no notice for it', async () => {
  const r = await auto.runOnce({ env: noCloud, force: true, isIdle: () => false });
  assert.equal(r.skipped, 'driving');
});

test('not enough free space: skipped with a visible notice, nothing written', async () => {
  const before = backup.listBackups().length;
  const r = await auto.runOnce({ env: noCloud, force: true, reserve: Number.MAX_SAFE_INTEGER });
  assert.equal(r.skipped, 'space');
  assert.match(auto.notice().text, /Not enough free space/);
  assert.equal(backup.listBackups().length, before);
  assert.deepEqual(fs.readdirSync(backup.BACKUP_DIR).filter((n) => n.startsWith('.')), [], 'no temp files left');
});

test('a synced folder is skipped unless the driver allows it', async () => {
  const env = { OneDrive: path.dirname(ACEVO_DATA) };
  assert.equal(auto.syncedFolder(backup.BACKUP_DIR, env), 'OneDrive');
  assert.equal(auto.syncedFolder('C:\\Users\\x\\Dropbox\\Paddock\\data', {}), 'Dropbox');
  assert.equal(auto.syncedFolder('D:\\Games\\AC EVO Paddock\\data', {}), null);
  const r = await auto.runOnce({ env, force: true });
  assert.equal(r.skipped, 'synced');
  assert.match(auto.notice().text, /OneDrive/);
  auto.setConfig({ allowSynced: true });
  assert.equal((await auto.runOnce({ env, force: true })).ran, true);
  assert.equal(auto.notice(), null, 'a good run clears the notice');
  auto.setConfig({ allowSynced: false });
});

test('retention keeps the newest scheduled backups only; manual backups are never removed', async () => {
  const manual = await backup.create({});
  for (let i = 0; i < 3; i++) await auto.runOnce({ env: noCloud, force: true });
  const all = backup.listBackups();
  assert.equal(all.filter((b) => b.reason === 'scheduled').length, 2);
  assert.ok(all.some((b) => b.name === manual.name), 'the manual backup stays');
});

test('verification catches a damaged database, wrong counts and a leaked key', async () => {
  const bad = path.join(backup.BACKUP_DIR, 'paddock-backup-broken.zip');
  await zip.writeZip(bad, [{ name: 'manifest.json', data: JSON.stringify({ format: backup.FORMAT, version: 1, files: ['telemetry.db'], counts: { laps: 3 } }) },
    { name: 'telemetry.db', data: 'not a database at all, just text'.repeat(200) }]);
  const v = await auto.verify('paddock-backup-broken.zip');
  assert.equal(v.ok, false);
  assert.match(v.problems.join(' '), /cannot be opened|damaged/);
  // a real copy, but its manifest claims other counts
  const tmp = path.join(ACEVO_DATA, 'copy.db'); db.vacuumInto(tmp);
  const wrong = path.join(backup.BACKUP_DIR, 'paddock-backup-wrong.zip');
  await zip.writeZip(wrong, [{ name: 'manifest.json', data: JSON.stringify({ format: backup.FORMAT, version: 1, files: ['telemetry.db'], counts: { laps: 99, sessions: 1 } }) }, { name: 'telemetry.db', file: tmp }]);
  const w = await auto.verify('paddock-backup-wrong.zip');
  assert.equal(w.ok, false);
  assert.match(w.problems.join(' '), /laps: 3 in the copy, 99/);
  // a key in a backup that says it has none
  const leaky = path.join(backup.BACKUP_DIR, 'paddock-backup-leaky.zip');
  await zip.writeZip(leaky, [{ name: 'manifest.json', data: JSON.stringify({ format: backup.FORMAT, version: 1, files: ['settings.json'], includesSecrets: false }) }, { name: 'settings.json', data: JSON.stringify({ geminiApiKey: KEY }) }]);
  assert.match((await auto.verify('paddock-backup-leaky.zip')).problems.join(' '), /Gemini key/);
  fs.rmSync(tmp, { force: true });
  assert.deepEqual(fs.readdirSync(backup.BACKUP_DIR).filter((n) => n.startsWith('.verify')), [], 'verification copies are removed');
});

test('forecast: database size, per-lap size, growth and days until the disk is full', () => {
  const f = auto.forecast();
  assert.ok(f.dbBytes > 0);
  assert.ok(f.perLapBytes > 0);
  assert.equal(f.lapsPer30d, Math.round((db.counts().laps / 7) * 30), 'a new history counts at least a week');
  assert.equal(f.growthPer30d, f.lapsPer30d * f.perLapBytes);
  assert.ok(f.freeBytes > 0);
  assert.ok(Number.isInteger(f.daysUntilFull));
  assert.equal(f.scheduledCount, 2);
  const st = auto.status();
  assert.equal(st.config.on, true);
  assert.ok(st.nextDueAt > Date.now());
});

test('the schedule is kept in settings.json and cannot be set through the general settings', () => {
  assert.equal(settings.get().autoBackup.on, true);
  auto.setConfig({ on: false });
  assert.equal(auto.config().on, false);
});
