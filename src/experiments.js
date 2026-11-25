// Setup experiments (PL8): an A/B test of two setups on one track + car, built on the P7 setup history
// (src/setuphistory.js: which setups were driven here, their recorded values) and the saved .carsetup files
// (src/setups.js, read only here: an experiment never writes a setup file and never changes the running game's
// setup; the driver loads each setup in the game's own setup screen). Stored in setup_experiments and
// experiment_entries (src/db.js v4). The rules: src/experimentstats.js, docs/platform/EXPERIMENTS.md.
//
// Lifecycle: planned (created: title, hypothesis, expected outcome, A and B, the stint plan) -> running (a stint was
// started) -> reviewed (the result saved with the driver's decision) -> archived (out of the way, restorable).
// A stint is a time window the driver starts and ends in Paddock, or a past session of this car + track.
import * as db from './db.js';
import * as X from './experimentstats.js';
import * as setuphistory from './setuphistory.js';
import * as setupmatch from './setupmatch.js';
import * as setups from './setups.js';
import * as channels from './channels.js';

export const LIMITS = { title: 120, text: 2000, label: 80, corner: 40, note: 500, entries: 500, stints: 40, list: 100 };
export const STATUSES = ['planned', 'running', 'reviewed', 'archived'];
export const DECISIONS = { 'keep-a': 'Keep A', 'keep-b': 'Keep B', retest: 'Test again', none: 'No decision' };

let gameVersion = () => null;
/** The server says how to read the game version now (src/game.js); tests pass their own. */
export function configure({ gameVersion: g } = {}) { if (g) gameVersion = () => { try { return g() ?? null; } catch { return null; } }; }

const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const same = (a, b) => a.track === b.track && a.layout === b.layout && a.car === b.car;
const str = (v, max, what, { required = false } = {}) => {
  if (v == null || v === '') { if (required) throw fail(400, `${what} is needed`); return ''; }
  if (typeof v !== 'string') throw fail(400, `${what} must be text`);
  const s = v.trim();
  if (required && !s) throw fail(400, `${what} is needed`);
  if (s.length > max) throw fail(400, `${what} is too long (at most ${max} characters)`);
  return s;
};
function comboOf(b) {
  const c = b?.combo || b || {};
  const s = (v) => (typeof v === 'string' ? v : null);
  const combo = { track: s(c.track), layout: s(c.layout ?? ''), car: s(c.car) };
  if (!combo.track || !combo.car || combo.layout == null) throw fail(400, 'Pick a track and car');
  return combo;
}

// one change at a time: two clicks cannot open two stints
let chain = Promise.resolve();
function serial(fn) { const run = chain.then(fn); chain = run.catch(() => {}); return run; }

// ---------------------------------------------------------------- what can be compared on a car + track
/**
 * The setups an experiment can use here, from the setup history (setups driven here, P7) and the saved files of
 * this car and track (only this track's: the game lists setups per track), with their ancestry; plus the sessions
 * that can be added as stints. Standard = no saved setup (the game's default or an unsaved change).
 */
export function options(combo) {
  combo = comboOf(combo);
  const byRel = new Map();
  for (const c of setupmatch.candidates(combo.car, combo.track, combo.layout)) {
    byRel.set(c.file.rel, { rel: c.file.rel, label: c.file.name, snap: setuphistory.snapOf(c.values), source: 'file', laps: 0 });
  }
  for (const g of setuphistory.history(combo)) {
    if (!g.rel) continue;
    const o = byRel.get(g.rel) || { rel: g.rel, label: g.name, snap: null, source: 'history', laps: 0 };
    o.laps += g.laps;
    if (!o.snap && o.source === 'history') {
      // a file that is not readable here (another PC, deleted): the values it was last driven with
      const cur = setupmatch.valuesOfRel(g.rel);
      o.snap = cur ? setuphistory.snapOf(cur) : g.snapshot;
    }
    byRel.set(g.rel, o);
  }
  const variants = [...byRel.values()].map((o) => ({ ...o, lineage: setups.lineage(o.rel) }));
  variants.push({ rel: null, label: setupmatch.STANDARD, snap: null, source: 'standard', laps: 0, lineage: [] });
  const sessions = db.listSessions().filter((s) => same(s, combo)).slice(0, 30)
    .map((s) => ({ id: s.id, startedAt: s.started_at, type: s.session_type, laps: db.lapsOfSession(s.id).length })).filter((s) => s.laps);
  return { combo, variants, sessions, game: gameVersion(), patterns: X.PATTERNS, metrics: X.METRICS, directions: X.DIRECTIONS, phases: X.PHASES, balance: X.BALANCE,
    rules: X.RULES, decisions: DECISIONS, probe: channels.status('setupProbe', { car: combo.car }) };
}

