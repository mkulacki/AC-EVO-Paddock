// Practice drills (PL7): the driver turns one finding of the lap analysis (src/opportunities.js) into a drill, Paddock
// checks it on the passes driven afterwards. Built on the P9 goals: a drill is a goals row of kind 'drill' (its
// prescription in goals.extra, met_* the first time it is met), with its later history in drill_events (src/db.js v3).
// Deterministic and local: no AI is involved anywhere in the loop, so it works with AI switched off.
//
// One focus: one active drill per car + track. A drill is judged on its corner's passes since it started (or since
// the last "keep practising"), from valid own laps that can be compared with the "before" laps (another game version
// does not count), and only laps that hold the reading it needs. Rules: src/practice.js, docs/platform/PRACTICE.md.
import * as db from './db.js';
import * as svc from './service.js';
import * as compat from './compat.js';
import * as practice from './practice.js';

const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const same = (a, b) => a.track === b.track && a.layout === b.layout && a.car === b.car;
const LIST_MAX = 30; // newest drills listed (older ones stay in the database)

let onMet = () => {};
/** The server announces a drill met for the first time (as goals.setOnMet does for goals). */
export function setOnMet(fn) { onMet = fn; }

// one change at a time: two clicks cannot make two active drills
let chain = Promise.resolve();
function serial(fn) { const run = chain.then(fn); chain = run.catch(() => {}); return run; }

const specOf = (p) => ({ corner: p.corner, key: p.key, channel: p.channel });
const brief = (g) => ({ id: g.id, corner: g.extra.corner.name, label: g.extra.label, key: g.extra.key });
const ended = (ev) => ev.find((e) => e.kind === 'stopped' || e.kind === 'replaced');

/**
 * Records a drill as met, once, inside serial() (review fix 4): only if it still exists, is not met yet and was not
 * stopped or replaced meanwhile. -> true when this call recorded it.
 */
function recordMet(id, e) {
  const g = db.getGoal(id);
  if (!g || g.kind !== 'drill' || g.met || ended(db.drillEvents().get(id) || [])) return false;
  if (Number(db.setGoalMet(id, { at: e.met.at, sessionId: e.met.sessionId, lapId: e.met.lapId, value: e.share }).changes) !== 1) return false;
  db.addDrillEvent(id, 'met', e, e.met.at);
  return true;
}

/**
 * Where one drill stands; may store "met" (goals.met_* and a 'met' event) the first time it is reached.
 * corners: the car + track's corners now ([{name, apex}], svc.cornerListAsync): the drill's corner is found by its
 * apex, so `corner` is its name now (null when it is not found) and `cornerAtStart` the name it had (review fix 1).
 * inSerial: called from inside serial() (create / keep / stop), so "met" is recorded directly.
 */
async function evaluateOne(g, events, { superseded = false, corners = null, inSerial = false } = {}) {
  const p = g.extra, ev = events.get(g.id) || [];
  const end = ended(ev);
  const since = Math.max(g.createdAt, ...ev.filter((e) => e.kind === 'restart').map((e) => e.at));
  const list = corners || await svc.cornerListAsync(g.combo);
  const k = svc.matchCorner(list, p.corner);
  const out = { id: g.id, combo: g.combo, corner: k >= 0 ? list[k].name : null, cornerAtStart: p.corner.name, apex: p.corner.apex, key: p.key, label: p.label,
    createdAt: g.createdAt, prescription: p, history: ev.map((e) => ({ kind: e.kind, at: e.at })), met: g.met, active: false, state: null, eval: null, slip: null, reason: null };
  if (g.met) {
    out.state = 'met';
    out.eval = ev.find((e) => e.kind === 'met')?.data ?? null;
    // later: is the behaviour slipping? (not when a newer drill on the same corner and behaviour carries it on)
    if (!superseded) {
      const r = await svc.drillPassesAsync(g.combo, specOf(p), { since: g.met.at + 1, newest: practice.PRACTICE.slipLaps, game: p.evidence.game });
      if (r.found) out.slip = practice.slipping(p, r.passes);
    }
    return out;
  }
  if (end) { out.state = 'stopped'; out.endedAt = end.at; out.endKind = end.kind; out.eval = end.data; return out; }
  out.active = true;
  const r = await svc.drillPassesAsync(g.combo, specOf(p), { since: g.createdAt, game: p.evidence.game });
  if (!r.found) { out.state = 'unavailable'; out.reason = r.reason; return out; }
  const e = practice.evaluate(p, r.passes, since);
  e.excluded = r.excluded.length;
  e.excludedReasons = [...new Set(r.excluded.map((x) => x.reason))];
  // what varies between the "before" laps and the drill's laps (PL4): shown, not hidden
  e.compat = compat.mix(svc.lapProvenance([...(p.baselineIds || []), ...r.passes.map((x) => x.lapId)]));
  out.state = e.state; out.eval = e;
  if (e.state === 'met') {
    // stored once, in turn with Stop / Keep / new drills: two pages working it out at the same moment both see it
    // met, only the first one records it; a drill stopped meanwhile stays stopped
    const first = inSerial ? recordMet(g.id, e) : await serial(() => recordMet(g.id, e));
    const now = db.getGoal(g.id);
    if (!now?.met) return now ? evaluateOne(now, db.drillEvents(), { superseded, corners: list, inSerial }) : out;
    out.active = false;
    out.met = now.met;
    if (first) { try { onMet(out); } catch (err) { console.log(`[drill] ${err.message}`); } }
  }
  return out;
}

