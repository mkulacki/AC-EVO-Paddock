// Driving technique metrics (src/analysis.js techniqueMetrics) and the performance score, on synthetic traces
// built directly on a 1 m grid, so every expected value can be worked out by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { techniqueMetrics, cornerMetrics, performanceScore, TECHNIQUE } from '../src/analysis.js';

// A corner on a 1 m grid, 0..400 m, apex (slowest point) at 200 m. Speed falls from 200 to 80 km/h and back.
// brk/thr/str are functions of the distance d (m). Time follows from the speed, so ms values are exact sums.
function corner({ brk = () => 0, thr = (d) => (d < 100 ? 1 : d > 200 ? 1 : 0), str = () => 0, spd } = {}) {
  const n = 401, R = { step: 1, n, L: 400, d: [], t: [], spd: [], thr: [], brk: [], str: [], gear: [], rpm: [], x: [], z: [], glat: [], glon: [] };
  let t = 0;
  for (let i = 0; i < n; i++) {
    const v = spd ? spd(i) : 80 + 120 * Math.min(1, Math.abs(i - 200) / 100);
    R.d.push(i); R.t.push(t); R.spd.push(v); R.thr.push(thr(i)); R.brk.push(brk(i)); R.str.push(str(i));
    R.gear.push(3); R.rpm.push(6000); R.x.push(i); R.z.push(0); R.glat.push(0); R.glon.push(0);
    t += 1000 / (v / 3.6); // ms per metre at this speed
  }
  return { R, c: { a: 0, b: 400, apexIdx: 200 } };
}
const msBetween = (R, i, j) => Math.round(R.t[j] - R.t[i]);

test('every metric has a definition for the tooltip', () => {
  const { R, c } = corner();
  for (const k of Object.keys(techniqueMetrics(R, c))) {
    assert.ok(TECHNIQUE[k], `definition for ${k}`);
    assert.ok(TECHNIQUE[k].label && TECHNIQUE[k].def.length > 20, `label and text for ${k}`);
  }
});

test('brake application: time from 10 % to 90 % of the peak; release: from the last 90 % to off', () => {
  // brake on at 100 m, ramps linearly to 100 % at 120 m, holds to 150 m, released linearly to 0 at 190 m
  const brk = (d) => (d < 100 ? 0 : d <= 120 ? (d - 100) / 20 : d <= 150 ? 1 : d <= 190 ? (190 - d) / 40 : 0);
  const { R, c } = corner({ brk, thr: (d) => (d > 200 ? 1 : d < 100 ? 1 : 0) });
  const m = techniqueMetrics(R, c);
  // first > 10 %: 103 m (0.15); first ≥ 90 %: 118 m
  assert.equal(m.brakeRampMs, msBetween(R, 103, 118));
  // last ≥ 90 %: 154 m (0.9); first < 5 %: 189 m (0.025)
  assert.equal(m.releaseMs, msBetween(R, 154, 189));
  assert.equal(m.releaseBumps, 0);
  assert.equal(m.trailM, 0, 'no steering: no trail braking');
});

test('a slower brake hit gives a longer application time', () => {
  const fast = corner({ brk: (d) => (d >= 100 && d < 160 ? Math.min(1, (d - 99) / 5) : 0) });
  const slow = corner({ brk: (d) => (d >= 100 && d < 160 ? Math.min(1, (d - 99) / 40) : 0) });
  assert.ok(techniqueMetrics(slow.R, slow.c).brakeRampMs > 3 * techniqueMetrics(fast.R, fast.c).brakeRampMs);
});

test('release bumps: pressing again by 5 % or more while releasing counts once per press', () => {
  // full brake to 140 m, release to 30 % at 160 m, back up to 50 % at 165 m, then off at 185 m
  const brk = (d) => (d < 100 ? 0 : d <= 140 ? 1 : d <= 160 ? 1 - 0.7 * (d - 140) / 20 : d <= 165 ? 0.3 + 0.2 * (d - 160) / 5 : d <= 185 ? 0.5 * (185 - d) / 20 : 0);
  const { R, c } = corner({ brk });
  assert.equal(techniqueMetrics(R, c).releaseBumps, 1);
  // a small wobble (2 %) is not a bump
  const wob = corner({ brk: (d) => (d < 100 ? 0 : d <= 140 ? 1 : d <= 180 ? Math.max(0, 1 - (d - 140) / 40 + (d === 160 ? 0.02 : 0)) : 0) });
  assert.equal(techniqueMetrics(wob.R, wob.c).releaseBumps, 0);
});

