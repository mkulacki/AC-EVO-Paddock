// PL5 review fixes: notes of sessions without laps (D-PL5-15), a database from a newer Paddock left untouched,
// restores checked against this Paddock's schema, the pre-upgrade copy for any user data, and the automatic HUD
// install switch used by the setup guide (OD-PL-22 (b)).
// Separate databases are opened in child processes (src/db.js opens ACEVO_DATA at import).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { isolate, ROOT } from './helpers.js';

const env = isolate('pl5review');
const db = await import('../src/db.js');
const notes = await import('../src/notes.js');
const backup = await import('../src/backup.js');
const zip = await import('../src/zip.js');
const health = await import('../src/health.js');
const hudInstall = await import('../src/hudinstall.js');

const mod = (f) => JSON.stringify(pathToFileURL(path.join(ROOT, 'src', f)).href);
const childEnv = (data) => { const e = { ...process.env, ACEVO_DATA: data, ACE_DIR: path.join(env.dir, 'ACE') }; if (!process.versions.electron) delete e.ELECTRON_RUN_AS_NODE; return e; };
/** Runs code in a fresh Node with its own data folder; the code's console.log output (JSON) is returned. */
const child = (data, code) => JSON.parse(execFileSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', code], { env: childEnv(data), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim().split('\n').pop());
const freshDir = (name) => { const d = path.join(env.dir, name); fs.mkdirSync(d, { recursive: true }); return d; };
const lapRow = (sid, n, ms) => ({ sessionId: sid, track: 't', layout: 'l', car: 'c', lapNumber: n, lapTimeMs: ms, valid: true, driver: 'd', recordedAt: Date.now() + n, trackLength: 100, data: { t: [0, 1], d: [0, 1], spd: [1, 1] } });

test('D-PL5-15: deleting the last lap of a session deletes its notes, tags and bookmarks; earlier laps gone keep them', () => {
  const sid = db.createSession({ track: 't', layout: 'l', car: 'c', sessionType: 0, driver: 'd', startedAt: 1 });
  const a = db.insertLap(lapRow(sid, 1, 60000)), b = db.insertLap(lapRow(sid, 2, 61000));
  notes.save(sid, { text: 'gone soon', tags: ['orphan-tag'] });
  notes.addBookmark(sid, { corner: 'T1' });
  db.deleteLap(a);
  assert.equal(notes.forSession(sid).text, 'gone soon', 'a lap is left: kept');
  db.deleteLap(b);
  const left = (t) => db.raw.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE session_id = ?`).get(sid).n;
  assert.deepEqual(['session_notes', 'session_tags', 'corner_bookmarks'].map(left), [0, 0, 0]);
  assert.ok(!notes.allTags().some((t) => t.tag === 'orphan-tag'), 'not in Ctrl+K or the tag filter');
  assert.ok(!notes.summaries().has(sid));
});

test('D-PL5-15: notes left by sessions without laps are removed once at start; others kept', () => {
  const data = freshDir('orphans');
  child(data, `const db = await import(${mod('db.js')}); const n = await import(${mod('notes.js')});
    const keep = db.createSession({ track: 't', layout: 'l', car: 'c', sessionType: 0, driver: 'd', startedAt: 1 });
    db.insertLap({ sessionId: keep, track: 't', layout: 'l', car: 'c', lapNumber: 1, lapTimeMs: 1, valid: true, driver: 'd', recordedAt: 1, trackLength: 1, data: { t: [0], d: [0], spd: [0] } });
    const lost = db.createSession({ track: 't', layout: 'l', car: 'c', sessionType: 0, driver: 'd', startedAt: 2 });
    n.save(keep, { text: 'keep', tags: ['k'] });
    db.raw.prepare("INSERT INTO session_notes (session_id, text) VALUES (?, 'orphan')").run(lost);
    db.raw.prepare("INSERT INTO session_tags (session_id, tag) VALUES (?, 'o')").run(lost);
    db.raw.prepare("INSERT INTO corner_bookmarks (session_id, corner) VALUES (?, 'T1')").run(lost);
    console.log(JSON.stringify(1));`);
  const r = child(data, `const db = await import(${mod('db.js')});
    console.log(JSON.stringify(['session_notes', 'session_tags', 'corner_bookmarks'].map((t) => db.raw.prepare('SELECT COUNT(*) AS n FROM ' + t).get().n)));`);
  assert.deepEqual(r, [1, 1, 0], 'only the session with a lap keeps its note and tag');
});

test('a database from a newer Paddock (user_version 5, one above this Paddock) is not upgraded or written; backups and restores refused; health says why', () => {
  const data = freshDir('newer');
  const file = path.join(data, 'telemetry.db');
  { const t = new DatabaseSync(file); t.exec("CREATE TABLE laps (id INTEGER PRIMARY KEY, x TEXT); CREATE TABLE future (y); INSERT INTO laps (x) VALUES ('kept'); PRAGMA user_version = 5;"); t.close(); }
  const hash = () => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const before = hash();
  const r = child(data, `const db = await import(${mod('db.js')}); const b = await import(${mod('backup.js')});
    const out = { blocked: db.blocked, laps: db.listLaps().length };
    db.createSession({ track: 't', layout: 'l', car: 'c', sessionType: 0, driver: 'd', startedAt: 1 }); // goes to memory only
    try { await b.create({ reason: 'manual' }); out.backup = 'made'; } catch (e) { out.backup = e.code + ' ' + e.message; }
    try { await b.stageRestore('x.zip'); out.restore = 'staged'; } catch (e) { out.restore = e.code + ' ' + e.message; }
    console.log(JSON.stringify(out));`);
  assert.equal(r.blocked.version, 5);
  assert.equal(r.blocked.supported, 4);
  assert.match(r.blocked.message, /^Recording is off: .*newer Paddock.*Install that newer Paddock/);
  assert.ok(r.blocked.message.includes('data\\telemetry.db'), 'the path is written out (no tab character)');
  assert.equal(r.laps, 0, 'runs on an empty database in memory');
  assert.match(r.backup, /^409 No backup/);
  assert.match(r.restore, /^409 No restore/);
  assert.equal(hash(), before, 'the file is byte for byte unchanged');
  assert.ok(!fs.existsSync(`${file}-wal`), 'not switched to WAL');
  const t = new DatabaseSync(file, { readOnly: true });
  assert.equal(t.prepare('PRAGMA user_version').get().user_version, 5);
  assert.equal(t.prepare('SELECT x FROM laps').get().x, 'kept');
  t.close();
  const h = health.build({ dbBlocked: r.blocked, telemetry: {}, game: {}, aceFound: true });
  const rec = h.checks.find((c) => c.id === 'recording');
  assert.equal(rec.state, 'bad');
  assert.match(rec.summary, /^Recording is off: .*newer Paddock/);
});

test('D-PL5-19: with a newer database, recording is off: mock laps driven produce no insert; health and status say so', async () => {
  const data = freshDir('newer-live');
  const file = path.join(data, 'telemetry.db');
  { const t = new DatabaseSync(file); t.exec('CREATE TABLE laps (id INTEGER PRIMARY KEY); PRAGMA user_version = 5;'); t.close(); }
  const sha = () => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const before = sha();
  const net = await import('node:net');
  const port = await new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  const { spawn } = await import('node:child_process');
  // the mock car at 60x speed: a lap every second or two
  const srv = spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'src/server.js'), '--mock', '60'], { env: { ...childEnv(data), PORT: String(port) }, cwd: ROOT });
  let log = '';
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`server did not start: ${log}`)), 20000);
      srv.stdout.on('data', (b) => { log += b; if (log.includes(`running: http://localhost:${port}`)) { clearTimeout(timer); resolve(); } });
      srv.stderr.on('data', (b) => { log += b; });
    });
    await new Promise((r) => setTimeout(r, 6000)); // several mock laps' worth of driving
    const j = (p) => fetch(`http://127.0.0.1:${port}${p}`).then((r) => r.json());
    const st = await j('/api/status');
    assert.equal(st.state.status, 'recording off');
    assert.equal(st.state.savedLaps, 0);
    assert.equal((await j('/api/overview')).laps.length, 0, 'no lap inserted, not even in memory');
    const rec = (await j('/api/health')).checks.find((c) => c.id === 'recording');
    assert.equal(rec.state, 'bad');
    assert.match(rec.summary, /^Recording is off/);
    assert.ok((await j('/api/dashboard')).warnings.some((w) => /^Recording is off/.test(w.text)), 'Home says so');
    assert.ok(!log.includes('[lap]'), 'no lap event');
  } finally { const gone = new Promise((r) => srv.once('exit', r)); srv.kill(); await gone; }
  assert.equal(sha(), before, 'file unchanged');
});