/** Every drill (newest LIST_MAX), or one car + track's, evaluated; with the progress summary and revisit suggestions. */
export async function list({ combo = null } = {}) {
  const rows = db.listDrills().filter((g) => !combo || same(g.combo, combo)).slice(0, LIST_MAX);
  const events = db.drillEvents();
  const drills = [];
  const cornersOf = new Map(); // car + track -> its corners now (read once)
  const seen = new Set(); // corner (by its apex) + behaviour per car + track: the newest drill carries it
  for (const g of rows) {
    const ck = `${g.combo.track}|${g.combo.layout}|${g.combo.car}`;
    if (!cornersOf.has(ck)) cornersOf.set(ck, await svc.cornerListAsync(g.combo));
    const corners = cornersOf.get(ck), at = svc.matchCorner(corners, g.extra.corner);
    const k = `${ck}|${at >= 0 ? corners[at].name : `@${g.extra.corner.apex}`}|${g.extra.key}`;
    drills.push(await evaluateOne(g, events, { superseded: seen.has(k), corners }));
    seen.add(k);
  }
  const readyOf = new Map();
  for (const d of drills) { const k = `${d.combo.track}|${d.combo.layout}|${d.combo.car}`; if (!readyOf.has(k)) readyOf.set(k, versionReady(d.combo)); d.versionOk = readyOf.get(k).ok; }
  return { ready: combo ? versionReady(combo) : null, noVersion: NO_VERSION, drills, summary: practice.progressSummary(drills), revisits: drills.filter((d) => d.slip?.slipping).map((d) => ({ id: d.id, combo: d.combo, corner: d.corner ?? d.cornerAtStart, key: d.key, label: d.label, share: d.slip.share, n: d.slip.n })), rules: practice.PRACTICE };
}

/** Why a drill cannot be made or renewed (D-PL7-13): the pages show it next to the disabled control. */
export const NO_VERSION = "This lap has no recorded game version, so a drill can't be checked";
/**
 * Can a drill be made on this car + track now? Only laps of the newest valid lap's recorded game version count
 * (OD-PL-34, D-PL7-9), so without that version none could: {ok, game} or {ok: false, reason}.
 */
export function versionReady(combo) {
  const newest = db.lapsForCombo(combo.track, combo.layout, combo.car, true).filter((l) => l.valid)
    .reduce((x, y) => (!x || y.recorded_at > x.recorded_at || (y.recorded_at === x.recorded_at && y.id > x.id) ? y : x), null);
  let game = null; try { game = JSON.parse(newest?.cond || 'null')?.game ?? null; } catch { /* old row */ }
  return game ? { ok: true, game } : { ok: false, game: null, reason: NO_VERSION };
}

/** Corner mastery of a car + track (the lap analysis's corner rows and its drills); null without valid laps. */
export async function masteryFor(combo, drills) {
  let a;
  try { a = await svc.lapAnalysisAsync(combo); } catch { return null; }
  if (a.disabled) return null;
  return practice.mastery(a.corners, drills.filter((d) => same(d.combo, combo)));
}

function activeOf(combo) {
  const events = db.drillEvents();
  return db.listDrills().find((g) => same(g.combo, combo) && !g.met && !ended(events.get(g.id) || []));
}

function comboOf(b) {
  const c = b?.combo || b || {};
  const str = (v) => (typeof v === 'string' ? v : null);
  const combo = { track: str(c.track), layout: str(c.layout ?? ''), car: str(c.car) };
  if (!combo.track || !combo.car || combo.layout == null) throw fail(400, 'Pick a track and car');
  return combo;
}

