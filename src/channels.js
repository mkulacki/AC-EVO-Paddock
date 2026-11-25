// Where each telemetry reading comes from and how far it can be trusted (docs/DECISIONS.md, "Provenance before more
// analysis"). AC EVO's shared-memory layout is community-sourced; some of it has been checked against the game,
// some not. Anything Paddock concludes from a reading that is not checked is shown as unconfirmed, never as fact.
//
// status: 'verified'   the readings were checked against the game, on this game version and with this reader
//         'unverified' read from the game, not checked yet, or checked on another game version / reader / car
//         'mismatch'   the driver compared them with the game and they did not match
// state:  the same in three classes (PL4.1): 'verified', 'unverified', 'unsupported' (= mismatch: not used at all)
// (A reading the game leaves empty in a given session is "missing"; that is decided per session, see carreport.js.)
//
// PL4.1: a check is a record {ok, game, adapter, at, method, car}: the game version it was made on (from the game's
// log, as laps.cond.game), the reader it was made with (shared-memory layout revision, or the Paddock HUD version for
// readings that come through the HUD), when, how, and the car for groups whose meaning depends on the car. A record
// counts only while the game version and the reader are the same as now; anything not known counts as not checked.
// A "does not match" stays until the driver undoes it (it is the cautious state), on any version.
import * as settings from './settings.js';

/**
 * Revision of the shared-memory layout (src/shm.js OFFSETS). Bump it whenever OFFSETS change: checks made with an
 * older revision then count as not checked. test/compat.test.js fails until OFFSETS_HASH matches OFFSETS again.
 */
export const PARSER_REV = 1;
export const OFFSETS_HASH = 'f682022fa5b1bc29';
export const METHOD = 'in-game comparison';
export const LEGACY_METHOD = 'in-game comparison, before Paddock recorded the game version';

/**
 * confirmable: the driver can check the readings against something the game shows (Setups → Setup recognition).
 * Built-in 'verified' groups were checked in game during development (laps, lap times and the driven line match).
 * via: where the readings come from: 'shm' (shared memory, src/shm.js) or 'hud' (the in-game Paddock HUD).
 * perCar: what the readings mean depends on the car (a check made with one car says nothing about another).
 */
export const GROUPS = {
  core: { label: 'Speed, pedals, steering, gear, RPM, lap timing and position', builtIn: 'verified', via: 'shm',
    note: 'Checked in game: recorded laps, lap times, the driven line and braking points match the game.' },
  trackLimits: { label: 'Track limits (lap valid flag, tyres off track)', builtIn: 'verified', via: 'shm',
    note: 'Checked in game: invalid laps match the game.' },
  gforce: { label: 'Lateral and longitudinal G', builtIn: 'unverified', via: 'shm',
    note: 'The game shows no G values to compare with. Used only for the replay G circle and to pick cornering samples.' },
  setupProbe: { label: 'Pit-box readings: tyre pressures, camber, brake bias, fuel', confirmable: true, via: 'shm',
    note: 'Used to recognise the setup of every lap.', check: 'Load a saved setup, stand in the pit box and compare the values with that setup.' },
  conditions: { label: 'Air and track temperature', confirmable: true, via: 'shm',
    note: 'Shown in session reports.', check: 'Compare with the temperatures the game shows for the session.' },
  tyres: { label: 'Tyre temperatures (inner, middle, outer, core) and hot pressures', confirmable: true, via: 'shm',
    note: 'Used for camber and pressure hints in Car & setup.', check: "Compare with the game's tyre page while driving or standing still." },
  brakes: { label: 'Brake temperatures and lock-ups', confirmable: true, via: 'shm',
    note: 'Used for brake bias and brake duct hints.', check: "Compare the brake temperatures with the game's tyre page; lock-ups you feel should show up here." },
  suspension: { label: 'Suspension travel and ride height', confirmable: true, via: 'shm', perCar: true,
    note: 'Used for bump stop and ride height hints.', check: "Compare with the game's suspension readings, if your car's display shows them." },
  aids: { label: 'Driving aids: TC, TC cut, ABS and ESC levels, and when they act', confirmable: true, via: 'hud', perCar: true,
    note: "From the game's own car display, through the Paddock HUD. Used to compare online lap times and for PRO challenges.",
    check: 'Change TC and ABS with your wheel buttons or the car menu: the levels here should follow. Then drive hard: TC and ABS should show up as acted.' },
  assists: { label: 'Assists: automatic gearbox, auto-clutch, stability control, ideal line', confirmable: true, via: 'hud',
    note: "From the game's assist settings, read on the game's menu screens.", check: "Compare with the game's Assists screen (open it once from the main menu)." },
  slip: { label: 'Slip angles and slip ratios (balance, wheelspin)', builtIn: 'unverified', via: 'shm',
    note: 'The game shows no slip values, so they cannot be checked: understeer, oversteer and wheelspin readings stay unconfirmed.' },
  windows: { label: "The game's tyre and brake window positions", builtIn: 'unverified', via: 'shm',
    note: 'Their meaning is not known yet.' },
};
export const CONFIRMABLE = Object.keys(GROUPS).filter((k) => GROUPS[k].confirmable);

