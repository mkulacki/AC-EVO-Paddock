// PL11: crash recovery of partial sessions. Each lap is committed to SQLite the moment it is saved (WAL), so a crash or a
// kill keeps every saved lap; what it loses is the end of the session: its conditions, its report, and the Home /
// notification follow-up. A small journal (data\session-open.json) is written when a session saves its first lap and
// removed once the session has ended and its report was attempted. Found at the next start, it means the session was
// interrupted: the session is closed there (its report made when it has enough laps) and Home says so once.
// Not recoverable: the lap being driven at the moment of the crash (its samples live only in memory until the line)
// and a lap that crossed the line less than a second before (it waits for the official lap time).
import fs from 'node:fs';
import path from 'node:path';
import * as db from './db.js';
import { writeJsonAtomic, readJsonSafe } from './jsonfile.js';

export const FILE = path.join(db.DATA_DIR, 'session-open.json');
let open = null; // the session id the journal holds now
let last = null; // what the last start recovered (shown on Home in this run)

/** A session saved its first lap (or any lap: written once per session). */
export function opened(s) {
  if (!s?.sessionId || open === s.sessionId) return;
  try {
    writeJsonAtomic(FILE, { sessionId: s.sessionId, track: s.track, layout: s.layout, car: s.car, startedAt: s.startedAt ?? null, pid: process.pid, at: Date.now() });
    open = s.sessionId;
  } catch (e) { console.log(`[recovery] journal not written: ${e.message}`); }
}

/** The session ended and its report was attempted: nothing to recover. */
export function closed(sessionId) {
  if (open == null || (sessionId != null && open !== sessionId)) return;
  try { fs.rmSync(FILE, { force: true }); open = null; } catch (e) { console.log(`[recovery] journal not removed: ${e.message}`); }
}

/**
 * At start: an interrupted session from the last run, checked against the database (the same id, track and car; a
 * restore could have brought other sessions). -> {sessionId, track, layout, car, laps, valid} or null
 */
export function interrupted() {
  if (db.blocked || db.DEMO) return null;
  if (!fs.existsSync(FILE)) return null;
  const j = readJsonSafe(FILE, null);
  const s = j && Number.isInteger(j.sessionId) ? db.getSession(j.sessionId) : null;
  if (!s || s.track !== j.track || s.car !== j.car || (j.startedAt != null && s.started_at !== j.startedAt)) {
    try { fs.rmSync(FILE, { force: true }); } catch { /* next start */ }
    if (j) console.log('[recovery] the journal of the last session did not match the database: ignored');
    return null;
  }
  const laps = db.lapsOfSession(s.id);
  return { sessionId: s.id, track: s.track, layout: s.layout, car: s.car, laps: laps.length, valid: laps.filter((l) => l.valid).length, startedAt: s.started_at };
}

/**
 * Close an interrupted session: makeReport(sessionId) is the server's report step (async, returns true when a report
 * was made). The journal is removed afterwards, also when the report fails (the session's laps are kept either way).
 */
export async function recover(found, { makeReport = async () => false } = {}) {
  if (!found) return null;
  let report = false, error = null;
  try { report = !!(await makeReport(found.sessionId)); } catch (e) { error = e.message; }
  // only this session's journal: a new session may have saved its first lap (and its own journal) meanwhile
  try { if (readJsonSafe(FILE, null)?.sessionId === found.sessionId) fs.rmSync(FILE, { force: true }); } catch { /* next start */ }
  last = { ...found, report, error, at: Date.now() };
  console.log(`[recovery] session ${found.sessionId} (${found.track} / ${found.car}) was interrupted last time: ${found.laps} saved lap(s) kept, session closed${report ? ', report made' : ''}${error ? ` (report failed: ${error})` : ''}`);
  return last;
}

/** What this start recovered, for Home (null when nothing). */
export const lastRecovery = () => last;
/** For tests. */
export const _reset = () => { open = null; last = null; };
