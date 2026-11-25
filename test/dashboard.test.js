// Home dashboard data (src/service.js dashboard): every number traceable to the stored laps and reports; nothing
// invented when there is no data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isolate, seedRandom } from './helpers.js';

isolate('dashboard');
seedRandom(5);
const db = await import('../src/db.js');
const svc = await import('../src/service.js');
const report = await import('../src/report.js');
const { seedLaps } = await import('../src/mock.js');

test('no laps: zeros and empty lists, no made-up values', () => {
  const d = svc.dashboard();
  assert.equal(d.totals.laps, 0);
  assert.equal(d.totals.lastAt, null);
  assert.deepEqual([d.recentSessions, d.records, d.trends, d.targets], [[], [], [], []]);
});

await seedLaps(6);
const sid = db.listSessions()[0].id;
report.make(sid);
svc.invalidate();

test('totals and records match the stored laps', () => {
  const laps = db.listLaps();
  const valid = laps.filter((l) => l.valid);
  const d = svc.dashboard();
  assert.equal(d.totals.laps, laps.length);
  assert.equal(d.totals.validLaps, valid.length);
  assert.equal(d.totals.sessions, 1);
  assert.equal(d.totals.drivingMs, laps.reduce((a, l) => a + l.lap_time_ms, 0));
  assert.equal(d.totals.last7, laps.length);
  assert.equal(d.records.length, 1);
  const r = d.records[0];
  assert.equal(r.bestMs, Math.min(...valid.map((l) => l.lap_time_ms)));
  assert.equal(r.idealMs, svc.overview().combos[0].idealMs);
  assert.ok(r.idealMs <= r.bestMs);
});

test('recent sessions carry the report summary', () => {
  const d = svc.dashboard();
  const s = d.recentSessions[0];
  const rep = db.getReport(sid).data;
  assert.equal(s.id, sid);
  assert.equal(s.bestMs, rep.best.ms);
  assert.equal(s.report.consistency, rep.consistency.score);
  assert.equal(s.report.avgCleanMs, rep.average.cleanMs);
});

test('trend = best lap per driving day (from Progress); targets from the newest report', () => {
  const d = svc.dashboard();
  assert.equal(d.trends.length, 1);
  const p = svc.progress(d.trends[0]);
  assert.deepEqual(d.trends[0].days.map((x) => x.bestMs), p.days.map((x) => x.bestMs));
  assert.equal(d.targets.length, 1);
  assert.deepEqual(d.targets[0].targets.map((t) => t.text), db.getReport(sid).data.targets.map((t) => t.text));
  assert.equal(d.targets[0].lastCheck, null, 'the first report has no earlier targets to check');
});

test('a second driving day, an imported lap and a second report', async () => {
  // move the first session three days back, then drive a second one today
  const raw = new DatabaseSync(path.join(process.env.ACEVO_DATA, 'telemetry.db'));
  raw.prepare('UPDATE laps SET recorded_at = recorded_at - ? WHERE session_id = ?').run(3 * 86400e3, sid);
  raw.prepare('UPDATE sessions SET started_at = started_at - ? WHERE id = ?').run(3 * 86400e3, sid);
  raw.close();
  report.make(sid); // its report again, with the moved start
  await seedLaps(5);
  const sid2 = db.listSessions().find((s) => s.id !== sid).id;
  const first = db.getLap(db.listLaps().find((l) => l.session_id === sid).id);
  db.insertLap({ ...first, data: first.data, sessionId: null, lapNumber: 1, lapTimeMs: 1000, valid: true, source: 'import', recordedAt: Date.now(), trackLength: first.track_length });
  report.make(sid2);
  svc.invalidate();
  const d = svc.dashboard();
  const local = db.listLaps().filter((l) => l.source === 'local');
  assert.equal(d.totals.laps, local.length, 'imported laps are not yours');
  assert.equal(d.totals.days, 2);
  assert.ok(d.records[0].bestMs > 1000, 'the imported 1-second lap is not a record');
  assert.equal(d.recentSessions[0].id, sid2, 'newest first');
  assert.equal(d.trends[0].days.length, 2);
  assert.equal(d.trends[0].days[0].newBest, false, 'the first day sets the first best: not a "new" one');
  assert.equal(d.targets.length, 1, 'one combo: one set of targets');
  assert.equal(d.targets[0].sessionId, sid2, 'from the newest report');
  const pt = db.getReport(sid2).data.prevTargets;
  assert.ok(pt?.items?.length, 'the second report checks the first one\'s targets');
  const known = pt.items.filter((t) => t.met === true || t.met === false);
  assert.deepEqual(d.targets[0].lastCheck, known.length ? { met: known.filter((t) => t.met).length, of: known.length } : null);
});

