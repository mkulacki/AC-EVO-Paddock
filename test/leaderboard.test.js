// Online leaderboard: the server (leaderboard/worker.js, run locally) with its Steam sign-in, and the app side
// (src/leaderboard.js). Steam itself is faked: nothing here goes to the internet.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { isolate } from './helpers.js';

isolate('leaderboard');
const { checkLap, appReturnOk } = await import('../leaderboard/worker.js');
const { serve } = await import('../leaderboard/local.mjs');
const db = await import('../src/db.js');
const settings = await import('../src/settings.js');
const lb = await import('../src/leaderboard.js');

// ---------------------------------------------------------------- a fake Steam
const STEAM_LOGIN = 'https://steamcommunity.com/openid/login';
const NAMES = { '76561198000000001': 'Alice', '76561198000000002': 'Bob <b>', '76561198000000003': 'Carol' };
const steamCalls = [];
async function fakeSteam(url, opts = {}) {
  steamCalls.push(String(url));
  if (url === STEAM_LOGIN && opts.method === 'POST') {
    const b = new URLSearchParams(opts.body);
    const ok = b.get('openid.mode') === 'check_authentication' && b.get('openid.sig') === 'good';
    return new Response(`ns:http://specs.openid.net/auth/2.0\nis_valid:${ok}\n`);
  }
  const m = /profiles\/(\d+)\/\?xml=1$/.exec(String(url));
  if (m) return new Response(`<?xml version="1.0"?><profile><steamID64>${m[1]}</steamID64><steamID><![CDATA[${NAMES[m[1]] ?? ''}]]></steamID></profile>`);
  throw new Error(`unexpected fetch ${url}`);
}

const server = await serve({ port: 0, file: ':memory:', fetchImpl: fakeSteam });
const URL0 = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

/** Follows a sign-in from its start address through the (fake) Steam page: the address the browser ends on. */
async function steamSignIn(startUrl, steamId, { sig = 'good', tamper = null } = {}) {
  const r1 = await fetch(startUrl, { redirect: 'manual' });
  assert.equal(r1.status, 302);
  const toSteam = new URL(r1.headers.get('location'));
  assert.equal(`${toSteam.origin}${toSteam.pathname}`, STEAM_LOGIN);
  const returnTo = toSteam.searchParams.get('openid.return_to');
  const back = new URL(tamper ? tamper(returnTo) : returnTo);
  const claimed = `https://steamcommunity.com/openid/id/${steamId}`;
  for (const [k, v] of Object.entries({ 'openid.ns': 'http://specs.openid.net/auth/2.0', 'openid.mode': 'id_res', 'openid.op_endpoint': STEAM_LOGIN,
    'openid.claimed_id': claimed, 'openid.identity': claimed, 'openid.return_to': returnTo, 'openid.response_nonce': '2026-11-23T10:00:00Zabc',
    'openid.assoc_handle': '1234567890', 'openid.signed': 'signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle', 'openid.sig': sig })) back.searchParams.set(k, v);
  const r2 = await fetch(back, { redirect: 'manual' });
  return { status: r2.status, location: r2.headers.get('location'), text: r2.status === 302 ? '' : await r2.text() };
}

const tokens = {};
async function tokenFor(steamId) {
  if (tokens[steamId]) return tokens[steamId];
  const state = crypto.randomBytes(16).toString('hex');
  const r = await steamSignIn(`${URL0}/v1/auth/steam?${new URLSearchParams({ return: 'http://127.0.0.1:9/cb', state })}`, steamId);
  const back = new URL(r.location);
  assert.equal(back.searchParams.get('state'), state);
  const t = await (await fetch(`${URL0}/v1/auth/token`, { method: 'POST', body: JSON.stringify({ code: back.searchParams.get('code') }) })).json();
  assert.equal(t.ok, true);
  return (tokens[steamId] = t.token);
}