test('a backup whose database is newer than this Paddock knows (SCHEMA_VERSION) is refused', async () => {
  const f = path.join(env.dir, 'v5.db');
  { const t = new DatabaseSync(f); t.exec('CREATE TABLE laps (id); CREATE TABLE sessions (id); PRAGMA user_version = 5;'); t.close(); }
  fs.mkdirSync(backup.BACKUP_DIR, { recursive: true });
  const z = 'paddock-backup-v5.zip';
  await zip.writeZip(path.join(backup.BACKUP_DIR, z), [{ name: 'manifest.json', data: JSON.stringify({ format: backup.FORMAT, version: 1, files: ['telemetry.db'] }) }, { name: 'telemetry.db', file: f }]);
  await assert.rejects(backup.stageRestore(z), /newer Paddock/);
  assert.ok(!backup.pending());
  // and the current schema passes that check (a v4 database from this Paddock, PL8)
  assert.equal(db.SCHEMA_VERSION, 4);
});

test('the copy before the v2 upgrade is made for any user data (goals, no laps), not only laps', () => {
  const data = freshDir('goalsonly');
  { const t = new DatabaseSync(path.join(data, 'telemetry.db'));
    t.exec(fs.readFileSync(path.join(ROOT, 'test/fixtures/db-v1-0.7.0.sql'), 'utf8'));
    t.exec("INSERT INTO goals (track, layout, car, kind, target, created_at) VALUES ('t', 'l', 'c', 'lap', 1, 1)"); t.close(); }
  const r = child(data, `const db = await import(${mod('db.js')}); console.log(JSON.stringify(db.counts().schema));`);
  assert.equal(r, 4);
  assert.equal(fs.readdirSync(data).filter((f) => /^telemetry\.backup-v1-\d+\.db$/.test(f)).length, 1);
  assert.equal(fs.readdirSync(data).filter((f) => f.startsWith('telemetry.backup-')).length, 1, 'one copy per start, also through v2, v3 (PL7) and v4 (PL8)');
  // an empty database gets none
  const empty = freshDir('empty');
  child(empty, `const db = await import(${mod('db.js')}); console.log(JSON.stringify(db.counts().schema));`);
  assert.equal(fs.readdirSync(empty).filter((f) => f.startsWith('telemetry.backup-')).length, 0);
});