/**
 * A new drill from the current lap analysis of a car + track: body {combo | track/layout/car, corner, key, replace}.
 * The numbers are never taken from the request: the corner and finding are looked up in the analysis again. With an
 * active drill on that car + track, 409 (code 'active') unless replace is true (the old one is closed as 'replaced').
 */
export function create(body, now = Date.now()) {
  return serial(async () => {
    const combo = comboOf(body);
    const corner = typeof body.corner === 'string' ? body.corner : '', key = typeof body.key === 'string' ? body.key : '';
    if (!corner || !practice.DRILLABLE.has(key)) throw fail(400, 'Pick a corner and one of its findings');
    let a;
    try { a = await svc.lapAnalysisAsync(combo); } catch (e) { throw fail(404, e.message); }
    if (a.disabled) throw fail(409, a.disabled);
    const row = a.corners.find((c) => c.name === corner);
    const finding = row?.findings?.find((f) => f.key === key);
    if (!row || !finding) throw fail(409, `This difference does not show in your latest laps at ${corner} any more: nothing to practise there now.`);
    const active = activeOf(combo);
    if (active && !body.replace) throw fail(409, `You are practising ${active.extra.corner.name} (${active.extra.label}) on this car and track. One drill at a time: replace it?`, { code: 'active', active: brief(active) });
    // the "before": the corner's passes in the analysed laps, on the newest lap's game version
    const ids = (row.values || []).map((v) => v.lapId);
    // unknown never matches (PL4, OD-PL-34; review fix 3): without the newest lap's game version no lap could count
    const ready = versionReady(combo), game = ready.game;
    if (!ready.ok) throw fail(409, `${ready.reason}.`, { code: 'noVersion' });
    const spec = { corner: { name: row.name, apex: row.apex }, key, channel: practice.METRICS[key].channel };
    const base = await svc.drillPassesAsync(combo, spec, { ids, game });
    if (!base.found) throw fail(409, base.reason);
    const r = practice.prescribe({ row, finding, analysis: a, baseline: base.passes, game });
    if (!r.ok) throw fail(409, r.reason);
    const left = base.excluded.filter((x) => /game version/.test(x.reason)).length;
    if (left) r.drill.evidence.text += ` ${left} of the ${ids.length} analysed laps ${left === 1 ? 'was' : 'were'} left out of the "before" (another or unrecorded game version).`;
    const drill = { ...r.drill, baselineIds: base.passes.map((x) => x.lapId) };
    drill.evidence.leftOut = left;
    const id = db.addGoal({ combo, kind: 'drill', target: drill.criterion.target, extra: drill, origin: 'analysis', createdAt: now, dueAt: null });
    // goals ids can be reused (no AUTOINCREMENT): events an older Paddock left for a deleted goal with this id go (review fix 2)
    db.clearDrillEvents(id);
    if (active) db.addDrillEvent(active.id, 'replaced', { by: id }, now);
    return evaluateOne(db.getGoal(id), db.drillEvents(), { inSerial: true });
  });
}

function drillById(id) {
  const g = db.getGoal(Number(id));
  if (!g || g.kind !== 'drill') throw fail(404, 'Drill not found');
  return g;
}
/** At a review point: keep practising (the next passes are judged afresh). */
export function keep(id, now = Date.now()) {
  return serial(async () => {
    const g = drillById(id);
    const d = await evaluateOne(g, db.drillEvents(), { inSerial: true });
    if (!d.active || d.state !== 'review') throw fail(409, 'This drill is not at its review point');
    db.addDrillEvent(g.id, 'restart', d.eval, now);
    return evaluateOne(db.getGoal(g.id), db.drillEvents(), { inSerial: true });
  });
}
/** Stop an active drill (its result so far is kept). */
export function stop(id, now = Date.now()) {
  return serial(async () => {
    const g = drillById(id);
    const d = await evaluateOne(g, db.drillEvents(), { inSerial: true });
    if (!d.active) throw fail(409, 'This drill is not active');
    db.addDrillEvent(g.id, 'stopped', d.eval, now);
    return evaluateOne(db.getGoal(g.id), db.drillEvents(), { inSerial: true });
  });
}
/** Delete a drill and its history. */
export function remove(id) {
  return serial(async () => { drillById(id); db.deleteGoal(Number(id)); return { ok: true }; });
}
