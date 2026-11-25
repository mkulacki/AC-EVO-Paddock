// PL8: the pure rules of setup experiments (src/experimentstats.js) on hand-written lap rows with known answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as X from '../src/experimentstats.js';

const COMBO = { track: 'trk', layout: 'gp', car: 'car' };
let nextId = 1;
/** A lap row as the database gives it (getLapMeta columns). */
const lap = (at, ms, { valid = true, game = '1.0', rel = null, snap = null, roadC = 30, airC = 20, session = 1, aids = null } = {}) => ({
  id: nextId++, session_id: session, recorded_at: at, lap_time_ms: ms, valid: valid ? 1 : 0, ...COMBO, source: 'local',
  setup_name: rel ? rel.split('/').pop() : null, setup_info: rel ? JSON.stringify({ rel, snap, match: 'matched' }) : null,
  cond: JSON.stringify({ game, roadC, airC }), aids: aids ? JSON.stringify({ cls: aids }) : null,
});
const variants = { A: { label: 'Base', rel: 'c/t/Base.carsetup', snap: 'sa' }, B: { label: 'Wing', rel: 'c/t/Wing.carsetup', snap: 'sb' } };
const vOpt = (k) => ({ rel: variants[k].rel, snap: variants[k].snap });

/**
 * Stints in the given order (e.g. 'ABBA'), each `n` laps one minute apart, times from fn(variant, lapIndexInStint,
 * stintIndex); laps recognised as the stint's own setup. -> {exp, laps}
 */
function build(order, n, fn, { warmup = 1, extra = () => ({}) } = {}) {
  const laps = [], stints = [];
  [...order].forEach((v, s) => {
    const t0 = 1e7 + s * 1e7;
    stints.push({ id: s + 1, variant: v, startAt: t0, endAt: t0 + n * 6e4 + 1 });
    for (let i = 0; i < n; i++) laps.push(lap(t0 + (i + 1) * 6e4, fn(v, i, s), { ...vOpt(v), ...extra(v, i, s) }));
  });
  return { exp: { variants, plan: { pattern: 'ABBA', warmup }, stints, game: '1.0', expected: { metric: 'pace', direction: 'better' } }, laps };
}
// small deterministic noise, ±150 ms
const noise = (i, s) => [0, 120, -90, 60, -150, 30, 90, -60][(i * 3 + s) % 8];

