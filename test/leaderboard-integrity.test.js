// PL10 leaderboard integrity: the 0003 migration on an older database (legacy labels, canonical keys), evidence
// tiers whose labels match their evidence, anomaly flags with their evidence, the moderation trail, suspensions,
// a driver's own deletions, rate limits and body caps. The Worker runs locally (leaderboard/local.mjs) on a free
// port with an in-memory or scratch database; Steam is faked. Nothing here goes to the internet or the live board.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { isolate, ROOT } from './helpers.js';

const env = isolate('lb-integrity');
const worker = await import('../leaderboard/worker.js');
const { serve, localD1 } = await import('../leaderboard/local.mjs');
const telc = await import('../src/telcodec.js');
const { TIERS, ANOMALY, RATE, canonicalKey, canonicalClass, cleanReason } = worker;

// ---------------------------------------------------------------- a fake Steam, as in leaderboard.test.js
const STEAM_LOGIN = 'https://steamcommunity.com/openid/login';
async function fakeSteam(url, opts = {}) {
  if (url === STEAM_LOGIN && opts.method === 'POST') return new Response(`ns:http://specs.openid.net/auth/2.0\nis_valid:${new URLSearchParams(opts.body).get('openid.sig') === 'good'}\n`);
  const m = /profiles\/(\d+)\/\?xml=1$/.exec(String(url));
  if (m) return new Response(`<profile><steamID><![CDATA[Driver ${m[1].slice(-2)}]]></steamID></profile>`);
  throw new Error(`unexpected fetch ${url}`);
}
const ADMIN = '76561198000000001', D2 = '76561198000000002', D3 = '76561198000000003', D4 = '76561198000000004', D5 = '76561198000000005';
const BOARD_DB = path.join(env.dir, 'board.db'); // scratch file (test data dir), so the tests can look inside
const server = await serve({ port: 0, file: BOARD_DB, fetchImpl: fakeSteam, admins: ADMIN });
const URL0 = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

let ipN = 0;
const freshIp = () => `10.0.0.${++ipN}`; // each sign-in from its own address, so the per-IP limits stay out of the way
const tokens = {};
async function tokenFor(steamId) {
  if (tokens[steamId]) return tokens[steamId];
  const ip = freshIp(), state = crypto.randomBytes(16).toString('hex');
  const r1 = await fetch(`${URL0}/v1/auth/steam?${new URLSearchParams({ return: 'http://127.0.0.1:9/cb', state })}`, { redirect: 'manual' });
  const returnTo = new URL(r1.headers.get('location')).searchParams.get('openid.return_to');
  const back = new URL(returnTo), claimed = `https://steamcommunity.com/openid/id/${steamId}`;
  for (const [k, v] of Object.entries({ 'openid.ns': 'http://specs.openid.net/auth/2.0', 'openid.mode': 'id_res', 'openid.op_endpoint': STEAM_LOGIN,
    'openid.claimed_id': claimed, 'openid.identity': claimed, 'openid.return_to': returnTo, 'openid.sig': 'good' })) back.searchParams.set(k, v);
  const r2 = await fetch(back, { redirect: 'manual', headers: { 'cf-connecting-ip': ip } });
  const code = new URL(r2.headers.get('location')).searchParams.get('code');
  const t = await (await fetch(`${URL0}/v1/auth/token`, { method: 'POST', headers: { 'cf-connecting-ip': ip }, body: JSON.stringify({ code }) })).json();
  assert.equal(t.ok, true);
  return (tokens[steamId] = t.token);
}
const auth = async (who) => ({ authorization: `Bearer ${await tokenFor(who)}` });
const post = async (who, p, body) => fetch(`${URL0}${p}`, { method: 'POST', headers: who ? await auth(who) : {}, body: JSON.stringify(body) });
const get = async (who, p) => fetch(`${URL0}${p}`, { headers: who ? await auth(who) : {} });
const NOW = Date.now();
const lap = (o = {}) => ({ ref: 'r1', track: 'Monza', layout: 'GP', car: 'Huracan GT3', valid: true, lapMs: 108000, sectors: [36000, 40000, 32000],
  airC: 24, roadC: 31, game: '0.9', app: '0.8.0', drivenAt: NOW - 1000, ...o });
