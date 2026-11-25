// Setup experiments (PL8): the pure rules. Which laps of an A/B experiment count, the descriptive statistics of each
// setup, and what may be said about the difference. Deterministic, no state, no database: src/experiments.js hands in
// the laps (database rows) and what each reading is worth. Rules and limits: docs/platform/EXPERIMENTS.md.
//
// Principles (the plan's PL8 statistics rules):
//   - never the best lap alone: the typical lap (median) of every counted lap, its spread (IQR) and the ~95 % interval
//     of the median (src/stats.js summary().ci); the best lap is shown, labelled as not used
//   - warm-up laps, invalid laps, slow laps (traffic, a mistake, an off: Paddock cannot tell which), laps on another or
//     an unknown game version, laps recognised as another setup and laps in other conditions (PL4 compat.classify)
//     are left out, each with its reason and count
//   - "inconclusive" is a result: too few laps, a gap inside the noise, or one stint per setup
//   - stint order, learning, tyres, fuel and traffic are stated as confounds; nothing is called a cause
import * as stats from './stats.js';
import * as compat from './compat.js';

/** The limits. docs/DECISIONS.md OD-PL-42 … 49 (operator defaults, user reviews in the app). */
export const RULES = {
  minLaps: 5,        // counted laps per setup before any comparison
  minStints: 2,      // stints per setup before a difference is called (one stint each cannot separate setup from order)
  slowPct: 3,        // a lap more than 3 % slower than its setup's median is left out (traffic, a mistake or an off)
  warmup: 1,         // default warm-up laps left out at the start of each stint (cold tyres, finding the rhythm)
  maxWarmup: 5,
  lapsPerStint: 6,   // default planned laps per stint
  trendShare: 0.5,   // a within-setup drift over the experiment above half the gap: learning flagged as a strong confound
  minCiMs: 50,       // the smallest median interval used (PL8 review): identical or 1 ms-resolution times give IQR 0, and a 0 ms
                     // interval would make any gap 'beyond the noise'; lap times in AC EVO vary by more than this lap to lap
  segmentGapMs: 5 * 60e3, // within a stint, a new session or a pause this long starts a new run: its first laps are warm-up too
  unknownShare: 0.5, // more than half of a setup's counted laps without recorded conditions: no clean 'difference' (OD-PL-46 review)
};
/** Own keys only: a request's 'constructor' or 'toString' is never a pattern, measure, phase … (PL8 review). */
export const has = (o, k) => typeof k === 'string' && Object.hasOwn(o, k);
/** The medians' intervals, each at least RULES.minCiMs, do not overlap. */
export const apart = (a, b) => !!a && !!b && Math.abs(a.median - b.median) > Math.max(a.ci, RULES.minCiMs) + Math.max(b.ci, RULES.minCiMs);
const ciOf = (sm) => Math.max(sm.ci, RULES.minCiMs);
export const PATTERNS = { ABBA: ['A', 'B', 'B', 'A'], ABAB: ['A', 'B', 'A', 'B'], ABA: ['A', 'B', 'A'], AB: ['A', 'B'] };
export const METRICS = { pace: 'Pace (typical lap)', consistency: 'Consistency (spread)', validity: 'Valid laps', handling: 'Handling (your feedback)' };
export const DIRECTIONS = { better: 'B better than A', worse: 'B worse than A', same: 'no difference' };
export const PHASES = { entry: 'Entry', mid: 'Mid-corner', exit: 'Exit' };
export const BALANCE = { understeer: 'Understeer', neutral: 'Neutral', oversteer: 'Oversteer' };
export const REASONS = {
  warmup: 'Warm-up lap (start of a stint)',
  invalid: 'Invalid lap',
  'version-unknown': 'Game version not recorded',
  'version-other': 'Another game version',
  'setup-other': 'Recognised as another setup',
  'setup-values': 'Same setup file with other values',
  conditions: 'Different conditions',
  aids: 'Different driving aids',
  session: 'Different session type',
  slow: `Slow lap: traffic, a mistake or an off (over ${RULES.slowPct} % off the typical lap)`,
};
const SESSION_RACE = 1;

