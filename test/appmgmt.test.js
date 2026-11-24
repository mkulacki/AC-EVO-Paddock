// Application management: zip writer, backup and restore, CSV export, diagnostics redaction, update check.
// No network: the update check gets a stubbed fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isolate, seedRandom } from './helpers.js';

const { dir, ACEVO_DATA } = isolate('appmgmt');
const KEY = 'test-only-key-0123456789', PW = 'server-pass-xyz';
fs.writeFileSync(path.join(ACEVO_DATA, 'settings.json'), JSON.stringify({ geminiApiKey: KEY, driverName: 'Jan Kowalski' }));
fs.writeFileSync(path.join(ACEVO_DATA, 'race.json'), JSON.stringify({ servers: [{ id: 's1', ip: '1.2.3.4', port: 9600, password: PW }], last: { server: { password: PW } } }));
seedRandom(11);
const db = await import('../src/db.js');
const zip = await import('../src/zip.js');
const backup = await import('../src/backup.js');
const { applyPendingRestore, PENDING } = await import('../src/restore-apply.js');
const dataexport = await import('../src/dataexport.js');
const diagnostics = await import('../src/diagnostics.js');
const updates = await import('../src/updates.js');
const { seedLaps } = await import('../src/mock.js');
await seedLaps(4);

// ---------------------------------------------------------------- zip writer
test('writeZip → list/extract round trip: files, buffers, UTF-8 names, empty entries', async () => {
  const src = path.join(dir, 'big.bin');
  const big = Buffer.alloc(300000); for (let i = 0; i < big.length; i++) big[i] = (i * 7919) % 251;
  fs.writeFileSync(src, big);
  const z = path.join(dir, 'w.zip');
  await zip.writeZip(z, [{ name: 'big.bin', file: src }, { name: 'Ślęża ąę.json', data: '{"a":1}' }, { name: 'empty.txt', data: '' }]);
  const l = zip.list(z);
  assert.deepEqual(l.map((e) => [e.name, e.size]), [['big.bin', big.length], ['Ślęża ąę.json', 7], ['empty.txt', 0]]);
  assert.ok(zip.readEntry(z, 'big.bin').equals(big));
  assert.equal(zip.readEntry(z, 'Ślęża ąę.json').toString(), '{"a":1}');
  assert.equal(zip.readEntry(z, 'nope'), null);
});

// ---------------------------------------------------------------- backup
let plain, withKey;
test('backup: database copy + files; key and passwords left out unless asked for', async () => {
  plain = await backup.create({ appVersion: '9.9.9' });
  assert.ok(plain.ok, plain.error);
  assert.equal(plain.counts.laps, 4);
  const f = backup.fileOf(plain.name);
  const names = zip.list(f).map((e) => e.name);
  assert.deepEqual(names.slice(0, 2), ['manifest.json', 'telemetry.db']);
  assert.ok(names.includes('settings.json') && names.includes('race.json'));
  const s = JSON.parse(zip.readEntry(f, 'settings.json'));
  assert.equal(s.geminiApiKey, '');
  assert.equal(s.driverName, 'Jan Kowalski');
  assert.ok(!zip.readEntry(f, 'race.json').toString().includes(PW), 'no password anywhere in race.json');
  // the database copy is a working database
  const tmp = path.join(dir, 'copy.db'); fs.writeFileSync(tmp, zip.readEntry(f, 'telemetry.db'));
  const c = new DatabaseSync(tmp, { readOnly: true }); assert.equal(c.prepare('SELECT COUNT(*) AS n FROM laps').get().n, 4); c.close();
  withKey = await backup.create({ includeSecrets: true });
  assert.equal(JSON.parse(zip.readEntry(backup.fileOf(withKey.name), 'settings.json')).geminiApiKey, KEY);
  assert.notEqual(withKey.name, plain.name, 'two backups in one second get different names');
  assert.equal(backup.listBackups().length, 2);
});

