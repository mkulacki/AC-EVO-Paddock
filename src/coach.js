// AI coach (P8) for one track + car: a chat that knows the driver's history there, a training plan of measurable
// targets checked against the following sessions, and AI braking-point suggestions applied only after review.
// The context sent to Gemini is compact (summaries of reports, setups and the plan, never raw telemetry) and can be
// seen in full on the page ("What is sent"). Nothing the AI says is written anywhere without the driver's click.
import * as db from './db.js';
import * as svc from './service.js';
import * as settings from './settings.js';
import * as channels from './channels.js';
import * as ai from './ai.js';
import * as report from './report.js';
import * as setuphistory from './setuphistory.js';
import * as marks from './brakemarks.js';
import { cornerMetrics, TECHNIQUE } from './analysis.js';

export const REPORTS_IN_CONTEXT = 3;   // latest session reports summarised for the coach
export const SESSIONS_IN_CONTEXT = 6;  // latest sessions listed (from the laps)
export const HISTORY_MESSAGES = 12;    // earlier chat messages sent along with a question
export const MAX_QUESTION = 1000;      // characters
export const PLAN_SESSIONS = 10;       // later sessions a plan is checked against (the latest ones)
export const BRAKE_LAPS = 30;          // latest valid laps searched for the fastest pass of each corner
export const TYPICAL_LAPS = 8;         // latest valid laps for the typical braking point
export const MAX_LATER_M = 15;         // a suggested point is never more than this later than the fastest pass's
const PLAN_KINDS = new Set(['lap', 'corner', 'consistency', 'limits']); // targets report.checkTargets can check

const fmt = ai.fmtMs;
const day = (t) => (t ? new Date(t).toISOString().slice(0, 10) : null);
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const same = (a, b) => a && b && a.track === b.track && a.layout === b.layout && a.car === b.car;
export const comboOfParams = (q) => {
  if (!q.track || !q.layout || !q.car) throw Object.assign(new Error('track, layout and car are needed'), { status: 400 });
  return { track: String(q.track), layout: String(q.layout), car: String(q.car) };
};

/** The combo's session reports, newest first. */
function reportsOf(combo) {
  return db.listReports().filter((r) => same(r.data.combo, combo)).map((r) => ({ sessionId: r.sessionId, ...r.data }))
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}

