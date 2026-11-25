// PL8: the v3 -> v4 database upgrade (setup experiments) on a database in the PL7 layout (test/fixtures/db-v3-pl7.sql),
// then setup experiments end to end (src/experiments.js) on synthetic laps (test/lapfixtures.js) with chosen lap
// times, setups, game versions and conditions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isolate, ROOT } from './helpers.js';

const { ACEVO_DATA } = isolate('experiments-db');
const tableInfo = (d) => Object.fromEntries(d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
  .map((t) => [t.name, d.prepare(`PRAGMA table_info(${t.name})`).all().map((c) => `${c.name}:${c.type}`).join(',')]));
let before;
{
  const old = new DatabaseSync(path.join(ACEVO_DATA, 'telemetry.db'));
  old.exec(fs.readFileSync(path.join(ROOT, 'test/fixtures/db-v3-pl7.sql'), 'utf8'));
  old.exec("INSERT INTO goals (track, layout, car, kind, target, extra, origin, created_at) VALUES ('trk', 'gp', 'car', 'drill', 0, '{}', 'me', 1)");
  old.exec("INSERT INTO drill_events (goal_id, at, kind, data) VALUES (1, 2, 'stopped', NULL)");
  old.exec("INSERT INTO session_notes (session_id, text, updated_at) VALUES (1, 'kept', 1)");
  before = tableInfo(old);
  old.close();
}

const db = await import('../src/db.js');

test('v3 -> v4: one copy first, data kept, schema version 4, only the two experiment tables added', () => {
  const copies = fs.readdirSync(ACEVO_DATA).filter((f) => f.startsWith('telemetry.backup-'));
  assert.equal(copies.length, 1);
  assert.match(copies[0], /^telemetry\.backup-v3-\d+\.db$/);
  const c = new DatabaseSync(path.join(ACEVO_DATA, copies[0]), { readOnly: true });
  assert.equal(c.prepare('PRAGMA user_version').get().user_version, 3, 'the copy is the old file');
  assert.equal(c.prepare('SELECT COUNT(*) AS n FROM drill_events').get().n, 1);
  c.close();
  assert.equal(db.SCHEMA_VERSION, 4);
  assert.equal(db.counts().schema, 4);
  assert.equal(db.listDrills().length, 1);
  assert.equal(db.drillEvents().get(1).length, 1, 'drill events kept');
  const after = tableInfo(db.raw);
  for (const [t, cols] of Object.entries(before)) assert.equal(after[t], cols, `table ${t} unchanged (an older Paddock still reads it)`);
  assert.deepEqual(Object.keys(after).filter((t) => !(t in before)).sort(), ['experiment_entries', 'setup_experiments']);
  assert.equal(db.blocked, null);
});

test('v4 tables: an experiment and its journal are stored, read back and deleted together; orphan entries pruned at start', () => {
  const id = db.addExperiment({ combo: { track: 'trk', layout: 'gp', car: 'car' }, title: 'Wing', variants: { A: { label: 'Base' }, B: { label: 'More wing' } }, stints: [] });
  db.addExperimentEntry(id, 'journal', { text: 'one click more rear wing' });
  const e = db.getExperiment(id);
  assert.equal(e.status, 'planned');
  assert.equal(e.title, 'Wing');
  assert.deepEqual(e.combo, { track: 'trk', layout: 'gp', car: 'car' });
  e.status = 'running'; e.stints.push({ id: 1, variant: 'A', startAt: 5, endAt: null });
  db.saveExperiment(e);
  assert.equal(db.getExperiment(id).stints.length, 1);
  assert.equal(db.getExperiment(id).status, 'running');
  assert.equal(db.listExperiments({ track: 'trk', layout: 'gp', car: 'car' }).length, 1);
  assert.equal(db.listExperiments({ track: 'trk', layout: 'gp', car: 'other' }).length, 0);
  assert.equal(db.experimentEntries(id).length, 1);
  db.deleteExperiment(id);
  assert.equal(db.getExperiment(id), null);
  assert.equal(db.experimentEntries(id).length, 0);
});

