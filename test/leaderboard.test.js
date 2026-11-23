// Online leaderboard v1: the server (leaderboard/worker.js, run locally) and the app side (src/leaderboard.js).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { isolate } from './helpers.js';

isolate('leaderboard');
const { checkLap } = await import('../leaderboard/worker.js');
const { serve } = await import('../leaderboard/local.mjs');
const db = await import('../src/db.js');
const settings = await import('../src/settings.js');
const lb = await import('../src/leaderboard.js');

const server = await serve({ port: 0, file: ':memory:' });
const URL0 = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const NOW = Date.UTC(2026, 10, 23);
const lap = (o = {}) => ({ player: { id: 'player-aaaa', name: 'Alice' }, ref: '1', track: 'monza', layout: 'gp', car: 'huracan', valid: true,
  lapMs: 108000, sectors: [36000, 40000, 32000], airC: 24.3, roadC: 31.2, weather: 'Clear', grip: 'Optimum', game: '0.5.1', app: '0.6.0', drivenAt: NOW - 1000, ...o });
const postLap = async (l) => (await fetch(`${URL0}/v1/laps`, { method: 'POST', body: JSON.stringify(l) })).json();
const board = async (q) => (await fetch(`${URL0}/v1/board?${new URLSearchParams({ track: 'monza', layout: 'gp', car: 'huracan', ...q })}`)).json();

test('checkLap: a good lap passes; bad ones say why', () => {
  assert.ok(checkLap(lap(), NOW).lap);
  assert.match(checkLap(lap({ valid: false }), NOW).error, /valid/);
  assert.match(checkLap(lap({ sectors: [36000, 40000, 30000] }), NOW).error, /add up/);
  assert.match(checkLap(lap({ lapMs: 5000, sectors: [5000] }), NOW).error, /range/);
  assert.match(checkLap(lap({ player: { id: 'x', name: 'A' } }), NOW).error, /player id/);
  assert.match(checkLap(lap({ player: { id: 'player-aaaa', name: '' } }), NOW).error, /driver name/);
  assert.match(checkLap(lap({ airC: 200 }), NOW).error, /temperature/);
  assert.match(checkLap(lap({ drivenAt: NOW + 5 * 86_400_000 }), NOW).error, /date/);
});

test('server: each driver shows once with their best lap; filters by version and temperature', async () => {
  assert.equal((await postLap(lap())).ok, true);
  const dup = await postLap(lap()); // the same lap again
  assert.equal(dup.stored, false);
  await postLap(lap({ ref: '2', lapMs: 107000, sectors: [35500, 39500, 32000], airC: 30 }));
  const r = await postLap(lap({ player: { id: 'player-bbbb', name: 'Bob' }, ref: '1', lapMs: 107500, sectors: [36000, 39500, 32000] }));
  assert.deepEqual([r.rank, r.of], [2, 2]);
  let b = await board({});
  assert.deepEqual(b.rows.map((x) => [x.name, x.lapMs]), [['Alice', 107000], ['Bob', 107500]]);
  assert.equal(b.rows[0].playerId, undefined); // ids are never sent out
  b = await board({ me: 'player-bbbb' });
  assert.deepEqual(b.rows.map((x) => x.me), [false, true]);
  b = await board({ airMax: '25' }); // Alice's 1:47.0 was at 30°: her 1:48.0 counts instead
  assert.deepEqual(b.rows.map((x) => [x.name, x.lapMs]), [['Bob', 107500], ['Alice', 108000]]);
  b = await board({ game: '0.4.0' });
  assert.equal(b.rows.length, 0);
  const c = await (await fetch(`${URL0}/v1/combos`)).json();
  assert.deepEqual(c.combos.map((x) => [x.track, x.drivers, x.best]), [['monza', 2, 107000]]);
});

test('server: bad input is refused', async () => {
  const r = await fetch(`${URL0}/v1/laps`, { method: 'POST', body: 'nope' });
  assert.equal(r.status, 400);
  assert.equal((await postLap(lap({ sectors: [1, 2] }))).ok, false);
});

// a straight lap of 1000 m at a constant speed, 100 s long
const lapData = () => { const t = [], d = []; for (let i = 0; i <= 1000; i++) { t.push(i * 100); d.push(i); } return { t, d }; };

