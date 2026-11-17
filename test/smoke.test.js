// API smoke test: the real server (src/server.js --mock) on a free port, with seeded laps in a temporary data dir.
// Every read-only route must answer 200 with valid JSON. No POST routes: several of them start the game.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { isolate, ROOT } from './helpers.js';

const env = isolate('smoke');
const childEnv = { ...process.env, ...env };
delete childEnv.ELECTRON_RUN_AS_NODE;

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
let server, base, log = '';

before(async () => {
  execFileSync(process.execPath, ['--no-warnings', path.join(ROOT, 'src/mock.js'), '--seed', '6'], { env: childEnv, cwd: ROOT, stdio: 'ignore' });
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'src/server.js'), '--mock', '8'], { env: { ...childEnv, PORT: String(port) }, cwd: ROOT });
  server.stdout.on('data', (b) => { log += b; });
  server.stderr.on('data', (b) => { log += b; });
  for (let i = 0; i < 100; i++) {
    if (server.exitCode != null) throw new Error(`server exited:\n${log}`);
    try { if ((await fetch(base + '/')).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server did not start:\n${log}`);
});
after(() => server?.kill());

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

test('settings never expose the Gemini key', async () => {
  const s = await json('/api/settings');
  assert.ok(!s.geminiApiKey || s.geminiApiKey.startsWith('••••'));
});

test('unknown files and path tricks are refused', async () => {
  assert.notEqual((await fetch(base + '/nope.html')).status, 200);
  const r = await fetch(base + '/..%2f..%2fpackage.json');
  assert.ok(r.status !== 200 || !(await r.text()).includes('"electron-builder"'), 'no files outside public/');
});
