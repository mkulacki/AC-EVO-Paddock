// PL1 review fix: a settings.json that cannot be read at start (held by antivirus / OneDrive, here: a folder in its
// place) is never saved over with defaults; once it can be read again, the next save keeps what was in it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolate } from './helpers.js';

const { ACEVO_DATA } = isolate('settings-locked');
const FILE = path.join(ACEVO_DATA, 'settings.json');
fs.mkdirSync(FILE); // readFileSync fails (EISDIR), and it cannot be renamed over
const settings = await import('../src/settings.js');

test('unreadable at start: defaults in memory, saves refused, nothing written', () => {
  assert.equal(settings.get().geminiApiKey, '');
  assert.equal(settings.saveable(), false);
  assert.throws(() => settings.update({ driverName: 'X' }), (e) => e.code === 503 && /not saved over/.test(e.message));
  assert.ok(fs.statSync(FILE).isDirectory());
  assert.equal(settings.get().driverName, '');
  // PL1D (OD-PL-5): the Settings page is told, without the folder
  assert.deepEqual(settings.fileNotices().map((n) => ({ ...n, at: 0 })), [{ file: 'settings.json', state: 'failed', damaged: false, keptAs: null, at: 0, savesRefused: true }]);
});

test('readable again: the next save loads it first and keeps the key', () => {
  fs.rmdirSync(FILE);
  fs.writeFileSync(FILE, JSON.stringify({ geminiApiKey: 'test-only-key-0123456789', driverName: 'Jan' }));
  settings.update({ language: 'Polski' });
  const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  assert.equal(saved.geminiApiKey, 'test-only-key-0123456789');
  assert.equal(saved.driverName, 'Jan');
  assert.equal(saved.language, 'Polski');
  assert.equal(settings.saveable(), true);
  assert.deepEqual(settings.fileNotices(), [], 'the notice goes once the file could be read');
});