const ALICE = '76561198000000001', BOB = '76561198000000002';
const NOW = Date.UTC(2026, 10, 23);
const lap = (o = {}) => ({ ref: '1', track: 'monza', layout: 'gp', car: 'huracan', valid: true,
  lapMs: 108000, sectors: [36000, 40000, 32000], airC: 24.3, roadC: 31.2, weather: 'Clear', grip: 'Optimum', game: '0.5.1', app: '0.6.0', drivenAt: NOW - 1000, ...o });
const postLap = async (l, who = ALICE) => (await fetch(`${URL0}/v1/laps`, { method: 'POST', headers: who ? { authorization: `Bearer ${await tokenFor(who)}` } : {}, body: JSON.stringify(l) })).json();
const board = async (q) => (await fetch(`${URL0}/v1/board?${new URLSearchParams({ track: 'monza', layout: 'gp', car: 'huracan', ...q })}`)).json();

test('checkLap: a good lap passes; bad ones say why', () => {
  assert.ok(checkLap(lap(), NOW).lap);
  assert.match(checkLap(lap({ valid: false }), NOW).error, /valid/);
  assert.match(checkLap(lap({ sectors: [36000, 40000, 30000] }), NOW).error, /add up/);
  assert.match(checkLap(lap({ lapMs: 5000, sectors: [5000] }), NOW).error, /range/);
  assert.match(checkLap(lap({ airC: 200 }), NOW).error, /temperature/);
  assert.match(checkLap(lap({ drivenAt: NOW + 5 * 86_400_000 }), NOW).error, /date/);
});

test('sign-in: only an address on this PC may receive a login', () => {
  assert.equal(appReturnOk('http://127.0.0.1:8080/api/board/callback'), true);
  assert.equal(appReturnOk('http://localhost:8080/x'), true);
  assert.equal(appReturnOk('https://evil.example/cb'), false);
  assert.equal(appReturnOk('http://127.0.0.1.evil.example/cb'), false);
  assert.equal(appReturnOk('http://user:pw@127.0.0.1/cb'), false);
  assert.equal(appReturnOk('javascript:alert(1)'), false);
});

test('sign-in: Steam must confirm the answer, and it must be meant for this server', async () => {
  const start = `${URL0}/v1/auth/steam?${new URLSearchParams({ return: 'http://127.0.0.1:9/cb', state: 'ab'.repeat(16) })}`;
  let r = await steamSignIn(start, ALICE, { sig: 'forged' });
  assert.equal(r.status, 400);
  assert.match(r.text, /did not confirm/);
  r = await steamSignIn(start, ALICE, { tamper: (u) => u.replace('127.0.0.1%3A9', '127.0.0.1%3A10') }); // another app address than Steam signed
  assert.equal(r.status, 400);
  assert.match(r.text, /not meant for this server/);
  const bad = await fetch(`${URL0}/v1/auth/steam?${new URLSearchParams({ return: 'https://evil.example/cb', state: 'ab'.repeat(16) })}`, { redirect: 'manual' });
  assert.equal(bad.status, 400);
});

test('sign-in: a code works once; the token says who you are; signing out ends it', async () => {
  const state = 'cd'.repeat(16);
  const r = await steamSignIn(`${URL0}/v1/auth/steam?${new URLSearchParams({ return: 'http://127.0.0.1:9/cb', state })}`, '76561198000000003');
  const code = new URL(r.location).searchParams.get('code');
  const t1 = await (await fetch(`${URL0}/v1/auth/token`, { method: 'POST', body: JSON.stringify({ code }) })).json();
  assert.deepEqual([t1.ok, t1.name, t1.steamId], [true, 'Carol', '76561198000000003']);
  const again = await fetch(`${URL0}/v1/auth/token`, { method: 'POST', body: JSON.stringify({ code }) });
  assert.equal(again.status, 401);
  const auth = { authorization: `Bearer ${t1.token}` };
  assert.equal((await (await fetch(`${URL0}/v1/me`, { headers: auth })).json()).name, 'Carol');
  await fetch(`${URL0}/v1/logout`, { method: 'POST', headers: auth });
  assert.equal((await fetch(`${URL0}/v1/me`, { headers: auth })).status, 401);
});