const send = async (who, o) => (await post(who, '/v1/laps', lap(o))).json();
const board = async (q) => (await fetch(`${URL0}/v1/board?${new URLSearchParams(q)}`)).json();
const telFor = (lapMs) => {
  const n = 401, R = { n, step: 2, t: Array.from({ length: n }, (_, i) => (i * lapMs) / (n - 1)), spd: Array(n).fill(72) };
  return telc.toBase64(zlib.gzipSync(telc.encodeTel(R, lapMs)));
};

// ---------------------------------------------------------------- migration
test('migration 0003: an older board keeps its laps, labelled legacy, with canonical keys; it can run again', async () => {
  const file = path.join(env.dir, 'old-board.db');
  // the live database as it is today: schema.sql + 0002, with laps from before PL10
  const raw = new DatabaseSync(file);
  raw.exec(fs.readFileSync(path.join(ROOT, 'leaderboard', 'schema.sql'), 'utf8'));
  raw.exec(fs.readFileSync(path.join(ROOT, 'leaderboard', 'migrations', '0002_classes_telemetry_reports.sql'), 'utf8'));
  const ins = raw.prepare(`INSERT INTO laps (player_id, player_name, ref, track, layout, car, lap_ms, sectors, driven_at, received_at, has_tel)
    VALUES (?, 'x', ?, ?, ?, ?, ?, '[1]', 1, 1, ?)`);
  ins.run(D2, 'a', 'Monza', 'GP', 'Huracan GT3', 108000, 1);
  ins.run(D3, 'b', 'monza', 'gp', 'huracan-gt3', 107000, 0);
  raw.prepare("INSERT INTO players (steam_id, name, updated_at) VALUES (?, 'P', 1234)").run(D2);
  raw.close();
  for (let run = 0; run < 2; run++) { // the local runner applies every migration at each start
    const d1 = localD1(file);
    const rows = (await d1.prepare('SELECT ref, tier, track_key, layout_key, car_key, flags FROM laps ORDER BY ref').all()).results;
    assert.deepEqual(rows.map((r) => [r.ref, r.tier, r.track_key, r.layout_key, r.car_key, r.flags]),
      [['a', 'legacy', 'monza', 'gp', 'huracan_gt3', null], ['b', 'legacy', 'monza', 'gp', 'huracan_gt3', null]]);
    assert.equal((await d1.prepare('SELECT first_seen FROM players').first()).first_seen, 1234);
    for (const t of ['moderation_log', 'suspensions', 'rate_limits']) assert.ok(await d1.prepare('SELECT name FROM sqlite_master WHERE name = ?').bind(t).first(), t);
    d1.close();
  }
  // the SQL key and the JavaScript key agree
  const d1 = localD1(':memory:');
  for (const s of ['Monza GP', 'monza-gp', 'Spa-Francorchamps 2024', 'A_b-C d', ' x ']) {
    const r = await d1.prepare("SELECT lower(replace(replace(trim(?), ' ', '_'), '-', '_')) AS k").bind(s).first();
    assert.equal(r.k, canonicalKey(s), s);
  }
  d1.close();
  // the file names a version and carries no statement the local runner would split wrongly
  const sql = fs.readFileSync(path.join(ROOT, 'leaderboard', 'migrations', '0003_integrity.sql'), 'utf8').replace(/--[^\n]*/g, '');
  assert.doesNotMatch(sql, /TRIGGER|DROP |DELETE FROM laps/i);
});