test('backup names are checked: no paths, only .zip', () => {
  for (const bad of ['../settings.json', '..\\x.zip', 'a/b.zip', 'x.txt', '']) assert.throws(() => backup.fileOf(bad), /Unknown backup/);
});

test('inspect / import refuse files that are not Paddock backups', async () => {
  const notZip = path.join(dir, 'x.zip'); fs.writeFileSync(notZip, 'hello');
  assert.throws(() => backup.inspect(notZip), /Not a backup file/);
  const other = path.join(dir, 'other.zip');
  await zip.writeZip(other, [{ name: 'manifest.json', data: JSON.stringify({ format: 'something-else' }) }]);
  assert.throws(() => backup.importUpload(other), /unknown format/);
  const newer = path.join(dir, 'newer.zip');
  await zip.writeZip(newer, [{ name: 'manifest.json', data: JSON.stringify({ format: backup.FORMAT, version: 99, files: ['telemetry.db'] }) }, { name: 'telemetry.db', data: 'x' }]);
  assert.throws(() => backup.inspect(newer), /newer Paddock/);
  const imported = backup.importUpload(backup.fileOf(plain.name));
  assert.match(imported.name, /imported/);
});

test('restore: staged with a safety backup first; refused for a damaged database; can be cancelled', async () => {
  const before = backup.listBackups().length;
  const r = await backup.stageRestore(plain.name);
  assert.ok(backup.pending());
  assert.equal(backup.listBackups().length, before + 1);
  assert.match(r.before, /before-restore/);
  const safety = backup.listBackups().find((b) => b.name === r.before);
  assert.equal(safety.includesSecrets, true, 'the local safety copy keeps the key');
  backup.cancelRestore();
  assert.ok(!backup.pending());
  // a backup whose database is not Paddock's
  const bad = path.join(backup.BACKUP_DIR, 'paddock-backup-bad.zip');
  const junk = path.join(dir, 'junk.db'); const j = new DatabaseSync(junk); j.exec('CREATE TABLE x (a)'); j.close();
  await zip.writeZip(bad, [{ name: 'manifest.json', data: JSON.stringify({ format: backup.FORMAT, version: 1, files: ['telemetry.db'] }) }, { name: 'telemetry.db', file: junk }]);
  await assert.rejects(backup.stageRestore('paddock-backup-bad.zip'), /not a Paddock laps database/);
  assert.ok(!backup.pending(), 'nothing left staged after a refusal');
  // PL1 (PL0 1.3-l): a database with a trigger or view (Paddock never makes one) is refused
  for (const [n, sql] of [['trig', "CREATE TRIGGER t AFTER INSERT ON laps BEGIN DELETE FROM sessions; END"], ['view', 'CREATE VIEW v AS SELECT * FROM laps']]) {
    const f = path.join(dir, `${n}.db`); const t = new DatabaseSync(f);
    t.exec(`CREATE TABLE laps (id); CREATE TABLE sessions (id); ${sql}`); t.close();
    const z = `paddock-backup-${n}.zip`;
    await zip.writeZip(path.join(backup.BACKUP_DIR, z), [{ name: 'manifest.json', data: JSON.stringify({ format: backup.FORMAT, version: 1, files: ['telemetry.db'] }) }, { name: 'telemetry.db', file: f }]);
    await assert.rejects(backup.stageRestore(z), new RegExp(`contains a ${n === 'trig' ? 'trigger' : 'view'} Paddock never makes`));
    assert.ok(!backup.pending());
    backup.remove(z);
  }
});

