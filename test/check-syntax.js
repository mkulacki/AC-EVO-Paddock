// Syntax check of every shipped script (CLAUDE.md release step 2), as `npm run check`. Exit code 1 on any failure.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT } from './helpers.js';

const DIRS = ['desktop', 'overlay', 'src', 'src/tools', 'public', 'mod/trainerhud', 'test'];
const files = DIRS.flatMap((d) => fs.readdirSync(path.join(ROOT, d)).filter((f) => /\.(c|m)?js$/.test(f)).map((f) => path.join(d, f)));
let failed = 0;
for (const f of files) {
  try { execFileSync(process.execPath, ['--check', path.join(ROOT, f)], { stdio: 'pipe' }); }
  catch (e) { failed++; console.error(`FAIL ${f}\n${e.stderr}`); }
}
console.log(`${files.length - failed}/${files.length} files OK`);
process.exit(failed ? 1 : 0);