// ---------------------------------------------------------------- tiers and labels
test('tier labels say only what was checked: none claims a lap is genuine, verified or cheat-proof', () => {
  assert.deepEqual(Object.keys(TIERS), ['legacy', 'basic', 'telemetry', 'reviewed']);
  for (const [k, label] of Object.entries(TIERS)) assert.doesNotMatch(label, /verified|genuine|authentic|cheat|proof|legit/i, k);
  // the Leaderboards tab labels every tier, and its labels and tooltips make no such claim either
  const ui = fs.readFileSync(path.join(ROOT, 'public', 'leaderboard.js'), 'utf8');
  for (const k of Object.keys(TIERS)) assert.match(ui, new RegExp(`\\b${k}: \\[`), `the Leaderboards tab labels ${k}`);
  const uiLabels = /const TIER = \{([\s\S]*?)\n\};/.exec(ui)[1];
  assert.doesNotMatch(uiLabels, /verified|genuine|authentic|cheat|legit/i);
  assert.doesNotMatch(ui, /cheat-proof|anti-cheat|verified lap/i);
  assert.equal(canonicalClass('gt3'), 'GT3');
  assert.equal(canonicalClass('GT9'), null);
  assert.equal(cleanReason(' too\nfast\u0007 '), 'too fast');
  assert.equal(cleanReason('x'.repeat(500)).length, 200);
});

test('tiers: format checked without telemetry, telemetry consistent with it; a bad telemetry is flagged, not hidden', async () => {
  let r = await send(D2, { ref: 't1', track: 'Imola', car: 'Kart', lapMs: 40000, sectors: [10000, 15000, 15000] });
  assert.equal(r.tier, 'basic');
  // the same lap sent again with telemetry that passes: raised to telemetry consistent
  r = await send(D2, { ref: 't1', track: 'Imola', car: 'Kart', lapMs: 40000, sectors: [10000, 15000, 15000], tel: telFor(40000) });
  assert.deepEqual([r.stored, r.tier], [false, 'telemetry']);
  r = await send(D3, { ref: 't2', track: 'Imola', car: 'Kart', lapMs: 40500, sectors: [10500, 15000, 15000], tel: telFor(41000) });
  assert.deepEqual([r.ok, r.tier], [true, 'basic']);
  assert.match(r.telError, /another lap/);
  const rows = (await board({ track: 'imola', layout: 'gp', car: 'KART' })).rows; // canonical keys: case does not matter
  assert.deepEqual(rows.map((x) => [x.lapMs, x.tier, x.tel]), [[40000, 'telemetry', true], [40500, 'basic', false]]);
  assert.ok(rows.every((x) => !('flags' in x)), 'flags are for moderators only');
  const q = await (await get(ADMIN, '/v1/admin/reports')).json();
  const flagged = q.laps.find((x) => x.lapId === r.lapId);
  assert.deepEqual(flagged.flags.map((f) => f.code), ['tel_rejected']);
  assert.equal(flagged.reports, 0);
});

test('canonical keys: spellings that differ in case, spaces or dashes share one board; the class is canonical too', async () => {
  await send(D2, { ref: 'k1', track: 'Spa Francorchamps', layout: '', car: 'BMW M4 GT3', carClass: 'gt3', lapMs: 138000, sectors: [58000, 40000, 40000] });
  await send(D3, { ref: 'k1', track: 'spa-francorchamps', layout: '', car: 'bmw m4 gt3', lapMs: 138500, sectors: [58500, 40000, 40000] });
  const b = await board({ track: 'SPA_FRANCORCHAMPS', layout: '', car: 'BMW-M4-GT3' });
  assert.deepEqual(b.rows.map((x) => [x.driver, x.car]), [[D2, 'BMW M4 GT3'], [D3, 'bmw m4 gt3']]);
  assert.equal(b.rows[1].carClass, 'GT3', 'the car keeps the class it was first sent with');
  assert.equal((await board({ track: 'spa francorchamps', layout: '', class: 'gt3' })).rows.length, 2);
  const c = await (await fetch(`${URL0}/v1/combos`)).json();
  assert.equal(c.combos.filter((x) => /spa/i.test(x.track)).length, 1, 'one board, not two');
  const p = await (await fetch(`${URL0}/v1/driver?id=${D3}`)).json();
  assert.deepEqual(p.boards.filter((x) => /spa/i.test(x.track)).map((x) => [x.car, x.rank, x.of]), [['bmw m4 gt3', 2, 2]]);
});

