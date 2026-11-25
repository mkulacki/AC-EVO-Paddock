// First-run guide (PL5): what the setup guide (#/welcome) shows.
// Steps: locate the game -> check the connections (/api/health) -> privacy and optional services -> drive a first
// session -> open a useful comparison. The AI, online accounts and game mods can each be skipped.
// The guide never opens by itself (user decision OD-PL-24 (c)): Home's empty state (no laps yet), Settings and the
// command palette (Ctrl+K) offer it. Skipping game mods also switches off the automatic HUD install (OD-PL-22 (b),
// src/server.js); the other skips only record the choice.
// Its state lives in settings.json: onboarding = {state: 'done' | 'dismissed', at, skipped: ['ai'|'online'|'mods']}.
import { raw as db } from './db.js';

export const STEPS = ['game', 'health', 'privacy', 'drive', 'compare'];
export const SKIPPABLE = ['ai', 'online', 'mods'];

/** The stored state, cleaned: anything unknown is dropped. */
export function normState(o) {
  const state = o && ['done', 'dismissed'].includes(o.state) ? o.state : null;
  const skipped = Array.isArray(o?.skipped) ? [...new Set(o.skipped.filter((s) => SKIPPABLE.includes(s)))] : [];
  return { state, at: state && Number.isFinite(o.at) ? o.at : null, skipped };
}

/** The next state after a guide action, or throws (code 400) for an unknown one. */
export function nextState(cur, { action, step } = {}) {
  const s = normState(cur);
  if (action === 'skip' || action === 'unskip') {
    if (!SKIPPABLE.includes(step)) throw Object.assign(new Error('Unknown step'), { code: 400 });
    const skipped = action === 'skip' ? [...new Set([...s.skipped, step])] : s.skipped.filter((x) => x !== step);
    return { ...s, skipped };
  }
  if (action === 'done' || action === 'dismiss') return { ...s, state: action === 'done' ? 'done' : 'dismissed', at: Date.now() };
  if (action === 'reopen') return { ...s, state: null, at: null };
  throw Object.assign(new Error('Unknown action'), { code: 400 });
}

const one = (sql, ...a) => db.prepare(sql).get(...a);
/** Own laps (recorded by Paddock, not imported or downloaded). Two small counting queries. */
export function lapCounts() {
  return { own: one("SELECT COUNT(*) AS n FROM laps WHERE source = 'local'").n, valid: one("SELECT COUNT(*) AS n FROM laps WHERE source = 'local' AND valid = 1").n,
    any: one('SELECT COUNT(*) AS n FROM laps').n };
}

/**
 * A useful first comparison from the newest own lap's car and track (a few indexed queries, no lap data read):
 * the last valid lap against the best one, or, when the last is the best, the best lap against the ideal lap.
 * -> {href, label, why, combo} or {href: null, why} when there is not enough yet.
 */
export function firstComparison() {
  const last = one("SELECT track, layout, car FROM laps WHERE source = 'local' ORDER BY recorded_at DESC LIMIT 1");
  if (!last) return { href: null, why: 'No lap recorded yet.' };
  const combo = { track: last.track, layout: last.layout, car: last.car };
  const where = "source = 'local' AND valid = 1 AND track = ? AND layout = ? AND car = ?";
  const args = [combo.track, combo.layout, combo.car];
  const n = one(`SELECT COUNT(*) AS n FROM laps WHERE ${where}`, ...args).n;
  if (n < 2) return { href: null, combo, why: n ? 'One valid lap so far on this car and track: a comparison needs a second one.' : 'No valid lap on this car and track yet (a lap with a track-limits warning does not count).' };
  const best = one(`SELECT id FROM laps WHERE ${where} ORDER BY lap_time_ms, id LIMIT 1`, ...args);
  const newest = one(`SELECT id FROM laps WHERE ${where} ORDER BY recorded_at DESC, id DESC LIMIT 1`, ...args);
  if (newest.id !== best.id) return { href: `#/compare?laps=${newest.id}&ref=best`, combo, label: 'Your last valid lap against your best lap', why: `${n} valid laps on this car and track: see where your last lap lost time against your best.` };
  return { href: `#/compare?laps=${best.id}&ref=ideal`, combo, label: 'Your best lap against your ideal lap', why: `Your last lap is your best of ${n}: compare it with your ideal lap (your best corners put together).` };
}

/**
 * Everything the guide page needs. x: {settings (raw), aceFound, contentFound, hud (hudinstall status, quick), board (status)}
 * hasData = a driver from before (laps, a key or a sign-in).
 */
export function build(x) {
  const s = x.settings || {};
  const st = normState(s.onboarding);
  const laps = lapCounts();
  const hasData = laps.any > 0 || !!s.geminiApiKey || !!s.boardToken;
  return {
    hasData, ...st,
    game: { aceFound: !!x.aceFound, contentFound: !!x.contentFound, gamePathSet: !!s.gamePath, aceDirSet: !!s.aceDir },
    services: { ai: !!s.geminiApiKey, boardShare: !!s.boardShare, signedIn: !!s.boardToken, updateCheck: s.updateCheck !== false },
    hud: x.hud ? { state: x.hud.state ?? null, removed: !!x.hud.removed } : null,
    laps, comparison: firstComparison(),
  };
}
