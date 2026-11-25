// Version-aware telemetry checks (PL4.1, src/channels.js): a check counts only on the game version and with the reader
// it was made with; old boolean checks are migrated as records of an unknown version and do not count; a "does not
// match" stays; groups whose meaning depends on the car count per car. Scratch data dir, no game.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isolate, ROOT } from './helpers.js';

const { ACEVO_DATA } = isolate('channels-version');
// settings from Paddock 0.7: booleans per group, plus a damaged entry and an unknown group
fs.writeFileSync(path.join(ACEVO_DATA, 'settings.json'), JSON.stringify({ channelChecks: { tyres: true, brakes: false, suspension: 'yes', nope: true } }));
const channels = await import('../src/channels.js');
const settings = await import('../src/settings.js');
let game = '0.6.1', hud = '0.14.0';
channels.configure({ gameVersion: () => game, hudVersion: () => hud });
const saved = () => JSON.parse(fs.readFileSync(path.join(ACEVO_DATA, 'settings.json'), 'utf8')).channelChecks;
// the game version is read at most every 5 s: a new one is picked up by configuring again
const setGame = (v) => { game = v; channels.configure({ gameVersion: () => game, hudVersion: () => hud }); };

test('the shared-memory layout revision is in step with src/shm.js OFFSETS (bump PARSER_REV and OFFSETS_HASH together)', () => {
  const s = fs.readFileSync(path.join(ROOT, 'src/shm.js'), 'utf8');
  const block = s.slice(s.indexOf('export const OFFSETS = {'), s.indexOf('export const STATUS'));
  const hash = crypto.createHash('sha256').update(block.replace(/\/\/[^\n]*/g, '').replace(/\s+/g, '')).digest('hex').slice(0, 16);
  assert.equal(hash, channels.OFFSETS_HASH, 'OFFSETS changed: bump PARSER_REV (checks made with the old layout must be made again) and set OFFSETS_HASH');
});

test('old boolean checks: read as legacy records of an unknown game version, never counted as verified; wrong ones stay wrong', () => {
  const t = channels.evaluate('tyres');
  assert.equal(t.status, 'unverified');
  assert.equal(t.state, 'unverified');
  assert.equal(t.needsRecheck, true);
  assert.match(t.reason, /before Paddock recorded the game version/);
  const b = channels.evaluate('brakes');
  assert.equal(b.status, 'mismatch', 'a "does not match" is the cautious state: kept');
  assert.equal(b.state, 'unsupported');
  assert.equal(channels.usable('brakes'), false);
  assert.equal(channels.evaluate('suspension').record, null, 'a damaged entry is ignored');
  assert.ok(!('nope' in channels.records()), 'unknown groups are ignored');
});

test('migrate writes the old checks out as records once; nothing to do the second time', () => {
  assert.equal(channels.migrate(), true);
  const s = saved();
  assert.equal(s.tyres.ok, true); assert.equal(s.tyres.legacy, true); assert.equal(s.tyres.game, null);
  assert.equal(s.brakes.ok, false);
  assert.equal(channels.migrate(), false);
  assert.equal(channels.status('tyres'), 'unverified');
});

test('a new check records game version, reader, time, method; it counts while they stay the same', () => {
  const before = Date.now();
  assert.equal(channels.confirm('tyres', true), 'verified');
  const r = saved().tyres;
  assert.equal(r.game, '0.6.1'); assert.equal(r.adapter, `shm r${channels.PARSER_REV}`); assert.equal(r.method, channels.METHOD);
  assert.ok(r.at >= before); assert.equal(r.car, null, 'tyres do not depend on the car');
  assert.equal(r.legacy, undefined);
  const l = channels.list().find((g) => g.id === 'tyres');
  assert.equal(l.state, 'verified'); assert.equal(l.record.game, '0.6.1'); assert.match(l.reason, /AC EVO 0\.6\.1/);
});

test('after a game update a check no longer counts (needs checking again); back on the old version it counts again', () => {
  setGame('0.6.2');
  const e = channels.evaluate('tyres');
  assert.equal(e.status, 'unverified'); assert.equal(e.needsRecheck, true);
  assert.match(e.reason, /now 0\.6\.2: check it again/);
  assert.equal(channels.trusted('tyres'), false);
  assert.match(channels.forAi(['tyres']).tyres, /NOT confirmed/);
  setGame('0.6.1');
  assert.equal(channels.status('tyres'), 'verified');
});