// ---------------------------------------------------------------- context for the chat
/** Everything the coach gets about this track + car (compact JSON). Throws when there are no laps. */
export function context(combo) {
  const laps = db.lapsForCombo(combo.track, combo.layout, combo.car, true).sort((a, b) => b.recorded_at - a.recorded_at);
  if (!laps.length) throw Object.assign(new Error('No laps with this car on this track yet'), { status: 404 });
  const info = svc.comboInfo(combo);
  const idealMs = info.ideal?.timeMs ?? null;
  const score = svc.scoreOf(laps.slice(0, svc.SCORE_LAPS), idealMs);
  const valid = laps.filter((l) => l.valid);

  const bySes = new Map();
  for (const l of laps) { const k = l.session_id ?? `lap${l.id}`; if (!bySes.has(k)) bySes.set(k, []); bySes.get(k).push(l); }
  const sessions = [...bySes.values()].slice(0, SESSIONS_IN_CONTEXT).map((ls) => {
    const v = ls.filter((l) => l.valid).map((l) => l.lap_time_ms);
    return { date: day(Math.min(...ls.map((l) => l.recorded_at))), laps: ls.length, valid: v.length, best: v.length ? fmt(Math.min(...v)) : null };
  });

  const reps = reportsOf(combo);
  const reports = reps.slice(0, REPORTS_IN_CONTEXT).map((r) => {
    const known = (r.prevTargets?.items || []).filter((t) => t.met === true || t.met === false);
    const st = r.style?.sufficient ? r.style : null;
    return {
      date: day(r.startedAt), laps: r.laps?.total, valid: r.laps?.valid, best: fmt(r.best?.ms), clean_avg: fmt(r.average?.cleanMs),
      spread_ms: r.consistency?.sdMs ?? null, new_pb: r.improvement?.newPb || undefined,
      vs_previous_session_ms: r.improvement?.bestDeltaMs ?? undefined, theoretical_best: r.theoretical ? fmt(r.theoretical.ms) : undefined,
      best_corners: r.corners?.best, weakest_corners: (r.corners?.weakest || []).map((w) => ({ corner: w.name, gap_to_fastest_pass_ms: w.gapMs, why: w.reasons })),
      habits: st?.habits?.length ? st.habits.map((h) => `${TECHNIQUE[h.key]?.label || h.key} (${h.corners} corners)`) : undefined,
      style_notes: st ? st.corners.filter((c) => c.notes.length).sort((a, b) => (b.gapMs ?? 0) - (a.gapMs ?? 0)).slice(0, 3)
        .map((c) => ({ corner: c.name, notes: c.notes.map((n) => n.text) })) : undefined,
      invalid_laps_at: r.trackLimits?.byCorner?.length ? r.trackLimits.byCorner.slice(0, 3).map((x) => `${x.name} ×${x.n}`) : undefined,
      previous_targets_met: known.length ? `${known.filter((t) => t.met).length} of ${known.length}` : undefined,
    };
  });
  const latest = reps[0];
  const plan = planStatus(db.activePlan(combo));
  const mc = marks.comboOf(combo);
  return {
    track: `${combo.track} ${combo.layout}`.trim(), car: combo.car,
    totals: { laps: laps.length, valid: valid.length, sessions: bySes.size, first_driven: day(laps[laps.length - 1].recorded_at), last_driven: day(laps[0].recorded_at) },
    best_lap: valid.length ? fmt(Math.min(...valid.map((l) => l.lap_time_ms))) : null,
    ideal_lap: idealMs != null ? fmt(idealMs) : null,
    score_last_laps: score.score != null ? { score: score.score, pace: score.pace, consistency: score.consistency, validity: score.validity } : { none: score.reason },
    recent_sessions: sessions,
    reports: reports.length ? reports : 'no session reports yet (a report needs 3 laps in a session)',
    corners_latest_report: latest?.corners?.all ? latest.corners.all.map((c) => ({ corner: c.name, typical_ms: c.medianMs, fastest_ever_ms: c.bestEverMs, gap_ms: c.gapMs, spread_ms: c.sdMs })) : undefined,
    laps_by_setup: setuphistory.forAi([combo]),
    training_plan: plan ? { since: day(plan.fromStartedAt), targets: plan.targets.map((t) => ({ target: t.text, sessions_checked: t.checked, met: t.met, last: t.last?.actual ?? null })) } : 'none',
    brake_marks: marks.marksFor(mc).length,
    units: 'times m:ss.mmm or ms; distances metres from the start/finish line; speeds km/h',
    data_quality: channels.forAi(['core', 'trackLimits', 'setupProbe', 'conditions']),
  };
}

const COACH_SYSTEM = `You are the driver's personal sim-racing coach for Assetto Corsa EVO, talking about one car on one track.
You get the driver's history there as JSON: lap and session totals, the latest session reports (weakest corners with
reasons, driving-style notes, invalid laps), corner times, laps split by setup, the active training plan with its checks,
and data_quality (which readings are confirmed in game).
Rules:
- Answer the driver's question directly and briefly (under 200 words unless asked for more), in Markdown.
- Base statements on the data and quote the numbers (dates, seconds, metres, km/h). If the data does not cover the
  question, say so plainly instead of guessing.
- Few laps or one session are weak evidence: say so. "Standard" = no saved setup matched; "Not recorded" = no setup known.
- When you suggest practice targets, make them measurable (a lap time, a corner time, a spread, a braking point in metres).
- You cannot change anything in the app: the driver makes training plans (from a session report) and applies brake marks.
${ai.CONFIDENCE}`;

/** What is sent with a question, for the "What is sent" view. */
export function preview(combo) {
  return { instructions: COACH_SYSTEM, data: context(combo), history: `the last ${HISTORY_MESSAGES} messages of this chat`, language: settings.get().language || 'English' };
}

const toMessage = (m) => (m.role === 'coach' ? { id: m.id, role: m.role, at: m.created_at, model: m.model, ...ai.splitConfidence(m.text) }
  : { id: m.id, role: m.role, at: m.created_at, text: m.text });
export const messages = (combo) => db.coachMessages(combo).map(toMessage);
export const clear = (combo) => { db.clearCoachMessages(combo); };

