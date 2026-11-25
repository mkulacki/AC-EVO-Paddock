// Actionable lap analysis (PL6): ranked corner opportunities, where in the corner the time goes, what the faster passes
// did differently (braking, brake release, apex speed, throttle, gear), corner distributions, a repeatability-based
// target lap, multi-session trends and what made the personal best faster. Deterministic, no AI.
//
// Pure: it gets numbers that src/service.js measured on the laps (src/analysis.js cornerMetrics + phaseTimes) and
// returns numbers and sentences. Algorithms, thresholds and limits: docs/platform/ANALYSIS.md (keep them in step).
//
// Rules (from the plan): what was measured (observations) is kept apart from what it might mean (interpretations,
// always worded as a possibility); a difference between faster and slower passes is an association, not a proven
// cause; nothing is concluded from fewer than RULES.minPasses passes; every insight names its corner and links to the
// chart that shows it; uncertainty is shown as a range and a confidence word instead of more decimals.
import { summary, sorted, quantile, quantileRange, median, mode, theilSen, apart } from './stats.js';

export const RULES = {
  minPasses: 5,              // valid passes a corner needs before anything is concluded about it
  confidence: { medium: 10, high: 20 }, // passes for 'medium' / 'high' confidence (below: 'low')
  minGainMs: 30,             // a realistic gain below this is too small to tell from noise: not listed
  top: 3,                    // opportunities shown first
  fastQuantile: 0.25,        // "your faster passes" = the quickest quarter of the passes of a corner
  gearGroupMin: 3,           // passes in each gear before two gears are compared
  trendPassesMin: 3,         // valid laps a session needs to count in a trend
  trendSessionsMin: 3,       // sessions a trend needs
  trendSessionsMax: 10,      // newest sessions in a trend
  trendMinMs: { lap: 100, corner: 30 }, // smallest first-to-latest change called faster / slower (review fix 4)
  diff: {                    // smallest difference worth naming (the session report's levels where they exist)
    brakePointM: 5, releasePointM: 5, releaseMs: 100, releaseRel: 0.25, minSpeedKmh: 2, exitSpeedKmh: 3,
    pickupM: 8, pickupMs: 150, pickupRel: 0.25, holdMs: 150, phaseMs: 20,
  },
};

export const CAUSATION_NOTE = 'These are differences between your faster and your typical passes. They go together with the time, but they do not prove what causes it: try one change at a time and check the result.';
export const PHASES = [['entryMs', 'entry'], ['apexMs', 'apex'], ['exitMs', 'exit']];

const r0 = (v) => (v == null ? null : Math.round(v));
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const s2 = (ms) => `${(Math.abs(ms) / 1000).toFixed(2)} s`;
const confidenceOf = (n) => (n < RULES.minPasses ? 'insufficient' : n < RULES.confidence.medium ? 'low' : n < RULES.confidence.high ? 'medium' : 'high');
const ord = (g) => (g === 1 ? '1st' : g === 2 ? '2nd' : g === 3 ? '3rd' : `${g}th`);
const nth = (list, k, key) => list.map((p) => p.c[k]?.[key]);

export const PASSES = { fast: 'Faster passes', typ: 'your typical pass', Typ: 'Your typical pass', plural: true };
/**
 * What the faster passes did differently from the typical pass of a corner (medians of each group). Only metrics both
 * groups have (passes of laps that hold the channel) and only differences of at least RULES.diff.
 * typ / fast: {metric: value} medians; n: {typ, fast}. Returns [{key, kind, observation, interpretation, size}].
 * who: the names of the two sides (PASSES, or the PB explanation's 'your best lap' / 'your previous best').
 */
