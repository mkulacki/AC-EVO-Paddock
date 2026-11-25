// Setup history (P7): for one track + car, every setup actually driven, with dates, sessions and lap statistics, and
// a value-by-value comparison of two of them. A "setup" here is what the lap remembers (laps.setup_info): the saved
// file it was recognised as (rel) and the snapshot of that file's values when it was driven (snap). The same file
// edited between sessions is two entries (two snapshots), so a change of values is never hidden.
// Laps with no setup_info (recorded before setups were tracked, or the setup was never detected in that session) form
// one "Not recorded" entry.
import crypto from 'node:crypto';
import * as db from './db.js';
import { describeName, GROUPS } from './carsetup.js';
import { valuesOfRel, STANDARD } from './setupmatch.js';
import * as channels from './channels.js';

export const NOT_RECORDED = 'Not recorded';
const CLEAN_WITHIN = 1.07; // same "clean lap" rule as the report and the Progress page
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const r0 = (v) => (v == null ? null : Math.round(v));
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const parse = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

/** Hash of a values object, the same recipe as the snapshots (src/setupmatch.js pick). */
export const snapOf = (values) => crypto.createHash('sha1').update(JSON.stringify(values)).digest('hex').slice(0, 16);

/**
 * The key of the setup a lap was driven on: 'snap:<hash>@<rel>', 'file:<rel>', 'standard' or 'none'. The file is part
 * of a snapshot key: two saved files with the same values are still two setups.
 */
export function keyOf(lap) {
  const info = parse(lap.setup_info);
  if (!info && lap.setup_name == null) return 'none';
  if (info?.snap) return `snap:${info.snap}@${info.rel ?? ''}`;
  if (info?.rel) return `file:${info.rel}`;
  return 'standard';
}

/**
 * Every setup driven with this car on this track, newest first:
 * [{key, name, rel, version, versions, snapshot, match: [kinds], firstAt, lastAt, sessions, laps, validLaps, cleanLaps,
 *   bestMs, bestLapId, medianMs, sdMs, conditions: {airC, roadC, sessions}}]
 */
export function history({ track, layout, car }) {
  const laps = db.lapsForCombo(track, layout, car, true).sort((a, b) => a.recorded_at - b.recorded_at);
  const groups = new Map();
  for (const l of laps) {
    const key = keyOf(l), info = parse(l.setup_info);
    if (!groups.has(key)) {
      groups.set(key, { key, name: key === 'none' ? NOT_RECORDED : key === 'standard' ? STANDARD : l.setup_name ?? STANDARD, rel: info?.rel ?? null,
        snapshot: info?.snap ?? null, match: new Set(), rows: [] });
    }
    const g = groups.get(key);
    g.rows.push(l);
    if (info?.match) g.match.add(info.match);
  }
  // versions: the same saved file driven with different recorded values, numbered in the order they were first driven
  // (only entries with recorded values: a file-only entry has unknown values)
  const byRel = new Map();
  for (const g of groups.values()) if (g.rel && g.snapshot) { if (!byRel.has(g.rel)) byRel.set(g.rel, []); byRel.get(g.rel).push(g); }
  for (const list of byRel.values()) list.forEach((g, i) => { g.version = i + 1; g.versions = list.length; });

  const sessionsCache = new Map();
  const sessionOf = (id) => { if (!sessionsCache.has(id)) sessionsCache.set(id, db.getSession(id) ?? null); return sessionsCache.get(id); };
  return [...groups.values()].map((g) => {
    const valid = g.rows.filter((l) => l.valid);
    const best = valid.reduce((a, b) => (!a || b.lap_time_ms < a.lap_time_ms ? b : a), null);
    const clean = best ? valid.map((l) => l.lap_time_ms).filter((t) => t <= best.lap_time_ms * CLEAN_WITHIN) : [];
    const mean = clean.length ? clean.reduce((a, b) => a + b, 0) / clean.length : null;
    const sids = [...new Set(g.rows.map((l) => l.session_id).filter((x) => x != null))];
    // conditions: the average air and track temperature of the sessions that recorded them
    const air = [], road = [];
    for (const sid of sids) {
      const c = parse(sessionOf(sid)?.conditions);
      if (c?.airC?.avg != null) air.push(c.airC.avg);
      if (c?.roadC?.avg != null) road.push(c.roadC.avg);
    }
    const avg = (a) => (a.length ? r1(a.reduce((x, y) => x + y, 0) / a.length) : null);
    return {
      key: g.key, name: g.name, rel: g.rel, version: g.version ?? null, versions: g.versions ?? null, snapshot: g.snapshot,
      match: [...g.match], firstAt: g.rows[0].recorded_at, lastAt: g.rows[g.rows.length - 1].recorded_at, sessions: sids.length,
      laps: g.rows.length, validLaps: valid.length, cleanLaps: clean.length,
      bestMs: best?.lap_time_ms ?? null, bestLapId: best?.id ?? null, medianMs: r0(median(clean)),
      sdMs: clean.length >= 3 ? r0(Math.sqrt(clean.reduce((a, b) => a + (b - mean) ** 2, 0) / clean.length)) : null,
      conditions: { airC: avg(air), roadC: avg(road), sessions: Math.max(air.length, road.length) },
      lapIds: g.rows.map((l) => l.id),
    };
  }).sort((a, b) => b.lastAt - a.lastAt);
}

