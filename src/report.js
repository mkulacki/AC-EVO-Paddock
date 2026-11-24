// Session report: made when a session ends (src/server.js, recorder 'sessionEnd') and on request for older
// sessions. Best lap and average, the change against earlier sessions, best and weakest corners, consistency,
// setups and conditions, lap-time trend, theoretical best, where laps went invalid, next practice targets and
// whether the previous report's targets were met. Stored in the reports table (JSON) so targets stay as they
// were set; "regenerate" builds it again from the laps.
import * as db from './db.js';
import * as svc from './service.js';
import { cornerMetrics, lateralOffsets, turnSign, techniqueMetrics } from './analysis.js';

export const MIN_LAPS = 3;               // saved laps a session needs for an automatic report
const CLEAN_WITHIN = 1.07;               // same "clean lap" rule as the Progress page
const VERSION = 2;                       // 2: driving style section (P6)

const fmt = (ms) => (ms == null ? '-' : `${Math.floor(ms / 60000)}:${((ms % 60000) / 1000).toFixed(3).padStart(6, '0')}`);
const secs = (ms, d = 2) => `${(ms / 1000).toFixed(d)} s`;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const sd = (a) => { if (a.length < 3) return null; const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length); };
const r0 = (v) => (v == null ? null : Math.round(v));
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

/** best / clean average / spread of a list of laps (db rows) */
function lapStats(laps) {
  const valid = laps.filter((l) => l.valid);
  const best = valid.reduce((a, b) => (!a || b.lap_time_ms < a.lap_time_ms ? b : a), null);
  const clean = best ? valid.map((l) => l.lap_time_ms).filter((t) => t <= best.lap_time_ms * CLEAN_WITHIN) : [];
  return { best, valid, clean, avgMs: r0(mean(clean)), medianMs: r0(median(clean)), sdMs: r0(sd(clean)), validAvgMs: r0(mean(valid.map((l) => l.lap_time_ms))) };
}

/** The report's consistency score (0-100) from a list of lap times' stats: 100 − 4000 × (spread / average) of the clean laps. */
const scoreOfStats = (S) => { const cv = S.sdMs != null && S.avgMs ? S.sdMs / S.avgMs : null; return cv != null ? Math.max(0, Math.min(100, Math.round(100 - 4000 * cv))) : null; };
/** Consistency of a session's laps (db rows), the same numbers as its report: {score, sdMs, cleanLaps}; score null under 3 clean laps. */
export function consistencyOf(laps) { const S = lapStats(laps); return { score: scoreOfStats(S), sdMs: S.sdMs, cleanLaps: S.clean.length }; }

// + = towards the outside of the corner (as the Consistency page)
function wideOf(R, ref, corners, turns) {
  const off = lateralOffsets(R, ref);
  const wide = new Array(off.length).fill(0);
  corners.forEach((c, k) => { for (let i = c.a; i <= c.b && i < off.length; i++) wide[i] = -turns[k] * off[i]; });
  return wide;
}

// what the typical pass of a corner does differently from the best pass ever: reasons + a concrete target
function cornerReasons(t, b) {
  const out = [];
  const bp = (m) => m.brakePoint ?? m.liftPoint;
  const verb = (m) => (m.brakePoint != null ? 'brake' : 'lift');
  if (bp(t) != null && bp(b) != null && bp(b) - bp(t) >= 5) {
    const d = bp(b) - bp(t);
    out.push({ w: d / 10, text: `${verb(t) === 'brake' ? 'braking' : 'lifting'} ${d} m earlier than your best pass (${bp(t)} m vs ${bp(b)} m)`, target: `${verb(b)} at about ${bp(b)} m (typically ${bp(t)} m today)` });
  }
  if (t.minSpeed != null && b.minSpeed != null && b.minSpeed - t.minSpeed >= 2) {
    const d = r1(b.minSpeed - t.minSpeed);
    out.push({ w: d / 3, text: `${d} km/h slower at the apex (${t.minSpeed} vs ${b.minSpeed} km/h)`, target: `carry ${Math.round(d)} km/h more to the apex, ${b.minSpeed} km/h` });
  }
  if (t.throttlePickup != null && b.throttlePickup != null && t.throttlePickup - b.throttlePickup >= 8) {
    const d = t.throttlePickup - b.throttlePickup;
    out.push({ w: d / 15, text: `back on the throttle ${d} m later (${t.throttlePickup} m vs ${b.throttlePickup} m)`, target: `pick up the throttle by ${b.throttlePickup} m` });
  }
  if (t.exitSpeed != null && b.exitSpeed != null && b.exitSpeed - t.exitSpeed >= 3) {
    const d = r1(b.exitSpeed - t.exitSpeed);
    out.push({ w: d / 4, text: `${d} km/h slower on the exit`, target: `exit at ${b.exitSpeed} km/h (+${Math.round(d)} km/h)` });
  }
  if (t.coastM != null && b.coastM != null && t.coastM - b.coastM >= 10) {
    const d = t.coastM - b.coastM;
    out.push({ w: d / 15, text: `${d} m more coasting (neither pedal)`, target: `cut the coasting: go from brake to throttle without a gap` });
  }
  if (t.apexWide != null && b.apexWide != null && t.apexWide - b.apexWide >= 1) {
    const d = r1(t.apexWide - b.apexWide);
    out.push({ w: d / 1.5, text: `apex ${d} m wider than on your best pass`, target: `a tighter apex, ${d} m closer to the inside` });
  }
  return out.sort((x, y) => y.w - x.w);
}

