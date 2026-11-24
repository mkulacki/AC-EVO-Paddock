// Runs every test file except the Windows-only ones (the CI Ubuntu job: `node test/portable.js`). A new test file is
// included automatically; a Windows-only one must be added to WINDOWS_ONLY with its reason.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from './helpers.js';

export const WINDOWS_ONLY = {
  'smoke.test.js': 'starts src/server.js (game process checks with tasklist, Windows shared memory)',
  'mods.test.js': 'src/game.js runs tasklist; Windows file-locking behaviour',
  'appmgmt.test.js': 'diagnostics redact Windows home-folder paths (backslash forms)',
  'secrets.test.js': 'the same diagnostics redaction',
  'feedback.test.js': "setups in the game's Windows folder layout",
};

const all = fs.readdirSync(path.join(ROOT, 'test')).filter((f) => f.endsWith('.test.js')).sort();
const unknown = Object.keys(WINDOWS_ONLY).filter((f) => !all.includes(f));
if (unknown.length) { console.error(`WINDOWS_ONLY names files that do not exist: ${unknown.join(', ')}`); process.exit(1); }
const files = all.filter((f) => !(f in WINDOWS_ONLY)).map((f) => path.join('test', f));
console.log(`portable tests: ${files.length} files; excluded (Windows only): ${Object.keys(WINDOWS_ONLY).join(', ')}`);
if (process.argv.includes('--list')) process.exit(0);
const r = spawnSync(process.execPath, ['--no-warnings', '--test', ...files], { cwd: ROOT, stdio: 'inherit' });
process.exit(r.status ?? 1);
