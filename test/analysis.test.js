// Pure analysis functions (src/analysis.js) on synthetic traces with known answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resample, smooth, detectCorners, deltaSeries, lapStats, buildIdeal, lateralOffsets, cornerMetrics, gridStep } from '../src/analysis.js';
import { near } from './helpers.js';

// a raw lap as the recorder stores it: 60 Hz columns, distance from the timing line
function rawLap({ L, speedAt, gearAt = () => 3, extra = {} }) {
  const data = { t: [], d: [], spd: [], thr: [], brk: [], str: [], gear: [], rpm: [], x: [], z: [], glat: [], glon: [] };
  let t = 0, d = 0;
  while (d < L) {
    const v = speedAt(d);
    data.t.push(t); data.d.push(d); data.spd.push(v);
    data.thr.push(extra.thr?.(d) ?? 1); data.brk.push(extra.brk?.(d) ?? 0); data.str.push(0);
    data.gear.push(gearAt(d)); data.rpm.push(6000); data.x.push(d); data.z.push(extra.z?.(d) ?? 0); data.glat.push(0); data.glon.push(0);
    t += 1000 / 60; d += (v / 3.6) / 60;
  }
  return { data, lapTimeMs: Math.round(t + ((L - data.d.at(-1)) / (speedAt(L) / 3.6)) * 1000) };
}

test('gridStep: 1 m for short tracks, 3 m at most', () => {
  assert.equal(gridStep(1000), 1);
  assert.equal(gridStep(5000), 2);
  assert.equal(gridStep(20000), 3);
});

test('resample: constant speed gives a linear time axis on a fixed distance grid', () => {
  const L = 1000;
  const { data, lapTimeMs } = rawLap({ L, speedAt: () => 36, gearAt: (d) => (d < 500 ? 3 : 4) }); // 10 m/s
  const R = resample(data, L, lapTimeMs);
  assert.equal(R.step, 1);
  assert.equal(R.n, 1001);
  assert.equal(R.d[0], 0);
  assert.equal(R.d.at(-1), L);
  assert.ok(near(R.t[500], 50000, 2), `t at 500 m = ${R.t[500]}`);
  assert.equal(R.t.at(-1), lapTimeMs, 'the end is anchored to the official lap time');
  // gear is a step channel: never interpolated to 3.5
  assert.ok(R.gear.every((g) => g === 3 || g === 4));
  assert.equal(R.gear[400], 3);
  assert.equal(R.gear[600], 4);
});

test('resample: duplicate or backwards distances are skipped', () => {
  const { data, lapTimeMs } = rawLap({ L: 500, speedAt: () => 36 });
  data.d.splice(10, 0, data.d[9]); // duplicate sample
  for (const k of Object.keys(data)) if (k !== 'd') data[k].splice(10, 0, data[k][9]);
  const R = resample(data, 500, lapTimeMs);
  for (let i = 1; i < R.n; i++) assert.ok(R.t[i] >= R.t[i - 1], 'time never goes backwards');
});

test('smooth: keeps a constant, averages a spike, w=0 copies', () => {
  assert.deepEqual(smooth([5, 5, 5, 5], 1), [5, 5, 5, 5]);
  const s = smooth([0, 0, 9, 0, 0], 1);
  assert.ok(near(s[2], 3, 1e-9));
  const a = [1, 2, 3];
  const c = smooth(a, 0);
  assert.deepEqual(c, a);
  assert.notEqual(c, a);
});

// a 3 km lap with three slow corners at 500, 1500 and 2500 m
const DIPS = [500, 1500, 2500];
const speed3 = (d) => 220 - DIPS.reduce((s, c) => s + 140 * Math.exp(-(((d - c) / 70) ** 2)), 0);

