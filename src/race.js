// Race tab: session setups, presets, saved servers, and the launch orders the Paddock HUD carries out
// in game on the Solo / multiplayer screens.
//
// How a Solo session is set up was read from the game's own UI code (uiresources\js\components.js in
// content.kspkg, game 0.9.1) and checked in game. The Solo screen sends "GameModeSelectionClient" requests:
//   SetGameType {mode, type}            session type; then GameModeParameters returns its sessions
//   TrackList {mode}                    the tracks of the current session type (TrackItem[])
//   SetTrack {mode, track_item}         one of those items
//   SetGameModeParameters {mode, sessions}   durations, start times, AI ...
//   SetWeather {weather_data}           one of the presets in GameModeParameters.weather_data
//   Start
// Session types the game accepts: PRACTICE (1 session), HOTLAP (1 session, not shown in the game's own
// menu but answered OK), INSTANT_RACE (1 race session) and RACE_WEEKEND (practice, qualifying, warm-up,
// race). An order is a list of steps (see mod/trainerhud/trainerhud.js, STEP); the values and limits
// below are the ones of the game's own sliders.
//
// The HUD also sends back what it reads ("[TrainerHUD-cat] {scan, part, i, n, d}" log lines, reassembled
// here into data/game-catalogue.json): `cars` (which cars the AI can drive), `tracks:<GameModeType>` (the
// game's track list per session type, with the largest grid), `applied` (the settings the game took).
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './db.js';
import * as trackdata from './trackdata.js';
import * as svc from './service.js';
import * as carsDb from './cars.js';

const FILE = path.join(DATA_DIR, 'race.json');
const SCAN_FILE = path.join(DATA_DIR, 'game-catalogue.json');
const APPLIED_FILE = path.join(DATA_DIR, 'game-applied.json');
const MAX_ORDER_BYTES = 11000; // the order rides inside a 16 KB live slot next to the HUD data

const readJson = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; } };
let store = { presets: [], servers: [], last: null, ...readJson(FILE, {}) };
let scan = readJson(SCAN_FILE, null); // { at, parts: { name: value } }
if (scan && !scan.parts) scan = null;
let derived = null;
const saveStore = () => fs.writeFileSync(FILE, JSON.stringify(store, null, 2));
let scanSaveT = null;
const saveScan = () => { clearTimeout(scanSaveT); scanSaveT = setTimeout(() => fs.writeFileSync(SCAN_FILE, JSON.stringify(scan)), 500); };

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const clamp = (v, lo, hi, dflt) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : dflt; };

// ---------------------------------------------------------------- what the game offers
export const MODEL = {
  modes: [
    { id: 'practice', label: 'Practice', type: 'GameModeType_PRACTICE', hint: 'Free running, alone on track', practice: true },
    { id: 'hotlap', label: 'Hotlap', type: 'GameModeType_HOTLAP', hint: 'Flying laps against the clock' },
    { id: 'race', label: 'Quick race', type: 'GameModeType_INSTANT_RACE', hint: 'One race against the AI', race: true, ai: true, startPos: true },
    { id: 'weekend', label: 'Race weekend', type: 'GameModeType_RACE_WEEKEND', hint: 'Practice, qualifying, warm-up, race', practice: true, qualifying: true, warmup: true, race: true, ai: true },
  ],
  weather: [
    { id: 'CLEAR', label: 'Clear' }, { id: 'SCATTERED_CLOUDS', label: 'Scattered clouds' }, { id: 'BROKEN_CLOUDS', label: 'Broken clouds' },
    { id: 'OVERCAST', label: 'Overcast' }, { id: 'DAMP', label: 'Damp track' }, { id: 'DRIZZLE', label: 'Drizzle' }, { id: 'RAIN', label: 'Rain' }, { id: 'HEAVY_RAIN', label: 'Heavy rain' },
  ],
  grips: [{ id: 'GREEN', label: 'Green' }, { id: 'FAST', label: 'Fast' }, { id: 'OPTIMUM', label: 'Optimum' }],
  multipliers: [1, 2, 4, 6, 12, 24, 48],
  aggression: [{ id: 'Safe', label: 'Safe' }, { id: 'Preview', label: 'Aggressive (preview)' }],
  limits: { practiceMin: [1, 90], qualifyingMin: [5, 90], warmupMin: [0, 90], raceMin: [5, 180], raceLaps: [1, 100], strength: [80, 100] },
  defaults: { time: '14:00', timeMult: 1, weather: 'CLEAR', dynamic: false, grip: 'GREEN', practiceMin: 20, qualifyingMin: 15, warmupMin: 10,
    race: { type: 'laps', laps: 10, minutes: 20, startPos: 0 }, ai: { count: 15, min: 88, max: 95, aggression: 'Safe', singleMake: false } },
};
const modeOf = (id) => MODEL.modes.find((m) => m.id === id) || null;

