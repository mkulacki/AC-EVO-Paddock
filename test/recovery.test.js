// PL11 crash recovery: the session journal, and a real server killed mid-session and started again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { isolate, seedRandom, ROOT } from './helpers.js';

const env = isolate('recovery');
seedRandom(3);
const db = await import('../src/db.js');
const recovery = await import('../src/recovery.js');
const { seedLaps } = await import('../src/mock.js');

test('journal: written once per session, removed when the session ends; a clean end leaves nothing to recover', async () => {
  let sid = null;
  await seedLaps(1, (l) => { sid = l.sessionId; recovery.opened({ ...l, startedAt: db.getSession(l.sessionId).started_at }); });
  assert.ok(fs.existsSync(recovery.FILE));
  recovery.closed(sid);
  assert.equal(fs.existsSync(recovery.FILE), false);
  assert.equal(recovery.interrupted(), null);
});

test('an interrupted session is found, checked against the database and closed with its report', async () => {
  recovery._reset();
  let sid = null, startedAt = null;
  await seedLaps(4, (l) => { sid = l.sessionId; startedAt ??= db.getSession(l.sessionId).started_at; recovery.opened({ ...l, startedAt }); });
  // the process "dies" here: the journal stays
  const found = recovery.interrupted();
  assert.equal(found.sessionId, sid);
  assert.equal(found.laps, 4);
  let asked = null;
  const r = await recovery.recover(found, { makeReport: async (id) => { asked = id; return true; } });
  assert.equal(asked, sid);
  assert.equal(r.report, true);
  assert.equal(recovery.lastRecovery().sessionId, sid);
  assert.equal(fs.existsSync(recovery.FILE), false);
});

test('a journal that does not match the database (e.g. after a restore) is ignored and removed', () => {
  fs.writeFileSync(recovery.FILE, JSON.stringify({ sessionId: 1, track: 'other_track', car: 'x', startedAt: 1 }));
  assert.equal(recovery.interrupted(), null);
  assert.equal(fs.existsSync(recovery.FILE), false);
  fs.writeFileSync(recovery.FILE, '{ damaged');
  assert.equal(recovery.interrupted(), null);
  assert.equal(fs.existsSync(recovery.FILE), false);
});

test('a failing report still closes the session; the laps stay', async () => {
  recovery._reset();
  const s = db.listSessions()[0];
  fs.writeFileSync(recovery.FILE, JSON.stringify({ sessionId: s.id, track: s.track, car: s.car, startedAt: s.started_at }));
  const r = await recovery.recover(recovery.interrupted(), { makeReport: async () => { throw new Error('boom'); } });
  assert.equal(r.report, false);
  assert.equal(r.error, 'boom');
  assert.equal(fs.existsSync(recovery.FILE), false);
  assert.ok(db.lapsOfSession(s.id).length > 0);
});

// ---------------------------------------------------------------- a real server, killed (TerminateProcess on Windows)
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
function start(dataDir, port, until) {
  const childEnv = { ...process.env, ACEVO_DATA: dataDir, ACE_DIR: env.ACE_DIR, PORT: String(port) };
  if (!process.versions.electron) delete childEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'src/server.js'), '--mock', '40'], { env: childEnv, cwd: ROOT });
  let log = '';
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out:\n${log}`)), 60000);
    const on = (b) => { log += b; if (until(log)) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', on); child.stderr.on('data', (b) => { log += b; });
    child.once('exit', (code) => { clearTimeout(timer); if (!until(log)) reject(new Error(`exited ${code}:\n${log}`)); });
  });
  return { child, ready, log: () => log };
}
const stop = async (c) => { if (c.child.exitCode != null) return; const gone = new Promise((r) => c.child.once('exit', r)); c.child.kill(); await gone; };

test('a server killed mid-session: every saved lap is still there and the next start closes the session with its report', { timeout: 120000 }, async () => {
  const dataDir = path.join(env.dir, 'kill-data');
  fs.mkdirSync(dataDir, { recursive: true });
  const journal = path.join(dataDir, 'session-open.json');
  const port = await freePort();
  // three saved laps (the mock car runs 40 times faster), then a hard kill: no session end, no report
  const a = start(dataDir, port, (log) => (log.match(/\[lap\] /g) || []).length >= 3 && fs.existsSync(journal));
  await a.ready;
  await stop(a);
  const lapsBefore = (a.log().match(/\[lap\] .* -> #(\d+)/g) || []).length;
  assert.ok(fs.existsSync(journal), 'the journal survives the kill');
  const { sessionId } = JSON.parse(fs.readFileSync(journal, 'utf8'));
  const port2 = await freePort();
  const b = start(dataDir, port2, (log) => log.includes('[recovery] session'));
  try {
    await b.ready;
    assert.match(b.log(), new RegExp(`\\[recovery\\] session ${sessionId} .*${lapsBefore} saved lap\\(s\\) kept, session closed, report made`));
    const dash = await (await fetch(`http://127.0.0.1:${port2}/api/dashboard`)).json();
    assert.ok(dash.warnings.some((w) => /closed during a session last time/.test(w.text)), 'Home says so');
    const rep = await (await fetch(`http://127.0.0.1:${port2}/api/report?session=${sessionId}`)).json();
    assert.ok(rep.data, 'the report was made');
    assert.equal(rep.laps.length, lapsBefore, 'no saved lap lost');
  } finally { await stop(b); }
});

test('review: a new session journaled while the old one is recovered keeps its journal', async () => {
  recovery._reset();
  const s = db.listSessions()[0];
  fs.writeFileSync(recovery.FILE, JSON.stringify({ sessionId: s.id, track: s.track, car: s.car, startedAt: s.started_at }));
  const found = recovery.interrupted();
  await recovery.recover(found, { makeReport: async () => {
    fs.writeFileSync(recovery.FILE, JSON.stringify({ sessionId: s.id + 1000, track: 't', car: 'c' })); // the new session's first lap
    return false;
  } });
  assert.equal(JSON.parse(fs.readFileSync(recovery.FILE, 'utf8')).sessionId, s.id + 1000);
  fs.rmSync(recovery.FILE, { force: true });
});