test('restore at start: files swapped before the database opens; key and passwords kept from the current files', async () => {
  await backup.stageRestore(plain.name);
  // the swap runs in a fresh data folder (this process holds its own database open)
  const other = fs.mkdtempSync(path.join(dir, 'other-'));
  fs.cpSync(path.join(ACEVO_DATA, PENDING), path.join(other, PENDING), { recursive: true });
  const old = new DatabaseSync(path.join(other, 'telemetry.db')); old.exec('CREATE TABLE laps (id); CREATE TABLE sessions (id)'); old.close();
  fs.writeFileSync(path.join(other, 'telemetry.db-wal'), 'stale');
  fs.writeFileSync(path.join(other, 'settings.json'), JSON.stringify({ geminiApiKey: 'current-key-1234', driverName: 'Other' }));
  fs.writeFileSync(path.join(other, 'race.json'), JSON.stringify({ servers: [{ id: 's1', ip: '1.2.3.4', port: 9600, password: 'current-pw' }] }));
  const r = applyPendingRestore(other);
  assert.equal(r.ok, true);
  assert.ok(r.files.includes('telemetry.db'));
  assert.ok(!fs.existsSync(path.join(other, PENDING)), 'staging removed');
  assert.ok(!fs.existsSync(path.join(other, 'telemetry.db-wal')), 'stale WAL removed');
  const c = new DatabaseSync(path.join(other, 'telemetry.db'), { readOnly: true }); assert.equal(c.prepare('SELECT COUNT(*) AS n FROM laps').get().n, 4); c.close();
  const s = JSON.parse(fs.readFileSync(path.join(other, 'settings.json'), 'utf8'));
  assert.equal(s.driverName, 'Jan Kowalski', 'from the backup');
  assert.equal(s.geminiApiKey, 'current-key-1234', 'the backup had no key: the current one is kept');
  assert.equal(JSON.parse(fs.readFileSync(path.join(other, 'race.json'), 'utf8')).servers[0].password, 'current-pw');
  assert.equal(applyPendingRestore(other), null, 'nothing to do on the next start');
  backup.cancelRestore();
});

test('restore at start, failure: the database cannot be replaced → current data unchanged, retried, set aside after 3 tries', async () => {
  await backup.stageRestore(plain.name);
  const other = fs.mkdtempSync(path.join(dir, 'locked-'));
  fs.cpSync(path.join(ACEVO_DATA, PENDING), path.join(other, PENDING), { recursive: true });
  backup.cancelRestore();
  // a folder where the database should be: the rename over it fails, like a locked file would
  fs.mkdirSync(path.join(other, 'telemetry.db'));
  fs.writeFileSync(path.join(other, 'telemetry.db', 'marker'), 'old data');
  fs.writeFileSync(path.join(other, 'settings.json'), JSON.stringify({ driverName: 'Current' }));
  for (let k = 1; k <= 2; k++) {
    const r = applyPendingRestore(other);
    assert.equal(r.ok, false);
    assert.match(r.error, /unchanged/);
    assert.ok(fs.existsSync(path.join(other, PENDING, 'manifest.json')), 'kept for the next start');
    assert.equal(JSON.parse(fs.readFileSync(path.join(other, PENDING, 'manifest.json'), 'utf8')).attempts, k);
  }
  assert.equal(fs.readFileSync(path.join(other, 'telemetry.db', 'marker'), 'utf8'), 'old data');
  assert.equal(JSON.parse(fs.readFileSync(path.join(other, 'settings.json'), 'utf8')).driverName, 'Current', 'nothing else touched');
  assert.ok(!fs.existsSync(path.join(other, 'telemetry.db.restoring')));
  const third = applyPendingRestore(other);
  assert.equal(third.ok, false);
  assert.ok(!fs.existsSync(path.join(other, PENDING)), 'given up after 3 starts');
  assert.ok(fs.readdirSync(other).some((n) => n.startsWith('restore-failed-')));
});