/** The values of a history entry: the snapshot taken when it was driven, else the saved file as it is now. */
export function valuesOf(entry) {
  if (entry.snapshot) {
    const s = db.getSnapshot(entry.snapshot);
    if (s?.values) return { source: 'snapshot', values: s.values };
  }
  if (entry.rel) {
    const v = valuesOfRel(entry.rel);
    if (v) return { source: 'file', values: v };
  }
  return { source: null, values: null };
}

/**
 * Two setups side by side: every value both have, and the ones that differ.
 * -> {a, b, changed: [{name, label, corner, unit, group, a, b, delta}], same: n, onlyA: [names], onlyB: [names]}
 */
export function compareValues(va, vb) {
  const changed = [], onlyA = [], onlyB = [];
  let same = 0;
  for (const name of Object.keys(va)) {
    if (!(name in vb)) { onlyA.push(name); continue; }
    const a = va[name], b = vb[name];
    if (Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b))) { same++; continue; }
    changed.push({ ...describeName(name), a, b, delta: Math.round((b - a) * 1e4) / 1e4 });
  }
  for (const name of Object.keys(vb)) if (!(name in va)) onlyB.push(name);
  const order = new Map(GROUPS.map((g, i) => [g.id, i]));
  changed.sort((x, y) => (order.get(x.group) ?? 99) - (order.get(y.group) ?? 99) || x.name.localeCompare(y.name));
  return { changed, same, onlyA, onlyB };
}

/** Compare two history entries of a track + car by key. */
export function diff(combo, keyA, keyB) {
  const list = history(combo);
  const A = list.find((g) => g.key === keyA), B = list.find((g) => g.key === keyB);
  if (!A || !B) throw new Error('Setup not found in this history');
  const va = valuesOf(A), vb = valuesOf(B);
  const strip = (g, v) => ({ key: g.key, name: g.name, version: g.version, versions: g.versions, source: v.source, bestMs: g.bestMs, medianMs: g.medianMs, laps: g.laps, validLaps: g.validLaps });
  const out = { a: strip(A, va), b: strip(B, vb), changed: null, same: null, onlyA: [], onlyB: [] };
  if (!va.values || !vb.values) {
    const why = (g) => `${g.name} has no recorded values (${g.key === 'standard' ? 'no saved setup matched: the game\'s default or an unsaved change'
      : g.key === 'none' ? 'the setup was not recorded for these laps' : 'the saved file is gone or unreadable'})`;
    out.reason = [!va.values && why(A), !vb.values && why(B)].filter(Boolean).join('; ');
    return out;
  }
  return { ...out, ...compareValues(va.values, vb.values) };
}

/** For the AI setup engineer: the laps split by setup (compact). current = rel of the setup being engineered. */
export function forAi(combos, currentRel = null) {
  const rows = [];
  // the setup being engineered = the entry driven with the file's current values; other entries of that file are
  // marked apart (older values, or values unknown), so their lap times are not credited to the current values
  const cur = currentRel ? valuesOfRel(currentRel) : null;
  const temps = channels.usable('conditions'); // temperatures marked as not matching the game are left out (PL4 review)
  const curSnap = cur ? snapOf(cur) : null;
  for (const c of combos) {
    for (const g of history(c)) {
      const mine = currentRel != null && g.rel === currentRel, exact = mine && g.snapshot != null && g.snapshot === curSnap;
      rows.push({ setup: g.version && g.versions > 1 ? `${g.name} (version ${g.version} of ${g.versions})` : g.name,
        this_setup: exact ? true : undefined, this_setup_other_values: mine && !exact ? true : undefined,
        layout: combos.length > 1 ? c.layout : undefined, laps: g.laps, valid_laps: g.validLaps, best_ms: g.bestMs,
        median_clean_ms: g.medianMs, spread_ms: g.sdMs ?? undefined, last_driven: new Date(g.lastAt).toISOString().slice(0, 10),
        air_c: temps ? g.conditions.airC ?? undefined : undefined, track_c: temps ? g.conditions.roadC ?? undefined : undefined });
    }
  }
  return rows;
}
