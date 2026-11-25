// PL6 actionable lap analysis (src/opportunities.js) on metric-level fixtures: every pass is written out by hand, so
// each expected number can be worked out from the table below. Provenance: test/fixtures/README.md.
//
// 12 laps over 3 sessions (4 laps each), 5 corners:
//   T1 consistent           every pass 5000 ms ± 10                         -> no opportunity
//   T2 exit hesitation      laps 1-4 fast (6000 ms), others 6200 ms: throttle held 400 ms, exit 6 km/h slower,
//                           3rd gear instead of 2nd, all the loss on the exit -> rank 1
//   T3 early braking        laps 5-8 fast (4900 ms), others 5000 ms: brake 10 m earlier, loss on entry -> rank 2
//   T4 one lucky pass       lap 9 4500 ms, the others 5000 ms ± 5           -> not listed (realistic gain ~0)
//   T5 improving over time  session 1 5300, session 2 5200, session 3 5100 ms
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyse, differences, RULES } from '../src/opportunities.js';

const pass = (o = {}) => ({ timeMs: 5000, entryMs: 2000, apexMs: 1000, exitMs: 2000, brakePoint: 100, brakeRelease: 150, releaseMs: 300, releaseBumps: 0,
  trailM: 10, minSpeed: 80, exitSpeed: 150, throttlePickup: 200, pickupMs: 800, holdMs: 0, reLifts: 0, minGear: 3, coastM: 0, ...o });
const CORNERS = ['T1', 'T2', 'T3', 'T4', 'T5'].map((name, i) => ({ n: i + 1, name, apex: 100 + 300 * i, start: 300 * i, end: 300 * (i + 1) }));

function lap(i, { has = { gear: true, brake: true, throttle: true } } = {}) {
  const session = Math.floor((i - 1) / 4) + 1; // laps 1-4 session 1, …
  const t2fast = i <= 4, t3fast = i >= 5 && i <= 8;
  const c = [
    pass({ timeMs: 5000 + (i % 2) * 10, exitMs: 2000 + (i % 2) * 10 }),
    t2fast ? pass({ timeMs: 6000, exitMs: 3000, minGear: 2 }) : pass({ timeMs: 6200, exitMs: 3200, holdMs: 400, exitSpeed: 144, minGear: 3 }),
    t3fast ? pass({ timeMs: 4900, entryMs: 1900, brakePoint: 110 }) : pass({ timeMs: 5000, entryMs: 2000, brakePoint: 100 }),
    pass({ timeMs: i === 9 ? 4500 : 5000 + (i % 3) * 5, apexMs: i === 9 ? 500 : 1000 + (i % 3) * 5 }),
    pass({ timeMs: 5400 - 100 * session, exitMs: 2400 - 100 * session }),
  ];
  return { id: i, sessionId: session, recordedAt: 1000 * i, lapMs: c.reduce((a, p) => a + p.timeMs, 0), has, c };
}
const LAPS = Array.from({ length: 12 }, (_, k) => lap(k + 1));
const trendOf = (laps) => laps.map((l) => ({ id: l.id, sessionId: l.sessionId, recordedAt: l.recordedAt, lapMs: l.lapMs, dts: l.c.map((p) => p.timeMs) }));
const run = (laps = LAPS, extra = {}) => analyse({ corners: CORNERS, laps, trend: trendOf(laps), idealMs: 25000, ...extra });

test('ranking: the exit hesitation first, the early braking second; consistent and lucky corners are not listed', () => {
  const r = run();
  assert.deepEqual(r.opportunities, ['T2', 'T3', 'T5']);
  assert.deepEqual(r.top.map((t) => t.name), ['T2', 'T3', 'T5']);
  const t2 = r.corners[1];
  // 12 passes [6000×4, 6200×8]: the first quartile sits at sorted index 2.75 (between two 6000s), the median at 5.5
  assert.equal(t2.dist.q1Ms, 6000);
  assert.equal(t2.dist.medianMs, 6200);
  assert.deepEqual(t2.gain, { realisticMs: 200, idealMs: 200 });
  assert.equal(t2.confidence, 'medium');
  assert.equal(t2.mainPhase, 'exit');
  assert.deepEqual(t2.phases, { entry: 0, apex: 0, exit: 200 });
});

test('the faster passes are the quickest quarter; what they did differently is named, with the gear', () => {
  const t2 = run().corners[1];
  assert.equal(t2.fastPasses, 4, 'passes at or under the first quartile');
  const keys = t2.findings.map((f) => f.key);
  assert.ok(keys.includes('holdMs') && keys.includes('exitSpeed') && keys.includes('minGear'), keys.join());
  const hold = t2.findings.find((f) => f.key === 'holdMs');
  assert.match(hold.observation, /Your typical pass holds the throttle part-way for 0\.40 s on the exit; faster passes 0\.00 s/);
  assert.match(hold.interpretation, /may/, 'an interpretation is worded as a possibility');
  assert.ok(!/may/.test(hold.observation), 'an observation states only what was measured');
  // gears: 2nd 4 passes, 3rd 8 passes; both groups have 3 or more passes, so they are compared
  assert.deepEqual(t2.gears.groups.map((g) => [g.gear, g.passes, g.medianMs]), [[2, 4, 6000], [3, 8, 6200]]);
  assert.equal(t2.gears.comparison.faster, 2);
  assert.match(t2.gears.comparison.interpretation, /association/);
  // links: a typical pass and a representative fast pass of this corner
  assert.ok(t2.links.typicalLapId > 4 && t2.links.fastLapId <= 4);
});

