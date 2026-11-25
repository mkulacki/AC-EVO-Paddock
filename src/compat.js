// Comparison compatibility (PL4.2): can two laps be compared, and what should the driver keep in mind when they are?
// Built only from what Paddock recorded with each lap (laps.cond, laps.setup_info, laps.aids, the session) and from
// what each reading is worth (src/channels.js). Nothing is guessed: a value not recorded for one of the laps never
// counts as a match, it becomes a caveat of its own.
//
// level: 'compatible'   everything that matters is known and the same
//        'caveats'      comparable, but something differs or is not known: each caveat says what it changes
//        'incompatible' another car or another track layout: the numbers do not carry over (the driver can still
//                       look, deliberately)
import * as channels from './channels.js';

/** Conditions count as different above these temperature gaps (°C). docs/DECISIONS.md OD-PL-14. */
export const LIMITS = { roadC: 5, airC: 5 };
export const MIXED = 'mixed';
// the same names as the pages use (public/util.js SESSION_TYPES)
export const SESSION_TYPES = { 0: 'time attack', 1: 'race', 2: 'hot stint', 3: 'cruise' };

const parse = (v) => { if (!v) return null; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return null; } };
const known = (v) => v !== null && v !== undefined && v !== '' && v !== MIXED;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * What is known about a lap, from its database row (a getLapMeta / getLap row, without data).
 * sessionType: the session's type when known (sessions.session_type), else null.
 */
export function provenance(meta, { sessionType = null } = {}) {
  const cond = parse(meta.cond) || {}, aids = parse(meta.aids), su = parse(meta.setup_info);
  // a setup's identity: the copy of its values when the lap was driven (setup_snapshots), or the game's stock setup
  const setup = su?.snap ? { id: `snap:${su.snap}`, name: meta.setup_name || null }
    : su?.stock && typeof su.stock === 'object' && su.stock.name ? { id: `stock:${su.stock.name}`, name: meta.setup_name || su.stock.name }
      : null;
  return {
    id: meta.id ?? null, car: meta.car ?? null, track: meta.track ?? null, layout: meta.layout ?? null, source: meta.source || 'local',
    game: typeof cond.game === 'string' && cond.game ? cond.game : null, reader: typeof cond.reader === 'string' ? cond.reader : null,
    setup, setupName: meta.setup_name || null,
    airC: num(cond.airC), roadC: num(cond.roadC), weather: cond.weather ?? null, grip: cond.grip ?? null,
    aids: aids?.cls && aids.cls !== 'unknown' ? aids.cls : null,
    sessionType: Number.isInteger(sessionType) && sessionType >= 0 ? sessionType : null,
  };
}

/**
 * One provenance for a lap made of several laps (the ideal lap): a value all of them share, null when one of them
 * does not know it, MIXED when they differ. Temperatures: the range is kept (min / max) for the caveat text.
 */
export function merge(list) {
  if (!list.length) return null;
  const one = (k) => {
    const vals = list.map((p) => p[k]);
    if (vals.some((v) => !known(v))) return null;
    return vals.every((v) => v === vals[0]) ? vals[0] : MIXED;
  };
  // a layout can be '' (a track with one layout, src/shm.js): '' is a value, only null / undefined is not known
  const layouts = list.map((p) => p.layout);
  const layout = layouts.some((v) => v == null) ? null : layouts.every((v) => v === layouts[0]) ? layouts[0] : MIXED;
  const setups = list.map((p) => p.setup?.id ?? null);
  const temp = (k) => { const v = list.map((p) => p[k]); return v.every((x) => x != null) ? { min: Math.min(...v), max: Math.max(...v) } : null; };
  const t = { air: temp('airC'), road: temp('roadC') };
  const mid = (r) => (r ? Math.round(((r.min + r.max) / 2) * 10) / 10 : null);
  return {
    id: 'ideal', car: one('car'), track: one('track'), layout, source: one('source'), game: one('game'), reader: one('reader'),
    setup: setups.some((s) => !s) ? null : setups.every((s) => s === setups[0]) ? list[0].setup : { id: MIXED, name: null },
    setupName: one('setupName'), airC: mid(t.air), roadC: mid(t.road), tempRange: t,
    weather: one('weather'), grip: one('grip'), aids: one('aids'), sessionType: one('sessionType'), parts: list.length,
  };
}