export function differences(typ, fast, { gear = null, who = PASSES } = {}) {
  const D = RULES.diff, out = [];
  const F = who.fast, v = (p, s) => (who.plural ? p : s);
  const has = (k) => typ[k] != null && fast[k] != null;
  const add = (key, kind, size, observation, interpretation) => out.push({ key, kind, size, observation, interpretation });
  // braking point (distance from the start/finish line: larger = later)
  if (has('brakePoint')) {
    const d = fast.brakePoint - typ.brakePoint;
    if (d >= D.brakePointM) add('brakePoint', 'braking', d / D.brakePointM, `${F} ${v('start', 'started')} braking ${r0(d)} m later (${r0(fast.brakePoint)} m against ${r0(typ.brakePoint)} m).`,
      'You may be braking earlier than you need to here.');
    else if (-d >= D.brakePointM) add('brakePoint', 'braking', -d / D.brakePointM, `${F} ${v('start', 'started')} braking ${r0(-d)} m earlier (${r0(fast.brakePoint)} m against ${r0(typ.brakePoint)} m).`,
      'An earlier, calmer stop may help you carry more speed through the apex.');
  }
  // brake release: where the brake comes off, how long the release takes, re-applications
  if (has('brakeRelease')) {
    const d = fast.brakeRelease - typ.brakeRelease;
    if (Math.abs(d) >= D.releasePointM) add('brakeRelease', 'release', Math.abs(d) / D.releasePointM,
      `${F} ${v('are', 'was')} off the brake ${r0(Math.abs(d))} m ${d > 0 ? 'later' : 'earlier'} (${r0(fast.brakeRelease)} m against ${r0(typ.brakeRelease)} m).`,
      d > 0 ? 'Releasing the brake later, into the turn, may help the car rotate.' : 'Releasing the brake sooner may let the car roll more speed to the apex.');
  }
  if (has('releaseMs')) {
    const d = fast.releaseMs - typ.releaseMs;
    if (Math.abs(d) >= Math.max(D.releaseMs, D.releaseRel * Math.min(fast.releaseMs, typ.releaseMs))) add('releaseMs', 'release', Math.abs(d) / D.releaseMs,
      `${F} ${v('take', 'took')} ${s2(fast.releaseMs)} to release the brake, ${who.typ} ${s2(typ.releaseMs)}.`,
      d > 0 ? 'A longer, smoother release may suit this corner.' : 'A quicker release may suit this corner.');
  }
  if (has('releaseBumps') && typ.releaseBumps >= 1 && fast.releaseBumps === 0) add('releaseBumps', 'release', typ.releaseBumps,
    `${who.Typ} ${v('presses', 'pressed')} the brake again while releasing it (${typ.releaseBumps === 1 ? 'once' : `${typ.releaseBumps} times`}); ${F.toLowerCase()} ${v('release', 'released')} it in one go.`,
    'A single smooth release may keep the car more settled.');
  // slowest point
  if (has('minSpeed')) {
    const d = fast.minSpeed - typ.minSpeed;
    if (d >= D.minSpeedKmh) add('minSpeed', 'apex', d / D.minSpeedKmh, `${F} ${v('carry', 'carried')} ${r1(d)} km/h more at the slowest point (${r1(fast.minSpeed)} against ${r1(typ.minSpeed)} km/h).`,
      `More speed to the apex may be available: look at how ${F.toLowerCase()} ${v('enter', 'entered')}.`);
  }
  // throttle: where it comes on, how long to full, hesitation on the way
  if (has('throttlePickup')) {
    const d = typ.throttlePickup - fast.throttlePickup;
    if (d >= D.pickupM) add('throttlePickup', 'throttle', d / D.pickupM, `${F} ${v('are', 'was')} back on the throttle ${r0(d)} m sooner (${r0(fast.throttlePickup)} m against ${r0(typ.throttlePickup)} m).`,
      'You may be waiting longer than needed before accelerating.');
  }
  if (has('pickupMs')) {
    const d = typ.pickupMs - fast.pickupMs;
    if (d >= Math.max(D.pickupMs, D.pickupRel * fast.pickupMs)) add('pickupMs', 'throttle', d / D.pickupMs,
      `From the slowest point to full throttle: ${F.toLowerCase()} ${s2(fast.pickupMs)}, ${who.typ} ${s2(typ.pickupMs)}.`,
      'Accelerating fully sooner may be possible here.');
  }
  if (has('holdMs')) {
    const d = typ.holdMs - fast.holdMs;
    if (d >= D.holdMs) add('holdMs', 'throttle', d / D.holdMs, `${who.Typ} ${v('holds', 'held')} the throttle part-way for ${s2(typ.holdMs)} on the exit; ${F.toLowerCase()} ${s2(fast.holdMs)}.`,
      'Hesitating on the throttle may cost exit speed: a steadier push may help.');
  }
  if (has('exitSpeed')) {
    const d = fast.exitSpeed - typ.exitSpeed;
    if (d >= D.exitSpeedKmh) add('exitSpeed', 'exit', d / D.exitSpeedKmh, `${F} ${v('leave', 'left')} the corner ${r1(d)} km/h quicker (${r1(fast.exitSpeed)} against ${r1(typ.exitSpeed)} km/h).`,
      'The exit carries on down the next straight: a better exit may be worth more than it looks.');
  }
  if (gear && gear.fast != null && gear.typ != null && gear.fast !== gear.typ) add('minGear', 'gear', 1,
    `${F} ${v('are mostly', 'was')} in ${ord(gear.fast)} gear at the slowest point; ${who.typ} ${v('is', 'was')} in ${ord(gear.typ)}.`,
    `The other gear may suit this corner better, or ${F.toLowerCase()} ${v('were', 'was')} simply quicker for other reasons.`);
  return out.sort((a, b) => b.size - a.size);
}