test('lapSectors: thirds without track data, adding up to the lap time', () => {
  const s = lb.lapSectors({ track: 'nowhere', layout: '', track_length: 1000, lap_time_ms: 100000, data: lapData() });
  assert.deepEqual(s, [33333, 33334, 33333]);
});

test('app: a lap gets its conditions; with sharing on, the best one is sent once', async () => {
  settings.update({ boardShare: true, boardUrl: URL0, driverName: 'Carol' });
  const rec = new EventEmitter();
  const app = lb.createLeaderboard({ recorder: rec, launchInfo: () => ({ weather: 'Clear', grip: 'Fast' }), gameVersion: () => '0.5.1', appVersion: 'test' });
  for (let i = 0; i < 10; i++) app.onFrame({ status: 2, probe: { airTemp: 20 + (i % 2), roadTemp: 30 } });
  const sessionId = db.createSession({ track: 'nowhere', layout: '', car: 'kart', sessionType: 1, driver: 'Carol', startedAt: 1 });
  const id = db.insertLap({ sessionId, track: 'nowhere', layout: '', car: 'kart', lapNumber: 2, lapTimeMs: 100000, valid: true, driver: 'Carol',
    recordedAt: Date.now(), trackLength: 1000, data: lapData() });
  app.onLap({ id, valid: false }); // conditions only: no sync started from here in the test
  const cond = JSON.parse(db.getLapMeta(id).cond);
  assert.deepEqual(cond, { airC: 20.5, roadC: 30, weather: 'Clear', grip: 'Fast', game: '0.5.1', app: 'test' });

  const r = await app.sync();
  assert.deepEqual(r, { sent: 1, failed: 0 });
  assert.equal(JSON.parse(db.getLapMeta(id).board).ok, true);
  assert.deepEqual(await app.sync(), { sent: 0, failed: 0 }); // already sent
  const t = await app.table({ track: 'nowhere', layout: '', car: 'kart' });
  assert.equal(t.body.rows[0].name, 'Carol');
  assert.equal(t.body.rows[0].me, true);
  assert.deepEqual(t.body.rows[0].sectors, [33333, 33334, 33333]);
  assert.equal(app.status().bests.length, 1);
});

test('app: with the server away the lap waits and is retried', async () => {
  settings.update({ boardUrl: 'http://127.0.0.1:1' });
  const app = lb.createLeaderboard({ recorder: null, gameVersion: () => '0.5.2', appVersion: 'test' });
  const sessionId = db.createSession({ track: 'nowhere', layout: '', car: 'kart', sessionType: 1, driver: 'Carol', startedAt: 1 });
  const id = db.insertLap({ sessionId, track: 'nowhere', layout: '', car: 'kart', lapNumber: 2, lapTimeMs: 101000, valid: true, driver: 'Carol',
    recordedAt: Date.now(), trackLength: 1000, data: lapData() });
  app.onLap({ id, valid: false });
  const r = await app.sync();
  assert.equal(r.failed, 1);
  assert.equal(JSON.parse(db.getLapMeta(id).board).retry, true);
  settings.update({ boardUrl: URL0 });
  assert.equal((await app.sync()).sent, 1); // new game version: its own best
});

test('app: with automatic sending off, laps wait for Send now', async () => {
  settings.update({ boardUrl: URL0, boardAuto: false });
  const app = lb.createLeaderboard({ recorder: null, gameVersion: () => '0.5.3', appVersion: 'test' });
  const sessionId = db.createSession({ track: 'nowhere', layout: '', car: 'kart', sessionType: 1, driver: 'Carol', startedAt: 1 });
  const id = db.insertLap({ sessionId, track: 'nowhere', layout: '', car: 'kart', lapNumber: 2, lapTimeMs: 102000, valid: true, driver: 'Carol',
    recordedAt: Date.now(), trackLength: 1000, data: lapData() });
  app.onLap({ id, valid: false });
  assert.equal((await app.sync()).skipped, true);
  assert.equal(db.getLapMeta(id).board, null);
  assert.equal((await app.sync({ manual: true })).sent, 1);
  assert.equal(app.status().auto, false);
  settings.update({ boardAuto: true });
});
