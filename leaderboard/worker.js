// AC EVO Paddock online leaderboard: a Cloudflare Worker over a D1 database (schema.sql + migrations/).
// The same file runs locally under Node (local.mjs), which hands it a D1-shaped wrapper around node:sqlite.
//
//   POST /v1/laps                  submit a lap (JSON, see checkLap); needs "Authorization: Bearer <token>"
//   GET  /v1/board?track&layout&(car|class)[&game][&airMin&airMax][&roadMin&roadMax][&limit][&me]
//                                  each driver's best lap on a track/layout and car (or car class), within the filters
//   GET  /v1/combos                the boards that have laps: per car, and per class
//   GET  /v1/versions?track&layout&(car|class)   the game versions with laps there
//   GET  /v1/driver?id=<SteamID>   a driver's profile: every car board they are on, with their place
//   GET  /v1/telemetry?lap=<id>    a lap's light telemetry (src/telcodec.js, gzip, base64)
//   POST /v1/report {lapId, reason}               "this lap looks wrong" (signed in)
//   POST /v1/laps/delete {lapId}   a driver removes one of their own laps (and its telemetry)
//   POST /v1/me/delete             a driver removes all their laps, reports and sign-ins (the account)
// Moderators (the ADMINS secret); every action is written to the moderation trail (moderation_log):
//   GET  /v1/admin/reports         the queue: reported or flagged laps, with their flags and evidence tier
//   GET  /v1/admin/lap?id=<id>     one lap's evidence: the lap, flags, reports, the trail, the driver's suspension
//   GET  /v1/admin/log[?lap][&before][&limit]      the moderation trail, newest first
//   POST /v1/admin/moderate {lapId, action: hide|show|review|unreview, reason}
//   POST /v1/admin/hide {lapId, hidden[, reason]}  (older Paddock versions: hide / show)
//   POST /v1/admin/suspend {driver, suspended, reason[, hideLaps]}
//   GET  /v1/health
//
// Trust model (docs/platform/LEADERBOARD_TRUST.md): a Steam sign-in proves who sent a lap, not that the lap is
// real. The checks here catch malformed and implausible laps; they cannot prove a lap was driven as sent. Each lap
// carries an evidence tier (TIERS) whose label says only what was checked.
// Steam login (OpenID 2.0: Steam checks the password, this server only learns the SteamID):
//   GET  /v1/auth/steam?return=<app callback>&state=<app's random value>   -> Steam's sign-in page
//   GET  /v1/auth/steam/callback   Steam comes back here; confirmed with Steam, then -> app callback ?code&state
//   POST /v1/auth/token {code}     the app swaps the one-time code for a login token
//   GET  /v1/me                    who a token belongs to (and whether they are an admin)
//   POST /v1/logout                ends that token
//
// The repo is public and the app holds no secret, so every lap is checked here.
import { telHeader, decodeTel, telBytes, fromBase64 } from '../src/telcodec.js';

const MAX_PER_HOUR = 60; // submitted laps per driver per hour
const MAX_REPORTS_PER_DAY = 30;
const LIMIT = { str: 100, name: 32, id: 64, sectors: 12, telB64: 131072, telRaw: 524288, body: 262144, smallBody: 4096, reason: 200 };
export const CLASSES = ['GT2', 'GT3', 'GT4'];

// Rate limits kept in D1 (rate_limits), per hour: [bucket prefix, most requests]. Laps and reports keep their own
// counts above (from their tables). IP addresses are only used as a hash and the rows go after 2 hours.
export const RATE = {
  callback: 20, // Steam sign-in answers per IP (each one asks Steam twice)
  token: 30,    // code -> token swaps per IP
  moderate: 120, // moderation actions per moderator (a stolen moderator login does limited harm)
  delete: 60,   // own-lap deletions per driver
  account: 5,   // account deletions per driver (a deleted account can sign in again)
};
const HOUR = 3_600_000;

/** Evidence tiers. Each label says only what was checked for that lap; none says a lap is genuine. */
export const TIERS = {
  legacy: 'Stored before evidence labels: the checks of that time were not recorded for this lap',
  basic: 'Format checked: sent by a signed-in driver; the times add up and are in range',
  telemetry: 'Telemetry consistent: its light telemetry passed the server checks and matches the lap time',
  reviewed: 'Reviewed: a moderator looked at the evidence and kept the lap',
};

// Anomaly rules (flags for moderators; a flag never hides a lap by itself). Operator defaults, OD-PL-66.
export const ANOMALY = {
  minDrivers: 3,     // the board needs this many other drivers before a lap is compared with it
  farAheadPct: 2,    // a lap this much (%) faster than every other driver's best on the board
  sectorAheadPct: 3, // a sector this much (%) faster than every other driver's best of that sector
  clockAheadMs: 10 * 60 * 1000, // a lap "driven" this far after it was received
};

// The canonical key of a track, layout or car name, in SQL so the migration, every insert and every query agree:
// lower case (ASCII), spaces and dashes as underscores. 'Monza GP' and 'monza-gp' share a board.
const KEY = "lower(replace(replace(trim(?), ' ', '_'), '-', '_'))";
/** The same key in JavaScript (tests and documentation; the server itself uses KEY). */
export const canonicalKey = (s) => String(s ?? '').trim().replace(/[A-Z]/g, (c) => c.toLowerCase()).replace(/[ -]/g, '_');
/** A car class as sent or asked for ('gt3' -> 'GT3'), or null when it is not one. */
export const canonicalClass = (c) => (typeof c === 'string' && CLASSES.includes(c.trim().toUpperCase()) ? c.trim().toUpperCase() : null);
const STEAM_LOGIN = 'https://steamcommunity.com/openid/login';
const OPENID_NS = 'http://specs.openid.net/auth/2.0';
const CODE_MS = 2 * 60 * 1000;           // a one-time login code lives this long
const TOKEN_MS = 180 * 24 * 3600 * 1000; // a login token: about 6 months

const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store', ...extra },
});
const bad = (error, status = 400) => json({ ok: false, error }, status);

