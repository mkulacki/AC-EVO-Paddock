// PL5: the v1 -> v2 database upgrade (session notes, tags, corner bookmarks) on a database in the 0.7.0-beta.1 layout
// (test/fixtures/db-v1-0.7.0.sql), then the notes module (src/notes.js: limits, tags, bookmarks, local only) and the
// setup guide's state and first comparison (src/onboarding.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { isolate, ROOT, seedRandom } from './helpers.js';

const { ACEVO_DATA } = isolate('notes');
seedRandom(3);

// ---- a 0.7.0 database with one session of two laps, a goal and a coach message
const lapData = () => { const t = [], d = [], spd = []; for (let i = 0; i < 600; i++) { t.push(i * 1000 / 60); d.push(i); spd.push(60); } return { t, d, spd, thr: t.map(() => 1), brk: t.map(() => 0) }; };
const tableInfo = (d) => Object.fromEntries(d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
  .map((t) => [t.name, d.prepare(`PRAGMA table_info(${t.name})`).all().map((c) => `${c.name}:${c.type}`).join(',')]));
let before;
{
  const old = new DatabaseSync(path.join(ACEVO_DATA, 'telemetry.db'));
  old.exec(fs.readFileSync(path.join(ROOT, 'test/fixtures/db-v1-0.7.0.sql'), 'utf8'));
  old.exec("INSERT INTO sessions (id, track, layout, car, session_type, driver, started_at) VALUES (1, 'trk', 'gp', 'car', 0, 'Driver', 1000)");
  const ins = old.prepare("INSERT INTO laps (session_id, track, layout, car, lap_number, lap_time_ms, valid, driver, source, recorded_at, track_length, samples, data) VALUES (1, 'trk', 'gp', 'car', ?, ?, 1, 'Driver', 'local', ?, 600, 600, ?)");
  ins.run(1, 61000, 2000, zlib.gzipSync(JSON.stringify(lapData())));
  ins.run(2, 60000, 3000, zlib.gzipSync(JSON.stringify(lapData())));
  old.exec("INSERT INTO goals (track, layout, car, kind, target, extra, origin, created_at) VALUES ('trk', 'gp', 'car', 'lap', 59000, '{}', 'me', 1)");
  old.exec("INSERT INTO coach_messages (track, layout, car, role, text, created_at) VALUES ('trk', 'gp', 'car', 'driver', 'hello', 1)");
  before = tableInfo(old);
  old.close();
}

const db = await import('../src/db.js');
const notes = await import('../src/notes.js');
const onboarding = await import('../src/onboarding.js');
const lapfile = await import('../src/lapfile.js');

test('v1 (0.7.0) -> v2 (and on to v4, PL7 + PL8): one copy first, data kept, no existing table changed', () => {
  const copies = fs.readdirSync(ACEVO_DATA).filter((f) => /^telemetry\.backup-v1-\d+\.db$/.test(f));
  assert.equal(copies.length, 1, 'one copy made before the upgrade');
  const c = new DatabaseSync(path.join(ACEVO_DATA, copies[0]), { readOnly: true });
  assert.equal(c.prepare('PRAGMA user_version').get().user_version, 1, 'the copy is the old file');
  assert.equal(c.prepare('SELECT COUNT(*) AS n FROM laps').get().n, 2);
  c.close();
  assert.equal(db.raw.prepare('PRAGMA user_version').get().user_version, db.SCHEMA_VERSION);
  assert.equal(db.SCHEMA_VERSION, 4);
  assert.equal(db.listLaps().length, 2);
  assert.equal(db.listGoals().length, 1);
  assert.equal(db.coachMessages({ track: 'trk', layout: 'gp', car: 'car' }).length, 1);
  // an older Paddock still opens the file: every table it knows has exactly its old columns (only new tables were added)
  const after = tableInfo(db.raw);
  for (const [t, cols] of Object.entries(before)) assert.equal(after[t], cols, `table ${t} unchanged`);
  assert.deepEqual(Object.keys(after).filter((t) => !(t in before)).sort(), ['corner_bookmarks', 'drill_events', 'experiment_entries', 'session_notes', 'session_tags', 'setup_experiments']);
  assert.equal(db.counts().schema, 4);
});

