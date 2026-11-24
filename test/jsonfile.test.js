// PL1 (PL0 finding 1.3-n): settings.json, race.json and setup-meta.json are written atomically, and a damaged file
// is kept aside instead of being silently replaced by defaults on the next save. Also: restored settings are typed (1.3-k).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolate } from './helpers.js';

const { dir, ACEVO_DATA } = isolate('jsonfile');
// a settings.json cut off mid-write (what an in-place write leaves after a crash), and a damaged race.json
const DAMAGED = '{"geminiApiKey": "test-only-key-0123456789", "driverName": "Jan';
fs.writeFileSync(path.join(ACEVO_DATA, 'settings.json'), DAMAGED);
fs.writeFileSync(path.join(ACEVO_DATA, 'race.json'), '[1,2');
const { writeFileAtomic, readJsonSafe } = await import('../src/jsonfile.js');
const settings = await import('../src/settings.js');
const race = await import('../src/race.js');

const asideOf = (name) => fs.readdirSync(ACEVO_DATA).filter((n) => n.startsWith(`${name}.unreadable-`));

test('a damaged settings.json is kept aside, not overwritten by the next save', () => {
  assert.equal(settings.get().geminiApiKey, '', 'defaults in use');
  const aside = asideOf('settings.json');
  assert.equal(aside.length, 1);
  assert.equal(fs.readFileSync(path.join(ACEVO_DATA, aside[0]), 'utf8'), DAMAGED, 'what was in it is still there');
  settings.update({ driverName: 'New' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(ACEVO_DATA, 'settings.json'), 'utf8')).driverName, 'New');
  assert.equal(fs.readFileSync(path.join(ACEVO_DATA, aside[0]), 'utf8'), DAMAGED);
  assert.ok(!fs.readdirSync(ACEVO_DATA).some((n) => n.endsWith('.tmp')), 'no temp file left');
});

test('a damaged race.json is kept aside too; saving writes a whole file', () => {
  assert.equal(asideOf('race.json').length, 1);
  assert.deepEqual(race.lists().servers, []);
  race.saveServer({ name: 'x', ip: '1.2.3.4', port: 9600, password: 'p' });
  const saved = JSON.parse(fs.readFileSync(path.join(ACEVO_DATA, 'race.json'), 'utf8'));
  assert.equal(saved.servers[0].ip, '1.2.3.4');
  assert.equal(fs.readFileSync(path.join(ACEVO_DATA, asideOf('race.json')[0]), 'utf8'), '[1,2');
});

test('writeFileAtomic: replaces the whole file; a failed write leaves the old file and no temp file', () => {
  const f = path.join(dir, 'a.json');
  writeFileAtomic(f, '{"v":1}');
  writeFileAtomic(f, '{"v":2}');
  assert.equal(fs.readFileSync(f, 'utf8'), '{"v":2}');
  // the target is a folder: the rename fails like a locked file would
  const blocked = path.join(dir, 'blocked.json');
  fs.mkdirSync(blocked);
  assert.throws(() => writeFileAtomic(blocked, '{"v":3}'));
  assert.ok(fs.statSync(blocked).isDirectory());
  assert.ok(!fs.readdirSync(dir).some((n) => n.endsWith('.tmp')), 'temp file removed after a failure');
  // the folder of the target does not exist
  assert.throws(() => writeFileAtomic(path.join(dir, 'no', 'x.json'), '{}'), /ENOENT/);
});

test('readJsonSafe: missing → default without a log; damaged or the wrong kind → kept aside', () => {
  const logs = [];
  const log = (m) => logs.push(m);
  assert.deepEqual(readJsonSafe(path.join(dir, 'missing.json'), { d: 1 }, { log }), { d: 1 });
  assert.equal(logs.length, 0);
  const arr = path.join(dir, 'arr.json'); fs.writeFileSync(arr, '[1]');
  assert.deepEqual(readJsonSafe(arr, {}, { log }), {});
  assert.ok(!fs.existsSync(arr) && fs.readdirSync(dir).some((n) => n.startsWith('arr.json.unreadable-')));
  const ok = path.join(dir, 'ok.json'); fs.writeFileSync(ok, '﻿{"a":1}');
  assert.deepEqual(readJsonSafe(ok, {}, { log }), { a: 1 }, 'a BOM is tolerated');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /arr\.json is damaged/);
});

test('settings from disk or a restore are typed: wrong kinds get the default, unknown keys are kept', () => {
  const n = settings.normalize({ driverName: 5, port: '9090', boardShare: 'yes', updateCheck: false, hud: [1], boardSteam: 'x', markButton: { button: 1 }, future: { a: 1 }, gamePath: null });
  assert.equal(n.driverName, '');
  assert.equal(n.port, 9090);
  assert.equal(n.boardShare, false);
  assert.equal(n.updateCheck, false);
  assert.equal(n.hud, null);
  assert.equal(n.boardSteam, null);
  assert.deepEqual(n.markButton, { button: 1 });
  assert.deepEqual(n.future, { a: 1 });
  assert.equal(n.gamePath, '');
  assert.equal(settings.normalize({ port: 'abc' }).port, 8080);
});