/** A variant from the request, looked up in this car + track's options (never trusted as sent). */
function variantOf(want, opts, key) {
  if (!want || typeof want !== 'object') throw fail(400, `Pick setup ${key}`);
  const label = str(want.label, LIMITS.label, `The name of setup ${key}`);
  if (want.rel) {
    const o = opts.variants.find((v) => v.rel === want.rel);
    if (!o) throw fail(400, `Setup ${key} is not a setup of this car and track`);
    return { label: label || o.label, rel: o.rel, snap: o.snap, file: o.label };
  }
  if (!label) throw fail(400, `Name setup ${key} (for example "Standard" or what you changed)`);
  return { label, rel: null, snap: null, file: null };
}
const valuesOfSnap = (snap) => (snap ? db.getSnapshot(snap)?.values ?? null : null);

/** Create an experiment. body: {combo, title, hypothesis, expected: {metric, direction, text}, a, b, plan, parentId} */
export function create(body, now = Date.now()) {
  const combo = comboOf(body);
  const title = str(body.title, LIMITS.title, 'A title', { required: true });
  const hypothesis = str(body.hypothesis, LIMITS.text, 'The hypothesis', { required: true });
  const ex = body.expected || {};
  if (!X.has(X.METRICS, ex.metric || 'pace')) throw fail(400, 'Unknown expected measure');
  if (!X.has(X.DIRECTIONS, ex.direction || 'better')) throw fail(400, 'Unknown expected direction');
  const expected = { metric: ex.metric || 'pace', direction: ex.direction || 'better', text: str(ex.text, LIMITS.note, 'The expected outcome') };
  const opts = options(combo);
  const A = variantOf(body.a, opts, 'A'), B = variantOf(body.b, opts, 'B');
  if (A.rel ? A.rel === B.rel : !B.rel && A.label.toLowerCase() === B.label.toLowerCase()) throw fail(400, 'A and B must be two different setups');
  const p = body.plan || {};
  const plan = {
    pattern: X.has(X.PATTERNS, p.pattern) ? p.pattern : 'ABBA',
    lapsPerStint: Number.isInteger(p.lapsPerStint) && p.lapsPerStint >= 2 && p.lapsPerStint <= 30 ? p.lapsPerStint : X.RULES.lapsPerStint,
    warmup: Number.isInteger(p.warmup) && p.warmup >= 0 && p.warmup <= X.RULES.maxWarmup ? p.warmup : X.RULES.warmup,
    matchConditions: p.matchConditions !== false,
  };
  let parentId = null;
  if (body.parentId != null) {
    const parent = db.getExperiment(Number(body.parentId));
    if (!parent || !same(parent.combo, combo)) throw fail(400, 'The experiment this follows up is not on this car and track');
    parentId = parent.id;
  }
  // the values of each file now, kept with the experiment (the journal's "what changed" stays readable later)
  for (const v of [A, B]) if (v.rel) { const vals = setupmatch.valuesOfRel(v.rel); if (vals && setuphistory.snapOf(vals) === v.snap) db.saveSnapshot(v.snap, { name: v.file, rel: v.rel, values: vals }); }
  const game = gameVersion();
  const id = db.addExperiment({ combo, status: 'planned', parentId, createdAt: now, title, hypothesis, expected, variants: { A, B }, plan, stints: [], game });
  const va = valuesOfSnap(A.snap), vb = valuesOfSnap(B.snap);
  const diff = va && vb ? setuphistory.compareValues(va, vb) : null;
  db.addExperimentEntry(id, 'event', { text: `Created${parentId ? ` as a follow-up of experiment ${parentId}` : ''}${game ? ` on AC EVO ${game}` : ' (game version not known yet: the first counted lap sets it)'}.`,
    changes: diff ? diff.changed.slice(0, 40).map((c) => ({ label: c.label, corner: c.corner, unit: c.unit, a: c.a, b: c.b })) : null,
    same: diff ? diff.same : null, noValues: diff ? null : 'The values of A and B are not both known (Standard, or a file Paddock cannot read), so the change is not listed.' }, now);
  return detail(id);
}