// ---- the experiment lifecycle on synthetic laps (test/lapfixtures.js), with two saved setup files in the scratch
// AC EVO folder (synthetic protobuf records: the car is not installed here, so their values are not readable and the
// setups' identities come from the setup history's recorded snapshots, as for a file on another PC)
const { insertLap, COMBO } = await import('./lapfixtures.js');
const crypto = await import('node:crypto');
const pbKey = (f, wt) => Buffer.from([(f << 3) | wt]);
const pbVar = (f, v) => Buffer.concat([pbKey(f, 0), Buffer.from([v])]);
const pbBytes = (f, b) => { b = Buffer.from(b); return Buffer.concat([pbKey(f, 2), Buffer.from([b.length]), b]); };
const carsetup = (k) => Buffer.concat([pbVar(1, 7), pbBytes(2, Buffer.from([0x0d, 0, 0, 0x80, 0x3e + k])), pbBytes(9, 'fixture_gt_preset_x'), pbVar(10, 3)]);
const SETUPS = path.join(process.env.ACE_DIR, 'Car Setups', 'Fixture GT', 'Fixture Ring');
fs.mkdirSync(SETUPS, { recursive: true });
fs.writeFileSync(path.join(SETUPS, 'Base.carsetup'), carsetup(0));
fs.writeFileSync(path.join(SETUPS, 'Wing.carsetup'), carsetup(1));
const REL = { A: 'Fixture GT/Fixture Ring/Base.carsetup', B: 'Fixture GT/Fixture Ring/Wing.carsetup' };
// Wing was saved in Paddock from Base (PL8 ancestry in data/setup-meta.json)
fs.writeFileSync(path.join(ACEVO_DATA, 'setup-meta.json'), JSON.stringify({ v: 1, files: { [REL.B]: { from: 'paddock', basedOn: 'Base', basedOnRel: REL.A } } }));
const allSetupFiles = () => {
  const out = {};
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out[path.relative(process.env.ACE_DIR, p)] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } };
  walk(path.join(process.env.ACE_DIR, 'Car Setups'));
  return out;
};
const setupsBefore = allSetupFiles();

const setups = await import('../src/setups.js');
const ex = await import('../src/experiments.js');
let game = '1.0';
ex.configure({ gameVersion: () => game });

db.saveSnapshot('sa000000000000aa', { name: 'Base', rel: REL.A, values: { pressure_FL: 26.5, camber_FL: -3.2, rear_wing_angle: 6 } });
db.saveSnapshot('sb000000000000bb', { name: 'Wing', rel: REL.B, values: { pressure_FL: 26.5, camber_FL: -3.2, rear_wing_angle: 8 } });
const SNAP = { A: 'sa000000000000aa', B: 'sb000000000000bb' };
const noise = (i, s) => [0, 120, -90, 60, -150, 30, 90, -60][(i * 3 + s) % 8];
/** One stint's session: n laps on setup v, recognised as that file; B 600 ms quicker on the typical lap. */
function drive(v, s, n = 6, { startedAt = 3e9 + s * 1e7, gameV = '1.0' } = {}) {
  const sid = db.createSession({ ...COMBO, sessionType: 0, driver: 'Me', startedAt });
  const ids = [];
  for (let i = 0; i < n; i++) {
    const id = insertLap(db, { sessionId: sid, lapNumber: i + 1, recordedAt: startedAt + (i + 1) * 6e4 });
    db.raw.prepare('UPDATE laps SET lap_time_ms = ? WHERE id = ?').run(60000 + (v === 'B' ? -600 : 0) + noise(i, s) + (i === 0 ? 3000 : 0), id);
    db.setLapCond(id, { game: gameV, roadC: 30, airC: 20 });
    ids.push(id);
  }
  db.setLapSetups(ids, { name: v === 'A' ? 'Base' : 'Wing', rel: REL[v], match: 'matched', snap: SNAP[v] });
  return { sid, ids };
}
const stints = ['A', 'B', 'B', 'A'].map((v, s) => ({ v, ...drive(v, s) }));