// medians of the metrics of a group of passes of corner k (pedal metrics only from laps that hold the pedal channel)
const BRAKE = ['brakePoint', 'brakeRelease', 'releaseMs', 'releaseBumps', 'trailM'];
const THROTTLE = ['throttlePickup', 'pickupMs', 'holdMs', 'reLifts'];
const OTHER = ['minSpeed', 'exitSpeed', 'coastM', 'timeMs', 'entryMs', 'apexMs', 'exitMs'];
// counts (re-applications, re-lifts) are whole numbers: the median of a count is rounded down, so 1 means at least
// half of the passes did it once or more (review fix 5: no '1.5×')
const COUNTS = new Set(['releaseBumps', 'reLifts']);
function medians(group, k) {
  const o = {};
  const med = (key, list) => { const v = median(list.map((l) => l.c[k]?.[key])); return v != null && COUNTS.has(key) ? Math.floor(v) : v; };
  for (const key of OTHER) o[key] = med(key, group);
  for (const key of BRAKE) o[key] = med(key, group.filter((l) => l.has?.brake !== false));
  for (const key of THROTTLE) o[key] = med(key, group.filter((l) => l.has?.throttle !== false));
  return o;
}

/** Laps whose gears say something about the driver's choice: a gear channel, and the automatic gearbox not on (review fix 2). */
const gearLap = (l) => l.has?.gear !== false && l.gearbox !== 'auto';
/**
 * The gear most passes of a group used at the slowest point, only when it is clear: at least RULES.gearGroupMin passes
 * in it and no other gear with as many (review fix 1). null otherwise.
 */
export function clearGear(passes, k) {
  const m = mode(passes.filter((l) => gearLap(l) && l.c[k]?.minGear > 0).map((l) => l.c[k].minGear));
  if (!m) return null;
  const n = m.counts.get(m.mode);
  if (n < RULES.gearGroupMin || [...m.counts.values()].filter((x) => x === n).length > 1) return null;
  return m.mode;
}

/** Gear at the slowest point, per gear: passes and median corner time (laps with a gear channel and no automatic gearbox). */
function gearsOf(passes, k) {
  const withGear = passes.filter((l) => gearLap(l) && l.c[k]?.minGear > 0);
  const auto = passes.filter((l) => l.gearbox === 'auto').length;
  if (!withGear.length) return { available: false, auto, reason: auto ? 'Driven with the automatic gearbox (or no gear recorded): no gear comparison.' : 'No gear was recorded for these laps.' };
  const m = mode(withGear.map((l) => l.c[k].minGear));
  const groups = [...m.counts.entries()].sort((a, b) => a[0] - b[0]).map(([g, n]) => {
    const t = withGear.filter((l) => l.c[k].minGear === g).map((l) => l.c[k].timeMs);
    return { gear: g, passes: n, medianMs: n >= RULES.gearGroupMin ? r0(median(t)) : null };
  });
  const compared = groups.filter((g) => g.medianMs != null);
  let comparison = null;
  if (compared.length >= 2) {
    const [a, b] = [...compared].sort((x, y) => x.medianMs - y.medianMs);
    comparison = { faster: a.gear, slower: b.gear, diffMs: b.medianMs - a.medianMs,
      observation: `Passes in ${ord(a.gear)} gear: median ${s2(a.medianMs)} (${a.passes} passes); in ${ord(b.gear)}: ${s2(b.medianMs)} (${b.passes} passes).`,
      interpretation: `${ord(a.gear)} gear went with the quicker passes here. That is an association: the passes in that gear may have been quicker for other reasons.` };
  }
  return { available: true, mode: m.mode, groups, comparison, auto, unknownGearbox: withGear.filter((l) => l.gearbox !== 'manual').length };
}