test('early braking: the loss is on the entry and the braking point is named', () => {
  const t3 = run().corners[2];
  assert.equal(t3.mainPhase, 'entry');
  const b = t3.findings.find((f) => f.key === 'brakePoint');
  assert.match(b.observation, /Faster passes start braking 10 m later \(110 m against 100 m\)/);
});

test('one lucky pass: a big ideal gain but no realistic one, so it is not ranked', () => {
  const t4 = run().corners[3];
  assert.equal(t4.gain.idealMs, 505);
  assert.ok(t4.gain.realisticMs < RULES.minGainMs);
  assert.equal(t4.rank, undefined);
});

test('the top three can be read without a chart: a headline, an observation and up to three findings', () => {
  const top = run().top[0];
  assert.match(top.headline, /^T2: about 0\.20 s a lap to gain, most of it on the way out/);
  assert.match(top.observation, /typical pass takes 6\.20 s; the quicker quarter of your passes 6\.00 s or less \(4 of 12 passes\), your fastest 6\.00 s/);
  assert.ok(top.findings.length >= 1 && top.findings.length <= 3);
  assert.equal(top.confidence, 'medium');
});

test('minimum samples: fewer than 5 passes give no ranking and no target lap, with the reason', () => {
  const r = run(LAPS.slice(0, 4));
  assert.deepEqual(r.top, []);
  assert.ok(r.corners.every((c) => !c.sufficient && /Needs 5 valid passes \(4 so far\)/.test(c.reason)));
  assert.equal(r.target.targetMs, null);
  assert.match(r.target.reason, /Needs 5 valid passes of every corner/);
  assert.equal(r.trends.sufficient, false);
});

test('repeatability target: the sum of the corners\' first quartiles, next to the ideal, with an approximate uncertainty', () => {
  const r = run();
  const sum = r.corners.reduce((a, c) => a + c.dist.q1Ms, 0);
  assert.equal(r.target.targetMs, sum);
  assert.equal(r.target.idealMs, 25000, 'the theoretical ideal is passed through');
  assert.equal(r.target.sampleIdealMs, r.corners.reduce((a, c) => a + c.dist.minMs, 0));
  assert.ok(r.target.sampleIdealMs <= r.target.targetMs && r.target.targetMs <= r.target.medianSumMs);
  assert.ok(r.target.uncertaintyMs >= 0);
});

test('a missing channel disables what depends on it: no gear, no brake data', () => {
  const noGear = LAPS.map((l) => ({ ...l, has: { gear: false, brake: true, throttle: true } }));
  const t2 = run(noGear).corners[1];
  assert.equal(t2.gears.available, false);
  assert.ok(!t2.findings.some((f) => f.key === 'minGear'));
  const noBrake = LAPS.map((l) => ({ ...l, has: { gear: true, brake: false, throttle: true } }));
  const t3 = run(noBrake).corners[2];
  assert.ok(!t3.findings.some((f) => f.kind === 'braking' || f.kind === 'release'), 'no brake findings without brake data');
  assert.equal(t3.typical.brakePoint, null);
});

test('multi-session trend: first against last session, a verdict only beyond the noise', () => {
  const tr = run().trends;
  assert.equal(tr.sufficient, true);
  assert.equal(tr.sessions.length, 3);
  const t5 = tr.corners.find((c) => c.name === 'T5');
  assert.deepEqual([t5.firstMs, t5.lastMs, t5.changeMs, t5.slopeMs, t5.verdict], [5300, 5100, -200, -100, 'faster']);
  const t1 = tr.corners.find((c) => c.name === 'T1');
  assert.equal(t1.verdict, 'no clear change');
});

test('personal best explained against the previous best, corner by corner, worded for one lap', () => {
  const prev = lap(9), best = lap(5); // lap 5 has the fast T3 (and no lucky T4)
  const r = run(LAPS, { pb: { lap: best, prev, compat: { level: 'compatible', items: [] } } });
  assert.equal(r.pb.deltaMs, best.lapMs - prev.lapMs);
  const t3 = r.pb.gains.find((g) => g.name === 'T3');
  assert.equal(t3.deltaMs, -100);
  assert.equal(t3.phases.entry, -100);
  assert.match(t3.findings[0].observation, /^Your best lap started braking 10 m later/);
  assert.ok(r.pb.losses.some((x) => x.name === 'T4'), 'lap 9 had the lucky T4: the best lap lost time there');
  assert.match(r.pb.note, /not proven causes/);
  const first = run(LAPS, { pb: { lap: best, prev: null, compat: null } });
  assert.match(first.pb.reason, /first valid lap/);
});

