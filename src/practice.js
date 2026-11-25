// Structured practice (PL7): practice drills made from the lap analysis's corner findings (src/opportunities.js),
// with a measurable success criterion, judged on the passes driven after the drill started. Deterministic, no AI.
//
// Pure: it gets the numbers src/drills.js and src/service.js measured and returns numbers and sentences. Rules,
// thresholds and limits: docs/platform/PRACTICE.md (keep them in step).
//
// A drill is one corner and one behaviour (a PL6 finding: braking point, brake release, apex speed, throttle, gear),
// "one focus". Its prescription holds the observed issue, the evidence, one exercise, a success criterion, the minimum
// evidence and a review point. Completion measures the behaviour (the metric of each pass), never time spent or laps
// driven: a drill is met when at least half of its newest passes reach the target, and only with enough passes.
import { RULES } from './opportunities.js';
import { summary, median, apart } from './stats.js';

export const PRACTICE = {
  minPasses: RULES.minPasses, // passes since the drill started before it can be judged (the analysis's own minimum)
  window: 10,                 // newest passes judged (a rolling window: old attempts do not hold a drill back for ever)
  share: 0.5,                 // met: at least this share of the judged passes reach the target
  reviewPasses: 10,           // review point: passes since the start (or the last "keep practising") without meeting it
  slipShare: 0.25,            // revisit: fewer than this share of the newest passes after a met drill still reach it
  slipLaps: 30,               // newest laps after a met drill looked at for slipping
};

// What each finding measures (src/opportunities.js differences(): the same keys). tol: how close to the target a pass
// must come, half of the smallest difference the analysis names (RULES.diff), so a drill is never met by noise and
// always needs at least half of the observed gap. channel: the reading a pass needs (laps without it do not count).
const D = RULES.diff;
export const METRICS = {
  brakePoint: { label: 'braking point', unit: 'm', dp: 0, channel: 'brake', tol: D.brakePointM / 2, position: true },
  brakeRelease: { label: 'point where the brake is fully off', unit: 'm', dp: 0, channel: 'brake', tol: D.releasePointM / 2, position: true },
  releaseMs: { label: 'brake release time', unit: 'ms', dp: 0, channel: 'brake', tol: D.releaseMs / 2 },
  releaseBumps: { label: 'brake re-applications while releasing', unit: 'count', dp: 0, channel: 'brake', tol: 0, target: 0, better: 'lower' },
  minSpeed: { label: 'speed at the slowest point', unit: 'km/h', dp: 1, channel: null, tol: D.minSpeedKmh / 2, better: 'higher' },
  throttlePickup: { label: 'point where the throttle goes back on', unit: 'm', dp: 0, channel: 'throttle', tol: D.pickupM / 2, better: 'lower', position: true },
  pickupMs: { label: 'time from the slowest point to full throttle', unit: 'ms', dp: 0, channel: 'throttle', tol: D.pickupMs / 2, better: 'lower' },
  holdMs: { label: 'part-throttle time on the exit', unit: 'ms', dp: 0, channel: 'throttle', tol: D.holdMs / 2, better: 'lower' },
  exitSpeed: { label: 'exit speed', unit: 'km/h', dp: 1, channel: null, tol: D.exitSpeedKmh / 2, better: 'higher' },
  minGear: { label: 'gear at the slowest point', unit: 'gear', dp: 0, channel: 'gear', tol: 0 },
};
export const DRILLABLE = new Set(Object.keys(METRICS));

const ord = (g) => (g === 1 ? '1st' : g === 2 ? '2nd' : g === 3 ? '3rd' : `${g}th`);
const round = (v, dp) => (v == null ? null : Math.round(v * 10 ** dp) / 10 ** dp);
/** A metric value in words: "412 m", "0.35 s", "84.5 km/h", "2nd gear", "1". */
export function fmtValue(key, v, { precise = false } = {}) {
  const m = METRICS[key];
  if (v == null || !m) return '–';
  if (m.unit === 'ms') return `${(v / 1000).toFixed(precise && v % 10 ? 3 : 2)} s`;
  if (m.unit === 'gear') return `${ord(v)} gear`;
  if (m.unit === 'count') return `${Math.round(v)}`;
  return `${round(v, precise ? m.dp + 1 : m.dp)} ${m.unit}`;
}
/** A difference in words, without its sign: "12 m", "0.20 s", "3.5 km/h". */
const fmtGap = (key, v) => (METRICS[key].unit === 'ms' ? `${(Math.abs(v) / 1000).toFixed(2)} s` : `${round(Math.abs(v), METRICS[key].dp)} ${METRICS[key].unit}`);