test('notes: saved and read back; tags cleaned, de-duplicated and stored in lower case', () => {
  const r = notes.save(1, { text: '  Wet track, braked early into T1\nTry later braking  ', tags: ['#Wet', 'wet', '  race   prep ', '', 'Quali'] });
  assert.equal(r.text, 'Wet track, braked early into T1\nTry later braking');
  assert.deepEqual(r.tags, ['wet', 'race prep', 'quali']);
  assert.ok(r.updatedAt > 0);
  const again = notes.forSession(1);
  assert.equal(again.text, r.text);
  assert.deepEqual(again.tags, r.tags);
  assert.deepEqual(notes.allTags().map((t) => t.tag).sort(), ['quali', 'race prep', 'wet']);
  assert.equal(notes.summaries().get(1).note, 'Wet track, braked early into T1');
  // control characters are dropped, line breaks kept
  assert.equal(notes.save(1, { text: 'a\u0007b\nc', tags: [] }).text, 'ab\nc');
  // an empty note and no tags: nothing is kept
  notes.save(1, { text: '', tags: [] });
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM session_notes').get().n, 0);
  assert.equal(notes.summaries().has(1), false);
});

test('notes: input limits are enforced with a plain message, and nothing is half-saved', () => {
  const L = notes.LIMITS;
  notes.save(1, { text: 'kept', tags: ['a'] });
  assert.throws(() => notes.save(1, { text: 'x'.repeat(L.noteChars + 1) }), (e) => e.code === 400 && /at most 4000/.test(e.message));
  assert.throws(() => notes.save(1, { text: 'ok', tags: ['y'.repeat(L.tagChars + 1)] }), (e) => e.code === 400);
  assert.throws(() => notes.save(1, { text: 'ok', tags: Array.from({ length: L.tags + 1 }, (_, i) => `t${i}`) }), (e) => e.code === 400);
  assert.throws(() => notes.save(1, { text: 'ok', tags: 'wet' }), (e) => e.code === 400);
  assert.throws(() => notes.save(1, { text: 42 }), (e) => e.code === 400);
  assert.throws(() => notes.save(999, { text: 'x' }), (e) => e.code === 404);
  assert.throws(() => notes.forSession('1; DROP TABLE laps'), (e) => e.code === 404);
  const r = notes.forSession(1);
  assert.equal(r.text, 'kept');
  assert.deepEqual(r.tags, ['a']);
  // exactly at the limits is fine
  assert.equal(notes.save(1, { text: 'x'.repeat(L.noteChars), tags: Array.from({ length: L.tags }, (_, i) => `t${i}`.padEnd(L.tagChars, 'z')) }).tags.length, L.tags);
});

test('corner bookmarks: per track + car with the session they came from; limits; delete', () => {
  db.raw.exec("INSERT INTO sessions (id, track, layout, car, session_type, driver, started_at) VALUES (2, 'trk', 'gp', 'car', 0, 'Driver', 5000)");
  let r = notes.addBookmark(1, { corner: 'Turn 3', note: 'brake 10 m later' });
  assert.equal(r.bookmarks.length, 1);
  assert.deepEqual(r.bookmarks[0].combo, { track: 'trk', layout: 'gp', car: 'car' });
  r = notes.forSession(2);
  assert.equal(r.bookmarks.length, 0, 'made in another session');
  assert.equal(r.comboBookmarks.length, 1, 'but listed for the same track and car');
  assert.throws(() => notes.addBookmark(1, { corner: '  ' }), (e) => e.code === 400);
  assert.throws(() => notes.addBookmark(1, { corner: 'T'.repeat(notes.LIMITS.corner + 1) }), (e) => e.code === 400);
  assert.throws(() => notes.addBookmark(1, { corner: 'T1', note: 'n'.repeat(notes.LIMITS.bookmarkNote + 1) }), (e) => e.code === 400);
  for (let i = 1; i < notes.LIMITS.bookmarksPerSession; i++) notes.addBookmark(2, { corner: `T${i}` });
  notes.addBookmark(2, { corner: 'last one' });
  assert.throws(() => notes.addBookmark(2, { corner: 'one too many' }), (e) => e.code === 400 && /At most 60/.test(e.message));
  assert.equal(notes.summaries().get(2).bookmarks, notes.LIMITS.bookmarksPerSession);
  const id = notes.forSession(1).bookmarks[0].id;
  assert.equal(notes.removeBookmark(id), 1);
  assert.throws(() => notes.removeBookmark(id), (e) => e.code === 404);
  assert.equal(notes.recentBookmarks(5).length, 5);
});

