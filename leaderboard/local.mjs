// Runs the leaderboard Worker (worker.js) locally under Node, with a D1-shaped wrapper around node:sqlite,
// so Paddock can be tested against it before anything goes online.
//   npm run board              -> http://127.0.0.1:8787, database in leaderboard/.local/board.db
//   BOARD_PORT, BOARD_DB       change the port / database file;  BOARD_ADMINS  SteamIDs of the admins (live: wrangler secret ADMINS)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import worker from './worker.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** A D1-like database (prepare().bind().first/all/run) over node:sqlite. */
export function localD1(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(fs.readFileSync(path.join(HERE, 'schema.sql'), 'utf8'));
  // the migrations, statement by statement (a column added before is skipped), as they ran on the live database
  const dir = path.join(HERE, 'migrations');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8').replace(/--[^\n]*/g, '');
    for (const st of sql.split(';').map((x) => x.trim()).filter(Boolean)) {
      try { db.exec(st); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
    }
  }
  const stmt = (sql, args) => ({
    bind: (...a) => stmt(sql, a),
    async first(col) { const r = db.prepare(sql).get(...args); return r == null ? null : col ? r[col] : { ...r }; },
    async all() { return { results: db.prepare(sql).all(...args).map((r) => ({ ...r })), meta: {} }; },
    async run() { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
  });
  return { prepare: (sql) => stmt(sql, []), close: () => db.close() };
}

/** Serves the Worker on 127.0.0.1:port; resolves to the http server. */
export function serve({ port = 8787, file = path.join(HERE, '.local', 'board.db'), fetchImpl = null, admins = process.env.BOARD_ADMINS || '' } = {}) {
  const env = { DB: localD1(file), ADMINS: admins, ...(fetchImpl ? { FETCH: fetchImpl } : {}) };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const r = await worker.fetch(new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body }), env);
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.BOARD_PORT) || 8787;
  const file = process.env.BOARD_DB || path.join(HERE, '.local', 'board.db');
  await serve({ port, file });
  console.log(`Paddock leaderboard (local) on http://127.0.0.1:${port}  database: ${file}`);
}