/** Does one pass reach the drill's target? criterion: {key, better, target, tol}. */
export function meets(c, v) {
  if (v == null || !Number.isFinite(v)) return false;
  if (c.key === 'minGear') return v === c.target;
  return c.better === 'higher' ? v >= c.target - c.tol : v <= c.target + c.tol;
}
/** The value a pass must reach: the target less the tolerance, on the drill's side. */
export const threshold = (c) => (c.key === 'minGear' ? c.target : c.better === 'higher' ? c.target - c.tol : c.target + c.tol);

function criterionText(c, corner) {
  const m = METRICS[c.key], t = threshold(c);
  let what;
  if (c.key === 'minGear') what = `are in ${ord(c.target)} gear at the slowest point`;
  else if (c.key === 'releaseBumps') what = 'release the brake without pressing it again';
  else if (m.position) what = `have the ${m.label} at ${fmtValue(c.key, t, { precise: true })} from the line or ${c.better === 'higher' ? 'later' : 'sooner'}`;
  else what = `have a ${m.label} of ${fmtValue(c.key, t, { precise: true })} or ${c.better === 'higher' ? 'more' : 'less'}`;
  return `At least half of your newest ${PRACTICE.window} passes of ${corner} ${what}.`;
}

function exerciseText(key, corner, typ, fast, better) {
  const gap = typ != null && fast != null ? fmtGap(key, fast - typ) : null;
  const only = 'Change only this; drive the rest of the corner as you normally do.';
  switch (key) {
    case 'brakePoint': return better === 'higher'
      ? `In ${corner}, start braking about ${gap} later than you usually do (your quicker passes: ${fmtValue(key, fast)} from the line, your typical pass: ${fmtValue(key, typ)}). Pick a marker beside the track to brake at. ${only}`
      : `In ${corner}, start braking about ${gap} earlier than you usually do (your quicker passes: ${fmtValue(key, fast)} from the line, your typical pass: ${fmtValue(key, typ)}) and finish the stop calmly before turning in. ${only}`;
    case 'brakeRelease': return better === 'higher'
      ? `In ${corner}, stay on the brake about ${gap} longer, easing off into the turn (fully off at about ${fmtValue(key, fast)} from the line, now ${fmtValue(key, typ)}). ${only}`
      : `In ${corner}, be fully off the brake about ${gap} sooner (at about ${fmtValue(key, fast)} from the line, now ${fmtValue(key, typ)}). ${only}`;
    case 'releaseMs': return better === 'higher'
      ? `In ${corner}, release the brake more gradually: about ${fmtValue(key, fast)} from starting to ease off to fully off (now ${fmtValue(key, typ)}). ${only}`
      : `In ${corner}, release the brake more quickly: about ${fmtValue(key, fast)} from starting to ease off to fully off (now ${fmtValue(key, typ)}). ${only}`;
    case 'releaseBumps': return `In ${corner}, release the brake in one smooth movement, without pressing it again on the way out. ${only}`;
    case 'minSpeed': return `In ${corner}, carry about ${gap} more to the slowest point: aim for ${fmtValue(key, fast)} (now ${fmtValue(key, typ)}). ${only}`;
    case 'throttlePickup': return `In ${corner}, get back on the throttle about ${gap} sooner after the slowest point (at about ${fmtValue(key, fast)} from the line, now ${fmtValue(key, typ)}). ${only}`;
    case 'pickupMs': return `In ${corner}, go from the slowest point to full throttle in about ${fmtValue(key, fast)} (now ${fmtValue(key, typ)}): one steady push. ${only}`;
    case 'holdMs': return `In ${corner}, after the slowest point, push the throttle steadily to full instead of holding it part-way (part-way now about ${fmtValue(key, typ)}; your quicker passes ${fmtValue(key, fast)}). ${only}`;
    case 'exitSpeed': return `In ${corner}, leave the corner about ${gap} quicker: aim for ${fmtValue(key, fast)} (now ${fmtValue(key, typ)}). ${only}`;
    case 'minGear': return `In ${corner}, use ${ord(fast)} gear at the slowest point (your quicker passes mostly did; your typical pass is in ${ord(typ)}). ${only}`;
    default: return null;
  }
}

/** A summary of baseline / drill passes: metric median and share reaching the target, corner time spread. */
function sideOf(c, passes) {
  if (!passes.length) return { n: 0, median: null, share: null, meeting: 0, time: null };
  const meeting = passes.filter((p) => meets(c, p.v)).length;
  const t = summary(passes.map((p) => p.timeMs));
  return { n: passes.length, median: round(median(passes.map((p) => p.v)), 3), meeting, share: round(meeting / passes.length, 3),
    time: t ? { n: t.n, medianMs: Math.round(t.median), q1Ms: Math.round(t.q1), ciMs: Math.round(t.ci) } : null };
}