// ---------------------------------------------------------------- anomalies
test('anomalies: a lap far ahead of three other drivers is flagged with its evidence, logged, and stays on the board', async () => {
  for (const [who, ms] of [[D2, 108000], [D3, 108300], [D4, 108600]]) await send(who, { ref: 'a1', track: 'Vallelunga', car: 'GT4 X', lapMs: ms, sectors: [36000, 40000, ms - 76000] });
  const r = await send(D5, { ref: 'a1', track: 'Vallelunga', car: 'GT4 X', lapMs: 104000, sectors: [33000, 40000, 31000] });
  assert.equal(r.rank, 1);
  const ev = await (await get(ADMIN, `/v1/admin/lap?id=${r.lapId}`)).json();
  const far = ev.lap.flags.find((f) => f.code === 'far_ahead');
  assert.deepEqual([far.boardBestMs, far.drivers, far.lapMs], [108000, 3, 104000]);
  assert.ok(far.pct > ANOMALY.farAheadPct);
  const sec = ev.lap.flags.find((f) => f.code === 'sector_ahead');
  assert.deepEqual([sec.sector, sec.boardBestMs], [1, 36000]);
  assert.equal(ev.lap.hidden, false, 'a flag hides nothing by itself');
  assert.deepEqual(ev.trail.map((t) => [t.actor, t.action]), [['system', 'flag']]);
  // a lap within the field is not flagged
  const ok = await send(D5, { ref: 'a2', track: 'Vallelunga', car: 'GT4 X', lapMs: 108100, sectors: [36000, 40000, 32100] });
  assert.deepEqual((await (await get(ADMIN, `/v1/admin/lap?id=${ok.lapId}`)).json()).lap.flags, []);
  // a lap "driven" well after it was received
  const late = await send(D4, { ref: 'a3', track: 'Nowhere', car: 'GT4 X', drivenAt: Date.now() + 3600_000 });
  assert.deepEqual((await (await get(ADMIN, `/v1/admin/lap?id=${late.lapId}`)).json()).lap.flags.map((f) => f.code), ['clock_ahead']);
});

// ---------------------------------------------------------------- moderation
test('moderation: moderators only; hide, show, review and unreview are each written to the trail with before and after', async () => {
  const r = await send(D2, { ref: 'm1', track: 'Laguna', car: 'Car M', lapMs: 90000, sectors: [30000, 30000, 30000] });
  for (const p of ['/v1/admin/lap?id=1', '/v1/admin/log', '/v1/admin/reports']) assert.equal((await get(D2, p)).status, 403, p);
  assert.equal((await post(D2, '/v1/admin/moderate', { lapId: r.lapId, action: 'hide' })).status, 403);
  assert.equal((await post(null, '/v1/admin/suspend', { driver: D3, suspended: true, reason: 'x' })).status, 403);
  const mod = async (action, reason) => (await post(ADMIN, '/v1/admin/moderate', { lapId: r.lapId, action, reason })).json();
  assert.deepEqual(await mod('hide', 'sector 2 impossible'), { ok: true, lapId: r.lapId, hidden: true, tier: 'basic' });
  assert.equal((await board({ track: 'laguna', layout: 'gp', car: 'car m' })).rows.length, 0);
  await mod('show', 'checked the telemetry');
  assert.equal((await mod('review', 'looked fine')).tier, 'reviewed');
  assert.equal((await board({ track: 'laguna', layout: 'gp', car: 'car m' })).rows[0].tier, 'reviewed');
  assert.equal((await mod('unreview', 'reviewed by mistake')).tier, 'basic', 'back to the tier it had before the review');
  assert.equal((await post(ADMIN, '/v1/admin/moderate', { lapId: r.lapId, action: 'delete' })).status, 400, 'moderators hide; they do not delete');
  // the older route still works and is logged too
  assert.equal((await post(ADMIN, '/v1/admin/hide', { lapId: r.lapId, hidden: true })).status, 200);
  const ev = await (await get(ADMIN, `/v1/admin/lap?id=${r.lapId}`)).json();
  assert.deepEqual(ev.trail.map((t) => [t.action, t.actor, t.reason]).reverse(), [
    ['hide', ADMIN, 'sector 2 impossible'], ['show', ADMIN, 'checked the telemetry'], ['review', ADMIN, 'looked fine'],
    ['unreview', ADMIN, 'reviewed by mistake'], ['hide', ADMIN, null]]);
  assert.deepEqual(ev.trail.at(-1).detail.before, { hidden: false, tier: 'basic' });
  assert.deepEqual(ev.trail.at(-1).detail.after, { hidden: true, tier: 'basic' });
  // the trail has no route that changes or removes an entry
  const log = await (await get(ADMIN, `/v1/admin/log?lap=${r.lapId}`)).json();
  assert.equal(log.entries.length, 5);
  for (const m of ['POST', 'PUT', 'DELETE']) assert.equal((await fetch(`${URL0}/v1/admin/log`, { method: m, headers: await auth(ADMIN) })).status, 404, m);
  const page2 = await (await get(ADMIN, `/v1/admin/log?limit=2&before=${log.entries[0].id}`)).json();
  assert.ok(page2.entries.length === 2 && page2.entries.every((e) => e.id < log.entries[0].id));
});

