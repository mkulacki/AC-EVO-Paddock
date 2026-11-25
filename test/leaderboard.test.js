// Online leaderboard: the server (leaderboard/worker.js, run locally) with its Steam sign-in, and the app side
// (src/leaderboard.js). Steam itself is faked: nothing here goes to the internet.
import { test, after, mock } from 'node:test';
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

const server = await serve({ port: 0, file: ':memory:', fetchImpl: fakeSteam, admins: '76561198000000001' }); // Alice is an admin
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
const lapData = (ms = 100000) => { const t = [], d = [], spd = []; for (let i = 0; i <= 1000; i++) { t.push((i * ms) / 1000); d.push(i); spd.push(36); } return { t, d, spd }; };
const newLap = (lapTimeMs) => {
  const sessionId = db.createSession({ track: 'nowhere', layout: '', car: 'kart', sessionType: 1, driver: 'Me', startedAt: 1 });
  const data = lapData(lapTimeMs);
  return db.insertLap({ sessionId, track: 'nowhere', layout: '', car: 'kart', lapNumber: 2, lapTimeMs, valid: true, driver: 'Me', recordedAt: Date.now(), trackLength: 1000, data });
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
  const app = lb.createLeaderboard({ background: false, recorder: rec, launchInfo: () => ({ weather: 'Clear', grip: 'Fast' }), gameVersion: () => '0.5.1', appVersion: 'test' });
  for (let i = 0; i < 10; i++) app.onFrame({ status: 2, probe: { airTemp: 20 + (i % 2), roadTemp: 30 } });
  const id = newLap(100000);
  app.onLap({ id, valid: false }); // conditions only: no sync started from here in the test
  assert.deepEqual(JSON.parse(db.getLapMeta(id).cond), { airC: 20.5, roadC: 30, weather: 'Clear', grip: 'Fast', game: '0.5.1', app: 'test', reader: 'shm r1' });

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
  const away = 'http://127.0.0.1:1', login = settings.get().boardSteam;
  settings.update({ boardUrl: away, boardSteam: { ...login, url: away } }); // signed in there, but it does not answer
  const app = lb.createLeaderboard({ background: false, recorder: null, gameVersion: () => '0.5.2', appVersion: 'test' });
  const id = newLap(101000);
  app.onLap({ id, valid: false });
  assert.equal((await app.sync()).failed, 1); // the first lap fails: the rest are not tried
  const b0 = db.getLapMeta(id).board;
  assert.ok(b0 == null || JSON.parse(b0).retry);
  settings.update({ boardUrl: URL0, boardSteam: login });
  const token = settings.get().boardToken;
  await fetch(`${URL0}/v1/logout`, { method: 'POST', headers: { authorization: `Bearer ${token}` } }); // ended elsewhere
  await app.sync();
  assert.equal(app.status().signedIn, false);
  await appSignIn(app, '76561198000000003');
  assert.ok((await app.sync()).sent >= 1); // new game version: its own best
  assert.equal(JSON.parse(db.getLapMeta(id).board).ok, true);
});

test('app: with automatic sending off, laps wait for Send now; signing out stops sending', async () => {
  settings.update({ boardUrl: URL0, boardAuto: false });
  const app = lb.createLeaderboard({ background: false, recorder: null, gameVersion: () => '0.5.3', appVersion: 'test' });
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
  const app = lb.createLeaderboard({ background: false, recorder: null, gameVersion: () => '0.5.4', appVersion: 'test' });
  const id = newLap(103000);
  app.onLap({ id, valid: false });
  db.setLapBoard(id, { at: 1, ok: true, rank: 1, of: 1 }); // the old anonymous send
  await appSignIn(app, '76561198000000003');
  assert.equal((await app.sync()).sent, 1);
  assert.equal(JSON.parse(db.getLapMeta(id).board).steamId, '76561198000000003');
  assert.equal((await app.sync()).sent, 0);
});