// ---- driving style (P6): this session's typical technique per corner against the corner's fastest pass ever.
// Every rule compares with that reference pass, so the thresholds suit any car. Only shown with enough data.
export const STYLE_MIN_LAPS = 3;
const STYLE_KEYS = ['brakeRampMs', 'trailM', 'releaseMs', 'releaseBumps', 'pickupMs', 'reLifts', 'steerReversals', 'steerSaw', 'coastM'];
function styleNotes(t, b) {
  const out = [], has = (k) => t[k] != null && b[k] != null;
  if (has('brakeRampMs') && t.brakeRampMs - b.brakeRampMs >= 100 && t.brakeRampMs >= 1.5 * b.brakeRampMs)
    out.push({ key: 'brakeRampMs', w: (t.brakeRampMs - b.brakeRampMs) / 100, text: `slower on the brake: ${t.brakeRampMs} ms to full pressure (best pass ${b.brakeRampMs} ms)` });
  if (has('trailM') && b.trailM >= 10 && t.trailM <= 0.5 * b.trailM)
    out.push({ key: 'trailM', w: (b.trailM - t.trailM) / 10, text: `less trail braking: ${t.trailM} m braking while turning (best pass ${b.trailM} m)` });
  if (has('releaseBumps') && t.releaseBumps >= 1 && b.releaseBumps === 0)
    out.push({ key: 'releaseBumps', w: t.releaseBumps, text: `pressing the brake again while releasing it (${t.releaseBumps}×; best pass: a smooth release)` });
  if (has('pickupMs') && t.pickupMs - b.pickupMs >= Math.max(150, 0.25 * b.pickupMs))
    out.push({ key: 'pickupMs', w: (t.pickupMs - b.pickupMs) / 150, text: `full throttle ${secs(t.pickupMs - b.pickupMs)} later after the apex (${secs(t.pickupMs)} vs ${secs(b.pickupMs)})` });
  if (has('reLifts') && t.reLifts - b.reLifts >= 1)
    out.push({ key: 'reLifts', w: t.reLifts - b.reLifts, text: `lifting again on the exit (${t.reLifts}×, best pass ${b.reLifts}×)` });
  if (has('steerReversals') && t.steerReversals - b.steerReversals >= 1)
    out.push({ key: 'steerReversals', w: 1.5 * (t.steerReversals - b.steerReversals), text: `an extra big steering correction (${t.steerReversals} direction changes, best pass ${b.steerReversals})` });
  if (has('steerSaw') && t.steerSaw - b.steerSaw >= 3 && t.steerSaw >= 1.5 * b.steerSaw)
    out.push({ key: 'steerSaw', w: (t.steerSaw - b.steerSaw) / 3, text: `more small steering corrections (${t.steerSaw}, best pass ${b.steerSaw})` });
  if (has('coastM') && t.coastM - b.coastM >= 10)
    out.push({ key: 'coastM', w: (t.coastM - b.coastM) / 15, text: `${t.coastM - b.coastM} m more coasting (${t.coastM} m vs ${b.coastM} m)` });
  return out.sort((x, y) => y.w - x.w);
}
/** typical values: the median of each metric over the passes (times and distances rounded; counts keep a .5) */
const COUNTS = new Set(['releaseBumps', 'reLifts', 'steerReversals', 'steerSaw']);
function typicalOf(list) {
  const o = {};
  for (const k of STYLE_KEYS) { const v = list.map((m) => m[k]).filter((x) => x != null); o[k] = v.length >= Math.ceil(list.length / 2) ? (COUNTS.has(k) ? r1(median(v)) : r0(median(v))) : null; }
  return o;
}
const pick = (m) => Object.fromEntries(STYLE_KEYS.map((k) => [k, m[k] ?? null]));

