// Driving aids per lap (src/aids.js) and the stock setup check (src/setupmatch.js stockOf).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { isolate } from './helpers.js';

isolate('aids');
const aids = await import('../src/aids.js');
const db = await import('../src/db.js');
const sm = await import('../src/setupmatch.js');

const OFF = { tc: 0, tcc: 0, abs: 0, esc: 0 };
const SWITCHABLE = { tc: 1, tcc: 1, abs: 1, esc: 1 };
const ASSISTS_OFF = { gearbox: false, clutch: true, idealLine: true, stability: 0 };
const lapAids = (o = {}) => ({ lv: OFF, mod: SWITCHABLE, used: {}, partial: false, assists: ASSISTS_OFF, ...o });

test('classify: everything off is PRO; auto-clutch and the ideal line do not count', () => {
  assert.equal(aids.classify(lapAids()), 'pro');
});

test('classify: any aid on or acting, the automatic gearbox or stability control make a lap assisted', () => {
  assert.equal(aids.classify(lapAids({ lv: { ...OFF, tc: 3 } })), 'assisted');
  assert.equal(aids.classify(lapAids({ used: { abs: true } })), 'assisted');
  assert.equal(aids.classify(lapAids({ assists: { ...ASSISTS_OFF, gearbox: true } })), 'assisted');
  assert.equal(aids.classify(lapAids({ assists: { ...ASSISTS_OFF, stability: 40 } })), 'assisted');
});

test('classify: an aid the car cannot switch off gives pro-fixed', () => {
  assert.equal(aids.classify(lapAids({ lv: { ...OFF, abs: 1 }, mod: { ...SWITCHABLE, abs: 0 } })), 'pro-fixed');
});

test('classify: a partial lap, no levels or no assist settings are unknown', () => {
  assert.equal(aids.classify(lapAids({ partial: true })), 'unknown');
  assert.equal(aids.classify(null), 'unknown');
  assert.equal(aids.classify(lapAids({ assists: null })), 'unknown');
  // but an aid that is on decides it, assist settings or not
  assert.equal(aids.classify(lapAids({ lv: { ...OFF, tc: 2 }, assists: null })), 'assisted');
});

test('normaliseAssists reads the game preset values', () => {
  assert.deepEqual(aids.normaliseAssists({ type: 'Pro', automatic_gearbox: 'RacingSetting_OFF', automatic_clutch: 'RacingSetting_ON', stability_control: 0, ideal_line: 'RacingSetting_OFF' }),
    { gearbox: false, clutch: true, idealLine: false, stability: 0, preset: 'Pro' });
  assert.equal(aids.normaliseAssists(null), null);
});

function lapRow(lapNumber) {
  const sessionId = db.createSession({ track: 't', layout: 'l', car: 'c', sessionType: 1, driver: 'Me', startedAt: 1 });
  const data = { t: [0, 1], d: [0, 1] };
  return db.insertLap({ sessionId, track: 't', layout: 'l', car: 'c', lapNumber, lapTimeMs: 90000, valid: true, driver: 'Me', recordedAt: 1, trackLength: 1000, data });
}

test('a lap summary that arrives before the lap is saved is stored with that lap', () => {
  const rec = new EventEmitter();
  const tr = aids.createAidsTracker({ recorder: rec });
  tr.onCommand({ t: 'assists', a: { automatic_gearbox: 'RacingSetting_OFF', stability_control: 0 } });
  tr.onCommand({ t: 'lap', lap: 4, lv: OFF, min: OFF, mod: SWITCHABLE, max: { tc: 11, tcc: 11, abs: 11, esc: 5 }, used: {} });
  const id = lapRow(5);
  rec.emit('lap', { id, lapNumber: 5 });
  const a = db.getLapAids(id);
  assert.equal(a.cls, 'pro');
  assert.equal(a.max.tc, 11);
  assert.equal(tr.live().lastLap.label, 'PRO');
});

