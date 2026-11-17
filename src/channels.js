// Where each telemetry reading comes from and how far it can be trusted (docs/DECISIONS.md, "Provenance before more
// analysis"). AC EVO's shared-memory layout is community-sourced; some of it has been checked against the game,
// some not. Anything Paddock concludes from a reading that is not checked is shown as unconfirmed, never as fact.
//
// status: 'verified'   the readings were checked against the game
//         'unverified' read from shared memory, not checked against the game yet
//         'mismatch'   the driver compared them with the game and they did not match
// (A reading the game leaves empty in a given session is "missing"; that is decided per session, see carreport.js.)
import * as settings from './settings.js';

/**
 * confirmable: the driver can check the readings against something the game shows (Setups → Setup recognition).
 * Built-in 'verified' groups were checked in game during development (laps, lap times and the driven line match).
 */
export const GROUPS = {
  core: { label: 'Speed, pedals, steering, gear, RPM, lap timing and position', builtIn: 'verified',
    note: 'Checked in game: recorded laps, lap times, the driven line and braking points match the game.' },
  trackLimits: { label: 'Track limits (lap valid flag, tyres off track)', builtIn: 'verified',
    note: 'Checked in game: invalid laps match the game.' },
  gforce: { label: 'Lateral and longitudinal G', builtIn: 'unverified',
    note: 'The game shows no G values to compare with. Used only for the replay G circle and to pick cornering samples.' },
  setupProbe: { label: 'Pit-box readings: tyre pressures, camber, brake bias, fuel', confirmable: true,
    note: 'Used to recognise the setup of every lap.', check: 'Load a saved setup, stand in the pit box and compare the values with that setup.' },
  conditions: { label: 'Air and track temperature', confirmable: true,
    note: 'Shown in session reports.', check: 'Compare with the temperatures the game shows for the session.' },
  tyres: { label: 'Tyre temperatures (inner, middle, outer, core) and hot pressures', confirmable: true,
    note: 'Used for camber and pressure hints in Car & setup.', check: "Compare with the game's tyre page while driving or standing still." },
  brakes: { label: 'Brake temperatures and lock-ups', confirmable: true,
    note: 'Used for brake bias and brake duct hints.', check: "Compare the brake temperatures with the game's tyre page; lock-ups you feel should show up here." },
  suspension: { label: 'Suspension travel and ride height', confirmable: true,
    note: 'Used for bump stop and ride height hints.', check: "Compare with the game's suspension readings, if your car's display shows them." },
  slip: { label: 'Slip angles and slip ratios (balance, wheelspin)', builtIn: 'unverified',
    note: 'The game shows no slip values, so they cannot be checked: understeer, oversteer and wheelspin readings stay unconfirmed.' },
  windows: { label: "The game's tyre and brake window positions", builtIn: 'unverified',
    note: 'Their meaning is not known yet.' },
};
export const CONFIRMABLE = Object.keys(GROUPS).filter((k) => GROUPS[k].confirmable);

/** The driver's checks: {group: true (matches the game) | false (does not match)}. */
function checks() {
  const s = settings.get();
  const c = { ...(s.channelChecks || {}) };
  // before 0.6 one switch ("Readings match the game") covered the pit-box readings and the temperatures
  if (s.probeConfirmed) for (const k of ['setupProbe', 'conditions']) if (!(k in c)) c[k] = true;
  return c;
}

export function status(id) {
  const g = GROUPS[id];
  if (!g) throw new Error(`Unknown telemetry group ${id}`);
  if (g.builtIn) return g.builtIn;
  const c = checks()[id];
  return c === true ? 'verified' : c === false ? 'mismatch' : 'unverified';
}
export const trusted = (id) => status(id) === 'verified';
/** Every group basis says what a conclusion rests on: true only if all of them are checked. */
export const allTrusted = (basis) => basis.every(trusted);

export const list = () => Object.entries(GROUPS).map(([id, g]) => ({ id, label: g.label, status: status(id), confirmable: !!g.confirmable, note: g.note, check: g.check || null }));
export const summary = () => Object.fromEntries(Object.keys(GROUPS).map((id) => [id, status(id)]));

/** The driver compared a group with the game: ok true = matches, false = does not, null = forget the check. */
export function confirm(id, ok) {
  if (!GROUPS[id]?.confirmable) throw new Error(`"${id}" cannot be checked against the game`);
  if (ok !== true && ok !== false && ok !== null) throw new Error('ok must be true, false or null');
  // write the old switch's meaning out first, so changing one of its two groups does not undo the other
  const c = checks();
  if (ok === null) delete c[id]; else c[id] = ok;
  const patch = { channelChecks: c };
  // keep the old switch in step, so going back to an older Paddock still shows the same state
  if (id === 'setupProbe') patch.probeConfirmed = ok === true;
  settings.update(patch);
  return status(id);
}

/** Readings the driver found wrong are not sent to the AI at all (relying on the prompt to ignore them is weaker). */
export const usable = (id) => status(id) !== 'mismatch';

/** For AI prompts: what each group's readings are worth, in words the model can use. */
export const forAi = (ids = Object.keys(GROUPS)) => Object.fromEntries(ids.map((id) => [id, {
  verified: 'confirmed in game', unverified: 'NOT confirmed in game: treat as a weak hint', mismatch: 'known to be WRONG: left out',
}[status(id)]]));
