// Comparison compatibility (PL4.2, src/compat.js): compatible / caveats / incompatible from recorded provenance only.
// Unknown never counts as a match; every caveat says what it changes. Then the compare, consistency and progress
// payloads on seeded mock laps. Scratch data dir, no game.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolate, seedRandom } from './helpers.js';

isolate('compat');
seedRandom(5);
const compat = await import('../src/compat.js');
const channels = await import('../src/channels.js');
const db = await import('../src/db.js');
const svc = await import('../src/service.js');
const { seedLaps } = await import('../src/mock.js');
channels.configure({ gameVersion: () => '0.6.1', hudVersion: () => '0.14.0' });

const lap = (over = {}) => ({
  id: 1, car: 'gt3', track: 'monza', layout: 'gp', source: 'local', game: '0.6.1', reader: 'shm r1',
  setup: { id: 'snap:abc', name: 'Race' }, setupName: 'Race', airC: 20, roadC: 28, weather: 'clear', grip: 'green', aids: 'pro', sessionType: 0, ...over,
});
const all = (s) => () => s; // every group has this status
const keys = (r) => r.items.map((i) => i.key);

test('everything known and the same: compatible, with what was matched', () => {
  const r = compat.classify(lap(), lap({ id: 2 }), { statusOf: all('verified') });
  assert.equal(r.level, 'compatible');
  assert.deepEqual(r.items, []);
  for (const m of ['car', 'track', 'game version', 'setup', 'track temperature', 'driving aids', 'session type']) assert.ok(r.matched.includes(m), m);
});

test('another car or layout: incompatible, with the practical effect', () => {
  let r = compat.classify(lap(), lap({ id: 2, car: 'gt4' }), { statusOf: all('verified') });
  assert.equal(r.level, 'incompatible');
  assert.deepEqual(keys(r), ['car']);
  assert.match(r.items[0].effect, /the car, not your driving/);
  r = compat.classify(lap(), lap({ id: 2, layout: 'junior' }), { statusOf: all('verified') });
  assert.equal(r.level, 'incompatible'); assert.deepEqual(keys(r), ['track']);
  r = compat.classify(lap({ car: null }), lap({ id: 2 }), { statusOf: all('verified') });
  assert.equal(r.level, 'incompatible', 'an unknown car is not the same car');
});

test('each difference is a caveat that says what it changes', () => {
  const cases = [
    [{ game: '0.7.0' }, 'game', /update/],
    [{ setup: { id: 'snap:zzz', name: 'Quali' }, setupName: 'Quali' }, 'setup', /setup/],
    [{ setup: { id: 'snap:zzz', name: 'Race' } }, 'setup', /setup/],
    [{ roadC: 40 }, 'conditions', /grip/],
    [{ weather: 'rain' }, 'conditions', /grip/],
    [{ aids: 'assisted' }, 'aids', /brake/],
    [{ sessionType: 1 }, 'session', /Traffic/],
  ];
  for (const [over, key, effect] of cases) {
    const r = compat.classify(lap(), lap({ id: 2, ...over }), { statusOf: all('verified') });
    assert.equal(r.level, 'caveats', JSON.stringify(over));
    assert.deepEqual(keys(r), [key], JSON.stringify(over));
    assert.match(r.items[0].effect, effect);
    assert.ok(r.items[0].detail.length > 10);
  }
  const same = compat.classify(lap(), lap({ id: 2, setup: { id: 'snap:zzz', name: 'Race' } }), { statusOf: all('verified') });
  assert.equal(same.items[0].title, 'Same setup file, other values');
  const near = compat.classify(lap(), lap({ id: 2, roadC: 28 + compat.LIMITS.roadC }), { statusOf: all('verified') });
  assert.equal(near.level, 'compatible', `up to ${compat.LIMITS.roadC} °C is the same conditions`);
});

test('unknown never counts as a match: one caveat lists what is not recorded', () => {
  const r = compat.classify(lap({ game: null, setup: null, aids: null }), lap({ id: 2, sessionType: null, roadC: null }), { statusOf: all('verified') });
  assert.equal(r.level, 'caveats');
  assert.deepEqual(keys(r), ['unknown']);
  for (const u of ['game version', 'setup', 'driving aids', 'session type', 'track temperature']) assert.ok(r.unknown.includes(u), u);
  assert.ok(!r.matched.includes('game version'));
  assert.match(r.items[0].effect, /Unknown is not the same/);
});

test('channel quality: an unconfirmed setup recognition is not proof; readings marked wrong are not used', () => {
  let r = compat.classify(lap(), lap({ id: 2 }), { statusOf: (g) => (g === 'setupProbe' ? 'unverified' : 'verified') });
  assert.deepEqual(keys(r), ['setup']);
  assert.match(r.items[0].title, /recognition not confirmed/);
  r = compat.classify(lap(), lap({ id: 2, roadC: 40 }), { statusOf: (g) => (g === 'conditions' ? 'mismatch' : 'verified') });
  assert.deepEqual(keys(r), ['unknown'], 'temperatures marked wrong: neither a match nor a difference');
  assert.ok(r.unknown.some((u) => /temperatures \(marked as wrong\)/.test(u)));
  r = compat.classify(lap(), lap({ id: 2, aids: 'assisted' }), { statusOf: (g) => (g === 'aids' ? 'unverified' : 'verified') });
  assert.match(r.items[0].detail, /not checked against the game/);
});