// ---------------------------------------------------------------- reading
function laps(combo) { return db.lapsForCombo(combo.track, combo.layout, combo.car, true); }
function sessionTypes(rows) {
  const out = new Map();
  for (const id of new Set(rows.map((l) => l.session_id).filter((x) => x != null))) out.set(id, db.getSession(id)?.session_type ?? null);
  return out;
}
/** Works an experiment out on its laps now. */
export function evaluate(e, now = Date.now()) {
  const rows = laps(e.combo);
  return X.evaluate(e, rows, { sessionTypes: sessionTypes(rows), probe: channels.status('setupProbe', { car: e.combo.car }), statusOf: (g) => channels.status(g, { car: e.combo.car }),
    currentGame: gameVersion(), feedback: db.experimentEntries(e.id).filter((x) => x.kind === 'feedback'), now });
}

/** What may have changed since the experiment was set up: a setup file edited, renamed or deleted; a game update. */
function warnings(e, ev) {
  const out = [];
  for (const k of ['A', 'B']) {
    const v = e.variants[k];
    if (!v.rel) continue;
    const cur = setupmatch.valuesOfRel(v.rel);
    if (!cur) out.push({ key: `file-${k}`, text: `${k} (${v.label}): the setup file is gone or Paddock can't read its values (renamed, deleted, or the car's limits are not known). Laps recognised as another file are left out.` });
    else if (v.snap && setuphistory.snapOf(cur) !== v.snap) out.push({ key: `values-${k}`, text: `${k} (${v.label}): the file's values changed after the experiment was set up. Laps driven on the new values are left out; start a follow-up experiment to test them.` });
  }
  const now = gameVersion(); // (a saved result keeps the version it had; the update is judged against the game now)
  if (ev?.game && now && now !== ev.game) out.push({ key: 'patch', text: `AC EVO was updated since this experiment's laps (AC EVO ${ev.game}, now ${now}). Laps on the new version are left out: a game update can change grip, tyres and braking. Start a follow-up experiment to test again on the new version.` });
  else if (ev?.patch?.otherVersion) out.push({ key: 'patch', text: `${ev.patch.otherVersion} lap${ev.patch.otherVersion === 1 ? '' : 's'} on another game version than AC EVO ${ev.patch.game} ${ev.patch.otherVersion === 1 ? 'is' : 'are'} left out.` });
  return out;
}

