// Update check (user's choice, 2026-11-17: check and notify; nothing is downloaded or installed).
// Once a day Paddock asks GitHub for the project's releases: one anonymous request, no data about the user sent.
// If a newer version is out, Settings and the nav say so, with a link to the release. Off in Settings (updateCheck).
import fs from 'node:fs';
import path from 'node:path';
import * as settings from './settings.js';
import { DATA_DIR } from './db.js';

export const REPO = 'mkulacki/AC-EVO-Paddock';
const API = `https://api.github.com/repos/${REPO}/releases?per_page=30`;
const STATE_FILE = path.join(DATA_DIR, 'update-check.json');
const DAY = 24 * 3600e3;

// ---- versions: semver with pre-releases (0.5.0-beta.1 < 0.5.0-beta.2 < 0.5.0 < 0.5.1-beta.1)
export function parse(v) {
  const m = String(v || '').trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/);
  return m ? { nums: [+m[1], +m[2], +m[3]], pre: m[4] ? m[4].split('.') : [] } : null;
}
export function compare(a, b) {
  const A = parse(a), B = parse(b);
  if (!A || !B) throw new Error(`Not a version: ${!A ? a : b}`);
  for (let i = 0; i < 3; i++) if (A.nums[i] !== B.nums[i]) return A.nums[i] < B.nums[i] ? -1 : 1;
  if (!A.pre.length || !B.pre.length) return A.pre.length === B.pre.length ? 0 : A.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(A.pre.length, B.pre.length); i++) {
    const x = A.pre[i], y = B.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) { if (+x !== +y) return +x < +y ? -1 : 1; } else if (nx !== ny) return nx ? -1 : 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * The newest release that is newer than `current`. A beta user is offered betas too; a user on a stable version only
 * stable versions. releases: GitHub's list [{tag_name, name, html_url, published_at, prerelease, draft}].
 */
export function newest(releases, current) {
  const onBeta = (parse(current)?.pre.length ?? 0) > 0;
  const ok = (releases || []).filter((r) => !r.draft && parse(r.tag_name) && (onBeta || !r.prerelease));
  ok.sort((a, b) => compare(b.tag_name, a.tag_name));
  const top = ok[0];
  if (!top || compare(top.tag_name, current) <= 0) return null;
  const url = typeof top.html_url === 'string' && top.html_url.startsWith(`https://github.com/${REPO}/`) ? top.html_url : `https://github.com/${REPO}/releases`;
  return { version: top.tag_name.replace(/^v/i, ''), name: String(top.name || top.tag_name).slice(0, 120), url, publishedAt: top.published_at, prerelease: !!top.prerelease };
}

let state = (() => { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } })();
let current = null;
const save = () => { try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch { /* read-only data dir: not worth failing for */ } };

export const enabled = () => settings.get().updateCheck !== false;
export const status = () => ({
  enabled: enabled(), current, checkedAt: state.checkedAt ?? null, error: state.error ?? null,
  latest: state.latest && current && compare(state.latest.version, current) > 0 ? state.latest : null,
});

/** Ask GitHub now. fetchFn is replaceable for tests. */
export async function check({ fetchFn = fetch } = {}) {
  try {
    const res = await fetchFn(API, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'AC-EVO-Paddock-update-check' }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    state = { checkedAt: Date.now(), latest: newest(await res.json(), current), error: null };
  } catch (e) {
    state = { ...state, checkedAt: Date.now(), error: e.name === 'TimeoutError' ? 'GitHub did not answer in time' : e.message };
  }
  save();
  return status();
}

/** At start (after a short delay) and then once a day, if switched on and the last check is a day old. */
export function schedule(version, { fetchFn } = {}) {
  current = version;
  const tick = () => { if (enabled() && !(Date.now() - (state.checkedAt || 0) < DAY)) check({ fetchFn }).catch(() => {}); };
  setTimeout(tick, 20000).unref?.();
  setInterval(tick, 3600e3).unref?.();
}
export const setCurrent = (v) => { current = v; };
