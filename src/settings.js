import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './db.js';
import { pageView } from './sensitive.js';
import { loadJson, writeJsonAtomic, notSaved, fileIssues } from './jsonfile.js';

const FILE = path.join(DATA_DIR, 'settings.json');
const DEFAULTS = { geminiApiKey: '', geminiModel: 'gemini-2.5-flash', driverName: '', language: 'English', port: 8080,
  gamePath: '', // AC EVO folder; empty = found automatically through Steam
  aceDir: '', // AC EVO's user folder (Saved Games\ACE); empty = found automatically. Read at start, so a change needs a restart
  hud: null, // Paddock HUD look (see HUD_DEFAULTS); null = defaults
  spotter: null, // audio brake spotter (see SPOTTER_DEFAULTS); null = defaults
  markButton: null, // wheel button that marks a brake point: {vid, pid, nth, button, name}; null = none
  markKey: '', // keyboard shortcut (Electron accelerator) that marks a brake point, desktop app only
  probeConfirmed: false, // the driver checked in game that the setup fingerprint / temperatures read right (Setups tab; before 0.6)
  openLastSession: true, // desktop app: when AC EVO closes, bring Paddock to the front on the session just driven (src/server.js)
  updateCheck: true, // once a day, ask GitHub whether a newer Paddock is out (nothing is downloaded; src/updates.js)
  channelChecks: null, // per telemetry group, whether the readings match the game: {group: true|false} (src/channels.js)
  boardShare: false, // send the best lap per track / car to the online leaderboard (src/leaderboard.js)
  boardAuto: true, // with sharing on: send right after each lap (off = only with Send now)
  boardTel: true, // send the light telemetry of shared laps too (others can compare with them)
  boardTarget: 'next', // the HUD's leaderboard target: 'next' (the driver just ahead), 'p1' or 'off'
  boardUrl: '', // leaderboard server; empty = the default
  boardToken: '', // Steam sign-in on the leaderboard: the login token (secret: never sent to the page)
  boardSteam: null, // who that sign-in is: {steamId, name}
  assistOff: false, // PL9 kill switch: the Paddock HUD and every cue (spotter countdowns) off at once, until switched on again
  assistKey: '', // desktop app: global shortcut (Electron accelerator) for that switch; empty = none (opt-in, like markKey)
  hudLayouts: null, // PL9 saved HUD layouts and context profiles (see normLayouts); null = none saved, no automatic switch
  onboarding: null }; // the setup guide (src/onboarding.js): {state: 'done' | 'dismissed', at, skipped}; null = not finished

// Paddock HUD (in game and desktop overlay): which parts are shown, its size and background opacity
// PL9: 'summary' (post-lap summary) and 'consistency' (lap-time spread) are new and off by default (OD-PL-55, OD-PL-56)
export const HUD_PARTS = ['lap', 'ref', 'delta', 'current', 'speed', 'predicted', 'best', 'session', 'last', 'cues', 'ideal', 'corners', 'footer',
  'shift', 'inputs', 'sectors', 'fuel', 'target', 'board', 'summary', 'consistency'];
const HUD_OFF = new Set(['speed', 'summary', 'consistency']);
// cueHoldMs: how long the HUD shows "braked 6 m later" / "throttle 4 m earlier" after a corner (PL9; 6 s as before)
export const HUD_DEFAULTS = { parts: Object.fromEntries(HUD_PARTS.map((k) => [k, !HUD_OFF.has(k)])), scale: 100, opacity: 85, cueHoldMs: 6000 };
const clampNum = (v, lo, hi, d) => (v !== null && v !== '' && Number.isFinite(+v) ? Math.max(lo, Math.min(hi, Math.round(+v))) : d);
function normHud(h) {
  const parts = { ...HUD_DEFAULTS.parts };
  for (const k of HUD_PARTS) if (typeof h?.parts?.[k] === 'boolean') parts[k] = h.parts[k];
  return { parts, scale: clampNum(h?.scale, 60, 160, HUD_DEFAULTS.scale), opacity: clampNum(h?.opacity, 0, 100, HUD_DEFAULTS.opacity),
    cueHoldMs: clampNum(h?.cueHoldMs, 2000, 10000, HUD_DEFAULTS.cueHoldMs) };
}

