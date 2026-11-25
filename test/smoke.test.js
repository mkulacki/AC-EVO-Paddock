// API smoke test: the real server (src/server.js --mock) on a free port, with seeded laps in a temporary data dir.
// Every read-only route must answer 200 with valid JSON. No POST routes: several of them start the game.
// Both child processes get a seeded Math.random (preload-seed.js) and the mock car runs at real speed, so the
// data is the same on every run and no new lap is saved while the tests run.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import zlib from 'node:zlib';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { spawn, execFileSync } from 'node:child_process';
import { isolate, ROOT } from './helpers.js';

const env = isolate('smoke');
const childEnv = { ...process.env, ...env, PADDOCK_TEST_SEED: '7' };
// the children run on this same runtime: under Electron (npm run test:electron) they need ELECTRON_RUN_AS_NODE to stay Node
if (!process.versions.electron) delete childEnv.ELECTRON_RUN_AS_NODE;
const node = (...args) => ['--no-warnings', '--import', pathToFileURL(path.join(ROOT, 'test/preload-seed.js')).href, ...args];
const FAKE_KEY = 'test-only-not-a-real-gemini-key-0123456789'; // must not match the release secret scan (CLAUDE.md step 3)

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
let server, base, port, log = '';

before(async () => {
  fs.writeFileSync(path.join(env.ACEVO_DATA, 'settings.json'), JSON.stringify({ geminiApiKey: FAKE_KEY, driverName: 'Test Driver' }));
  // a game log as AC EVO writes it: the game version telemetry checks are recorded with (PL4.1)
  fs.mkdirSync(path.join(env.ACE_DIR, 'Logs'), { recursive: true });
  fs.writeFileSync(path.join(env.ACE_DIR, 'Logs', 'log-test.txt'), 'Assetto Corsa EVO version 0.6.1, test build');
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
    `/api/consistency?${q}`, `/api/progress?${q}`, `/api/setuphistory?${q}`, `/api/compare?laps=${c.bestLapId}&ref=ideal`, `/api/report?session=${sid}`,
    `/api/carreport?session=${sid}`, `/api/ai/summary?lap=${c.bestLapId}&ref=ideal`]) await json(p);
  // setup history: the mock laps have no setup recorded, a diff of one entry with itself compares nothing,
  // and the mock car/track are not in the game's catalogue (no combos)
  const h = await json(`/api/setuphistory?${q}`);
  assert.ok(h.entries.length >= 1);
  const k = h.entries[0].key;
  const d = await json(`/api/setuphistory/diff?${q}&a=${encodeURIComponent(k)}&b=${encodeURIComponent(k)}`);
  assert.equal(d.a.key, k);
  assert.deepEqual((await json('/api/setuphistory/combos?carId=nope&trackId=nope')).combos, []);
});

test('coach: page data, what is sent (without the key), plan from a report, braking-point data; no Gemini call', async () => {
  const o = await json('/api/overview');
  const c = o.combos[0];
  const q = new URLSearchParams({ track: c.track, layout: c.layout, car: c.car });
  const page = await json(`/api/coach?${q}`);
  assert.equal(page.hasKey, true);
  assert.deepEqual(page.messages, []);
  assert.ok(page.marksCombo.track);
  const ctxText = await get(`/api/coach/context?${q}`);
  assert.ok(!ctxText.includes(FAKE_KEY), 'the key is not in what is sent');
  const ctx = JSON.parse(ctxText);
  assert.match(ctx.instructions, /Confidence/);
  assert.equal(ctx.data.totals.laps, c.laps);
  assert.ok((await json(`/api/coach/brakes/data?${q}`)).corners.length >= 1);
  // a plan from the session's report (the report is made on first view)
  const sid = o.sessions[0].id;
  await json(`/api/report?session=${sid}`);
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const made = await (await post('/api/plan', { action: 'create', session: sid })).json();
  assert.equal(made.plan.fromSession, sid);
  assert.equal((await json(`/api/report?session=${sid}`)).plan.role, 'source');
  assert.equal((await json(`/api/plan?${q}`)).plan.id, made.plan.id);
  assert.equal((await (await post('/api/plan', { action: 'close', id: made.plan.id })).json()).plan, null);
  // errors without calling Gemini: an empty question, a missing combo, a bad brake point
  assert.equal((await post('/api/coach/ask', { track: c.track, layout: c.layout, car: c.car, question: ' ' })).status, 400);
  assert.equal((await fetch(`${base}/api/coach`)).status, 400);
  assert.equal((await post('/api/coach/brakes/apply', { track: c.track, layout: c.layout, car: c.car, items: [{ corner: 'T99', m: 1 }] })).status, 400);
  await get('/coach.js');
});

