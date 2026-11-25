// Small descriptive statistics for the lap analysis (PL6, docs/platform/ANALYSIS.md). Pure and deterministic: no random
// numbers, no state. Every function ignores values that are not finite numbers (a metric a pass does not have is
// null, not 0), so a missing value never pulls a median or a spread.

/** The finite numbers of a list, sorted ascending (a new array). */
export const sorted = (a) => a.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((x, y) => x - y);

/** Quantile p (0..1) of an already sorted list, linear between the two nearest values (R's type 7). null when empty. */
export function quantile(s, p) {
  if (!s.length) return null;
  const h = (s.length - 1) * p, lo = Math.floor(h), hi = Math.ceil(h);
  return s[lo] + (s[hi] - s[lo]) * (h - lo);
}
export const median = (a) => quantile(sorted(a), 0.5);

/**
 * n, min, q1, median, q3, max, iqr, mean, sd (population) and ci: the half-width of an approximate 95 % interval of the
 * median, 1.58 × IQR / √n (the box-plot notch of McGill, Tukey and Larsen 1978). null when there is no value.
 */
export function summary(a) {
  const s = sorted(a), n = s.length;
  if (!n) return null;
  const mean = s.reduce((x, y) => x + y, 0) / n;
  const q1 = quantile(s, 0.25), q3 = quantile(s, 0.75);
  return { n, min: s[0], q1, median: quantile(s, 0.5), q3, max: s[n - 1], iqr: q3 - q1, mean,
    sd: Math.sqrt(s.reduce((x, y) => x + (y - mean) ** 2, 0) / n), ci: (1.58 * (q3 - q1)) / Math.sqrt(n) };
}

/**
 * A distribution-free ~95 % interval of quantile p of an already sorted list: the values at the ranks
 * n·p ± 1.96·√(n·p·(1−p)) (normal approximation of the binomial), clipped to the list. {lo, hi}; null when empty.
 */
export function quantileRange(s, p) {
  if (!s.length) return null;
  const n = s.length, h = 1.96 * Math.sqrt(n * p * (1 - p));
  // 1-based ranks floor(n·p − h) and ceil(n·p + h), as 0-based indexes
  const lo = Math.max(0, Math.floor(n * p - h) - 1), hi = Math.min(n - 1, Math.ceil(n * p + h) - 1);
  return { lo: s[lo], hi: s[Math.max(hi, lo)] };
}

/** The most frequent value (the smallest of a tie) and the counts: {mode, counts: Map(value -> n)}; null when empty. */
export function mode(a) {
  const counts = new Map();
  for (const v of a) if (v != null && Number.isFinite(v)) counts.set(v, (counts.get(v) || 0) + 1);
  if (!counts.size) return null;
  let best = null;
  for (const [v, n] of counts) if (best == null || n > counts.get(best) || (n === counts.get(best) && v < best)) best = v;
  return { mode: best, counts };
}

/** Theil–Sen slope of y over x: the median of the slopes of all pairs with different x. null with fewer than 2 points. */
export function theilSen(xs, ys) {
  const slopes = [];
  for (let i = 0; i < xs.length; i++) for (let j = i + 1; j < xs.length; j++) if (xs[j] !== xs[i]) slopes.push((ys[j] - ys[i]) / (xs[j] - xs[i]));
  return slopes.length ? median(slopes) : null;
}

/** True when two medians' intervals (summary().ci) do not overlap: the difference is larger than the noise. */
export const apart = (a, b) => !!a && !!b && Math.abs(a.median - b.median) > a.ci + b.ci;