test('checkTags: an over-long tag list is refused before any cleaning', () => {
  const sid = db.createSession({ track: 't', layout: 'l', car: 'c', sessionType: 0, driver: 'd', startedAt: 9 });
  db.insertLap(lapRow(sid, 1, 60000));
  assert.throws(() => notes.save(sid, { text: '', tags: Array(1e5).fill('') }), (e) => e.code === 400 && /At most 12 tags/.test(e.message));
});

test('OD-PL-22 (b): the automatic HUD install switch uses the existing hud-removed / loader-removed flags', () => {
  const flag = (n) => fs.existsSync(path.join(env.ACEVO_DATA, n));
  assert.equal(hudInstall.autoInstallOn(), true, 'on by default: existing behaviour');
  let s = hudInstall.setAutoInstall(false);
  assert.ok(flag('hud-removed') && flag('loader-removed'));
  assert.equal(s.removed, true);
  s = hudInstall.autoUpdate('test');
  assert.equal(s.state, 'missing');
  assert.equal(hudInstall.installedVersion(), null, 'nothing installed while off');
  assert.equal(fs.existsSync(path.join(env.ACE_DIR, 'mods')), false, 'nothing put into the game folder (HUD or loader)');
  hudInstall.setAutoInstall(true);
  assert.ok(!flag('hud-removed') && !flag('loader-removed'));
  assert.equal(hudInstall.autoInstallOn(), true);
});