/**
 * A drill's prescription from one corner of the lap analysis and one of its findings.
 * row: an analysis corner row (src/opportunities.js cornerRow: name, n, apex, passes, confidence, gain, mainPhase,
 *      typical, fast, gearChoice, rank, findings); finding: one of row.findings; analysis: the whole result (sample,
 *      windowSize); baseline: [{lapId, v, timeMs}] the corner's passes in the analysed laps (with the channel).
 * Returns {ok: true, drill} or {ok: false, reason}. The drill's numbers all come from these inputs.
 */
export function prescribe({ row, finding, analysis, baseline, game = null }) {
  const key = finding?.key;
  if (!row || !finding || !DRILLABLE.has(key)) return { ok: false, reason: 'This finding cannot be practised as a drill.' };
  if (!row.sufficient || !row.rank) return { ok: false, reason: `${row.name} is not one of your opportunities in the latest analysis.` };
  const m = METRICS[key];
  let typ, fast;
  if (key === 'minGear') { typ = row.gearChoice?.typ ?? null; fast = row.gearChoice?.fast ?? null; }
  else { typ = row.typical?.[key] ?? null; fast = row.fast?.[key] ?? null; }
  if (typ == null || fast == null || typ === fast) return { ok: false, reason: 'The analysis has no clear difference here any more.' };
  const better = m.better || (fast > typ ? 'higher' : 'lower');
  const target = m.target ?? round(fast, m.dp);
  const criterion = { key, better, target, tol: m.tol };
  const base = baseline.filter((p) => Number.isFinite(p.v) && Number.isFinite(p.timeMs));
  if (base.length < PRACTICE.minPasses) return { ok: false, reason: `Needs ${PRACTICE.minPasses} passes of ${row.name} with this reading (${base.length}).` };
  const before = sideOf(criterion, base);
  // a target most passes already reach is no drill (it would be met at once)
  if (before.share >= PRACTICE.share) return { ok: false, reason: `You already do this in ${Math.round(before.share * 100)} % of your passes of ${row.name}.` };
  const s = analysis.sample || {};
  const gainTxt = `${(row.gain.realisticMs / 1000).toFixed(2)} s`;
  return { ok: true, drill: {
    v: 1, corner: { name: row.name, n: row.n, apex: row.apex }, key, label: m.label, channel: m.channel,
    issue: `${row.name}: ${finding.observation}`,
    hypothesis: finding.interpretation,
    evidence: {
      passes: row.passes, confidence: row.confidence, laps: s.laps ?? null, sessions: s.sessions ?? null, from: s.from ?? null, to: s.to ?? null,
      window: analysis.window ?? null, windowSize: analysis.windowSize ?? null, gainMs: row.gain.realisticMs, upToMs: row.gain.idealMs, rank: row.rank,
      mainPhase: row.mainPhase ?? null, typical: typ, fast, fastPasses: row.fastPasses ?? null, game,
      text: `${row.passes} valid passes of ${row.name} in ${s.laps ?? '?'} laps (${s.sessions ?? '?'} session${s.sessions === 1 ? '' : 's'}); confidence ${row.confidence}. Opportunity #${row.rank}: about ${gainTxt} a lap between your typical pass and your quicker quarter. ${m.label[0].toUpperCase()}${m.label.slice(1)}: typical ${fmtValue(key, typ)}, quicker passes ${fmtValue(key, fast)}.`,
    },
    exercise: exerciseText(key, row.name, typ, fast, better),
    criterion: { ...criterion, text: criterionText(criterion, row.name) },
    minEvidence: { passes: PRACTICE.minPasses, text: `${PRACTICE.minPasses} valid passes of ${row.name} since the drill started${m.channel ? ` with the ${m.channel === 'gear' ? 'gear reading (manual gearbox)' : `${m.channel} reading`}` : ''}, on laps that can be compared with the "before" laps (another game version does not count).` },
    review: { passes: PRACTICE.reviewPasses, text: `After ${PRACTICE.reviewPasses} passes without meeting the target, review it: keep practising, renew the target from your latest laps, or stop.` },
    before,
  } };
}

/**
 * Where a drill stands. p: the prescription (goals.extra); passes: the countable passes since the drill started,
 * [{lapId, sessionId, at, v, timeMs}] (any order); since: the start or the last "keep practising" (only passes from
 * then are judged). Returns {state, passes, judged, meeting, share, met, after, change, sessions}.
 * state: 'collecting' (fewer than minPasses) | 'practising' | 'review' (review point reached, not met) | 'met'.
 */