test('suspension: needs a reason; stops laps and reports; can hide the driver laps; logged; survives deleting the account', async () => {
  const D6 = '76561198000000006';
  const l = await send(D6, { ref: 's1', track: 'Suzuka', car: 'Car S' });
  assert.equal((await post(ADMIN, '/v1/admin/suspend', { driver: D6, suspended: true })).status, 400);
  assert.equal((await post(ADMIN, '/v1/admin/suspend', { driver: ADMIN, suspended: true, reason: 'x' })).status, 400);
  const s = await (await post(ADMIN, '/v1/admin/suspend', { driver: D6, suspended: true, reason: 'impossible laps', hideLaps: true })).json();
  assert.deepEqual([s.ok, s.lapsHidden], [true, 1]);
  assert.equal((await post(D6, '/v1/laps', lap({ ref: 's2', track: 'Suzuka', car: 'Car S' }))).status, 403);
  assert.equal((await post(D6, '/v1/report', { lapId: 1, reason: 'x' })).status, 403);
  assert.equal((await (await get(D6, '/v1/me')).json()).suspended, true);
  const ev = await (await get(ADMIN, `/v1/admin/lap?id=${l.lapId}`)).json();
  assert.equal(ev.driver.suspended.reason, 'impossible laps');
  // deleting the account does not lift it
  assert.equal((await post(D6, '/v1/me/delete', {})).status, 200);
  delete tokens[D6];
  assert.equal((await post(D6, '/v1/laps', lap({ ref: 's3', track: 'Suzuka', car: 'Car S' }))).status, 403);
  await post(ADMIN, '/v1/admin/suspend', { driver: D6, suspended: false, reason: 'appeal accepted' });
  assert.equal((await post(D6, '/v1/laps', lap({ ref: 's3', track: 'Suzuka', car: 'Car S' }))).status, 200);
  const trail = (await (await get(ADMIN, '/v1/admin/log?limit=500')).json()).entries.filter((e) => e.subject === D6).map((e) => e.action).reverse();
  assert.deepEqual(trail, ['suspend', 'account_delete', 'unsuspend']);
});