// ---------------------------------------------------------------- data read in game
const pending = new Map();
export function onCatalogue(e) {
  if (!e || e.scan == null || !e.part || !(e.n > 0)) return;
  const key = `${e.scan}|${e.part}`;
  let p = pending.get(key);
  if (!p || p.n !== e.n) { p = { n: e.n, d: new Array(e.n), got: 0 }; pending.set(key, p); }
  if (p.d[e.i] == null) { p.d[e.i] = e.d; p.got++; }
  if (p.got < p.n) return;
  pending.delete(key);
  let value;
  try { value = JSON.parse(p.d.join('')); } catch { console.log(`[race] game data part ${e.part} could not be read`); return; }
  if (e.part === 'applied') { fs.writeFileSync(APPLIED_FILE, JSON.stringify({ at: Date.now(), ...value }, null, 1)); return; }
  // parts are kept across scans / probes / launches: each one refreshes what it read
  if (!scan) scan = { at: Date.now(), parts: {} };
  scan.parts[e.part] = value;
  scan.at = Date.now();
  derived = null;
  saveScan();
  console.log(`[race] game data: ${e.part}`);
}

// the game's track list for a session type: Map "track|layout" -> largest grid (cars on track), or null if not read yet
function gameTracks(type) {
  const items = scan?.parts?.[`tracks:${type}`]?.items;
  if (!Array.isArray(items) || !items.length) return null;
  const out = new Map();
  for (const it of items) if (it?.is_enabled !== false) out.set(`${norm(it.name)}|${norm(it.layout)}`, Number(it.max_drivers) || 0);
  return out;
}

const slug = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
// a mod track's own map drawing (loose file in mods\uiresources\images\trackmaps, named "<track>-<layout>.svg")
function modMapFile(mt, trackName, layoutName) {
  const want = slug(`${trackName} ${layoutName}`);
  for (const [n, file] of mt.maps) if (slug(n) === want) return file;
  return null;
}

export function catalogue() {
  const base = carsDb.catalog(); // a new array when mod packs are added or removed
  const mt = carsDb.modTracks(); // a new object when mod tracks are added or removed
  if (derived && derived.base === base && derived.mt === mt) return derived;
  const parts = scan?.parts || {};
  const aiFlag = new Map((parts.cars || []).map((c) => [c.f?.name, c.f?.is_ai_drivable !== false]));
  const cars = base.map((c) => ({ ...c, ai: aiFlag.get(c.id) ?? true }));
  const lists = Object.fromEntries(MODEL.modes.map((m) => [m.id, gameTracks(m.type)]));
  // per session type: the largest grid there, false = the game does not offer this layout for it, null = not known yet
  const modesOf = (trackName, layoutName) => {
    const modes = {}, k = `${norm(trackName)}|${norm(layoutName)}`;
    for (const m of MODEL.modes) { const g = lists[m.id]; modes[m.id] = g ? (g.has(k) ? g.get(k) : false) : null; }
    return modes;
  };
  // source: 'original' = Kunos content from content.kspkg, 'mod' = a mod replaces the track's folder
  const tracks = trackdata.catalog().map((t) => ({ id: t.id, name: t.name, country: t.countryName, source: mt.folders.has(t.id) ? 'mod' : 'original', layouts: t.layouts.map((l) => (
    { key: l.key, name: l.name, lengthM: l.lengthM, hasMap: !!l.svg, modes: modesOf(t.name, l.name) })) }));
  // Mod tracks: the game lists them (TrackList, read in game) but content.kspkg does not have them.
  // Their name/layout/length come from the game's own list; they have no track model (no ideal line).
  const known = new Set(tracks.flatMap((t) => t.layouts.map((l) => `${norm(t.name)}|${l.key}`)));
  const extra = new Map(); // norm(track name) -> track
  for (const m of MODEL.modes) {
    for (const it of scan?.parts?.[`tracks:${m.type}`]?.items || []) {
      if (!it?.name || !it.layout || it.is_for_development || known.has(`${norm(it.name)}|${norm(it.layout)}`)) continue;
      let t = extra.get(norm(it.name));
      if (!t) extra.set(norm(it.name), t = { id: `mod_${slug(it.name)}`, name: it.name, country: it.nation || '', source: 'mod', layouts: [] });
      if (t.layouts.some((l) => l.key === norm(it.layout))) continue;
      const svg = modMapFile(mt, it.name, it.layout);
      // "hdc_drift_park" -> "HDC Drift Park" (the HUD matches names loosely, so the order still finds it)
      const name = /^[a-z0-9_]+$/.test(it.layout) ? it.layout.split('_').filter(Boolean).map((w) => (w.length <= 3 && !/[aeiou]/.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1))).join(' ') : it.layout;
      t.layouts.push({ key: norm(it.layout), name, lengthM: Number(it.track_length) || 0, hasMap: !!svg, modes: modesOf(it.name, it.layout) });
    }
  }
  tracks.push(...extra.values());
  tracks.sort((a, b) => a.name.localeCompare(b.name));
  derived = { readAt: scan?.at ?? null, cars, tracks, model: MODEL };
  Object.defineProperty(derived, 'base', { value: base }); // not sent to the page
  Object.defineProperty(derived, 'mt', { value: mt });
  return derived;
}
export const publicCatalogue = catalogue;

