// PL1.1 credential-safe backups: the sensitive-settings list (src/sensitive.js) and every output that uses it
// (backups, restores, diagnostics, the page's settings view). Regression tests for PL0 findings 1.1-a … 1.1-d.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolate, seedRandom } from './helpers.js';

const { dir, ACEVO_DATA } = isolate('secrets');
// fake values only (they must not match the release secret scan, CLAUDE.md step 3)
const KEY = 'test-only-key-0123456789', PW = 'server-pass-xyz', TOKEN = 'ab'.repeat(32), STEAM = { steamId: '76561190000000001', name: 'SteamNick', admin: false, url: 'https://board.example' };
fs.writeFileSync(path.join(ACEVO_DATA, 'settings.json'), JSON.stringify({ geminiApiKey: KEY, driverName: 'Jan Kowalski', boardToken: TOKEN, boardSteam: STEAM, boardShare: true }));
fs.writeFileSync(path.join(ACEVO_DATA, 'race.json'), JSON.stringify({ servers: [{ id: 's1', ip: '1.2.3.4', port: 9600, password: PW }], presets: [{ spec: { server: { password: PW } } }] }));
seedRandom(3);
const sensitive = await import('../src/sensitive.js');
const zip = await import('../src/zip.js');
const backup = await import('../src/backup.js');
const { applyPendingRestore, PENDING } = await import('../src/restore-apply.js');
const settings = await import('../src/settings.js');
const diagnostics = await import('../src/diagnostics.js');
const { seedLaps } = await import('../src/mock.js');
await seedLaps(2);

const entryText = (name, entry) => zip.readEntry(backup.fileOf(name), entry)?.toString('utf8') ?? null;
const rawZip = (name) => fs.readFileSync(backup.fileOf(name)).toString('latin1');

// ---------------------------------------------------------------- the list itself
test('inventory: key and token are secrets/sign-in; legacy settings without them get no new fields', () => {
  assert.deepEqual(sensitive.SECRET_SETTINGS, ['geminiApiKey']);
  assert.deepEqual(sensitive.SIGN_IN_FIELDS, ['boardToken', 'boardSteam']);
  const full = { geminiApiKey: KEY, boardToken: TOKEN, boardSteam: STEAM, driverName: 'x', hud: { scale: 90 } };
  assert.deepEqual(sensitive.stripSettings(full), { geminiApiKey: '', boardToken: '', boardSteam: null, driverName: 'x', hud: { scale: 90 } });
  assert.deepEqual(sensitive.stripSettings(full, { keepSecrets: true }), { geminiApiKey: KEY, boardToken: '', boardSteam: null, driverName: 'x', hud: { scale: 90 } });
  assert.equal(full.boardToken, TOKEN, 'the input is not changed');
  assert.deepEqual(sensitive.stripSettings({ driverName: 'old' }), { driverName: 'old' }, 'a legacy file stays as it was');
  for (const junk of [null, undefined, 'x', [1]]) assert.deepEqual(sensitive.stripSettings(junk), {});
  const race = { servers: [{ password: PW, ip: '1' }], deep: [[{ a: { password: 'p2' } }]] };
  assert.deepEqual(sensitive.raceSecrets(race), [PW, 'p2']);
  assert.ok(!JSON.stringify(sensitive.stripRace(race)).includes(PW));
  assert.equal(race.servers[0].password, PW, 'the input is not changed');
  assert.deepEqual(sensitive.settingsSecrets({ geminiApiKey: KEY, boardToken: TOKEN }), [KEY, TOKEN]);
});