// ---------------------------------------------------------------- a driver's own data
test('deletion: a driver removes one own lap or the whole account; never another driver lap; the trail keeps that it happened', async () => {
  const D7 = '76561198000000007', D8 = '76561198000000008';
  const mine = await send(D7, { ref: 'd1', track: 'Brands', car: 'Car D', tel: telFor(108000) });
  const other = await send(D8, { ref: 'd1', track: 'Brands', car: 'Car D', lapMs: 109000, sectors: [36000, 40000, 33000] });
  await post(D8, '/v1/report', { lapId: mine.lapId, reason: 'too fast' });
  assert.equal((await post(D7, '/v1/laps/delete', { lapId: other.lapId })).status, 404);
  assert.equal((await post(null, '/v1/laps/delete', { lapId: mine.lapId })).status, 401);
  assert.equal((await post(D7, '/v1/laps/delete', { lapId: mine.lapId })).status, 200);
  assert.equal((await fetch(`${URL0}/v1/telemetry?lap=${mine.lapId}`)).status, 404);
  assert.deepEqual((await board({ track: 'brands', layout: 'gp', car: 'car d' })).rows.map((r) => r.driver), [D8]);
  const ev = await (await get(ADMIN, `/v1/admin/log?lap=${mine.lapId}`)).json();
  assert.deepEqual(ev.entries.map((e) => [e.action, e.actor]), [['self_delete', D7]]);
  // the whole account: laps, the reports made, sign-ins, the name
  await send(D7, { ref: 'd2', track: 'Brands', car: 'Car D', lapMs: 107000, sectors: [35000, 40000, 32000] });
  await post(D7, '/v1/report', { lapId: other.lapId, reason: 'hm' });
  const del = await (await post(D7, '/v1/me/delete', {})).json();
  assert.deepEqual([del.ok, del.laps], [true, 1]);
  assert.equal((await get(D7, '/v1/me')).status, 401, 'signed out everywhere');
  assert.equal((await fetch(`${URL0}/v1/driver?id=${D7}`)).status, 404);
  const q = await (await get(ADMIN, '/v1/admin/reports')).json();
  assert.equal(q.laps.find((x) => x.lapId === other.lapId)?.reports ?? 0, 0, 'their reports went too');
  delete tokens[D7];
});

// ---------------------------------------------------------------- abuse
test('abuse: token swaps and sign-in answers are limited per address; moderation per moderator; large bodies refused', async () => {
  const ip = { 'cf-connecting-ip': '192.0.2.77' };
  let last;
  for (let i = 0; i <= RATE.token; i++) last = await fetch(`${URL0}/v1/auth/token`, { method: 'POST', headers: ip, body: JSON.stringify({ code: '0'.repeat(64) }) });
  assert.equal(last.status, 429);
  assert.equal((await fetch(`${URL0}/v1/auth/token`, { method: 'POST', headers: { 'cf-connecting-ip': '192.0.2.78' }, body: JSON.stringify({ code: '0'.repeat(64) }) })).status, 401, 'another address is not affected');
  const big = await fetch(`${URL0}/v1/report`, { method: 'POST', headers: await auth(D2), body: JSON.stringify({ lapId: 1, reason: 'x'.repeat(10_000) }) });
  assert.equal(big.status, 413);
  const huge = await fetch(`${URL0}/v1/laps`, { method: 'POST', headers: await auth(D2), body: JSON.stringify(lap({ ref: 'big', pad: 'x'.repeat(300_000) })) });
  assert.equal(huge.status, 413);
  const keep = RATE.moderate;
  RATE.moderate = 2;
  try {
    const r = await send(D3, { ref: 'rl', track: 'Rate', car: 'Car R' });
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await post(ADMIN, '/v1/admin/moderate', { lapId: r.lapId, action: i % 2 ? 'show' : 'hide' })).status);
    assert.deepEqual(codes.slice(-1), [429]);
  } finally { RATE.moderate = keep; }
  // only a hash of the address is kept, never the address itself
  const look = new DatabaseSync(BOARD_DB, { readOnly: true });
  const buckets = look.prepare('SELECT bucket FROM rate_limits').all().map((r) => r.bucket);
  look.close();
  assert.ok(buckets.some((b) => /^token:[0-9a-f]{16}$/.test(b)));
  assert.ok(!buckets.some((b) => /192.0.2|10.0.0/.test(b)));
});