test('server: laps need a sign-in; each driver shows once with their best lap; filters by version and temperature', async () => {
  const anon = await postLap(lap(), null);
  assert.match(anon.error, /sign in/);
  assert.equal((await postLap(lap())).ok, true);
  const dup = await postLap(lap()); // the same lap again
  assert.equal(dup.stored, false);
  await postLap(lap({ ref: '2', lapMs: 107000, sectors: [35500, 39500, 32000], airC: 30 }));
  const r = await postLap(lap({ ref: '1', lapMs: 107500, sectors: [36000, 39500, 32000] }), BOB);
  assert.deepEqual([r.rank, r.of], [2, 2]);
  let b = await board({});
  assert.deepEqual(b.rows.map((x) => [x.name, x.lapMs]), [['Alice', 107000], ['Bob <b>', 107500]]); // Steam names (escaped by the page)
  assert.equal(b.rows[0].playerId, undefined);
  b = await board({ me: BOB });
  assert.deepEqual(b.rows.map((x) => x.me), [false, true]);
  b = await board({ airMax: '25' }); // Alice's 1:47.0 was at 30°: her 1:48.0 counts instead
  assert.deepEqual(b.rows.map((x) => [x.name, x.lapMs]), [['Bob <b>', 107500], ['Alice', 108000]]);
  b = await board({ game: '0.4.0' });
  assert.equal(b.rows.length, 0);
  const c = await (await fetch(`${URL0}/v1/combos`)).json();
  assert.deepEqual(c.combos.map((x) => [x.track, x.drivers, x.best]), [['monza', 2, 107000]]);
});

test('server: bad input is refused', async () => {
  const r = await fetch(`${URL0}/v1/laps`, { method: 'POST', headers: { authorization: `Bearer ${await tokenFor(ALICE)}` }, body: 'nope' });
  assert.equal(r.status, 400);
  assert.equal((await postLap(lap({ sectors: [1, 2] }))).ok, false);
  assert.equal((await fetch(`${URL0}/v1/laps`, { method: 'POST', headers: { authorization: `Bearer ${'0'.repeat(64)}` }, body: JSON.stringify(lap()) })).status, 401);
});

// ---------------------------------------------------------------- app side
// a straight lap of 1000 m at a constant speed, 100 s long
const lapData = () => { const t = [], d = []; for (let i = 0; i <= 1000; i++) { t.push(i * 100); d.push(i); } return { t, d }; };
const newLap = (lapTimeMs) => {
  const sessionId = db.createSession({ track: 'nowhere', layout: '', car: 'kart', sessionType: 1, driver: 'Me', startedAt: 1 });
  return db.insertLap({ sessionId, track: 'nowhere', layout: '', car: 'kart', lapNumber: 2, lapTimeMs, valid: true, driver: 'Me', recordedAt: Date.now(), trackLength: 1000, data: lapData() });
};

/** Signs the app in the way the browser would: start address -> Steam -> the app's callback. */
async function appSignIn(app, steamId) {
  const r = await steamSignIn(app.loginUrl('http://127.0.0.1:8080/api/board/callback'), steamId);
  const back = new URL(r.location);
  assert.equal(`${back.origin}${back.pathname}`, 'http://127.0.0.1:8080/api/board/callback');
  return app.finishLogin({ code: back.searchParams.get('code'), state: back.searchParams.get('state') });
}

test('lapSectors: thirds without track data, adding up to the lap time', () => {
  assert.deepEqual(lb.lapSectors({ track: 'nowhere', layout: '', track_length: 1000, lap_time_ms: 100000, data: lapData() }), [33333, 33334, 33333]);
});

test('safeUrl: the login only goes over https, or to a server on this PC', () => {
  assert.equal(lb.safeUrl('https://board.example.workers.dev'), true);
  assert.equal(lb.safeUrl('http://127.0.0.1:8787'), true);
  assert.equal(lb.safeUrl('http://board.example.com'), false);
});

