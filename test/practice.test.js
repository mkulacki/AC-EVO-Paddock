// PL7 structured practice, the pure rules (src/practice.js): when a pass reaches a drill's target, how a prescription
// is built from a lap-analysis corner row, when a drill is judged, met, at its review point or slipping, corner mastery
// and the progress summary. Hand-written numbers, no database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as practice from '../src/practice.js';

const { PRACTICE, METRICS } = practice;
// a corner row as src/opportunities.js makes it: typical passes hold the throttle 600 ms, the quicker quarter 100 ms
const row = (o = {}) => ({ name: 'T2', n: 2, apex: 900, passes: 12, confidence: 'medium', sufficient: true, rank: 1, mainPhase: 'exit', fastPasses: 3,
  gain: { realisticMs: 120, idealMs: 200 }, typical: { holdMs: 600, brakePoint: 300, minSpeed: 80, releaseBumps: 1 }, fast: { holdMs: 100, brakePoint: 312, minSpeed: 84, releaseBumps: 0 },
  gearChoice: { typ: 3, fast: 2 }, ...o });
const finding = (key) => ({ key, kind: 'x', observation: `observed ${key}`, interpretation: `It may help (${key}).` });
const analysis = { sample: { laps: 12, sessions: 3, from: 1, to: 2 }, window: 'recent', windowSize: 30 };
// baseline passes: 3 of 12 reach the target
const base = (vals) => vals.map((v, i) => ({ lapId: i + 1, v, timeMs: 10000 + v }));
const HOLD = [100, 90, 120, 600, 620, 580, 650, 600, 610, 590, 640, 700];

test('meets: higher / lower with half the naming threshold as tolerance; gears exactly', () => {
  const lower = { key: 'holdMs', better: 'lower', target: 100, tol: METRICS.holdMs.tol };
  assert.equal(METRICS.holdMs.tol, 75);
  assert.ok(practice.meets(lower, 175) && !practice.meets(lower, 176));
  assert.equal(practice.threshold(lower), 175);
  const higher = { key: 'brakePoint', better: 'higher', target: 312, tol: 2.5 };
  assert.ok(practice.meets(higher, 309.5) && !practice.meets(higher, 309.4));
  assert.ok(!practice.meets(higher, null) && !practice.meets(higher, NaN));
  const gear = { key: 'minGear', target: 2, tol: 0 };
  assert.ok(practice.meets(gear, 2) && !practice.meets(gear, 1) && !practice.meets(gear, 3));
});