const make = (extra = {}) => ex.create({ combo: COMBO, title: 'More rear wing', hypothesis: 'Two more degrees of rear wing calm the exit of T2.',
  expected: { metric: 'pace', direction: 'better', text: 'Quicker exits, about 0.3 s' }, a: { rel: REL.A }, b: { rel: REL.B }, plan: { pattern: 'ABBA', lapsPerStint: 6, warmup: 1 }, ...extra });

test('options: the setups driven here (setup history) with their ancestry, Standard, and the sessions that can become stints', () => {
  const o = ex.options(COMBO);
  assert.deepEqual(o.variants.map((v) => v.label).sort(), ['Base', 'Standard', 'Wing']);
  const wing = o.variants.find((v) => v.rel === REL.B);
  assert.equal(wing.snap, SNAP.B, 'the recorded values identify it (the file is not readable without the car)');
  assert.deepEqual(wing.lineage.map((l) => l.name), ['Wing', 'Base'], 'saved from Base');
  assert.equal(o.sessions.length, 4);
  assert.equal(o.game, '1.0');
});

test('create: validated, A and B from this car + track only, the change between them in the journal; never trusts sent values', () => {
  assert.throws(() => make({ title: '' }), /A title is needed/);
  assert.throws(() => make({ b: { rel: REL.A } }), /two different setups/);
  assert.throws(() => make({ b: { rel: 'Other/Track/X.carsetup', snap: 'forged' } }), /not a setup of this car and track/);
  assert.throws(() => make({ expected: { metric: 'speed' } }), /Unknown expected measure/);
  const d = make();
  assert.equal(d.status, 'planned');
  assert.equal(d.game, '1.0');
  assert.deepEqual([d.variants.A.label, d.variants.B.label, d.variants.B.snap], ['Base', 'Wing', SNAP.B]);
  assert.deepEqual(d.changes.changed.map((c) => [c.name, c.a, c.b]), [['rear_wing_angle', 6, 8]]);
  assert.equal(d.entries[0].kind, 'event');
  assert.equal(d.entries[0].data.changes.length, 1);
  assert.deepEqual(d.plan.sequence, ['A', 'B', 'B', 'A']);
  assert.equal(d.plan.next, 'A');
  assert.equal(d.result.comparison.kind, 'inconclusive', 'no stint yet');
  return ex.remove(d.id);
});

let expId;
test('run: four past sessions as ABBA stints; the result from typical laps with warm-up laps left out and counts shown', async () => {
  const d0 = make();
  expId = d0.id;
  for (const s of stints) await ex.addSession(expId, s.v, s.sid);
  await assert.rejects(ex.addSession(expId, 'A', stints[0].sid), /already a stint/);
  const d = ex.detail(expId);
  assert.equal(d.status, 'running');
  assert.equal(d.plan.done, 4);
  assert.equal(d.plan.complete, true);
  const r = d.result;
  assert.equal(r.variants.A.used, 10);
  assert.equal(r.variants.B.used, 10);
  assert.equal(r.variants.A.excluded.warmup, 2);
  assert.equal(r.comparison.kind, 'difference');
  assert.equal(r.comparison.faster, 'B');
  assert.equal(r.expected.status, 'supported');
  assert.equal(r.excludedTotal, 4);
  assert.deepEqual(d.warnings.map((w) => w.key), ['file-A', 'file-B'], 'the values of the files cannot be read here: said, not hidden');
});

