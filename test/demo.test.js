// PL11 demo: a real server started with --demo next to a real data folder. The demo lives in data\demo, the real
// database is not opened or changed, and nothing of the demo can reach the game, its files or the leaderboard.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { isolate, ROOT } from './helpers.js';

const env = isolate('demo');
const childEnv = { ...process.env, ...env };
if (!process.versions.electron) delete childEnv.ELECTRON_RUN_AS_NODE;
const REAL_DB = path.join(env.ACEVO_DATA, 'telemetry.db');
const hash = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
let server, base, log = '', realHash;

before(async () => {
  // the driver's own data: two laps and settings with a sign-in
  execFileSync(process.execPath, ['--no-warnings', path.join(ROOT, 'src/mock.js'), '--seed', '2'], { env: childEnv, cwd: ROOT, stdio: 'ignore' });
  fs.writeFileSync(path.join(env.ACEVO_DATA, 'settings.json'), JSON.stringify({ driverName: 'Real Driver', boardToken: 'real-token', boardShare: true }));
  realHash = hash(REAL_DB);
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'src/server.js'), '--demo'], { env: { ...childEnv, PORT: String(port) }, cwd: ROOT });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${log}`)), 30000);
    server.stdout.on('data', (b) => { log += b; if (log.includes(`running: http://localhost:${port}`)) { clearTimeout(timer); resolve(); } });
    server.stderr.on('data', (b) => { log += b; });
    server.once('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited (${code}):\n${log}`)); });
  });
});
after(async () => {
  if (!server || server.exitCode != null) return;
  const gone = new Promise((r) => server.once('exit', r)); server.kill(); await gone;
});
const json = async (p, init) => { const r = await fetch(base + p, init); return { status: r.status, body: await r.json() }; };
const postJson = (p, body = {}) => json(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('the demo runs on its own data folder with two synthetic sessions and their reports', async () => {
  const s = await json('/api/status');
  assert.equal(s.body.demo, true);
  assert.match(s.body.source, /Mock/);
  assert.ok(fs.existsSync(path.join(env.ACEVO_DATA, 'demo', 'telemetry.db')));
  const r = await json('/api/reports');
  assert.equal(r.body.reports.length, 2, JSON.stringify(r.body).slice(0, 300));
  assert.match(log, /\[demo\] 2 synthetic session\(s\) made/);
  assert.equal(s.body.settings.driverName, '', 'the demo has its own settings, not the driver\'s');
});

test('the driver\'s real database and settings are untouched', () => {
  assert.equal(hash(REAL_DB), realHash);
  assert.equal(JSON.parse(fs.readFileSync(path.join(env.ACEVO_DATA, 'settings.json'), 'utf8')).boardToken, 'real-token');
});

test('nothing reaches the game, its files, the leaderboard or real data', async () => {
  for (const p of ['/api/board/login', '/api/board/sync', '/api/game/launch', '/api/race/launch', '/api/mods/action', '/api/setups/import', '/api/backup/restore', '/api/laps/import']) {
    const r = await postJson(p);
    assert.equal(r.status, 409, `${p} → ${r.status}`);
    assert.match(r.body.error, /Not in the demo/);
  }
  // outside the desktop app there is no relaunch: it says how instead
  const d = await postJson('/api/demo', { on: false });
  assert.equal(d.status, 409);
  // no scheduled backups in the demo (the mock car is on track, so the run is refused even before that)
  const b = await postJson('/api/backup/schedule/run');
  assert.ok(b.status === 409 || b.body.skipped === 'demo', JSON.stringify(b.body));
  assert.equal(fs.existsSync(path.join(env.ACEVO_DATA, 'backups')), false, 'nothing in the real backups folder');
});