test('app: a login and a "sent" mark belong to one server', async () => {
  settings.update({ boardUrl: URL0, boardShare: true, boardAuto: true });
  const app = lb.createLeaderboard({ background: false, recorder: null, gameVersion: () => '0.5.5', appVersion: 'test' });
  const id = newLap(104000);
  app.onLap({ id, valid: false });
  await appSignIn(app, '76561198000000003');
  assert.equal((await app.sync()).sent, 1);
  // another address (the same server under another name here): not signed in there, and the lap is not sent there yet
  settings.update({ boardUrl: URL0.replace('127.0.0.1', 'localhost') });
  assert.equal(app.status().signedIn, false);
  assert.equal((await app.sync()).reason, 'sign in with Steam first');
  await appSignIn(app, '76561198000000003');
  assert.ok((await app.sync()).sent >= 1);
  assert.equal(JSON.parse(db.getLapMeta(id).board).url, URL0.replace('127.0.0.1', 'localhost'));
  settings.update({ boardUrl: URL0 });
});

// ---------------------------------------------------------------- classes, telemetry, profiles, targets, reports
const telc = await import('../src/telcodec.js');
const zlib = (await import('node:zlib')).default;

test('telemetry: encodes and decodes a lap within its resolution', () => {
  const n = 501, R = { n, step: 2, t: [], spd: [], thr: [], brk: [], str: [], gear: [], rpm: [], x: [], z: [] };
  for (let i = 0; i < n; i++) {
    R.t.push(i * 20.37); R.spd.push(120 + Math.sin(i / 9) * 40); R.thr.push((i % 50) / 50); R.brk.push(i % 70 < 8 ? 0.9 : 0);
    R.str.push(Math.sin(i / 30) * 0.2); R.gear.push(3 + (i % 3)); R.rpm.push(6000 + i); R.x.push(Math.cos(i / 80) * 400); R.z.push(Math.sin(i / 80) * 300 - 12.34);
  }
  const bytes = telc.encodeTel(R, 10185);
  assert.equal(bytes.length, telc.telBytes(n));
  const d = telc.decodeTel(telc.fromBase64(telc.toBase64(bytes)));
  assert.equal(d.n, n); assert.equal(d.lapMs, 10185); assert.equal(d.d[n - 1], 1000);
  for (const [c, tol] of [['t', 0.6], ['spd', 0.06], ['thr', 0.001], ['str', 0.0001], ['x', 0.006], ['z', 0.006]]) {
    for (let i = 0; i < n; i += 37) assert.ok(Math.abs(d[c][i] - R[c][i]) <= tol, `${c}[${i}] ${d[c][i]} vs ${R[c][i]}`);
  }
  assert.deepEqual([...telc.fromBase64(telc.toBase64(new Uint8Array([1, 2])))], [1, 2]);
  assert.equal(telc.decodeTel(new Uint8Array(10)), null);
});

test('classes: GT3 / GT4 / GT2 race cars; cups and road cars have none', () => {
  // without the game's car list the name decides
  assert.equal(lb.carClass('Ford Mustang GT3'), 'GT3');
  assert.equal(lb.carClass('Audi R8 LMS GT4 Evo'), 'GT4');
  assert.equal(lb.carClass('Maserati MC20 GT2'), 'GT2');
  assert.equal(lb.carClass('Porsche 992 GT3 Cup'), null);
  assert.equal(lb.carClass('Mazda MX5 ND Cup'), null);
});

const tokenOf = async (who) => `Bearer ${await tokenFor(who)}`;
const postAs = async (who, l) => (await fetch(`${URL0}/v1/laps`, { method: 'POST', headers: { authorization: await tokenOf(who) }, body: JSON.stringify(l) })).json();
const spaLap = (o) => ({ ref: o.ref, track: 'spa', layout: '', car: o.car, carClass: o.carClass ?? null, valid: true, lapMs: o.ms, sectors: [o.ms - 80000, 40000, 40000],
  airC: 20, roadC: 28, game: '0.9', drivenAt: NOW, tel: o.tel ?? null });