export function evaluate(p, passes, since) {
  const c = p.criterion, W = PRACTICE.window;
  const all = [...passes].sort((a, b) => a.at - b.at || a.lapId - b.lapId);
  const run = all.filter((x) => x.at >= since);
  let met = null;
  for (let i = PRACTICE.minPasses - 1; i < run.length && !met; i++) {
    const win = run.slice(Math.max(0, i + 1 - W), i + 1);
    const k = win.filter((x) => meets(c, x.v)).length;
    if (k / win.length >= PRACTICE.share) met = { at: run[i].at, lapId: run[i].lapId, sessionId: run[i].sessionId ?? null, share: round(k / win.length, 3), n: win.length };
  }
  const judged = met ? run.slice(0, run.findIndex((x) => x.lapId === met.lapId) + 1).slice(-W) : run.slice(-W);
  const after = sideOf(c, judged);
  const state = met ? 'met' : run.length < PRACTICE.minPasses ? 'collecting' : run.length >= PRACTICE.reviewPasses ? 'review' : 'practising';
  return { state, passes: all.length, sinceRestart: run.length, judged: judged.length, needed: PRACTICE.minPasses, meeting: after.meeting, share: after.share,
    met, after, change: change(p, after), sessions: new Set(all.map((x) => x.sessionId ?? `lap${x.lapId}`)).size };
}

/** Before against after: the behaviour (share reaching the target, median) and, as context only, the corner time. */
export function change(p, after) {
  const b = p.before, out = { shareBefore: b.share, shareAfter: after.share, nBefore: b.n, nAfter: after.n, metricBefore: b.median, metricAfter: after.median, time: null };
  if (p.key !== 'minGear' && b.median != null && after.median != null && p.criterion.target !== b.median) {
    out.gapClosed = round(Math.max(-1, Math.min(2, (after.median - b.median) / (p.criterion.target - b.median))), 2);
  }
  if (b.time && after.time && after.n >= PRACTICE.minPasses) {
    const d = after.time.medianMs - b.time.medianMs;
    const sep = apart({ median: b.time.medianMs, ci: b.time.ciMs }, { median: after.time.medianMs, ci: after.time.ciMs });
    out.time = { beforeMs: b.time.medianMs, afterMs: after.time.medianMs, deltaMs: d,
      verdict: !sep || Math.abs(d) < RULES.trendMinMs.corner ? 'no clear change' : d < 0 ? 'faster' : 'slower' };
  }
  return out;
}

/**
 * A met drill, later: is the behaviour slipping? passes: the countable passes after it was met. Slipping when the
 * newest PRACTICE.window passes (at least minPasses) reach the target in fewer than PRACTICE.slipShare of them.
 */
export function slipping(p, passes) {
  const win = [...passes].sort((a, b) => a.at - b.at || a.lapId - b.lapId).slice(-PRACTICE.window);
  if (win.length < PRACTICE.minPasses) return { checked: false, n: win.length };
  const k = win.filter((x) => meets(p.criterion, x.v)).length;
  return { checked: true, n: win.length, share: round(k / win.length, 3), slipping: k / win.length < PRACTICE.slipShare };
}

export const MASTERY = {
  unknown: 'Not enough passes', open: 'Time to find', practising: 'Practising', revisit: 'Revisit', steady: 'Steady',
};
/**
 * Corner mastery of one car + track, from the lap analysis's corner rows and the car + track's drills (evaluated).
 * unknown: fewer than RULES.minPasses passes; practising: an active drill there; revisit: a met drill there is slipping;
 * open: a ranked opportunity (realistic gain of RULES.minGainMs or more); steady: sufficient passes and no such gain.
 * The confidence word of the corner (sample size) goes with it.
 */
export function mastery(rows, drills = []) {
  return rows.map((r) => {
    const here = drills.filter((d) => d.corner === r.name); // d.corner: the name now, found by the apex (src/drills.js)
    const met = here.filter((d) => d.state === 'met').length;
    let level = !r.sufficient ? 'unknown' : r.rank ? 'open' : 'steady';
    if (here.some((d) => d.slip?.slipping)) level = 'revisit';
    if (here.some((d) => d.active)) level = 'practising';
    return { name: r.name, level, label: MASTERY[level], confidence: r.confidence, passes: r.passes, drillsMet: met };
  });
}

/** Progress over every drill (evaluated): counts and the latest results, for the Development page. */
export function progressSummary(drills) {
  const n = (f) => drills.filter(f).length;
  const results = drills.filter((d) => d.state === 'met').slice(0, 10).map((d) => ({ id: d.id, corner: d.corner ?? d.cornerAtStart, combo: d.combo, label: d.label,
    shareBefore: d.eval?.change?.shareBefore ?? null, shareAfter: d.eval?.change?.shareAfter ?? null, nBefore: d.eval?.change?.nBefore ?? d.prescription?.before?.n ?? null, nAfter: d.eval?.change?.nAfter ?? d.eval?.judged ?? null, metAt: d.met?.at ?? null, time: d.eval?.change?.time ?? null }));
  return { active: n((d) => d.active), review: n((d) => d.active && d.state === 'review'), met: n((d) => d.state === 'met'),
    stopped: n((d) => d.state === 'stopped'), revisit: n((d) => d.slip?.slipping), results };
}