test('restore merges server passwords everywhere in race.json (servers, presets, last)', async () => {
  const other = fs.mkdtempSync(path.join(dir, 'race-'));
  fs.mkdirSync(path.join(other, PENDING));
  fs.writeFileSync(path.join(other, PENDING, 'race.json'), JSON.stringify({ servers: [{ id: 's1', ip: '1.2.3.4', port: 9600, password: '' }],
    presets: [{ spec: { server: { ip: '1.2.3.4', port: 9600, password: '' } } }], last: { server: { ip: '5.6.7.8', port: 1, password: '' } } }));
  fs.writeFileSync(path.join(other, PENDING, 'manifest.json'), JSON.stringify({ files: ['race.json'] }));
  fs.writeFileSync(path.join(other, 'race.json'), JSON.stringify({ servers: [{ id: 's1', ip: '1.2.3.4', port: 9600, password: 'pw1' }], last: { server: { ip: '5.6.7.8', port: 1, password: 'pw2' } } }));
  assert.equal(applyPendingRestore(other).ok, true);
  const r = JSON.parse(fs.readFileSync(path.join(other, 'race.json'), 'utf8'));
  assert.equal(r.servers[0].password, 'pw1');
  assert.equal(r.presets[0].spec.server.password, 'pw1');
  assert.equal(r.last.server.password, 'pw2');
});

test('backups leave out the Mods manifest and game caches; reserved and odd names refused; manifest values typed', async () => {
  fs.writeFileSync(path.join(ACEVO_DATA, 'mods.json'), '{"mods":[]}');
  const b = await backup.create();
  assert.ok(!zip.list(backup.fileOf(b.name)).some((e) => e.name === 'mods.json'));
  for (const bad of ['CON.zip', 'nul.zip', 'com1.zip']) assert.throws(() => backup.fileOf(bad), /Unknown backup/);
  const evil = path.join(backup.BACKUP_DIR, 'paddock-backup-evil.zip');
  await zip.writeZip(evil, [{ name: 'manifest.json', data: JSON.stringify({ format: backup.FORMAT, version: 1, files: ['telemetry.db'], createdAt: '<b>x</b>', app: { a: 1 },
    reason: '<img src=x onerror=alert(1)>', includesSecrets: 'yes', counts: { laps: '<img src=x onerror=alert(1)>', sessions: 2 } }) }, { name: 'telemetry.db', data: 'x' }]);
  const d = backup.listBackups().find((x) => x.name === 'paddock-backup-evil.zip');
  assert.equal(d.counts.laps, null);
  assert.equal(d.counts.sessions, 2);
  assert.equal(d.app, null);
  assert.equal(d.includesSecrets, false);
  assert.equal(typeof d.createdAt, 'number');
  backup.remove('paddock-backup-evil.zip');
});

test('two backups at once both succeed, with different names', async () => {
  const [a, b] = await Promise.all([backup.create(), backup.create()]);
  assert.ok(a.ok && b.ok);
  assert.notEqual(a.name, b.name);
});

test('writeZip errors: missing folder rejects cleanly; never overwrites; no .part left', async () => {
  await assert.rejects(zip.writeZip(path.join(dir, 'no', 'such', 'dir', 'x.zip'), [{ name: 'a', data: 'b' }]), /ENOENT/);
  const dest = path.join(dir, 'exists.zip');
  fs.writeFileSync(dest, 'keep me');
  await assert.rejects(zip.writeZip(dest, [{ name: 'a', data: 'b' }]), /already exists/);
  assert.equal(fs.readFileSync(dest, 'utf8'), 'keep me');
  assert.ok(!fs.existsSync(`${dest}.part`));
  await assert.rejects(zip.writeZip(path.join(dir, 'gone.zip'), [{ name: 'a', file: path.join(dir, 'missing-source') }]), /ENOENT/);
  assert.ok(!fs.existsSync(path.join(dir, 'gone.zip')) && !fs.existsSync(path.join(dir, 'gone.zip.part')));
});