const brief = (e) => {
  const prog = X.planProgress(e.plan, e.stints);
  return { id: e.id, combo: e.combo, title: e.title, status: e.status, parentId: e.parentId, createdAt: e.createdAt, updatedAt: e.updatedAt, game: e.game,
    variants: { A: e.variants.A.label, B: e.variants.B.label }, plan: prog, reviewedAt: e.reviewedAt ?? null, decision: e.decision ?? null,
    result: e.result ? { kind: e.result.comparison.kind, why: e.result.comparison.why, faster: e.result.comparison.faster, deltaMs: e.result.comparison.deltaMs, used: { A: e.result.variants.A.used, B: e.result.variants.B.used } } : null };
};
/** Experiments, newest first (with a combo: that car + track's), and the combos with laps for a new one. */
export function list({ combo = null } = {}) {
  const c = combo ? comboOf(combo) : null;
  const rows = db.listExperiments(c).slice(0, LIMITS.list);
  return { experiments: rows.map(brief), combos: c ? null : db.ownCombos().slice(0, 40), game: gameVersion() };
}

const sig = (r) => `${r.variants.A.used}:${r.variants.B.used}:${r.comparison.kind}:${r.comparison.deltaMs}`;
/** One experiment with its journal, its result (live; the saved one once reviewed), warnings and relatives. */
export function detail(id, now = Date.now()) {
  const e = db.getExperiment(Number(id));
  if (!e) throw fail(404, 'Experiment not found');
  const live = evaluate(e, now);
  const shown = e.result || live;
  const parent = e.parentId ? db.getExperiment(e.parentId) : null;
  const children = db.listExperiments(e.combo).filter((x) => x.parentId === e.id).map((x) => ({ id: x.id, title: x.title, status: x.status }));
  const vals = (v) => valuesOfSnap(v.snap);
  const diff = vals(e.variants.A) && vals(e.variants.B) ? setuphistory.compareValues(vals(e.variants.A), vals(e.variants.B)) : null;
  return {
    ...brief(e), hypothesis: e.hypothesis, expected: e.expected, plan: { ...e.plan, ...live.plan }, stints: e.stints,
    variants: Object.fromEntries(['A', 'B'].map((k) => [k, { ...e.variants[k], lineage: e.variants[k].rel ? setups.lineage(e.variants[k].rel) : [] }])),
    changes: diff ? { changed: diff.changed, same: diff.same } : null,
    entries: db.experimentEntries(e.id), result: shown, saved: !!e.result, conclusion: e.conclusion ?? '', decision: e.decision ?? null,
    // the laps changed since the review (deleted, a session re-assigned): the saved result stays, the page says so
    liveDiffers: !!e.result && sig(live) !== sig(e.result),
    warnings: e.status === 'archived' || e.status === 'reviewed' ? warnings(e, shown).filter((w) => w.key === 'patch') : warnings(e, live),
    parent: parent ? { id: parent.id, title: parent.title, status: parent.status } : null, children,
    probe: channels.status('setupProbe', { car: e.combo.car }), rules: X.RULES, reasons: X.REASONS, decisions: DECISIONS,
  };
}

// ---------------------------------------------------------------- changes
function load(id, { open = true } = {}) {
  const e = db.getExperiment(Number(id));
  if (!e) throw fail(404, 'Experiment not found');
  if (open && (e.status === 'archived' || e.status === 'reviewed')) throw fail(409, e.status === 'archived' ? 'This experiment is archived: restore it first' : 'This experiment is reviewed: reopen it to drive more stints');
  return e;
}
const event = (e, text, at = Date.now()) => db.addExperimentEntry(e.id, 'event', { text }, at);
const openStint = (e) => e.stints.find((s) => s.endAt == null && s.sessionId == null) || null;
const nextStintId = (e) => e.stints.reduce((m, s) => Math.max(m, s.id), 0) + 1;
const entriesFull = (e) => { if (db.experimentEntries(e.id).length >= LIMITS.entries) throw fail(400, `At most ${LIMITS.entries} journal entries per experiment`); };