const str = (v, max = LIMIT.str) => (typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : null);
const optStr = (v, max = LIMIT.str) => (v == null || v === '' ? null : str(v, max));
const temp = (v) => (v == null ? null : Number.isFinite(v) && v >= -40 && v <= 90 ? Math.round(v * 10) / 10 : undefined);
const int = (v) => (Number.isInteger(v) ? v : null);
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** The lap as stored (its driver comes from the login, not from the lap), or {error}. */
export function checkLap(b, now = Date.now()) {
  if (!b || typeof b !== 'object') return { error: 'not a lap' };
  const ref = str(String(b.ref ?? ''), LIMIT.id);
  if (!ref) return { error: 'bad lap ref' };
  const track = str(b.track), layout = optStr(b.layout) ?? '', car = str(b.car);
  if (!track || !car) return { error: 'track and car are needed' };
  if (b.valid !== true) return { error: 'only valid laps count' };
  const lapMs = int(b.lapMs);
  if (lapMs == null || lapMs < 10_000 || lapMs > 3_600_000) return { error: 'lap time out of range' };
  const s = b.sectors;
  if (!Array.isArray(s) || s.length < 1 || s.length > LIMIT.sectors || !s.every((x) => Number.isInteger(x) && x > 0)) return { error: 'bad sectors' };
  if (Math.abs(s.reduce((a, x) => a + x, 0) - lapMs) > 2) return { error: 'the sectors do not add up to the lap time' };
  const airC = temp(b.airC), roadC = temp(b.roadC);
  if (airC === undefined || roadC === undefined) return { error: 'temperature out of range' };
  const drivenAt = int(b.drivenAt);
  if (drivenAt == null || drivenAt < Date.UTC(2025, 0, 1) || drivenAt > now + 86_400_000) return { error: 'bad lap date' };
  const carClass = b.carClass == null ? null : canonicalClass(b.carClass);
  if (b.carClass != null && !carClass) return { error: 'unknown car class' };
  if (b.tel != null && (typeof b.tel !== 'string' || b.tel.length > LIMIT.telB64)) return { error: 'telemetry too large' };
  return {
    lap: { ref, track, layout, car, lapMs, sectors: JSON.stringify(s), airC, roadC, carClass,
      weather: optStr(b.weather, 40), grip: optStr(b.grip, 40), game: optStr(b.game, 40), app: optStr(b.app, 40), drivenAt },
    tel: b.tel ?? null,
  };
}

/** gunzip with a size cap (a small upload must not unpack into something huge). */
async function gunzip(bytes, cap) {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > cap) { await reader.cancel(); throw new Error('too large'); }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** The lap's telemetry is ours, whole, and says the same lap time; null when fine, else why not. */
export async function checkTel(b64, lapMs) {
  const gz = fromBase64(b64);
  if (!gz) return 'telemetry is not base64';
  let raw;
  try { raw = await gunzip(gz, LIMIT.telRaw); } catch { return 'telemetry is not readable'; }
  const h = telHeader(raw);
  if (!h || raw.length !== telBytes(h.n)) return 'telemetry is not in the expected format';
  if (!(h.step >= 0.5 && h.step <= 5) || h.n * h.step < 500 || h.n * h.step > 30_000) return 'telemetry has an odd track length';
  if (Math.abs(h.lapMs - lapMs) > 5) return 'telemetry is of another lap';
  const d = decodeTel(raw);
  if (!d || Math.abs(d.t[d.n - 1] - lapMs) > 1500 || d.spd.some((v) => v < -1 || v > 500)) return 'telemetry does not match the lap';
  return null;
}

/** The request body as JSON, refused when larger than max bytes (a small route must not read a huge body). */
async function readJson(req, max = LIMIT.smallBody) {
  const len = Number(req.headers.get('content-length'));
  if (Number.isFinite(len) && len > max) return { error: bad('request too large', 413) };
  let text;
  try { text = await req.text(); } catch { return { error: bad('not JSON') }; }
  if (new TextEncoder().encode(text).length > max) return { error: bad('request too large', 413) };
  try { return { body: JSON.parse(text) }; } catch { return { error: bad('not JSON') }; }
}

/** A moderator's or driver's reason: one line of plain text, at most 200 characters, or null. */
export const cleanReason = (v) => {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, LIMIT.reason);
  return s || null;
};

/** Counts one request in its bucket for this hour; true when the bucket is over its limit (the request is refused). */
async function overLimit(env, bucket, max, now) {
  const win = Math.floor(now / HOUR);
  const r = await env.DB.prepare('INSERT INTO rate_limits (bucket, win, n) VALUES (?, ?, 1) ON CONFLICT (bucket, win) DO UPDATE SET n = n + 1 RETURNING n')
    .bind(bucket, win).first();
  if (Math.random() < 0.05) await env.DB.prepare('DELETE FROM rate_limits WHERE win < ?').bind(win - 1).run();
  return (r?.n ?? 0) > max;
}
/** The caller's IP address as a short hash (null salt unless the RATE_SALT secret is set). */
const ipBucket = async (req, env, kind) => `${kind}:${(await sha256(`${req.headers.get('cf-connecting-ip') || 'local'}|${env.RATE_SALT}`)).slice(0, 16)}`;
/** RATE_SALT is required: without it an IP hash could be reversed, so the routes that count per IP refuse to run. */
const noSalt = () => { console.error('RATE_SALT is not set: sign-in is refused (npm run wrangler -- secret put RATE_SALT)'); return bad('the leaderboard server is not configured (RATE_SALT), sign-in is off', 503); };

/** Laps stored by an older worker after migration 0003 have no keys: fill them (and the legacy tier), at most every
 *  10 minutes per worker instance (the query uses the laps_board_key index). migrations/0004 does the same by hand. */
let healedAt = 0;
export async function healKeys(db, now = Date.now(), force = false) {
  if (!force && now - healedAt < 10 * 60 * 1000) return 0;
  healedAt = now;
  const r = await db.prepare(`UPDATE laps SET track_key = lower(replace(replace(trim(track), ' ', '_'), '-', '_')), layout_key = lower(replace(replace(trim(layout), ' ', '_'), '-', '_')), car_key = lower(replace(replace(trim(car), ' ', '_'), '-', '_')),
      tier = COALESCE(tier, 'legacy') WHERE track_key IS NULL`).run(); // an older worker leaves all three keys empty
  return r.meta?.changes ?? 0;
}

