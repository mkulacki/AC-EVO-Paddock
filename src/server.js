import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import * as db from './db.js';
import * as svc from './service.js';
import * as settings from './settings.js';
import * as ai from './ai.js';
import { Recorder } from './recorder.js';
import * as trackdata from './trackdata.js';
import { LiveHud } from './live.js';
import { GameBridge } from './gamebridge.js';
import * as game from './game.js';
import * as race from './race.js';
import * as cars from './cars.js';
import * as mods from './mods.js';
import * as hudInstall from './hudinstall.js';
import * as setups from './setups.js';
import * as carsetup from './carsetup.js';
import { pipeline } from 'node:stream/promises';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const mockIdx = args.indexOf('--mock');

// ---------------------------------------------------------------- telemetry source
let source;
if (mockIdx >= 0) {
  const { MockSource } = await import('./mock.js');
  source = new MockSource({ speedup: Number(args[mockIdx + 1]) || 1 });
} else {
  const { ShmSource, enableHighResTimer } = await import('./shm.js');
  enableHighResTimer();
  source = new ShmSource();
}

const recorder = new Recorder(() => settings.get().driverName);
const hud = new LiveHud(recorder);
// in-game HUD: data via the live slot files, commands via the game log (the game's UI cannot do HTTP)
const runCommand = (c) => {
  try {
    if (c.cmd === 'ref') hud.setMode(c.arg || 'cycle');
    console.log(`[hud] command from game: ${c.cmd} ${c.arg ?? ''}`);
  } catch (e) { console.log(`[hud] command ${c.cmd} failed: ${e.message}`); }
};
if (mockIdx < 0 || process.env.ACE_BRIDGE) {
  hudInstall.startAuto(); // keeps the in-game HUD installed and current while the game is closed
  new GameBridge({ snapshot: () => ({ ...hud.snapshot(), order: game.currentOrder() }), onCommand: runCommand,
    onLaunchEvent: game.onLaunchEvent, onCatalogue: race.onCatalogue }).start();
}
// every start of the game goes through here: the HUD is brought up to date first (the game is still closed)
function startGame(order) { if ((mockIdx < 0 || process.env.ACE_BRIDGE) && !game.isRunningNow()) hudInstall.autoUpdate('before starting the game'); return game.start(order); }
/**
 * What the AI setup engineer gets from the driver's laps with this car on this track: lap times and, for the best
 * valid lap, the corner-by-corner comparison with the ideal lap (null when there are no laps). Laps are not linked
 * to setups, so they may have been driven on other setups.
 */
function setupTelemetry(setup, trackId, layout) {
  const laps = db.listLaps().filter((l) => l.source === 'local' && cars.match(l.car)?.id === setup.carId).filter((l) => {
    const h = trackdata.find(l.track, l.layout);
    return h && h.track.id === trackId && (!layout || h.layout.key === layout);
  });
  if (!laps.length) return null;
  const valid = laps.filter((l) => l.valid);
  const best = valid.reduce((a, b) => (!a || b.lap_time_ms < a.lap_time_ms ? b : a), null);
  const out = { laps: laps.length, valid_laps: valid.length, recent_lap_times_ms: laps.slice(0, 15).map((l) => (l.valid ? l.lap_time_ms : `${l.lap_time_ms} (invalid)`)) };
  if (best) {
    try {
      const cmp = svc.compare([best.id], 'ideal');
      const lap = cmp.laps.find((l) => l.id === best.id);
      if (lap) out.best_lap_vs_ideal = ai.buildSummary(cmp, lap);
    } catch (e) { out.note = e.message; }
  }
  return out;
}