const parse = (v) => { if (!v) return null; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return null; } };
const s3 = (ms) => `${(Math.abs(ms) / 1000).toFixed(3)} s`;
const s2 = (ms) => `${(Math.abs(ms) / 1000).toFixed(2)} s`;
const plural = (n, w, ws = `${w}s`) => `${n} ${n === 1 ? w : ws}`;

/** The most frequent known value (the first seen of a tie), or null. */
function modeOf(vals) {
  const counts = new Map();
  for (const v of vals) if (v != null && v !== '') counts.set(v, (counts.get(v) || 0) + 1);
  let best = null;
  for (const [v, n] of counts) if (best == null || n > counts.get(best)) best = v;
  return best;
}

/** Hodges–Lehmann shift of b against a: the median of every difference b_j − a_i. null when either is empty. */
export function shift(a, b) {
  const d = [];
  for (const y of b) for (const x of a) d.push(y - x);
  return d.length ? stats.median(d) : null;
}

/** Which stint each lap belongs to: laps in a stint's session, or recorded inside its time window. -> Map(lapId -> stint) */
// Deterministic and never twice (PL8 review): a session stint takes its session's laps; a time window takes only laps of
// sessions that are no stint of their own; windows are tried oldest first (src/experiments.js refuses overlaps anyway).
export function assign(stints, laps, now = Date.now()) {
  const out = new Map();
  const bySession = new Map(stints.filter((st) => st.sessionId != null).map((st) => [st.sessionId, st]));
  const windows = stints.filter((st) => st.sessionId == null).sort((a, b) => a.startAt - b.startAt || a.id - b.id);
  const sorted = [...laps].sort((a, b) => a.recorded_at - b.recorded_at || a.id - b.id);
  for (const l of sorted) {
    const s = bySession.get(l.session_id) ?? (bySession.has(l.session_id) ? null : windows.find((st) => l.recorded_at >= st.startAt && l.recorded_at <= (st.endAt ?? now)));
    if (s) out.set(l.id, s);
  }
  return out;
}

/** The planned stints and how far the driver is: {pattern, sequence, lapsPerStint, warmup, done, next}. */
export function planProgress(plan = {}, stints = [], lapsOf = null) {
  const sequence = has(PATTERNS, plan.pattern) ? PATTERNS[plan.pattern] : PATTERNS.ABBA;
  // a finished stint without a lap (its laps deleted, or ended before any lap) is not a driven stint (PL8 review)
  const empty = lapsOf ? stints.filter((s) => (s.endAt != null || s.sessionId != null) && !lapsOf(s.id)).map((s) => s.id) : [];
  const done = stints.filter((s) => (s.endAt != null || s.sessionId != null) && !empty.includes(s.id)).length;
  const open = stints.find((s) => s.endAt == null && s.sessionId == null) || null;
  return { pattern: has(PATTERNS, plan.pattern) ? plan.pattern : 'ABBA', sequence, empty, lapsPerStint: plan.lapsPerStint ?? RULES.lapsPerStint, warmup: plan.warmup ?? RULES.warmup,
    done, open: open ? { id: open.id, variant: open.variant, startAt: open.startAt } : null, next: open ? null : sequence[done] ?? null, complete: done >= sequence.length };
}

/** Handling feedback by corner phase: {A: {entry: {understeer, neutral, oversteer}, …}, B: …, notes: n, corners: [names]}. */
export function feedbackSummary(entries) {
  const blank = () => Object.fromEntries(Object.keys(PHASES).map((p) => [p, Object.fromEntries(Object.keys(BALANCE).map((b) => [b, 0]))]));
  const out = { A: blank(), B: blank(), count: { A: 0, B: 0 }, corners: [] };
  const corners = new Set();
  for (const e of entries) {
    const f = e.data || {};
    if ((f.variant !== 'A' && f.variant !== 'B') || !has(PHASES, f.phase) || !has(BALANCE, f.balance)) continue;
    out[f.variant][f.phase][f.balance]++;
    out.count[f.variant]++;
    if (f.corner) corners.add(f.corner);
  }
  out.corners = [...corners];
  return out;
}

