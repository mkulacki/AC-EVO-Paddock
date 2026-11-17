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
  await get('/app.js');
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
