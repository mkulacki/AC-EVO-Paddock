// Shared test helpers. Every test file runs in its own process (node --test), so a file calls isolate() first and
// then imports the app modules dynamically: src/db.js opens ACEVO_DATA at import time.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(os.tmpdir(), 'paddock-tests');

// left-overs of earlier runs (SQLite keeps its files locked until the process ends, so each run cleans the old ones)
try {
  for (const d of fs.readdirSync(TMP)) {
    const p = path.join(TMP, d);
    if (Date.now() - fs.statSync(p).mtimeMs > 3600e3) fs.rmSync(p, { recursive: true, force: true });
  }
} catch { /* nothing yet */ }

/**
 * A fresh, empty data dir and AC EVO user folder for this test process. Nothing is written to the project's
 * data/ or to the real Saved Games\ACE. (The game's content.kspkg may still be READ, if AC EVO is installed.)
 */
export function isolate(name) {
  fs.mkdirSync(TMP, { recursive: true });
  const dir = fs.mkdtempSync(path.join(TMP, `${name}-`));
  const env = { ACEVO_DATA: path.join(dir, 'data'), ACE_DIR: path.join(dir, 'ACE') };
  fs.mkdirSync(env.ACEVO_DATA, { recursive: true });
  fs.mkdirSync(env.ACE_DIR, { recursive: true });
  Object.assign(process.env, env);
  delete process.env.ACE_BRIDGE;
  return { dir, ...env };
}

/** Make Math.random repeatable (mulberry32), so the mock car drives the same laps on every run. */
export function seedRandom(seed = 1) {
  let a = seed >>> 0;
  Math.random = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const near = (a, b, tol) => Math.abs(a - b) <= tol;