/**
 * The experiment's laps and what may be said about A against B.
 *   exp:  {variants: {A: {label, rel, snap}, B: …}, plan: {pattern, lapsPerStint, warmup, matchConditions}, stints, game, expected}
 *   laps: database rows of the car + track (own laps; getLapMeta columns), any order
 *   ctx:  {sessionTypes: Map(sessionId -> type), probe: setupProbe status, statusOf: group -> status (compat),
 *          currentGame: the game version now (null = not known), feedback: journal entries of kind 'feedback', now}
 */
export function evaluate(exp, laps, ctx = {}) {
  const now = ctx.now ?? Date.now();
  const statusOf = ctx.statusOf || (() => 'unverified');
  const probe = ctx.probe || 'unverified';
  const warmup = Math.max(0, Math.min(RULES.maxWarmup, exp.plan?.warmup ?? RULES.warmup));
  const filter = exp.plan?.matchConditions !== false;
  const stintOf = assign(exp.stints || [], laps, now);
  const inExp = laps.filter((l) => stintOf.has(l.id)).sort((a, b) => a.recorded_at - b.recorded_at || a.id - b.id);

  // the experiment's game version: the one it was created on, else the first of its laps that recorded one
  const gameOf = (l) => { const c = parse(l.cond); return typeof c?.game === 'string' && c.game ? c.game : null; };
  const firstGame = inExp.map(gameOf).find(Boolean) || null;
  const game = exp.game || firstGame;

  // warm-up per run (PL8 review): a new session inside a stint, or a pause of RULES.segmentGapMs, starts a new run
  const run = new Map(); // stint id -> {session, at, i}
  const rows = inExp.map((l) => {
    const st = stintOf.get(l.id);
    const prev = run.get(st.id);
    const fresh = !prev || prev.session !== (l.session_id ?? null) || l.recorded_at - prev.at > RULES.segmentGapMs;
    const i = fresh ? 0 : prev.i + 1;
    run.set(st.id, { session: l.session_id ?? null, at: l.recorded_at, i });
    const prov = compat.provenance(l, { sessionType: ctx.sessionTypes?.get(l.session_id) ?? null });
    return { id: l.id, sessionId: l.session_id ?? null, recordedAt: l.recorded_at, stint: st.id, variant: st.variant, idx: i, timeMs: l.lap_time_ms, valid: !!l.valid,
      game: gameOf(l), info: parse(l.setup_info), prov, reason: null, unrecognised: false };
  });

  // 1. warm-up, validity, game version, setup recognition
  const other = { A: 'B', B: 'A' };
  for (const r of rows) {
    const v = exp.variants[r.variant] || {}, o = exp.variants[other[r.variant]] || {};
    if (r.idx < warmup) r.reason = 'warmup';
    else if (!r.valid) r.reason = 'invalid';
    else if (!r.game) r.reason = 'version-unknown';
    else if (game && r.game !== game) r.reason = 'version-other';
    else if (probe !== 'mismatch' && r.info?.rel) {
      // recognised as a saved file: another file than the stint's setup, or this file with other values
      if (v.rel ? r.info.rel !== v.rel : o.rel && r.info.rel === o.rel) r.reason = 'setup-other';
      else if (v.rel && v.snap && r.info.snap && r.info.snap !== v.snap) r.reason = 'setup-values';
    } else if (probe !== 'mismatch') r.unrecognised = true;
  }
  // 2. matched conditions (PL4 compat): against the experiment's typical conditions, from the laps still in
  const cand = rows.filter((r) => !r.reason);
  const ps = cand.map((r) => r.prov);
  const ref = {
    roadC: stats.median(ps.map((p) => p.roadC)), airC: stats.median(ps.map((p) => p.airC)),
    weather: modeOf(ps.map((p) => p.weather)), grip: modeOf(ps.map((p) => p.grip)), aids: modeOf(ps.map((p) => p.aids)), sessionType: modeOf(ps.map((p) => p.sessionType)),
  };
  const unknown = new Map();
  for (const r of cand) {
    const b = { ...r.prov, ...ref, id: 'ref', setup: r.prov.setup, setupName: r.prov.setupName, game: r.prov.game };
    const c = compat.classify(r.prov, b, { statusOf });
    // (the setup and game version are checked above, by the stint and the experiment's version)
    for (const u of c.unknown) if (!/^(setup|game version)/.test(u)) unknown.set(u, (unknown.get(u) || 0) + 1);
    if (!filter) continue;
    const hit = (k) => c.items.some((it) => it.key === k && !it.unconfirmed);
    if (hit('conditions')) r.reason = 'conditions';
    else if (hit('aids')) r.reason = 'aids';
    else if (hit('session')) r.reason = 'session';
  }
  // 3. slow laps against their own setup's typical lap
  for (const k of ['A', 'B']) {
    const left = rows.filter((r) => r.variant === k && !r.reason);
    const med = stats.median(left.map((r) => r.timeMs));
    if (med != null) for (const r of left) if (r.timeMs > med * (1 + RULES.slowPct / 100)) r.reason = 'slow';
  }

  // per setup
  const order = [...new Set(rows.map((r) => r.stint))];
  const variant = (k) => {
    const mine = rows.filter((r) => r.variant === k);
    const used = mine.filter((r) => !r.reason);
    const afterWarm = mine.filter((r) => r.reason !== 'warmup');
    const excluded = {};
    for (const r of mine) if (r.reason) excluded[r.reason] = (excluded[r.reason] || 0) + 1;
    const stintIds = [...new Set(used.map((r) => r.stint))];
    const pos = used.map((r) => rows.indexOf(r));
    const sm = stats.summary(used.map((r) => r.timeMs));
    return {
      key: k, label: exp.variants[k]?.label || k, laps: mine.length, used: used.length, excluded,
      stints: stintIds.length, stintsDriven: new Set(mine.map((r) => r.stint)).size, stintOrder: stintIds.map((id) => order.indexOf(id) + 1),
      summary: sm, bestMs: used.length ? Math.min(...used.map((r) => r.timeMs)) : null,
      validity: { valid: afterWarm.filter((r) => r.valid).length, of: afterWarm.length },
      unrecognised: used.filter((r) => r.unrecognised).length,
      // counted laps with no recorded conditions at all (no track or air temperature, weather or grip)
      noConditions: used.filter((r) => r.prov.roadC == null && r.prov.airC == null && r.prov.weather == null && r.prov.grip == null).length,
      trendMsPerLap: used.length >= RULES.minLaps ? stats.theilSen(pos, used.map((r) => r.timeMs)) : null,
    };
  };
  const A = variant('A'), B = variant('B');

  // the comparison
  const cmp = { kind: 'inconclusive', why: null, deltaMs: null, shiftMs: null, faster: null, lean: null, text: '' };
  if (A.used >= 1 && B.used >= 1) {
    cmp.deltaMs = Math.round(B.summary.median - A.summary.median);
    cmp.shiftMs = Math.round(shift(rows.filter((r) => r.variant === 'A' && !r.reason).map((r) => r.timeMs), rows.filter((r) => r.variant === 'B' && !r.reason).map((r) => r.timeMs)));
    cmp.lean = cmp.deltaMs < 0 ? 'B' : cmp.deltaMs > 0 ? 'A' : null;
  }
  const quicker = (k) => (k === 'B' ? B.label : A.label);
  if (A.used < RULES.minLaps || B.used < RULES.minLaps) {
    cmp.why = 'laps';
    cmp.text = `Inconclusive: not enough laps yet. Each setup needs at least ${RULES.minLaps} counted laps (A has ${A.used}, B has ${B.used}).`;
  } else if (!apart(A.summary, B.summary)) {
    cmp.why = 'noise';
    cmp.text = `Inconclusive: the typical laps differ by ${s3(cmp.deltaMs)}, which is inside the lap-to-lap noise (A ±${s3(ciOf(A.summary))}, B ±${s3(ciOf(B.summary))}; never taken as less than ±${s3(RULES.minCiMs)}). This does not show the setups are the same, only that these laps can't tell them apart.`;
  } else if (A.stints < RULES.minStints || B.stints < RULES.minStints) {
    cmp.why = 'stints';
    cmp.text = `Inconclusive: ${quicker(cmp.lean)}'s typical lap was ${s3(cmp.deltaMs)} quicker, more than the noise, but ${A.stints < RULES.minStints && B.stints < RULES.minStints ? 'each setup was' : `${A.stints < RULES.minStints ? 'A' : 'B'} was`} driven in one stint only, so the gap can't be told apart from what changed between the stints (learning, tyres, fuel, the track). Drive the remaining stints of the plan.`;
  } else if (A.noConditions > RULES.unknownShare * A.used || B.noConditions > RULES.unknownShare * B.used) {
    // OD-PL-46 refinement (review): a gap on laps whose conditions were not recorded is never a clean difference
    cmp.why = 'conditions';
    cmp.text = `Inconclusive: ${quicker(cmp.lean)}'s typical lap was ${s3(cmp.deltaMs)} quicker, more than the noise, but the conditions were not recorded for most of the counted laps (A ${A.noConditions} of ${A.used}, B ${B.noConditions} of ${B.used}), so Paddock can't tell whether both setups were driven in the same conditions.`;
  } else {
    cmp.kind = 'difference'; cmp.faster = cmp.lean;
    cmp.text = `${quicker(cmp.faster)}'s typical lap was ${s3(cmp.deltaMs)} quicker (${A.used} and ${B.used} counted laps over ${A.stints} and ${B.stints} stints), more than the lap-to-lap noise. This is a difference in these laps; it suggests, but does not prove, that the setup caused it (see what else changed below).`;
  }

  // confounds: always stated; strong when the numbers point at them
  const confounds = [];
  const meanPos = (v) => (v.stintOrder.length ? v.stintOrder.reduce((a, b) => a + b, 0) / v.stintOrder.length : null);
  const pa = meanPos(A), pb = meanPos(B);
  if (pa != null && pb != null && Math.abs(pa - pb) >= 0.5) {
    const later = pb > pa ? B : A;
    confounds.push({ key: 'order', strong: true, text: `Stint order: ${later.label} was driven later on average (stints ${later.stintOrder.join(', ')} of ${order.length}). If you were still learning, or the track was gaining grip, that favours ${later.label}.` });
  } else confounds.push({ key: 'order', strong: false, text: 'Stint order: A and B were driven equally early on average, which balances a steady trend (learning, track grip) but not a sudden change.' });
  const trends = [A.trendMsPerLap, B.trendMsPerLap].filter((v) => v != null);
  if (trends.length) {
    const slope = stats.median(trends), drift = Math.abs(slope) * Math.max(1, rows.filter((r) => !r.reason).length - 1);
    const strong = cmp.deltaMs != null && drift > RULES.trendShare * Math.abs(cmp.deltaMs) && drift >= 50;
    confounds.push({ key: 'learning', strong, text: `Learning: with the same setup your lap times ${slope < 0 ? 'came down' : 'went up'} by about ${s2(slope)} a lap (${s2(drift)} over the experiment)${strong ? ', which is of the size of the gap: part of the gap may be you, not the setup' : ''}.` });
  } else confounds.push({ key: 'learning', strong: false, text: 'Learning: not measurable yet (too few counted laps per setup).' });
  confounds.push({ key: 'tyres', strong: false, text: 'Tyres and fuel: tyre wear and fuel load per stint are not recorded. Start each stint on the same fuel and tyres where you can.' });
  if (rows.some((r) => r.prov.sessionType === SESSION_RACE)) confounds.push({ key: 'traffic', strong: false, text: `Traffic: some laps are from race sessions. Paddock can't see traffic: laps over ${RULES.slowPct} % slow are left out, smaller losses stay in.` });
  if (probe !== 'verified') confounds.push({ key: 'recognition', strong: false, text: probe === 'mismatch'
    ? 'Setup recognition is marked as wrong, so laps count by your stints only: Paddock can\'t check you were on the right setup.'
    : 'Setup recognition is not checked against the game yet: laps count by your stints, and a lap recognised as the other setup is left out, but a wrong recognition can\'t be detected.' });
  if (!filter) confounds.push({ key: 'conditions', strong: false, text: 'Matched conditions are off: laps in other temperatures, weather, grip, aids or session types count too.' });
  else if (unknown.size) confounds.push({ key: 'conditions', strong: false, text: `Not recorded for some laps, so not matched: ${[...unknown].map(([k, n]) => `${k} (${plural(n, 'lap')})`).join(', ')}.` });

  // the expected outcome
  const ex = exp.expected || {};
  const expected = { metric: ex.metric || 'pace', direction: ex.direction || 'better', status: 'inconclusive', text: '' };
  const leanWord = (better) => (better == null ? 'no lean either way' : better ? 'B better' : 'B worse');
  if (expected.metric === 'pace') {
    if (cmp.kind === 'difference') {
      const bBetter = cmp.faster === 'B';
      expected.status = expected.direction === 'same' ? 'not-supported' : (expected.direction === 'better') === bBetter ? 'supported' : 'not-supported';
      expected.text = expected.status === 'supported' ? 'The laps agree with what you expected.' : 'The laps do not agree with what you expected.';
    } else expected.text = expected.direction === 'same' && cmp.why === 'noise' ? 'No difference showed, as you expected, but that is not proof the setups are the same.' : 'Not decided yet: the pace comparison is inconclusive.';
  } else if (expected.metric === 'consistency') {
    expected.status = 'descriptive';
    const ok = A.used >= RULES.minLaps && B.used >= RULES.minLaps;
    expected.text = ok ? `Spread (IQR) B ${s3(B.summary.iqr)} against A ${s3(A.summary.iqr)}: ${leanWord(B.summary.iqr < A.summary.iqr ? true : B.summary.iqr > A.summary.iqr ? false : null)}. Descriptive only: spreads at these lap counts have no reliable interval.`
      : `Not enough laps to describe the spread (${RULES.minLaps} counted laps per setup).`;
  } else if (expected.metric === 'validity') {
    expected.status = 'descriptive';
    const sh = (v) => (v.validity.of ? v.validity.valid / v.validity.of : null);
    expected.text = A.validity.of && B.validity.of ? `Valid laps B ${B.validity.valid} of ${B.validity.of} against A ${A.validity.valid} of ${A.validity.of}: ${leanWord(sh(B) > sh(A) ? true : sh(B) < sh(A) ? false : null)}. Descriptive only.` : 'No laps yet.';
  } else {
    expected.status = 'descriptive';
    expected.text = 'Handling is judged from your own feedback by corner phase (below); Paddock does not measure it.';
  }

  const fb = feedbackSummary(ctx.feedback || []);
  const otherVersion = rows.filter((r) => r.reason === 'version-other').length, unknownVersion = rows.filter((r) => r.reason === 'version-unknown').length;
  return {
    game, gameFrom: exp.game ? 'created' : firstGame ? 'first lap' : null,
    patch: { game, current: ctx.currentGame ?? null, changed: !!(game && ctx.currentGame && ctx.currentGame !== game), otherVersion, unknownVersion },
    filter, reference: { roadC: ref.roadC, airC: ref.airC, weather: ref.weather, grip: ref.grip, aids: ref.aids, sessionType: ref.sessionType },
    variants: { A, B }, comparison: cmp, expected, confounds, feedback: fb, plan: planProgress(exp.plan, exp.stints || [], (id) => rows.some((r) => r.stint === id)),
    laps: rows.map((r) => ({ id: r.id, variant: r.variant, stint: r.stint, idx: r.idx, timeMs: r.timeMs, valid: r.valid, game: r.game, reason: r.reason, sessionId: r.sessionId, recordedAt: r.recordedAt })),
    excludedTotal: rows.filter((r) => r.reason).length, lapsTotal: rows.length,
  };
}
