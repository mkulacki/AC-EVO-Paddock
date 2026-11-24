// Runs the test suite on the Node that ships inside the packaged app (Electron's, run as plain Node with
// ELECTRON_RUN_AS_NODE=1), not on the Node that runs npm. `npm run test:electron`. Same tests, same scratch dirs.
// Extra arguments replace the default file list, e.g. `npm run test:electron -- test/leaderboard.test.js`.
import { spawnSync } from 'node:child_process';
import { ROOT } from './helpers.js';

const electron = (await import('electron')).default; // the path of electron.exe (devDependency)
const files = process.argv.slice(2);
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
const v = spawnSync(electron, ['-p', 'process.versions.node + " (Electron " + process.versions.electron + ")"'], { env, encoding: 'utf8' });
console.log(`tests on Node ${v.stdout?.trim() || '?'}`);
const r = spawnSync(electron, ['--no-warnings', '--test', ...(files.length ? files : ['test/*.test.js'])], {
  cwd: ROOT, stdio: 'inherit', env,
});
if (r.error) { console.error(`cannot start Electron: ${r.error.message}`); process.exit(1); }
process.exit(r.status ?? 1);
