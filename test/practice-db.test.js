// PL7: the v2 -> v3 database upgrade (practice drills) on a database in the PL5/PL6 layout (test/fixtures/db-v2-pl6.sql),
// then the practice loop end to end (src/drills.js over src/service.js and src/practice.js) on synthetic laps with
// known patterns (test/lapfixtures.js): a drill made from a lap-analysis finding, judged on the passes driven after
// it started, met, slipping, a review point, keep practising, stop, one drill at a time, game versions left out.
//
// The fixture laps (as in test/lapanalysis.test.js): 12 laps in 3 sessions; T2: 8 of 12 laps hold half throttle for
// 50 m after the corner (the 4 others are the quicker quarter); T1: 8 of 12 brake early and soft.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isolate, ROOT } from './helpers.js';
import { COMBO, insertLap } from './lapfixtures.js';

const { ACEVO_DATA } = isolate('practice-db');
const tableInfo = (d) => Object.fromEntries(d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
  .map((t) => [t.name, d.prepare(`PRAGMA table_info(${t.name})`).all().map((c) => `${c.name}:${c.type}`).join(',')]));
let before;
{
  const old = new DatabaseSync(path.join(ACEVO_DATA, 'telemetry.db'));
  old.exec(fs.readFileSync(path.join(ROOT, 'test/fixtures/db-v2-pl6.sql'), 'utf8'));
  old.exec("INSERT INTO goals (track, layout, car, kind, target, extra, origin, created_at) VALUES ('trk', 'gp', 'car', 'lap', 59000, '{}', 'me', 1)");
  old.exec("INSERT INTO coach_messages (track, layout, car, role, text, created_at) VALUES ('trk', 'gp', 'car', 'driver', 'hello', 1)");
  before = tableInfo(old);
  old.close();
}

const db = await import('../src/db.js');
const svc = await import('../src/service.js');
const goals = await import('../src/goals.js');
const drills = await import('../src/drills.js');

test('v2 -> v3 (and on to v4, PL8): one copy first, data kept, only the drill_events and setup experiment tables added', () => {
  const copies = fs.readdirSync(ACEVO_DATA).filter((f) => f.startsWith('telemetry.backup-'));
  assert.equal(copies.length, 1);
  assert.match(copies[0], /^telemetry\.backup-v2-\d+\.db$/);
  const c = new DatabaseSync(path.join(ACEVO_DATA, copies[0]), { readOnly: true });
  assert.equal(c.prepare('PRAGMA user_version').get().user_version, 2, 'the copy is the old file');
  assert.equal(c.prepare('SELECT COUNT(*) AS n FROM goals').get().n, 1);
  c.close();
  assert.equal(db.SCHEMA_VERSION, 4);
  assert.equal(db.counts().schema, 4);
  assert.equal(db.listGoals().length, 1);
  assert.equal(db.coachMessages({ track: 'trk', layout: 'gp', car: 'car' }).length, 1);
  const after = tableInfo(db.raw);
  for (const [t, cols] of Object.entries(before)) assert.equal(after[t], cols, `table ${t} unchanged`);
  assert.deepEqual(Object.keys(after).filter((t) => !(t in before)).sort(), ['drill_events', 'experiment_entries', 'setup_experiments']);
  assert.equal(db.blocked, null);
});

// ---- the fixture laps, all on game version 1.0
const params = (i) => ({ brake: [i % 3 !== 0 ? 0.75 : 1, 1, 1], hold: [0, i % 3 !== 1 ? 50 : 0, 0], gear: [0, i % 3 !== 1 ? 1 : 0, 0] });
const setGame = (id, game) => db.setLapCond(id, { game });
const ses = [0, 1, 2].map((s) => db.createSession({ ...COMBO, sessionType: 0, driver: 'Me', startedAt: 1e9 + s * 1e6 }));
for (let i = 1; i <= 12; i++) setGame(insertLap(db, { sessionId: ses[Math.floor((i - 1) / 4)], lapNumber: i, recordedAt: 1e9 + i * 1e5, params: params(i) }), '1.0');
svc.invalidate();
const T0 = 2e9; // the first drill starts here, after every fixture lap
let lapNo = 100;
/** n laps driven from time `at` in a new session (game version 1.0 unless said), with these corner parameters. */
function drive(n, at, p, game = '1.0') {
  const sid = db.createSession({ ...COMBO, sessionType: 0, driver: 'Me', startedAt: at });
  const ids = [];
  for (let i = 1; i <= n; i++) { const id = insertLap(db, { sessionId: sid, lapNumber: lapNo++, recordedAt: at + i * 1e5, params: p }); setGame(id, game); ids.push(id); }
  svc.invalidate(COMBO); // what the recorder does after each lap
  return ids;
}
const GOOD_T2 = { hold: [0, 0, 0] }, BAD_T2 = { hold: [0, 50, 0] };
let first;