/** The map drawing of a mod track that content.kspkg does not have (loose file in mods\), or null. */
export function modMapSvg(trackId, layoutKey) {
  const t = catalogue().tracks.find((x) => x.id === trackId && x.source === 'mod');
  const l = t?.layouts.find((x) => x.key === layoutKey);
  const file = l && modMapFile(carsDb.modTracks(), t.name, l.name);
  try { return file ? fs.readFileSync(file) : null; } catch { return null; }
}

// ---------------------------------------------------------------- personal bests for a combo
export function comboStats(trackId, layoutKey, car) {
  const hits = svc.overview().combos.filter((c) => {
    const h = trackdata.find(c.track, c.layout);
    if (!h || h.track.id !== trackId || (layoutKey && h.layout.key !== layoutKey)) return false;
    if (car?.id) return carsDb.match(c.car)?.id === car.id;
    return !car?.display || norm(car.display) === norm(c.car);
  });
  if (!hits.length) return { laps: 0 };
  const best = hits.filter((c) => c.bestMs).sort((a, b) => a.bestMs - b.bestMs)[0];
  return { laps: hits.reduce((a, c) => a + c.laps, 0), bestMs: best?.bestMs ?? null, idealMs: best?.idealMs ?? null, bestLapId: best?.bestLapId ?? null,
    lastAt: Math.max(...hits.map((c) => c.lastAt)), comboKey: best?.key ?? hits[0].key };
}

// recent combos from the laps, resolved to catalogue ids (the "quick picks")
export function recent() {
  return svc.overview().combos.sort((a, b) => b.lastAt - a.lastAt).map((c) => {
    const h = trackdata.find(c.track, c.layout);
    const car = carsDb.match(c.car);
    return { track: c.track, layout: c.layout, carName: c.car, laps: c.laps, bestMs: c.bestMs, idealMs: c.idealMs, lastAt: c.lastAt,
      trackRef: h ? { id: h.track.id, layout: h.layout.key } : null, car: car ? { id: car.id } : { display: c.car } };
  });
}

// ---------------------------------------------------------------- orders
const hhmm = (s, dflt) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '')); return m ? Math.min(23, Number(m[1])) * 60 + Math.min(59, Number(m[2])) : dflt; };