test('a late summary replaces the provisional aids of its lap', () => {
  const rec = new EventEmitter();
  const tr = aids.createAidsTracker({ recorder: rec });
  tr.onCommand({ t: 'assists', a: { automatic_gearbox: 'RacingSetting_OFF', stability_control: 0 } });
  tr.onCommand({ t: 'lv', lap: 2, lv: OFF, mod: SWITCHABLE, max: OFF });
  const id = lapRow(3);
  rec.emit('lap', { id, lapNumber: 3 });
  assert.equal(db.getLapAids(id).cls, 'unknown'); // provisional: the HUD has not seen the lap end yet
  tr.onCommand({ t: 'lap', lap: 2, lv: { ...OFF, tc: 4 }, min: OFF, mod: SWITCHABLE, max: OFF, used: { tc: true } });
  const a = db.getLapAids(id);
  assert.equal(a.cls, 'assisted');
  assert.equal(a.used.tc, true);
});

test('no HUD at all: the lap is left without aids; a new session forgets old summaries', () => {
  const rec = new EventEmitter();
  aids.createAidsTracker({ recorder: rec });
  const id = lapRow(1);
  rec.emit('lap', { id, lapNumber: 1 });
  assert.equal(db.getLapAids(id), null);

  const tr = aids.createAidsTracker({ recorder: rec });
  tr.onCommand({ t: 'lap', lap: 0, lv: OFF, min: OFF, mod: SWITCHABLE, max: OFF, used: {} });
  rec.emit('session', {});
  const id2 = lapRow(1);
  rec.emit('lap', { id: id2, lapNumber: 1 });
  assert.equal(db.getLapAids(id2), null);
});

test('use messages show what acted in the lap being driven', () => {
  const tr = aids.createAidsTracker({ recorder: null });
  tr.onCommand({ t: 'use', lap: 7, aid: 'abs' });
  assert.deepEqual(tr.live().usedThisLap, { tc: false, abs: true, esc: false });
  tr.onCommand({ t: 'use', lap: 8, aid: 'tc' });
  assert.deepEqual(tr.live().usedThisLap, { tc: true, abs: false, esc: false });
});

// ---------------------------------------------------------------- stock setup check
const stock = [{ name: 'Game default', values: { pressure_FL: 27, pressure_FR: 27, pressure_RL: 26, pressure_RR: 26, camber_FL: -3, camber_FR: -3, camber_RL: -2.5, camber_RR: -2.5,
  brakesfront_bias: 56, wheel_rate_FL: 120000, fuel: 60, tc1: 3, abs: 2 } }];
const fp = (p, c) => ({ pressure: [p, p, p - 1, p - 1], camber: [c, c, c + 0.5, c + 0.5], bias: null, fuel: null });

test('stock: a saved setup equal to the game default (fuel and aids aside) is stock', () => {
  const snap = 'stocktest1';
  db.saveSnapshot(snap, { name: 'Mine', values: { ...stock[0].values, fuel: 20, tc1: 0, abs: 0 } });
  assert.deepEqual(sm.stockOf({ match: 'matched', snap }, 'car', stock), { state: 'stock', name: 'Game default', how: 'file' });
});

test('stock: a saved setup with one spring changed is not', () => {
  const snap = 'stocktest2';
  db.saveSnapshot(snap, { name: 'Mine', values: { ...stock[0].values, wheel_rate_FL: 130000 } });
  assert.equal(sm.stockOf({ match: 'matched', snap }, 'car', stock).state, 'changed');
});

test('stock: with no saved setup matched, the pit-box readings decide "likely" or "changed"', () => {
  assert.equal(sm.stockOf({ match: 'standard', snap: null, probe: fp(27.1, -3) }, 'car', stock).state, 'likely');
  assert.equal(sm.stockOf({ match: 'standard', snap: null, probe: fp(31, -1) }, 'car', stock).state, 'changed');
  assert.equal(sm.stockOf({ match: 'guess', snap: null, probe: fp(27, -3) }, 'car', stock).state, 'unknown');
  assert.equal(sm.stockOf({ match: 'standard', snap: null, probe: fp(27, -3) }, 'car', []).state, 'unknown');
});
