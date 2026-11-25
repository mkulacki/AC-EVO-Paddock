// PL6 statistics helpers (src/stats.js): values worked out by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sorted, quantile, median, summary, mode, theilSen, apart } from '../src/stats.js';

test('quantiles interpolate linearly (type 7); non-numbers are ignored', () => {
  assert.deepEqual(sorted([3, null, 1, NaN, 2, undefined, Infinity]), [1, 2, 3]);
  assert.equal(quantile([], 0.5), null);
  assert.equal(quantile([10], 0.25), 10);
  assert.equal(quantile([1, 2, 3, 4], 0.25), 1.75);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([5, null, 1, 3]), 3);
});

test('summary: quartiles, spread and the interval of the median', () => {
  const s = summary([10, 20, 30, 40, 50]);
  assert.equal(s.n, 5);
  assert.equal(s.min, 10); assert.equal(s.max, 50);
  assert.equal(s.q1, 20); assert.equal(s.median, 30); assert.equal(s.q3, 40);
  assert.equal(s.iqr, 20); assert.equal(s.mean, 30);
  assert.equal(Math.round(s.sd * 1000) / 1000, 14.142);
  assert.equal(Math.round(s.ci * 1000) / 1000, Math.round((1.58 * 20 / Math.sqrt(5)) * 1000) / 1000);
  assert.equal(summary([]), null);
  assert.equal(summary([null, NaN]), null);
});

test('mode: the most frequent value, the smaller one on a tie', () => {
  const m = mode([3, 2, 3, 2, 4, null]);
  assert.equal(m.mode, 2);
  assert.equal(m.counts.get(3), 2);
  assert.equal(mode([]), null);
});

test('Theil–Sen slope ignores an outlier', () => {
  assert.equal(theilSen([1, 2, 3, 4, 5], [10, 12, 14, 16, 100]), 2);
  assert.equal(theilSen([1], [1]), null);
  assert.equal(theilSen([2, 2], [1, 5]), null);
});

test('apart: only when the intervals of the medians do not overlap', () => {
  const a = summary([100, 101, 102, 103, 104]), b = summary([110, 111, 112, 113, 114]), c = summary([102, 103, 104, 105, 106]);
  assert.equal(apart(a, b), true);
  assert.equal(apart(a, c), false);
  assert.equal(apart(a, null), false);
});

test('quantileRange: a distribution-free interval of a quantile from the order of the values (PL6 review fix 6)', async () => {
  const { quantileRange } = await import('../src/stats.js');
  // n = 12, p = 0.25: ranks 3 ± 1.96·√2.25 = 0.06 .. 5.94 -> 1-based ranks 0 (clipped to 1) .. 6
  assert.deepEqual(quantileRange([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 0.25), { lo: 1, hi: 6 });
  assert.deepEqual(quantileRange([5], 0.25), { lo: 5, hi: 5 });
  assert.equal(quantileRange([], 0.5), null);
});