test('class boards: each driver once, with the car; a car keeps its first class', async () => {
  await postAs(ALICE, spaLap({ ref: 's1', car: 'Ford Mustang GT3', carClass: 'GT3', ms: 138500 }));
  await postAs(BOB, spaLap({ ref: 's1', car: 'BMW M4 GT3', carClass: 'GT3', ms: 138200 }));
  await postAs(BOB, spaLap({ ref: 's2', car: 'Ford Mustang GT3', carClass: 'GT4', ms: 139000 })); // a wrong class is not taken
  await postAs(ALICE, spaLap({ ref: 's3', car: 'Audi R8 LMS GT4 Evo', ms: 150000 })); // sent before classes existed
  await postAs(ALICE, spaLap({ ref: 's3', car: 'Audi R8 LMS GT4 Evo', carClass: 'GT4', ms: 150000 })); // the same lap again, now with its class
  assert.equal((await (await fetch(`${URL0}/v1/board?track=spa&layout=&class=GT4`)).json()).rows.length, 1);
  const b = await (await fetch(`${URL0}/v1/board?track=spa&layout=&class=GT3`)).json();
  assert.deepEqual(b.rows.map((r) => [r.name, r.car, r.lapMs]), [['Bob <b>', 'BMW M4 GT3', 138200], ['Alice', 'Ford Mustang GT3', 138500]]);
  const c = await (await fetch(`${URL0}/v1/combos`)).json();
  assert.deepEqual(c.classes.filter((x) => x.track === 'spa').map((x) => [x.car_class, x.drivers, x.cars]), [['GT3', 2, 2], ['GT4', 1, 1]]);
  assert.equal((await (await fetch(`${URL0}/v1/board?track=spa&layout=&class=GT9`)).json()).ok, false);
});

test('telemetry: stored with the lap, served to anyone; a broken one is left out but the lap counts', async () => {
  const R = { n: 401, step: 2, t: Array.from({ length: 401 }, (_, i) => i * 100), spd: Array(401).fill(72) };
  const good = telc.toBase64(zlib.gzipSync(telc.encodeTel(R, 40000)));
  let r = await postAs(ALICE, { ...spaLap({ ref: 'tel1', car: 'kart', ms: 40000 }), sectors: [10000, 15000, 15000], tel: good });
  assert.equal(r.telError, null);
  const t = await (await fetch(`${URL0}/v1/telemetry?lap=${r.lapId}`)).json();
  assert.equal(t.tel, good);
  assert.equal(t.name, 'Alice');
  const other = telc.toBase64(zlib.gzipSync(telc.encodeTel(R, 41000))); // says another lap time
  r = await postAs(ALICE, { ...spaLap({ ref: 'tel2', car: 'kart', ms: 40500 }), sectors: [10500, 15000, 15000], tel: other });
  assert.equal(r.ok, true);
  assert.match(r.telError, /another lap/);
  assert.equal((await fetch(`${URL0}/v1/telemetry?lap=${r.lapId}`)).status, 404);
});

test('driver profile: places, the driver ahead and the leader', async () => {
  const bob = await (await fetch(`${URL0}/v1/driver?id=${BOB}`)).json();
  const spa = bob.boards.find((x) => x.track === 'spa' && x.car === 'Ford Mustang GT3'); // Bob was slower in the Mustang
  assert.deepEqual([spa.rank, spa.of, spa.ahead.name, spa.leader.name, spa.carClass], [2, 2, 'Alice', 'Alice', 'GT3']);
  const p = await (await fetch(`${URL0}/v1/driver?id=${ALICE}`)).json();
  assert.deepEqual(p.boards.find((x) => x.track === 'spa' && x.car === 'Ford Mustang GT3').rank, 1);
  const monza = p.boards.find((x) => x.track === 'monza');
  assert.deepEqual([monza.rank, monza.ahead], [1, null]);
  assert.equal((await fetch(`${URL0}/v1/driver?id=76561198999999999`)).status, 404);
});