// a session is loaded in the game (driving, paused, in the pits or watching a replay)
const inSession = () => ['live', 'pause', 'replay'].includes(recorder.state.status) && Date.now() - recorder.state.lastFrameAt < 5000;
const clients = new Set();
const broadcast = (type, data) => { const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`; for (const c of clients) c.write(msg); };

recorder.on('lap', (l) => { svc.invalidate(); broadcast('lap', l); console.log(`[lap] ${l.track}/${l.car} ${(l.lapTimeMs / 1000).toFixed(3)}s ${l.valid ? 'valid' : 'INVALID'} -> #${l.id}`); });
recorder.on('session', (s) => console.log(`[session] ${s.track} ${s.layout} / ${s.car}`));
recorder.on('discarded', (e) => console.log(`[lap discarded] ${e.reason}`));

let lastPacket = null, lastPacketChange = Date.now(), stale = false;
setInterval(() => {
  try {
    source.tick?.();
    const f = source.read();
    if (!f) { recorder.state.connected = false; recorder.state.status = 'waiting for game'; return; }
    // game closed or frozen: packet id stops changing
    if (f.packetId !== lastPacket) { lastPacket = f.packetId; lastPacketChange = Date.now(); stale = false; }
    else if (Date.now() - lastPacketChange > 3000 && f.status !== 3) {
      if (!stale) { stale = true; recorder.endSession(); }
      recorder.state.status = 'no data (game closed?)';
      return;
    }
    recorder.onFrame(f);
    hud.onFrame(f);
  } catch (e) { console.error('telemetry error', e); }
}, 1000 / 60);

// ---------------------------------------------------------------- status for the header bar
setInterval(() => {
  if (clients.size) broadcast('status', { state: recorder.state, live: recorder.live() });
}, 1000);

// ---------------------------------------------------------------- http helpers
const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};
const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = []; let size = 0;
  req.on('data', (c) => { size += c.length; if (size > 50e6) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});
const readJson = async (req) => { const b = await readBody(req); return b.length ? JSON.parse(b.toString()) : {}; };

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
function serveStatic(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}
const safeName = (s) => String(s).replace(/[^a-z0-9_.-]+/gi, '_');