const SNAP_KEYS = /^(pressure_|camber_|brakesfront_bias$|fuel$|front_wing_angle$|rear_wing_angle$|front_target_height$|rear_target_height$|tc|abs|arbs)/;

/** Setups of the session, in driving order: [{name, rel, id, match, laps: [lapNumber], lapIds, bestMs, values}] */
function setupSegments(laps) {
  const segs = [];
  for (const l of laps) {
    let info = null; try { info = l.setup_info ? JSON.parse(l.setup_info) : null; } catch { /* old row */ }
    const name = l.setup_name ?? null, rel = info?.rel ?? null;
    let s = segs[segs.length - 1];
    if (!s || s.name !== name || s.rel !== rel) {
      const snap = info?.snap ? db.getSnapshot(info.snap) : null;
      const values = snap ? Object.fromEntries(Object.entries(snap.values).filter(([k]) => SNAP_KEYS.test(k))) : null;
      s = { name, rel, id: info?.id ?? null, match: info?.match ?? null, laps: [], lapIds: [], bestMs: null, values, probe: info?.probe ?? null };
      segs.push(s);
    }
    s.laps.push(l.lap_number); s.lapIds.push(l.id);
    if (l.valid && (s.bestMs == null || l.lap_time_ms < s.bestMs)) s.bestMs = l.lap_time_ms;
  }
  return segs;
}

/** Where invalid laps lost validity: the corner of the first sample flagged "not valid". */
function trackLimits(laps, R, corners) {
  const byCorner = new Map(); let unknown = 0;
  for (const l of laps.filter((x) => !x.valid)) {
    const lap = db.getLap(l.id);
    const ok = lap?.data?.ok, d = lap?.data?.d;
    const i = Array.isArray(ok) ? ok.findIndex((v) => v === 0) : -1;
    if (i < 0) { unknown++; continue; }
    const dist = d[i] * (R.L / (lap.track_length || R.L));
    const c = corners.find((x) => dist >= R.d[x.a] && dist <= R.d[x.b]) || corners[corners.length - 1];
    byCorner.set(c.name, (byCorner.get(c.name) || 0) + 1);
  }
  return { invalid: laps.filter((x) => !x.valid).length, unknown,
    byCorner: [...byCorner.entries()].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n) };
}

/** Did this session meet the targets of an earlier report? */
export function checkTargets(targets, r) {
  return targets.map((t) => {
    if (t.kind === 'lap') {
      const a = r.best?.ms ?? null;
      return { text: t.text, met: a != null && a <= t.ms, actual: a != null ? `best ${fmt(a)}` : 'no valid lap' };
    }
    if (t.kind === 'corner') {
      const c = r.corners.all.find((x) => x.name === t.corner);
      const a = c?.medianMs ?? null;
      return { text: t.text, met: a != null && a <= t.ms, actual: a != null ? `typical ${secs(a, 3)} (target ${secs(t.ms, 3)})` : 'corner not driven' };
    }
    if (t.kind === 'consistency') {
      const a = r.consistency.sdMs;
      return { text: t.text, met: a != null && a <= t.sdMs, actual: a != null ? `±${secs(a)}` : 'fewer than 3 clean laps' };
    }
    if (t.kind === 'limits') {
      const a = r.trackLimits.byCorner.find((x) => x.name === t.corner)?.n ?? 0;
      return { text: t.text, met: a === 0, actual: `${a} invalid there` };
    }
    return { text: t.text, met: null, actual: '' };
  });
}

/**
 * Build the report of a session. -> report object, or throws when there is nothing to report on.
 * opts.withPrevTargets: also check the previous report's targets (false while building that previous report)
 */