test('reports: signed in, not your own lap; admins see them and can hide the lap', async () => {
  const board0 = await (await fetch(`${URL0}/v1/board?track=spa&layout=&class=GT3`)).json();
  const bobLap = board0.rows[0].lapId;
  const rep = async (who, body) => fetch(`${URL0}/v1/report`, { method: 'POST', headers: { authorization: await tokenOf(who) }, body: JSON.stringify(body) });
  assert.equal((await rep(BOB, { lapId: bobLap, reason: 'mine' })).status, 400);
  assert.equal((await rep(ALICE, { lapId: bobLap, reason: '2 s faster than anyone' })).status, 200);
  assert.equal((await fetch(`${URL0}/v1/admin/reports`, { headers: { authorization: await tokenOf(BOB) } })).status, 403);
  const list = await (await fetch(`${URL0}/v1/admin/reports`, { headers: { authorization: await tokenOf(ALICE) } })).json();
  assert.deepEqual([list.laps[0].lapId, list.laps[0].reports, list.laps[0].reasons], [bobLap, 1, '2 s faster than anyone']);
  const hideAs = async (auth, h) => fetch(`${URL0}/v1/admin/hide`, { method: 'POST', headers: { authorization: auth }, body: JSON.stringify({ lapId: bobLap, hidden: h }) });
  assert.equal((await hideAs('X', true)).status, 403);
  await hideAs(await tokenOf(ALICE), true);
  let b = await (await fetch(`${URL0}/v1/board?track=spa&layout=&class=GT3`)).json();
  assert.deepEqual(b.rows.map((r) => [r.name, r.car]), [['Alice', 'Ford Mustang GT3'], ['Bob <b>', 'Ford Mustang GT3']]); // his other GT3 lap counts now
  await hideAs(await tokenOf(ALICE), false);
  b = await (await fetch(`${URL0}/v1/board?track=spa&layout=&class=GT3`)).json();
  assert.equal(b.rows.length, 2);
  const me = await (await fetch(`${URL0}/v1/me`, { headers: { authorization: await tokenOf(ALICE) } })).json();
  assert.equal(me.admin, true);
});

