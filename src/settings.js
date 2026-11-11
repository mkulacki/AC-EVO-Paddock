import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './db.js';

const FILE = path.join(DATA_DIR, 'settings.json');
const DEFAULTS = { geminiApiKey: '', geminiModel: 'gemini-2.5-flash', driverName: '', language: 'English', port: 8080,
  gamePath: '' }; // AC EVO folder; empty = found automatically through Steam

let current = { ...DEFAULTS };
try { current = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch { /* first run */ }

export const get = () => current;
export function update(patch) {
  for (const k of Object.keys(DEFAULTS)) if (patch[k] !== undefined) current[k] = patch[k];
  fs.writeFileSync(FILE, JSON.stringify(current, null, 2));
  return current;
}
// settings safe to send to the browser
export const publicView = () => ({ ...current, geminiApiKey: current.geminiApiKey ? '••••' + current.geminiApiKey.slice(-4) : '', hasKey: !!current.geminiApiKey });