/** Ask the coach. Both messages are saved only when the answer came back (an error leaves the chat as it was). */
export async function ask(combo, question) {
  const q = String(question ?? '').trim().slice(0, MAX_QUESTION);
  if (!q) throw Object.assign(new Error('Type a question first'), { status: 400 });
  if (!settings.get().geminiApiKey) throw Object.assign(new Error(ai.NO_KEY_TEXT), { code: 'nokey' });
  const ctx = context(combo);
  const history = db.coachMessages(combo).slice(-HISTORY_MESSAGES);
  while (history.length && history[0].role !== 'driver') history.shift(); // the conversation starts with the driver
  const contents = [...history.map((m) => ({ role: m.role === 'coach' ? 'model' : 'user', parts: [{ text: m.text }] })), { role: 'user', parts: [{ text: q }] }];
  const system = `${COACH_SYSTEM}\n\nRespond in ${settings.get().language || 'English'}.\n\nDriver data (JSON):\n${JSON.stringify(ctx)}`;
  const out = await ai.generate({ system, contents });
  const at = Date.now();
  db.addCoachMessages(combo, [{ role: 'driver', text: q, at }, { role: 'coach', text: out.text, model: out.model, at: at + 1 }]);
  return { question: q, answer: { role: 'coach', at: at + 1, model: out.model, ...ai.splitConfidence(out.text) } };
}

// ---------------------------------------------------------------- training plan
/** Later sessions of the combo (after the plan's source session), oldest first, the latest PLAN_SESSIONS of them. */
function laterSessions(plan) {
  const ids = new Map();
  for (const l of db.lapsForCombo(plan.combo.track, plan.combo.layout, plan.combo.car, true)) {
    if (l.session_id == null || l.session_id === plan.fromSession) continue;
    const at = ids.get(l.session_id);
    if (at == null || l.recorded_at < at) ids.set(l.session_id, l.recorded_at);
  }
  return [...ids.entries()].filter(([, at]) => at > (plan.fromStartedAt ?? 0)).sort((a, b) => a[1] - b[1]).slice(-PLAN_SESSIONS)
    .map(([sessionId, startedAt]) => ({ sessionId, startedAt }));
}
const reportFor = (sessionId) => {
  const stored = db.getReport(sessionId)?.data;
  if (stored) return stored;
  try { return report.build(sessionId, { withPrevTargets: false }); } catch (e) { return { error: e.message }; }
};

/** A plan with every later session checked: targets[i] = {...target, checked, met, last}, sessions[] per session. */
export function planStatus(plan) {
  if (!plan) return null;
  const sessions = laterSessions(plan).map((s) => {
    const r = reportFor(s.sessionId);
    if (r.error) return { ...s, skipped: r.error };
    return { ...s, items: report.checkTargets(plan.targets, r).map((i) => ({ met: i.met, actual: i.actual })) };
  });
  const checked = sessions.filter((s) => s.items);
  const targets = plan.targets.map((t, k) => {
    const known = checked.map((s) => s.items[k]).filter((i) => i.met === true || i.met === false);
    return { ...t, checked: known.length, met: known.filter((i) => i.met).length, last: checked.length ? checked[checked.length - 1].items[k] : null };
  });
  const last = checked[checked.length - 1];
  return { ...plan, targets, sessions, allMetLast: last ? last.items.every((i) => i.met === true) : null };
}

/** Make a session report's measurable targets the combo's training plan (replaces the active one). */
export function createPlan(sessionId) {
  const stored = db.getReport(sessionId)?.data;
  const r = stored || report.build(sessionId);
  const targets = (r.targets || []).filter((t) => PLAN_KINDS.has(t.kind));
  if (!targets.length) throw Object.assign(new Error('This report has no targets that can be checked'), { status: 400 });
  const id = db.createPlan(r.combo, { fromSession: sessionId, fromStartedAt: r.startedAt ?? db.getSession(sessionId)?.started_at ?? Date.now(), targets });
  return planStatus(db.getPlan(id));
}
/** Drop one target; a plan without targets is closed. */
export function removeTarget(planId, index) {
  const p = db.getPlan(planId);
  if (!p || p.closedAt) throw Object.assign(new Error('No active plan with this id'), { status: 404 });
  if (!(index >= 0 && index < p.targets.length)) throw Object.assign(new Error('No such target'), { status: 400 });
  const targets = p.targets.filter((_, k) => k !== index);
  if (!targets.length) { db.closePlan(planId); return null; }
  db.setPlanTargets(planId, targets);
  return planStatus(db.getPlan(planId));
}
export const closePlan = (planId) => { db.closePlan(planId); };
export const activePlan = (combo) => planStatus(db.activePlan(combo));

