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
  assert.deepEqual(sensitive.mergeRestoredSettings({ geminiApiKey: 'from-backup', boardToken: TOKEN, boardSteam: STEAM }, cur), { geminiApiKey: 'from-backup', boardToken: 'cur-token', boardSteam: { name: 'Me' } },
    'an old backup that still holds a token never replaces the current sign-in');
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
  assert.equal(race.presets[0].spec.server.password, '', 'a password the install no longer has cannot come back (the safety backup has none)');
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