// PL9 HUD layouts: named looks (parts, size, background) the driver applies in one go, and context profiles that
// apply one when a session of a given type starts (off by default, OD-PL-54). Built-in layouts are not stored.
const only = (on) => Object.fromEntries(HUD_PARTS.map((k) => [k, on.includes(k)]));
export const HUD_PRESETS = {
  Default: { parts: HUD_DEFAULTS.parts, scale: 100, opacity: 85 },
  Minimal: { parts: only(['lap', 'ref', 'delta', 'current', 'cues', 'footer']), scale: 100, opacity: 85 },
  Race: { parts: only(['lap', 'ref', 'delta', 'current', 'predicted', 'last', 'shift', 'inputs', 'sectors', 'fuel', 'target', 'board', 'footer']), scale: 100, opacity: 85 },
};
export const SESSION_CONTEXTS = ['0', '1', '2', '3']; // AC EVO session types (src/compat.js SESSION_TYPES)
export const MAX_LAYOUTS = 12;
// eslint-disable-next-line no-control-regex
const layoutName = (n) => (typeof n === 'string' ? n.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40) : '');
/** Saved layouts and context profiles, as far as they are valid: {list: [{name, parts, scale, opacity}], auto, byType}. */
export function normLayouts(x) {
  const list = [];
  for (const l of Array.isArray(x?.list) ? x.list : []) {
    const name = layoutName(l?.name);
    if (!name || HUD_PRESETS[name] || list.some((o) => o.name === name) || list.length >= MAX_LAYOUTS) continue;
    const h = normHud(l);
    list.push({ name, parts: h.parts, scale: h.scale, opacity: h.opacity });
  }
  const names = new Set([...Object.keys(HUD_PRESETS), ...list.map((l) => l.name)]);
  const byType = {};
  for (const t of SESSION_CONTEXTS) { const n = layoutName(x?.byType?.[t]); byType[t] = names.has(n) ? n : ''; }
  return { list, auto: x?.auto === true, byType };
}
export const cleanLayoutName = layoutName;

// audio brake spotter: voice clips or beeps counting down to the reference lap's brake points
// sound: a voice (clips in public/audio/spotter/<voice>/) or 'beep'
export const SPOTTER_VOICES = ['orus', 'algenib'];
// points: 'best' = the HUD reference lap's brake points, 'mine' = the driver's own marks (only those)
// cooldownMs (PL9): the least time between two spoken cues; 0 = none (as before). It can only drop cues, never add any.
export const SPOTTER_DEFAULTS = { on: false, sound: 'orus', volume: 80, countdown: 'full', corners: 'all', offsetMs: 0, points: 'best', cooldownMs: 0 };
const pick = (v, allowed, d) => (allowed.includes(v) ? v : d);
function normSpotter(p) {
  const D = SPOTTER_DEFAULTS;
  return { on: typeof p?.on === 'boolean' ? p.on : D.on, sound: pick(p?.sound === 'voice' ? 'orus' : p?.sound, [...SPOTTER_VOICES, 'beep'], D.sound),
    volume: clampNum(p?.volume, 0, 100, D.volume), countdown: pick(p?.countdown, ['full', 'brake'], D.countdown),
    corners: pick(p?.corners, ['all', 'big'], D.corners), offsetMs: clampNum(p?.offsetMs, -500, 500, D.offsetMs),
    points: pick(p?.points, ['best', 'mine'], D.points), cooldownMs: clampNum(p?.cooldownMs, 0, 3000, D.cooldownMs) };
}

// A file from disk (or brought back by a restore) is trusted only as far as the types go: each known setting with a
// value of the wrong kind gets its default; unknown keys are kept as they are (a newer Paddock may have written them).
export function normalize(raw) {
  const out = { ...DEFAULTS, ...raw };
  for (const [k, d] of Object.entries(DEFAULTS)) {
    const v = out[k];
    if (typeof d === 'string') { if (typeof v !== 'string') out[k] = d; }
    else if (typeof d === 'boolean') { if (typeof v !== 'boolean') out[k] = d; }
    else if (typeof d === 'number') out[k] = v !== null && v !== '' && Number.isFinite(+v) ? +v : d;
    else if (d === null && v !== null && (typeof v !== 'object' || Array.isArray(v))) out[k] = null;
  }
  return out;
}

// missing = first run; damaged = kept aside as settings.json.unreadable-<time>, defaults used; could not be read at all
// (locked by antivirus / OneDrive, after retries) = defaults in memory, and the file is not saved over (canSave false)
const loaded = loadJson(FILE, {});
let canSave = loaded.canSave;
let current = normalize(loaded.value);
let hud = normHud(current.hud); // cached: sent to the HUD 20 times a second
let spotter = normSpotter(current.spotter); // cached: read 60 times a second

export const get = () => current;
export const hudConfig = () => hud;
export const spotterConfig = () => spotter;
/** Saves a change. The values in memory change only once the file is written; a failed write throws and changes nothing. */
export function update(patch) {
  if (!canSave) {
    // the file could not be read at start: try again now, and never write over it while it holds unread settings
    const again = loadJson(FILE, {}, { retries: 2 });
    if (!again.canSave) throw notSaved(FILE);
    canSave = true;
    if (again.state === 'ok') { current = normalize(again.value); hud = normHud(current.hud); spotter = normSpotter(current.spotter); }
  }
  const next = { ...current };
  for (const k of Object.keys(DEFAULTS)) if (patch[k] !== undefined) next[k] = patch[k];
  const nextHud = patch.hud !== undefined ? normHud(patch.hud) : hud;
  const nextSpotter = patch.spotter !== undefined ? normSpotter({ ...spotter, ...patch.spotter }) : spotter;
  if (patch.hud !== undefined) next.hud = nextHud;
  if (patch.hudLayouts !== undefined) next.hudLayouts = patch.hudLayouts === null ? null : normLayouts(patch.hudLayouts);
  if (patch.spotter !== undefined) next.spotter = nextSpotter;
  writeJsonAtomic(FILE, next); // temp file + rename: a crash never leaves half a file
  current = next; hud = nextHud; spotter = nextSpotter;
  return current;
}
/** false while settings.json could not be read and is protected from being saved over. */
export const saveable = () => canSave;
// The driver's own files in data\ that Paddock keeps aside when damaged (src/jsonfile.js; read by src/settings.js,
// src/race.js, src/setups.js).
export const OWN_FILES = ['settings.json', 'race.json', 'setup-meta.json'];
const KEPT = /^(settings|race|setup-meta)\.json\.unreadable-(\d{1,15})$/;
/**
 * For the Settings page (decision OD-PL-5): the driver's files that were damaged or could not be read. -> [{file, state,
 * damaged, keptAs, at, savesRefused}], newest first, at most 10. state: 'aside' / 'failed' (this run, src/jsonfile.js)
 * or 'earlier' (a damaged copy from an earlier run is still in data\). Names only: no folder, nothing from the file.
 */
