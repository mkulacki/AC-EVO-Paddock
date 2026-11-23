// AC EVO Paddock online leaderboard: a Cloudflare Worker over a D1 database (schema.sql).
// The same file runs locally under Node (local.mjs), which hands it a D1-shaped wrapper around node:sqlite.
//
//   POST /v1/laps                  submit a lap (JSON, see checkLap)
//   GET  /v1/board?track&layout&car[&game][&airMin&airMax][&roadMin&roadMax][&limit]
//                                  each driver's best lap on a track/layout/car, within the filters
//   GET  /v1/combos                the track/layout/car combinations that have laps
//   GET  /v1/versions?track&layout&car   the game versions with laps there
//   GET  /v1/health
//
// The repo is public and the app holds no secret, so every lap is checked here. Version 1 has no login:
// a driver is a random id the app makes, with the name from Paddock's settings (Steam login comes later).

const MAX_PER_HOUR = 60; // submitted laps per driver per hour
const LIMIT = { str: 100, name: 32, id: 64, sectors: 12 };

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' },
});
const bad = (error, status = 400) => json({ ok: false, error }, status);

const str = (v, max = LIMIT.str) => (typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : null);
const optStr = (v, max = LIMIT.str) => (v == null || v === '' ? null : str(v, max));
const temp = (v) => (v == null ? null : Number.isFinite(v) && v >= -40 && v <= 90 ? Math.round(v * 10) / 10 : undefined);
const int = (v) => (Number.isInteger(v) ? v : null);

/** The lap as stored, or {error}. */
export function checkLap(b, now = Date.now()) {
  if (!b || typeof b !== 'object') return { error: 'not a lap' };
  const playerId = str(b.player?.id, LIMIT.id);
  if (!playerId || !/^[A-Za-z0-9_-]{8,64}$/.test(playerId)) return { error: 'bad player id' };
  const playerName = str(b.player?.name, LIMIT.name);
  if (!playerName) return { error: 'a driver name is needed (Paddock Settings)' };
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
  return {
    lap: { playerId, playerName, ref, track, layout, car, lapMs, sectors: JSON.stringify(s), airC, roadC,
      weather: optStr(b.weather, 40), grip: optStr(b.grip, 40), game: optStr(b.game, 40), app: optStr(b.app, 40), drivenAt },
  };
}

async function submit(req, env, now) {
  let body;
  try { body = await req.json(); } catch { return bad('not JSON'); }
  const c = checkLap(body, now);
  if (c.error) return bad(c.error);
  const l = c.lap, db = env.DB;
  const recent = await db.prepare('SELECT COUNT(*) AS n FROM laps WHERE player_id = ? AND received_at > ?').bind(l.playerId, now - 3_600_000).first();
  if (recent && recent.n >= MAX_PER_HOUR) return bad('too many laps this hour, try later', 429);
  const r = await db.prepare(`INSERT INTO laps (player_id, player_name, ref, track, layout, car, lap_ms, sectors, air_c, road_c, weather, grip, game, app, driven_at, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (player_id, ref) DO NOTHING`)
    .bind(l.playerId, l.playerName, l.ref, l.track, l.layout, l.car, l.lapMs, l.sectors, l.airC, l.roadC, l.weather, l.grip, l.game, l.app, l.drivenAt, now).run();
  // the name follows the latest submit (renaming in Settings renames the driver everywhere)
  await db.prepare('UPDATE laps SET player_name = ? WHERE player_id = ?').bind(l.playerName, l.playerId).run();
  const rows = await bestPerDriver(db, { track: l.track, layout: l.layout, car: l.car, game: l.game }, 1000);
  const rank = rows.findIndex((x) => x.playerId === l.playerId) + 1;
  return json({ ok: true, stored: (r.meta?.changes ?? 0) > 0, rank: rank || null, of: rows.length });
}

const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

async function bestPerDriver(db, f, limit) {
  const where = ['track = ?', 'layout = ?', 'car = ?'], args = [f.track, f.layout ?? '', f.car];
  if (f.game) { where.push('game = ?'); args.push(f.game); }
  for (const [col, lo, hi] of [['air_c', f.airMin, f.airMax], ['road_c', f.roadMin, f.roadMax]]) {
    if (lo != null) { where.push(`${col} >= ?`); args.push(lo); }
    if (hi != null) { where.push(`${col} <= ?`); args.push(hi); }
  }
  const { results } = await db.prepare(`SELECT * FROM (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY player_id ORDER BY lap_ms, received_at) AS rn FROM laps WHERE ${where.join(' AND ')}
    ) WHERE rn = 1 ORDER BY lap_ms, received_at LIMIT ?`).bind(...args, limit).all();
  return results.map((r) => ({
    playerId: r.player_id, name: r.player_name, lapMs: r.lap_ms, sectors: JSON.parse(r.sectors), airC: r.air_c, roadC: r.road_c,
    weather: r.weather, grip: r.grip, game: r.game, app: r.app, drivenAt: r.driven_at,
  }));
}

async function board(url, env) {
  const q = url.searchParams, track = q.get('track'), car = q.get('car');
  if (!track || !car) return bad('track and car are needed');
  const limit = Math.max(1, Math.min(500, num(q.get('limit')) ?? 100));
  const rows = await bestPerDriver(env.DB, {
    track, layout: q.get('layout') ?? '', car, game: q.get('game') || null,
    airMin: num(q.get('airMin')), airMax: num(q.get('airMax')), roadMin: num(q.get('roadMin')), roadMax: num(q.get('roadMax')),
  }, limit);
  // the player id stays private: the app is told which row is its own
  const me = q.get('me');
  return json({ ok: true, rows: rows.map(({ playerId, ...r }) => ({ ...r, me: !!me && playerId === me })) });
}

async function combos(env) {
  const { results } = await env.DB.prepare(`SELECT track, layout, car, COUNT(DISTINCT player_id) AS drivers, MIN(lap_ms) AS best, MAX(received_at) AS latest
    FROM laps GROUP BY track, layout, car ORDER BY track, layout, car`).all();
  return json({ ok: true, combos: results });
}

async function versions(url, env) {
  const q = url.searchParams;
  const { results } = await env.DB.prepare('SELECT game, COUNT(*) AS laps FROM laps WHERE track = ? AND layout = ? AND car = ? GROUP BY game ORDER BY game DESC')
    .bind(q.get('track') ?? '', q.get('layout') ?? '', q.get('car') ?? '').all();
  return json({ ok: true, versions: results });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url), now = Date.now();
    if (req.method === 'OPTIONS') return new Response(null, { headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type' } });
    try {
      if (url.pathname === '/v1/health') return json({ ok: true, version: 1 });
      if (url.pathname === '/v1/laps' && req.method === 'POST') return await submit(req, env, now);
      if (req.method !== 'GET') return bad('not found', 404);
      if (url.pathname === '/v1/board') return await board(url, env);
      if (url.pathname === '/v1/combos') return await combos(env);
      if (url.pathname === '/v1/versions') return await versions(url, env);
      return bad('not found', 404);
    } catch (e) {
      console.error(e);
      return bad('server error', 500);
    }
  },
};