test('crafted zips: an entry larger than it says, or an oversized manifest, is refused without inflating it', async () => {
  const z = path.join(dir, 'bomb.zip');
  await zip.writeZip(z, [{ name: 'manifest.json', data: 'x'.repeat(200000) }]);
  assert.throws(() => zip.readEntry(z, 'manifest.json', { maxSize: 1000 }), /unexpectedly large/);
  // claim 10 bytes in the central directory for 200 kB of data
  const buf = fs.readFileSync(z);
  const cen = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  buf.writeUInt32LE(10, cen + 24);
  fs.writeFileSync(z, buf);
  assert.throws(() => zip.readEntry(z, 'manifest.json'), /larger than it says/);
  // PL1 (PL0 1.3-b): the streamed extraction (backups, mods) stops at the stated size too, and leaves no file behind
  const dest = path.join(dir, 'bomb.out');
  const entry = zip.list(z)[0];
  assert.equal(entry.size, 10);
  await assert.rejects(zip.extract(z, entry, dest), /larger than it says/);
  assert.ok(!fs.existsSync(dest));
});

test('crafted zips: a central directory said to be bigger than the file is refused before reading it (PL0 1.3-c)', async () => {
  const z = path.join(dir, 'bigdir.zip');
  await zip.writeZip(z, [{ name: 'a.txt', data: 'hello' }]);
  const buf = fs.readFileSync(z);
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  buf.writeUInt32LE(0xfffffff0, end + 12); // cdSize ~4 GB in a tiny file
  fs.writeFileSync(z, buf);
  assert.throws(() => zip.list(z), /Damaged zip directory/);
});

test('limitBytes: passes data up to the limit, fails with 413 past it', async () => {
  const { Readable, Writable } = await import('node:stream');
  const { pipeline } = await import('node:stream/promises');
  const sink = () => new Writable({ write(_c, _e, cb) { cb(); } });
  await pipeline(Readable.from([Buffer.alloc(600), Buffer.alloc(400)]), zip.limitBytes(1000), sink());
  await assert.rejects(pipeline(Readable.from([Buffer.alloc(600), Buffer.alloc(401)]), zip.limitBytes(1000, 'The upload'), sink()), (e) => e.code === 413 && /The upload is larger/.test(e.message));
  assert.ok(backup.MAX_UPLOAD > 3.9 * 1024 ** 3);
});

// ---------------------------------------------------------------- export
test('CSV export: one row per lap / session, spreadsheet formulas neutralised', () => {
  const laps = dataexport.lapsCsv().trim().split('\r\n');
  assert.equal(laps.length, 1 + 4);
  assert.match(laps[0], /^lap_id,session_id,recorded_at,track/);
  assert.match(laps[1], /mock_ring,gp,mock_gt3/);
  const sess = dataexport.sessionsCsv().trim().split('\r\n');
  assert.equal(sess.length, 1 + db.listSessions().length);
  db.createSession({ track: '=HYPERLINK("x")', layout: 'a,b', car: 'say "hi"', sessionType: 0, driver: '@me', startedAt: Date.now() });
  const last = dataexport.sessionsCsv().trim().split('\r\n').at(-1);
  assert.ok(last.includes(`'=HYPERLINK(""x"")`) && last.includes('"a,b"') && last.includes('"say ""hi"""') && last.includes("'@me"), last);
});

// ---------------------------------------------------------------- diagnostics
test('redact: keys, given secrets, driver names, the user folder', () => {
  const home = os.homedir();
  const lookalike = ['AI', 'za', 'SyA', '1234567890123456789012345'].join(''); // assembled, so the release secret scan stays clean
  const t = diagnostics.redact(`key ${KEY} at ${home}\\x and ${lookalike} by Jan Kowalski, pw ${PW}`, { secrets: [KEY, PW], names: ['Jan Kowalski'] });
  assert.ok(!t.includes(KEY) && !t.includes(PW) && !t.includes('Jan Kowalski') && !t.includes(home) && !t.includes('AIzaSy'), t);
  assert.match(t, /%USERPROFILE%/);
  // the user folder in JSON (doubled backslashes), in a file URL, and the bare user name after Users\
  const B = String.fromCharCode(92);
  const user = os.userInfo().username;
  const forms = [JSON.stringify(home), `file:///${encodeURI(home.split(B).join('/'))}/x`, `D:${B}Users${B}${user}${B}Documents`, `D:/Users//${user}/x`];
  for (const f of forms) {
    const r = diagnostics.redact(f);
    assert.ok(!r.toLowerCase().includes(home.toLowerCase()) && !new RegExp(`Users[${B}${B}/]+${user}([${B}${B}/"]|$)`, 'i').test(r), `${f} → ${r}`);
  }
  assert.equal(diagnostics.redact('pw abc here', { secrets: ['abc'] }), 'pw [secret] here', '3-character secrets too');
});

