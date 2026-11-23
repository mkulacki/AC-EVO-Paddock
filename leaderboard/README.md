# Paddock leaderboard server

A Cloudflare Worker (`worker.js`) with a D1 database (`schema.sql`). Live at
https://acevo-paddock-leaderboard.acevo-paddock.workers.dev (Paddock's default, `src/leaderboard.js` `DEFAULT_URL`).

All commands run from the repo root. Wrangler is pinned in `package.json`; the first run needs `npm run wrangler -- login`.

| What | Command |
|---|---|
| Run it locally (http://127.0.0.1:8787, data in `leaderboard/.local/`) | `npm run board` |
| Publish a new `worker.js` | `npm run board:deploy` |
| Create the tables (new database; `schema.sql` only uses `IF NOT EXISTS`) | `npm run board:schema` |
| Query the live database | `npm run wrangler -- d1 execute acevo-paddock-leaderboard --remote --command "SELECT COUNT(*) FROM laps"` |
| Live logs | `npm run wrangler -- tail` |
| Take it offline | `npm run wrangler -- delete` |

No secrets are needed: Steam sign-in uses OpenID and the public profile, so nothing goes in `wrangler secret`.
A schema change that alters an existing table needs its own `ALTER TABLE` run against the live database.