test('an unknown game version now counts as not checked; "matches" is refused then with the reason, "does not match" is kept (review 3)', () => {
  setGame(null);
  assert.equal(channels.status('tyres'), 'unverified');
  assert.match(channels.evaluate('tyres').reason, /not known/);
  assert.throws(() => channels.confirm('brakes', true), (e) => e.code === 409 && /game version is not known yet/.test(e.message));
  assert.equal(saved().brakes.ok, false, 'nothing changed');
  assert.match(channels.list().find((g) => g.id === 'brakes').confirmBlock, /start AC EVO once/);
  assert.equal(channels.confirm('suspension', false), 'mismatch', 'the cautious answer is always recorded');
  setGame('0.6.1');
  assert.equal(channels.list().find((g) => g.id === 'brakes').confirmBlock, null);
  assert.equal(channels.status('tyres'), 'verified');
  // a record without a game version that is not a legacy one (made by an earlier PL4 build) says so plainly
  settings.update({ channelChecks: { ...channels.records(), conditions: { ok: true, game: null, adapter: 'shm r1', at: 1, method: channels.METHOD, car: null } } });
  assert.match(channels.evaluate('conditions').reason, /while the game version was not known/);
  assert.doesNotMatch(channels.evaluate('conditions').reason, /before Paddock recorded/);
  channels.confirm('suspension', null); channels.confirm('conditions', null);
});

test('a HUD reading cannot be confirmed while no HUD is installed (review 3)', () => {
  hud = null;
  assert.throws(() => channels.confirm('aids', true), /Paddock HUD is not installed/);
  hud = '0.14.0';
});

test('channelChecks keys of groups this Paddock does not know are kept on every write (review 6)', () => {
  settings.update({ channelChecks: { ...channels.records(), futureGroup: { ok: true, game: '9.9', extra: 1 } } });
  channels.confirm('tyres', true);
  assert.deepEqual(saved().futureGroup, { ok: true, game: '9.9', extra: 1 });
  assert.equal(channels.migrate(), false, 'an unknown key is not an old check');
  settings.update({ channelChecks: { ...saved(), oldFuture: true, tyres: true } });
  assert.equal(channels.migrate(), true);
  assert.equal(saved().oldFuture, true, 'kept as it was'); assert.equal(saved().tyres.legacy, true);
  assert.ok(!('futureGroup' in channels.records()));
  channels.confirm('tyres', true);
});

test('a reader change (HUD update for aids, layout revision for shared memory) needs a new check', () => {
  channels.confirm('assists', true);
  assert.equal(saved().assists.adapter, 'hud 0.14.0');
  assert.equal(channels.status('assists'), 'verified');
  hud = '0.15.0';
  const e = channels.evaluate('assists');
  assert.equal(e.status, 'unverified'); assert.match(e.reason, /hud 0\.15\.0/);
  hud = null;
  assert.equal(channels.status('assists'), 'unverified', 'no HUD installed: not known');
  hud = '0.14.0';
  assert.equal(channels.status('assists'), 'verified');
  // a check made with another shared-memory layout revision
  settings.update({ channelChecks: { ...channels.records(), conditions: { ok: true, game: '0.6.1', adapter: 'shm r0', at: 1, method: 'in-game comparison', car: null } } });
  assert.equal(channels.status('conditions'), 'unverified');
  assert.match(channels.evaluate('conditions').reason, /shm r0/);
});

test('per-car groups: a check counts for the car it was made with only', () => {
  channels.confirm('suspension', true, { car: 'ks_porsche_992_gt3_r' });
  assert.equal(saved().suspension.car, 'ks_porsche_992_gt3_r');
  assert.equal(channels.status('suspension', { car: 'ks_porsche_992_gt3_r' }), 'verified');
  assert.equal(channels.status('suspension', { car: 'ks_bmw_m4_gt3' }), 'unverified');
  assert.match(channels.evaluate('suspension', { car: 'ks_bmw_m4_gt3' }).reason, /depends on the car/);
  assert.equal(channels.status('suspension'), 'verified', 'without a car: the check itself');
  channels.confirm('suspension', true); // not in a session: no car
  assert.equal(channels.status('suspension', { car: 'ks_bmw_m4_gt3' }), 'unverified');
  assert.equal(channels.status('tyres', { car: 'ks_bmw_m4_gt3' }), 'verified', 'tyres count for every car');
});

test('a "does not match" stays on any version, flagged for a new look; undo forgets it', () => {
  channels.confirm('brakes', false);
  setGame('0.7.0');
  const e = channels.evaluate('brakes');
  assert.equal(e.status, 'mismatch'); assert.equal(e.needsRecheck, true); assert.match(e.reason, /Undo it/);
  setGame('0.6.1');
  channels.confirm('brakes', null);
  assert.equal(channels.evaluate('brakes').record, null);
});

test('records with values of the wrong kind are cleaned, never trusted', () => {
  settings.update({ channelChecks: { tyres: { ok: 'true', game: '0.6.1' }, brakes: { ok: true, game: 42, adapter: 'shm r1', at: 'x' }, conditions: [] } });
  assert.equal(channels.evaluate('tyres').record, null);
  const b = channels.evaluate('brakes');
  assert.equal(b.record.game, null); assert.equal(b.record.at, null); assert.equal(b.status, 'unverified');
  assert.equal(channels.evaluate('conditions').record, null);
  assert.deepEqual(channels.context(), { game: '0.6.1', parser: `shm r${channels.PARSER_REV}`, hud: 'hud 0.14.0' });
});