test('stints in real time: one open stint per car + track; laps driven during it count; feedback and notes are journaled', async () => {
  const other = make({ title: 'Softer rear bar' });
  await ex.startStint(expId, 'B', 9e9);
  await assert.rejects(ex.startStint(expId, 'A', 9e9 + 1), /already running/);
  await assert.rejects(ex.startStint(other.id, 'A', 9e9 + 2), (e) => e.status === 409 && e.code === 'open' && e.other === expId);
  const { ids } = drive('B', 9, 3, { startedAt: 9e9 + 10 });
  const mid = ex.detail(expId, 9e9 + 1e6);
  assert.equal(mid.plan.open.variant, 'B');
  assert.equal(mid.result.laps.filter((l) => ids.includes(l.id)).length, 3, 'the open stint takes the laps driven since it started');
  await ex.endStint(expId, 9e9 + 2e6);
  ex.feedback(expId, { variant: 'B', phase: 'exit', balance: 'neutral', corner: 'T2', note: 'Calmer on the throttle' });
  ex.feedback(expId, { variant: 'A', phase: 'exit', balance: 'oversteer', corner: 'T2' });
  assert.throws(() => ex.feedback(expId, { variant: 'B', phase: 'apex', balance: 'neutral' }), /Pick entry, mid-corner or exit/);
  ex.note(expId, 'Same fuel (30 l) for every stint.');
  const d = ex.detail(expId);
  assert.equal(d.result.feedback.B.exit.neutral, 1);
  assert.equal(d.result.feedback.A.exit.oversteer, 1);
  assert.ok(d.entries.some((e) => e.kind === 'journal' && /Same fuel/.test(e.data.text)));
  assert.ok(d.entries.some((e) => e.kind === 'event' && /never changes the game's setup/.test(e.data.text)));
  // that stint was a test: taken out again
  await ex.removeStint(expId, d.stints.find((s) => s.startAt === 9e9).id);
  await ex.remove(other.id);
});

test('review saves the result with the decision; later lap changes do not rewrite it; a game update is flagged; archive and restore', async () => {
  await assert.rejects(ex.review(expId, { decision: 'maybe' }), /Unknown decision/);
  const d = await ex.review(expId, { decision: 'keep-b', conclusion: 'Wing stays for the race.' });
  assert.equal(d.status, 'reviewed');
  assert.equal(d.saved, true);
  assert.equal(d.decision, 'keep-b');
  assert.equal(d.result.comparison.faster, 'B');
  await assert.rejects(ex.startStint(expId, 'A'), /reviewed: reopen it/);
  // a counted lap deleted afterwards: the saved result stays, the page is told the laps changed
  db.deleteLap(stints[1].ids[3]);
  const d2 = ex.detail(expId);
  assert.equal(d2.result.variants.B.used, 10);
  assert.equal(d2.liveDiffers, true);
  game = '1.1';
  assert.ok(ex.detail(expId).warnings.some((w) => w.key === 'patch' && /AC EVO was updated .*1\.0, now 1\.1/.test(w.text)));
  game = '1.0';
  // a follow-up keeps its ancestry
  const f = make({ title: 'Even more wing', parentId: expId });
  assert.equal(f.parent.id, expId);
  assert.deepEqual(ex.detail(expId).children.map((c) => c.id), [f.id]);
  const a = await ex.archive(expId);
  assert.equal(a.status, 'archived');
  assert.throws(() => ex.note(expId, 'x'), /archived/);
  assert.equal(ex.list({ combo: COMBO }).experiments.find((x) => x.id === expId).status, 'archived');
  assert.equal((await ex.restore(expId)).status, 'reviewed');
  assert.equal((await ex.reopen(expId)).status, 'running');
  await ex.remove(f.id);
  assert.equal(db.getExperiment(f.id), null);
});

test('.carsetup files: experiments never write one; export is byte-identical; a rename keeps the bytes and the ancestry', () => {
  assert.deepEqual(allSetupFiles(), setupsBefore, 'no setup file written, changed or added by the experiments above');
  const base = setups.scan(true).find((f) => f.rel === REL.A);
  assert.ok(setups.exportFile(base.id).buf.equals(carsetup(0)), 'export = the file, byte for byte');
  const wing = setups.scan().find((f) => f.rel === REL.B);
  assert.ok(setups.exportFile(wing.id).buf.equals(carsetup(1)));
  // import of a setup for a car that is not installed here: refused, nothing written
  assert.throws(() => setups.importFile(carsetup(2), { filename: 'Fixture GT - Fixture Ring - Shared.carsetup' }), /not installed/);
  assert.deepEqual(allSetupFiles(), setupsBefore);
  // renaming the parent: the file's bytes are unchanged and Wing still descends from it
  setups.update(base.id, { name: 'Base v2' });
  const moved = path.join(SETUPS, 'Base v2.carsetup');
  assert.ok(fs.readFileSync(moved).equals(carsetup(0)));
  assert.deepEqual(setups.lineage(REL.B).map((l) => l.name), ['Wing', 'Base v2']);
});

// ---- PL8 review fixes
test('review 4: a .carsetup imported, exported and copied to another track stays byte-identical; the copy records its ancestry', () => {
  setups.useCatalogs({ cars: () => [{ id: 'fixture_gt', brand: 'Fixture', name: 'GT' }], tracks: () => [{ id: 'fixture_ring', name: 'Fixture Ring' }, { id: 'other_ring', name: 'Other Ring' }] });
  try {
    const buf = carsetup(5);
    const imp = setups.importFile(buf, { filename: 'Fixture GT - Fixture Ring - Shared.carsetup' });
    assert.equal(imp.name, 'Shared');
    const file = path.join(SETUPS, 'Shared.carsetup');
    assert.ok(fs.readFileSync(file).equals(buf), 'imported = the file sent, byte for byte');
    const ex1 = setups.exportFile(imp.id);
    assert.ok(ex1.buf.equals(buf), 'exported = imported');
    assert.equal(ex1.filename, 'Fixture GT - Fixture Ring - Shared.carsetup', 'the export name imports back to the same car, track and name');
    const copy = setups.copyTo(imp.id, 'other_ring');
    const copied = path.join(process.env.ACE_DIR, 'Car Setups', 'Fixture GT', 'Other Ring', 'Shared [Fixture Ring].carsetup');
    assert.ok(fs.readFileSync(copied).equals(buf), 'the copy for another track is byte-identical');
    assert.ok(setups.exportFile(copy.id).buf.equals(buf));
    assert.deepEqual(setups.lineage(copy.rel).map((l) => [l.name, l.track]), [['Shared [Fixture Ring]', 'Other Ring'], ['Shared', 'Fixture Ring']]);
  } finally { setups.useCatalogs(null); }
});

test('review 2: overlapping stints are refused (a window that ends after now; a session inside a window)', async () => {
  const d = make({ title: 'Overlap check' });
  await ex.startStint(d.id, 'A', 7e9);
  const { sid } = drive('A', 20, 3, { startedAt: 7e9 + 10 });
  await ex.endStint(d.id, 7e9 + 1e6);
  await assert.rejects(ex.addSession(d.id, 'B', sid), (e) => e.status === 409 && /overlaps stint 1 \(A\)/.test(e.message));
  await assert.rejects(ex.startStint(d.id, 'B', 7e9 + 5e5), /ends after now/);
  const r = ex.detail(d.id, 7e9 + 2e6).result;
  assert.equal(r.laps.length, 3, 'each lap once');
  await ex.remove(d.id);
});

test('review 6: prototype keys are refused as patterns, measures, setups, phases and decisions', async () => {
  const d = make({ title: 'Keys', plan: { pattern: 'constructor' }, expected: { metric: 'pace', direction: 'better' } });
  assert.equal(d.plan.pattern, 'ABBA');
  assert.throws(() => make({ expected: { metric: 'constructor' } }), /Unknown expected measure/);
  assert.throws(() => make({ expected: { direction: 'toString' } }), /Unknown expected direction/);
  await assert.rejects(ex.startStint(d.id, 'constructor'), /Pick A or B/);
  assert.throws(() => ex.feedback(d.id, { variant: 'A', phase: 'constructor', balance: 'neutral' }), /Pick entry/);
  assert.throws(() => ex.feedback(d.id, { variant: 'toString', phase: 'entry', balance: 'neutral' }), /Pick A or B/);
  await ex.addSession(d.id, 'A', stints[0].sid);
  await assert.rejects(ex.review(d.id, { decision: 'constructor' }), /Unknown decision/);
  assert.equal(ex.list({ combo: COMBO }).experiments.find((x) => x.id === d.id).plan.sequence.join(''), 'ABBA');
  await ex.remove(d.id);
});
