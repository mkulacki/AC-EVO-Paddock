// API smoke test: the real server (src/server.js --mock) on a free port, with seeded laps in a temporary data dir.
// Every read-only route must answer 200 with valid JSON. No POST routes: several of them start the game.
// Both child processes get a seeded Math.random (preload-seed.js) and the mock car runs at real speed, so the
// data is the same on every run and no new lap is saved while the tests run.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { spawn, execFileSync } from 'node:child_process';
import { isolate, ROOT } from './helpers.js';

const env = isolate('smoke');
const childEnv = { ...process.env, ...env, PADDOCK_TEST_SEED: '7' };
delete childEnv.ELECTRON_RUN_AS_NODE;
const node = (...args) => ['--no-warnings', '--import', pathToFileURL(path.join(ROOT, 'test/preload-seed.js')).href, ...args];
const FAKE_KEY = 'test-only-not-a-real-gemini-key-0123456789'; // must not match the release secret scan (CLAUDE.md step 3)

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
let server, base, port, log = '';

before(async () => {
  fs.writeFileSync(path.join(env.ACEVO_DATA, 'settings.json'), JSON.stringify({ geminiApiKey: FAKE_KEY, driverName: 'Test Driver' }));
  execFileSync(process.execPath, node(path.join(ROOT, 'src/mock.js'), '--seed', '6'), { env: childEnv, cwd: ROOT, stdio: 'ignore' });
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, node(path.join(ROOT, 'src/server.js'), '--mock', '1'), { env: { ...childEnv, PORT: String(port) }, cwd: ROOT });
  // ready = this server says it listens on our port (not just any process answering on it)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${log}`)), 20000);
    const onData = (b) => { log += b; if (log.includes(`running: http://localhost:${port}`)) { clearTimeout(timer); resolve(); } };
    server.stdout.on('data', onData);
    server.stderr.on('data', (b) => { log += b; });
    server.once('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited (${code}):\n${log}`)); });
  });
});
after(async () => {
  if (!server || server.exitCode != null) return;
  const gone = new Promise((r) => server.once('exit', r));
  server.kill();
  await gone;
});

const get = async (p) => {
  const r = await fetch(base + p);
  const text = await r.text();
  assert.equal(r.status, 200, `${p} → ${r.status}: ${text.slice(0, 200)}`);
  return text;
};
const json = async (p) => JSON.parse(await get(p));

test('the page loads with its title', async () => {
  assert.match(await get('/'), /<title>AC EVO Paddock<\/title>/);
  for (const m of ['app', 'palette', 'sessions', 'compare', 'game', 'settingspage', 'system', 'util']) await get(`/${m}.js`);
  await get('/style.css');
  await get('/vendor/uplot/uPlot.iife.min.js');
});

test('read-only API routes answer', async () => {
  const o = await json('/api/overview');
  assert.ok(o.laps.length >= 6);
  const c = o.combos[0];
  const q = new URLSearchParams({ track: c.track, layout: c.layout, car: c.car });
  const sid = o.sessions[0].id;
  for (const p of ['/api/status', '/api/settings', '/api/reports', '/api/game', '/api/race/status', '/api/hud', '/api/setups/meta',
    `/api/consistency?${q}`, `/api/progress?${q}`, `/api/compare?laps=${c.bestLapId}&ref=ideal`, `/api/report?session=${sid}`,
    `/api/carreport?session=${sid}`, `/api/ai/summary?lap=${c.bestLapId}&ref=ideal`]) await json(p);
});

test('the Gemini key is never sent to the page, only masked', async () => {
  const s = await json('/api/settings');
  assert.equal(s.geminiApiKey, '••••' + FAKE_KEY.slice(-4));
  for (const p of ['/api/settings', '/api/status', '/api/game', '/api/overview']) assert.ok(!(await get(p)).includes(FAKE_KEY), `${p} leaks the key`);
});

test('telemetry checks: list, confirm a group, refuse unknown ones, not settable through /api/settings', async () => {
  const list = await json('/api/channels');
  assert.equal(list.find((g) => g.id === 'tyres').status, 'unverified');
  const send = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let r = await send('/api/setupcheck/confirm', { group: 'tyres', ok: true });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).channels.find((g) => g.id === 'tyres').status, 'verified');
  assert.equal((await send('/api/setupcheck/confirm', { group: 'slip', ok: true })).status, 400);
  await send('/api/settings', { channelChecks: { brakes: true } });
  assert.equal((await json('/api/channels')).find((g) => g.id === 'brakes').status, 'unverified');
  await send('/api/setupcheck/confirm', { group: 'tyres', ok: null });
  assert.equal((await send('/api/setupcheck/confirm', { group: 'tyres', ok: 'yes' })).status, 400, 'ok must be a boolean or null');
  // an old client (no group): the pit-box readings and temperatures, as before
  r = await send('/api/setupcheck/confirm', { ok: true });
  const st = Object.fromEntries((await r.json()).channels.map((g) => [g.id, g.status]));
  assert.equal(st.setupProbe, 'verified'); assert.equal(st.conditions, 'verified'); assert.equal(st.tyres, 'unverified');
  await send('/api/setupcheck/confirm', { ok: null });
});