/**
 * The analysis of a set of laps of one track + car.
 * input: { corners: [{n, name, apex, start, end}], laps: [{id, sessionId, recordedAt, lapMs, has: {gear, brake, throttle},
 *          c: [per-corner pass]}], trend: [{id, sessionId, recordedAt, lapMs, dts}], pb: {lap, prev, compat} | null,
 *          idealMs, excluded: [{id, reason}] }
 */
export function analyse({ corners, laps: input, trend = [], pb = null, idealMs = null, excluded = [] }) {
  // the same answer whatever order the laps come in: oldest first, then by id
  const laps = [...input].sort((a, b) => a.recordedAt - b.recordedAt || a.id - b.id);
  const rows = corners.map((c, k) => cornerRow(c, k, laps));
  const ranked = rows.filter((r) => r.sufficient && r.gain.realisticMs >= RULES.minGainMs)
    .sort((a, b) => b.gain.realisticMs - a.gain.realisticMs || b.gain.idealMs - a.gain.idealMs || a.n - b.n);
  ranked.forEach((r, i) => { r.rank = i + 1; });
  const short = rows.filter((r) => !r.sufficient).map((r) => r.name);
  return {
    rules: RULES, causation: CAUSATION_NOTE,
    sample: { laps: laps.length, excluded, sessions: new Set(laps.map((l) => l.sessionId)).size,
      from: laps.length ? Math.min(...laps.map((l) => l.recordedAt)) : null, to: laps.length ? Math.max(...laps.map((l) => l.recordedAt)) : null },
    corners: rows,
    opportunities: ranked.map((r) => r.name),
    top: ranked.slice(0, RULES.top).map((r) => topCard(r)),
    notEnough: short,
    target: targetLap(rows, laps, idealMs),
    trends: trends(corners, trend),
    pb: pb ? pbExplain(corners, pb) : null,
  };
}

function cornerRow(c, k, laps) {
  const passes = laps.filter((l) => Number.isFinite(l.c[k]?.timeMs));
  const n = passes.length;
  const dist = summary(passes.map((l) => l.c[k].timeMs));
  const row = { n: c.n, name: c.name, apex: c.apex, start: c.start, end: c.end, passes: n, confidence: confidenceOf(n), sufficient: n >= RULES.minPasses };
  if (!dist) return { ...row, dist: null, gain: null, reason: 'Not driven in these laps.' };
  row.dist = { minMs: r0(dist.min), q1Ms: r0(dist.q1), medianMs: r0(dist.median), q3Ms: r0(dist.q3), maxMs: r0(dist.max), sdMs: r0(dist.sd), ciMs: r0(dist.ci) };
  // the passes in time order, for the distribution chart (lap id, time)
  row.values = passes.map((l) => ({ lapId: l.id, ms: r0(l.c[k].timeMs) }));
  const qr = quantileRange(sorted(passes.map((l) => l.c[k].timeMs)), RULES.fastQuantile);
  row.q1HalfMs = qr ? (qr.hi - qr.lo) / 2 : null;
  if (!row.sufficient) return { ...row, gain: null, reason: `Needs ${RULES.minPasses} valid passes (${n} so far).` };
  const cut = quantile(sorted(passes.map((l) => l.c[k].timeMs)), RULES.fastQuantile);
  const fast = passes.filter((l) => l.c[k].timeMs <= cut);
  const T = medians(passes, k), F = medians(fast, k);
  row.gain = { realisticMs: r0(dist.median - dist.q1), idealMs: r0(dist.median - dist.min) };
  row.fastPasses = fast.length;
  row.phases = Object.fromEntries(PHASES.map(([key, name]) => [name, r0(T[key] - F[key])]));
  const main = PHASES.map(([, name]) => name).sort((a, b) => row.phases[b] - row.phases[a])[0];
  row.mainPhase = row.phases[main] >= RULES.diff.phaseMs ? main : null;
  row.typical = T; row.fast = F;
  row.gears = gearsOf(passes, k);
  const gTyp = clearGear(passes, k), gFast = clearGear(fast, k);
  row.findings = differences(T, F, { gear: gTyp != null && gFast != null ? { typ: gTyp, fast: gFast } : null });
  // the laps to open: a typical pass (the median one, the slower of two middles) and a representative fast pass
  const byTime = [...passes].sort((a, b) => a.c[k].timeMs - b.c[k].timeMs);
  const typLap = byTime[n >> 1], fastLap = [...fast].sort((a, b) => Math.abs(a.c[k].timeMs - dist.q1) - Math.abs(b.c[k].timeMs - dist.q1))[0];
  row.links = { typicalLapId: typLap.id, fastLapId: fastLap.id, fastestLapId: byTime[0].id };
  return row;
}