/** Appends one entry to the moderation trail. */
async function log(env, now, { actor, action, lapId = null, subject = null, reason = null, detail = null }) {
  await env.DB.prepare('INSERT INTO moderation_log (at, actor, action, lap_id, subject, reason, detail) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(now, actor, action, lapId, subject, reason, detail == null ? null : JSON.stringify(detail)).run();
}

const suspended = async (env, steamId) => !!(await env.DB.prepare('SELECT 1 AS x FROM suspensions WHERE steam_id = ?').bind(steamId).first());

/** Anomaly flags for a lap just stored, each with its evidence (compared with the other drivers on its car board,
 *  same game version when the lap has one). Flags are for moderators: they hide nothing. */
export async function anomalies(db, l, { telError = null, now = Date.now() } = {}) {
  const flags = [];
  if (telError) flags.push({ code: 'tel_rejected', reason: telError });
  if (l.drivenAt > now + ANOMALY.clockAheadMs) flags.push({ code: 'clock_ahead', drivenAt: l.drivenAt, receivedAt: now });
  const where = `hidden = 0 AND player_id != ? AND track_key = ${KEY} AND layout_key = ${KEY} AND car_key = ${KEY}${l.game ? ' AND game = ?' : ''}`;
  const args = [l.playerId, l.track, l.layout, l.car, ...(l.game ? [l.game] : [])];
  const { results } = await db.prepare(`SELECT player_id, MIN(lap_ms) AS ms FROM laps WHERE ${where} GROUP BY player_id`).bind(...args).all();
  if (results.length >= ANOMALY.minDrivers) {
    const best = Math.min(...results.map((r) => r.ms));
    const pct = ((best - l.lapMs) / best) * 100;
    if (pct > ANOMALY.farAheadPct) flags.push({ code: 'far_ahead', lapMs: l.lapMs, boardBestMs: best, drivers: results.length, pct: Math.round(pct * 100) / 100 });
    // sectors: each other driver's fastest lap with the same number of sectors
    const mine = JSON.parse(l.sectors);
    const { results: laps } = await db.prepare(`SELECT player_id, sectors FROM (SELECT player_id, sectors, ROW_NUMBER() OVER (PARTITION BY player_id ORDER BY lap_ms) AS rn
      FROM laps WHERE ${where}) WHERE rn = 1`).bind(...args).all();
    const same = laps.map((r) => JSON.parse(r.sectors)).filter((s) => Array.isArray(s) && s.length === mine.length);
    if (same.length >= ANOMALY.minDrivers) {
      mine.forEach((ms, i) => {
        const b = Math.min(...same.map((s) => s[i]));
        const p = ((b - ms) / b) * 100;
        if (p > ANOMALY.sectorAheadPct) flags.push({ code: 'sector_ahead', sector: i + 1, ms, boardBestMs: b, drivers: same.length, pct: Math.round(p * 100) / 100 });
      });
    }
  }
  return flags;
}

async function submit(req, env, now) {
  const who = await authed(req, env, now);
  if (!who) return bad('sign in with Steam first', 401);
  if (await suspended(env, who.steamId)) return bad('this account may not send laps (suspended by a moderator)', 403);
  const { body, error } = await readJson(req, LIMIT.body);
  if (error) return error;
  const c = checkLap(body, now);
  if (c.error) return bad(c.error);
  // telemetry that does not pass is left out; the lap time still counts
  const telError = c.tel ? await checkTel(c.tel, c.lap.lapMs) : null;
  const db = env.DB;
  const l = { ...c.lap, playerId: who.steamId, playerName: who.name };
  // a car keeps the class it was first sent with (the class comes from the app, from the car's name)
  const known = await db.prepare(`SELECT car_class FROM laps WHERE car_key = ${KEY} AND car_class IS NOT NULL LIMIT 1`).bind(l.car).first();
  if (known) l.carClass = known.car_class;
  const recent = await db.prepare('SELECT COUNT(*) AS n FROM laps WHERE player_id = ? AND received_at > ?').bind(l.playerId, now - HOUR).first();
  if (recent && recent.n >= MAX_PER_HOUR) return bad('too many laps this hour, try later', 429);
  const r = await db.prepare(`INSERT INTO laps (player_id, player_name, ref, track, layout, car, track_key, layout_key, car_key, car_class, lap_ms, sectors,
      air_c, road_c, weather, grip, game, app, driven_at, received_at, tier)
    VALUES (?, ?, ?, ?, ?, ?, ${KEY}, ${KEY}, ${KEY}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (player_id, ref) DO NOTHING`)
    .bind(l.playerId, l.playerName, l.ref, l.track, l.layout, l.car, l.track, l.layout, l.car, l.carClass, l.lapMs, l.sectors,
      l.airC, l.roadC, l.weather, l.grip, l.game, l.app, l.drivenAt, now, 'basic').run();
  const stored = (r.meta?.changes ?? 0) > 0;
  const row = await db.prepare('SELECT id, has_tel, car_class, tier FROM laps WHERE player_id = ? AND ref = ?').bind(l.playerId, l.ref).first();
  // a lap sent before classes existed gets its class when it is sent again
  if (row && l.carClass && !row.car_class) await db.prepare('UPDATE laps SET car_class = ? WHERE id = ?').bind(l.carClass, row.id).run();
  if (c.tel && !telError && row && !row.has_tel) {
    await db.prepare('INSERT OR REPLACE INTO telemetry (lap_id, data) VALUES (?, ?)').bind(row.id, c.tel).run();
    // telemetry that passed raises a format-checked lap to "telemetry consistent" (a legacy or reviewed label stays)
    await db.prepare("UPDATE laps SET has_tel = 1, tier = CASE WHEN tier = 'basic' THEN 'telemetry' ELSE tier END WHERE id = ?").bind(row.id).run();
  }
  if (stored && row) {
    const flags = await anomalies(db, l, { telError, now });
    if (flags.length) {
      await db.prepare('UPDATE laps SET flags = ? WHERE id = ?').bind(JSON.stringify(flags), row.id).run();
      await log(env, now, { actor: 'system', action: 'flag', lapId: row.id, subject: l.playerId, detail: { flags } });
    }
  }
  const rows = await bestPerDriver(db, { track: l.track, layout: l.layout, car: l.car, game: l.game }, 1000);
  const rank = rows.findIndex((x) => x.driver === l.playerId) + 1;
  const after = row ? await db.prepare('SELECT tier FROM laps WHERE id = ?').bind(row.id).first() : null;
  return json({ ok: true, stored, lapId: row?.id ?? null, rank: rank || null, of: rows.length, telError, tier: after?.tier ?? null });
}

/** Each driver's best lap on a car board (car) or a class board (cls), within the filters (canonical keys). */
async function bestPerDriver(db, f, limit) {
  const where = ['hidden = 0', `track_key = ${KEY}`, `layout_key = ${KEY}`], args = [f.track, f.layout ?? ''];
  if (f.cls) { where.push('car_class = ?'); args.push(f.cls); } else { where.push(`car_key = ${KEY}`); args.push(f.car); }
  if (f.game) { where.push('game = ?'); args.push(f.game); }
  for (const [col, lo, hi] of [['air_c', f.airMin, f.airMax], ['road_c', f.roadMin, f.roadMax]]) {
    if (lo != null) { where.push(`${col} >= ?`); args.push(lo); }
    if (hi != null) { where.push(`${col} <= ?`); args.push(hi); }
  }
  // the name shown is the driver's Steam name at their latest sign-in
  const { results } = await db.prepare(`SELECT l.*, p.name AS steam_name FROM (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY player_id ORDER BY lap_ms, received_at) AS rn FROM laps WHERE ${where.join(' AND ')}
    ) l LEFT JOIN players p ON p.steam_id = l.player_id WHERE l.rn = 1 ORDER BY l.lap_ms, l.received_at LIMIT ?`).bind(...args, limit).all();
  return results.map((r) => ({
    lapId: r.id, driver: r.player_id, name: r.steam_name ?? r.player_name, car: r.car, carClass: r.car_class ?? null,
    lapMs: r.lap_ms, sectors: JSON.parse(r.sectors), airC: r.air_c, roadC: r.road_c,
    weather: r.weather, grip: r.grip, game: r.game, app: r.app, drivenAt: r.driven_at, tel: !!r.has_tel, tier: r.tier ?? 'legacy',
  }));
}

function boardFilter(q) {
  const track = q.get('track')?.trim(), car = q.get('car')?.trim(), cls = q.get('class') ? canonicalClass(q.get('class')) : null;
  if (!track || (!car && !q.get('class'))) return null;
  if (q.get('class') && !cls) return null;
  return {
    track, layout: (q.get('layout') ?? '').trim(), car: cls ? null : car, cls, game: q.get('game') || null,
    airMin: num(q.get('airMin')), airMax: num(q.get('airMax')), roadMin: num(q.get('roadMin')), roadMax: num(q.get('roadMax')),
  };
}

async function board(url, env) {
  const q = url.searchParams, f = boardFilter(q);
  if (!f) return bad('track and a car or a class are needed');
  const limit = Math.max(1, Math.min(500, num(q.get('limit')) ?? 100));
  const rows = await bestPerDriver(env.DB, f, limit);
  const me = q.get('me');
  return json({ ok: true, rows: rows.map((r) => ({ ...r, me: !!me && r.driver === me })) });
}

// Boards group by canonical keys; the names shown are the first spelling stored (MIN), so a board keeps its name.
async function combos(env) {
  const { results } = await env.DB.prepare(`SELECT MIN(track) AS track, MIN(layout) AS layout, MIN(car) AS car, MAX(car_class) AS car_class,
      COUNT(DISTINCT player_id) AS drivers, MIN(lap_ms) AS best, MAX(received_at) AS latest
    FROM laps WHERE hidden = 0 GROUP BY track_key, layout_key, car_key ORDER BY track_key, layout_key, car_key`).all();
  const cls = await env.DB.prepare(`SELECT MIN(track) AS track, MIN(layout) AS layout, car_class, COUNT(DISTINCT player_id) AS drivers, COUNT(DISTINCT car_key) AS cars, MIN(lap_ms) AS best
    FROM laps WHERE hidden = 0 AND car_class IS NOT NULL GROUP BY track_key, layout_key, car_class ORDER BY track_key, layout_key, car_class`).all();
  return json({ ok: true, combos: results, classes: cls.results });
}

async function versions(url, env) {
  const q = url.searchParams, cls = q.get('class') ? canonicalClass(q.get('class')) : null;
  const { results } = await env.DB.prepare(`SELECT game, COUNT(*) AS laps FROM laps WHERE hidden = 0 AND track_key = ${KEY} AND layout_key = ${KEY} AND ${cls ? 'car_class = ?' : `car_key = ${KEY}`}
    GROUP BY game ORDER BY game DESC`).bind(q.get('track') ?? '', q.get('layout') ?? '', (cls || q.get('car')) ?? '').all();
  return json({ ok: true, versions: results });
}

/** A driver's car boards: their best, place, the driver just ahead and the leader (all game versions). */
async function driver(url, env) {
  const id = url.searchParams.get('id') || '';
  if (!/^\d{17}$/.test(id)) return bad('bad driver id');
  const p = await env.DB.prepare('SELECT name FROM players WHERE steam_id = ?').bind(id).first();
  if (!p) return bad('no such driver', 404);
  const { results } = await env.DB.prepare(`WITH best AS (
      SELECT track_key, layout_key, car_key, MIN(track) AS track, MIN(layout) AS layout, MIN(car) AS car, player_id, MIN(lap_ms) AS ms, MAX(car_class) AS car_class
      FROM laps WHERE hidden = 0 GROUP BY track_key, layout_key, car_key, player_id
    ), ranked AS (
      SELECT b.*, RANK() OVER w AS rank, COUNT(*) OVER (PARTITION BY track_key, layout_key, car_key) AS of,
        LAG(player_id) OVER w AS ahead_id, LAG(ms) OVER w AS ahead_ms, FIRST_VALUE(player_id) OVER w AS lead_id, FIRST_VALUE(ms) OVER w AS lead_ms
      FROM best b WHERE (track_key, layout_key, car_key) IN (SELECT track_key, layout_key, car_key FROM best WHERE player_id = ?)
      WINDOW w AS (PARTITION BY track_key, layout_key, car_key ORDER BY ms)
    )
    SELECT r.*, pa.name AS ahead_name, pl.name AS lead_name FROM ranked r
      LEFT JOIN players pa ON pa.steam_id = r.ahead_id LEFT JOIN players pl ON pl.steam_id = r.lead_id
    WHERE r.player_id = ? ORDER BY r.track, r.layout, r.car`).bind(id, id).all();
  const boards = results.map((r) => ({
    track: r.track, layout: r.layout, car: r.car, carClass: r.car_class ?? null, lapMs: r.ms, rank: r.rank, of: r.of,
    ahead: r.ahead_id ? { driver: r.ahead_id, name: r.ahead_name, lapMs: r.ahead_ms } : null,
    leader: r.lead_id && r.lead_id !== id ? { driver: r.lead_id, name: r.lead_name, lapMs: r.lead_ms } : null,
  }));
  const podiums = boards.filter((b) => b.rank <= 3).length, wins = boards.filter((b) => b.rank === 1).length;
  return json({ ok: true, driver: id, name: p.name, boards, wins, podiums });
}

async function telemetry(url, env) {
  const id = Number(url.searchParams.get('lap'));
  if (!Number.isInteger(id) || id <= 0) return bad('bad lap id');
  const r = await env.DB.prepare(`SELECT t.data, l.lap_ms, l.track, l.layout, l.car, l.player_id, p.name FROM telemetry t JOIN laps l ON l.id = t.lap_id
    LEFT JOIN players p ON p.steam_id = l.player_id WHERE t.lap_id = ? AND l.hidden = 0`).bind(id).first();
  if (!r) return bad('no telemetry for this lap', 404);
  // a lap never changes: browsers and Paddock may keep it a day
  return json({ ok: true, lapId: id, lapMs: r.lap_ms, track: r.track, layout: r.layout, car: r.car, driver: r.player_id, name: r.name, tel: r.data }, 200,
    { 'cache-control': 'public, max-age=86400' });
}

// ---------------------------------------------------------------- reports and hiding
const admins = (env) => String(env.ADMINS || '').split(/[\s,]+/).filter((x) => /^\d{17}$/.test(x));
const isAdmin = (env, steamId) => admins(env).includes(steamId);

async function report(req, env, now) {
  const who = await authed(req, env, now);
  if (!who) return bad('sign in with Steam first', 401);
  if (await suspended(env, who.steamId)) return bad('this account may not send reports (suspended by a moderator)', 403);
  const { body: b, error } = await readJson(req);
  if (error) return error;
  const lapId = int(b?.lapId), reason = cleanReason(b?.reason);
  if (!lapId) return bad('bad lap id');
  const lap = await env.DB.prepare('SELECT player_id FROM laps WHERE id = ?').bind(lapId).first();
  if (!lap) return bad('no such lap', 404);
  if (lap.player_id === who.steamId) return bad('that is your own lap');
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM reports WHERE reporter = ? AND at > ?').bind(who.steamId, now - 86_400_000).first();
  if (n && n.n >= MAX_REPORTS_PER_DAY) return bad('too many reports today', 429);
  await env.DB.prepare('INSERT INTO reports (lap_id, reporter, reason, at) VALUES (?, ?, ?, ?) ON CONFLICT (lap_id, reporter) DO UPDATE SET reason = excluded.reason, at = excluded.at')
    .bind(lapId, who.steamId, reason, now).run();
  return json({ ok: true });
}

/** The signed-in moderator ({steamId, name}), or a 403 response in `error`. */
async function moderator(req, env, now) {
  const who = await authed(req, env, now);
  return who && isAdmin(env, who.steamId) ? { who } : { error: bad('admins only', 403) };
}

const parseFlags = (s) => { try { return s ? JSON.parse(s) : []; } catch { return []; } };

/** The moderation queue: laps with reports or anomaly flags; open ones first (not hidden, not reviewed), newest first. */
async function adminReports(req, env, now) {
  const m = await moderator(req, env, now);
  if (m.error) return m.error;
  const { results } = await env.DB.prepare(`SELECT l.id, l.track, l.layout, l.car, l.lap_ms, l.sectors, l.hidden, l.player_id, l.tier, l.flags, l.has_tel, l.game,
      l.received_at, p.name, COUNT(r.reporter) AS reports, GROUP_CONCAT(COALESCE(r.reason, ''), ' | ') AS reasons, MAX(r.at) AS last
    FROM laps l LEFT JOIN reports r ON r.lap_id = l.id LEFT JOIN players p ON p.steam_id = l.player_id
    WHERE l.flags IS NOT NULL OR l.id IN (SELECT lap_id FROM reports)
    GROUP BY l.id ORDER BY l.hidden, (l.tier = 'reviewed'), COALESCE(MAX(r.at), l.received_at) DESC LIMIT 200`).all();
  return json({ ok: true, laps: results.map((r) => ({ lapId: r.id, track: r.track, layout: r.layout, car: r.car, lapMs: r.lap_ms, sectors: JSON.parse(r.sectors),
    hidden: !!r.hidden, driver: r.player_id, name: r.name, reports: r.reports, reasons: r.reasons, last: r.last ?? r.received_at,
    tier: r.tier ?? 'legacy', flags: parseFlags(r.flags), tel: !!r.has_tel, game: r.game })) });
}

/** One lap's evidence for a moderator: the lap, its flags, every report, its trail and the driver's suspension. */
async function adminLap(url, env, req, now) {
  const m = await moderator(req, env, now);
  if (m.error) return m.error;
  const id = Number(url.searchParams.get('id'));
  if (!Number.isInteger(id) || id <= 0) return bad('bad lap id');
  const l = await env.DB.prepare('SELECT l.*, p.name, p.first_seen FROM laps l LEFT JOIN players p ON p.steam_id = l.player_id WHERE l.id = ?').bind(id).first();
  if (!l) return bad('no such lap', 404);
  const reps = await env.DB.prepare('SELECT reporter, reason, at FROM reports WHERE lap_id = ? ORDER BY at DESC').bind(id).all();
  const trail = await env.DB.prepare('SELECT id, at, actor, action, reason, detail FROM moderation_log WHERE lap_id = ? ORDER BY at DESC, id DESC LIMIT 100').bind(id).all();
  const susp = await env.DB.prepare('SELECT reason, actor, at FROM suspensions WHERE steam_id = ?').bind(l.player_id).first();
  const laps = await env.DB.prepare('SELECT COUNT(*) AS n FROM laps WHERE player_id = ?').bind(l.player_id).first();
  return json({ ok: true,
    lap: { lapId: l.id, driver: l.player_id, name: l.name ?? l.player_name, track: l.track, layout: l.layout, car: l.car, carClass: l.car_class ?? null,
      keys: { track: l.track_key, layout: l.layout_key, car: l.car_key }, lapMs: l.lap_ms, sectors: JSON.parse(l.sectors), airC: l.air_c, roadC: l.road_c,
      weather: l.weather, grip: l.grip, game: l.game, app: l.app, drivenAt: l.driven_at, receivedAt: l.received_at, hidden: !!l.hidden, tel: !!l.has_tel,
      tier: l.tier ?? 'legacy', flags: parseFlags(l.flags) },
    reports: reps.results, trail: trail.results.map((t) => ({ ...t, detail: parseFlags(t.detail) })),
    driver: { firstSeen: l.first_seen ?? null, laps: laps?.n ?? 0, suspended: susp || null } });
}

/** The moderation trail, newest first (?lap=<id>, ?before=<entry id> for the next page). */
async function adminLog(url, env, req, now) {
  const m = await moderator(req, env, now);
  if (m.error) return m.error;
  const q = url.searchParams, lap = Number(q.get('lap')) || null, before = Number(q.get('before')) || null;
  const limit = Math.max(1, Math.min(500, num(q.get('limit')) ?? 100));
  const where = [], args = [];
  if (lap) { where.push('lap_id = ?'); args.push(lap); }
  if (before) { where.push('id < ?'); args.push(before); }
  const { results } = await env.DB.prepare(`SELECT id, at, actor, action, lap_id, subject, reason, detail FROM moderation_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY id DESC LIMIT ?`).bind(...args, limit).all();
  return json({ ok: true, entries: results.map((t) => ({ ...t, detail: parseFlags(t.detail) })) });
}

/** One moderation action on a lap; written to the trail with the state before and after. */
async function moderateLap(env, now, who, lapId, action, reason) {
  const l = await env.DB.prepare('SELECT id, player_id, track, layout, car, lap_ms, hidden, tier, has_tel FROM laps WHERE id = ?').bind(lapId).first();
  if (!l) return bad('no such lap', 404);
  const before = { hidden: !!l.hidden, tier: l.tier ?? 'legacy' };
  const after = { ...before };
  if (action === 'hide') after.hidden = true;
  else if (action === 'show') after.hidden = false;
  else if (action === 'review') after.tier = 'reviewed';
  else if (action === 'unreview') {
    // back to the tier the lap had before its review (from the trail); legacy when the trail does not say
    if (l.tier === 'reviewed') {
      const last = await env.DB.prepare("SELECT detail FROM moderation_log WHERE lap_id = ? AND action = 'review' ORDER BY id DESC LIMIT 1").bind(lapId).first();
      const t = parseFlags(last?.detail)?.before?.tier;
      after.tier = Object.hasOwn(TIERS, t ?? '') && t !== 'reviewed' ? t : 'legacy';
    }
  } else return bad('unknown action');
  await env.DB.prepare('UPDATE laps SET hidden = ?, tier = ? WHERE id = ?').bind(after.hidden ? 1 : 0, after.tier, lapId).run();
  await log(env, now, { actor: who.steamId, action, lapId, subject: l.player_id, reason,
    detail: { before, after, lap: { track: l.track, layout: l.layout, car: l.car, lapMs: l.lap_ms } } });
  return json({ ok: true, lapId, ...after });
}

async function adminModerate(req, env, now) {
  const m = await moderator(req, env, now);
  if (m.error) return m.error;
  if (await overLimit(env, `moderate:${m.who.steamId}`, RATE.moderate, now)) return bad('too many moderation actions this hour', 429);
  const { body: b, error } = await readJson(req);
  if (error) return error;
  const lapId = int(b?.lapId);
  if (!lapId || typeof b.action !== 'string') return bad('lapId and action are needed');
  return moderateLap(env, now, m.who, lapId, b.action, cleanReason(b.reason));
}

/** Older Paddock versions: {lapId, hidden}; the same as moderate hide / show (written to the trail). */
async function adminHide(req, env, now) {
  const m = await moderator(req, env, now);
  if (m.error) return m.error;
  if (await overLimit(env, `moderate:${m.who.steamId}`, RATE.moderate, now)) return bad('too many moderation actions this hour', 429);
  const { body: b, error } = await readJson(req);
  if (error) return error;
  const lapId = int(b?.lapId);
  if (!lapId || typeof b.hidden !== 'boolean') return bad('lapId and hidden are needed');
  return moderateLap(env, now, m.who, lapId, b.hidden ? 'hide' : 'show', cleanReason(b.reason));
}

/** Suspends a driver (no laps or reports from them; optionally hides all their laps), or lifts it. */
async function adminSuspend(req, env, now) {
  const m = await moderator(req, env, now);
  if (m.error) return m.error;
  if (await overLimit(env, `moderate:${m.who.steamId}`, RATE.moderate, now)) return bad('too many moderation actions this hour', 429);
  const { body: b, error } = await readJson(req);
  if (error) return error;
  const id = typeof b?.driver === 'string' && /^\d{17}$/.test(b.driver) ? b.driver : null;
  if (!id || typeof b.suspended !== 'boolean') return bad('driver and suspended are needed');
  if (id === m.who.steamId) return bad('a moderator cannot suspend themselves');
  const reason = cleanReason(b.reason);
  if (b.suspended && !reason) return bad('a suspension needs a reason');
  let hidden = 0;
  if (b.suspended) {
    await env.DB.prepare('INSERT INTO suspensions (steam_id, reason, actor, at) VALUES (?, ?, ?, ?) ON CONFLICT (steam_id) DO UPDATE SET reason = excluded.reason, actor = excluded.actor, at = excluded.at')
      .bind(id, reason, m.who.steamId, now).run();
    if (b.hideLaps === true) hidden = (await env.DB.prepare('UPDATE laps SET hidden = 1 WHERE player_id = ? AND hidden = 0').bind(id).run()).meta?.changes ?? 0;
  } else {
    await env.DB.prepare('DELETE FROM suspensions WHERE steam_id = ?').bind(id).run();
  }
  await log(env, now, { actor: m.who.steamId, action: b.suspended ? 'suspend' : 'unsuspend', subject: id, reason, detail: { lapsHidden: hidden } });
  return json({ ok: true, driver: id, suspended: b.suspended, lapsHidden: hidden });
}

// ---------------------------------------------------------------- a driver's own data
/** A driver removes one of their own laps (with its telemetry and the reports on it). */
async function deleteOwnLap(req, env, now) {
  const who = await authed(req, env, now);
  if (!who) return bad('sign in with Steam first', 401);
  if (await overLimit(env, `delete:${who.steamId}`, RATE.delete, now)) return bad('too many deletions this hour', 429);
  const { body: b, error } = await readJson(req);
  if (error) return error;
  const lapId = int(b?.lapId);
  if (!lapId) return bad('bad lap id');
  const l = await env.DB.prepare('SELECT id, player_id, track, layout, car, lap_ms, hidden FROM laps WHERE id = ?').bind(lapId).first();
  if (!l || l.player_id !== who.steamId) return bad('no such lap of yours', 404);
  await env.DB.prepare('DELETE FROM telemetry WHERE lap_id = ?').bind(lapId).run();
  await env.DB.prepare('DELETE FROM reports WHERE lap_id = ?').bind(lapId).run();
  await env.DB.prepare('DELETE FROM laps WHERE id = ?').bind(lapId).run();
  // the trail keeps that the lap existed and went (a hidden lap deleted by its driver stays explainable)
  await log(env, now, { actor: who.steamId, action: 'self_delete', lapId, subject: who.steamId,
    detail: { lap: { track: l.track, layout: l.layout, car: l.car, lapMs: l.lap_ms }, wasHidden: !!l.hidden } });
  return json({ ok: true, lapId });
}

/** A driver removes their account: every lap (and telemetry), their reports, the reports on their laps, their
 *  sign-ins and their name. A suspension and the moderation trail stay (OD-PL-68). */
async function deleteAccount(req, env, now) {
  const who = await authed(req, env, now);
  if (!who) return bad('sign in with Steam first', 401);
  if (await overLimit(env, `account:${who.steamId}`, RATE.account, now)) return bad('too many account deletions this hour', 429);
  const id = who.steamId, db = env.DB;
  const n = await db.prepare('SELECT COUNT(*) AS n FROM laps WHERE player_id = ?').bind(id).first();
  await db.prepare('DELETE FROM telemetry WHERE lap_id IN (SELECT id FROM laps WHERE player_id = ?)').bind(id).run();
  await db.prepare('DELETE FROM reports WHERE lap_id IN (SELECT id FROM laps WHERE player_id = ?) OR reporter = ?').bind(id, id).run();
  await db.prepare('DELETE FROM laps WHERE player_id = ?').bind(id).run();
  await db.prepare('DELETE FROM tokens WHERE steam_id = ?').bind(id).run();
  await db.prepare('DELETE FROM login_codes WHERE steam_id = ?').bind(id).run();
  await db.prepare('DELETE FROM players WHERE steam_id = ?').bind(id).run();
  await log(env, now, { actor: id, action: 'account_delete', subject: id, detail: { laps: n?.n ?? 0 } });
  return json({ ok: true, laps: n?.n ?? 0 });
}

// ---------------------------------------------------------------- Steam login
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const randomHex = (n = 32) => hex(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async (s) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
const STATE_RE = /^[0-9a-f]{32,64}$/;

/** Only the app's own local server may receive a login: an http address on this PC. */
export function appReturnOk(u) {
  try {
    const x = new URL(u);
    return x.protocol === 'http:' && (x.hostname === '127.0.0.1' || x.hostname === 'localhost') && !x.username && !x.password;
  } catch { return false; }
}

const bearer = (req) => /^Bearer ([0-9a-f]{64})$/.exec(req.headers.get('authorization') || '')?.[1] ?? null;

/** The driver a request's token belongs to ({steamId, name}), or null. */
async function authed(req, env, now) {
  const t = bearer(req);
  if (!t) return null;
  const r = await env.DB.prepare(`SELECT t.steam_id AS steamId, p.name AS name FROM tokens t JOIN players p ON p.steam_id = t.steam_id
    WHERE t.token_hash = ? AND t.expires_at > ?`).bind(await sha256(t), now).first();
  return r || null;
}

/** The Steam name from the public profile (no API key needed); null when it cannot be read. */
export async function steamName(steamId, fetchFn = fetch) {
  try {
    const r = await fetchFn(`https://steamcommunity.com/profiles/${steamId}/?xml=1`);
    const x = await r.text();
    const m = /<steamID>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))\s*<\/steamID>/.exec(x);
    const name = (m?.[1] ?? m?.[2] ?? '').trim();
    return name ? name.slice(0, LIMIT.name) : null;
  } catch { return null; }
}