test('a drill from a finding: all six parts of the prescription, numbers from the analysis, not judged before 5 passes', async () => {
  const a = await svc.lapAnalysisAsync(COMBO);
  const t2 = a.corners.find((c) => c.name === 'T2');
  assert.ok(t2.findings.some((f) => f.key === 'holdMs'));
  first = await drills.create({ combo: COMBO, corner: 'T2', key: 'holdMs' }, T0);
  const p = first.prescription;
  assert.equal(first.state, 'collecting');
  assert.equal(first.active, true);
  assert.match(p.issue, /^T2: Your typical pass holds the throttle part-way/);
  assert.match(p.evidence.text, /^12 valid passes of T2 in 12 laps \(3 sessions\); confidence medium\. Opportunity #1/);
  assert.equal(p.evidence.typical, t2.typical.holdMs, 'quoted from the analysis');
  assert.equal(p.evidence.fast, t2.fast.holdMs);
  assert.equal(p.evidence.game, '1.0');
  assert.match(p.exercise, /^In T2, after the slowest point, push the throttle steadily to full/);
  assert.equal(p.criterion.target, Math.round(t2.fast.holdMs));
  assert.match(p.criterion.text, /^At least half of your newest 10 passes of T2 have a part-throttle time on the exit of \d\.\d\d\d? s or less\.$/);
  assert.match(p.minEvidence.text, /^5 valid passes of T2 since the drill started/);
  assert.match(p.review.text, /^After 10 passes without meeting the target/);
  assert.match(p.hypothesis, /\bmay\b/, 'the interpretation stays hedged');
  // before: the quicker passes (4 of 12) reach the target, the others do not
  assert.equal(p.before.n, 12);
  assert.equal(p.before.meeting, 4);
  // a goals row of kind 'drill' (P9), kept out of the goal lists, Home and achievements
  const g = db.getGoal(first.id);
  assert.equal(g.kind, 'drill');
  assert.equal(g.origin, 'analysis');
  assert.ok(!goals.list().some((x) => x.kind === 'drill'));
  assert.equal(goals.describe(g), p.criterion.text);
});

test('one drill at a time per car + track: a second one is refused unless it replaces the first', async () => {
  await assert.rejects(drills.create({ combo: COMBO, corner: 'T1', key: 'brakePoint' }, T0 + 1), (e) => e.status === 409 && e.code === 'active' && e.active.id === first.id);
  // a finding that is not in the analysis, or a key that cannot be drilled: refused
  await assert.rejects(drills.create({ combo: COMBO, corner: 'T3', key: 'holdMs', replace: true }, T0 + 1), (e) => e.status === 409);
  await assert.rejects(drills.create({ combo: COMBO, corner: 'T2', key: 'coastM' }), (e) => e.status === 400);
  await assert.rejects(drills.create({ combo: { track: 'nowhere', layout: '', car: 'x' }, corner: 'T1', key: 'brakePoint' }), (e) => e.status === 404);
});

test('met by behaviour: 4 good passes are not enough, the 5th meets it; before against after is stored', async () => {
  const ids = drive(4, T0 + 1e6, GOOD_T2);
  let d = (await drills.list({ combo: COMBO })).drills.find((x) => x.id === first.id);
  assert.equal(d.state, 'collecting');
  assert.equal(d.eval.sinceRestart, 4);
  ids.push(...drive(1, T0 + 2e6, GOOD_T2));
  const out = await drills.list({ combo: COMBO });
  d = out.drills.find((x) => x.id === first.id);
  assert.equal(d.state, 'met');
  assert.equal(d.active, false);
  assert.equal(d.met.lapId, ids[4], 'met on the 5th pass');
  assert.equal(d.eval.share, 1);
  assert.equal(d.eval.change.shareBefore, Math.round((4 / 12) * 1000) / 1000);
  assert.equal(d.eval.change.time.verdict, 'faster', 'the corner time is shown as context');
  // stored as a met goal and a 'met' event: the result stays when the laps go
  assert.equal(db.getGoal(first.id).met.lapId, ids[4]);
  assert.deepEqual(db.drillEvents().get(first.id).map((e) => e.kind), ['met']);
  assert.equal(out.summary.met, 1);
  assert.equal(out.summary.results[0].shareAfter, 1);
});

test('slipping after it was met: a revisit suggestion, and the corner shows "Revisit"', async () => {
  drive(5, T0 + 3e6, BAD_T2);
  const out = await drills.list({ combo: COMBO });
  const d = out.drills.find((x) => x.id === first.id);
  assert.equal(d.state, 'met', 'met stays met');
  assert.equal(d.slip.slipping, true);
  assert.equal(d.slip.share, 0);
  assert.deepEqual(out.revisits.map((r) => [r.id, r.corner]), [[first.id, 'T2']]);
  const m = await drills.masteryFor(COMBO, out.drills);
  assert.equal(m.find((x) => x.name === 'T2').level, 'revisit');
  assert.equal(m.find((x) => x.name === 'T2').drillsMet, 1);
});

let second;
test('a review point after 10 passes without meeting it; keep practising judges the next passes afresh; stop', async () => {
  // the same corner, another behaviour: the exit speed (the met hold drill there stays met)
  second = await drills.create({ combo: COMBO, corner: 'T2', key: 'exitSpeed' }, T0 + 4e6);
  assert.equal(second.state, 'collecting');
  assert.equal(second.prescription.criterion.better, 'higher', 'the quicker passes leave the corner faster');
  // an active drill there: the corner shows "Practising" (before "Revisit")
  let out = await drills.list({ combo: COMBO });
  assert.equal((await drills.masteryFor(COMBO, out.drills)).find((x) => x.name === 'T2').level, 'practising');
  const early = BAD_T2; // the hold costs exit speed: no pass reaches the target
  drive(6, T0 + 5e6, early);
  out = await drills.list({ combo: COMBO });
  assert.equal(out.drills.find((x) => x.id === second.id).state, 'practising');
  await assert.rejects(drills.keep(second.id), (e) => e.status === 409, 'no review point yet');
  drive(4, T0 + 6e6, early);
  out = await drills.list({ combo: COMBO });
  let d = out.drills.find((x) => x.id === second.id);
  assert.equal(d.state, 'review');
  assert.equal(d.eval.share, 0);
  assert.equal(out.summary.review, 1);
  d = await drills.keep(second.id, T0 + 7e6);
  assert.equal(d.state, 'collecting');
  assert.equal(d.eval.passes, 10, 'the earlier passes are still counted as driven');
  assert.equal(d.eval.sinceRestart, 0, 'but not judged');
  d = await drills.stop(second.id, T0 + 8e6);
  assert.equal(d.state, 'stopped');
  assert.equal(d.active, false);
  await assert.rejects(drills.stop(second.id), (e) => e.status === 409);
  assert.deepEqual(db.drillEvents().get(second.id).map((e) => e.kind), ['restart', 'stopped']);
});

test('laps on another game version do not count towards a drill; replace closes the old one as replaced', async () => {
  // most newest laps still hold the throttle at T2: the hold finding is still there
  const a = await svc.lapAnalysisAsync(COMBO);
  const t2 = a.corners.find((c) => c.name === 'T2');
  assert.ok(t2.rank && t2.findings.some((f) => f.key === 'holdMs'), JSON.stringify(t2.findings?.map((f) => f.key)));
  const d1 = await drills.create({ combo: COMBO, corner: 'T2', key: 'holdMs' }, T0 + 9e6);
  const d2 = await drills.create({ combo: COMBO, corner: 'T2', key: 'holdMs', replace: true }, T0 + 9e6 + 1);
  assert.deepEqual(db.drillEvents().get(d1.id).map((e) => e.kind), ['replaced']);
  drive(5, T0 + 10e6, GOOD_T2, '2.0');
  const d = (await drills.list({ combo: COMBO })).drills.find((x) => x.id === d2.id);
  assert.equal(d.state, 'collecting');
  assert.equal(d.eval.passes, 0);
  assert.equal(d.eval.excluded, 5);
  assert.deepEqual(d.eval.excludedReasons, ['another game version']);
  // deleting the drill deletes its history
  await drills.remove(d1.id);
  assert.equal(db.getGoal(d1.id), null);
  assert.equal(db.drillEvents().get(d1.id), undefined);
});

test('two pages working the drills out at once record "met" once and announce it once', async () => {
  // the newest laps are on game version 2.0: the drill's "before" is those laps only (5 good ones so far, so 6 more
  // with the hold first, or it would already be reached)
  drive(6, T0 + 11e6, BAD_T2, '2.0');
  const d = await drills.create({ combo: COMBO, corner: 'T2', key: 'holdMs', replace: true }, T0 + 11.5e6);
  assert.equal(d.prescription.evidence.game, '2.0');
  assert.equal(d.prescription.before.n, 11);
  drive(5, T0 + 12e6, GOOD_T2, '2.0');
  const told = [];
  drills.setOnMet((x) => told.push(x.id));
  const [a, b] = await Promise.all([drills.list({ combo: COMBO }), drills.list({ combo: COMBO })]);
  assert.equal(a.drills.find((x) => x.id === d.id).state, 'met');
  assert.equal(b.drills.find((x) => x.id === d.id).state, 'met');
  assert.deepEqual(db.drillEvents().get(d.id).map((e) => e.kind), ['met']);
  assert.deepEqual(told, [d.id]);
  drills.setOnMet(() => {});
});

test('the practice loop works with AI off: no AI module in it, and no AI key set', () => {
  for (const f of ['src/practice.js', 'src/drills.js', 'public/practice.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(!/from '\.\/(ai|coach)\.js'/.test(src), `${f} does not import the AI`);
  }
  assert.ok(!fs.existsSync(path.join(ACEVO_DATA, 'settings.json')) || !/geminiApiKey"\s*:\s*"[^"]/.test(fs.readFileSync(path.join(ACEVO_DATA, 'settings.json'), 'utf8')));
});