const phaseText = (r) => (r.mainPhase ? `most of it ${r.mainPhase === 'entry' ? 'on the way in (braking and turn-in)' : r.mainPhase === 'apex' ? 'around the apex' : 'on the way out (exit and acceleration)'}` : 'spread over the whole corner');
/** One of the top opportunities: enough to understand it without opening a chart. */
function topCard(r) {
  return {
    rank: r.rank, name: r.name, n: r.n, passes: r.passes, confidence: r.confidence, gain: r.gain, phases: r.phases, mainPhase: r.mainPhase,
    headline: `${r.name}: about ${s2(r.gain.realisticMs)} a lap to gain, ${phaseText(r)}.`,
    observation: `Your typical pass takes ${s2(r.dist.medianMs)}; the quicker quarter of your passes ${s2(r.dist.q1Ms)} or less (${r.fastPasses} of ${r.passes} passes), your fastest ${s2(r.dist.minMs)}.`,
    findings: r.findings.slice(0, 3),
    caveats: caveatsOf(r, r.findings.slice(0, 3)),
    links: r.links,
  };
}

export const BRAKE_NOTE = 'The brake reading is the pedal position, not the brake pressure.';
/** What the reader of a card must know about the channels its findings rest on (review fix 2). */
function caveatsOf(r, findings) {
  const out = [];
  if (findings.some((f) => f.kind === 'braking' || f.kind === 'release')) out.push(BRAKE_NOTE);
  if (findings.some((f) => f.kind === 'gear')) {
    const unk = r.gears?.unknownGearbox || 0;
    out.push(`Gears from laps with the manual gearbox only${r.gears?.auto ? ` (${r.gears.auto} pass${r.gears.auto === 1 ? '' : 'es'} with the automatic gearbox left out)` : ''}${unk ? `; for ${unk} pass${unk === 1 ? '' : 'es'} the gearbox setting was not recorded (no Paddock HUD reading), so they may include automatic shifts` : ''}.`);
  }
  return out;
}

/** Target lap: the sum of the time every corner is driven in at least 1 pass in 4 (q1), next to the ideal. */
function targetLap(rows, laps, idealMs) {
  const missing = rows.filter((r) => !r.sufficient).map((r) => r.name);
  const best = laps.length ? Math.min(...laps.map((l) => l.lapMs)) : null;
  const typical = laps.length ? median(laps.map((l) => l.lapMs)) : null;
  const base = { bestMs: best, typicalMs: r0(typical), idealMs, laps: laps.length };
  if (!rows.length || missing.length) return { ...base, targetMs: null, reason: missing.length ? `Needs ${RULES.minPasses} valid passes of every corner (short: ${missing.slice(0, 6).join(', ')}${missing.length > 6 ? ', …' : ''}).` : 'No corners.' };
  const sum = (key) => rows.reduce((a, r) => a + r.dist[key], 0);
  // a rough range: each corner's first quartile has a distribution-free ~95 % interval (quantileRange); the half-widths
  // are added as independent errors (review fix 6: the same statistic as the target, not the median's interval)
  return { ...base, targetMs: r0(sum('q1Ms')), sampleIdealMs: r0(sum('minMs')), medianSumMs: r0(sum('medianMs')),
    uncertaintyMs: r0(Math.sqrt(rows.reduce((a, r) => a + r.q1HalfMs ** 2, 0))) };
}

