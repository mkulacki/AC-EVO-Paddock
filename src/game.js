// Game tab + Race tab launches: is AC EVO running, which version, are the loader / Paddock HUD installed,
// and starting the game with an order (scan the catalogue, a Solo session, or joining a server) that the
// Paddock HUD carries out in game on the menu / Solo / multiplayer pages.
import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { ACE, APP_DIR, LOG_DIR, SLOTS, slotFile } from './gamebridge.js';

const EXE = 'AssettoCorsaEVO.exe';
const STEAM_APP_ID = 3058630;
const ORDER_TTL_MS = 10 * 60 * 1000;

let running = { value: false, at: 0 };
const launch = { order: null, events: [] };

function checkRunning() {
  if (Date.now() - running.at < 2000) return running.value;
  running.at = Date.now();
  execFile('tasklist', ['/FI', `IMAGENAME eq ${EXE}`, '/NH', '/FO', 'CSV'], { windowsHide: true }, (err, out) => {
    running.value = !err && out.toLowerCase().includes(EXE.toLowerCase());
  });
  return running.value;
}
checkRunning();

function gameVersion() {
  try {
    const newest = fs.readdirSync(LOG_DIR).filter((f) => /^log-.*\.txt$/.test(f))
      .map((f) => ({ f, t: fs.statSync(path.join(LOG_DIR, f)).mtimeMs })).sort((a, b) => b.t - a.t)[0];
    if (!newest) return null;
    const fd = fs.openSync(path.join(LOG_DIR, newest.f), 'r');
    const buf = Buffer.alloc(8192); const n = fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd);
    return buf.toString('utf8', 0, n).match(/version (\S+?),/)?.[1] ?? null;
  } catch { return null; }
}

function installed() {
  const loader = path.join(ACE, 'mods', 'ACEUIAppLoader.kspkg');
  let hudVersion = null;
  try { hudVersion = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'app.json'), 'utf8')).version; } catch { /* not installed */ }
  let liveAgeMs = null;
  try { liveAgeMs = Math.min(...Array.from({ length: SLOTS }, (_, k) => Date.now() - fs.statSync(slotFile(k)).mtimeMs)); } catch { /* none */ }
  return { loader: fs.existsSync(loader), hudVersion, liveAgeMs };
}

export function onLaunchEvent(e) {
  launch.events.push({ ...e, at: Date.now() });
  if (launch.events.length > 40) launch.events.shift();
  console.log(`[launch] ${e.step}${e.msg ? ': ' + e.msg : ''}`);
  // finished: the order must not be carried out again (e.g. when the player is back on the menu)
  if (e.step === 'started' || e.step === 'scandone' || e.step === 'probed') launch.done = launch.order?.issued ?? null;
}

const live = () => (launch.order && Date.now() - launch.order.issued < ORDER_TTL_MS && launch.done !== launch.order.issued ? launch.order : null);
// the launch order travels to the game inside the live slot files (see gamebridge.js)
export const currentOrder = live;

export function status() {
  const o = live();
  return { running: checkRunning(), version: gameVersion(), ...installed(),
    launch: { order: o ? { kind: o.kind, summary: o.summary, issued: o.issued } : null, events: launch.events.slice(-14) } };
}

// a fresh answer before starting anything (the cached one may predate the first tasklist reply)
export function isRunningNow() { return runningNow(); }
function runningNow() {
  try {
    const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${EXE}`, '/NH', '/FO', 'CSV'], { windowsHide: true, encoding: 'utf8' });
    running.value = out.toLowerCase().includes(EXE.toLowerCase()); running.at = Date.now();
  } catch { /* keep the cached value */ }
  return running.value;
}

// order: null = just start the game; otherwise {kind: 'scan'|'probe'|'solo'|'mp', ...} for the in-game launcher
export function start(order) {
  const isRunning = runningNow();
  if (order) {
    launch.order = { ...order, issued: Date.now(), ttlMs: ORDER_TTL_MS };
    launch.events = [];
  } else {
    launch.order = null;
  }
  const what = !order ? '' : order.kind === 'scan' || order.kind === 'probe' ? 'the game check' : order.kind === 'mp' ? 'joining the server' : 'the session';
  if (isRunning) {
    return { started: false, msg: order ? `AC EVO is already running: go to the main menu and the Paddock HUD starts ${what}.` : 'AC EVO is already running.' };
  }
  // Steam starts the game (same as pressing Play in the library)
  spawn('cmd', ['/c', 'start', '', `steam://rungameid/${STEAM_APP_ID}`], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  running.at = 0;
  return { started: true, msg: order ? `Starting AC EVO, then ${what}…` : 'Starting AC EVO…' };
}

export function cancel() {
  launch.order = null;
}