function authStart(url) {
  const ret = url.searchParams.get('return'), state = url.searchParams.get('state') || '';
  if (!appReturnOk(ret)) return bad('bad return address');
  if (!STATE_RE.test(state)) return bad('bad state');
  const back = new URL('/v1/auth/steam/callback', url.origin);
  back.searchParams.set('ret', ret);
  back.searchParams.set('state', state);
  const q = new URLSearchParams({
    'openid.ns': OPENID_NS, 'openid.mode': 'checkid_setup', 'openid.return_to': back.toString(), 'openid.realm': url.origin,
    'openid.identity': `${OPENID_NS}/identifier_select`, 'openid.claimed_id': `${OPENID_NS}/identifier_select`,
  });
  return Response.redirect(`${STEAM_LOGIN}?${q}`, 302);
}

const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const page = (title, text, status = 200) => new Response(`<!doctype html><meta charset="utf-8"><title>${escHtml(title)}</title>
<body style="font:16px system-ui,sans-serif;background:#15181c;color:#e8eaed;display:grid;place-items:center;height:90vh;margin:0">
<div style="max-width:440px;padding:16px"><h2>${escHtml(title)}</h2><p>${escHtml(text)}</p></div></body>`,
{ status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });

async function authCallback(url, env, now, req) {
  const q = url.searchParams, fetchFn = env.FETCH || fetch;
  const ret = q.get('ret'), state = q.get('state') || '';
  if (!appReturnOk(ret) || !STATE_RE.test(state)) return page('Sign-in failed', 'The link is not complete. Start again from Paddock.', 400);
  if (q.get('openid.mode') !== 'id_res') return page('Sign-in cancelled', 'Steam did not sign you in. Start again from Paddock.', 400);
  // Steam signed the address it sent the answer to: it must be this very address (with our ret and state)
  const here = new URL(url.toString());
  for (const k of [...here.searchParams.keys()]) if (k.startsWith('openid.')) here.searchParams.delete(k);
  if (q.get('openid.return_to') !== here.toString() || q.get('openid.op_endpoint') !== STEAM_LOGIN) {
    return page('Sign-in failed', 'The answer was not meant for this server.', 400);
  }
  const id = /^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/.exec(q.get('openid.claimed_id') || '');
  if (!id || q.get('openid.identity') !== q.get('openid.claimed_id')) return page('Sign-in failed', 'Steam did not say who you are.', 400);
  // each answer costs two requests to Steam: limited per IP address (hashed with RATE_SALT, which is required)
  if (!env.RATE_SALT) { noSalt(); return page('Sign-in is off', 'The leaderboard server is not fully configured yet. Try again later.', 503); }
  if (await overLimit(env, await ipBucket(req, env, 'callback'), RATE.callback, now)) return page('Sign-in failed', 'Too many sign-ins from this address. Try again in an hour.', 429);
  // ask Steam whether it really signed this answer (Steam also refuses the same answer twice)
  const check = new URLSearchParams();
  for (const [k, v] of q) if (k.startsWith('openid.')) check.set(k, v);
  check.set('openid.mode', 'check_authentication');
  let ok = false;
  try {
    const r = await fetchFn(STEAM_LOGIN, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: check.toString() });
    ok = /(^|\n)is_valid\s*:\s*true/.test(await r.text());
  } catch { ok = false; }
  if (!ok) return page('Sign-in failed', 'Steam did not confirm the sign-in. Try again.', 400);
  const steamId = id[1];
  const name = (await steamName(steamId, fetchFn)) || `Steam ${steamId.slice(-4)}`;
  await env.DB.prepare(`INSERT INTO players (steam_id, name, updated_at, first_seen) VALUES (?, ?, ?, ?)
    ON CONFLICT (steam_id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`).bind(steamId, name, now, now).run();
  const code = randomHex();
  await env.DB.prepare('DELETE FROM login_codes WHERE expires_at < ?').bind(now).run();
  await env.DB.prepare('INSERT INTO login_codes (code_hash, steam_id, expires_at) VALUES (?, ?, ?)').bind(await sha256(code), steamId, now + CODE_MS).run();
  const to = new URL(ret);
  to.searchParams.set('code', code);
  to.searchParams.set('state', state);
  return Response.redirect(to.toString(), 302);
}