test('trail braking: metres with the brake on while steering more than 20 % of peak lock', () => {
  // brake 100..180 m; steering ramps from 0 at 150 m to 0.5 at 200 m (20 % of 0.5 = 0.1 reached after 160 m)
  const str = (d) => (d < 150 ? 0 : d <= 200 ? (d - 150) / 100 : Math.max(0, 0.5 - (d - 200) / 100));
  const { R, c } = corner({ brk: (d) => (d >= 100 && d < 180 ? 0.8 : 0), str });
  // |str| > 0.1 from 161 m; brake > 5 % until 179 m: 161..179 = 19 points of 1 m
  assert.equal(techniqueMetrics(R, c).trailM, 19);
});

test('no braking: brake metrics are empty, not zero', () => {
  const { R, c } = corner();
  const m = techniqueMetrics(R, c);
  assert.equal(m.brakeRampMs, null);
  assert.equal(m.releaseMs, null);
  assert.equal(m.releaseBumps, null);
  assert.equal(m.trailM, null);
});

test('throttle: apex to full throttle, and re-lifts on the exit', () => {
  // throttle from the apex: 60 % at 200..229 m, full from 230 m
  const { R, c } = corner({ thr: (d) => (d < 100 ? 1 : d < 200 ? 0 : d < 230 ? 0.6 : 1) });
  const m = techniqueMetrics(R, c);
  assert.equal(m.pickupMs, msBetween(R, 200, 230));
  assert.equal(m.reLifts, 0);
  // a lift from 100 % to 50 % at 260..270 m, and again at 300..310 m
  const l = corner({ thr: (d) => (d < 100 ? 1 : d < 200 ? 0 : (d >= 260 && d < 270) || (d >= 300 && d < 310) ? 0.5 : 1) });
  assert.equal(techniqueMetrics(l.R, l.c).reLifts, 2);
  // full throttle never reached: empty
  const p = corner({ thr: (d) => (d < 100 ? 1 : d < 200 ? 0 : 0.8) });
  assert.equal(techniqueMetrics(p.R, p.c).pickupMs, null);
});

test('steering: one clean corner = 1 reversal and no saw; small corrections count as saw', () => {
  const clean = (d) => (d < 120 ? 0 : d <= 200 ? 0.5 * (d - 120) / 80 : d <= 280 ? 0.5 * (280 - d) / 80 : 0);
  const a = corner({ str: clean });
  const m = techniqueMetrics(a.R, a.c);
  assert.equal(m.steerReversals, 1);
  assert.equal(m.steerSaw, 0);
  // the same corner with a ±0.02 zigzag (4 % of the lock) every 4 m around the apex
  const saw = (d) => clean(d) + (d >= 170 && d < 230 ? (Math.floor(d / 4) % 2 ? 0.02 : -0.02) : 0);
  const b = corner({ str: saw });
  const s = techniqueMetrics(b.R, b.c);
  assert.equal(s.steerReversals, 1, 'the zigzag is too small to be a big reversal');
  assert.ok(s.steerSaw >= 10, `saw ${s.steerSaw}`);
  // a big catch: unwinding to the other side (counter-steer) and back = 2 more big reversals
  const cat = (d) => (d >= 210 && d < 230 ? -0.2 : clean(d));
  assert.equal(techniqueMetrics(corner({ str: cat }).R, corner().c).steerReversals, 3);
  // a straight (no real steering) has no reversals at all, whatever the noise
  const st = corner({ str: (d) => (d % 2 ? 0.003 : -0.003) });
  assert.deepEqual([techniqueMetrics(st.R, st.c).steerReversals, techniqueMetrics(st.R, st.c).steerSaw], [0, 0]);
});

test('thresholds are relative: the same shape at a quarter of the lock gives the same counts', () => {
  const shape = (k) => (d) => k * ((d < 120 ? 0 : d <= 200 ? (d - 120) / 80 : d <= 280 ? (280 - d) / 80 : 0) + (d >= 170 && d < 230 ? (Math.floor(d / 4) % 2 ? 0.04 : -0.04) : 0));
  const big = corner({ str: shape(1) }), small = corner({ str: shape(0.25) });
  const a = techniqueMetrics(big.R, big.c), b = techniqueMetrics(small.R, small.c);
  assert.equal(a.steerReversals, b.steerReversals);
  assert.equal(a.steerSaw, b.steerSaw);
});