test('a clear gap over ABBA stints: a difference, from typical laps, warm-up laps left out; never the best lap alone', () => {
  // B is 600 ms quicker on the typical lap; A holds the single best lap of all (a lucky one)
  const { exp, laps } = build('ABBA', 6, (v, i, s) => 100000 + (v === 'B' ? -600 : 0) + noise(i, s) + (v === 'A' && s === 0 && i === 3 ? -1200 : 0) + (i === 0 ? 2500 : 0));
  const r = X.evaluate(exp, laps, { currentGame: '1.0' });
  assert.equal(r.variants.A.excluded.warmup, 2);
  assert.equal(r.variants.B.excluded.warmup, 2);
  assert.equal(r.variants.A.used, 10);
  assert.equal(r.variants.B.used, 10);
  assert.ok(r.variants.A.bestMs < r.variants.B.bestMs, 'A has the best lap');
  assert.equal(r.comparison.kind, 'difference');
  assert.equal(r.comparison.faster, 'B', 'decided on typical laps, not the best lap');
  assert.ok(Math.abs(r.comparison.deltaMs + 600) < 200, `delta ${r.comparison.deltaMs}`);
  assert.match(r.comparison.text, /^Wing's typical lap was 0\.\d{3} s quicker \(10 and 10 counted laps over 2 and 2 stints\).*does not prove/);
  assert.equal(r.expected.status, 'supported');
  assert.equal(r.confounds.find((c) => c.key === 'order').strong, false, 'ABBA balances the order');
  assert.equal(r.plan.done, 4);
  assert.equal(r.plan.complete, true);
});

test('the same pace: inconclusive inside the noise, said as "not shown the same"', () => {
  const { exp, laps } = build('ABBA', 6, (v, i, s) => 100000 + noise(i, s + (v === 'B' ? 1 : 0)));
  const r = X.evaluate(exp, laps);
  assert.equal(r.comparison.kind, 'inconclusive');
  assert.equal(r.comparison.why, 'noise');
  assert.match(r.comparison.text, /inside the lap-to-lap noise.*does not show the setups are the same/);
  assert.equal(r.expected.status, 'inconclusive');
});

test('too few laps: inconclusive with the counts', () => {
  const { exp, laps } = build('AB', 4, (v) => (v === 'B' ? 99000 : 100000));
  const r = X.evaluate(exp, laps);
  assert.equal(r.comparison.why, 'laps');
  assert.match(r.comparison.text, /at least 5 counted laps \(A has 3, B has 3\)/);
});

test('one stint each: a clear gap stays inconclusive and the stint order is a strong confound', () => {
  const { exp, laps } = build('AB', 8, (v, i, s) => 100000 + (v === 'B' ? -800 : 0) + noise(i, s));
  const r = X.evaluate(exp, laps);
  assert.equal(r.comparison.kind, 'inconclusive');
  assert.equal(r.comparison.why, 'stints');
  assert.equal(r.comparison.lean, 'B');
  assert.match(r.comparison.text, /each setup was driven in one stint only/);
  const order = r.confounds.find((c) => c.key === 'order');
  assert.equal(order.strong, true);
  assert.match(order.text, /^Stint order: Wing was driven later on average/);
});

test('exclusions: invalid, game versions, recognised as the other setup or other values, conditions, aids, slow laps; each counted', () => {
  const special = {
    1: { valid: false }, 2: { game: '1.1' }, 3: { game: null }, 4: { rel: variants.B.rel, snap: 'sb' }, 5: { snap: 'old' }, 6: { roadC: 45 }, 7: { aids: 'assisted' },
  };
  const { exp, laps } = build('ABBA', 12, (v, i, s) => 100000 + noise(i, s) + (s === 0 && i === 8 ? 5000 : 0), {
    extra: (v, i, s) => (s === 0 && special[i] ? special[i] : s !== 0 || i >= 1 ? { aids: 'pro' } : {}),
  });
  const r = X.evaluate(exp, laps, { statusOf: () => 'verified' });
  assert.deepEqual(r.variants.A.excluded, { warmup: 2, invalid: 1, 'version-other': 1, 'version-unknown': 1, 'setup-other': 1, 'setup-values': 1, conditions: 1, aids: 1, slow: 1 });
  assert.equal(r.variants.A.used, 24 - 10);
  assert.equal(r.excludedTotal, 10 + 2);
  assert.equal(r.patch.otherVersion, 1);
  assert.equal(r.patch.unknownVersion, 1);
  for (const k of Object.keys(r.variants.A.excluded)) assert.ok(X.REASONS[k], k);
  // matched conditions off: the conditions and aids laps count again, and the confound says so
  const off = X.evaluate({ ...exp, plan: { ...exp.plan, matchConditions: false } }, laps, { statusOf: () => 'verified' });
  assert.equal(off.variants.A.excluded.conditions, undefined);
  assert.equal(off.variants.A.excluded.aids, undefined);
  assert.ok(off.confounds.some((c) => c.key === 'conditions' && /Matched conditions are off/.test(c.text)));
});

test('readings not checked against the game: a similar temperature is not a reason to leave a lap out; a lap recognised wrongly cannot be told', () => {
  const { exp, laps } = build('ABBA', 6, (v, i, s) => 100000 + noise(i, s), { extra: (v, i, s) => (s === 1 && i === 2 ? { roadC: 33 } : {}) });
  const r = X.evaluate(exp, laps, { statusOf: () => 'unverified', probe: 'unverified' });
  assert.equal(r.variants.B.excluded.conditions, undefined);
  assert.ok(r.confounds.some((c) => c.key === 'recognition' && /not checked against the game/.test(c.text)));
  // pit-box readings marked as wrong: recognition is ignored, stints alone decide
  const { exp: e2, laps: l2 } = build('ABBA', 6, (v, i, s) => 100000 + noise(i, s), { extra: (v, i, s) => (s === 0 && i === 2 ? { rel: variants.B.rel } : {}) });
  assert.equal(X.evaluate(e2, l2, { probe: 'verified' }).variants.A.excluded['setup-other'], 1);
  assert.equal(X.evaluate(e2, l2, { probe: 'mismatch' }).variants.A.excluded['setup-other'], undefined);
});

test('learning: a steady improvement with the same setup of the size of the gap is a strong confound', () => {
  // each lap 60 ms quicker than the one before over the whole experiment; B 300 ms quicker
  let k = 0;
  const { exp, laps } = build('ABAB', 6, (v) => 101000 - 60 * k++ + (v === 'B' ? -300 : 0));
  const r = X.evaluate(exp, laps);
  const l = r.confounds.find((c) => c.key === 'learning');
  assert.equal(l.strong, true, l.text);
  assert.match(l.text, /came down by about 0\.06 s a lap.*part of the gap may be you, not the setup/);
  assert.equal(r.confounds.find((c) => c.key === 'order').strong, true, 'ABAB: B later on average');
});

test('stints: by session or by time window (an open one runs to now); a lap in no stint is not part of it', () => {
  const laps = [lap(100, 1, { session: 7 }), lap(200, 1, { session: 8 }), lap(300, 1, { session: 8 }), lap(5000, 1, { session: 9 })];
  const m = X.assign([{ id: 1, variant: 'A', sessionId: 7 }, { id: 2, variant: 'B', startAt: 250, endAt: null }], laps, 1000);
  assert.deepEqual([...m.keys()], [laps[0].id, laps[2].id]);
  assert.deepEqual(X.planProgress({ pattern: 'ABAB' }, [{ id: 1, variant: 'A', sessionId: 7 }]), { pattern: 'ABAB', sequence: ['A', 'B', 'A', 'B'], lapsPerStint: 6, warmup: 1, done: 1, open: null, next: 'B', complete: false });
  const p = X.planProgress({}, [{ id: 1, variant: 'A', startAt: 5, endAt: null }]);
  assert.deepEqual([p.pattern, p.done, p.next, p.open.variant], ['ABBA', 0, null, 'A']);
});

test('handling feedback by corner phase, per setup; unknown phases or balances ignored', () => {
  const f = X.feedbackSummary([
    { data: { variant: 'A', phase: 'entry', balance: 'understeer', corner: 'T1' } }, { data: { variant: 'A', phase: 'entry', balance: 'understeer' } },
    { data: { variant: 'B', phase: 'exit', balance: 'oversteer', corner: 'T3' } }, { data: { variant: 'B', phase: 'apex', balance: 'x' } }]);
  assert.equal(f.A.entry.understeer, 2);
  assert.equal(f.B.exit.oversteer, 1);
  assert.deepEqual(f.count, { A: 2, B: 1 });
  assert.deepEqual(f.corners, ['T1', 'T3']);
});

test('expected outcomes: pace against the result; consistency and validity descriptive only; a game update is flagged', () => {
  const { exp, laps } = build('ABBA', 6, (v, i, s) => 100000 + (v === 'B' ? 600 : 0) + noise(i, s));
  assert.equal(X.evaluate(exp, laps).expected.status, 'not-supported');
  assert.equal(X.evaluate({ ...exp, expected: { metric: 'pace', direction: 'worse' } }, laps).expected.status, 'supported');
  const c = X.evaluate({ ...exp, expected: { metric: 'consistency', direction: 'better' } }, laps).expected;
  assert.equal(c.status, 'descriptive');
  assert.match(c.text, /^Spread \(IQR\) B .* Descriptive only/);
  assert.equal(X.evaluate({ ...exp, expected: { metric: 'validity' } }, laps).expected.status, 'descriptive');
  const r = X.evaluate(exp, laps, { currentGame: '1.1' });
  assert.deepEqual([r.patch.game, r.patch.current, r.patch.changed], ['1.0', '1.1', true]);
  // created without a known version: the first lap's version is the experiment's
  const r2 = X.evaluate({ ...exp, game: null }, laps);
  assert.deepEqual([r2.game, r2.gameFrom], ['1.0', 'first lap']);
});

test('Hodges–Lehmann shift: the median of all pairwise differences', () => {
  assert.equal(X.shift([1, 2, 3], [11, 12, 13]), 10);
  assert.equal(X.shift([], [1]), null);
});
