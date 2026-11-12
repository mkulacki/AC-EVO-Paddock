// Installs the community ACE UI App Loader (github.com/dreasgrech/ACEUIAppLoader, MIT) that the Paddock HUD
// runs in, so the player has nothing to download or copy. Its unmodified release zips ship with Paddock in
// mod/ACEUIAppLoader (loader.json says which loader version and which game version they are).
//
// Paddock manages the loader: whenever the game is closed and the game version is the one the bundled loader
// was built for, a missing loader, or any loader that is not the bundled one (normal or alternate build), is
// replaced with the bundled one, and stray copies ("ACEUIAppLoader (1).kspkg") that could win over it are
// deleted. A loader the player disabled or deleted in the Mods tab is not put back automatically.
// When the game version does not match, nothing is touched: the loader is built for one game version, and a
// newer Paddock (with a newer loader) is needed. The Game and Mods tabs say so.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ACE } from './gamebridge.js';
import { gameVersion, isRunningNow } from './game.js';
import * as zip from './zip.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'mod', 'ACEUIAppLoader');
const MODS = path.join(ACE, 'mods');
export const KSPKG = path.join(MODS, 'ACEUIAppLoader.kspkg');
export const LOADER_URL = 'https://github.com/dreasgrech/ACEUIAppLoader/releases';
const REMOVED_FLAG = path.join(path.resolve(process.env.ACEVO_DATA || 'data'), 'loader-removed');
const STRAY_RE = /^aceuiapploader.*\.kspkg$/i;

export class LoaderError extends Error { constructor(msg, code = 400) { super(msg); this.code = code; } }

const bundle = () => { try { return JSON.parse(fs.readFileSync(path.join(SRC, 'loader.json'), 'utf8')); } catch { return null; } };

// hashing 69 MB takes a moment, so the answer is kept until the file changes
let hashed = { key: null, sha: null };
function installedHash() {
  const st = fs.statSync(KSPKG), key = `${st.size}:${st.mtimeMs}`;
  if (hashed.key !== key) hashed = { key, sha: crypto.createHash('sha256').update(fs.readFileSync(KSPKG)).digest('hex') };
  return hashed.sha;
}
const strays = () => { try { return fs.readdirSync(MODS).filter((f) => STRAY_RE.test(f) && f.toLowerCase() !== 'aceuiapploader.kspkg'); } catch { return []; } };

let lastAuto = { at: 0, error: null };

/** state: 'current' | 'missing' | 'other' (not the bundled loader) | 'no-game' | 'no-bundle' */
export function status() {
  const b = bundle(), game = gameVersion(), present = fs.existsSync(KSPKG);
  let variant = null;
  if (present && b) { try { const h = installedHash(); variant = Object.keys(b.variants).find((k) => b.variants[k].sha256 === h) || 'other'; } catch { variant = 'other'; } }
  let state;
  if (!fs.existsSync(ACE)) state = 'no-game';
  else if (!b) state = 'no-bundle';
  else if (!present) state = 'missing';
  else state = variant === 'other' ? 'other' : 'current';
  return { state, installed: present, variant, bundled: b?.version ?? null, builtFor: b?.game ?? null, game,
    gameMatch: game && b ? game === b.game : null, strays: strays(), removed: fs.existsSync(REMOVED_FLAG), autoError: lastAuto.error, url: LOADER_URL };
}

export function install({ force = false } = {}) {
  if (!fs.existsSync(ACE)) throw new LoaderError(`Not found: ${ACE}. Start AC EVO once so it creates its Saved Games folder.`, 404);
  if (!force && isRunningNow()) throw new LoaderError('AC EVO is running. Close the game first: replacing mod files while it runs can crash it.', 409);
  const b = bundle();
  if (!b) throw new LoaderError(`The ACE UI App Loader is missing from this Paddock (${SRC}).`, 500);
  const game = gameVersion();
  if (game && game !== b.game) throw new LoaderError(`The ACE UI App Loader in this Paddock (${b.version}) is built for AC EVO ${b.game}, but the game is ${game}. Update Paddock, or install the matching loader from ${LOADER_URL}.`, 409);
  const zipFile = path.join(SRC, b.variants.normal.zip);
  for (const e of zip.list(zipFile)) {
    if (e.dir) continue;
    const rel = e.name.split('/');
    if (rel[0] !== 'mods' || rel.includes('..')) continue;
    const dest = path.join(ACE, ...rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (/\.kspkg$/i.test(e.name)) {
      // unpacked next to it first, so a failure never leaves a half-written loader behind
      const tmp = `${dest}.paddock-tmp`;
      try { zip.extractSync(zipFile, e, tmp); fs.renameSync(tmp, dest); }
      finally { fs.rmSync(tmp, { force: true }); }
    } else if (!fs.existsSync(dest)) {
      zip.extractSync(zipFile, e, dest); // the loader's "PUT APPS HERE" note
    }
  }
  for (const f of strays()) { try { fs.rmSync(path.join(MODS, f)); console.log(`[loader] deleted the extra copy ${f}`); } catch (e) { console.log(`[loader] could not delete ${f}: ${e.message}`); } }
  fs.rmSync(REMOVED_FLAG, { force: true });
  console.log(`[loader] installed ACE UI App Loader ${b.version} in ${KSPKG}`);
  return status();
}

// the Mods tab calls this when the player disables / deletes the loader (true) or enables it again (false)
export function setRemoved(on) {
  try { if (on) fs.writeFileSync(REMOVED_FLAG, String(Date.now())); else fs.rmSync(REMOVED_FLAG, { force: true }); } catch { /* data folder not writable */ }
}

// called from hudinstall.autoUpdate: at start, every 15 s while Paddock runs, and right before it starts the game
export function autoUpdate(why = 'check') {
  let s;
  try {
    s = status();
    if (s.state === 'no-game' || s.state === 'no-bundle' || s.removed) return s;
    if (s.state === 'current' && !s.strays.length) return s;
    if (s.gameMatch === false) return s; // the bundled loader is for another game version
    if (isRunningNow()) return s;
    s = install();
    lastAuto = { at: Date.now(), error: null };
    console.log(`[loader] ${why}: ACE UI App Loader ${s.bundled} installed automatically`);
  } catch (e) {
    if (lastAuto.error !== e.message) console.log(`[loader] automatic install failed: ${e.message}`);
    lastAuto = { at: Date.now(), error: e.message };
    s = { ...(s || {}), autoError: e.message };
  }
  return s;
}