/** The active plan as seen from one session: made from it, checked by it, or older than the plan. */
export function planForSession(sessionId, combo) {
  const plan = activePlan(combo);
  if (!plan) return null;
  if (plan.fromSession === sessionId) return { plan, role: 'source' };
  const s = plan.sessions.find((x) => x.sessionId === sessionId);
  return s ? { plan, role: 'checked', check: s } : { plan, role: 'other' };
}

// ---------------------------------------------------------------- braking points
/** Where each corner's mark may go (metres on the best lap): from the previous corner's apex to this apex. */
function zones(combo) {
  const info = svc.comboInfo(combo);
  if (!info.best) throw Object.assign(new Error('No valid lap with this car on this track yet'), { status: 404 });
  const ref = svc.getResampled(info.best.id).R;
  return { info, ref, L: ref.L, list: info.corners.map((c, k) => ({ c, name: c.name, from: k ? Math.round(ref.d[info.corners[k - 1].apexIdx]) : 0, apex: Math.round(ref.d[c.apexIdx]) })) };
}
const inZone = (z, m) => m >= z.from && m <= z.apex;

/** What the braking-point AI gets: per corner the fastest recent pass, the typical one and the current mark. */
export function brakeData(combo) {
  const { ref, L, list } = zones(combo);
  const valid = db.lapsForCombo(combo.track, combo.layout, combo.car, true).filter((l) => l.valid)
    .sort((a, b) => b.recorded_at - a.recorded_at).slice(0, BRAKE_LAPS)
    .map((l) => ({ l, R: svc.getResampled(l.id)?.R })).filter((x) => x.R && x.R.n === ref.n);
  const mine = marks.marksFor(marks.comboOf(combo));
  const corners = list.map((z) => {
    const { c } = z;
    let best = null;
    for (const x of valid) { const t = x.R.t[c.b] - x.R.t[c.a]; if (!best || t < best.t) best = { ...x, t }; }
    const bm = best ? cornerMetrics(best.R, c) : null;
    const recent = valid.slice(0, TYPICAL_LAPS).map((x) => ({ m: cornerMetrics(x.R, c), t: x.R.t[c.b] - x.R.t[c.a] }));
    const pts = recent.map((x) => x.m.brakePoint ?? x.m.liftPoint).filter((v) => v != null);
    const mark = mine.find((m) => inZone(z, m.pos * L));
    return {
      corner: z.name, zone_from_m: z.from, apex_m: z.apex,
      fastest_pass: bm ? { brake_m: bm.brakePoint ?? bm.liftPoint, kind: bm.brakePoint != null ? 'brake' : bm.liftPoint != null ? 'lift' : 'flat out',
        entry_kmh: bm.entrySpeed, min_kmh: bm.minSpeed, max_brake_pct: bm.maxBrakePct, corner_ms: Math.round(best.t), lap: best.l.lap_number, date: day(best.l.recorded_at) } : null,
      typical: recent.length ? { brake_m: pts.length ? Math.round(median(pts)) : null, earliest_m: pts.length ? Math.min(...pts) : null, latest_m: pts.length ? Math.max(...pts) : null,
        corner_ms: Math.round(median(recent.map((x) => x.t))), laps: recent.length } : null,
      my_mark_m: mark ? Math.round(mark.pos * L) : null, my_mark_kind: mark?.kind,
    };
  });
  return { track: `${combo.track} ${combo.layout}`.trim(), car: combo.car, lap_length_m: Math.round(L), laps_used: valid.length, corners,
    units: 'metres from the start/finish line; larger brake_m = later braking', data_quality: channels.forAi(['core']) };
}

const BRAKE_SYSTEM = `You are a sim-racing driving coach suggesting braking points ("brake marks") for Assetto Corsa EVO.
The driver's audio spotter counts down to these marks. You get, per corner: the zone where its mark may go
(zone_from_m .. apex_m), fastest_pass = the driver's fastest pass through that corner among recent valid laps
(braking point, entry and minimum speed, time), typical = their latest laps (median braking point and its range),
and my_mark_m = their current mark (null = none).
Rules:
- Suggest a point only where it should help: usually at the fastest pass's braking point, or slightly later when the
  typical laps brake clearly earlier than the fastest pass. Never more than ${MAX_LATER_M} m later than the fastest pass, never
  outside the zone. Prefer points the driver has already shown they can make.
- Leave a corner out when the current mark is already right, the corner is flat out, or the data is too thin.
- kind: "brake", or "lift" for a lift of the throttle without braking.
- Each suggestion: reason (one sentence quoting the numbers) and confidence (high|medium|low).
- Rate the overall confidence honestly: few laps or a large spread = low.
Answer with JSON only:
{"summary": "markdown, 2-4 sentences", "suggestions": [{"corner": "...", "brake_m": number, "kind": "brake|lift", "reason": "...", "confidence": "high|medium|low"}],
 "confidence": "high|medium|low", "basis": "one sentence: what the suggestions rest on, and what is uncertain"}`;

