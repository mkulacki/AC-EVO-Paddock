// Installs the Paddock HUD app for the ACE UI App Loader (same layout as the loader's install_app.py):
//   <Saved Games>\ACE\mods\uiresources\ACEUIAppLoader\trainerhud\   (app files)
//   <Saved Games>\ACE\Video\ACEUIAppLoader-trainerhud.settingspreset (EMPTY marker the loader scans for)
// Usage: npm run install-mod            install / update
//        npm run install-mod -- --remove
// ACE_DIR overrides the "Saved Games\ACE" folder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { padLive, SLOTS } from '../gamebridge.js';

const NAME = 'trainerhud';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = path.join(ROOT, 'mod', NAME);
const ACE = process.env.ACE_DIR || path.join(os.homedir(), 'Saved Games', 'ACE');
const DEST = path.join(ACE, 'mods', 'uiresources', 'ACEUIAppLoader', NAME);
const MARKER = path.join(ACE, 'Video', `ACEUIAppLoader-${NAME}.settingspreset`);
const LOADER = path.join(ACE, 'mods', 'ACEUIAppLoader.kspkg');

if (!fs.existsSync(ACE)) {
  console.error(`Not found: ${ACE}\nStart AC EVO once, or set ACE_DIR to your "Saved Games\\ACE" folder.`);
  process.exit(1);
}

// Replacing the app folder while the game runs makes the HUD's next live-slot read fail, and a failed
// file open in the game's resource loader CRASHES AC EVO. So: only with the game closed.
{
  const { execFileSync } = await import('node:child_process');
  let out = '';
  try { out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq AssettoCorsaEVO.exe', '/NH', '/FO', 'CSV'], { encoding: 'utf8', windowsHide: true }); } catch { /* no tasklist */ }
  if (out.toLowerCase().includes('assettocorsaevo.exe') && !process.argv.includes('--force')) {
    console.error('AC EVO is running. Close the game first: replacing the HUD files while it runs can crash it.');
    process.exit(1);
  }
}

if (process.argv.includes('--remove')) {
  fs.rmSync(DEST, { recursive: true, force: true });
  fs.rmSync(MARKER, { force: true });
  console.log(`Removed ${DEST}\nRemoved ${MARKER}`);
  process.exit(0);
}

const app = JSON.parse(fs.readFileSync(path.join(SRC, 'app.json'), 'utf8').replace(/^﻿/, '')); // tolerate a BOM
fs.rmSync(DEST, { recursive: true, force: true });
fs.mkdirSync(DEST, { recursive: true });
// copied without a UTF-8 BOM: the loader parses app.json with JSON.parse
for (const f of ['app.json', ...app.styles, ...app.scripts]) {
  fs.writeFileSync(path.join(DEST, f), fs.readFileSync(path.join(SRC, f), 'utf8').replace(/^﻿/, ''));
}
// the time-slotted data files Paddock rewrites (see src/gamebridge.js); they must always exist,
// because a file the game cannot open crashes it
for (let k = 0; k < SLOTS; k++) fs.writeFileSync(path.join(DEST, `live${k}.json`), padLive('{}'));
fs.mkdirSync(path.dirname(MARKER), { recursive: true });
fs.writeFileSync(MARKER, ''); // must stay empty: the game deserialises every file in that folder

console.log(`Installed Paddock HUD ${app.version}\n  app:    ${DEST}\n  marker: ${MARKER}`);
if (!fs.existsSync(LOADER)) {
  console.warn(`\nWARNING: the ACE UI App Loader is not installed (${LOADER} missing).
Download it from https://github.com/dreasgrech/ACEUIAppLoader/releases and follow its install steps,
otherwise the game will not load this app.`);
}
console.log('\nIn game: open the loader\'s app drawer and enable "Paddock HUD". Escape + resume reloads the HUD.');