const AIDS_TEXT = { pro: 'no aids (PRO)', 'pro-fixed': 'only aids the car cannot switch off', assisted: 'aids on' };
const sess = (t) => SESSION_TYPES[t] || `session type ${t}`;

/**
 * Lap a against the reference b. statusOf(group): what a telemetry group is worth now for these laps
 * (default: src/channels.js, per car). Returns {level, items, matched, unknown}.
 *   items:   [{key, level: 'caveat' | 'incompatible', title, detail, effect}]
 *   matched: factors known on both sides and the same (for "what was checked")
 *   unknown: factors not known for at least one of the laps (they never count as a match)
 */
export function classify(a, b, { statusOf } = {}) {
  const st = statusOf || ((g) => channels.status(g, { car: a.car }));
  const items = [], matched = [], unknown = [];
  const add = (key, level, title, detail, effect) => items.push({ key, level, title, detail, effect });
  const refName = b.id === 'ideal' ? 'the ideal lap' : 'the reference';

  // track and car: anything else is a different comparison altogether
  // ('' is a real layout name: equal '' matches; null = not known, MIXED = several)
  if (!known(a.track) || !known(b.track) || a.track !== b.track || a.layout == null || b.layout == null || b.layout === MIXED || a.layout !== b.layout) {
    add('track', 'incompatible', 'Another track or layout', `This lap is from ${a.track || '?'} ${a.layout || ''}, ${refName} from ${b.track || '?'} ${b.layout || ''}.`.replace(/\s+/g, ' '),
      'Distances and corners do not line up, so the gap and the corner times mean nothing.');
  } else matched.push('track');
  if (!known(a.car) || !known(b.car) || a.car !== b.car) {
    add('car', 'incompatible', b.car === MIXED ? 'The reference mixes cars' : 'Another car', `This lap: ${a.car || 'not known'}; ${refName}: ${b.car === MIXED ? 'several cars' : b.car || 'not known'}.`,
      'Speed, braking points and gears differ from car to car: a gap can be the car, not your driving.');
  } else matched.push('car');

  // game version: physics and tyres can change with an update
  if (!known(a.game) || (!known(b.game) && b.game !== MIXED)) unknown.push('game version');
  if (b.game === MIXED) add('game', 'caveat', 'The ideal lap mixes game versions', 'Its corners come from laps driven on different AC EVO versions.', 'A game update can change grip and braking: part of the gap may come from the update.');
  else if (known(a.game) && known(b.game)) {
    if (a.game !== b.game) add('game', 'caveat', 'Different game versions', `This lap: AC EVO ${a.game}; ${refName}: AC EVO ${b.game}.`, 'A game update can change grip, tyres and braking: part of the gap may come from the update, not from your driving.');
    else matched.push('game version');
  }

  // setup: recognised in the pit box (setupProbe); an unconfirmed recognition is not proof of the same setup
  const probe = st('setupProbe');
  if (probe === 'mismatch') unknown.push('setup (pit-box readings marked as wrong)');
  else if (b.setup?.id === MIXED) add('setup', 'caveat', 'The ideal lap mixes setups', 'Its corners come from laps driven on different setups.', 'Some of its corners may be faster because of the setup, not the driving.');
  else if (!a.setup || !b.setup) unknown.push('setup');
  else if (a.setup.id !== b.setup.id) {
    const same = a.setupName && a.setupName === b.setupName;
    add('setup', 'caveat', same ? 'Same setup file, other values' : 'Different setups',
      `${same ? `Both laps were driven on "${a.setupName}", but its values had changed in between.` : `This lap: ${a.setupName || 'not named'}; ${refName}: ${b.setupName || 'not named'}.`}${probe !== 'verified' ? ' (setup recognition is not checked against the game yet)' : ''}`,
      'A setup change moves braking points, speed and balance: part of the gap may be the setup.');
  } else if (probe !== 'verified') {
    add('setup', 'caveat', 'Same setup, recognition not confirmed', `Both laps were recognised as "${a.setupName || 'the same setup'}", but setup recognition is not checked against the game yet.`,
      'If the recognition is wrong, a setup change could explain part of the gap. Check it once in Setups → Setup recognition.');
  } else matched.push('setup');

  // conditions: temperatures (conditions group), weather and grip (from the Race tab launch)
  const cond = st('conditions');
  if (cond === 'mismatch') unknown.push('temperatures (marked as wrong)');
  else {
    const diffs = [], close = [];
    for (const [k, label] of [['roadC', 'track'], ['airC', 'air']]) {
      if (a[k] == null || b[k] == null) { unknown.push(`${label} temperature`); continue; }
      const range = b.tempRange?.[k === 'roadC' ? 'road' : 'air'];
      const far = range ? Math.max(Math.abs(a[k] - range.min), Math.abs(a[k] - range.max)) : Math.abs(a[k] - b[k]);
      if (far > LIMITS[k]) diffs.push(`${label} ${a[k]} °C against ${range && range.min !== range.max ? `${range.min}–${range.max}` : b[k]} °C`);
      else if (cond === 'verified') matched.push(`${label} temperature`);
      else close.push(`${label} ${a[k]} against ${b[k]} °C`); // not checked against the game: not counted as a match
    }
    for (const [k, label] of [['weather', 'weather'], ['grip', 'grip']]) {
      if (!known(a[k]) || !known(b[k])) { if (b[k] === MIXED) diffs.push(`${refName} mixes ${label}`); else unknown.push(label); continue; }
      if (a[k] !== b[k]) diffs.push(`${label} ${a[k]} against ${b[k]}`); else matched.push(label);
    }
    if (diffs.length) add('conditions', 'caveat', 'Different conditions', `${diffs.join('; ')}${cond !== 'verified' && diffs.some((d) => d.includes('°C')) ? ' (temperatures not checked against the game yet)' : ''}.`,
      'Track temperature, weather and grip change how much grip there is: part of the gap may be the conditions.');
    else if (close.length) add('conditions', 'caveat', 'Similar temperatures, not confirmed', `${close.join('; ')}: within ${LIMITS.roadC} °C, but the temperature readings are not checked against the game yet.`,
      'If the readings are wrong, the conditions may differ more than shown. Check them once in Setups → Setup recognition.');
  }

  // driving aids (through the Paddock HUD)
  const aid = st('aids');
  if (aid === 'mismatch') unknown.push('driving aids (marked as wrong)');
  else if (b.aids === MIXED) add('aids', 'caveat', 'The ideal lap mixes driving aids', 'Its corners come from laps driven with different aid settings.', 'TC and ABS change braking and corner exits: some corners may be faster because of the aids.');
  else if (!known(a.aids) || !known(b.aids)) unknown.push('driving aids');
  else if (a.aids !== b.aids) add('aids', 'caveat', 'Different driving aids', `This lap: ${AIDS_TEXT[a.aids] || a.aids}; ${refName}: ${AIDS_TEXT[b.aids] || b.aids}${aid !== 'verified' ? ' (aid readings not checked against the game yet)' : ''}.`,
    'TC and ABS change how late you can brake and how early you can accelerate: part of the gap may be the aids.');
  else if (aid !== 'verified') add('aids', 'caveat', 'Same driving aids, not confirmed', `Both laps: ${AIDS_TEXT[a.aids] || a.aids}, but the aid readings are not checked against the game yet.`,
    'If the readings are wrong, a difference in TC or ABS could explain part of the gap. Check them once in Setups → Setup recognition.');
  else matched.push('driving aids');

  // session type: a race lap has traffic and fuel, a hotlap has neither
  if (b.sessionType === MIXED) add('session', 'caveat', 'The ideal lap mixes session types', 'Its corners come from different kinds of sessions (time attack, race, …).', 'Traffic and fuel load differ between session types.');
  else if (a.sessionType == null || b.sessionType == null) unknown.push('session type');
  else if (a.sessionType !== b.sessionType) add('session', 'caveat', 'Different session types', `This lap: ${sess(a.sessionType)}; ${refName}: ${sess(b.sessionType)}.`, 'Traffic, fuel load and tyre wear differ between session types: part of the gap may come from them.');
  else matched.push('session type');

  const unk = [...new Set(unknown.filter(Boolean))];
  if (unk.length) add('unknown', 'caveat', 'Not recorded for one of the laps', `Paddock cannot tell whether these match: ${unk.join(', ')}.`,
    'Unknown is not the same: part of the gap may come from a difference Paddock could not see. Laps from older Paddock versions, imports and online laps often lack these.');
  const level = items.some((i) => i.level === 'incompatible') ? 'incompatible' : items.length ? 'caveats' : 'compatible';
  return { level, items, matched, unknown: unk };
}