/** The last earlier session with a valid lap on the same track + car (its report's targets are checked), or null. */
export function previousSession(sessionId) {
  const laps = db.lapsOfSession(sessionId).filter((l) => l.source === 'local');
  if (!laps.length) return null;
  const startAt = laps[0].recorded_at;
  return db.lapsForCombo(laps[0].track, laps[0].layout, laps[0].car, true).sort((a, b) => a.recorded_at - b.recorded_at)
    .filter((l) => l.recorded_at < startAt && l.session_id !== sessionId).reverse().find((l) => l.valid)?.session_id ?? null;
}

export function build(sessionId, { withPrevTargets = true } = {}) {
  const session = db.getSession(sessionId);
  if (!session) throw new Error('Session not found');
  const laps = db.lapsOfSession(sessionId).filter((l) => l.source === 'local');
  if (!laps.length) throw new Error('This session has no laps');
  const combo = { track: laps[0].track, layout: laps[0].layout, car: laps[0].car };
  const startAt = laps[0].recorded_at, endAt = laps[laps.length - 1].recorded_at;
  const S = lapStats(laps);
  if (!S.best) throw new Error('This session has no valid lap: nothing to compare yet');

  // ---- earlier sessions on this track with this car
  const all = db.lapsForCombo(combo.track, combo.layout, combo.car, true).sort((a, b) => a.recorded_at - b.recorded_at);
  const before = all.filter((l) => l.recorded_at < startAt && l.session_id !== sessionId);
  const allTimeBefore = before.filter((l) => l.valid).reduce((a, b) => (a == null || b.lap_time_ms < a ? b.lap_time_ms : a), null);
  const prevSessionId = [...before].reverse().find((l) => l.valid)?.session_id ?? null;
  const prevLaps = prevSessionId != null ? all.filter((l) => l.session_id === prevSessionId) : [];
  const P = prevLaps.length ? lapStats(prevLaps) : null;

  // ---- corners: this session's typical pass against your fastest pass so far
  const info = svc.comboInfo(combo);
  const corners = info.corners;
  const ref = svc.getResampled(info.best.id).R;
  const turns = corners.map((c) => turnSign(ref, c.apexIdx));
  const upTo = all.filter((l) => l.valid && l.recorded_at <= endAt);
  const bestEver = corners.map(() => ({ ms: Infinity, lapId: null }));
  // lapId -> corner times; R (the whole trace) is read only for the laps that need it (PL3: the corner times of
  // every lap are kept by src/service.js, so a long history is not read again for each report)
  const lapTimes = new Map();
  for (const l of upTo) {
    const ct = svc.lapCornerTimes(info, l.id);
    if (!ct || ct.n !== ref.n) continue;
    const t = ct.dts; lapTimes.set(l.id, { t, get R() { return svc.getResampled(l.id).R; } });
    t.forEach((ms, k) => { if (ms < bestEver[k].ms) bestEver[k] = { ms, lapId: l.id }; });
  }
  const sess = S.valid.filter((l) => lapTimes.has(l.id));
  const prevValid = (P?.valid || []).filter((l) => lapTimes.has(l.id));
  const cornerRows = corners.map((c, k) => {
    const mine = sess.map((l) => lapTimes.get(l.id).t[k]);
    const prev = prevValid.map((l) => lapTimes.get(l.id).t[k]);
    const med = median(mine), pm = median(prev);
    return { name: c.name, n: c.n, apex: Math.round(ref.d[c.apexIdx]), medianMs: r0(med), sessionBestMs: r0(Math.min(...mine)), bestEverMs: r0(bestEver[k].ms),
      gapMs: med != null && Number.isFinite(bestEver[k].ms) ? r0(med - bestEver[k].ms) : null, sdMs: r0(sd(mine)),
      prevMedianMs: r0(pm), changeMs: med != null && pm != null ? r0(med - pm) : null };
  });
  const ranked = cornerRows.filter((c) => c.gapMs != null).sort((a, b) => a.gapMs - b.gapMs);
  const nPick = Math.min(3, Math.floor(ranked.length / 2)) || Math.min(3, ranked.length);
  const bestCorners = ranked.slice(0, nPick).map((c) => c.name);
  // a corner only counts as weak if it actually loses time against the best pass (not with a single lap that is the best)
  const weakest = ranked.slice(-nPick).reverse().filter((c) => c.gapMs >= 20 && (!bestCorners.includes(c.name) || ranked.length < 2)).map((c) => {
    const k = corners.findIndex((x) => x.name === c.name);
    // the typical pass = the session lap whose time in this corner is the median one
    // (the upper one of an even count, so with two laps it is not the faster one, which may be the best pass itself)
    const typ = [...sess].sort((a, b) => lapTimes.get(a.id).t[k] - lapTimes.get(b.id).t[k])[sess.length >> 1];
    const bestLap = lapTimes.get(bestEver[k].lapId);
    let reasons = [];
    if (typ && bestLap && typ.id !== bestEver[k].lapId) {
      const tR = lapTimes.get(typ.id).R, cc = corners[k];
      reasons = cornerReasons(cornerMetrics(tR, cc, wideOf(tR, ref, corners, turns)), cornerMetrics(bestLap.R, cc, wideOf(bestLap.R, ref, corners, turns)));
      if (!reasons.length) {
        // nothing stands out in the metrics: say at least whether the time goes before or after the apex
        const entry = (tR.t[cc.apexIdx] - tR.t[cc.a]) - (bestLap.R.t[cc.apexIdx] - bestLap.R.t[cc.a]);
        const exit = (tR.t[cc.b] - tR.t[cc.apexIdx]) - (bestLap.R.t[cc.b] - bestLap.R.t[cc.apexIdx]);
        const onEntry = entry >= exit;
        reasons = [{ text: `${secs(Math.max(0, entry), 2)} lost before the apex, ${secs(Math.max(0, exit), 2)} after it`,
          target: onEntry ? 'copy the entry of your best pass: braking point and turn-in (compare the laps)' : 'copy the exit of your best pass: earlier, more confident throttle (compare the laps)' }];
      }
    }
    return { name: c.name, gapMs: c.gapMs, reasons: reasons.slice(0, 2).map((x) => x.text), target: reasons[0]?.target ?? null, bestLapId: bestEver[k].lapId };
  });

  // ---- driving style: only with enough valid laps through the corners
  let style;
  if (sess.length < STYLE_MIN_LAPS) style = { sufficient: false, reason: `needs ${STYLE_MIN_LAPS} valid laps (this session: ${sess.length})`, laps: sess.length };
  else {
    const rows = corners.map((c, k) => {
      const ref = lapTimes.get(bestEver[k].lapId);
      if (!ref) return null;
      const typical = typicalOf(sess.map((l) => techniqueMetrics(lapTimes.get(l.id).R, c)));
      const best = pick(techniqueMetrics(ref.R, c));
      const gap = cornerRows[k].gapMs;
      return { name: c.name, gapMs: gap, bestLapId: bestEver[k].lapId, typical, best, notes: styleNotes(typical, best).map(({ key, text }) => ({ key, text })) };
    }).filter(Boolean);
    // the habits that come back in most corners (counted per metric)
    const count = new Map();
    for (const r of rows) for (const n of r.notes) count.set(n.key, (count.get(n.key) || 0) + 1);
    style = { sufficient: true, laps: sess.length, corners: rows,
      habits: [...count.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).map(([key, n]) => ({ key, corners: n })) };
  }

  // ---- theoretical best of the session: the session's best pass of every corner put together
  const theo = sess.length && corners.length ? corners.reduce((a, _, k) => a + Math.min(...sess.map((l) => lapTimes.get(l.id).t[k])), 0) : null;

  // ---- consistency
  const worst = cornerRows.filter((c) => c.sdMs != null).sort((a, b) => b.sdMs - a.sdMs)[0] || null;
  const consistency = { sdMs: S.sdMs, cleanLaps: S.clean.length, score: scoreOfStats(S),
    worstCorner: worst ? { name: worst.name, sdMs: worst.sdMs } : null };

  const limits = trackLimits(laps, ref, corners);
  let conditions = null; try { conditions = session.conditions ? JSON.parse(session.conditions) : null; } catch { /* none */ }

  const report = {
    version: VERSION, sessionId, combo, sessionType: session.session_type, driver: session.driver, startedAt: session.started_at, endedAt: endAt,
    laps: { total: laps.length, valid: S.valid.length, invalid: laps.length - S.valid.length, clean: S.clean.length },
    best: { ms: S.best.lap_time_ms, lapId: S.best.id, lapNumber: S.best.lap_number },
    average: { cleanMs: S.avgMs, medianMs: S.medianMs, validMs: S.validAvgMs },
    improvement: {
      prev: P?.best ? { sessionId: prevSessionId, startedAt: prevLaps[0].recorded_at, bestMs: P.best.lap_time_ms, avgMs: P.avgMs, sdMs: P.sdMs } : null,
      bestDeltaMs: P?.best ? S.best.lap_time_ms - P.best.lap_time_ms : null,
      avgDeltaMs: P?.avgMs != null && S.avgMs != null ? S.avgMs - P.avgMs : null,
      sdDeltaMs: P?.sdMs != null && S.sdMs != null ? S.sdMs - P.sdMs : null,
      allTimeBeforeMs: allTimeBefore, pbDeltaMs: allTimeBefore != null ? S.best.lap_time_ms - allTimeBefore : null,
      newPb: allTimeBefore != null && S.best.lap_time_ms < allTimeBefore, firstSession: !before.length,
    },
    theoretical: theo != null ? { ms: r0(theo), gapMs: r0(S.best.lap_time_ms - theo) } : null,
    consistency,
    corners: { source: info.cornersSource, all: cornerRows, best: bestCorners, weakest },
    style,
    setups: setupSegments(laps),
    conditions,
    trackLimits: limits,
    trend: laps.map((l) => ({ id: l.id, n: l.lap_number, ms: l.lap_time_ms, valid: !!l.valid, setup: l.setup_name ?? null })),
  };

  // ---- next practice targets (each with a number the next report can check)
  const targets = [];
  const lapTarget = report.theoretical && report.theoretical.ms < S.best.lap_time_ms - 20 ? report.theoretical.ms : S.best.lap_time_ms - 100;
  targets.push({ kind: 'lap', ms: r0(lapTarget), text: `Lap time ${fmt(lapTarget)} or faster${report.theoretical && lapTarget === report.theoretical.ms ? " (today's theoretical best: your best corners of this session put together)" : ''}` });
  for (const w of weakest.slice(0, 2)) {
    const c = cornerRows.find((x) => x.name === w.name);
    const ms = r0(c.medianMs - c.gapMs / 2);
    targets.push({ kind: 'corner', corner: w.name, ms, text: `${w.name}: ${w.target || 'match your best pass'} (typical ${secs(c.medianMs, 3)} → ${secs(ms, 3)})` });
  }
  if (S.sdMs != null && S.sdMs <= 100) {
    targets.push({ kind: 'consistency', sdMs: 100, text: `Consistency: keep your clean laps within ±${secs(100)} (today ±${secs(S.sdMs)})` });
  } else if (S.sdMs != null) {
    const want = Math.max(100, Math.round((S.sdMs * 0.75) / 10) * 10);
    targets.push({ kind: 'consistency', sdMs: want, text: `Consistency: clean laps within ±${secs(want)} (today ±${secs(S.sdMs)})` });
  } else targets.push({ kind: 'consistency', sdMs: 400, text: 'Consistency: drive at least 3 clean laps in a row within ±0.40 s' });
  const hot = limits.byCorner[0];
  if (hot && hot.n >= 2) targets.push({ kind: 'limits', corner: hot.name, text: `Track limits: no invalid lap at ${hot.name} (${hot.n} today)` });
  report.targets = targets;

  // ---- the previous report's targets, checked against this session
  report.prevTargets = null;
  if (withPrevTargets && prevSessionId != null) {
    let prev = db.getReport(prevSessionId)?.data;
    if (!prev) { try { prev = build(prevSessionId, { withPrevTargets: false }); } catch { prev = null; } }
    if (prev?.targets?.length) report.prevTargets = { sessionId: prevSessionId, items: checkTargets(prev.targets, report) };
  }
  return report;
}

/** Build and store. -> report */
export function make(sessionId) {
  const r = build(sessionId);
  db.saveReport(sessionId, r);
  return r;
}

/** A short plain summary (notification text). */
export function headline(r) {
  const imp = r.improvement;
  const parts = [`Best ${fmt(r.best.ms)}`];
  if (r.average.cleanMs) parts.push(`avg ${fmt(r.average.cleanMs)}`);
  if (imp.newPb) parts.push(`new PB (${secs(imp.pbDeltaMs, 3)})`);
  else if (imp.bestDeltaMs != null) parts.push(`${imp.bestDeltaMs <= 0 ? '' : '+'}${secs(imp.bestDeltaMs, 3)} vs last session`);
  return parts.join(' · ');
}
