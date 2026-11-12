// AC EVO's setup files, read and written by Paddock.
//
//   <Saved Games>\ACE\Car Setups\<car>\<track>\<name>.carsetup        a setup (protobuf, no schema)
//   content\cars\<car>\data\setup\*.carsetuplimits                  what can be adjusted on this car
//
// The limits file has the same layout as the setup file: where the setup has a value, the limits file has
// {f1 step, f2 min, f3 max, f4 adjustable (1), f7 unit text, f8 decimals}. Missing numbers are 0 (protobuf).
// The adjustable entries are exactly the sliders the game's setup screen shows (checked against the game's own
// slider list for the Toyota GR86: 20 of 20, same values).
//
// Setup layout (field numbers; [w] = one entry per wheel, FL FR RL RR):
//   1 chassis {1 anti-roll bars [front, rear] (packed), 2 steering ratio, 3 brakes {1 bias %, 2 power %},
//              4 differential {1 power, 2 coast, 3 preload}}
//   2[w] spring {1 rate N/m, 2 bump stop {1 range m, 2 rate}, 3 rebound stop {1 range, 2 rate}, 4, 5}
//   3[w] damper {1 slow bump, 2 fast bump, 3 slow rebound, 4 fast rebound}
//   4[w] wheel {1 pressure PSI, 2 camber, 3 toe, 4 caster, 5, 6 (worked out by the game), 7 compound}
//   5 electronics {1 TC, 2 TC cut, 3 ABS, 4 engine map, 5 telemetry laps, 6 ESC, 7.. others}
//   6 body {1 (packed, worked out by the game), 2 front ride height mm, 3 rear ride height mm, 4 front wing, 5 rear wing}
//   7 fuel {1 litres}
//   9 the car preset it was made for, e.g. "ks_toyota_gr86_preset_gr86_mech_1_preset_gr86_visual_1"; 10 version
//
// Paddock changes only the adjustable numbers and leaves every other byte as the game wrote it.
import * as carsDb from './cars.js';