test('detectCorners: finds the three speed minima, segments cover the lap without gaps', () => {
  const L = 3000;
  const { data, lapTimeMs } = rawLap({ L, speedAt: speed3 });
  const R = resample(data, L, lapTimeMs);
  const corners = detectCorners(R);
  assert.equal(corners.length, 3);
  corners.forEach((c, k) => {
    assert.equal(c.name, `T${k + 1}`);
    assert.ok(near(R.d[c.apexIdx], DIPS[k], 10), `apex ${k + 1} at ${R.d[c.apexIdx]} m`);
    assert.ok(c.a <= c.apexIdx && c.apexIdx <= c.b);
    if (k) assert.equal(c.a, corners[k - 1].b, 'segments are contiguous');
  });
  assert.equal(corners[0].a, 0);
  assert.equal(corners.at(-1).b, R.n - 1);
});

test('detectCorners: a lap without corners is one segment', () => {
  const { data, lapTimeMs } = rawLap({ L: 2000, speedAt: () => 200 });
  const R = resample(data, 2000, lapTimeMs);
  const c = detectCorners(R);
  assert.equal(c.length, 1);
  assert.equal(c[0].name, 'Lap');
});

test('deltaSeries / lateralOffsets: a lap against itself is zero everywhere', () => {
  const L = 3000;
  const { data, lapTimeMs } = rawLap({ L, speedAt: speed3, extra: { z: (d) => 50 * Math.sin(d / 300) } });
  const R = resample(data, L, lapTimeMs);
  assert.ok(deltaSeries(R, R).every((v) => v === 0));
  assert.ok(lateralOffsets(R, R).every((v) => Math.abs(v) < 1e-6));
});

test('cornerMetrics: brake point, minimum speed and throttle pickup of a known corner', () => {
  const L = 3000;
  const brk = (d) => (d > 380 && d < 480 ? 1 : 0);
  const thr = (d) => (d > 380 && d < 540 ? 0 : 1);
  const { data, lapTimeMs } = rawLap({ L, speedAt: speed3, extra: { brk, thr } });
  const R = resample(data, L, lapTimeMs);
  const c = detectCorners(R)[0];
  const m = cornerMetrics(R, c);
  assert.ok(near(m.brakePoint, 381, 2), `brake point ${m.brakePoint}`);
  assert.ok(near(m.apexAt, 500, 10), `apex ${m.apexAt}`);
  assert.ok(near(m.minSpeed, 80, 1), `min speed ${m.minSpeed}`);
  assert.ok(near(m.throttlePickup, 540, 2), `pickup ${m.throttlePickup}`);
  assert.equal(m.maxBrakePct, 100);
});

test('lapStats: full throttle share and top speed', () => {
  const { data, lapTimeMs } = rawLap({ L: 1000, speedAt: () => 150, extra: { thr: (d) => (d < 250 ? 0.5 : 1) } });
  const s = lapStats(resample(data, 1000, lapTimeMs));
  assert.equal(s.topSpeed, 150);
  assert.ok(near(s.fullThrottlePct, 75, 1), `full throttle ${s.fullThrottlePct}%`);
});

test('buildIdeal: takes the fastest lap per corner, never slower than the best lap', () => {
  const L = 3000;
  // lap A is faster in T1, lap B in T2 and T3
  const lapA = rawLap({ L, speedAt: (d) => speed3(d) * (d < 1000 ? 1.05 : 1) });
  const lapB = rawLap({ L, speedAt: (d) => speed3(d) * (d < 1000 ? 1 : 1.03) });
  const A = resample(lapA.data, L, lapA.lapTimeMs), B = resample(lapB.data, L, lapB.lapTimeMs);
  const corners = detectCorners(A);
  const ideal = buildIdeal([{ id: 1, R: A }, { id: 2, R: B }], corners);
  assert.deepEqual(ideal.sources.map((s) => s.lapId), [1, 2, 2]);
  assert.ok(ideal.timeMs <= Math.min(A.t.at(-1), B.t.at(-1)));
  for (let i = 1; i < ideal.R.n; i++) assert.ok(ideal.R.t[i] >= ideal.R.t[i - 1], 'spliced time is continuous');
  assert.equal(buildIdeal([], corners), null);
});