test('restore merge: the key comes from the current file when the backup has none; the sign-in is always the current one (OD-PL-1 b)', () => {
  const cur = { geminiApiKey: 'current', boardToken: 'cur-token', boardSteam: { name: 'Me' } };
  assert.deepEqual(sensitive.mergeRestoredSettings({ driverName: 'b', geminiApiKey: '' }, cur), { driverName: 'b', geminiApiKey: 'current', boardToken: 'cur-token', boardSteam: { name: 'Me' } },
    'a backup without a sign-in keeps the current one');
  assert.deepEqual(sensitive.mergeRestoredSettings({ geminiApiKey: 'from-backup', boardToken: TOKEN, boardSteam: STEAM }, cur), { geminiApiKey: 'current', boardToken: 'cur-token', boardSteam: { name: 'Me' } },
    'current secrets win: the backup key never replaces the current one; an old token never replaces the current sign-in');
  assert.equal(sensitive.mergeRestoredSettings({ geminiApiKey: 'from-backup' }, { geminiApiKey: '' }).geminiApiKey, 'from-backup', 'an empty key is filled from the backup');
  assert.deepEqual(sensitive.mergeRestoredSettings({ boardToken: TOKEN, boardSteam: STEAM }, {}), { boardToken: '', boardSteam: null },
    'an old backup that still holds a token does not sign a signed-out install in');
  assert.deepEqual(sensitive.mergeRestoredSettings({}, { boardToken: 'half', boardSteam: null }), { boardToken: '', boardSteam: null }, 'half a sign-in is not kept');
  assert.deepEqual(sensitive.mergeRestoredSettings({}, {}), { boardToken: '', boardSteam: null });
});

test('the page never sees the token; the key is masked', () => {
  const v = settings.publicView();
  assert.equal(v.boardToken, undefined);
  assert.ok(!JSON.stringify(v).includes(TOKEN));
  assert.equal(v.geminiApiKey, '••••6789');
  assert.equal(v.hasKey, true);
  assert.equal(v.boardSteam.name, 'SteamNick', 'the driver sees who is signed in');
});

// ---------------------------------------------------------------- backups
let plain, withKey;
test('secret-free backup: no Gemini key, no leaderboard token or Steam identity, no passwords; manifest says so', async () => {
  plain = await backup.create({ appVersion: '9.9.9' });
  assert.ok(plain.ok, plain.error);
  const s = JSON.parse(entryText(plain.name, 'settings.json'));
  assert.equal(s.geminiApiKey, '');
  assert.equal(s.boardToken, '');
  assert.equal(s.boardSteam, null);
  assert.equal(s.driverName, 'Jan Kowalski', 'preferences are kept');
  assert.equal(s.boardShare, true, 'preferences are kept');
  const raw = rawZip(plain.name) + entryText(plain.name, 'settings.json') + entryText(plain.name, 'race.json');
  for (const secret of [KEY, TOKEN, PW, STEAM.steamId]) assert.ok(!raw.includes(secret), `${secret} must not be in a secret-free backup`);
  const m = JSON.parse(entryText(plain.name, 'manifest.json'));
  assert.equal(m.includesSecrets, false);
  assert.equal(m.signIn, false);
  assert.deepEqual(m.files, zip.list(backup.fileOf(plain.name)).map((e) => e.name).filter((n) => n !== 'manifest.json'), 'manifest lists exactly the files in the zip');
  assert.match(backup.PARTS.find((p) => p.id === 'settings').hint, /never the leaderboard sign-in/);
});

test('"include secrets" backup: key and passwords in, the token still out (OD-PL-1)', async () => {
  withKey = await backup.create({ includeSecrets: true });
  const s = JSON.parse(entryText(withKey.name, 'settings.json'));
  assert.equal(s.geminiApiKey, KEY);
  assert.equal(s.boardToken, '');
  assert.equal(s.boardSteam, null);
  assert.ok(entryText(withKey.name, 'race.json').includes(PW));
  assert.equal(withKey.includesSecrets, true);
});

let safety;
test('before-restore safety backup holds no secrets at all: no key, passwords, token or Steam identity (OD-PL-4)', async () => {
  const r = await backup.stageRestore(withKey.name);
  safety = r.before;
  const s = JSON.parse(entryText(r.before, 'settings.json'));
  assert.equal(s.geminiApiKey, '');
  assert.equal(s.boardToken, '');
  assert.equal(s.boardSteam, null);
  assert.equal(s.driverName, 'Jan Kowalski', 'preferences are kept');
  const raw = rawZip(r.before) + entryText(r.before, 'settings.json') + entryText(r.before, 'race.json');
  for (const secret of [KEY, TOKEN, PW, STEAM.steamId]) assert.ok(!raw.includes(secret), `${secret} must not be in the safety backup`);
  const d = backup.listBackups().find((b) => b.name === r.before);
  assert.equal(d.includesSecrets, false, 'listed without the "with key" badge');
  assert.equal(JSON.parse(entryText(r.before, 'manifest.json')).includesSecrets, false);
  backup.cancelRestore();
});