// ---------------------------------------------------------------- generic protobuf tree (keeps order and unknown fields)
function varint(b, p) {
  let v = 0, s = 0;
  for (;;) {
    if (p >= b.length) throw new Error('bad protobuf');
    const x = b[p++];
    v += (x & 0x7f) * 2 ** s;
    s += 7;
    if (!(x & 0x80)) return [v, p];
  }
}
function putVarint(out, v) {
  while (v >= 0x80) { out.push((v % 0x80) | 0x80); v = Math.floor(v / 0x80); }
  out.push(v);
}
/** -> [{f, wt, v}] where v is a number (wt 0/1/5) or a Buffer (wt 2) */
export function decode(b) {
  const out = [];
  let p = 0;
  while (p < b.length) {
    let k; [k, p] = varint(b, p);
    const f = Math.floor(k / 8), wt = k & 7;
    if (!f) throw new Error('bad protobuf field');
    if (wt === 0) { let v; [v, p] = varint(b, p); out.push({ f, wt, v }); }
    else if (wt === 5) { if (p + 4 > b.length) throw new Error('bad protobuf'); out.push({ f, wt, v: b.readFloatLE(p) }); p += 4; }
    else if (wt === 1) { if (p + 8 > b.length) throw new Error('bad protobuf'); out.push({ f, wt, v: b.readDoubleLE(p) }); p += 8; }
    else if (wt === 2) { let l; [l, p] = varint(b, p); if (p + l > b.length) throw new Error('bad protobuf length'); out.push({ f, wt, v: b.subarray(p, p + l) }); p += l; }
    else throw new Error(`unsupported wire type ${wt}`);
  }
  return out;
}
export function encode(nodes) {
  const parts = [];
  for (const n of nodes) {
    const head = []; putVarint(head, n.f * 8 + n.wt);
    parts.push(Buffer.from(head));
    if (n.wt === 0) { const v = []; putVarint(v, n.v); parts.push(Buffer.from(v)); }
    else if (n.wt === 5) { const b = Buffer.alloc(4); b.writeFloatLE(n.v); parts.push(b); }
    else if (n.wt === 1) { const b = Buffer.alloc(8); b.writeDoubleLE(n.v); parts.push(b); }
    else { const body = n.kids ? encode(n.kids) : n.v; const l = []; putVarint(l, body.length); parts.push(Buffer.from(l), body); }
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- the limits file
const isLimit = (fs) => fs.some((x) => x.f <= 3 && x.wt === 5) || fs.every((x) => x.wt !== 2);
/** Every entry of a limits file: [{path: [[field, index], ...], step, min, max, adj, unit, dec}] */
export function readLimits(buf) {
  const out = [];
  (function walk(b, path) {
    const seen = {};
    for (const n of decode(b)) {
      if (n.wt !== 2) continue;
      const i = seen[n.f] = (seen[n.f] ?? -1) + 1;
      const p = [...path, [n.f, i]];
      let kids; try { kids = decode(n.v); } catch { continue; }
      if (isLimit(kids)) {
        const g = (f) => kids.find((x) => x.f === f);
        const unit = g(7)?.wt === 2 ? g(7).v.toString('utf8') : '';
        out.push({ path: p, step: g(1)?.v ?? 0, min: g(2)?.v ?? 0, max: g(3)?.v ?? 0, adj: g(4)?.v === 1, unit: /^[\x20-\x7e°]{0,8}$/.test(unit) ? unit : '', dec: g(8)?.v ?? null });
      } else walk(n.v, p);
    }
  })(buf, []);
  return out;
}

// ---------------------------------------------------------------- names (the game's own slider names where known)
const W = ['FL', 'FR', 'RL', 'RR'];
const NAMES = {
  '1.1#0': 'arbs0', '1.1#1': 'arbs1', '1.2': 'steer_ratio', '1.3.1': 'brakesfront_bias', '1.3.2': 'brakestorque_multiplier',
  '1.4.1': 'differentialpower', '1.4.2': 'differentialcoast', '1.4.3': 'differentialpreload',
  '2.1': 'wheel_rate', '2.2.1': 'bump_stop_uprange', '2.2.2': 'bump_stop_uprate', '2.3.1': 'rebound_stop_range', '2.3.2': 'rebound_stop_rate',
  '3.1': 'slow_bump', '3.2': 'fast_bump', '3.3': 'slow_rebound', '3.4': 'fast_rebound',
  '4.1': 'pressure', '4.2': 'camber', '4.3': 'toe', '4.4': 'caster', '4.7': 'compound',
  '5.1': 'tc1', '5.2': 'tc2', '5.3': 'abs', '5.4': 'engine_map', '5.5': 'telemetry_laps_to_record', '5.6': 'esc',
  '6.2': 'front_target_height', '6.3': 'rear_target_height', '6.4': 'front_wing_angle', '6.5': 'rear_wing_angle',
  '7.1': 'fuel',
};
// label, unit, group, how to show it (shown = stored * scale)
export const PROPS = {
  pressure: { label: 'Tyre pressure', unit: 'PSI', group: 'tyres' }, camber: { label: 'Camber', unit: '°', group: 'tyres' },
  toe: { label: 'Toe', unit: '°', group: 'tyres' }, caster: { label: 'Caster', group: 'tyres' }, compound: { label: 'Tyre compound', group: 'tyres', list: true },
  tc1: { label: 'Traction control', group: 'electronics' }, tc2: { label: 'TC cut', group: 'electronics' }, abs: { label: 'ABS', group: 'electronics' },
  esc: { label: 'Stability control', group: 'electronics' }, engine_map: { label: 'Engine map', group: 'electronics' },
  telemetry_laps_to_record: { label: 'Telemetry laps', group: 'electronics' },
  fuel: { label: 'Fuel', unit: 'L', group: 'fuel' },
  arbs0: { label: 'Front anti-roll bar', group: 'chassis' }, arbs1: { label: 'Rear anti-roll bar', group: 'chassis' },
  steer_ratio: { label: 'Steering ratio', group: 'chassis', abs: true }, brakesfront_bias: { label: 'Brake bias (front)', unit: '%', group: 'chassis' },
  brakestorque_multiplier: { label: 'Brake power', unit: '%', group: 'chassis' },
  differentialpower: { label: 'Diff power', unit: '%', scale: 100, group: 'chassis' }, differentialcoast: { label: 'Diff coast', unit: '%', scale: 100, group: 'chassis' },
  differentialpreload: { label: 'Diff preload', unit: 'Nm', group: 'chassis' },
  wheel_rate: { label: 'Spring rate', unit: 'N/m', group: 'springs' }, bump_stop_uprange: { label: 'Bump stop range', unit: 'mm', scale: 1000, group: 'springs' },
  bump_stop_uprate: { label: 'Bump stop rate', unit: 'N/m', group: 'springs' }, rebound_stop_range: { label: 'Rebound stop range', unit: 'mm', scale: 1000, group: 'springs' },
  rebound_stop_rate: { label: 'Rebound stop rate', unit: 'N/m', group: 'springs' },
  slow_bump: { label: 'Slow bump', group: 'dampers' }, fast_bump: { label: 'Fast bump', group: 'dampers' },
  slow_rebound: { label: 'Slow rebound', group: 'dampers' }, fast_rebound: { label: 'Fast rebound', group: 'dampers' },
  front_target_height: { label: 'Front ride height', unit: 'mm', group: 'aero' }, rear_target_height: { label: 'Rear ride height', unit: 'mm', group: 'aero' },
  front_wing_angle: { label: 'Front wing', unit: '°', group: 'aero' }, rear_wing_angle: { label: 'Rear wing', unit: '°', group: 'aero' },
};
export const GROUPS = [
  ['tyres', 'Tyres'], ['electronics', 'Electronics'], ['fuel', 'Fuel'], ['chassis', 'Chassis, brakes & diff'],
  ['springs', 'Springs & bump stops'], ['dampers', 'Dampers'], ['aero', 'Ride height & aero'], ['other', 'Other'],
].map(([id, label]) => ({ id, label }));

const CORNERS = ['FL', 'FR', 'RL', 'RR', 'F3', 'R3']; // 4 and 5: the third (heave) element front / rear, on cars that have one
const CORNER_RE = /_(FL|FR|RL|RR|F3|R3)$/;
export const CORNER_LABEL = { FL: 'front left', FR: 'front right', RL: 'rear left', RR: 'rear right', F3: 'front third element', R3: 'rear third element' };
const TOP_GROUP = { 1: 'chassis', 2: 'springs', 3: 'dampers', 4: 'tyres', 5: 'electronics', 6: 'aero', 7: 'fuel' };
function nameOf(path) {
  const top = path[0][0];
  const perWheel = (top === 2 || top === 3 || top === 4) && path[0][1] < CORNERS.length;
  const k = [top, ...path.slice(1).map(([f]) => f)].join('.');
  const last = path[path.length - 1];
  const base = NAMES[`${k}#${last[1]}`] || NAMES[k] || `x${k.replace(/\./g, '_')}${!perWheel && last[1] ? `_${last[1]}` : ''}`;
  return perWheel ? `${base}_${CORNERS[path[0][1]]}` : base;
}

// ---------------------------------------------------------------- which limits file a car uses
// cardata.car names the car's limits; a part of the mechanical variant (e.g. a race suspension) can replace them
// through its .tuningpart. Resolved by following the file names written in those files.
const limitsCache = new Map();
const refs = (buf, ext) => [...buf.toString('latin1').matchAll(new RegExp(`content\\\\cars\\\\[\\w\\\\.-]+?\\.${ext}`, 'gi'))].map((m) => m[0].toLowerCase());
export function limitsFor(carId, preset) {
  const car = carsDb.byId(carId);
  const pack = carsDb.packOf(car);
  if (!car || !pack) return null;
  const key = `${carId}|${preset || ''}|${pack.stamp}`;
  if (limitsCache.has(key)) return limitsCache.get(key);
  let file = null;
  try {
    const cardata = pack.read(`content\\cars\\${carId}\\data\\cardata.car`);
    file = cardata ? refs(cardata, 'carsetuplimits')[0] || null : null;
    const mech = preset && preset.startsWith(`${carId}_`) ? (preset.slice(carId.length + 1).match(/^(.+?_mech_\d+)/) || [])[1] : null;
    const mp = mech ? pack.read(`content\\cars\\${carId}\\presets\\${mech}.mechanicalcarpreset`) : null;
    if (mp) {
      // the variant's parts, by name (the preset lists them; their files sit in presets\parts\ or presets\)
      const names = [...new Set([...mp.toString('latin1').matchAll(/[\w-]{3,}/g)].map((m) => m[0].toLowerCase()))];
      for (const n of names) {
        const part = pack.read(`content\\cars\\${carId}\\presets\\parts\\${n}.carpart`) || pack.read(`content\\cars\\${carId}\\presets\\${n}.carpart`);
        if (!part) continue;
        for (const t of refs(part, 'tuningpart')) {
          const tp = pack.read(t);
          const l = tp && refs(tp, 'carsetuplimits')[0];
          if (l) file = l;
        }
      }
    }
    if (!file) file = pack.list(`content\\cars\\${carId}\\data\\setup\\`).find((f) => f.endsWith('.carsetuplimits')) || null;
  } catch (e) { console.log(`[setup] limits for ${carId}: ${e.message}`); }
  let out = null;
  try { const buf = file && pack.read(file); out = buf ? { file, list: readLimits(buf) } : null; } catch (e) { console.log(`[setup] ${file}: ${e.message}`); }
  limitsCache.set(key, out);
  return out;
}

// ---------------------------------------------------------------- values in a setup file
// the node list that holds the value at path (created when `make`), plus how the value is stored there
function locate(root, path, make) {
  let nodes = root;
  for (let d = 0; d < path.length - 1; d++) {
    const [f, i] = path[d];
    const list = nodes.filter((n) => n.f === f && n.wt === 2);
    let n = list[i];
    if (!n) {
      if (!make) return null;
      while (list.length <= i) { n = { f, wt: 2, v: Buffer.alloc(0), kids: [] }; insertSorted(nodes, n); list.push(n); }
    }
    if (!n.kids) n.kids = decode(n.v);
    nodes = n.kids;
  }
  return nodes;
}
function insertSorted(nodes, n) {
  let at = nodes.length;
  while (at > 0 && nodes[at - 1].f > n.f) at--;
  nodes.splice(at, 0, n);
}
function getAt(root, path) {
  const nodes = locate(root, path, false);
  if (!nodes) return 0;
  const [f, i] = path[path.length - 1];
  const scal = nodes.filter((n) => n.f === f && n.wt !== 2);
  if (scal.length) return scal[i]?.v ?? 0;
  const packed = nodes.find((n) => n.f === f && n.wt === 2);
  if (packed && packed.v.length % 4 === 0 && !packed.kids) return 4 * i + 4 <= packed.v.length ? packed.v.readFloatLE(4 * i) : 0;
  return 0;
}
function setAt(root, path, value) {
  const nodes = locate(root, path, true);
  const [f, i] = path[path.length - 1];
  const scal = nodes.filter((n) => n.f === f && n.wt !== 2);
  if (scal[i]) { scal[i].v = scal[i].wt === 0 ? Math.max(0, Math.round(value)) : value; return; }
  const packed = nodes.find((n) => n.f === f && n.wt === 2);
  if (packed && !packed.kids && packed.v.length % 4 === 0) {
    const b = Buffer.alloc(Math.max(packed.v.length, 4 * i + 4));
    packed.v.copy(b); b.writeFloatLE(value, 4 * i); packed.v = b;
    return;
  }
  if (i > 0 && !scal.length) { // a repeated value the file has none of yet: write them packed, like the game does
    const b = Buffer.alloc(4 * i + 4); b.writeFloatLE(value, 4 * i);
    insertSorted(nodes, { f, wt: 2, v: b });
    return;
  }
  while (scal.length <= i) { const n = { f, wt: 5, v: 0 }; insertSorted(nodes, n); scal.push(n); }
  scal[i].v = value;
}
const f32 = (v) => { const b = Buffer.alloc(4); b.writeFloatLE(v); return b.readFloatLE(0); };
const tidy = (v) => Math.round(v * 1e6) / 1e6;

/** The car preset string (f9) of a setup file, or null. */
export function presetOf(buf) {
  try {
    const n = decode(buf).find((x) => x.f === 9 && x.wt === 2);
    const s = n ? n.v.toString('utf8') : null;
    return s && /^[\x20-\x7e]+$/.test(s) ? s : null;
  } catch { return null; }
}

/**
 * What the game's setup screen shows for this file:
 * [{name, label, corner, group, value, min, max, step, unit, scale, list, locked, path}]
 * locked: the game shows this one as clicks (e.g. anti-roll bar 1-7) but stores the physical value (N/m); how
 * clicks map to values is not in the setup files, so it can only be changed in the game.
 */
export function read(buf, carId) {
  const root = decode(buf);
  const preset = presetOf(buf);
  const lim = limitsFor(carId, preset);
  if (!lim) return { preset, values: null, limitsFile: null };
  const values = [];
  for (const L of lim.list) {
    if (!L.adj) continue;
    const name = nameOf(L.path);
    const corner = (name.match(CORNER_RE) || [])[1] || null;
    const base = name.replace(CORNER_RE, '');
    const P = PROPS[base] || { label: `Setting ${base.slice(1).replace(/_/g, '.')}`, group: TOP_GROUP[L.path[0][0]] || 'other' };
    const v = { name, label: P.label, corner, group: P.group, value: tidy(getAt(root, L.path)), min: tidy(Math.min(L.min, L.max)), max: tidy(Math.max(L.min, L.max)),
      step: tidy(L.step), unit: P.unit || L.unit || '', scale: P.scale || 1, list: !!P.list, locked: false, path: L.path.map(([f, i]) => `${f}:${i}`).join('/') };
    const slack = Math.max(v.step, 1e-6);
    if (!(v.step > 0) || v.max <= v.min) v.locked = 'fixed';
    else if (v.value < v.min - slack || v.value > v.max + slack) v.locked = 'clicks';
    values.push(v);
  }
  return { preset, values, limitsFile: lim.file };
}

/** The value the game would keep for a slider: on the step grid, inside the limits. */
export function snap(s, v) {
  let x = Number(v);
  if (!Number.isFinite(x)) return s.value;
  if (s.step > 0) x = s.min + Math.round((x - s.min) / s.step) * s.step;
  x = Math.min(Math.max(x, Math.min(s.min, s.max)), Math.max(s.min, s.max));
  return tidy(x);
}

/**
 * A copy of the setup file with some values changed: {name: value} in stored units (as read() gives them).
 * Only adjustable values are touched; each is snapped to the car's limits. -> {buf, changed: [{name, from, to}]}
 */
export function write(buf, carId, changes) {
  const { values } = read(buf, carId);
  if (!values) throw new Error('This car\'s setup limits were not found in the game files');
  const root = decode(buf);
  const changed = [];
  for (const [name, want] of Object.entries(changes || {})) {
    const s = values.find((x) => x.name === name);
    if (!s) throw new Error(`"${name}" can't be adjusted on this car`);
    if (s.locked) throw new Error(`${s.label}${s.corner ? ` ${s.corner}` : ''} can only be changed in the game`);
    const to = snap(s, want);
    if (Math.abs(to - s.value) < 1e-6) continue;
    setAt(root, s.path.split('/').map((x) => x.split(':').map(Number)), f32(to));
    changed.push({ name, from: s.value, to });
  }
  const out = encode(root);
  // what was written reads back the same (and nothing else moved)
  const check = read(out, carId).values;
  for (const s of check) {
    const c = changed.find((x) => x.name === s.name);
    const want = c ? c.to : values.find((x) => x.name === s.name).value;
    if (Math.abs(s.value - want) > Math.max(1e-4, s.step / 100, Math.abs(want) * 1e-6)) throw new Error(`writing ${s.name} failed (${s.value} instead of ${want})`);
  }
  return { buf: out, changed };
}

// ---------------------------------------------------------------- the game's own help text per setting
let tipCache = null;
/** {name: text} from the game's English tooltips (tooltip_carsetup_<name>; per-wheel ones under the _FL name). */
export function tooltips() {
  if (tipCache) return tipCache;
  const out = {};
  try {
    const buf = carsDb.packOf(null)?.read(String.raw`uiresources\localization\en.tooltips.loc`);
    for (const line of (buf ? buf.toString('utf8') : '').split(/\r?\n/)) {
      const m = line.match(/^tooltip_carsetup_([A-Za-z0-9_]+?)(?:_FL)?=(.+)$/);
      if (m && !/_(FR|RL|RR)$/.test(m[1])) out[m[1]] = m[2].trim();
    }
  } catch (e) { console.log(`[setup] tooltips: ${e.message}`); }
  tipCache = out;
  return out;
}
/** Help text for a value from read(), or ''. */
export const tipFor = (v) => { const t = tooltips(); const base = v.name.replace(CORNER_RE, ''); return t[base] || ({ arbs0: t.arbs0, arbs1: t.arbs1 })[base] || ''; };