test('saved AI answers come back with their confidence split off (no Gemini call)', async () => {
  const o = await json('/api/overview');
  const sid = o.sessions.find((s) => o.laps.some((l) => l.session_id === s.id)).id;
  const rep = await json(`/api/report?session=${sid}`); // makes the report
  assert.equal(rep.ai, null);
  assert.equal(typeof rep.channels, 'object');
  const dbf = new DatabaseSync(path.join(env.ACEVO_DATA, 'telemetry.db'));
  dbf.prepare('UPDATE reports SET ai_text = ?, ai_model = ?, ai_at = ? WHERE session_id = ?').run('Good session.\nConfidence: medium - 6 laps', 'stub', Date.now(), sid);
  // a saved coach answer for a lap against the best lap (the key the server uses: "<ref id>:<ref time>")
  const valid = o.laps.filter((l) => l.valid && l.session_id === sid).sort((a, b) => a.lap_time_ms - b.lap_time_ms);
  const [best, other] = valid;
  dbf.prepare('INSERT INTO analyses (lap_id, ref_key, model, created_at, text) VALUES (?,?,?,?,?)').run(other.id, `${best.id}:${best.lap_time_ms}`, 'stub', Date.now(), 'Brake later.\n**Confidence:** low - one lap');
  dbf.close();
  const rep2 = await json(`/api/report?session=${sid}`);
  assert.equal(rep2.ai.text, 'Good session.');
  assert.deepEqual(rep2.ai.confidence, { level: 'medium', basis: '6 laps' });
  const r = await fetch(base + '/api/ai/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lap: other.id, ref: 'best' }) });
  assert.equal(r.status, 200);
  const a = await r.json();
  assert.equal(a.cached, true, 'served from the database, Gemini not called');
  assert.equal(a.text, 'Brake later.');
  assert.deepEqual(a.confidence, { level: 'low', basis: 'one lap' });
});

test('application management routes: export, diagnostics without private data, updates without network, backups refused on track', async () => {
  const csv = await get('/api/export/laps.csv');
  assert.match(csv, /^﻿?lap_id,session_id/);
  const diag = await json('/api/diagnostics?format=text');
  assert.ok(!diag.text.includes(FAKE_KEY) && !diag.text.includes('Test Driver'), 'diagnostics leak private data');
  assert.equal((await json('/api/diagnostics')).settings.geminiKey, 'set');
  const u = await json('/api/updates');
  assert.equal(typeof u.current, 'string');
  const c = await (await fetch(base + '/api/updates/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
  assert.match(c.error, /mock/, 'no network call from a mock run');
  assert.deepEqual((await json('/api/backup')).backups, []);
  // the mock car is on track: a backup would stall the recording
  const b = await fetch(base + '/api/backup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(b.status, 409);
  assert.equal((await fetch(base + '/api/backup/file?name=..%2fsettings.json')).status, 400);
});

test('only Paddock pages may use the API: foreign origins, cross-site requests and other host names are refused', async () => {
  const send = (headers, method = 'POST', p = '/api/backup/restore') => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { 'content-type': 'text/plain', ...headers } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    r.on('error', reject); r.end(method === 'POST' ? '{"name":"x.zip"}' : undefined);
  });
  assert.equal(await send({ origin: 'https://evil.example' }), 403);
  assert.equal(await send({ origin: `http://127.0.0.1:${port + 1}` }), 403, 'another local port is another site');
  assert.equal(await send({ origin: 'null' }), 403);
  assert.equal(await send({ 'sec-fetch-site': 'cross-site' }), 403);
  assert.equal(await send({ host: `evil.example:${port}` }, 'GET', '/api/diagnostics'), 403, 'DNS rebinding');
  assert.equal(await send({ host: `evil.example:${port}` }, 'GET', '/api/backup/file?name=x.zip'), 403);
  // Paddock's own page: allowed (the restore itself then fails: on track / no such backup)
  assert.notEqual(await send({ origin: `http://127.0.0.1:${port}` }), 403);
  assert.notEqual(await send({ origin: `http://localhost:${port}`, host: `localhost:${port}` }), 403);
});

// raw request: fetch/URL would clean up "../" before sending it
const raw = (p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p }, (r) => { let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => resolve({ status: r.statusCode, body: b })); }).on('error', reject);
});

// Behaviour check: no file outside public/ is served. (The server's new URL() parsing already resolves these paths,
// so this passes even without the startsWith(public) guard in server.js, which is a second line of defence.)
test('unknown files and paths outside public/ are refused', async () => {
  assert.notEqual((await raw('/nope.html')).status, 200);
  for (const p of ['/../package.json', '/..\\package.json', '/%2e%2e/package.json', '/../../package.json', '/../data/settings.json']) {
    const r = await raw(p);
    assert.ok(!r.body.includes('electron-builder') && !r.body.includes(FAKE_KEY), `${p} served a file outside public/ (${r.status})`);
  }
});