// ---------------------------------------------------------------- what "now" is: set by the server (src/server.js)
let ctx = { game: () => null, hud: () => null };
let gameCache = { at: 0, v: null };
/** gameVersion(): the game version now (null = not known); hudVersion(): the Paddock HUD version Paddock ships. */
export function configure({ gameVersion, hudVersion } = {}) {
  ctx = { game: gameVersion || (() => null), hud: hudVersion || (() => null) };
  gameCache = { at: 0, v: null };
}
const str = (v, max = 64) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
/** The game version now (read from the game's newest log at most every 5 s), or null when it is not known. */
export function currentGame() {
  if (Date.now() - gameCache.at > 5000) { let v = null; try { v = str(ctx.game()); } catch { /* not known */ } gameCache = { at: Date.now(), v }; }
  return gameCache.v;
}
/** The reader a group's readings come through now: 'shm r1' or 'hud 0.14.0' (null = not known). */
export function adapterOf(id) {
  if (GROUPS[id]?.via === 'hud') { let v = null; try { v = str(ctx.hud()); } catch { /* not known */ } return v ? `hud ${v}` : null; }
  return `shm r${PARSER_REV}`;
}

// ---------------------------------------------------------------- records
/** One stored check, made safe: a value of the wrong kind is dropped (null), an unusable record is ignored. */
function cleanRecord(r) {
  if (r === true || r === false) return { ok: r, game: null, adapter: null, at: null, method: LEGACY_METHOD, car: null, legacy: true };
  if (!r || typeof r !== 'object' || typeof r.ok !== 'boolean') return null;
  return { ok: r.ok, game: str(r.game), adapter: str(r.adapter), at: Number.isFinite(r.at) ? r.at : null,
    method: str(r.method, 60) || LEGACY_METHOD, car: str(r.car, 120), ...(r.legacy ? { legacy: true } : {}) };
}
/** The driver's checks: {group: record}. Booleans from before PL4 (and the 0.5 switch) become legacy records. */
export function records() {
  const s = settings.get();
  const raw = s.channelChecks && typeof s.channelChecks === 'object' && !Array.isArray(s.channelChecks) ? s.channelChecks : {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) { if (!GROUPS[k]) continue; const r = cleanRecord(v); if (r) out[k] = r; }
  // before 0.6 one switch ("Readings match the game") covered the pit-box readings and the temperatures
  if (s.probeConfirmed) for (const k of ['setupProbe', 'conditions']) if (!(k in out)) out[k] = cleanRecord(true);
  return out;
}
/** Writes old boolean checks out as records once (at start), so settings.json says what they are. */
export function migrate() {
  const raw = settings.get().channelChecks;
  const old = (raw && typeof raw === 'object' && Object.values(raw).some((v) => typeof v === 'boolean')) || (settings.get().probeConfirmed && !raw);
  if (!old) return false;
  settings.update({ channelChecks: records() });
  return true;
}

const fmtWhen = (at) => (at ? new Date(at).toISOString().slice(0, 10) : 'an unknown date');
/**
 * Everything about one group now: {status, state, reason, needsRecheck, record}. car: the car the readings are about
 * (only matters for perCar groups); without one, a perCar check counts for the car it was made with.
 */
