// The driver's own session notes, tags and corner bookmarks (PL5; tables in src/db.js, schema v2).
// Local only: nothing here is sent to the leaderboard, the AI or any other service, and lap files (src/lapfile.js) do
// not carry it. Settings backups do (they copy the whole database). Every input is bounded: text that is too long, too
// many tags or bookmarks are refused with a plain message (the page's fields have the same limits, so a driver never
// meets the error by typing).
import { raw as db, getSession } from './db.js';

export const LIMITS = { noteChars: 4000, tags: 12, tagChars: 32, corner: 60, bookmarkNote: 280, bookmarksPerSession: 60, bookmarksListed: 200 };

const bad = (msg) => Object.assign(new Error(msg), { code: 400 });
// control characters out (a tab or a new line stays in a note), no leading / trailing spaces
const clean = (s, keepLines) => String(s ?? '').replace(keepLines ? /[\u0000-\u0008\u000b-\u001f\u007f]/g : /[\u0000-\u001f\u007f]/g, '').trim();

/** A tag as stored: lower case, single spaces, no '#' in front. '' = not a tag. */
export function normTag(t) {
  return clean(t).replace(/^#+/, '').replace(/\s+/g, ' ').toLowerCase();
}
function checkTags(list) {
  if (list == null) return [];
  if (!Array.isArray(list)) throw bad('Tags must be a list');
  // too many before any work on them (a long list is refused, not cleaned first)
  if (list.length > LIMITS.tags * 2) throw bad(`At most ${LIMITS.tags} tags per session`);
  const out = [];
  for (const t of list) {
    const n = normTag(t);
    if (!n) continue;
    if (n.length > LIMITS.tagChars) throw bad(`A tag can be at most ${LIMITS.tagChars} characters`);
    if (!out.includes(n)) out.push(n);
  }
  if (out.length > LIMITS.tags) throw bad(`At most ${LIMITS.tags} tags per session`);
  return out;
}
function sessionOrThrow(id) {
  const s = Number.isInteger(+id) && +id > 0 ? getSession(+id) : null;
  if (!s) throw Object.assign(new Error('No such session'), { code: 404 });
  return s;
}
const bookmarkRow = (r) => ({ id: r.id, sessionId: r.session_id, combo: { track: r.track, layout: r.layout, car: r.car }, corner: r.corner, note: r.note, createdAt: r.created_at });

/** One session's note, tags and the bookmarks made in it, plus the other bookmarks of its track + car. */
export function forSession(id) {
  const s = sessionOrThrow(id);
  const n = db.prepare('SELECT text, updated_at FROM session_notes WHERE session_id = ?').get(s.id);
  const tags = db.prepare('SELECT tag FROM session_tags WHERE session_id = ? ORDER BY rowid').all(s.id).map((r) => r.tag);
  const all = db.prepare('SELECT * FROM corner_bookmarks WHERE track = ? AND layout = ? AND car = ? ORDER BY created_at DESC, id DESC LIMIT ?')
    .all(s.track, s.layout, s.car, LIMITS.bookmarksListed).map(bookmarkRow);
  return { sessionId: s.id, combo: { track: s.track, layout: s.layout, car: s.car }, text: n?.text ?? '', updatedAt: n?.updated_at ?? null, tags,
    bookmarks: all.filter((b) => b.sessionId === s.id), comboBookmarks: all.filter((b) => b.sessionId !== s.id), limits: LIMITS };
}

/** Saves a session's note and tags (both replaced). Empty note and no tags = nothing kept. */
export function save(id, { text = '', tags = [] } = {}) {
  const s = sessionOrThrow(id);
  if (typeof text !== 'string') throw bad('The note must be text');
  const t = clean(text, true);
  if (t.length > LIMITS.noteChars) throw bad(`A note can be at most ${LIMITS.noteChars} characters`);
  const list = checkTags(tags);
  db.exec('BEGIN');
  try {
    if (t) db.prepare(`INSERT INTO session_notes (session_id, text, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at`).run(s.id, t, Date.now());
    else db.prepare('DELETE FROM session_notes WHERE session_id = ?').run(s.id);
    db.prepare('DELETE FROM session_tags WHERE session_id = ?').run(s.id);
    const ins = db.prepare('INSERT INTO session_tags (session_id, tag) VALUES (?, ?)');
    for (const tag of list) ins.run(s.id, tag);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return forSession(s.id);
}

/** A corner bookmark in a session (its track + car come from the session). */
export function addBookmark(id, { corner, note = '' } = {}) {
  const s = sessionOrThrow(id);
  const c = clean(corner), n = clean(note);
  if (!c) throw bad('Name the corner');
  if (c.length > LIMITS.corner) throw bad(`A corner name can be at most ${LIMITS.corner} characters`);
  if (n.length > LIMITS.bookmarkNote) throw bad(`A bookmark note can be at most ${LIMITS.bookmarkNote} characters`);
  if (db.prepare('SELECT COUNT(*) AS n FROM corner_bookmarks WHERE session_id = ?').get(s.id).n >= LIMITS.bookmarksPerSession) throw bad(`At most ${LIMITS.bookmarksPerSession} bookmarks per session`);
  db.prepare('INSERT INTO corner_bookmarks (session_id, track, layout, car, corner, note, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(s.id, s.track, s.layout, s.car, c, n, Date.now());
  return forSession(s.id);
}
export function removeBookmark(bookmarkId) {
  const r = db.prepare('SELECT session_id FROM corner_bookmarks WHERE id = ?').get(Number(bookmarkId));
  if (!r) throw Object.assign(new Error('No such bookmark'), { code: 404 });
  db.prepare('DELETE FROM corner_bookmarks WHERE id = ?').run(Number(bookmarkId));
  return r.session_id;
}

/**
 * Per session, what it has (for the Sessions list, Home and the command palette): Map sessionId -> {tags, note, bookmarks}.
 * note = the first line, at most 80 characters. Small tables: read whole.
 */
export function summaries() {
  const out = new Map();
  const get = (sid) => { if (!out.has(sid)) out.set(sid, { tags: [], note: '', bookmarks: 0 }); return out.get(sid); };
  for (const r of db.prepare('SELECT session_id, text FROM session_notes').all()) get(r.session_id).note = r.text.split('\n')[0].slice(0, 80);
  for (const r of db.prepare('SELECT session_id, tag FROM session_tags ORDER BY rowid').all()) get(r.session_id).tags.push(r.tag);
  for (const r of db.prepare('SELECT session_id, COUNT(*) AS n FROM corner_bookmarks GROUP BY session_id').all()) if (r.session_id != null) get(r.session_id).bookmarks = r.n;
  return out;
}
/** Every tag in use, most used first. */
export const allTags = () => db.prepare('SELECT tag, COUNT(*) AS n FROM session_tags GROUP BY tag ORDER BY n DESC, tag').all().map((r) => ({ tag: r.tag, n: r.n }));
/** The newest bookmarks (command palette). */
export const recentBookmarks = (limit = 40) => db.prepare('SELECT * FROM corner_bookmarks ORDER BY created_at DESC, id DESC LIMIT ?').all(limit).map(bookmarkRow);