test('the ideal lap: parts that agree count as known, parts that differ are named, any unknown part makes it unknown', () => {
  const m = compat.merge([lap(), lap({ id: 2, roadC: 30 }), lap({ id: 3, game: '0.7.0', setup: { id: 'snap:x', name: 'B' } })]);
  assert.equal(m.car, 'gt3'); assert.equal(m.game, compat.MIXED); assert.equal(m.setup.id, compat.MIXED);
  assert.deepEqual(m.tempRange.road, { min: 28, max: 30 }); assert.equal(m.parts, 3);
  const r = compat.classify(lap(), m, { statusOf: all('verified') });
  assert.equal(r.level, 'caveats');
  assert.ok(keys(r).includes('game') && keys(r).includes('setup'));
  assert.match(r.items.find((i) => i.key === 'game').title, /ideal lap mixes/);
  assert.equal(compat.merge([lap(), lap({ id: 2, aids: null })]).aids, null);
  assert.equal(compat.merge([]), null);
});

test('provenance from a database row: JSON columns, stock setups, damaged JSON', () => {
  const p = compat.provenance({ id: 9, car: 'gt3', track: 'monza', layout: 'gp', source: 'local', setup_name: 'Standard',
    setup_info: JSON.stringify({ match: 'none', stock: { name: 'Default' } }), cond: JSON.stringify({ game: '0.6.1', airC: 21, roadC: 30, reader: 'shm r1' }),
    aids: JSON.stringify({ cls: 'unknown' }) }, { sessionType: 1 });
  assert.equal(p.setup.id, 'stock:Default'); assert.equal(p.game, '0.6.1'); assert.equal(p.aids, null, "'unknown' class = not known"); assert.equal(p.sessionType, 1);
  const bad = compat.provenance({ id: 1, car: 'x', cond: '{oops', setup_info: 'nope', aids: null });
  assert.equal(bad.game, null); assert.equal(bad.setup, null);
});

test('mix: what varies between the laps of a trend, and what is not recorded', () => {
  const r = compat.mix([lap(), lap({ id: 2, game: '0.7.0' }), lap({ id: 3, aids: null })]);
  assert.equal(r.level, 'caveats');
  assert.deepEqual(r.items.map((i) => i.key), ['game', 'unknown']);
  assert.match(r.items[1].detail, /driving aids \(1 of 3 laps\)/);
  assert.equal(compat.mix([lap(), lap({ id: 2 })]).level, 'compatible');
});

// ---------------------------------------------------------------- the payloads
await seedLaps(4);
const local = db.listLaps().sort((a, b) => a.id - b.id);
const combo = { track: local[0].track, layout: local[0].layout, car: local[0].car };

test('compare: each lap carries its compatibility with the reference; the charts name what they rest on', () => {
  const d = svc.compare([local[1].id], String(local[0].id));
  assert.equal(d.laps.length, 1);
  const c = d.laps[0].compat;
  assert.equal(c.level, 'caveats', 'mock laps record no game version, setup or aids');
  assert.ok(c.unknown.includes('game version'));
  assert.ok(c.matched.includes('car') && c.matched.includes('session type'));
  assert.equal(d.compat.level, 'caveats');
  assert.deepEqual(d.compat.basis.map((b) => [b.id, b.status]), [['core', 'verified'], ['trackLimits', 'verified'], ['gforce', 'unverified']]);
});

test('compare: with conditions and game version recorded, a game update shows as a caveat', () => {
  db.setLapCond(local[0].id, { airC: 20, roadC: 28, game: '0.6.1' });
  db.setLapCond(local[1].id, { airC: 20, roadC: 29, game: '0.7.0' });
  svc.invalidate();
  const c = svc.compare([local[1].id], String(local[0].id)).laps[0].compat;
  assert.ok(c.items.some((i) => i.key === 'game' && /0\.7\.0/.test(i.detail)));
  assert.ok(c.matched.includes('track temperature'));
});

test('compare: a lap of another car is incompatible (the page asks before showing it)', async () => {
  const src = db.getLap(local[2].id);
  const { data, ...meta } = src;
  const id = db.insertLap({ track: meta.track, layout: meta.layout, car: 'mock_gt4', lapNumber: 1, lapTimeMs: meta.lap_time_ms, valid: true,
    driver: 'Someone', source: 'import', recordedAt: Date.now(), trackLength: meta.track_length, data });
  svc.invalidate();
  const d = svc.compare([id], String(local[0].id));
  assert.equal(d.compat.level, 'incompatible');
  assert.ok(d.laps[0].compat.items.some((i) => i.key === 'car' && i.level === 'incompatible'));
  assert.ok(d.laps[0].trace, 'the data is still there for a deliberate look');
  db.deleteLap(id); svc.invalidate();
});

test('compare against the ideal lap: the reference provenance comes from the laps it is made of', () => {
  const d = svc.compare([local[3].id], 'ideal');
  assert.equal(d.ref.id, 'ideal');
  assert.ok(d.compat.parts >= 1);
  assert.notEqual(d.laps[0].compat.level, 'incompatible', 'same car and track');
});

test('consistency and progress name what varies between their laps', () => {
  const cons = svc.consistency(combo);
  assert.equal(cons.compat.level, 'caveats');
  assert.ok(cons.compat.items.some((i) => i.key === 'game'), 'two game versions recorded above');
  const prog = svc.progress(combo);
  assert.ok(prog.compat.items.length >= 1);
});