/** Per session (with enough valid laps): median lap and median corner times; first against last session. */
function trends(corners, list) {
  const bySession = new Map();
  for (const l of [...list].sort((a, b) => a.recordedAt - b.recordedAt)) {
    const k = l.sessionId ?? `lap${l.id}`;
    if (!bySession.has(k)) bySession.set(k, []);
    bySession.get(k).push(l);
  }
  const sessions = [...bySession.entries()].filter(([, ls]) => ls.length >= RULES.trendPassesMin).slice(-RULES.trendSessionsMax)
    .map(([id, ls]) => ({ sessionId: typeof id === 'number' ? id : null, at: ls[0].recordedAt, laps: ls }));
  const base = { sessions: sessions.map((s) => ({ sessionId: s.sessionId, at: s.at, laps: s.laps.length, medianMs: r0(median(s.laps.map((l) => l.lapMs))), bestMs: Math.min(...s.laps.map((l) => l.lapMs)) })) };
  if (sessions.length < RULES.trendSessionsMin) return { ...base, sufficient: false, reason: `Needs ${RULES.trendSessionsMin} sessions with ${RULES.trendPassesMin} or more valid laps (${sessions.length} so far).`, corners: [], lap: null };
  const verdict = (vals, minMs) => {
    const first = summary(vals[0]), last = summary(vals[vals.length - 1]);
    const meds = vals.map((v) => median(v));
    // a session without a pass of this corner (e.g. a lap measured on another grid): no verdict
    if (!first || !last) return { firstMs: null, lastMs: null, changeMs: null, slopeMs: null, verdict: 'no clear change', points: meds.map(r0) };
    const xs = meds.map((_, i) => i).filter((i) => meds[i] != null);
    const slope = theilSen(xs, xs.map((i) => meds[i]));
    const change = last.median - first.median;
    return { firstMs: r0(first.median), lastMs: r0(last.median), changeMs: r0(change), slopeMs: r0(slope),
      verdict: !apart(first, last) || Math.abs(change) < minMs ? 'no clear change' : change < 0 ? 'faster' : 'slower', points: meds.map(r0) };
  };
  return { ...base, sufficient: true,
    lap: verdict(sessions.map((s) => s.laps.map((l) => l.lapMs)), RULES.trendMinMs.lap),
    corners: corners.map((c, k) => ({ name: c.name, ...verdict(sessions.map((s) => s.laps.map((l) => l.dts?.[k]).filter(Number.isFinite)), RULES.trendMinMs.corner) })) };
}

const PB_WHO = { fast: 'Your best lap', typ: 'your previous best', Typ: 'Your previous best', plural: false };
/** What made the personal best faster than the previous best: corner by corner, one lap against one lap. */
function pbExplain(corners, { lap, prev, compat }) {
  const base = { lapId: lap.id, at: lap.recordedAt, lapMs: lap.lapMs, compat };
  if (!prev) return { ...base, prev: null, reason: 'This is your first valid lap here: there is no earlier best to compare with.' };
  const rows = corners.map((c, k) => {
    const a = lap.c[k], b = prev.c[k];
    if (!a || !b) return null;
    const phases = Object.fromEntries(PHASES.map(([key, name]) => [name, r0(a[key] - b[key])]));
    return { name: c.name, deltaMs: r0(a.timeMs - b.timeMs), phases, findings: [], a, b };
  }).filter(Boolean);
  const gains = rows.filter((r) => r.deltaMs <= -RULES.diff.phaseMs).sort((x, y) => x.deltaMs - y.deltaMs);
  const losses = rows.filter((r) => r.deltaMs >= RULES.diff.phaseMs).sort((x, y) => y.deltaMs - x.deltaMs);
  for (const r of gains.slice(0, 3)) {
    // the PB pass plays the "faster" side: what it did differently from the previous best's pass
    const pick = (m, has) => Object.fromEntries([...OTHER, ...(has?.brake === false ? [] : BRAKE), ...(has?.throttle === false ? [] : THROTTLE)].map((key) => [key, m[key] ?? null]));
    const gear = gearLap(lap) && gearLap(prev) && r.a.minGear > 0 && r.b.minGear > 0 ? { fast: r.a.minGear, typ: r.b.minGear } : null;
    r.findings = differences(pick(r.b, prev.has), pick(r.a, lap.has), { gear, who: PB_WHO }).slice(0, 3);
  }
  const clean = (r) => ({ name: r.name, deltaMs: r.deltaMs, phases: r.phases, findings: r.findings });
  return { ...base, prev: { lapId: prev.id, at: prev.recordedAt, lapMs: prev.lapMs }, deltaMs: lap.lapMs - prev.lapMs,
    gains: gains.map(clean), losses: losses.map(clean),
    note: 'One lap against one lap: a single pass can be luck. These are the differences between the two laps, not proven causes.' };
}