test('home dashboard: data and what needs attention', async () => {
  const d = await json('/api/dashboard');
  assert.ok(d.totals.laps >= 6);
  assert.ok(Array.isArray(d.warnings));
  assert.ok(d.warnings.every((w) => ['warning', 'info'].includes(w.level) && w.href.startsWith('#/') && w.text));
  assert.ok(d.warnings.some((w) => /not checked against the game/.test(w.text)), 'unchecked telemetry is mentioned');
  assert.ok(!d.warnings.some((w) => /Gemini API key/.test(w.text)), 'a key is set in this test');
  await get('/home.js');
  await get('/setuphistory.js');
  assert.ok(d.development && Array.isArray(d.development.goals) && d.development.achievements.total > 10, 'goals and achievements for Home');
});

test('development: goals, suggestions, achievements, weekends; planner refuses what it cannot start', async () => {
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const d = await json('/api/development');
  assert.ok(d.combos.length >= 1 && d.achievements.total > 10 && Array.isArray(d.weekends) && Array.isArray(d.presets));
  assert.ok(d.achievements.items.find((a) => a.id === 'laps-1').unlockedAt, 'the seeded laps unlock the first one');
  const c = d.combos[0];
  const made = await (await post('/api/goals', { key: c.key, kind: 'streak', target: 50, days: 7 })).json();
  assert.equal(made.goal.state, 'open');
  assert.equal(made.goal.challenge, true);
  assert.equal((await post('/api/goals', { key: c.key, kind: 'streak', target: 50 })).status, 400, 'the same goal while it is open (with or without a deadline)');
  assert.equal((await post('/api/goals', { key: 'no|such|combo', kind: 'lap', target: 90000 })).status, 400);
  assert.ok((await json('/api/development')).goals.some((g) => g.id === made.goal.id));
  assert.equal((await post('/api/goals', { action: 'remove', id: made.goal.id })).status, 200);
  assert.equal((await post('/api/goals', { action: 'remove', id: made.goal.id })).status, 404);
  assert.equal((await post('/api/achievements/seen', {})).status, 200);
  assert.ok((await json('/api/development')).achievements.items.every((a) => !a.isNew));
  assert.equal((await post('/api/development/start', { key: c.key, preset: 'nope' })).status, 400, 'unknown preset');
  assert.equal((await post('/api/development/start', { key: 'no|such|combo' })).status, 400, 'not in the game');
  await get('/development.js');
});