// ---------------------------------------------------------------- review fixes
test('review: 0004 fills keys of laps an older worker stored after 0003, any number of times; the worker heals them too', async () => {
  const file = path.join(env.dir, 'between.db');
  const d1 = localD1(file); // schema + every migration: 0003 applied
  d1.close();
  const raw = new DatabaseSync(file);
  // what the old worker writes on the migrated database: no keys, no tier
  raw.prepare(`INSERT INTO laps (player_id, player_name, ref, track, layout, car, lap_ms, sectors, driven_at, received_at)
    VALUES (?, 'x', 'old', 'Red Bull Ring', 'GP', 'Old-Car', 100000, '[100000]', 1, 1)`).run(D2);
  const sql = fs.readFileSync(path.join(ROOT, 'leaderboard', 'migrations', '0004_backfill_keys.sql'), 'utf8');
  assert.doesNotMatch(sql.replace(/--[^\n]*/g, ''), /ALTER|CREATE|DROP|DELETE/i, 'updates only');
  for (let i = 0; i < 3; i++) raw.exec(sql); // as D1 would run it: whole file, no statement skipped
  assert.deepEqual({ ...raw.prepare("SELECT track_key, layout_key, car_key, tier FROM laps WHERE ref = 'old'").get() },
    { track_key: 'red_bull_ring', layout_key: 'gp', car_key: 'old_car', tier: 'legacy' });
  // the worker's own healing, on the live test board
  const live = new DatabaseSync(BOARD_DB);
  live.prepare(`INSERT INTO laps (player_id, player_name, ref, track, layout, car, lap_ms, sectors, driven_at, received_at)
    VALUES (?, 'x', 'between', 'Heal Track', '', 'Heal Car', 90000, '[90000]', 1, 1)`).run(D3);
  live.close();
  assert.equal((await board({ track: 'heal track', layout: '', car: 'heal car' })).rows.length, 0, 'invisible without keys');
  // a bare D1-like handle (localD1 would run 0004 itself on opening)
  const sq = new DatabaseSync(BOARD_DB);
  const w = { prepare: (q) => ({ run: async () => ({ meta: { changes: Number(sq.prepare(q).run().changes) } }) }), close: () => sq.close() };
  assert.equal(await worker.healKeys(w, Date.now(), true), 1);
  assert.equal(await worker.healKeys(w, Date.now(), true), 0);
  w.close();
  const rows = (await board({ track: 'heal track', layout: '', car: 'heal car' })).rows;
  assert.deepEqual(rows.map((r) => [r.driver, r.tier]), [[D3, 'legacy']]);
  raw.close();
});

test('review: without RATE_SALT sign-in is refused (no reversible IP hashes); health says so; account deletion is limited', async () => {
  const bare = await serve({ port: 0, file: ':memory:', fetchImpl: fakeSteam, admins: ADMIN, rateSalt: '' });
  const u = `http://127.0.0.1:${bare.address().port}`;
  try {
    assert.equal((await (await fetch(`${u}/v1/health`)).json()).configured.rateSalt, false);
    assert.equal((await fetch(`${u}/v1/auth/token`, { method: 'POST', body: JSON.stringify({ code: '0'.repeat(64) }) })).status, 503);
  } finally { bare.close(); }
  assert.equal((await (await fetch(`${URL0}/v1/health`)).json()).configured.rateSalt, true);
  const keep = RATE.account;
  RATE.account = 0;
  try { assert.equal((await post(D4, '/v1/me/delete', {})).status, 429); } finally { RATE.account = keep; }
  // a suspended driver can report nothing either (report() checks it like submit())
  const D9 = '76561198000000009';
  await post(ADMIN, '/v1/admin/suspend', { driver: D9, suspended: true, reason: 'test' });
  assert.equal((await post(D9, '/v1/report', { lapId: 1, reason: 'x' })).status, 403);
  await post(ADMIN, '/v1/admin/suspend', { driver: D9, suspended: false, reason: 'test over' });
});