test('invalidate(combo) recomputes that combo only', () => {
  const c = svc.dashboard().records[0];
  const before = svc.progress(c);
  assert.equal(svc.progress(c), before, 'cached');
  svc.invalidate({ track: 'other', layout: 'x', car: 'y' });
  assert.equal(svc.progress(c), before, 'another combo: still cached');
  svc.invalidate(c);
  assert.notEqual(svc.progress(c), before, 'this combo: worked out again');
  assert.deepEqual(svc.progress(c), before, 'same data, same answer');
});

test('old laps fall out of "last 7 days" by the clock given', () => {
  const d = svc.dashboard({ now: Date.now() + 8 * 86400e3 });
  assert.equal(d.totals.last7, 0);
  assert.equal(d.totals.last30, d.totals.laps);
});

// ---------------------------------------------------------------- PL5: next step and recent progress
test('next step: from the last session, with evidence quoting stored values only', () => {
  const d = svc.dashboard();
  const a = d.nextAction, last = d.recentSessions[0], rec = d.records.find((r) => r.track === last.track && r.layout === last.layout && r.car === last.car);
  assert.ok(a, 'a session exists: a next step');
  assert.deepEqual([a.track, a.layout, a.car], [last.track, last.layout, last.car]);
  assert.ok(a.evidence && a.href && a.label);
  if (a.kind === 'corner' || a.kind === 'ideal') {
    assert.equal(a.gapMs, rec.bestMs - rec.idealMs);
    assert.ok(a.evidence.includes((a.gapMs / 1000).toFixed(3)));
    assert.ok(a.href.startsWith(`#/compare?laps=${rec.bestLapId}&ref=ideal`));
  }
  if (a.kind === 'corner') assert.equal(a.corner, last.report.weakest[0]);
});

test('next step rules: no report -> a longer session; no gap -> progress; nothing -> null', () => {
  assert.equal(svc.nextStep(null, []), null);
  const s = { id: 9, track: 't', layout: 'l', car: 'c', laps: 2, validLaps: 1, report: null };
  const a = svc.nextStep(s, []);
  assert.equal(a.kind, 'longer');
  assert.match(a.evidence, /2 laps, 1 valid/);
  const r = svc.nextStep({ ...s, laps: 5, validLaps: 4 }, []);
  assert.equal(r.kind, 'report', 'long enough, not opened yet: open the report (it is made then)');
  assert.equal(r.href, '#/report?session=9&tab=report');
  assert.equal(svc.nextStep({ ...s, laps: 5, validLaps: 0 }, []).kind, 'longer', 'no valid lap: no report possible');
  const withReport = { ...s, report: { weakest: ['T1'] } };
  assert.equal(svc.nextStep(withReport, [{ key: 't|l|c', bestMs: 60000, idealMs: 60000, bestLapId: 1 }]).kind, 'progress', 'best = ideal: nothing to compare');
  assert.match(svc.nextStep(withReport, [{ key: 't|l|c', bestMs: 60000, idealMs: 60000, bestLapId: 1 }]).evidence, /matches your ideal/);
  // review: no ideal lap known -> never claims best = ideal
  const noIdeal = svc.nextStep(withReport, [{ key: 't|l|c', bestMs: 60000, idealMs: null, bestLapId: 1 }]);
  assert.equal(noIdeal.kind, 'progress');
  assert.doesNotMatch(noIdeal.evidence, /matches/);
  assert.match(noIdeal.evidence, /no ideal lap/);
  const c = svc.nextStep(withReport, [{ key: 't|l|c', bestMs: 60500, idealMs: 60000, bestLapId: 7 }]);
  assert.equal(c.kind, 'corner');
  assert.equal(c.href, '#/compare?laps=7&ref=ideal&c=T1');
  assert.equal(svc.nextStep({ ...s, report: { weakest: [] } }, [{ key: 't|l|c', bestMs: 60500, idealMs: 60000, bestLapId: 7 }]).kind, 'ideal');
});

test('recent progress: new bests in the last 30 days, a first visit is not progress', () => {
  const d = svc.dashboard();
  assert.equal(d.recentProgress.days, 30);
  assert.equal(d.recentProgress.combos, 1);
  assert.equal(d.recentProgress.newBests, 0, 'every lap is from the last 30 days: nothing to beat from before');
  assert.equal(d.recentProgress.latest.length, d.recentProgress.newBests);
  // 40 days on: nothing in the window
  assert.deepEqual(svc.dashboard({ now: Date.now() + 40 * 86400e3 }).recentProgress, { days: 30, combos: 0, newBests: 0, latest: [] });
});