export function evaluate(id, { car = null } = {}) {
  const g = GROUPS[id];
  if (!g) throw new Error(`Unknown telemetry group ${id}`);
  const out = (status, reason, extra = {}) => ({ status, state: status === 'mismatch' ? 'unsupported' : status, reason, needsRecheck: false, record: null, ...extra });
  if (g.builtIn) return out(g.builtIn, g.builtIn === 'verified' ? 'Checked in game during development.' : 'Cannot be checked against the game.', { builtIn: true });
  const r = records()[id];
  if (!r) return out('unverified', 'Not checked against the game yet.');
  const game = currentGame(), adapter = adapterOf(id);
  const made = `${r.game ? `on AC EVO ${r.game}` : 'on an unknown game version'}${r.at ? `, ${fmtWhen(r.at)}` : ''}`;
  // what would make an old check no longer count (the same for "matches" and "does not match")
  const stale = r.legacy || !r.game ? 'It was checked before Paddock recorded the game version: check it again.'
    : !game ? `Checked ${made}, but the game version now is not known (AC EVO's log not found): it counts once the version is known again.`
      : r.game !== game ? `Checked ${made}; the game is now ${game}: check it again.`
        : !r.adapter || r.adapter !== adapter ? `Checked ${made} with ${r.adapter || 'an unknown reader'}; Paddock now reads it with ${adapter || 'an unknown reader'}: check it again.`
          : g.perCar && car && r.car !== car ? `Checked with ${r.car || 'no car'}; these readings are about ${car}, and their meaning depends on the car: check it with this car.`
            : null;
  if (!r.ok) return out('mismatch', `Found not to match the game ${made}.${stale ? ' Undo it if a newer version reads it right.' : ''}`, { record: r, needsRecheck: !!stale });
  if (stale) return out('unverified', stale, { record: r, needsRecheck: true });
  return out('verified', `Checked ${made}${g.perCar && r.car ? ` with ${r.car}` : ''}.`, { record: r });
}

export const status = (id, opts) => evaluate(id, opts).status;
export const state = (id, opts) => evaluate(id, opts).state;
export const trusted = (id, opts) => status(id, opts) === 'verified';
/** Every group basis says what a conclusion rests on: true only if all of them are checked. */
export const allTrusted = (basis, opts) => basis.every((id) => trusted(id, opts));

export const list = (opts) => Object.entries(GROUPS).map(([id, g]) => {
  const e = evaluate(id, opts);
  return { id, label: g.label, status: e.status, state: e.state, reason: e.reason, needsRecheck: e.needsRecheck,
    record: e.record ? { game: e.record.game, adapter: e.record.adapter, at: e.record.at, method: e.record.method, car: e.record.car } : null,
    confirmable: !!g.confirmable, perCar: !!g.perCar, via: g.via, note: g.note, check: g.check || null };
});
export const summary = (opts) => Object.fromEntries(Object.keys(GROUPS).map((id) => [id, status(id, opts)]));
/** What the checks are measured against now (Diagnostics, health panel). */
export const context = () => ({ game: currentGame(), parser: `shm r${PARSER_REV}`, hud: adapterOf('aids') });

/** The driver compared a group with the game: ok true = matches, false = does not, null = forget the check. */
export function confirm(id, ok, { car = null } = {}) {
  if (!GROUPS[id]?.confirmable) throw new Error(`"${id}" cannot be checked against the game`);
  if (ok !== true && ok !== false && ok !== null) throw new Error('ok must be true, false or null');
  // write the old switch's meaning out first, so changing one of its two groups does not undo the other
  const c = records();
  if (ok === null) delete c[id];
  else c[id] = { ok, game: currentGame(), adapter: adapterOf(id), at: Date.now(), method: METHOD, car: GROUPS[id].perCar ? str(car, 120) : null };
  const patch = { channelChecks: c };
  // keep the old switch in step, so going back to an older Paddock still shows the same state
  if (id === 'setupProbe') patch.probeConfirmed = ok === true;
  settings.update(patch);
  return status(id, { car });
}

/** Readings the driver found wrong are not sent to the AI at all (relying on the prompt to ignore them is weaker). */
export const usable = (id, opts) => state(id, opts) !== 'unsupported';

/** For AI prompts: what each group's readings are worth, in words the model can use. */
export const forAi = (ids = Object.keys(GROUPS), opts) => Object.fromEntries(ids.map((id) => [id, {
  verified: 'confirmed in game', unverified: 'NOT confirmed in game: treat as a weak hint', mismatch: 'known to be WRONG: left out',
}[status(id, opts)]]));
