// Cars tab: what you did with each car, from your own saved laps.
// Distance and time come from the lap list; top speed and driving style come from each lap's telemetry, worked out
// once per lap and kept in the lap_stats table (a lap's samples never change, deleted laps drop out by the join).
import * as db from './db.js';
import * as cars from './cars.js';
import * as trackdata from './trackdata.js';
import * as setups from './setups.js';

const STATS_VERSION = 1;

// ---------------------------------------------------------------- one lap's numbers from its telemetry
/** {topKmh, thrAvg, fullThr, brake, coast, shiftsPerKm, offPct} of a lap's samples (time-weighted), or null. */
export function lapNumbers(data) {
  const t = data?.t, n = t?.length || 0;
  if (n < 20 || !data.spd) return null;
  let top = 0, T = 0, thr = 0, full = 0, brk = 0, coast = 0, off = 0, shifts = 0;
  for (let i = 1; i < n; i++) {
    const dt = Math.max(0, Math.min(500, t[i] - t[i - 1])); // a gap in the samples counts at most half a second
    const s = data.spd[i] || 0;
    if (s > top) top = s;
    T += dt;
    const th = data.thr?.[i] || 0, br = data.brk?.[i] || 0;
    thr += th * dt;
    if (th >= 0.98) full += dt;
    if (br > 0.05) brk += dt;
    else if (th < 0.05 && s > 10) coast += dt;
    if ((data.out?.[i] || 0) > 0) off += dt;
    if (data.gear && data.gear[i] !== data.gear[i - 1] && s > 5) shifts++;
  }
  if (!T) return null;
  const km = data.d ? Math.max(0.1, (data.d[n - 1] - data.d[0]) / 1000) : null;
  const pct = (x) => Math.round((1000 * x) / T) / 10;
  return { topKmh: Math.round(top * 10) / 10, thrAvg: pct(thr), fullThr: pct(full), brake: pct(brk), coast: pct(coast), offPct: pct(off),
    shiftsPerKm: km ? Math.round((10 * shifts) / km) / 10 : null };
}

// lap_stats: {lap_id, v, data(JSON)}; filled on demand for the laps of the car being looked at
let ready = false;
function table() {
  if (ready) return;
  db.raw.exec('CREATE TABLE IF NOT EXISTS lap_stats (lap_id INTEGER PRIMARY KEY, v INTEGER, data TEXT)');
  ready = true;
}
function statsOf(lapIds) {
  table();
  const out = new Map();
  if (!lapIds.length) return out;
  const get = db.raw.prepare('SELECT lap_id, v, data FROM lap_stats WHERE lap_id = ?');
  const put = db.raw.prepare('INSERT OR REPLACE INTO lap_stats (lap_id, v, data) VALUES (?, ?, ?)');
  for (const id of lapIds) {
    const r = get.get(id);
    if (r && r.v === STATS_VERSION) { out.set(id, r.data ? JSON.parse(r.data) : null); continue; }
    let s = null;
    try { s = lapNumbers(db.getLap(id)?.data); } catch { /* unreadable lap: no numbers */ }
    put.run(id, STATS_VERSION, s ? JSON.stringify(s) : null);
    out.set(id, s);
  }
  return out;
}

