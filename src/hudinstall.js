// Installs / updates the Paddock HUD app for the ACE UI App Loader (same layout as the loader's install_app.py):
//   <Saved Games>\ACE\mods\uiresources\ACEUIAppLoader\trainerhud\   (app files)
//   <Saved Games>\ACE\Video\ACEUIAppLoader-trainerhud.settingspreset (EMPTY marker the loader scans for)
// The app ships with Paddock (mod/trainerhud); the Mods tab compares its version with the installed one
// and offers to install or update it. Used by the Mods tab and by `npm run install-mod`.
//
// Only with the game closed: replacing the app folder while the game runs makes the HUD's next live-slot
// read fail, and a failed file open in the game's resource loader CRASHES AC EVO.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACE, APP_DIR, padLive, SLOTS } from './gamebridge.js';
import { isRunningNow } from './game.js';

const NAME = 'trainerhud';
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'mod', NAME);
const MARKER = path.join(ACE, 'Video', `ACEUIAppLoader-${NAME}.settingspreset`);
export const LOADER = path.join(ACE, 'mods', 'ACEUIAppLoader.kspkg');
export const LOADER_URL = 'https://github.com/dreasgrech/ACEUIAppLoader/releases';

const readApp = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'app.json'), 'utf8').replace(/^﻿/, '')); } catch { return null; } };
// "0.10.0" > "0.9.2"; anything unreadable counts as older
export function cmpVersion(a, b) {
  const pa = String(a || '0').split(/[.-]/).map((x) => parseInt(x, 10) || 0), pb = String(b || '0').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

/** state: 'missing' | 'outdated' | 'current' | 'newer' (installed is newer than this Paddock's copy) | 'no-game' */
// quick: skip the (slow) check whether the game runs
export function status({ quick = false } = {}) {
  const bundled = readApp(SRC)?.version ?? null;
  const installed = fs.existsSync(APP_DIR) ? readApp(APP_DIR)?.version ?? '?' : null;
  const marker = fs.existsSync(MARKER);
  let state;
  if (!fs.existsSync(ACE)) state = 'no-game';
  else if (!installed || !marker) state = 'missing';
  else { const c = cmpVersion(installed, bundled); state = c < 0 ? 'outdated' : c > 0 ? 'newer' : 'current'; }
  return { state, bundled, installed, marker, loader: fs.existsSync(LOADER), loaderUrl: LOADER_URL, gameRunning: quick ? null : isRunningNow(),
    removed: fs.existsSync(REMOVED_FLAG), autoError: lastAuto.error };
}

export class InstallError extends Error { constructor(msg, code = 400) { super(msg); this.code = code; } }

export function install({ force = false } = {}) {
  if (!fs.existsSync(ACE)) throw new InstallError(`Not found: ${ACE}. Start AC EVO once so it creates its Saved Games folder.`, 404);
  if (!force && isRunningNow()) throw new InstallError('AC EVO is running. Close the game first: replacing the HUD files while it runs can crash it.', 409);
  const app = readApp(SRC);
  if (!app) throw new InstallError(`The HUD files are missing from this Paddock (${SRC}).`, 500);
  fs.mkdirSync(APP_DIR, { recursive: true });
  // the app's own files, copied without a UTF-8 BOM (the loader parses app.json with JSON.parse);
  // the folder is not emptied, so Paddock's live-slot writer never finds it missing
  for (const f of ['app.json', ...app.styles, ...app.scripts]) {
    fs.writeFileSync(path.join(APP_DIR, f), fs.readFileSync(path.join(SRC, f), 'utf8').replace(/^﻿/, ''));
  }
  // the time-slotted data files Paddock rewrites (gamebridge.js) must always exist: a file the game cannot open crashes it
  for (let k = 0; k < SLOTS; k++) { const f = path.join(APP_DIR, `live${k}.json`); if (!fs.existsSync(f)) fs.writeFileSync(f, padLive('{}')); }
  fs.mkdirSync(path.dirname(MARKER), { recursive: true });
  fs.writeFileSync(MARKER, ''); // must stay empty: the game deserialises every file in that folder
  fs.rmSync(REMOVED_FLAG, { force: true });
  console.log(`[hud] installed Paddock HUD ${app.version} in ${APP_DIR}`);
  return status();
}

export function remove() {
  if (isRunningNow()) throw new InstallError('AC EVO is running. Close the game first.', 409);
  fs.rmSync(APP_DIR, { recursive: true, force: true });
  fs.rmSync(MARKER, { force: true });
  try { fs.writeFileSync(REMOVED_FLAG, String(Date.now())); } catch { /* data folder not writable */ }
  return status();
}

// ---------------------------------------------------------------- automatic install / update
// Paddock keeps its HUD installed and current by itself whenever the game is closed: at start, every
// AUTO_MS while it runs, and right before it launches the game. A HUD the player removed on purpose
// (tray menu "Remove") is not put back automatically; installing it again clears that.
const REMOVED_FLAG = path.join(path.resolve(process.env.ACEVO_DATA || 'data'), 'hud-removed');
const AUTO_MS = 15000;
let lastAuto = { at: 0, error: null };
export function autoUpdate(why = 'check') {
  let s;
  try {
    s = status({ quick: true });
    if (s.state !== 'missing' && s.state !== 'outdated') return s;
    if (s.state === 'missing' && fs.existsSync(REMOVED_FLAG)) return s;
    if (isRunningNow()) return s; // next time the game is closed
    s = install();
    console.log(`[hud] ${why}: Paddock HUD ${s.installed} installed automatically`);
    lastAuto = { at: Date.now(), error: null, version: s.installed };
  } catch (e) {
    if (lastAuto.error !== e.message) console.log(`[hud] automatic install failed: ${e.message}`);
    lastAuto = { at: Date.now(), error: e.message };
  }
  return s;
}
export const lastAutoInstall = () => lastAuto;
export function startAuto() {
  autoUpdate('Paddock started');
  setInterval(() => autoUpdate('game closed'), AUTO_MS).unref?.();
}
