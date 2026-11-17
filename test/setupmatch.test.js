// Setup recognition (src/setupmatch.js match): a pit-box fingerprint against saved setups' values.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolate } from './helpers.js';

isolate('setupmatch');
const sm = await import('../src/setupmatch.js');
const db = await import('../src/db.js');

const setup = (name, mtime, p, c, bias) => ({
  file: { name, rel: `car/trk/${name}.carsetup`, id: name, mtime },
  values: { pressure_FL: p, pressure_FR: p, pressure_RL: p - 1, pressure_RR: p - 1, camber_FL: c, camber_FR: c, camber_RL: c + 0.5, camber_RR: c + 0.5, brakesfront_bias: bias },
});
const fp = (p, c, bias = null) => ({ pressure: [p, p, p - 1, p - 1], camber: [c, c, c + 0.5, c + 0.5], bias, fuel: null });
const cands = [setup('Race', 100, 27, -3.0, 56), setup('Quali', 200, 25, -3.5, 58)];

test('the setup whose values are within tolerance is matched, and its values are snapshotted', () => {
  const r = sm.match(fp(25.2, -3.4, 58), cands);
  assert.equal(r.name, 'Quali');
  assert.equal(r.match, 'matched');
  assert.deepEqual(db.getSnapshot(r.snap).values, cands[1].values);
  assert.equal(r.scores[0].name, 'Quali');
});

test('no setup within tolerance = Standard', () => {
  const r = sm.match(fp(31, -1), cands);
  assert.equal(r.name, sm.STANDARD);
  assert.equal(r.match, 'standard');
  assert.equal(r.snap, null);
});

test('unreadable shared memory: best guess is the newest setup, marked as a guess', () => {
  const r = sm.match({ pressure: [null, null, null, null], camber: [null, null, null, null], bias: null, fuel: null }, cands);
  assert.equal(r.name, 'Quali');
  assert.equal(r.match, 'guess');
  assert.equal(sm.match(null, []).name, sm.STANDARD);
});

test('identical setups: the newest wins and the others are named', () => {
  const twin = setup('Quali copy', 300, 25, -3.5, 58);
  const r = sm.match(fp(25, -3.5, 58), [...cands, twin]);
  assert.equal(r.name, 'Quali copy');
  assert.deepEqual(r.alsoMatches, ['Quali']);
});