// spec: { kind: 'solo'|'mp', mode, car: {id, mech, visual} | {display}, track: {id, layout},
//         time: 'HH:MM', timeMult, weather, dynamic, grip, practiceMin, qualifyingMin, warmupMin,
//         race: {type: 'laps'|'time', laps, minutes, startPos}, ai: {count, min, max, aggression, singleMake},
//         grid: {cars: [{id, mech}]}, server: {ip, port, password} }
export function buildOrder(spec) {
  const cat = catalogue();
  const order = { kind: spec.kind === 'mp' ? 'mp' : 'solo' };
  if (spec.car?.id) {
    const c = cat.cars.find((x) => x.id === spec.car.id);
    order.car = { id: spec.car.id, mech: spec.car.mech || null, visual: spec.car.visual || null, label: c ? `${c.brand} ${c.name}` : spec.car.id };
  } else if (spec.car?.display) order.car = { display: spec.car.display, label: spec.car.display };
  else if (order.kind === 'solo') throw new Error('Pick a car');
  // only set after the player confirmed it in Paddock: the HUD then quits the running session first
  if (spec.endSession) order.endSession = true;

  if (order.kind === 'mp') {
    const s = spec.server || {};
    if (!s.ip || !(Number(s.port) > 0)) throw new Error('Enter the server address and port');
    order.server = { ip: String(s.ip).trim(), port: Number(s.port), password: s.password || '' };
    order.summary = `online · ${order.server.ip}:${order.server.port}${order.car ? ' · ' + order.car.label : ''}`;
    return order;
  }

  const mode = modeOf(spec.mode);
  if (!mode) throw new Error('Pick a session type');
  const t = cat.tracks.find((x) => x.id === spec.track?.id);
  const l = t?.layouts.find((x) => x.key === spec.track?.layout) || t?.layouts[0];
  if (!t || !l) throw new Error('Pick a track');
  if (l.modes[mode.id] === false) throw new Error(`The game does not offer ${t.name} ${l.name} for ${mode.label}`);
  const D = MODEL.defaults, L = MODEL.limits;
  const tlabel = `${t.name} ${l.name}`;
  const steps = [
    { op: 'type', type: mode.type, say: `session type: ${mode.label}` },
    { op: 'track', name: t.name, layout: l.name, label: tlabel, say: `track: ${tlabel}` },
  ];

  // session settings, written into the game's own session objects (sessions[i].<field>)
  const items = [];
  const set = (i, key, value) => items.push({ path: ['sessions', i, ...[].concat(key)], value });
  const mult = MODEL.multipliers.includes(Number(spec.timeMult)) ? Number(spec.timeMult) : 1;
  const at = (i, minuteOfDay) => {
    const m = Math.max(0, Math.min(1435, minuteOfDay));
    set(i, ['time_of_day', 'hour'], Math.floor(m / 60)); set(i, ['time_of_day', 'minute'], m % 60); set(i, ['time_of_day', 'time_multiplier'], mult);
  };
  const start = hhmm(spec.time, hhmm(D.time, 840));
  const race = { ...D.race, ...(spec.race || {}) }, ai = { ...D.ai, ...(spec.ai || {}) };
  const raceLength = (i) => {
    const laps = race.type !== 'time';
    set(i, 'duration_type', laps ? 'GameModeSelectionDuration_LAPS' : 'GameModeSelectionDuration_TIME');
    set(i, 'duration', laps ? clamp(race.laps, ...L.raceLaps, D.race.laps) : clamp(race.minutes, ...L.raceMin, D.race.minutes) * 60);
  };
  const minutes = (v, lim, dflt) => clamp(v, lim[0], lim[1], dflt) * 60;
  if (mode.id === 'practice') { set(0, 'duration', minutes(spec.practiceMin, L.practiceMin, D.practiceMin)); at(0, start); }
  else if (mode.id === 'hotlap') at(0, start);
  else if (mode.id === 'race') { raceLength(0); at(0, start); }
  else {
    // race weekend: the chosen time is the race start; the earlier sessions keep the game's own spacing before it
    set(0, 'duration', minutes(spec.practiceMin, L.practiceMin, D.practiceMin)); at(0, start - 300);
    set(1, 'duration', minutes(spec.qualifyingMin, L.qualifyingMin, D.qualifyingMin)); at(1, start - 120);
    set(2, 'duration', minutes(spec.warmupMin, L.warmupMin, D.warmupMin)); at(2, start - 60);
    raceLength(3); at(3, start);
  }
  const custom = mode.ai ? (spec.grid?.cars || []).filter((c) => c?.id).slice(0, 40) : [];
  let count = 0;
  if (mode.ai) {
    const most = typeof l.modes[mode.id] === 'number' && l.modes[mode.id] > 1 ? l.modes[mode.id] - 1 : 40;
    count = clamp(ai.count, 1, most, Math.min(15, most));
    const lo = clamp(ai.min, ...L.strength, D.ai.min), hi = clamp(ai.max, ...L.strength, D.ai.max);
    set(0, 'num_opponents', count);
    set(0, 'min_strength', Math.min(lo, hi)); set(0, 'max_strength', Math.max(lo, hi));
    set(0, 'aggressivness', MODEL.aggression.some((a) => a.id === ai.aggression) ? ai.aggression : 'Safe');
    set(0, 'single_make', !!ai.singleMake && !custom.length);
    set(0, 'grid_type', 'GameModeSelectionGridType_AUTO');
    if (mode.startPos) set(0, 'starting_position', clamp(race.startPos, 0, count + 1, 0));
  }
  steps.push({ op: 'set', items, say: 'session settings' });

  const w = MODEL.weather.find((x) => x.id === spec.weather) || MODEL.weather[0];
  const grip = MODEL.grips.find((x) => x.id === spec.grip) || MODEL.grips[0];
  steps.push({ op: 'weather', type: `GameModeSelectionWeatherType_${w.id}`, behaviour: `GameModeSelectionWeatherBehaviour_${spec.dynamic ? 'DYNAMIC' : 'STATIC'}`,
    grip: `InitialGrip_${grip.id}`, say: `weather: ${w.label}` });
  if (custom.length) steps.push({ op: 'grid', count, cars: custom.map((c) => ({ id: c.id, mech: c.mech || null })), say: 'AI grid' });
  steps.push({ op: 'check', type: mode.type, track: { name: t.name, layout: l.name, label: tlabel }, car: order.car.id || null });
  steps.push({ op: 'dump', part: 'applied' }, { op: 'tracks', part: `tracks:${mode.type}` });
  steps.push({ op: 'start', say: `starting ${mode.label}` });
  order.steps = steps;
  order.summary = [mode.label, tlabel, order.car.label].filter(Boolean).join(' · ');
  if (Buffer.byteLength(JSON.stringify(order)) > MAX_ORDER_BYTES) throw new Error('This setup is too large to send to the game (fewer grid cars?)');
  if (!spec.noRemember) { store.last = spec; saveStore(); } // one-click starts keep the Race tab's own setup
  return order;
}

