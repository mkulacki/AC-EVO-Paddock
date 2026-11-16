// Car & setup report for a session: what the car did, from the 10 Hz car data saved with each lap (data.car, see
// src/recorder.js): tyre temperatures across the tread and pressures, brakes and lock-ups, suspension travel and ride
// height, balance (front vs rear slip angle) per corner phase, and wheelspin. Ends with setup suggestions, also given
// to the AI engineer (src/server.js setupTelemetry).
//
// The rules are the usual race-engineering rules of thumb. Thresholds are deliberately wide: a suggestion is a hint
// of where to look, not a verdict. Values the game gives as a position in its optimal window (nP, nC, nB) are used
// carefully: their meaning has not been checked in game yet.
import * as db from './db.js';
import * as svc from './service.js';

const WHEELS = ['FL', 'FR', 'RL', 'RR'];
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const r1 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
const r2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const r3 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 1000) / 1000);
const MIN_SPEED = 30; // km/h: below this (pit exit, spins) the car data says little

export function build(sessionId) {
  const metas = db.lapsOfSession(sessionId);
  const laps = metas.map((m) => ({ meta: m, data: db.getLap(m.id)?.data })).filter((l) => l.data?.car?.k?.length > 10);
  if (!laps.length) return { sessionId, available: false, laps: metas.length };
  const combo = { track: laps[0].meta.track, layout: laps[0].meta.layout, car: laps[0].meta.car };

  // corners of this car and track (same names as everywhere else), as distances
  let corners = [];
  try {
    const info = svc.comboInfo(combo);
    const R = svc.getResampled(info.best?.id ?? laps[0].meta.id)?.R;
    if (R) corners = info.corners.map((c) => ({ name: c.name, start: R.d[c.a], apex: R.d[c.apexIdx], end: R.d[c.b] }));
  } catch { /* no corners: per-corner parts are left out */ }
  const cornerAt = (d) => corners.find((c) => d >= c.start - 15 && d <= c.end + 15) || null;
  const phaseAt = (c, d) => {
    if (d < c.apex - 0.2 * (c.apex - c.start)) return 'entry';
    if (d > c.apex + 0.25 * (c.end - c.apex)) return 'exit';
    return 'mid';
  };

  // warm-up: with 3 laps or more, the first lap is left out of the temperatures and pressures
  const hot = laps.length >= 3 ? laps.slice(1) : laps;
  const S = (l) => { // the samples of a lap with what the main channels say at that moment
    const c = l.data.car, D = l.data;
    return c.k.map((k, j) => ({ j, d: D.d[k], spd: D.spd[k], thr: D.thr[k], brk: D.brk[k], glat: D.glat?.[k] ?? 0 }));
  };

  // ---- what the game gives (an all-zero channel means the game does not fill it)
  const any = (f) => laps.some((l) => l.data.car.w.some((w) => f(w).some((v) => v !== 0)));
  const has = {
    tyres: any((w) => w.m), pressures: any((w) => w.p), brakes: any((w) => w.b), susp: any((w) => w.s), slip: any((w) => w.a),
    window: any((w) => w.nC) || any((w) => w.nP), rideHeight: laps.some((l) => l.data.car.rh0.some((v) => v !== 0 && Math.abs(v) < 1e8)),
  };

  // ---- tyres: temperatures across the tread, core, pressure (hot laps, at speed)
  const tyres = WHEELS.map((name, w) => {
    const v = { i: [], m: [], o: [], c: [], p: [], nP: [], nC: [] };
    for (const l of hot) {
      const W = l.data.car.w[w];
      for (const s of S(l)) if (s.spd > MIN_SPEED) for (const k of Object.keys(v)) v[k].push(W[k][s.j]);
    }
    const t = Object.fromEntries(Object.entries(v).map(([k, a]) => [k, mean(a)]));
    return { wheel: name, inner: r1(t.i), middle: r1(t.m), outer: r1(t.o), core: r1(t.c), pressure: r2(t.p), pressureMax: r2(Math.max(...v.p)),
      spread: r1(t.i - t.o), crown: r1(t.m - (t.i + t.o) / 2), windowPressure: r3(t.nP), windowCore: r3(t.nC) };
  });

  // ---- brakes: peak temperature per lap, lock-ups and where
  const lockList = [];
  const brakes = WHEELS.map((name, w) => {
    const peaks = [], nPeaks = [];
    let locks = 0;
    for (const l of laps) {
      const W = l.data.car.w[w];
      peaks.push(Math.max(...W.b)); nPeaks.push(Math.max(...W.nB));
      let was = 0;
      for (const s of S(l)) {
        const on = W.l[s.j];
        if (on && !was && s.spd > MIN_SPEED) { locks++; lockList.push({ wheel: name, lap: l.meta.lap_number, corner: cornerAt(s.d)?.name ?? null, d: Math.round(s.d) }); }
        was = on;
      }
    }
    return { wheel: name, peak: r1(mean(peaks)), windowPeak: r3(mean(nPeaks)), locks };
  });

  // ---- suspension: travel range and how often it reaches the end of its travel; ride height
  const susp = WHEELS.map((name, w) => {
    const all = laps.flatMap((l) => l.data.car.w[w].s);
    const max = Math.max(...all), min = Math.min(...all);
    // reaching the end: within 1 mm of the session's maximum, counted once per visit
    const hits = [];
    if (max - min > 5) for (const l of laps) {
      let was = false;
      for (const s of S(l)) {
        const on = l.data.car.w[w].s[s.j] >= max - 1;
        if (on && !was) hits.push({ lap: l.meta.lap_number, corner: cornerAt(s.d)?.name ?? null, braking: s.brk > 0.3, d: Math.round(s.d) });
        was = on;
      }
    }
    return { wheel: name, max: r1(max), min: r1(min), range: r1(max - min), hitsPerLap: r1(hits.length / laps.length), hits };
  });
  const rh = has.rideHeight ? ['rh0', 'rh1'].map((k) => r1(Math.min(...laps.flatMap((l) => l.data.car[k].filter((v) => Math.abs(v) < 1e8))))) : null;

  // ---- balance: front vs rear slip angle while cornering, per corner phase. + = understeer, − = oversteer
  const phases = { entry: [], mid: [], exit: [] };
  const byCorner = new Map();
  const spin = []; // wheelspin: rear slip ratio on throttle
  let exitSamples = 0;
  for (const l of laps) {
    const W = l.data.car.w;
    for (const s of S(l)) {
      const c = cornerAt(s.d);
      if (!c || s.spd < MIN_SPEED) continue;
      const ph = phaseAt(c, s.d);
      if (has.slip && Math.abs(s.glat) > 0.4) {
        const f = (Math.abs(W[0].a[s.j]) + Math.abs(W[1].a[s.j])) / 2, rr = (Math.abs(W[2].a[s.j]) + Math.abs(W[3].a[s.j])) / 2;
        if (f + rr > 1e-6) {
          const b = (f - rr) / (f + rr);
          phases[ph].push(b);
          const key = `${c.name}|${ph}`;
          if (!byCorner.has(key)) byCorner.set(key, []);
          byCorner.get(key).push(b);
        }
      }
      if (ph === 'exit' && s.thr > 0.5) {
        exitSamples++;
        const sr = Math.max(Math.abs(W[2].r[s.j]), Math.abs(W[3].r[s.j]));
        if (sr > 0.1) spin.push({ corner: c.name, lap: l.meta.lap_number });
      }
    }
  }
  const balTxt = (b) => (b == null ? null : b > 0.18 ? 'strong understeer' : b > 0.08 ? 'understeer' : b < -0.18 ? 'strong oversteer' : b < -0.08 ? 'oversteer' : 'neutral');
  const balance = has.slip ? Object.fromEntries(Object.entries(phases).map(([ph, a]) => {
    const b = mean(a);
    const worst = [...byCorner.entries()].filter(([k, v]) => k.endsWith(`|${ph}`) && v.length >= 3).map(([k, v]) => ({ corner: k.split('|')[0], b: mean(v) }))
      .filter((x) => Math.sign(x.b) === Math.sign(b) && Math.abs(x.b) > 0.08).sort((x, y) => Math.abs(y.b) - Math.abs(x.b)).slice(0, 3);
    return [ph, { value: r3(b), label: balTxt(b), samples: a.length, corners: worst.map((x) => x.corner) }];
  })) : null;
  const spinBy = new Map();
  for (const s of spin) spinBy.set(s.corner, (spinBy.get(s.corner) || 0) + 1);
  const traction = exitSamples ? { share: r3(spin.length / exitSamples), corners: [...spinBy.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c]) => c) } : null;

  // ---- per lap: how the tyres came in
  const perLap = laps.map((l) => {
    const W = l.data.car.w;
    const at = S(l).filter((s) => s.spd > MIN_SPEED).map((s) => s.j);
    const avg = (w, k) => r1(mean(at.map((j) => W[w][k][j])));
    return { id: l.meta.id, lap: l.meta.lap_number, timeMs: l.meta.lap_time_ms, valid: !!l.meta.valid,
      core: [0, 1, 2, 3].map((w) => avg(w, 'c')), pressure: [0, 1, 2, 3].map((w) => r2(mean(at.map((j) => W[w].p[j])))),
      brakePeak: [0, 1, 2, 3].map((w) => r1(Math.max(...W[w].b))) };
  });

  const report = { sessionId, available: true, combo, laps: laps.length, warmupSkipped: hot.length < laps.length, has, tyres, brakes, locks: lockList,
    suspension: susp.map(({ hits, ...s }) => ({ ...s, hitCorners: topCorners(hits), hitsBraking: hits.filter((h) => h.braking).length })), rideHeightMin: rh,
    balance, traction, perLap };
  report.suggestions = suggest(report);
  return report;
}