export function fileNotices() {
  let names = [];
  try { names = fs.readdirSync(DATA_DIR); } catch { /* no data folder yet */ }
  const onDisk = new Set(names.filter((n) => KEPT.test(n)));
  const hidden = dismissed();
  // a copy the driver deleted or dismissed is not shown again; a notice without a copy (could not be read) always is
  const now = fileIssues(DATA_DIR).filter((x) => OWN_FILES.includes(x.file) && (!x.keptAs || (onDisk.has(x.keptAs) && !hidden.has(x.keptAs))))
    .map((x) => ({ file: x.file, state: x.state, damaged: x.damaged, keptAs: x.keptAs, at: x.at, savesRefused: x.state === 'failed' }));
  const shown = new Set(now.map((x) => x.keptAs).filter(Boolean));
  const earlier = [...onDisk].filter((n) => !shown.has(n) && !hidden.has(n)).map((n) => {
    const m = KEPT.exec(n);
    return { file: `${m[1]}.json`, state: 'earlier', damaged: true, keptAs: n, at: Number(m[2]), savesRefused: false };
  });
  return [...now, ...earlier.sort((a, b) => b.at - a.at)].slice(0, 10);
}

// Dismissed notices (user decision B, 2026-11-24): the names of kept copies the driver chose not to be told about
// again, in data\notices-dismissed.json (names only, no secret). A new damaged copy has a new name, so it is shown.
const DISMISSED_FILE = path.join(DATA_DIR, 'notices-dismissed.json');
// Read once and kept in memory (GET /api/settings asks every time the page opens), refreshed on every write. Read
// directly, not through loadJson: it is not one of the driver's files, so an unreadable one is not a Settings notice;
// it only means nothing is dismissed (logged once).
let dismissedCache = null;
function dismissed() {
  if (!dismissedCache) {
    let v = null;
    try { v = JSON.parse(fs.readFileSync(DISMISSED_FILE, 'utf8').replace(/^\uFEFF/, '')); } catch (e) {
      if (e.code !== 'ENOENT') console.error(`[data] ${path.basename(DISMISSED_FILE)} cannot be read (${e.code || 'damaged'}): no notice is dismissed`);
    }
    dismissedCache = new Set(Array.isArray(v?.copies) ? v.copies.filter((n) => typeof n === 'string' && KEPT.test(n)) : []);
  }
  return new Set(dismissedCache);
}
/** A kept copy named by the page: only `<own file>.unreadable-<time>` directly in data\, and it must exist as a file. */
function keptCopy(name) {
  if (typeof name !== 'string' || !KEPT.test(name) || path.basename(name) !== name) throw Object.assign(new Error('Not a damaged copy Paddock kept'), { code: 400 });
  const file = path.join(DATA_DIR, name);
  let st; try { st = fs.lstatSync(file); } catch { throw Object.assign(new Error('That copy is no longer there'), { code: 404 }); }
  if (!st.isFile()) throw Object.assign(new Error('Not a damaged copy Paddock kept'), { code: 400 });
  return file;
}
// Saved whatever canSave says: canSave guards settings.json, and this is a separate file with names only.
function saveDismissed(set) {
  let names = [];
  try { names = fs.readdirSync(DATA_DIR); } catch { /* none */ }
  const copies = [...set].filter((n) => names.includes(n)); // copies that are gone drop out
  writeJsonAtomic(DISMISSED_FILE, { copies });
  dismissedCache = new Set(copies);
}
/** Hide the notice about one kept copy for good. */
export function dismissNotice(name) {
  keptCopy(name);
  const set = dismissed(); set.add(name); saveDismissed(set);
}
/** Delete one kept copy (never a live settings.json / race.json / setup-meta.json: the name must be a kept copy's). */
export function deleteKeptCopy(name) {
  fs.rmSync(keptCopy(name));
  const set = dismissed(); if (set.delete(name)) saveDismissed(set);
}

// settings safe to send to the browser
export const publicView = () => ({ ...pageView(current), hud, spotter, hudLayouts: normLayouts(current.hudLayouts), hudPresets: Object.keys(HUD_PRESETS),
  hasKey: !!current.geminiApiKey });
