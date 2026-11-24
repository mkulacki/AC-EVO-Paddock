// PL1 (PL0 findings 1.3-g, 1.3-f, 1.3-h, 1.3-i): a mod install that fails midway puts back the files it was replacing,
// zip paths with Windows device names or trailing dots/spaces are refused, setup imports are size-checked first. Scratch ACE_DIR.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolate } from './helpers.js';

const { dir, ACE_DIR } = isolate('mods');
const zip = await import('../src/zip.js');
const mods = await import('../src/mods.js');
const game = await import('../src/game.js');
// mod files are only touched while AC EVO is closed: on a PC where it is running, these tests cannot run
const skip = game.isRunningNow() ? 'AC EVO is running' : false;

const MODS = path.join(ACE_DIR, 'mods');
const read = (f) => fs.readFileSync(path.join(MODS, f), 'utf8');
const leftovers = () => fs.readdirSync(MODS).filter((n) => /\.(part|paddock-old(-[0-9]+)?)$/.test(n));
async function pack(name, files) {
  const z = path.join(dir, name);
  await zip.writeZip(z, Object.entries(files).map(([n, data]) => ({ name: n, data })));
  return z;
}

test('install with overwrite: a rename refused midway puts every replaced file back', { skip }, async () => {
  fs.mkdirSync(MODS, { recursive: true });
  fs.writeFileSync(path.join(MODS, 'a.kspkg'), 'old-a');
  fs.writeFileSync(path.join(MODS, 'b.kspkg'), 'old-b');
  const z = await pack('pack.zip', { 'mods/a.kspkg': 'new-a', 'mods/b.kspkg': 'new-b', 'mods/c.kspkg': 'new-c' });
  await assert.rejects(mods.install(z, 'pack.zip'), (e) => e.code === 409 && e.conflicts.length === 2);
  const real = mods.io.rename;
  mods.io.rename = (a, b) => { if (a.endsWith('b.kspkg.part')) throw Object.assign(new Error('EPERM: file in use'), { code: 'EPERM' }); return real(a, b); };
  try {
    await assert.rejects(mods.install(z, 'pack.zip', { overwrite: true }), /Install failed: EPERM.*nothing was changed/);
  } finally { mods.io.rename = real; }
  assert.equal(read('a.kspkg'), 'old-a', 'the file replaced before the failure is back');
  assert.equal(read('b.kspkg'), 'old-b');
  assert.ok(!fs.existsSync(path.join(MODS, 'c.kspkg')), 'no new file left');
  assert.deepEqual(leftovers(), []);
  // the same install without the failure replaces them and leaves nothing aside
  const r = await mods.install(z, 'pack.zip', { overwrite: true });
  assert.equal(r.replaced, 2);
  assert.equal(read('a.kspkg'), 'new-a');
  assert.equal(read('b.kspkg'), 'new-b');
  assert.deepEqual(leftovers(), []);
});

test('zip paths with Windows device names or trailing dots/spaces are refused', { skip }, async () => {
  for (const bad of ['mods/CON/x.txt', 'mods/aux.txt', 'mods/x/lpt1.json', 'mods/folder./x.txt', 'mods/name /x.txt', 'mods/x/file.txt.']) {
    const z = await pack(`bad-${Math.random().toString(36).slice(2)}.zip`, { [bad]: 'x', 'mods/ok.kspkg': 'ok' });
    await assert.rejects(mods.install(z, 'bad.zip'), /Unsafe path/, bad);
  }
  const z = await pack('fine.zip', { 'mods/console/condition.txt': 'x', 'mods/auxiliary.kspkg': 'y' });
  const r = await mods.install(z, 'fine.zip');
  assert.equal(r.installed, 2, 'names that only start like a device name are fine');
  // review fix: an odd name in an entry that is skipped anyway does not stop the install
  const z2 = await pack('skipped.zip', { 'mods/fine2.kspkg': 'z', 'docs/CON.txt': 'readme', 'extras/notes./a.txt': 'x' });
  const r2 = await mods.install(z2, 'skipped.zip');
  assert.equal(r2.installed, 1);
  assert.ok(r2.skipped.includes('docs/CON.txt'));
});

test('setups: oversized files are refused before parsing; device names in setup names get an underscore', async () => {
  const setups = await import('../src/setups.js');
  assert.throws(() => setups.importFile(Buffer.alloc(setups.MAX_SETUP_BYTES + 1, 0x7b)), /Not an AC EVO setup file/);
  assert.throws(() => setups.importFile(Buffer.alloc(0)), /Not an AC EVO setup file/);
  assert.equal(setups.safeName('CON'), 'CON_');
  assert.equal(setups.safeName('aux.carsetup'), 'aux_.carsetup');
  assert.equal(setups.safeName('lpt1'), 'lpt1_');
  assert.equal(setups.safeName('Console race'), 'Console race');
  assert.equal(setups.safeName('a/b:c.'), 'a b c');
});

test('review fixes: a .paddock-old left by a crashed install is kept; failing to clean up never fails the install', { skip }, async () => {
  fs.writeFileSync(path.join(MODS, 'd.kspkg'), 'current-d');
  fs.writeFileSync(path.join(MODS, 'd.kspkg.paddock-old'), 'original-from-crash');
  const z = await pack('d.zip', { 'mods/d.kspkg': 'new-d' });
  const realRm = fs.rmSync;
  fs.rmSync = (f, ...a) => { if (String(f).includes('.paddock-old')) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); return realRm(f, ...a); };
  let r;
  try { r = await mods.install(z, 'd.zip', { overwrite: true }); } finally { fs.rmSync = realRm; }
  assert.equal(read('d.kspkg'), 'new-d');
  assert.equal(read('d.kspkg.paddock-old'), 'original-from-crash', 'never deleted to make room');
  assert.ok(mods.list().some((m) => m.id === r.id), 'the manifest has the new mod although the cleanup failed');
  assert.equal(read('d.kspkg.paddock-old-2'), 'current-d', 'cleanup failed: the replaced file is still on disk');
});