// ---------------------------------------------------------------- restore
function applyIn(name, current, currentRace = null, { race = false } = {}) {
  const other = fs.mkdtempSync(path.join(dir, 'restore-'));
  fs.mkdirSync(path.join(other, PENDING));
  const f = backup.fileOf(name);
  const files = [];
  for (const e of zip.list(f)) if (['settings.json', 'race.json'].includes(e.name)) { fs.writeFileSync(path.join(other, PENDING, e.name), zip.readEntry(f, e.name)); files.push(e.name); }
  fs.writeFileSync(path.join(other, PENDING, 'manifest.json'), JSON.stringify({ files }));
  fs.writeFileSync(path.join(other, 'settings.json'), JSON.stringify(current));
  if (currentRace) fs.writeFileSync(path.join(other, 'race.json'), JSON.stringify(currentRace));
  const r = applyPendingRestore(other);
  assert.equal(r.ok, true, r.error);
  const s = JSON.parse(fs.readFileSync(path.join(other, 'settings.json'), 'utf8'));
  return race ? { settings: s, race: JSON.parse(fs.readFileSync(path.join(other, 'race.json'), 'utf8')) } : s;
}

test('restoring a secret-free backup: current sign-in and key kept, preferences restored (OD-PL-1 b)', () => {
  const s = applyIn(plain.name, { geminiApiKey: 'current-key', boardToken: 'current-token', boardSteam: { name: 'Current' }, driverName: 'Other' });
  assert.equal(s.driverName, 'Jan Kowalski');
  assert.equal(s.geminiApiKey, 'current-key');
  assert.equal(s.boardToken, 'current-token', 'the install stays signed in');
  assert.deepEqual(s.boardSteam, { name: 'Current' });
  const out = applyIn(plain.name, { geminiApiKey: '' });
  assert.equal(out.boardToken, '', 'a signed-out install stays signed out');
  assert.equal(out.boardSteam, null);
});

test('undoing a restore with the safety backup keeps the current key, passwords and sign-in (OD-PL-4 with OD-PL-1 b)', () => {
  // the install after a restore: other key, a new password for the same server, signed in
  const cur = { geminiApiKey: 'after-restore-key', driverName: 'Restored', boardToken: 'current-token', boardSteam: { steamId: '1', name: 'Current' } };
  const curRace = { servers: [{ id: 's1', ip: '1.2.3.4', port: 9600, password: 'after-restore-pw' }], presets: [] };
  const { settings: s, race } = applyIn(safety, cur, curRace, { race: true });
  assert.equal(s.driverName, 'Jan Kowalski', 'the settings from before the restore come back');
  assert.equal(s.geminiApiKey, 'after-restore-key', 'the key the install has now is kept');
  assert.equal(s.boardToken, 'current-token', 'still signed in');
  assert.equal(s.boardSteam.name, 'Current');
  assert.equal(race.servers[0].password, 'after-restore-pw', 'the saved server keeps its current password');
  assert.equal(race.presets[0].spec.server.password, '', 'a preset with no server address gets no password from elsewhere');
});

test('current secrets win (user decision 2026-11-24): restoring a backup WITH secrets never replaces the current key or passwords', () => {
  const cur = { geminiApiKey: 'current-key', boardToken: 'current-token', boardSteam: { name: 'Current' } };
  const curRace = { servers: [{ id: 's1', ip: '1.2.3.4', port: 9600, password: 'current-pw' }, { id: 'only-here', ip: '9.9.9.9', port: 1, password: 'kept-pw' }],
    presets: [{ id: 'p-here', name: 'Mine', spec: { server: { ip: '9.9.9.9', port: 1, password: 'kept-pw' } } }, { id: 'p-plain', name: 'Plain', spec: {} }] };
  const { settings: s, race } = applyIn(withKey.name, cur, curRace, { race: true });
  assert.equal(s.geminiApiKey, 'current-key', 'the key in the backup does not replace the current one');
  assert.equal(s.boardToken, 'current-token');
  assert.equal(race.servers.find((x) => x.id === 's1').password, 'current-pw', 'the backup password does not replace the current one');
  assert.equal(race.servers.find((x) => x.id === 'only-here')?.password, 'kept-pw', 'a server the backup lacks is kept with its password');
  assert.equal(race.presets.find((p) => p.id === 'p-here')?.spec.server.password, 'kept-pw', 'a preset the backup lacks is kept when it holds a password');
  assert.ok(!race.presets.some((p) => p.id === 'p-plain'), 'a preset without a password follows the backup');
  // an install without a key or password gets the backup's
  const { settings: s2, race: r2 } = applyIn(withKey.name, { geminiApiKey: '' }, { servers: [{ id: 's1', ip: '1.2.3.4', port: 9600, password: '' }] }, { race: true });
  assert.equal(s2.geminiApiKey, KEY);
  assert.equal(r2.servers.find((x) => x.id === 's1').password, PW);
});

