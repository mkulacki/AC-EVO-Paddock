import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './db.js';

const FILE = path.join(DATA_DIR, 'settings.json');
const DEFAULTS = { geminiApiKey: '', geminiModel: 'gemini-2.5-flash', driverName: '', language: 'English', port: 8080,
  gamePath: '', // AC EVO folder; empty = found automatically through Steam
  hud: null }; // Paddock HUD look (see HUD_DEFAULTS); null = defaults

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

let current = { ...DEFAULTS };
try { current = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch { /* first run */ }
let hud = normHud(current.hud); // cached: sent to the HUD 20 times a second

export const get = () => current;
export const hudConfig = () => hud;
export function update(patch) {
  for (const k of Object.keys(DEFAULTS)) if (patch[k] !== undefined) current[k] = patch[k];
  if (patch.hud !== undefined) current.hud = hud = normHud(patch.hud);
  fs.writeFileSync(FILE, JSON.stringify(current, null, 2));
  return current;
}
// settings safe to send to the browser
export const publicView = () => ({ ...current, hud, geminiApiKey: current.geminiApiKey ? '••••' + current.geminiApiKey.slice(-4) : '', hasKey: !!current.geminiApiKey });
