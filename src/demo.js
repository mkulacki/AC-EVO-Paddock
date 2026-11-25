// PL11 replayable demo: Paddock without the game. Started with --demo (Settings → Try the demo in the desktop app,
// `npm run demo` from source). src/db.js then uses data\demo as the data folder: its own laps database, settings and
// backups, so demo laps are never mixed into the driver's own laps, stats, goals, backups or the leaderboard.
// The mock car (src/mock.js, a fictional circuit) drives in real time, so the live pages, the HUD overlay and the
// spotter can be watched; two earlier synthetic sessions with reports are there from the first start.
// Every page shows a "Demo" banner (public/app.js) with a way back.
import * as db from './db.js';
import * as report from './report.js';

// writes refused in the demo: the game (start, Race tab), its files (setups, mods, HUD, loader), the leaderboard,
// restores and uploads (src/server.js route guard)
export const BLOCKED = /^\/api\/(game\/|race\/|setups\/(values|copy|import)|mods\/|board\/|backup\/(restore|upload)|laps\/import)/;
export const BLOCKED_TEXT = 'Not in the demo: it never starts the game, changes its files, uses the leaderboard or brings in other data. Leave the demo to do this.';

export const SESSIONS = [{ laps: 6, daysAgo: 2 }, { laps: 8, daysAgo: 1 }];

/** Fill an empty demo database with synthetic sessions (each with its report). Does nothing outside the demo or when laps exist. */
export async function seed({ sessions = SESSIONS } = {}) {
  if (!db.DEMO || db.blocked) return 0;
  if (db.counts().laps) return 0;
  const { seedLaps } = await import('./mock.js');
  const raw = db.raw;
  let n = 0;
  for (const s of sessions) {
    let sid = null;
    await seedLaps(s.laps, (l) => { sid = l.sessionId; });
    if (sid == null) continue;
    // spread over the last days, so Progress and the reports have an earlier session to compare with
    const shift = s.daysAgo * 86400e3;
    raw.prepare('UPDATE sessions SET started_at = started_at - ?, driver = ? WHERE id = ?').run(shift, 'Demo driver', sid);
    raw.prepare('UPDATE laps SET recorded_at = recorded_at - ?, driver = ? WHERE session_id = ?').run(shift, 'Demo driver', sid);
    try { report.make(sid); } catch (e) { console.log(`[demo] report of session ${sid}: ${e.message}`); }
    n++;
  }
  console.log(`[demo] ${n} synthetic session(s) made in ${db.DATA_DIR}`);
  return n;
}
