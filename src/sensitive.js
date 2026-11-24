// The one list of private values Paddock keeps (PL1): which settings and saved-server fields are secrets or sign-in
// data, and how each kind of output treats them. Used by backups (src/backup.js), restores (src/restore-apply.js),
// diagnostics (src/diagnostics.js), the page's view of the settings (src/settings.js) and the settings route
// (src/server.js). No imports: src/restore-apply.js runs before the database is opened and cannot load app modules.
//
//   secret     a value that must never leave this PC by accident (Gemini key, saved server passwords)
//   sign-in    the leaderboard login and who it belongs to: never in any backup, and a restore never brings it back
//              (decision OD-PL-1: a restore signs the leaderboard out; one Steam sign-in renews it)

// settings.json fields: kind, the value a stripped copy gets, and
// page: what the browser gets (src/settings.js publicView): 'masked' (last 4 characters), 'hidden', or 'shown'
// (boardSteam is the driver's own name and Steam id, shown on the Leaderboards page).
export const SETTINGS_FIELDS = {
  geminiApiKey: { kind: 'secret', empty: '', page: 'masked' },
  boardToken: { kind: 'sign-in', empty: '', page: 'hidden' },
  boardSteam: { kind: 'sign-in', empty: null, page: 'shown' },
};
/** race.json: every field with this name, at any depth (saved servers, presets, the last setup), is a secret. */
export const RACE_SECRET_KEY = 'password';

/** Settings fields the page may never set through /api/settings (the Steam sign-in sets them). */
export const SIGN_IN_FIELDS = Object.keys(SETTINGS_FIELDS).filter((k) => SETTINGS_FIELDS[k].kind === 'sign-in');
export const SECRET_SETTINGS = Object.keys(SETTINGS_FIELDS).filter((k) => SETTINGS_FIELDS[k].kind === 'secret');

const walk = (o, fn) => {
  if (Array.isArray(o)) o.forEach((x) => walk(x, fn));
  else if (o && typeof o === 'object') for (const k of Object.keys(o)) { if (k === RACE_SECRET_KEY) fn(o, k); else walk(o[k], fn); }
};

/**
 * A copy of settings for a backup: the sign-in always goes; the secrets go unless keepSecrets.
 * Missing fields stay missing (a legacy file without them is not given new keys).
 */
export function stripSettings(obj, { keepSecrets = false } = {}) {
  const out = obj && typeof obj === 'object' && !Array.isArray(obj) ? { ...obj } : {};
  for (const [k, f] of Object.entries(SETTINGS_FIELDS)) {
    if (!(k in out)) continue;
    if (f.kind === 'sign-in' || !keepSecrets) out[k] = f.empty;
  }
  return out;
}

/** A copy of race.json with every saved password emptied (unless keepSecrets). */
export function stripRace(obj, { keepSecrets = false } = {}) {
  const out = structuredClone(obj ?? {});
  if (!keepSecrets) walk(out, (o, k) => { o[k] = ''; });
  return out;
}

/** The secret values in race.json (non-empty passwords), e.g. to take out of a diagnostics report. */
export function raceSecrets(obj) {
  const out = [];
  walk(obj, (o, k) => { if (o[k]) out.push(String(o[k])); });
  return out;
}

/** Settings as the page may see them: secrets masked, the token left out. */
export function pageView(s) {
  const out = { ...s };
  for (const [k, f] of Object.entries(SETTINGS_FIELDS)) {
    if (f.page === 'hidden') out[k] = undefined;
    else if (f.page === 'masked') out[k] = s?.[k] ? '••••' + String(s[k]).slice(-4) : '';
  }
  return out;
}

/** The secret / sign-in values in settings, as strings (for redaction). */
export function settingsSecrets(s) {
  return [s?.geminiApiKey, s?.boardToken].filter((v) => typeof v === 'string' && v);
}

/**
 * settings.json brought back by a restore, merged with the current one:
 * - secrets the backup left out (empty or missing) are kept from the current file;
 * - the sign-in is never taken from the backup and is cleared (OD-PL-1): the driver signs in with Steam again.
 */
export function mergeRestoredSettings(restored, current) {
  const out = restored && typeof restored === 'object' && !Array.isArray(restored) ? { ...restored } : {};
  for (const [k, f] of Object.entries(SETTINGS_FIELDS)) {
    if (f.kind === 'sign-in') out[k] = f.empty;
    else if (!out[k] && current?.[k]) out[k] = current[k];
  }
  return out;
}