test('the Gemini key is never sent to the page, only masked', async () => {
  const s = await json('/api/settings');
  assert.equal(s.geminiApiKey, '••••' + FAKE_KEY.slice(-4));
  for (const p of ['/api/settings', '/api/status', '/api/game', '/api/overview', '/api/health']) assert.ok(!(await get(p)).includes(FAKE_KEY), `${p} leaks the key`);
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
  // recording timing (PL3): numbers only, also part of the full report
  const perfText = await get('/api/diagnostics/perf');
  const perf = JSON.parse(perfText);
  assert.ok(perf.tickInterval.n > 0 && perf.tickWork.n > 0, 'the telemetry loop is timed');
  assert.ok(!perfText.includes(FAKE_KEY) && !perfText.includes('Test Driver') && !perfText.includes('?'), 'no private data or query strings');
  assert.ok((await json('/api/diagnostics')).performance.tickInterval, 'in the full report');
  const u = await json('/api/updates');
  assert.equal(typeof u.current, 'string');
  const c = await (await fetch(base + '/api/updates/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
  assert.match(c.error, /mock/, 'no network call from a mock run');
  const bk = await json('/api/backup');
  assert.deepEqual(bk.backups, []);
  assert.deepEqual(bk.parts.map((p) => p.id), ['laps', 'settings', 'race', 'setupNotes']);
  // Cars tab
  const cs = await json('/api/cars/stats');
  assert.ok(Array.isArray(cs.cars) && Array.isArray(cs.unknown));
  assert.equal((await fetch(base + '/api/cars/detail?car=no_such_car')).status, 404);
  await get('/cars.js');
  // the mock car is on track: a backup would stall the recording
  const b = await fetch(base + '/api/backup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(b.status, 409);
  assert.equal((await fetch(base + '/api/backup/file?name=..%2fsettings.json')).status, 400);
});

test('lap import route (PL1.2): duplicate refused with the existing lap named, bad files 400, bombs 413, never a 500', async () => {
  const o = await json('/api/overview');
  const id = o.laps[0].id;
  const r0 = await fetch(`${base}/api/laps/${id}/export`);
  assert.equal(r0.status, 200);
  const file = Buffer.from(await r0.arrayBuffer());
  const imp = (body) => fetch(base + '/api/laps/import', { method: 'POST', body, headers: { 'content-type': 'application/octet-stream' } });
  const dup = await imp(file);
  assert.equal(dup.status, 409);
  assert.match((await dup.json()).error, new RegExp(`already in Paddock \\(lap #${id}`));
  const obj = JSON.parse(zlib.gunzipSync(file));
  const fresh = await imp(zlib.gzipSync(JSON.stringify({ ...obj, meta: { ...obj.meta, recorded_at: obj.meta.recorded_at + 1 } })));
  assert.equal(fresh.status, 200);
  const newId = (await fresh.json()).id;
  assert.ok(newId > 0);
  assert.equal((await json('/api/overview')).laps.find((l) => l.id === newId).source, 'import');
  for (const [body, code] of [[Buffer.from('junk'), 400], [zlib.gzipSync(JSON.stringify({ ...obj, meta: undefined })), 400],
    [zlib.gzipSync(JSON.stringify({ ...obj, data: { ...obj.data, t: 5 } })), 400], [zlib.gzipSync(Buffer.alloc(70 * 1024 * 1024, 0x20)), 413]]) {
    const r = await imp(body);
    assert.equal(r.status, code, (await r.json()).error);
  }
  assert.ok(!/\[import\] lap import failed/.test(log), 'no unexpected import error');
  // setup files are a few kB: a big body is refused without being read whole (PL0 1.3-i)
  const big = await fetch(base + '/api/setups/import?filename=x.carsetup', { method: 'POST', body: Buffer.alloc(200 * 1024, 0x7b), headers: { 'content-type': 'application/octet-stream' } }).catch((e) => e);
  assert.ok(big instanceof Error || big.status === 413, `setup import of 200 kB: ${big.status}`);
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
  // PL1 (PL0 1.1-e): GETs of private data refuse other sites too; ordinary GETs and typed/opened URLs stay allowed
  for (const p of ['/api/diagnostics', '/api/diagnostics/perf', '/api/health', '/api/backup/file?name=x.zip', '/api/export/laps.csv', '/api/laps/1/export', '/api/setups/export?id=x']) {
    assert.equal(await send({ 'sec-fetch-site': 'cross-site' }, 'GET', p), 403, `${p} cross-site`);
    assert.equal(await send({ 'sec-fetch-site': 'same-site' }, 'GET', p), 403, `${p} from another local port`);
    assert.equal(await send({ origin: 'https://evil.example' }, 'GET', p), 403, `${p} with a foreign origin`);
  }
  assert.equal(await send({ 'sec-fetch-site': 'same-origin' }, 'GET', '/api/diagnostics'), 200);
  assert.equal(await send({ 'sec-fetch-site': 'none' }, 'GET', '/api/export/laps.csv'), 200);
  assert.equal(await send({}, 'GET', '/api/export/laps.csv'), 200);
  assert.equal(await send({ 'sec-fetch-site': 'cross-site' }, 'GET', '/'), 200, 'opening Paddock from a link still works');
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

test('integration health (PL4.3): every part answered; a mock run says so; checks are counted against the game log version', async () => {
  const h = await json('/api/health');
  assert.deepEqual(h.checks.map((c) => c.id), ['game', 'freshness', 'recording', 'hud', 'channels', 'online']);
  for (const c of h.checks) { assert.ok(['ok', 'warn', 'bad', 'off', 'unknown'].includes(c.state), c.id); assert.ok(c.summary); }
  assert.match(h.checks[0].summary, /mock telemetry/);
  assert.match(h.checks.find((c) => c.id === 'channels').summary, /AC EVO 0\.6\.1/);
  assert.equal(h.checks.find((c) => c.id === 'online').state, 'off', 'sharing is off by default');
});

// ---------------------------------------------------------------- PL5: notes, tags, bookmarks, the setup guide, Home
test('notes API: save, bookmark, list; bounded; private (refused cross-site); in the overview; not in diagnostics', async () => {
  const post = (p, body, method = 'POST') => fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const sid = (await json('/api/overview')).sessions[0].id;
  let r = await (await post('/api/notes', { session: sid, text: 'smoke-note-text', tags: ['Smoke', 'smoke'] })).json();
  assert.deepEqual(r.tags, ['smoke']);
  r = await (await post('/api/notes/bookmark', { session: sid, corner: 'T1', note: 'smoke-bookmark' })).json();
  assert.equal(r.bookmarks.length, 1);
  assert.equal((await post('/api/notes', { session: sid, text: 'x'.repeat(4001) })).status, 400);
  assert.equal((await post('/api/notes', { session: 99999, text: 'x' })).status, 404);
  assert.equal((await post('/api/notes/bookmark', { session: sid, corner: '' })).status, 400);
  const g = await json(`/api/notes?session=${sid}`);
  assert.equal(g.text, 'smoke-note-text');
  const idx = await json('/api/notes/index');
  assert.deepEqual(idx.tags, [{ tag: 'smoke', n: 1 }]);
  assert.equal(idx.sessions[sid].bookmarks, 1);
  assert.deepEqual((await json('/api/overview')).notes[sid].tags, ['smoke']);
  // another site cannot read them
  assert.equal((await fetch(`${base}/api/notes?session=${sid}`, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await fetch(`${base}/api/notes/index`, { headers: { 'sec-fetch-site': 'same-site' } })).status, 403);
  // local only: not in diagnostics, nor in what the leaderboard or AI coach would get
  for (const p of ['/api/diagnostics?format=text', '/api/diagnostics', '/api/board/status']) assert.ok(!(await get(p)).includes('smoke-note-text'), `${p}`);
  const c = (await json('/api/overview')).combos[0];
  assert.ok(!(await get(`/api/coach/context?${new URLSearchParams({ track: c.track, layout: c.layout, car: c.car })}`)).includes('smoke-'), 'not sent to the AI coach');
  r = await (await post(`/api/notes/bookmark?id=${g.bookmarks[0].id}`, null, 'DELETE')).json();
  assert.equal(r.bookmarks.length, 0);
});

test('setup guide API: an existing driver is not sent to it; skips are recorded; Home has the next step', async () => {
  const post = (body) => fetch(base + '/api/onboarding', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let o = await json('/api/onboarding');
  assert.equal(o.hasData, true);
  assert.equal(o.show, false, 'laps exist: never opened by itself');
  assert.ok(o.comparison.href?.startsWith('#/compare?laps='));
  o = await (await post({ action: 'skip', step: 'online' })).json();
  assert.deepEqual(o.skipped, ['online']);
  assert.equal((await json('/api/settings')).boardShare, false, 'skipping changes no setting');
  assert.equal((await post({ action: 'nope' })).status, 400);
  o = await (await post({ action: 'done' })).json();
  assert.equal(o.state, 'done');
  assert.equal((await fetch(`${base}/api/onboarding`, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  const d = await json('/api/dashboard');
  assert.ok(d.nextAction?.evidence && d.nextAction.href.startsWith('#/'));
  assert.ok(d.recentProgress && Number.isInteger(d.recentProgress.newBests));
  assert.ok('objective' in d && 'lastNotes' in d);
  await get('/welcome.js');
  await get('/notes.js');
});