// ---------------------------------------------------------------- routes
async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const m = req.method;

  if (p === '/api/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  // ---- in-game HUD app (ACE UI App Loader) and desktop overlay: cross-origin, small payloads
  if (p.startsWith('/api/hud')) {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type');
    if (m === 'OPTIONS') { res.writeHead(204); return res.end(); }
  }
  if (p === '/api/hud') return send(res, 200, hud.snapshot());
  if (p === '/api/hud/ref' && m === 'POST') {
    const { mode = 'cycle' } = await readJson(req);
    hud.setMode(mode);
    return send(res, 200, hud.snapshot());
  }

  // ---- Tracks tab: every track/layout in the game, from AC EVO's own track data
  if (p === '/api/tracks') {
    const mine = svc.overview().combos;
    const tracks = trackdata.catalog().map((t) => ({ ...t, layouts: t.layouts.map((l) => {
      const md = trackdata.modelById(t.id, l.key);
      const laps = mine.filter((c) => trackdata.find(c.track, c.layout)?.layout === l && trackdata.find(c.track, c.layout)?.track.id === t.id);
      return { key: l.key, name: l.name, lengthM: l.lengthM, hasMap: !!l.svg, corners: md?.corners.length ?? null, width: md?.width ?? null,
        sectors: md ? md.sectors.length + 1 : null, laps: laps.reduce((a, c) => a + c.laps, 0),
        bestMs: laps.map((c) => c.bestMs).filter(Boolean).sort((a, b) => a - b)[0] ?? null };
    }) }));
    return send(res, 200, { status: trackdata.status(), tracks });
  }
  if (p === '/api/tracks/map') {
    const svg = trackdata.mapSvg(url.searchParams.get('track'), url.searchParams.get('layout'))
      || race.modMapSvg(url.searchParams.get('track'), url.searchParams.get('layout'));
    if (!svg) return send(res, 404, { error: 'no map' });
    res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'max-age=86400' });
    return res.end(svg);
  }
  if (p === '/api/tracks/detail') {
    const id = url.searchParams.get('track'), key = url.searchParams.get('layout');
    const t = trackdata.catalog().find((x) => x.id === id);
    const l = t?.layouts.find((x) => x.key === key);
    const model = l && trackdata.modelById(id, key);
    if (!model) return send(res, 404, { error: 'track not found' });
    const combos = svc.overview().combos.filter((c) => { const h = trackdata.find(c.track, c.layout); return h?.track.id === id && h.layout.key === key; })
      .map(({ key: k, car, laps, bestMs, idealMs, lastAt, bestLapId }) => ({ key: k, car, laps, bestMs, idealMs, lastAt, bestLapId }));
    const { layouts, ...track } = t;
    track.layouts = layouts.map((x) => ({ key: x.key, name: x.name, lengthM: x.lengthM }));
    return send(res, 200, { track, layout: { key: l.key, name: l.name, lengthM: l.lengthM, hasMap: !!l.svg }, model, combos });
  }
  // ---- Game tab
  if (p === '/api/game' && m === 'GET') return send(res, 200, { ...game.status(), telemetry: { ...recorder.state, live: recorder.live() } });
  if (p === '/api/game/launch' && m === 'POST') return send(res, 200, startGame(null));
  if (p === '/api/game/cancel' && m === 'POST') { game.cancel(); return send(res, 200, { ok: true }); }

  // ---- cars, from AC EVO's own files
  if (p === '/api/cars') return send(res, 200, cars.catalog());
  if (p === '/api/cars/thumb') {
    const q = url.searchParams;
    const file = await cars.thumbnail(q.get('car'), q.get('mech'), q.get('visual'));
    if (!file) return send(res, 404, { error: 'no thumbnail' });
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=604800' });
    return fs.createReadStream(file).pipe(res);
  }

  // ---- Race tab
  if (p === '/api/race' && m === 'GET') {
    return send(res, 200, { catalogue: race.publicCatalogue(), ...race.lists(), recent: race.recent(), game: { ...game.status(), inSession: inSession() } });
  }
  if (p === '/api/race/status') return send(res, 200, { ...game.status(), inSession: inSession() });
  if (p === '/api/race/combo') {
    const q = url.searchParams;
    return send(res, 200, race.comboStats(q.get('track'), q.get('layout'), { id: q.get('car'), name: q.get('carName'), display: q.get('display') }));
  }
  if (p === '/api/race/scan' && m === 'POST') return send(res, 200, startGame(race.scanOrder()));
  // development: run any steps on the game's Solo screen and get the answers in data/game-catalogue.json
  if (p === '/api/race/probe' && m === 'POST') {
    const { steps = [], car = null } = await readJson(req);
    return send(res, 200, startGame({ kind: 'probe', car, steps: [...steps, { op: 'done', step: 'probed', msg: 'probe finished' }], summary: 'checking the game' }));
  }
  if (p === '/api/race/scan.json') {
    res.writeHead(200, { 'content-type': 'application/json', 'content-disposition': 'attachment; filename="game-catalogue.json"' });
    return res.end(JSON.stringify(race.rawScan(), null, 1));
  }
  if (p === '/api/race/launch' && m === 'POST') {
    const spec = await readJson(req);
    if (spec.kind === 'mp' && spec.serverId) {
      const s = race.serverById(spec.serverId);
      if (!s) return send(res, 400, { error: 'Saved server not found' });
      spec.server = { ip: s.ip, port: s.port, password: s.password };
    }
    try { return send(res, 200, startGame(race.buildOrder(spec))); } catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (p === '/api/race/hotlap' && m === 'POST') {
    const { track, layout, car, endSession } = await readJson(req);
    try { return send(res, 200, startGame(race.buildOrder({ ...race.hotlapSpec(track, layout, car), endSession: !!endSession }))); }
    catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (p === '/api/race/presets' && m === 'POST') {
    const { name, spec } = await readJson(req);
    try { race.savePreset(name, spec); } catch (e) { return send(res, 400, { error: e.message }); }
    return send(res, 200, race.lists());
  }
  if (p === '/api/race/servers' && m === 'POST') {
    try { race.saveServer(await readJson(req)); } catch (e) { return send(res, 400, { error: e.message }); }
    return send(res, 200, race.lists());
  }
  const mm0 = p.match(/^\/api\/race\/(presets|servers)\/([\w-]+)$/);
  if (mm0 && m === 'DELETE') {
    if (mm0[1] === 'presets') race.deletePreset(mm0[2]); else race.deleteServer(mm0[2]);
    return send(res, 200, race.lists());
  }

  // ---- Setups tab: the game's own .carsetup files (loaded and saved in the game; read and edited here)
  if (p.startsWith('/api/setups')) {
    const q = url.searchParams;
    try {
      if (p === '/api/setups' && m === 'GET') {
        const car = q.get('car');
        const track = q.get('track') ? { id: q.get('track'), layout: q.get('layout') || null } : null;
        return send(res, 200, { cars: setups.cars(), list: car ? setups.list(car, track) : [], ...setups.status() });
      }
      if (p === '/api/setups/meta') return send(res, 200, { groups: carsetup.GROUPS, corners: carsetup.CORNER_LABEL });
      // edited values: {id, values: {name: value}, asName?} -> saved over the file, or as a new file when asName is given
      if (p === '/api/setups/values' && m === 'POST') { const { id, values, asName, notes, from } = await readJson(req); return send(res, 200, setups.saveValues(id, values, { asName: asName ?? null, notes, from: from === 'ai' ? 'ai' : 'paddock' })); }
      if (p === '/api/setups/copy' && m === 'POST') { const { id, track } = await readJson(req); return send(res, 200, setups.copyTo(id, track)); }
      // the AI setup engineer: proposes changes (nothing is saved until the driver saves them as a new setup)
      if (p === '/api/setups/ai' && m === 'POST') {
        const { id, problem, track, layout } = await readJson(req);
        const d = setups.detail(id);
        if (!d) throw new Error('Setup not found');
        if (!d.values) throw new Error(d.error || 'The values of this setup could not be read');
        return send(res, 200, await ai.setupEngineer({ setup: d, problem, telemetry: setupTelemetry(d, track || d.track.id, layout) }));
      }
      if (p === '/api/setups/export') {
        const { buf, filename } = setups.exportFile(q.get('id'));
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${filename.replace(/["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename)}` });
        return res.end(buf);
      }
      if (p === '/api/setups/import' && m === 'POST') {
        const buf = await readBody(req);
        try { return send(res, 200, setups.importFile(buf, { filename: q.get('filename') || '', trackId: q.get('track') || null })); }
        catch (e) { if (e.needsTrack) return send(res, 409, { error: e.message, needsTrack: true, car: e.car }); throw e; }
      }
      if (p === '/api/setups/file') {
        const id = q.get('id');
        if (m === 'GET') { const d = setups.detail(id); return d ? send(res, 200, d) : send(res, 404, { error: 'Setup not found' }); }
        if (m === 'PUT') return send(res, 200, setups.update(id, await readJson(req)));
        if (m === 'DELETE') { setups.remove(id); return send(res, 200, { ok: true }); }
      }
      return send(res, 404, { error: 'not found' });
    } catch (e) { return send(res, e.status || 400, { error: e.message }); }
  }

  // ---- Mods tab
  if (p === '/api/mods' && m === 'GET') return send(res, 200, { mods: mods.list(), running: game.isRunningNow(), hud: hudInstall.status() });
  // the Paddock HUD shipped with this Paddock: installed / outdated? (Mods tab prompt, nav badge)
  if (p === '/api/mods/hud' && m === 'GET') return send(res, 200, hudInstall.status());
  if (p === '/api/mods/hud' && m === 'POST') {
    try { return send(res, 200, hudInstall.install()); } catch (e) { return send(res, e.code || 500, { error: e.message }); }
  }
  if (p === '/api/mods/upload' && m === 'POST') {
    // streamed to disk: mod packs can be far bigger than the JSON body limit
    fs.mkdirSync(mods.UPLOAD_DIR, { recursive: true });
    const tmp = path.join(mods.UPLOAD_DIR, `upload-${Date.now()}-${process.pid}`);
    try {
      await pipeline(req, fs.createWriteStream(tmp));
      return send(res, 200, await mods.install(tmp, url.searchParams.get('name'), { overwrite: url.searchParams.get('overwrite') === '1' }));
    } catch (e) {
      return send(res, e.code >= 400 ? e.code : 500, { error: e.message, conflicts: e.conflicts });
    } finally { fs.rmSync(tmp, { force: true }); }
  }
  if (p === '/api/mods/action' && m === 'POST') {
    const { id, op, name, into, force } = await readJson(req);
    try {
      const list = op === 'disable' ? mods.disable(id, { force }) : op === 'enable' ? mods.enable(id) : op === 'delete' ? mods.remove(id, { force })
        : op === 'rename' ? mods.rename(id, name) : op === 'merge' ? mods.merge(id, into) : null;
      if (!list) return send(res, 400, { error: 'unknown action' });
      return send(res, 200, { mods: list });
    } catch (e) {
      return send(res, typeof e.code === 'number' ? e.code : 500, { error: e.message, needsConfirm: e.needsConfirm });
    }
  }

  // developer: restart the whole app so code changes load (the page reloads itself once it is back)
  if (p === '/api/dev/restart' && m === 'POST') {
    send(res, 200, { ok: true });
    setTimeout(restartApp, 150);
    return;
  }
  if (p === '/api/status') return send(res, 200, { source: source.name, state: recorder.state, settings: settings.publicView() });
  if (p === '/api/overview') return send(res, 200, svc.overview());
  if (p === '/api/consistency') {
    const q = url.searchParams;
    return send(res, 200, svc.consistency({ track: q.get('track'), layout: q.get('layout'), car: q.get('car') },
      q.get('session') || 'all', q.get('invalid') === '1'));
  }
  if (p === '/api/progress') {
    const q = url.searchParams;
    return send(res, 200, svc.progress({ track: q.get('track'), layout: q.get('layout'), car: q.get('car') }));
  }
  if (p === '/api/compare') {
    const laps = (url.searchParams.get('laps') || '').split(',').map(Number).filter(Boolean);
    if (!laps.length) return send(res, 400, { error: 'no laps' });
    return send(res, 200, svc.compare(laps, url.searchParams.get('ref') || 'best'));
  }

  // several laps at once (e.g. "remove invalid laps"): {ids: [lapId…]}
  if (p === '/api/laps/delete' && m === 'POST') {
    const { ids = [] } = await readJson(req);
    const list = [...new Set([].concat(ids).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    for (const id of list) db.deleteLap(id);
    if (list.length) svc.invalidate();
    return send(res, 200, { ok: true, deleted: list.length });
  }

  let mm;
  if ((mm = p.match(/^\/api\/laps\/(\d+)$/)) && m === 'DELETE') {
    db.deleteLap(Number(mm[1])); svc.invalidate();
    return send(res, 200, { ok: true });
  }
  if ((mm = p.match(/^\/api\/laps\/(\d+)\/export$/))) {
    const lap = db.getLap(Number(mm[1]));
    if (!lap) return send(res, 404, { error: 'not found' });
    const { data, id, session_id, ...meta } = lap;
    const file = zlib.gzipSync(JSON.stringify({ format: 'acevo-trainer-lap', version: 1, meta, data }));
    const name = safeName(`${meta.track}_${meta.car}_${meta.driver}_${(meta.lap_time_ms / 1000).toFixed(3)}.lap.gz`);
    res.writeHead(200, { 'content-type': 'application/gzip', 'content-disposition': `attachment; filename="${name}"` });
    return res.end(file);
  }
  if (p === '/api/laps/import' && m === 'POST') {
    let buf = await readBody(req);
    if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
    const obj = JSON.parse(buf.toString());
    if (obj.format !== 'acevo-trainer-lap' || !obj.data?.t || !obj.data?.d) return send(res, 400, { error: 'Not an acevo-trainer lap file' });
    const mt = obj.meta;
    const id = db.insertLap({ sessionId: null, track: mt.track, layout: mt.layout, car: mt.car, lapNumber: mt.lap_number,
      lapTimeMs: mt.lap_time_ms, valid: !!mt.valid, driver: mt.driver || 'Imported', source: 'import',
      recordedAt: mt.recorded_at || Date.now(), trackLength: mt.track_length, data: obj.data });
    svc.invalidate();
    return send(res, 200, { ok: true, id });
  }
  if (p === '/api/settings') {
    if (m === 'POST') {
      const body = await readJson(req);
      if (typeof body.geminiApiKey === 'string' && body.geminiApiKey.startsWith('••••')) delete body.geminiApiKey;
      const oldPath = settings.get().gamePath;
      settings.update(body);
      if (settings.get().gamePath !== oldPath) { trackdata.reset(); svc.invalidate(); }
    }
    return send(res, 200, settings.publicView());
  }
  if (p === '/api/ai/models') return send(res, 200, await ai.listModels());
  if (p === '/api/ai/analyze' && m === 'POST') {
    const { lap: lapId, ref = 'best', question, force } = await readJson(req);
    const cmp = svc.compare([lapId], ref);
    // cache key = the actual reference (best/ideal change as you drive more laps)
    const refKey = `${cmp.ref.id}:${cmp.ref.lapTimeMs}`;
    if (!question && !force) {
      const cached = db.getAnalysis(lapId, refKey);
      if (cached) return send(res, 200, { text: cached.text, model: cached.model, cached: true, createdAt: cached.created_at });
    }
    const lap = cmp.laps.find((l) => l.id === lapId);
    if (!lap) return send(res, 400, { error: 'Pick a lap different from the reference' });
    const out = await ai.coach(cmp, lap, question, question ? db.getAnalysis(lapId, refKey)?.text : null);
    if (!question) db.saveAnalysis(lapId, refKey, out.model, out.text);
    return send(res, 200, { ...out, cached: false, createdAt: Date.now() });
  }
  if (p === '/api/ai/summary') { // what exactly is sent to the AI (transparency/debug)
    const lapId = Number(url.searchParams.get('lap')), ref = url.searchParams.get('ref') || 'best';
    const cmp = svc.compare([lapId], ref);
    return send(res, 200, ai.buildSummary(cmp, cmp.laps[0]));
  }
  if (p === '/api/debug/raw') return send(res, 200, source.lastRaw ?? source.read?.() ?? null);

  // static files
  if (p.startsWith('/vendor/uplot/')) return serveStatic(res, path.join(ROOT, 'node_modules/uplot/dist', path.basename(p)));
  // the in-game app's files, reused by the desktop overlay page (hud.html)
  if (p.startsWith('/mod/')) return serveStatic(res, path.join(ROOT, 'mod/trainerhud', path.basename(p)));
  const file = path.normalize(path.join(ROOT, 'public', p === '/' ? 'index.html' : p));
  if (!file.startsWith(path.join(ROOT, 'public'))) return send(res, 403, { error: 'forbidden' });
  return serveStatic(res, file);
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => { console.error(e.message); if (!res.headersSent) send(res, 500, { error: e.message }); });
});
const port = Number(process.env.PORT) || settings.get().port || 8080;
// resolves with the port once listening; the desktop app (desktop/main.cjs) waits on it
export const ready = new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', () => {
    console.log(`AC EVO Paddock running: http://localhost:${port}   (source: ${source.name})`);
    setTimeout(() => cars.warmThumbnails().catch(() => {}), 3000); // car pictures for the Race tab, in a worker
    resolve(port);
  });
});
// Restart for development. Desktop app: desktop/main.cjs provides a relaunch. start.bat runs the server in a
// loop and starts it again on exit code 75. Plain `npm start`: start a new copy of this process, then exit.
export const RESTART_EXIT_CODE = 75;
let restarting = false;
function restartApp() {
  if (restarting) return;
  restarting = true;
  console.log('[dev] restarting the app…');
  if (typeof globalThis.__trainerRelaunch === 'function') return globalThis.__trainerRelaunch();
  const done = () => {
    if (process.env.TRAINER_SUPERVISED) process.exit(RESTART_EXIT_CODE);
    // a child sharing this console is killed with it (npm, terminals): start a detached copy instead, in its
    // own console window on Windows so its log stays visible
    import('node:child_process').then(({ spawn }) => {
      const args = [...process.execArgv, ...process.argv.slice(1)];
      const child = process.platform === 'win32'
        ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'start', 'AC EVO Paddock', process.execPath, ...args], { detached: true, stdio: 'ignore', cwd: process.cwd(), env: process.env })
        : spawn(process.execPath, args, { detached: true, stdio: 'ignore', cwd: process.cwd(), env: process.env });
      child.unref();
      process.exit(0);
    }).catch((e) => { console.error('[dev] restart failed:', e.message); process.exit(1); });
  };
  // free the port first (the live event stream keeps connections open)
  server.close(done);
  server.closeAllConnections?.();
  setTimeout(done, 3000).unref();
}

// run directly (npm start): a busy port should still end the process with a clear message
if (!process.versions.electron) ready.catch((e) => { console.error(`Cannot start the server on port ${port}: ${e.message}`); process.exit(1); });
