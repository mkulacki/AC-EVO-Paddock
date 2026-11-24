// Smoke test of the packaged desktop app (CLAUDE.md release step 6), as `npm run smoke:packaged`.
//   npm run smoke:packaged             tests the existing build in dist/win-unpacked
//   npm run smoke:packaged -- --build  builds it first (rm -rf dist, npx electron-builder --win dir; never deploys)
// Starts "AC EVO Paddock.exe" with a scratch ACEVO_DATA and ACE_DIR (nothing is written to the build, to data\ or
// to Saved Games\ACE), checks http://127.0.0.1:8080/ answers 200 with the "AC EVO Paddock" title and that the log
// file was written, then stops the app and checks the build holds no data\ folder.
// SKIPS (exit 0) on other systems than Windows, and when port 8080 is busy (a Paddock is running: quit it first).
// ELECTRON_RUN_AS_NODE is cleared for the app (with it set, Electron would run as plain Node).
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { ROOT } from './helpers.js';

const PORT = 8080;
const DIST = path.join(ROOT, 'dist');
const APP = path.join(DIST, 'win-unpacked');
const EXE = path.join(APP, 'AC EVO Paddock.exe');
const skip = (why) => { console.log(`SKIP packaged smoke: ${why}`); process.exit(0); };
const fail = (why) => { console.error(`FAIL packaged smoke: ${why}`); process.exitCode = 1; };
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

if (process.platform !== 'win32') skip('the packaged app is Windows only');
const portFree = () => new Promise((resolve) => {
  const s = net.createServer().once('error', () => resolve(false)).listen(PORT, '127.0.0.1', () => s.close(() => resolve(true)));
});
if (!(await portFree())) skip(`port ${PORT} is busy (quit the running Paddock from the tray first)`);

if (process.argv.includes('--build')) {
  fs.rmSync(DIST, { recursive: true, force: true });
  console.log('building: npx electron-builder --win dir');
  const b = spawnSync('npx electron-builder --win dir', { cwd: ROOT, env, stdio: 'inherit', shell: true });
  if (b.status !== 0) { fail(`the build failed (exit ${b.status})`); process.exit(1); }
}
if (!fs.existsSync(EXE)) skip(`no build at ${path.relative(ROOT, EXE)} (run with --build)`);
if (fs.existsSync(path.join(APP, 'data'))) { fail('dist/win-unpacked/data exists before the start: a build must never hold data'); process.exit(1); }

const tmp = path.join(os.tmpdir(), 'paddock-tests');
fs.mkdirSync(tmp, { recursive: true });
const dir = fs.mkdtempSync(path.join(tmp, 'packaged-'));
const DATA = path.join(dir, 'data'), ACE = path.join(dir, 'ACE');
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(ACE, { recursive: true });
console.log(`scratch: ${dir}`);

const child = spawn(EXE, [], { cwd: APP, env: { ...env, ACEVO_DATA: DATA, ACE_DIR: ACE }, stdio: 'ignore' });
let exited = null;
child.once('exit', (code) => { exited = code; });
child.once('error', (e) => { exited = e.message; });

let page = null;
const until = Date.now() + 60_000;
while (Date.now() < until && exited == null) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(3000) });
    page = { status: r.status, text: await r.text() };
    break;
  } catch { await new Promise((r) => setTimeout(r, 500)); }
}

if (exited != null) fail(`the app exited early (${exited})`);
else if (!page) fail(`no answer on http://127.0.0.1:${PORT}/ within 60 s`);
else {
  const title = /<title>([^<]*)<\/title>/i.exec(page.text)?.[1]?.trim();
  if (page.status !== 200) fail(`GET / answered ${page.status}`);
  else if (title !== 'AC EVO Paddock') fail(`page title is "${title}"`);
  else console.log(`ok: GET http://127.0.0.1:${PORT}/ 200, title "${title}"`);
}

// stop the app and everything it started (renderer, GPU): only this process tree
if (exited == null) {
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  const gone = Date.now() + 10_000;
  while (exited == null && Date.now() < gone) await new Promise((r) => setTimeout(r, 200));
}

const logFile = path.join(DATA, 'logs', 'paddock.log');
const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : null;
if (log == null) fail(`no log at ${logFile}`);
else {
  console.log(`ok: log written (${log.split('\n').filter(Boolean).length} lines)`);
  const errors = log.split('\n').filter((l) => / ERROR /.test(l));
  if (errors.length) console.log(`log errors (not a failure by themselves):\n  ${errors.slice(0, 10).join('\n  ')}`);
}
if (fs.existsSync(path.join(APP, 'data'))) fail('dist/win-unpacked/data exists after the run');
else console.log('ok: dist/win-unpacked holds no data folder');
console.log(process.exitCode ? 'packaged smoke FAILED' : 'packaged smoke passed');