// Laps tab "Start hotlap": a driven combo (names as recorded) in Hotlap mode with the best conditions
export function hotlapSpec(track, layout, carName) {
  const h = trackdata.find(track, layout);
  if (!h) throw new Error(`${track} ${layout || ''} is not in the game's track list`);
  const car = carsDb.match(carName);
  return { kind: 'solo', mode: 'hotlap', car: car ? { id: car.id } : { display: carName }, track: { id: h.track.id, layout: h.layout.key },
    time: MODEL.defaults.time, timeMult: 1, weather: 'CLEAR', dynamic: false, grip: 'OPTIMUM', noRemember: true };
}

// reads the game's car list and the track list of every session type (the launches refresh their own type too)
export function scanOrder() {
  const steps = [];
  for (const m of [...MODEL.modes.slice(1), MODEL.modes[0]]) steps.push({ op: 'type', type: m.type, say: `reading ${m.label}` }, { op: 'tracks', part: `tracks:${m.type}` });
  steps.push({ op: 'done', step: 'scandone', msg: 'game data read' });
  return { kind: 'scan', summary: 'reading the game\'s cars and tracks', steps };
}

// ---------------------------------------------------------------- presets and servers
export const lists = () => ({ presets: store.presets, servers: store.servers.map(({ password, ...s }) => ({ ...s, hasPassword: !!password })), last: store.last });
export function savePreset(name, spec) {
  if (!String(name || '').trim()) throw new Error('Name the preset');
  const ex = store.presets.find((p) => p.name === name.trim());
  if (ex) ex.spec = spec, ex.at = Date.now();
  else store.presets.push({ id: uid(), name: name.trim(), spec, at: Date.now() });
  saveStore();
}
export function deletePreset(id) { store.presets = store.presets.filter((p) => p.id !== id); saveStore(); }
export function saveServer(s) {
  if (!s.ip || !(Number(s.port) > 0)) throw new Error('Server address and port are required');
  const ex = s.id && store.servers.find((x) => x.id === s.id);
  const v = { name: String(s.name || `${s.ip}:${s.port}`).trim(), ip: String(s.ip).trim(), port: Number(s.port) };
  if (ex) Object.assign(ex, v, s.password !== undefined ? { password: s.password } : {});
  else store.servers.push({ id: uid(), ...v, password: s.password || '' });
  saveStore();
}
export function deleteServer(id) { store.servers = store.servers.filter((s) => s.id !== id); saveStore(); }
export const serverById = (id) => store.servers.find((s) => s.id === id) || null;
export const rawScan = () => scan;