test('coasting: neither pedal above 30 km/h', () => {
  const { R, c } = corner({ thr: (d) => (d < 100 ? 1 : d < 200 ? 0 : 1) }); // no brake 100..199: 100 m coasting
  assert.equal(techniqueMetrics(R, c).coastM, 100);
});

test('cornerMetrics carries the technique metrics (Compare, Consistency and the report use it)', () => {
  const { R, c } = corner({ brk: (d) => (d >= 100 && d < 180 ? 0.8 : 0) });
  const m = cornerMetrics(R, c);
  for (const k of Object.keys(TECHNIQUE)) assert.ok(k in m, k);
  assert.equal(m.coastM, techniqueMetrics(R, c).coastM);
});

test('performance score: formula with known inputs', () => {
  // ideal 100 s; clean laps 101, 101, 101 s: pace = 100 − 2000 × 0.01 = 80, σ = 0 → consistency 100;
  // 3 valid of 4 → validity 75; score = 40 + 30 + 15 = 85
  const laps = [{ ms: 101000, valid: true }, { ms: 101000, valid: true }, { ms: 101000, valid: true }, { ms: 99000, valid: false }];
  const s = performanceScore(laps, 100000);
  assert.deepEqual([s.pace, s.consistency, s.validity, s.score], [80, 100, 75, 85]);
  // laps more than 5 % off the ideal: pace 0, not negative
  assert.equal(performanceScore([106000, 106000, 106000].map((ms) => ({ ms, valid: true })), 100000).pace, 0);
  // σ: laps 100, 101, 102 s (mean 101 s, σ 0.8165 s) → consistency 100 − 4000 × 0.008084 = 67.7
  assert.equal(performanceScore([100000, 101000, 102000].map((ms) => ({ ms, valid: true })), 100000).consistency, 68);
  // a lap more than 7 % off the best is not clean (left out of pace and consistency, still counts as valid)
  const slow = performanceScore([100000, 100000, 100000, 120000].map((ms) => ({ ms, valid: true })), 100000);
  assert.deepEqual([slow.clean, slow.pace, slow.consistency, slow.validity], [3, 100, 100, 100]);
});

test('performance score: missing instead of a made-up number', () => {
  assert.equal(performanceScore([], 100000).score, null);
  assert.equal(performanceScore([{ ms: 100000, valid: true }], null).score, null);
  const two = performanceScore([{ ms: 100000, valid: true }, { ms: 100000, valid: true }, { ms: 90000, valid: false }], 100000);
  assert.equal(two.score, null);
  assert.match(two.reason, /3 clean laps/);
});

test('review fix: a gradual lift (100 % → 0 % over 20 m, then back) is one re-lift, not four', () => {
  const thr = (d) => (d < 100 ? 1 : d < 200 ? 0 : d < 260 ? 1 : d < 280 ? 1 - (d - 260) / 20 : d < 300 ? (d - 280) / 20 : 1);
  const { R, c } = corner({ thr });
  assert.equal(techniqueMetrics(R, c).reLifts, 1);
  // two separate gradual lifts are two
  const two = (d) => (d < 100 ? 1 : d < 200 ? 0 : d >= 240 && d < 260 ? 0.3 : d >= 300 && d < 320 ? Math.abs(d - 310) / 10 : 1);
  assert.equal(techniqueMetrics(corner({ thr: two }).R, corner().c).reLifts, 2);
});

test('review fix: an early tap on the straight is not taken as the braking zone', () => {
  // a 30 % tap at 20..25 m, then the real braking: on at 100 m, full at 120 m, off at 180 m
  const brk = (d) => (d >= 20 && d <= 25 ? 0.3 : d < 100 ? 0 : d <= 120 ? (d - 100) / 20 : d < 180 ? 1 : 0);
  const withTap = techniqueMetrics(corner({ brk }).R, corner().c);
  const noTap = techniqueMetrics(corner({ brk: (d) => (d < 30 ? 0 : brk(d)) }).R, corner().c);
  assert.equal(withTap.brakeRampMs, noTap.brakeRampMs);
  assert.equal(withTap.releaseMs, noTap.releaseMs);
  assert.ok(withTap.brakeRampMs > 0);
});