// round 3 review: the current files are read like everywhere else (a BOM is fine) and never silently taken as empty
function applyRaw(name, settingsText, raceText) {
  const other = fs.mkdtempSync(path.join(dir, 'restore-raw-'));
  fs.mkdirSync(path.join(other, PENDING));
  const f = backup.fileOf(name);
  const files = [];
  for (const e of zip.list(f)) if (['settings.json', 'race.json'].includes(e.name)) { fs.writeFileSync(path.join(other, PENDING, e.name), zip.readEntry(f, e.name)); files.push(e.name); }
  fs.writeFileSync(path.join(other, PENDING, 'manifest.json'), JSON.stringify({ files }));
  if (settingsText != null) fs.writeFileSync(path.join(other, 'settings.json'), settingsText);
  if (raceText != null) fs.writeFileSync(path.join(other, 'race.json'), raceText);
  const r = applyPendingRestore(other);
  const read = (n) => JSON.parse(fs.readFileSync(path.join(other, n), 'utf8'));
  return { r, other, settings: read('settings.json'), race: read('race.json'), kept: fs.readdirSync(other).filter((n) => /\.json\.unreadable-\d+$/.test(n)) };
}

test('restore: a current settings.json / race.json with a BOM (Notepad) keeps key, sign-in and passwords', () => {
  const bom = '﻿';
  const { r, settings: s, race } = applyRaw(withKey.name,
    bom + JSON.stringify({ geminiApiKey: 'bom-key', boardToken: 'bom-token', boardSteam: { steamId: '2', name: 'Bom' } }),
    bom + JSON.stringify({ servers: [{ id: 's1', ip: '1.2.3.4', port: 9600, password: 'bom-pw' }] }));
  assert.equal(r.ok, true, r.error);
  assert.equal(s.geminiApiKey, 'bom-key');
  assert.equal(s.boardToken, 'bom-token');
  assert.equal(s.boardSteam.name, 'Bom');
  assert.equal(race.servers.find((x) => x.id === 's1').password, 'bom-pw');
});

test('restore: a damaged current settings.json / race.json is kept aside (never silently lost), then the backup is applied', () => {
  const DAMAGED_S = '{"geminiApiKey": "damaged-key-0123456789", "driverName": "X', DAMAGED_R = '{"servers": [{"password": "damaged-pw"';
  const logged = []; const real = console.error; console.error = (m) => logged.push(String(m));
  let out; try { out = applyRaw(withKey.name, DAMAGED_S, DAMAGED_R); } finally { console.error = real; }
  assert.equal(out.r.ok, true, out.r.error);
  assert.equal(out.kept.length, 2, 'both damaged files kept as <name>.unreadable-<time>');
  const keptS = out.kept.find((n) => n.startsWith('settings.json.')), keptR = out.kept.find((n) => n.startsWith('race.json.'));
  assert.equal(fs.readFileSync(path.join(out.other, keptS), 'utf8'), DAMAGED_S, 'the key stays recoverable in the kept copy');
  assert.equal(fs.readFileSync(path.join(out.other, keptR), 'utf8'), DAMAGED_R);
  assert.equal(out.settings.geminiApiKey, KEY, 'nothing current could be read: the backup fills the key');
  assert.ok(logged.some((m) => /settings\.json is damaged/.test(m)), 'logged');
});

test('restore: a current settings.json that cannot be read at all (locked) is not replaced', () => {
  const other = fs.mkdtempSync(path.join(dir, 'restore-locked-'));
  fs.mkdirSync(path.join(other, PENDING));
  fs.writeFileSync(path.join(other, PENDING, 'settings.json'), zip.readEntry(backup.fileOf(withKey.name), 'settings.json'));
  fs.writeFileSync(path.join(other, PENDING, 'manifest.json'), JSON.stringify({ files: ['settings.json'] }));
  fs.mkdirSync(path.join(other, 'settings.json')); // read fails (EISDIR), like a file held by another program
  const real = console.error; console.error = () => {};
  let r; try { r = applyPendingRestore(other); } finally { console.error = real; }
  assert.equal(r.ok, false);
  assert.match(r.error, /settings\.json: the current file could not be read/);
  assert.ok(fs.statSync(path.join(other, 'settings.json')).isDirectory(), 'left as it was');
});