test('diagnostics report: useful content, no private data', () => {
  const d = diagnostics.build({ version: '1.0.0', source: 'test', recorder: { status: 'offline' }, game: {}, loader: {}, hud: {}, paths: { data: ACEVO_DATA } });
  assert.equal(d.data.paddock.version, '1.0.0');
  assert.equal(d.data.settings.geminiKey, 'set');
  assert.equal(d.data.data.laps, 4);
  for (const priv of [KEY, PW, 'Jan Kowalski', os.homedir()]) assert.ok(!d.text.includes(priv) && !JSON.stringify(d.data).includes(priv), `leaks ${priv}`);
});

// ---------------------------------------------------------------- updates
test('version order: pre-releases before the release, numeric parts numerically', () => {
  const order = ['0.5.0-beta.1', '0.5.0-beta.2', '0.5.0-beta.10', '0.5.0', '0.5.1-beta.1', '0.10.0'];
  for (let i = 1; i < order.length; i++) assert.equal(updates.compare(order[i - 1], order[i]), -1, `${order[i - 1]} < ${order[i]}`);
  assert.equal(updates.compare('v1.2.3', '1.2.3'), 0);
  assert.throws(() => updates.compare('x', '1.0.0'), /Not a version/);
});

const rel = (tag, pre = false, draft = false) => ({ tag_name: tag, name: `AC EVO Paddock ${tag}`, html_url: `https://example.invalid/${tag}`, published_at: '2026-11-20T10:00:00Z', prerelease: pre, draft });
test('newest: betas offered to beta users only; drafts and odd tags ignored; nothing older', () => {
  const list = [rel('v0.5.0-beta.1', true), rel('v0.6.0-beta.1', true), rel('v0.5.1'), rel('v9.0.0', false, true), rel('nightly')];
  assert.equal(updates.newest(list, '0.5.0-beta.1').version, '0.6.0-beta.1');
  assert.equal(updates.newest(list, '0.5.0').version, '0.5.1');
  assert.equal(updates.newest(list, '0.6.0-beta.1'), null);
  assert.equal(updates.newest([], '1.0.0'), null);
});

test('check: stubbed GitHub; failures are recorded, never thrown', async () => {
  updates.setCurrent('0.5.0-beta.1');
  let asked;
  const s = await updates.check({ fetchFn: async (url, init) => { asked = { url, init }; return { ok: true, json: async () => [rel('v0.6.0-beta.1', true)] }; } });
  assert.match(asked.url, /api\.github\.com\/repos\/mkulacki\/AC-EVO-Paddock\/releases/);
  assert.equal(asked.init.headers['user-agent'], 'AC-EVO-Paddock-update-check', 'a generic client name, nothing about the user');
  assert.equal(s.latest.version, '0.6.0-beta.1');
  assert.equal(s.error, null);
  const f = await updates.check({ fetchFn: async () => ({ ok: false, status: 403 }) });
  assert.match(f.error, /403/);
  assert.equal(f.latest.version, '0.6.0-beta.1', 'the last good answer is kept');
  const off = await updates.check({ fetchFn: async () => { throw new Error('offline'); } });
  assert.equal(off.error, 'offline');
  updates.setCurrent('0.6.0-beta.1');
  assert.equal(updates.status().latest, null, 'not offered once installed');
});