test('app: a lap gets its conditions; it waits for the Steam sign-in, then the best one is sent once', async () => {
  settings.update({ boardShare: true, boardUrl: URL0, boardToken: '', boardSteam: null });
  const rec = new EventEmitter();
  const app = lb.createLeaderboard({ recorder: rec, launchInfo: () => ({ weather: 'Clear', grip: 'Fast' }), gameVersion: () => '0.5.1', appVersion: 'test' });
  for (let i = 0; i < 10; i++) app.onFrame({ status: 2, probe: { airTemp: 20 + (i % 2), roadTemp: 30 } });
  const id = newLap(100000);
  app.onLap({ id, valid: false }); // conditions only: no sync started from here in the test
  assert.deepEqual(JSON.parse(db.getLapMeta(id).cond), { airC: 20.5, roadC: 30, weather: 'Clear', grip: 'Fast', game: '0.5.1', app: 'test' });

  assert.equal((await app.sync()).reason, 'sign in with Steam first');
  assert.equal(db.getLapMeta(id).board, null);
  // a callback with a state this app did not make is refused
  assert.equal((await app.finishLogin({ code: 'a'.repeat(64), state: 'f'.repeat(32) })).ok, false);
  const s = await appSignIn(app, '76561198000000003');
  assert.deepEqual(s, { ok: true, name: 'Carol' });
  assert.equal(app.status().signedIn, true);
  assert.equal(settings.publicView().boardToken, undefined); // the token never reaches the page

  assert.deepEqual(await app.sync(), { sent: 1, failed: 0 });
  assert.equal(JSON.parse(db.getLapMeta(id).board).ok, true);
  assert.deepEqual(await app.sync(), { sent: 0, failed: 0 }); // already sent
  const t = await app.table({ track: 'nowhere', layout: '', car: 'kart' });
  assert.deepEqual([t.body.rows[0].name, t.body.rows[0].me], ['Carol', true]);
  assert.deepEqual(t.body.rows[0].sectors, [33333, 33334, 33333]);
});

test('app: with the server away the lap waits and is retried; a dead login asks for a new sign-in', async () => {
  settings.update({ boardUrl: 'http://127.0.0.1:1' });
  const app = lb.createLeaderboard({ recorder: null, gameVersion: () => '0.5.2', appVersion: 'test' });
  const id = newLap(101000);
  app.onLap({ id, valid: false });
  assert.equal((await app.sync()).failed, 1);
  assert.equal(JSON.parse(db.getLapMeta(id).board).retry, true);
  settings.update({ boardUrl: URL0 });
  const token = settings.get().boardToken;
  await fetch(`${URL0}/v1/logout`, { method: 'POST', headers: { authorization: `Bearer ${token}` } }); // ended elsewhere
  await app.sync();
  assert.equal(app.status().signedIn, false);
  await appSignIn(app, '76561198000000003');
  assert.equal((await app.sync()).sent, 1); // new game version: its own best
});

test('app: with automatic sending off, laps wait for Send now; signing out stops sending', async () => {
  settings.update({ boardUrl: URL0, boardAuto: false });
  const app = lb.createLeaderboard({ recorder: null, gameVersion: () => '0.5.3', appVersion: 'test' });
  const id = newLap(102000);
  app.onLap({ id, valid: false });
  assert.equal((await app.sync()).skipped, true);
  assert.equal(db.getLapMeta(id).board, null);
  assert.equal((await app.sync({ manual: true })).sent, 1);
  await app.logout();
  assert.equal(app.status().signedIn, false);
  assert.equal(settings.get().boardToken, '');
  settings.update({ boardAuto: true });
});

test('app: a lap sent anonymously (before sign-in existed) is sent again under the Steam account', async () => {
  settings.update({ boardUrl: URL0, boardAuto: true });
  const app = lb.createLeaderboard({ recorder: null, gameVersion: () => '0.5.4', appVersion: 'test' });
  const id = newLap(103000);
  app.onLap({ id, valid: false });
  db.setLapBoard(id, { at: 1, ok: true, rank: 1, of: 1 }); // the old anonymous send
  await appSignIn(app, '76561198000000003');
  assert.equal((await app.sync()).sent, 1);
  assert.equal(JSON.parse(db.getLapMeta(id).board).steamId, '76561198000000003');
  assert.equal((await app.sync()).sent, 0);
});
