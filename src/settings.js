import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './db.js';

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
  channelChecks: null }; // per telemetry group, whether the readings match the game: {group: true|false} (src/channels.js)

// Paddock HUD (in game and desktop overlay): which parts are shown, its size and background opacity
export const HUD_PARTS = ['lap', 'ref', 'delta', 'current', 'speed', 'predicted', 'best', 'session', 'last', 'cues', 'ideal', 'corners', 'footer',
  'shift', 'inputs', 'sectors', 'fuel'];
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

let current = { ...DEFAULTS };
try { current = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch { /* first run */ }
let hud = normHud(current.hud); // cached: sent to the HUD 20 times a second
let spotter = normSpotter(current.spotter); // cached: read 60 times a second

export const get = () => current;
export const hudConfig = () => hud;
export const spotterConfig = () => spotter;
export function update(patch) {
  for (const k of Object.keys(DEFAULTS)) if (patch[k] !== undefined) current[k] = patch[k];
  if (patch.hud !== undefined) current.hud = hud = normHud(patch.hud);
  if (patch.spotter !== undefined) current.spotter = spotter = normSpotter({ ...spotter, ...patch.spotter });
  fs.writeFileSync(FILE, JSON.stringify(current, null, 2));
  return current;
}
// settings safe to send to the browser
export const publicView = () => ({ ...current, hud, spotter, geminiApiKey: current.geminiApiKey ? '••••' + current.geminiApiKey.slice(-4) : '', hasKey: !!current.geminiApiKey });