async function authToken(req, env, now) {
  if (!env.RATE_SALT) return noSalt();
  if (await overLimit(env, await ipBucket(req, env, 'token'), RATE.token, now)) return bad('too many sign-ins from this address, try again in an hour', 429);
  const { body: b, error } = await readJson(req);
  if (error) return error;
  if (typeof b?.code !== 'string' || !/^[0-9a-f]{64}$/.test(b.code)) return bad('bad code');
  const h = await sha256(b.code);
  const row = await env.DB.prepare('SELECT steam_id FROM login_codes WHERE code_hash = ? AND expires_at > ?').bind(h, now).first();
  await env.DB.prepare('DELETE FROM login_codes WHERE code_hash = ?').bind(h).run(); // one use only
  if (!row) return bad('this sign-in has expired, sign in again', 401);
  const token = randomHex();
  await env.DB.prepare('DELETE FROM tokens WHERE expires_at < ?').bind(now).run();
  await env.DB.prepare('INSERT INTO tokens (token_hash, steam_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256(token), row.steam_id, now, now + TOKEN_MS).run();
  const p = await env.DB.prepare('SELECT name FROM players WHERE steam_id = ?').bind(row.steam_id).first();
  return json({ ok: true, token, steamId: row.steam_id, name: p?.name ?? null, admin: isAdmin(env, row.steam_id), expiresAt: now + TOKEN_MS });
}

async function logout(req, env) {
  const t = bearer(req);
  if (t) await env.DB.prepare('DELETE FROM tokens WHERE token_hash = ?').bind(await sha256(t)).run();
  return json({ ok: true });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url), now = Date.now(), p = url.pathname;
    if (req.method === 'OPTIONS') {
      return new Response(null, { headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type, authorization' } });
    }
    try {
      if (p === '/v1/health') return json({ ok: true, version: 3, configured: { rateSalt: !!env.RATE_SALT } });
      await healKeys(env.DB, now).catch((e) => console.error(`keys not filled: ${e.message}`));
      if (req.method === 'POST') {
        if (p === '/v1/laps') return await submit(req, env, now);
        if (p === '/v1/report') return await report(req, env, now);
        if (p === '/v1/laps/delete') return await deleteOwnLap(req, env, now);
        if (p === '/v1/me/delete') return await deleteAccount(req, env, now);
        if (p === '/v1/admin/hide') return await adminHide(req, env, now);
        if (p === '/v1/admin/moderate') return await adminModerate(req, env, now);
        if (p === '/v1/admin/suspend') return await adminSuspend(req, env, now);
        if (p === '/v1/auth/token') return await authToken(req, env, now);
        if (p === '/v1/logout') return await logout(req, env);
        return bad('not found', 404);
      }
      if (req.method !== 'GET') return bad('not found', 404);
      if (p === '/v1/auth/steam') return authStart(url);
      if (p === '/v1/auth/steam/callback') return await authCallback(url, env, now, req);
      if (p === '/v1/me') { const w = await authed(req, env, now); return w ? json({ ok: true, ...w, admin: isAdmin(env, w.steamId), suspended: await suspended(env, w.steamId) }) : bad('not signed in', 401); }
      if (p === '/v1/board') return await board(url, env);
      if (p === '/v1/combos') return await combos(env);
      if (p === '/v1/versions') return await versions(url, env);
      if (p === '/v1/driver') return await driver(url, env);
      if (p === '/v1/telemetry') return await telemetry(url, env);
      if (p === '/v1/admin/reports') return await adminReports(req, env, now);
      if (p === '/v1/admin/lap') return await adminLap(url, env, req, now);
      if (p === '/v1/admin/log') return await adminLog(url, env, req, now);
      return bad('not found', 404);
    } catch (e) {
      console.error(e);
      return bad('server error', 500);
    }
  },
};