test('reproducible: the same laps in any order give the same result', () => {
  const a = run();
  const b = run([...LAPS].reverse());
  assert.deepEqual(a, b);
  assert.deepEqual(run(), a);
});

test('differences: thresholds are inclusive and nothing is said below them', () => {
  const base = { brakePoint: 100, minSpeed: 80 };
  assert.equal(differences(base, { brakePoint: 104.9, minSpeed: 81.9 }).length, 0);
  assert.deepEqual(differences(base, { brakePoint: 105, minSpeed: 82 }).map((d) => d.key).sort(), ['brakePoint', 'minSpeed']);
});

// ---- PL6 review fixes
import { clearGear, BRAKE_NOTE } from '../src/opportunities.js';
import { quantileRange, sorted as srt } from '../src/stats.js';

test('review fix 1: no gear finding from a quick group of 1-2 passes, and none on a tie', () => {
  // 5 passes, gears [4, 3, 4, 4, 4]; the two quickest are one 4th and one 3rd
  const one = (i, g, t) => ({ id: i, sessionId: 1, recordedAt: i, lapMs: t, has: { gear: true, brake: true, throttle: true }, c: [pass({ timeMs: t, minGear: g })] });
  const laps = [one(1, 4, 5000), one(2, 3, 4900), one(3, 4, 5100), one(4, 4, 5100), one(5, 4, 5100)];
  const r = analyse({ corners: CORNERS.slice(0, 1), laps });
  assert.ok(!r.corners[0].findings.some((f) => f.key === 'minGear'), JSON.stringify(r.corners[0].findings));
  assert.equal(clearGear(laps.slice(0, 2), 0), null, 'two passes are under the 3-pass minimum');
  const tie = [3, 3, 3, 4, 4, 4].map((g, i) => one(i + 1, g, 5000));
  assert.equal(clearGear(tie, 0), null, 'a tie names no gear');
  assert.equal(clearGear([3, 3, 3, 4].map((g, i) => one(i + 1, g, 5000)), 0), 3);
});

test('review fix 2: laps with the automatic gearbox are left out of gear comparisons; top cards carry the channel caveats', () => {
  const auto = LAPS.map((l) => ({ ...l, gearbox: l.id <= 4 ? 'auto' : 'manual' }));
  const t2 = run(auto).corners[1];
  assert.equal(t2.gears.auto, 4);
  assert.deepEqual(t2.gears.groups.map((g) => g.gear), [3], 'the 2nd-gear passes were all automatic');
  assert.ok(!t2.findings.some((f) => f.key === 'minGear'));
  // with the gear finding on a card, its caveat says where the gears come from; a braking finding says "pedal position"
  const r = run(LAPS.map((l) => ({ ...l, gearbox: 'unknown' })));
  const c2 = r.top.find((t) => t.name === 'T2'), c3 = r.top.find((t) => t.name === 'T3');
  assert.ok(c2.findings.some((f) => f.key === 'minGear'));
  assert.match(c2.caveats.join(' '), /manual gearbox only.*12 passes the gearbox setting was not recorded/);
  assert.ok(c3.caveats.includes(BRAKE_NOTE));
});

test('review fix 4: a trend verdict needs a minimum change, not just non-overlapping intervals', () => {
  // three sessions of identical laps, the last 1 ms slower: zero spread makes the intervals not overlap
  const tl = [1, 2, 3].flatMap((s) => [0, 1, 2].map((j) => ({ id: s * 10 + j, sessionId: s, recordedAt: s * 10 + j, lapMs: 90000 + (s === 3 ? 1 : 0), dts: [5000 + (s === 3 ? 1 : 0)] })));
  const tr = analyse({ corners: CORNERS.slice(0, 1), laps: [], trend: tl }).trends;
  assert.equal(tr.lap.verdict, 'no clear change');
  assert.equal(tr.corners[0].verdict, 'no clear change');
  assert.equal(RULES.trendMinMs.lap, 100);
});

test('review fix 5: counts are whole numbers (no "1.5×")', () => {
  // typical passes: re-applications 1 and 2 alternate (median 1.5), quick ones 0
  const laps = LAPS.map((l) => ({ ...l, c: l.c.map((p, k) => (k === 2 ? { ...p, releaseBumps: l.id >= 5 && l.id <= 8 ? 0 : 1 + (l.id % 2) } : p)) }));
  const t3 = run(laps).corners[2];
  assert.equal(t3.typical.releaseBumps, 1);
  const f = t3.findings.find((x) => x.key === 'releaseBumps');
  assert.match(f.observation, /releasing it \(once\)/);
  assert.ok(!/\d\.\d×/.test(JSON.stringify(t3.findings)));
});

test('review fix 6: the target lap range comes from the first quartiles, not the medians', () => {
  const r = run();
  const half = (k) => { const q = quantileRange(srt(LAPS.map((l) => l.c[k].timeMs)), 0.25); return (q.hi - q.lo) / 2; };
  assert.equal(r.target.uncertaintyMs, Math.round(Math.sqrt([0, 1, 2, 3, 4].reduce((a, k) => a + half(k) ** 2, 0))));
});