test('race merge: servers match by id, else host:port; the restored list is never shortened', async () => {
  const { mergeRestoredRace } = await import('../src/restore-apply.js');
  const out = mergeRestoredRace(
    { servers: [{ id: 'a', ip: '1.1.1.1', port: 1, password: 'old' }, { id: 'b', ip: ' 2.2.2.2 ', port: 2, password: '' }], last: { server: { ip: '1.1.1.1', port: 1, password: '' } } },
    { servers: [{ id: 'a', ip: '5.5.5.5', port: 5, password: 'new-a' }, { id: 'x', ip: '2.2.2.2', port: 2, password: 'by-host' }] });
  assert.deepEqual(out.servers.map((x) => [x.id, x.password]), [['a', 'new-a'], ['b', 'by-host']], 'same id wins over the address; same address fills; nothing duplicated');
  assert.equal(out.last.server.password, '', 'no current password for that address: the backup value (empty) stays');
  assert.deepEqual(mergeRestoredRace(null, { servers: [{ id: 'z', ip: 'h', port: 3, password: 'p' }] }).servers.map((x) => x.id), ['z'], 'a backup without servers keeps the current ones');
  assert.deepEqual(mergeRestoredRace({ servers: [{ id: 'q', password: 'from-backup' }] }, {}).servers[0].password, 'from-backup');
  // presets: same id, else same name (as src/race.js savePreset): never two presets of one name
  const pr = mergeRestoredRace({ presets: [{ id: 'b1', name: 'Online', spec: { server: { ip: 'h', port: 1, password: '' } } }] },
    { presets: [{ id: 'c1', name: ' Online ', spec: { server: { ip: 'h', port: 1, password: 'pw' } } }, { id: 'c2', name: 'Other', spec: { server: { password: 'pw2' } } }] });
  assert.deepEqual(pr.presets.map((p) => p.id), ['b1', 'c2']);
  assert.equal(pr.presets[0].spec.server.password, 'pw', 'the same-named preset gets the current password for its server');
});

test('an older backup that still holds a token restores without it, and keeps the current sign-in', async () => {
  const old = path.join(backup.BACKUP_DIR, 'paddock-backup-legacy.zip');
  await zip.writeZip(old, [
    { name: 'manifest.json', data: JSON.stringify({ format: backup.FORMAT, version: 1, includesSecrets: false, files: ['settings.json'] }) },
    { name: 'settings.json', data: JSON.stringify({ driverName: 'Legacy', geminiApiKey: '', boardToken: TOKEN, boardSteam: STEAM }) }]);
  assert.equal(backup.listBackups().find((b) => b.name === 'paddock-backup-legacy.zip').ok, true, 'still listed as a valid backup');
  const s = applyIn('paddock-backup-legacy.zip', { geminiApiKey: 'k2' });
  assert.equal(s.driverName, 'Legacy');
  assert.equal(s.boardToken, '');
  assert.equal(s.boardSteam, null);
  assert.equal(s.geminiApiKey, 'k2');
  const kept = applyIn('paddock-backup-legacy.zip', { boardToken: 'current-token', boardSteam: { name: 'Current' } });
  assert.equal(kept.boardToken, 'current-token', 'the backup token never replaces the current one');
  assert.equal(kept.boardSteam.name, 'Current');
  backup.remove('paddock-backup-legacy.zip');
});

// ---------------------------------------------------------------- diagnostics
test('diagnostics: no token, key, password or Steam name', () => {
  fs.mkdirSync(path.join(ACEVO_DATA, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(ACEVO_DATA, 'logs', 'paddock.log'), `[board] signed in with Steam as SteamNick\n[x] token ${TOKEN}\n[race] pw ${PW}\n`);
  const { text, data } = diagnostics.build({ version: 't', source: 'mock', recorder: {}, game: {}, loader: {}, hud: {}, paths: {} });
  for (const secret of [KEY, TOKEN, PW, 'SteamNick']) assert.ok(!text.includes(secret) && !JSON.stringify(data).includes(secret), `${secret} leaked`);
});