test('prescribe: issue, evidence, one exercise, criterion, minimum evidence and review point, all from the inputs', () => {
  const r = practice.prescribe({ row: row(), finding: finding('holdMs'), analysis, baseline: base(HOLD), game: '1.0' });
  assert.equal(r.ok, true);
  const d = r.drill;
  assert.equal(d.issue, 'T2: observed holdMs');
  assert.match(d.evidence.text, /^12 valid passes of T2 in 12 laps \(3 sessions\); confidence medium\. Opportunity #1: about 0\.12 s a lap/);
  assert.match(d.evidence.text, /typical 0\.60 s, quicker passes 0\.10 s\.$/);
  assert.match(d.exercise, /^In T2, after the slowest point, push the throttle steadily to full/);
  assert.deepEqual({ key: d.criterion.key, better: d.criterion.better, target: d.criterion.target, tol: d.criterion.tol }, { key: 'holdMs', better: 'lower', target: 100, tol: 75 });
  assert.equal(d.criterion.text, 'At least half of your newest 10 passes of T2 have a part-throttle time on the exit of 0.175 s or less.');
  assert.equal(d.minEvidence.passes, 5);
  assert.equal(d.review.passes, 10);
  assert.equal(d.hypothesis, 'It may help (holdMs).');
  assert.equal(d.before.n, 12);
  assert.equal(d.before.meeting, 3);
  assert.equal(d.before.share, 0.25);
  assert.equal(d.evidence.game, '1.0');
});

test('prescribe: braking later or earlier follows the quicker passes; counts aim at zero; gears quote the clear gears', () => {
  const later = practice.prescribe({ row: row(), finding: finding('brakePoint'), analysis, baseline: base([312, 313, 300, 300, 301, 299, 300, 302, 298, 300]) }).drill;
  assert.equal(later.criterion.better, 'higher');
  assert.match(later.exercise, /start braking about 12 m later/);
  assert.match(later.criterion.text, /braking point at 309\.5 m from the line or later\.$/);
  const earlier = practice.prescribe({ row: row({ typical: { brakePoint: 312 }, fast: { brakePoint: 300 } }), finding: finding('brakePoint'), analysis,
    baseline: base([300, 299, 312, 312, 313, 311, 312, 312, 310, 312]) }).drill;
  assert.equal(earlier.criterion.better, 'lower');
  assert.match(earlier.exercise, /about 12 m earlier/);
  const bumps = practice.prescribe({ row: row(), finding: finding('releaseBumps'), analysis, baseline: base([0, 0, 1, 1, 2, 1, 1, 1, 1, 1]) }).drill;
  assert.equal(bumps.criterion.target, 0);
  assert.match(bumps.criterion.text, /release the brake without pressing it again\.$/);
  const gear = practice.prescribe({ row: row(), finding: finding('minGear'), analysis, baseline: base([2, 2, 3, 3, 3, 3, 3, 3]) }).drill;
  assert.equal(gear.criterion.target, 2);
  assert.match(gear.exercise, /use 2nd gear at the slowest point .*typical pass is in 3rd/);
  assert.match(gear.criterion.text, /are in 2nd gear at the slowest point\.$/);
});

test('prescribe refuses: not an opportunity, too few passes, a target most passes already reach, no difference, unknown finding', () => {
  const p = (o) => practice.prescribe({ row: row(o.row), finding: finding(o.key || 'holdMs'), analysis, baseline: base(o.base || HOLD) });
  assert.match(p({ row: { rank: undefined } }).reason, /not one of your opportunities/);
  assert.match(p({ row: { sufficient: false } }).reason, /not one of your opportunities/);
  assert.match(p({ base: [100, 600, 600, 600] }).reason, /^Needs 5 passes of T2/);
  assert.match(p({ base: [100, 100, 100, 100, 600, 600] }).reason, /already do this in 67 %/);
  assert.match(p({ row: { typical: { holdMs: 100 }, fast: { holdMs: 100 } } }).reason, /no clear difference/);
  assert.match(p({ key: 'coastM' }).reason, /cannot be practised/);
});

const drill = () => practice.prescribe({ row: row(), finding: finding('holdMs'), analysis, baseline: base(HOLD) }).drill;
const passes = (vals, t0 = 1000) => vals.map((v, i) => ({ lapId: 100 + i, sessionId: 1, at: t0 + i, v, timeMs: 10000 + v / 2 }));

test('evaluate: collecting below 5 passes, practising, met at the first point where half of the newest passes reach it', () => {
  const d = drill();
  assert.equal(practice.evaluate(d, passes([100, 100, 100, 100]), 0).state, 'collecting', '4 good passes are not judged');
  assert.equal(practice.evaluate(d, passes([600, 600, 600, 100, 100]), 0).state, 'practising', '2 of 5');
  const e = practice.evaluate(d, passes([600, 600, 100, 100, 100, 600, 600]), 0);
  assert.equal(e.state, 'met');
  assert.deepEqual([e.met.lapId, e.met.share, e.met.n], [104, 0.6, 5], 'met on the 5th pass, 3 of 5');
  assert.equal(e.after.n, 5, 'after = the passes up to the met point');
  assert.equal(e.change.shareBefore, 0.25);
  assert.equal(e.change.shareAfter, 0.6);
  // the order the passes come in does not matter
  assert.deepEqual(practice.evaluate(d, passes([600, 600, 100, 100, 100, 600, 600]).reverse(), 0).met, e.met);
});

test('evaluate: the window rolls, so early misses do not block a drill for ever; review point after 10 passes not met', () => {
  const d = drill();
  const r = practice.evaluate(d, passes(Array(10).fill(600)), 0);
  assert.equal(r.state, 'review');
  assert.equal(r.share, 0);
  // 10 misses, then 5 hits: the newest 10 passes hold 5 hits -> met at the 15th
  const m = practice.evaluate(d, passes([...Array(10).fill(600), 100, 100, 100, 100, 100]), 0);
  assert.equal(m.state, 'met');
  assert.equal(m.met.lapId, 114);
  // keep practising at the review point: only the passes from then are judged
  const k = practice.evaluate(d, passes([...Array(10).fill(600), 100, 100]), 1010);
  assert.equal(k.state, 'collecting');
  assert.equal(k.sinceRestart, 2);
  assert.equal(k.passes, 12);
});

test('change: the corner time is context with a verdict only when the intervals are apart and the change is 30 ms or more', () => {
  const d = drill();
  const e = practice.evaluate(d, passes([100, 100, 100, 100, 100]), 0);
  assert.equal(e.change.time.verdict, 'faster', JSON.stringify(e.change.time));
  assert.ok(e.change.time.deltaMs < 0);
  assert.equal(e.change.gapClosed, 1);
  const same = practice.evaluate({ ...d, before: { ...d.before, time: { n: 12, medianMs: 10050, q1Ms: 10050, ciMs: 400 } } }, passes([100, 100, 100, 100, 100]), 0);
  assert.equal(same.change.time.verdict, 'no clear change');
});

test('slipping: checked from 5 passes after the drill was met; under 25 % of the newest passes reaching it', () => {
  const d = drill();
  assert.deepEqual(practice.slipping(d, passes([600, 600, 600, 600])), { checked: false, n: 4 });
  assert.equal(practice.slipping(d, passes([600, 600, 600, 600, 600])).slipping, true);
  assert.equal(practice.slipping(d, passes([600, 600, 600, 100, 600])).slipping, true, '1 of 5 = 20 %');
  assert.equal(practice.slipping(d, passes([600, 600, 100, 100, 600])).slipping, false, '2 of 5 = 40 %');
});

test('mastery and the progress summary', () => {
  const rows = [row({ name: 'T1', rank: undefined, confidence: 'high' }), row({ name: 'T2' }), row({ name: 'T3', sufficient: false, rank: undefined, confidence: 'insufficient' }), row({ name: 'T4' }), row({ name: 'T5', rank: undefined })];
  const ds = [
    { id: 1, corner: 'T2', active: true, state: 'practising' },
    { id: 2, corner: 'T2', active: false, state: 'met', met: { at: 5 }, eval: { change: { shareBefore: 0.2, shareAfter: 0.6, time: null } }, label: 'x', combo: {} },
    { id: 3, corner: 'T5', active: false, state: 'met', slip: { slipping: true }, met: { at: 6 }, label: 'y', combo: {} },
    { id: 4, corner: 'T1', active: false, state: 'stopped' },
  ];
  const m = practice.mastery(rows, ds);
  assert.deepEqual(m.map((x) => [x.name, x.level, x.drillsMet]), [['T1', 'steady', 0], ['T2', 'practising', 1], ['T3', 'unknown', 0], ['T4', 'open', 0], ['T5', 'revisit', 1]]);
  assert.equal(m[0].confidence, 'high');
  const s = practice.progressSummary(ds);
  assert.deepEqual({ active: s.active, met: s.met, stopped: s.stopped, revisit: s.revisit, review: s.review }, { active: 1, met: 2, stopped: 1, revisit: 1, review: 0 });
  assert.deepEqual(s.results.map((r) => [r.id, r.shareBefore, r.shareAfter]), [[2, 0.2, 0.6], [3, null, null]]);
});

test('every finding key of the lap analysis that names a behaviour can be drilled; units are written out', () => {
  for (const k of ['brakePoint', 'brakeRelease', 'releaseMs', 'releaseBumps', 'minSpeed', 'throttlePickup', 'pickupMs', 'holdMs', 'exitSpeed', 'minGear']) assert.ok(practice.DRILLABLE.has(k), k);
  assert.equal(practice.fmtValue('releaseMs', 350), '0.35 s');
  assert.equal(practice.fmtValue('minSpeed', 84.46), '84.5 km/h');
  assert.equal(practice.fmtValue('minGear', 2), '2nd gear');
  assert.equal(practice.fmtValue('brakePoint', 312.4), '312 m');
  assert.equal(PRACTICE.minPasses, 5, 'the lap analysis minimum (OD-PL-26)');
});