test('app: beaten notices, the HUD target, and downloading another driver lap', async () => {
  settings.update({ boardUrl: URL0, boardShare: true, boardAuto: true, boardTel: true, boardTarget: 'next' });
  const seen = [];
  const app = lb.createLeaderboard({ background: false, recorder: null, gameVersion: () => '0.9', appVersion: 'test', notify: (n) => seen.push(n) });
  await appSignIn(app, '76561198000000003'); // Carol
  const sessionId = db.createSession({ track: 'imola', layout: '', car: 'kart', sessionType: 1, driver: 'Me', startedAt: 1 });
  const id = db.insertLap({ sessionId, track: 'imola', layout: '', car: 'kart', lapNumber: 2, lapTimeMs: 100000, valid: true, driver: 'Me', recordedAt: Date.now(), trackLength: 1000,
    data: { ...lapData(100000), thr: Array(1001).fill(1) } });
  db.setLapCond(id, { airC: 20, roadC: 30, game: '0.9', app: 'test' });
  await app.sync();
  assert.equal(JSON.parse(db.getLapMeta(id).board).tel, true);
  await app.checkRanks(); // P1 of 1: remembered, nothing to say
  assert.equal(seen.length, 0);
  // Alice goes 0.5 s faster, Bob is slower
  await postAs(ALICE, { ref: 'im1', track: 'imola', layout: '', car: 'kart', valid: true, lapMs: 99500, sectors: [33000, 33000, 33500], drivenAt: NOW });
  await postAs(BOB, { ref: 'im1', track: 'imola', layout: '', car: 'kart', valid: true, lapMs: 101000, sectors: [33000, 34000, 34000], drivenAt: NOW });
  await app.checkRanks();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].title, 'Leaderboard: P1 → P2');
  assert.match(seen[0].body, /Alice is 0\.500 s faster/);
  assert.equal(app.status().notices[0].to, 2);

  // the HUD target: the driver just ahead (Alice), or P1; off = none
  const s = { track: 'imola', layout: '', car: 'kart' };
  await app.loadTarget(s);
  assert.deepEqual(app.target(s), { rank: 1, of: 3, name: 'Alice', lapMs: 99500, sectors: [33000, 33000, 33500] });
  settings.update({ boardTarget: 'off' });
  assert.equal(app.target(s), null);
  settings.update({ boardTarget: 'next' });

  // Carol's own lap went up with telemetry: download it as an online lap (once)
  const remote = JSON.parse(db.getLapMeta(id).board).remoteId;
  const local = await app.fetchOnline(remote);
  const got = db.getLap(local);
  assert.deepEqual([got.source, got.driver, got.lap_time_ms, got.track], ['online', 'Carol', 100000, 'imola']);
  assert.ok(Math.abs(got.data.t[got.data.t.length - 1] - 100000) < 1);
  assert.equal(got.data.thr[100], 1);
  assert.equal(await app.fetchOnline(remote), local);
  // an online lap is never sent back as your own
  assert.ok(!db.boardBests().some((l) => l.id === local));

  // the in-game board window: your row and the gaps to your time
  await app.loadTarget(s);
  assert.deepEqual(app.boardWindow(s), { of: 3, rows: [
    { rank: 1, name: 'Alice', lapMs: 99500, me: false, local: false, gapMs: -500 },
    { rank: 2, name: 'Carol', lapMs: 100000, me: true, local: false, gapMs: null },
    { rank: 3, name: 'Bob <b>', lapMs: 101000, me: false, local: false, gapMs: 1000 }] });
  // a faster lap driven but not sent yet: your place moves straight away, marked local
  const faster = db.insertLap({ sessionId, track: 'imola', layout: '', car: 'kart', lapNumber: 3, lapTimeMs: 99000, valid: true, driver: 'Me', recordedAt: Date.now(), trackLength: 1000,
    data: { ...lapData(99000), thr: Array(1001).fill(1) } });
  await app.loadTarget(s);
  assert.deepEqual(app.boardWindow(s).rows.map((r) => [r.rank, r.name, r.local, r.gapMs]), [[1, 'Carol', true, null], [2, 'Alice', false, 500], [3, 'Bob <b>', false, 2000]]);
  // sent: a place gained is kept as a notice (no desktop notice: you drove it)
  db.setLapCond(faster, { airC: 20, roadC: 30, game: '0.9', app: 'test' });
  await app.sync();
  await app.checkRanks();
  assert.equal(seen.length, 1);
  assert.deepEqual([app.status().notices[0].kind, app.status().notices[0].from, app.status().notices[0].to], ['gained', 2, 1]);
  assert.match(app.status().notices[0].text, /your 1:39\.000/);
});

test('downloading an online lap (PL1.2): a server that sends a gzip bomb or an incomplete lap is refused, nothing stored', async () => {
  const before = db.listLaps().length;
  const reply = (body) => async () => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  const bomb = telc.toBase64(new Uint8Array(zlib.gzipSync(Buffer.alloc(20 * 1024 * 1024))));
  const lap = { ok: true, track: 'imola', layout: '', car: 'kart', lapMs: 100000, name: 'X' };
  const app1 = lb.createLeaderboard({ background: false, recorder: null, appVersion: 'test', fetchImpl: reply({ ...lap, tel: bomb }) });
  await assert.rejects(app1.fetchOnline(990001), /too large/);
  const app2 = lb.createLeaderboard({ background: false, recorder: null, appVersion: 'test', fetchImpl: reply({ ok: true, tel: bomb }) });
  await assert.rejects(app2.fetchOnline(990002), /incomplete lap/);
  const app3 = lb.createLeaderboard({ background: false, recorder: null, appVersion: 'test', fetchImpl: reply({ ...lap, tel: 'AAAA' }) });
  await assert.rejects(app3.fetchOnline(990003), /cannot be read/);
  assert.equal(db.listLaps().length, before);
});