function topCorners(list) {
  const m = new Map();
  for (const x of list) if (x.corner) m.set(x.corner, (m.get(x.corner) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c]) => c);
}

// ---- setup suggestions: {area, level 1..3, text, why}
function suggest(r) {
  const out = [];
  const add = (area, level, text, why) => out.push({ area, level, text, why });
  const axle = (a) => (a === 0 ? 'front' : 'rear');
  const pair = (arr, a) => arr.slice(a * 2, a * 2 + 2);
  const list = (a) => (a.length ? ` (${a.join(', ')})` : '');

  if (r.has.tyres) for (const a of [0, 1]) {
    const [L, R] = pair(r.tyres, a);
    const spread = mean([L.spread, R.spread]), crown = mean([L.crown, R.crown]);
    if (spread < -1) add('Tyres', 2, `More negative camber on the ${axle(a)}`, `The outer edge of the ${axle(a)} tyres runs hotter than the inner edge (${fmtC(spread)} inner − outer): the tyre is not leaning into the corner enough.`);
    else if (spread > 12) add('Tyres', 2, `Less negative camber on the ${axle(a)}`, `The inner edge of the ${axle(a)} tyres runs ${fmtC(spread)} hotter than the outer edge: too much camber wears and overheats the inside.`);
    if (r.has.pressures) {
      if (crown > 4) add('Tyres', 2, `Lower the ${axle(a)} tyre pressures a little (about 0.5 psi)`, `The middle of the ${axle(a)} tread is ${fmtC(crown)} hotter than its edges: the tyres are over-inflated and the contact patch is narrow.`);
      else if (crown < -4) add('Tyres', 2, `Raise the ${axle(a)} tyre pressures a little (about 0.5 psi)`, `The edges of the ${axle(a)} tread are ${fmtC(-crown)} hotter than the middle: the tyres are under-inflated.`);
    }
  }
  if (r.has.window) for (const a of [0, 1]) {
    const [L, R] = pair(r.tyres, a);
    const p = mean([L.windowPressure, R.windowPressure].filter((v) => v != null)), c = mean([L.windowCore, R.windowCore].filter((v) => v != null));
    if (p != null && p > 0 && p < 0.7) add('Tyres', 1, `${cap(axle(a))} hot pressures look low for the game's target`, `The game puts the ${axle(a)} pressures at ${pct(p)} of its target window (to be confirmed in game).`);
    if (c != null && c > 0 && c < 0.7) add('Tyres', 1, `${cap(axle(a))} tyres run cold`, `The game puts the ${axle(a)} core temperature at ${pct(c)} of its optimal window (to be confirmed in game). Higher pressure or more camber warms them.`);
    if (c != null && c > 1.3) add('Tyres', 1, `${cap(axle(a))} tyres run hot`, `The game puts the ${axle(a)} core temperature at ${pct(c)} of its optimal window (to be confirmed in game).`);
  }
  if (r.has.tyres) {
    const f = mean([r.tyres[0].core, r.tyres[1].core]), b = mean([r.tyres[2].core, r.tyres[3].core]);
    if (f != null && b != null && Math.abs(f - b) > 10) add('Tyres', 1, `The ${f > b ? 'front' : 'rear'} tyres work much harder than the ${f > b ? 'rear' : 'front'}`, `Core temperatures: front ${fmtT(f)}, rear ${fmtT(b)}. ${f > b ? 'Typical of understeer: the fronts slide.' : 'Typical of oversteer or wheelspin: the rears slide.'}`);
  }

  // brakes
  const fl = r.brakes[0].locks + r.brakes[1].locks, rl = r.brakes[2].locks + r.brakes[3].locks;
  const lockCorners = topCorners(r.locks);
  if (fl >= 3 && fl >= 2 * rl) add('Brakes', 2, 'Move the brake bias 1–2 % to the rear', `The fronts locked ${fl} times${list(lockCorners)}, the rears ${rl}. If it is only one corner, brake a touch softer there first.`);
  else if (rl >= 3 && rl >= 2 * fl) add('Brakes', 3, 'Move the brake bias 1–2 % to the front', `The rears locked ${rl} times${list(lockCorners)}: rear lock-ups spin the car.`);
  if (r.has.brakes) for (const a of [0, 1]) {
    const [L, R] = pair(r.brakes, a);
    const n = mean([L.windowPeak, R.windowPeak].filter((v) => v != null && v > 0));
    if (n != null && n > 1.15) add('Brakes', 1, `Open the ${axle(a)} brake ducts`, `The ${axle(a)} brakes peak at ${pct(n)} of their window (to be confirmed in game): hot brakes fade.`);
    else if (n != null && n < 0.45) add('Brakes', 1, `Close the ${axle(a)} brake ducts a little`, `The ${axle(a)} brakes peak at only ${pct(n)} of their window (to be confirmed in game): cold brakes bite less.`);
  }

  // suspension
  if (r.has.susp) for (const a of [0, 1]) {
    const [L, R] = pair(r.suspension, a);
    const hits = mean([L.hitsPerLap, R.hitsPerLap]);
    if (hits >= 3) {
      const braking = L.hitsBraking + R.hitsBraking > (L.hitsPerLap + R.hitsPerLap) * r.laps * 0.5;
      add('Suspension', 2, `The ${axle(a)} suspension reaches the end of its travel ${Math.round(hits)} times a lap: stiffer ${axle(a)} springs or bump stops, or a little more ${axle(a)} ride height`,
        `Mostly ${braking ? 'under braking' : 'in corners or over kerbs'}${list([...new Set([...L.hitCorners, ...R.hitCorners])].slice(0, 3))}. On the bump stop the spring rate jumps and the tyre loses grip.`);
    }
  }
  if (r.rideHeightMin) r.rideHeightMin.forEach((h, a) => {
    if (h != null && h < 5) add('Suspension', 2, `Raise the ${axle(a)} ride height a little`, `The ${axle(a)} ride height dropped to ${h} mm: the car may be bottoming out.`);
  });

  // balance
  const B = r.balance;
  if (B) {
    const tips = {
      'entry+': ['Soften the front anti-roll bar, or move the brake bias slightly to the rear', 'The car pushes when you turn in on the brakes.'],
      'mid+': ['Soften the front anti-roll bar or stiffen the rear one (more front wing if the car has it)', 'The car pushes in the middle of corners: the fronts slide more than the rears.'],
      'exit+': ['Soften the front, or lower the differential power lock', 'The car pushes wide on the throttle out of corners.'],
      'entry-': ['Move the brake bias slightly forward, or raise the differential coast lock', 'The rear steps out when you turn in.'],
      'mid-': ['Stiffen the front anti-roll bar or soften the rear one (more rear wing if the car has it)', 'The rears slide more than the fronts in the middle of corners.'],
      'exit-': ['Soften the rear anti-roll bar or springs, more traction control, or a lower differential power lock', 'The rear steps out on the throttle.'],
    };
    for (const ph of ['entry', 'mid', 'exit']) {
      const p = B[ph];
      if (!p || p.value == null || Math.abs(p.value) <= 0.08 || p.samples < 20) continue;
      const [text, why] = tips[`${ph}${p.value > 0 ? '+' : '-'}`];
      add('Balance', Math.abs(p.value) > 0.18 ? 3 : 2, `${cap(ph === 'mid' ? 'mid-corner' : ph)} ${p.value > 0 ? 'understeer' : 'oversteer'}: ${text.charAt(0).toLowerCase()}${text.slice(1)}`, `${why}${list(p.corners)}`);
    }
  }
  if (r.traction && r.traction.share > 0.15) add('Traction', 2, 'Wheelspin out of slow corners: softer rear, more traction control or a lower differential power lock (and a smoother throttle)',
    `The rear wheels spun on ${pct(r.traction.share)} of the throttle samples on corner exits${list(r.traction.corners)}.`);
  return out.sort((a, b) => b.level - a.level);
}
const fmtC = (v) => `${Math.round(v * 10) / 10} °C`;
const fmtT = (v) => `${Math.round(v)} °C`;
const pct = (v) => `${Math.round(v * 100)} %`;
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** The compact version the AI engineer gets */
export function forAi(r) {
  if (!r?.available) return null;
  return {
    laps_with_car_data: r.laps,
    tyres: r.has.tyres ? r.tyres.map((t) => ({ wheel: t.wheel, inner_c: t.inner, middle_c: t.middle, outer_c: t.outer, core_c: t.core, hot_pressure_psi: t.pressure })) : 'not available',
    brakes: r.brakes.map((b) => ({ wheel: b.wheel, peak_c: b.peak, lock_ups: b.locks })),
    suspension: r.has.susp ? r.suspension.map((s) => ({ wheel: s.wheel, travel_mm: [s.min, s.max], end_of_travel_hits_per_lap: s.hitsPerLap, where: s.hitCorners })) : 'not available',
    min_ride_height_mm: r.rideHeightMin ? { front: r.rideHeightMin[0], rear: r.rideHeightMin[1] } : undefined,
    balance_front_vs_rear_slip: r.balance ? Object.fromEntries(Object.entries(r.balance).map(([k, v]) => [k, { value: v.value, label: v.label, corners: v.corners }])) : 'not available',
    wheelspin_share_on_exits: r.traction?.share,
    rule_based_hints: r.suggestions.map((s) => s.text),
  };
}