test('notes stay local: a lap file carries none of them', () => {
  notes.save(1, { text: 'private thought', tags: ['secret-tag'] });
  notes.addBookmark(1, { corner: 'Turn 9', note: 'private bookmark' });
  const lap = db.getLap(db.lapsOfSession(1)[0].id);
  const file = zlib.gunzipSync(lapfile.exportLapFile(lap)).toString();
  for (const s of ['private thought', 'secret-tag', 'private bookmark']) assert.ok(!file.includes(s), `${s} not in the lap file`);
});

test('setup guide state: skips are recorded and change nothing else; unknown actions refused', () => {
  let s = onboarding.nextState(null, { action: 'skip', step: 'ai' });
  s = onboarding.nextState(s, { action: 'skip', step: 'mods' });
  s = onboarding.nextState(s, { action: 'skip', step: 'ai' });
  assert.deepEqual(s, { state: null, at: null, skipped: ['ai', 'mods'] });
  s = onboarding.nextState(s, { action: 'unskip', step: 'ai' });
  assert.deepEqual(s.skipped, ['mods']);
  assert.throws(() => onboarding.nextState(s, { action: 'skip', step: 'game' }), (e) => e.code === 400);
  assert.throws(() => onboarding.nextState(s, { action: 'format-disk' }), (e) => e.code === 400);
  const done = onboarding.nextState(s, { action: 'done' });
  assert.equal(done.state, 'done'); assert.ok(done.at > 0);
  assert.equal(onboarding.nextState(done, { action: 'reopen' }).state, null);
  assert.deepEqual(onboarding.normState({ state: 'weird', skipped: ['ai', 'nope', 'ai'], at: 'x' }), { state: null, at: null, skipped: ['ai'] });
});

test('setup guide: never opens by itself (OD-PL-24 c); hasData tells a driver from before', () => {
  const b = onboarding.build({ settings: {}, aceFound: false });
  assert.equal(b.hasData, true);
  assert.equal('show' in b, false, 'no auto-open flag any more');
  assert.equal(b.laps.own, 2);
  const raw = db.raw;
  raw.exec('BEGIN');
  try {
    raw.exec('DELETE FROM laps');
    assert.equal(onboarding.build({ settings: {} }).hasData, false, 'new driver');
    assert.equal(onboarding.build({ settings: { geminiApiKey: 'k' } }).hasData, true, 'a key from before');
    assert.equal(onboarding.build({ settings: { boardToken: 't' } }).hasData, true, 'a sign-in from before');
    assert.equal(onboarding.firstComparison().href, null);
  } finally { raw.exec('ROLLBACK'); }
});

test('setup guide: the first comparison is the last valid lap against the best, or the best against the ideal', () => {
  // lap 2 (60.000) is the newest and the best: best against ideal
  let c = onboarding.firstComparison();
  const [l1, l2] = db.lapsOfSession(1);
  assert.equal(c.href, `#/compare?laps=${l2.id}&ref=ideal`);
  assert.match(c.why, /best of 2/);
  // a slower lap after it: that lap against the best
  db.raw.prepare("INSERT INTO laps (session_id, track, layout, car, lap_number, lap_time_ms, valid, driver, source, recorded_at, track_length, samples, data) VALUES (1, 'trk', 'gp', 'car', 3, 62000, 1, 'Driver', 'local', 4000, 600, 600, ?)")
    .run(zlib.gzipSync(JSON.stringify(lapData())));
  const l3 = db.lapsOfSession(1).at(-1);
  c = onboarding.firstComparison();
  assert.equal(c.href, `#/compare?laps=${l3.id}&ref=best`);
  // an invalid newest lap is not the one compared
  db.raw.prepare('UPDATE laps SET valid = 0 WHERE id = ?').run(l3.id);
  assert.equal(onboarding.firstComparison().href, `#/compare?laps=${l2.id}&ref=ideal`);
  db.raw.prepare('UPDATE laps SET valid = 0 WHERE id = ?').run(l1.id);
  assert.equal(onboarding.firstComparison().href, null, 'one valid lap is not enough');
});