/** Check the model's suggestions against the zones and the fastest passes: -> {suggestions, rejected}. */
export function validateSuggestions(data, raw) {
  const out = [], rejected = [];
  for (const s of Array.isArray(raw) ? raw : []) {
    const c = data.corners.find((x) => x.corner === s?.corner);
    const m = Math.round(Number(s?.brake_m));
    const why = !c ? 'unknown corner' : !Number.isFinite(m) ? 'no distance'
      : m < c.zone_from_m || m > c.apex_m ? `outside the corner's zone (${c.zone_from_m}–${c.apex_m} m)`
        : c.fastest_pass?.brake_m != null && m > c.fastest_pass.brake_m + MAX_LATER_M ? `more than ${MAX_LATER_M} m later than your fastest pass (${c.fastest_pass.brake_m} m)`
          : out.some((x) => x.corner === c.corner) ? 'a second point for the same corner' : null;
    if (why) { rejected.push({ corner: String(s?.corner ?? '?'), brakeM: Number.isFinite(m) ? m : null, why }); continue; }
    out.push({ corner: c.corner, m, pos: m / (data.lap_length_m || 1), kind: s.kind === 'lift' ? 'lift' : 'brake',
      reason: String(s.reason || '').slice(0, 400), confidence: ai.levelOf(s.confidence),
      fastestM: c.fastest_pass?.brake_m ?? null, typicalM: c.typical?.brake_m ?? null, currentM: c.my_mark_m, currentKind: c.my_mark_kind ?? null });
  }
  return { suggestions: out, rejected };
}

/** Ask Gemini for braking points. Nothing is saved: the driver picks which to apply. */
export async function suggestBrakes(combo) {
  if (!settings.get().geminiApiKey) throw Object.assign(new Error(ai.NO_KEY_TEXT), { code: 'nokey' });
  const data = brakeData(combo);
  if (!data.laps_used) throw Object.assign(new Error('No valid lap with this car on this track yet'), { status: 404 });
  const { text, model } = await ai.generate({ system: BRAKE_SYSTEM, json: true, temperature: 0.2,
    contents: [{ role: 'user', parts: [{ text: `Respond in ${settings.get().language || 'English'} (JSON keys stay in English).\n\n${JSON.stringify(data)}` }] }] });
  const out = ai.parseJson(text);
  const { suggestions, rejected } = validateSuggestions(data, out.suggestions);
  return { model, at: Date.now(), summary: String(out.summary || ''), suggestions, rejected, lapsUsed: data.laps_used,
    confidence: ai.levelOf(out.confidence) ? { level: ai.levelOf(out.confidence), basis: String(out.basis || '').slice(0, 400) } : null };
}

/**
 * Apply the points the driver ticked: each replaces the marks inside its corner's zone; other marks stay.
 * items = [{corner, m, kind}] -> {combo (brake-mark key), marks (the new list to save)}
 */
export function applyBrakes(combo, items) {
  if (!Array.isArray(items) || !items.length) throw Object.assign(new Error('Pick at least one braking point'), { status: 400 });
  const { L, list } = zones(combo);
  const mc = marks.comboOf(combo);
  let next = marks.marksFor(mc).map((m) => ({ pos: m.pos, kind: m.kind }));
  for (const it of items) {
    const z = list.find((x) => x.name === it?.corner);
    const m = Number(it?.m);
    if (!z) throw Object.assign(new Error(`Unknown corner ${it?.corner}`), { status: 400 });
    if (!Number.isFinite(m) || !inZone(z, m)) throw Object.assign(new Error(`${z.name}: ${m} m is outside the corner's zone (${z.from}–${z.apex} m)`), { status: 400 });
    next = next.filter((x) => !inZone(z, x.pos * L));
    next.push({ pos: m / L, kind: it.kind === 'lift' ? 'lift' : 'brake' });
  }
  return { combo: mc, marks: next };
}