/** The worst level of several comparisons. */
export const worst = (levels) => (levels.includes('incompatible') ? 'incompatible' : levels.includes('caveats') ? 'caveats' : 'compatible');

/** What a comparison's charts rest on (the telemetry groups used), with what each is worth now. */
export function basis(car) {
  return [['core', 'Speed, pedals, steering, gear, RPM and the driven line'], ['trackLimits', 'Lap valid flag'], ['gforce', 'G-forces (replay only)']]
    .map(([id, use]) => ({ id, use, status: channels.status(id, { car }), state: channels.state(id, { car }) }));
}

/**
 * A group of laps (Consistency, Progress): which recorded factors differ between them, as caveats in the same form.
 * Only values that were recorded and actually differ make an item (OD-PL-18 (b)); what is not recorded is returned in
 * `unknown` (not shown). Setups and aids are left out when their readings are marked as wrong. Returns {level, items, unknown, laps}.
 */
export function mix(list, { statusOf } = {}) {
  const st = statusOf || ((g) => channels.status(g, { car: list[0]?.car ?? null }));
  const items = [];
  const vary = (k, title, effect, fmt = (v) => v) => {
    const vals = list.map((p) => (k === 'setup' ? p.setup?.id ?? null : p[k]));
    const seen = [...new Set(vals.filter((v) => known(v)))];
    const missing = vals.filter((v) => !known(v)).length;
    if (seen.length > 1) items.push({ key: k, level: 'caveat', title, detail: `${seen.length} different: ${seen.slice(0, 4).map(fmt).join(', ')}${seen.length > 4 ? ', …' : ''}.`, effect });
    return missing;
  };
  const wrong = (g) => st(g) === 'mismatch';
  const missing = {
    'game version': vary('game', 'Laps from different game versions', 'A game update can change grip and braking: a trend across an update may be the update.', (v) => `AC EVO ${v}`),
    setup: wrong('setupProbe') ? 0 : vary('setup', 'Laps on different setups', 'Setup changes move lap times: part of a trend may be the setup.', (v) => list.find((p) => p.setup?.id === v)?.setupName || 'a setup'),
    'driving aids': wrong('aids') ? 0 : vary('aids', 'Laps with different driving aids', 'TC and ABS change lap times: compare laps with the same aids for a fair trend.', (v) => AIDS_TEXT[v] || v),
  };
  const unk = Object.entries(missing).filter(([, n]) => n > 0).map(([k, n]) => `${k} (${n} of ${list.length} laps)`);
  return { level: items.length ? 'caveats' : 'compatible', items, unknown: unk, laps: list.length };
}