/** Start a stint of A or B now. One open stint per car + track (laps can only belong to one). */
export const startStint = (id, variant, now = Date.now()) => serial(() => {
  const e = load(id);
  if (variant !== 'A' && variant !== 'B') throw fail(400, 'Pick A or B');
  if (openStint(e)) throw fail(409, 'A stint is already running: end it first');
  const other = db.listExperiments(e.combo).find((x) => x.id !== e.id && x.status !== 'archived' && openStint(x));
  if (other) throw fail(409, `A stint of "${other.title}" is running on this car and track: end it first`, { code: 'open', other: other.id });
  if (e.stints.length >= LIMITS.stints) throw fail(400, `At most ${LIMITS.stints} stints per experiment`);
  // stints never overlap (PL8 review): a window that ends after now would share its laps with the new one
  const later = e.stints.find((x) => x.sessionId == null && (x.startAt > now || (x.endAt != null && x.endAt > now)));
  if (later) throw fail(409, `Stint ${e.stints.indexOf(later) + 1} ends after now: a new stint would overlap it`);
  e.stints.push({ id: nextStintId(e), variant, startAt: now, endAt: null });
  e.status = 'running';
  db.saveExperiment(e);
  event(e, `Stint ${e.stints.length} started on ${variant} (${e.variants[variant].label}). Load this setup in the game's setup screen yourself: Paddock never changes the game's setup.`, now);
  return detail(e.id, now);
});
/** End the running stint. */
export const endStint = (id, now = Date.now()) => serial(() => {
  const e = load(id);
  const s = openStint(e);
  if (!s) throw fail(409, 'No stint is running');
  s.endAt = now;
  db.saveExperiment(e);
  event(e, `Stint ${e.stints.indexOf(s) + 1} on ${s.variant} ended.`, now);
  return detail(e.id, now);
});
/** A past session of this car + track as a stint of A or B. */
export const addSession = (id, variant, sessionId, now = Date.now()) => serial(() => {
  const e = load(id);
  if (variant !== 'A' && variant !== 'B') throw fail(400, 'Pick A or B');
  const s = db.getSession(Number(sessionId));
  if (!s || !same(s, e.combo)) throw fail(400, 'That session is not on this car and track');
  if (e.stints.some((x) => x.sessionId === s.id)) throw fail(409, 'That session is already a stint of this experiment');
  if (e.stints.length >= LIMITS.stints) throw fail(400, `At most ${LIMITS.stints} stints per experiment`);
  // a session whose laps lie inside a stint's time window would take them from it (PL8 review): refused
  const times = db.lapsOfSession(s.id).map((l) => l.recorded_at);
  const overlap = e.stints.find((x) => x.sessionId == null && times.some((t) => t >= x.startAt && t <= (x.endAt ?? now)));
  if (overlap) throw fail(409, `That session overlaps stint ${e.stints.indexOf(overlap) + 1} (${overlap.variant}), which already counts its laps: take that stint out first`);
  e.stints.push({ id: nextStintId(e), variant, sessionId: s.id, startAt: s.started_at, endAt: null });
  e.stints.sort((a, b) => a.startAt - b.startAt);
  e.status = 'running';
  db.saveExperiment(e);
  event(e, `Session of ${new Date(s.started_at).toISOString().slice(0, 16).replace('T', ' ')} added as a stint on ${variant} (${e.variants[variant].label}).`, now);
  return detail(e.id, now);
});
/** Take a stint out (a mistake); its laps no longer count. */
export const removeStint = (id, stintId, now = Date.now()) => serial(() => {
  const e = load(id);
  const i = e.stints.findIndex((s) => s.id === Number(stintId));
  if (i < 0) throw fail(404, 'Stint not found');
  const [s] = e.stints.splice(i, 1);
  if (!e.stints.length) e.status = 'planned';
  db.saveExperiment(e);
  event(e, `A stint on ${s.variant} was taken out.`, now);
  return detail(e.id, now);
});
/** A line in the change journal (what was changed and why, what was tried). */
export function note(id, text, now = Date.now()) {
  const e = load(id, { open: false });
  if (e.status === 'archived') throw fail(409, 'This experiment is archived: restore it first');
  entriesFull(e);
  db.addExperimentEntry(e.id, 'journal', { text: str(text, LIMITS.text, 'The note', { required: true }) }, now);
  return detail(e.id, now);
}
/** Handling feedback: setup, corner phase, balance, optional corner and note. */
export function feedback(id, f = {}, now = Date.now()) {
  const e = load(id, { open: false });
  if (e.status === 'archived') throw fail(409, 'This experiment is archived: restore it first');
  if (f.variant !== 'A' && f.variant !== 'B') throw fail(400, 'Pick A or B');
  if (!X.has(X.PHASES, f.phase)) throw fail(400, 'Pick entry, mid-corner or exit');
  if (!X.has(X.BALANCE, f.balance)) throw fail(400, 'Pick understeer, neutral or oversteer');
  entriesFull(e);
  db.addExperimentEntry(e.id, 'feedback', { variant: f.variant, phase: f.phase, balance: f.balance, corner: str(f.corner, LIMITS.corner, 'The corner') || null, note: str(f.note, LIMITS.note, 'The note') || null }, now);
  return detail(e.id, now);
}
/** Save the result as it is now, with the driver's decision; the experiment is then read-only until reopened. */
export const review = (id, { decision = 'none', conclusion = '' } = {}, now = Date.now()) => serial(() => {
  const e = load(id);
  if (!X.has(DECISIONS, decision)) throw fail(400, 'Unknown decision');
  if (openStint(e)) throw fail(409, 'A stint is still running: end it first');
  if (!e.stints.length) throw fail(409, 'Drive at least one stint first');
  const r = evaluate(e, now);
  e.result = { ...r, laps: r.laps.map(({ id: lapId, variant, stint, timeMs, valid, reason }) => ({ id: lapId, variant, stint, timeMs, valid, reason })) };
  e.decision = decision; e.conclusion = str(conclusion, LIMITS.text, 'The conclusion'); e.reviewedAt = now; e.status = 'reviewed';
  db.saveExperiment(e);
  event(e, `Reviewed: ${r.comparison.kind === 'difference' ? `${r.comparison.faster} quicker` : 'inconclusive'}; decision: ${DECISIONS[decision]}.`, now);
  return detail(e.id, now);
});
/** Drive more: the saved result is dropped (its journal line stays). */
export const reopen = (id, now = Date.now()) => serial(() => {
  const e = load(id, { open: false });
  if (e.status !== 'reviewed') throw fail(409, 'Only a reviewed experiment can be reopened');
  delete e.result; delete e.reviewedAt; e.decision = null;
  e.status = e.stints.length ? 'running' : 'planned';
  db.saveExperiment(e);
  event(e, 'Reopened to drive more stints (the saved result was dropped).', now);
  return detail(e.id, now);
});
export const archive = (id, now = Date.now()) => serial(() => {
  const e = load(id, { open: false });
  if (e.status === 'archived') return detail(e.id, now);
  const s = openStint(e);
  if (s) s.endAt = now;
  e.prevStatus = e.status; e.status = 'archived';
  db.saveExperiment(e);
  event(e, `Archived${s ? ' (its running stint was ended)' : ''}.`, now);
  return detail(e.id, now);
});
export const restore = (id, now = Date.now()) => serial(() => {
  const e = load(id, { open: false });
  if (e.status !== 'archived') throw fail(409, 'This experiment is not archived');
  e.status = STATUSES.includes(e.prevStatus) && e.prevStatus !== 'archived' ? e.prevStatus : 'planned';
  delete e.prevStatus;
  db.saveExperiment(e);
  event(e, 'Restored from the archive.', now);
  return detail(e.id, now);
});
/** Delete an experiment and its journal (laps and setup files are not touched). */
export const remove = (id) => serial(() => {
  const e = db.getExperiment(Number(id));
  if (!e) throw fail(404, 'Experiment not found');
  db.deleteExperiment(e.id);
  return { ok: true, id: e.id };
});