test('background work (PL2): a valid lap schedules a sync; stop() cancels everything still pending', async () => {
  const before = settings.get();
  const url = 'http://127.0.0.1:2';
  settings.update({ boardUrl: url, boardShare: true, boardAuto: true, boardToken: 'e'.repeat(64), boardSteam: { steamId: '76561198000000009', name: 'T', url } });
  const calls = [];
  const fetchImpl = async (u) => { calls.push(String(u)); return new Response(JSON.stringify({ ok: false, error: 'test' }), { status: 400 }); };
  const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    const on = lb.createLeaderboard({ recorder: null, appVersion: 'test', fetchImpl });
    on.onLap({ id: newLap(105000), valid: true, track: 'nowhere', layout: '', car: 'kart', lapTimeMs: 105000 });
    mock.timers.tick(1500);
    await flush();
    assert.ok(calls.some((u) => u.endsWith('/v1/laps')), 'the deferred sync ran');
    on.stop();
    calls.length = 0;
    const off = lb.createLeaderboard({ recorder: null, appVersion: 'test', fetchImpl });
    off.onLap({ id: newLap(106000), valid: true, track: 'nowhere', layout: '', car: 'kart', lapTimeMs: 106000 });
    off.stop();
    mock.timers.tick(60 * 60 * 1000);
    await flush();
    assert.deepEqual(calls, []); // nothing ran after stop(): no deferred sync, no start check, no periodic sync
  } finally {
    mock.timers.reset();
    settings.update({ boardUrl: before.boardUrl, boardShare: before.boardShare, boardAuto: before.boardAuto, boardToken: before.boardToken, boardSteam: before.boardSteam });
  }
});

test('background work (PL2 review): after stop() nothing new is scheduled, not by a sync in flight, a lap or a sign-in', async () => {
  const before = settings.get();
  const url = 'http://127.0.0.1:3';
  settings.update({ boardUrl: url, boardShare: true, boardAuto: true, boardToken: 'f'.repeat(64), boardSteam: { steamId: '76561198000000009', name: 'T', url } });
  const calls = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const fetchImpl = async (u) => {
    calls.push(String(u));
    if (String(u).endsWith('/v1/laps')) await gate; // the send is still on its way when stop() comes
    return new Response(JSON.stringify({ ok: true, rank: 1, of: 1 }), { status: 200 });
  };
  const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    const app = lb.createLeaderboard({ recorder: null, appVersion: 'test', gameVersion: () => '0.9.9', fetchImpl }); // its own best: a new game version
    const id = newLap(107000);
    app.onLap({ id, valid: false }); // conditions only
    const running = app.sync();
    await flush();
    assert.ok(calls.some((u) => u.endsWith('/v1/laps')), 'the send started');
    app.stop();
    release();
    assert.equal((await running).sent, 1); // the send in flight finishes...
    app.onLap({ id: newLap(108000), valid: true }); // ...but neither it nor a new lap schedules anything
    calls.length = 0;
    mock.timers.tick(60 * 60 * 1000);
    await flush();
    assert.deepEqual(calls, []);
  } finally {
    mock.timers.reset();
    settings.update({ boardUrl: before.boardUrl, boardShare: before.boardShare, boardAuto: before.boardAuto, boardToken: before.boardToken, boardSteam: before.boardSteam });
  }
});
