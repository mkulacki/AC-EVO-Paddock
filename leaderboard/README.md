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

Steam sign-in needs no secret (OpenID and the public profile). The one secret is `ADMINS`: the SteamIDs (comma separated) that may see
reports and hide laps: `npm run wrangler -- secret put ADMINS`. It is not in this repo.

Schema changes: `schema.sql` is the first version; every later change is a file in `migrations/`, run once against the live
database in order (`npm run wrangler -- d1 execute acevo-paddock-leaderboard --remote --file migrations/<file>.sql`).
The local runner applies them by itself.

| Migration | What |
|---|---|
| 0002_classes_telemetry_reports | car class boards, light telemetry per lap, reports, hidden laps |