// ---------------------------------------------------------------- per car
const KM = (m) => Math.round(m / 100) / 10;
const p2 = (n) => String(n).padStart(2, '0');
const day = (t) => { const d = new Date(t); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; };
// fun comparisons for the distance driven
const TRIPS = [
  [5, 'a parkrun'], [42.2, 'a marathon'], [100, 'Monaco to Sanremo and back'], [344, 'London to Paris'],
  [930, 'Monza to the Nürburgring'], [1600, 'Le Mans to Monza and back'], [2800, 'Lisbon to Berlin'], [4000, 'across Europe'],
  [6400, 'New York to Los Angeles and back'], [40075, 'once around the Earth'],
];
const MILESTONES = [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

/** Every car you drove, with totals: [{carId|null, name, laps, validLaps, km, ms, sessions, firstAt, lastAt, tracks, bestLaps}] */
function driven() {
  const by = new Map();
  for (const l of db.listLaps()) {
    if (l.source && l.source !== 'local') continue; // imported reference laps are not your driving
    const k = l.car;
    let e = by.get(k);
    if (!e) { e = { name: l.car, laps: 0, validLaps: 0, m: 0, ms: 0, sessions: new Set(), days: new Set(), firstAt: Infinity, lastAt: 0, combos: new Map(), lapIds: [] }; by.set(k, e); }
    e.laps++; if (l.valid) e.validLaps++;
    e.m += l.track_length || 0; e.ms += l.lap_time_ms || 0;
    if (l.session_id) e.sessions.add(l.session_id);
    e.days.add(day(l.recorded_at));
    e.firstAt = Math.min(e.firstAt, l.recorded_at); e.lastAt = Math.max(e.lastAt, l.recorded_at);
    const ck = `${l.track}|${l.layout}`;
    const c = e.combos.get(ck) || { track: l.track, layout: l.layout, laps: 0, validLaps: 0, m: 0, best: null, pbs: 0, lastAt: 0 };
    c.laps++; c.m += l.track_length || 0; c.lastAt = Math.max(c.lastAt, l.recorded_at);
    if (l.valid) c.validLaps++;
    e.combos.set(ck, c);
    e.lapIds.push(l);
  }
  // personal bests set over time (laps in recorded order: each lap faster than all before it on that track)
  for (const e of by.values()) {
    for (const l of [...e.lapIds].sort((a, b) => a.recorded_at - b.recorded_at)) {
      if (!l.valid || !l.lap_time_ms) continue;
      const c = e.combos.get(`${l.track}|${l.layout}`);
      if (!c.best || l.lap_time_ms < c.best.lap_time_ms) { if (c.best) c.pbs++; c.best = l; }
    }
  }
  return by;
}

function summary(e, match) {
  const car = match(e.name);
  const combos = [...e.combos.values()];
  const fav = [...combos].sort((a, b) => b.laps - a.laps)[0];
  return { carId: car?.id ?? null, name: e.name, laps: e.laps, validLaps: e.validLaps, km: KM(e.m), drivingMs: e.ms, sessions: e.sessions.size, days: e.days.size,
    firstAt: e.firstAt, lastAt: e.lastAt, tracks: combos.length, pbs: combos.reduce((s, c) => s + c.pbs, 0), favourite: fav ? { track: fav.track, layout: fav.layout, laps: fav.laps } : null };
}

/** The Cars tab list: every car in the game, and what you did with it. -> {cars: [catalogue car + mine], unknown: [driven cars not in the game list]} */
export function overview() {
  const by = driven();
  const mine = new Map(), unknown = [];
  for (const e of by.values()) {
    const s = summary(e, (n) => cars.match(n));
    if (!s.carId) { unknown.push(s); continue; }
    const prev = mine.get(s.carId); // two recorded names for one car (e.g. a renamed variant): add them up
    mine.set(s.carId, prev ? merge(prev, s) : s);
  }
  const ranked = [...mine.values()].sort((a, b) => b.km - a.km);
  ranked.forEach((s, i) => { s.rank = i + 1; });
  return { cars: cars.catalog().map((c) => ({ ...c, mine: mine.get(c.id) || null })), unknown, drivenCount: ranked.length };
}
const merge = (a, b) => ({ ...a, laps: a.laps + b.laps, validLaps: a.validLaps + b.validLaps, km: Math.round((a.km + b.km) * 10) / 10, drivingMs: a.drivingMs + b.drivingMs,
  sessions: a.sessions + b.sessions, days: Math.max(a.days, b.days), firstAt: Math.min(a.firstAt, b.firstAt), lastAt: Math.max(a.lastAt, b.lastAt),
  tracks: a.tracks + b.tracks, pbs: a.pbs + b.pbs, favourite: (a.favourite?.laps || 0) >= (b.favourite?.laps || 0) ? a.favourite : b.favourite });

/** One car: the catalogue entry, totals, records per track, driving style, milestones and fun facts. */
export function detail(carId) {
  const car = cars.byId(carId);
  if (!car) throw Object.assign(new Error('Car not found'), { status: 404 });
  const by = driven();
  const entries = [...by.values()].filter((e) => cars.match(e.name)?.id === carId);
  const ov = overview(); // for the garage rank
  const mineSum = ov.cars.find((c) => c.id === carId)?.mine || null;
  const setupCount = (() => { try { return setups.list(carId).length; } catch { return 0; } })();
  if (!entries.length) return { car, mine: null, setups: setupCount, drivenCars: ov.drivenCount };

  // records per track and layout
  const combos = new Map();
  for (const e of entries) for (const c of e.combos.values()) {
    const k = `${c.track}|${c.layout}`, prev = combos.get(k);
    if (!prev) { combos.set(k, { ...c }); continue; }
    prev.laps += c.laps; prev.validLaps += c.validLaps; prev.m += c.m; prev.pbs += c.pbs; prev.lastAt = Math.max(prev.lastAt, c.lastAt);
    if (c.best && (!prev.best || c.best.lap_time_ms < prev.best.lap_time_ms)) prev.best = c.best;
  }
  const records = [...combos.values()].map((c) => {
    const h = (() => { try { return trackdata.find(c.track, c.layout); } catch { return null; } })();
    return { track: c.track, layout: c.layout, trackId: h?.track.id ?? null, layoutKey: h?.layout.key ?? null, laps: c.laps, validLaps: c.validLaps, km: KM(c.m),
      bestMs: c.best?.lap_time_ms ?? null, bestLapId: c.best?.id ?? null, bestAt: c.best?.recorded_at ?? null, pbs: c.pbs, lastAt: c.lastAt };
  }).sort((a, b) => b.laps - a.laps);

  // telemetry numbers: every lap with this car (worked out once, then kept)
  const laps = entries.flatMap((e) => e.lapIds);
  const st = statsOf(laps.map((l) => l.id));
  let top = null; const avg = { thrAvg: [], fullThr: [], brake: [], coast: [], offPct: [], shiftsPerKm: [] };
  for (const l of laps) {
    const s = st.get(l.id); if (!s) continue;
    if (!top || s.topKmh > top.kmh) top = { kmh: s.topKmh, lapId: l.id, track: l.track, layout: l.layout, at: l.recorded_at };
    if (l.valid) for (const k of Object.keys(avg)) if (s[k] != null) avg[k].push(s[k]);
  }
  const mean = (a) => (a.length ? Math.round((10 * a.reduce((x, y) => x + y, 0)) / a.length) / 10 : null);
  const style = Object.fromEntries(Object.entries(avg).map(([k, a]) => [k, mean(a)]));
  style.laps = avg.thrAvg.length;

  // the busiest day and the longest session
  const perDay = new Map(), perSession = new Map();
  for (const l of laps) {
    const dk = day(l.recorded_at); perDay.set(dk, (perDay.get(dk) || 0) + (l.track_length || 0));
    if (l.session_id) { const s = perSession.get(l.session_id) || { laps: 0, ms: 0, at: l.recorded_at }; s.laps++; s.ms += l.lap_time_ms || 0; perSession.set(l.session_id, s); }
  }
  const busiest = [...perDay].sort((a, b) => b[1] - a[1])[0];
  const longest = [...perSession.values()].sort((a, b) => b.laps - a.laps)[0] || null;

  const km = mineSum.km;
  const milestones = MILESTONES.map((m) => ({ km: m, done: km >= m }));
  const trip = [...TRIPS].reverse().find(([d]) => km >= d) || null;
  const nextTrip = TRIPS.find(([d]) => km < d) || null;

  return {
    car, setups: setupCount, drivenCars: ov.drivenCount,
    mine: {
      ...mineSum, cleanPct: mineSum.laps ? Math.round((1000 * mineSum.validLaps) / mineSum.laps) / 10 : null,
      topSpeed: top, style, records,
      busiestDay: busiest ? { day: busiest[0], km: KM(busiest[1]) } : null,
      longestSession: longest,
      milestones, trip: trip ? { km: trip[0], label: trip[1], times: Math.floor(km / trip[0]) } : null,
      nextTrip: nextTrip ? { km: nextTrip[0], label: nextTrip[1], left: Math.round((nextTrip[0] - km) * 10) / 10 } : null,
    },
  };
}
