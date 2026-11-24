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
  boardSteam: null }; // who that sign-in is: {steamId, name}

// Paddock HUD (in game and desktop overlay): which parts are shown, its size and background opacity
export const HUD_PARTS = ['lap', 'ref', 'delta', 'current', 'speed', 'predicted', 'best', 'session', 'last', 'cues', 'ideal', 'corners', 'footer',
  'shift', 'inputs', 'sectors', 'fuel', 'target', 'board'];
const HUD_OFF = new Set(['speed']);
export const HUD_DEFAULTS = { parts: Object.fromEntries(HUD_PARTS.map((k) => [k, !HUD_OFF.has(k)])), scale: 100, opacity: 85 };
const clampNum = (v, lo, hi, d) => (v !== null && v !== '' && Number.isFinite(+v) ? Math.max(lo, Math.min(hi, Math.round(+v))) : d);
function normHud(h) {
  const parts = { ...HUD_DEFAULTS.parts };
  for (const k of HUD_PARTS) if (typeof h?.parts?.[k] === 'boolean') parts[k] = h.parts[k];
  return { parts, scale: clampNum(h?.scale, 60, 160, HUD_DEFAULTS.scale), opacity: clampNum(h?.opacity, 0, 100, HUD_DEFAULTS.opacity) };
}

// audio brake spotter: voice clips or beeps counting down to the reference lap's brake points
// sound: a voice (clips in public/audio/spotter/<voice>/) or 'beep'
export const SPOTTER_VOICES = ['orus', 'algenib'];
// points: 'best' = the HUD reference lap's brake points, 'mine' = the driver's own marks (only those)
export const SPOTTER_DEFAULTS = { on: false, sound: 'orus', volume: 80, countdown: 'full', corners: 'all', offsetMs: 0, points: 'best' };
const pick = (v, allowed, d) => (allowed.includes(v) ? v : d);
function normSpotter(p) {
  const D = SPOTTER_DEFAULTS;
  return { on: typeof p?.on === 'boolean' ? p.on : D.on, sound: pick(p?.sound === 'voice' ? 'orus' : p?.sound, [...SPOTTER_VOICES, 'beep'], D.sound),
    volume: clampNum(p?.volume, 0, 100, D.volume), countdown: pick(p?.countdown, ['full', 'brake'], D.countdown),
    corners: pick(p?.corners, ['all', 'big'], D.corners), offsetMs: clampNum(p?.offsetMs, -500, 500, D.offsetMs),
    points: pick(p?.points, ['best', 'mine'], D.points) };
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
  const now = fileIssues(DATA_DIR).filter((x) => OWN_FILES.includes(x.file))
    .map((x) => ({ file: x.file, state: x.state, damaged: x.damaged, keptAs: x.keptAs, at: x.at, savesRefused: x.state === 'failed' }));
  const shown = new Set(now.map((x) => x.keptAs).filter(Boolean));
  let names = [];
  try { names = fs.readdirSync(DATA_DIR); } catch { /* no data folder yet */ }
  const earlier = names.filter((n) => KEPT.test(n) && !shown.has(n)).map((n) => {
    const m = KEPT.exec(n);
    return { file: `${m[1]}.json`, state: 'earlier', damaged: true, keptAs: n, at: Number(m[2]), savesRefused: false };
  });
  return [...now, ...earlier.sort((a, b) => b.at - a.at)].slice(0, 10);
}

// settings safe to send to the browser
export const publicView = () => ({ ...pageView(current), hud, spotter, hasKey: !!current.geminiApiKey });
