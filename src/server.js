import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as db from './db.js';
import * as svc from './service.js';
import * as settings from './settings.js';
import * as ai from './ai.js';
import { Recorder } from './recorder.js';
import * as trackdata from './trackdata.js';
import { LiveHud } from './live.js';
import { GameBridge, ACE, ACE_AUTO } from './gamebridge.js';
import { createSpotter } from './spotter.js';
import * as assist from './assist.js';
import * as hudLayouts from './hudlayouts.js';
import * as marks from './brakemarks.js';
import { createMarker } from './brakemarks.js';
import * as wheel from './wheel.js';
import { cornerMetrics, TECHNIQUE } from './analysis.js';
import * as game from './game.js';
import * as race from './race.js';
import * as cars from './cars.js';
import * as mods from './mods.js';
import * as hudInstall from './hudinstall.js';
import * as loaderInstall from './loaderinstall.js';
import * as setups from './setups.js';
import * as carstats from './carstats.js';
import * as carsetup from './carsetup.js';
import { createSetupTracker } from './setupmatch.js';
import * as setupmatch from './setupmatch.js';
import { createAidsTracker } from './aids.js';
import { createLeaderboard } from './leaderboard.js';
import * as report from './report.js';
import * as carreport from './carreport.js';
import * as setuphistory from './setuphistory.js';
import * as coach from './coach.js';
import * as goals from './goals.js';
import * as drills from './drills.js';
import * as experiments from './experiments.js';
import * as weekends from './weekends.js';
import * as achievements from './achievements.js';
import * as channels from './channels.js';
import * as health from './health.js';
import * as notes from './notes.js';
import * as onboarding from './onboarding.js';
import * as backup from './backup.js';
import * as dataexport from './dataexport.js';
import * as diagnostics from './diagnostics.js';
import * as sensitive from './sensitive.js';
import * as lapfile from './lapfile.js';
import { limitBytes } from './zip.js';
import * as updates from './updates.js';
import { perf } from './perf.js';
import { pipeline } from 'node:stream/promises';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const mockIdx = args.indexOf('--mock');

// ---------------------------------------------------------------- telemetry source
let source;
if (mockIdx >= 0) {
  const { MockSource } = await import('./mock.js');
  source = new MockSource({ speedup: Number(args[mockIdx + 1]) || 1 });
  // timing measurements (npm run bench): the same 1 ms Windows timer as a real run, so the 60 Hz loop is comparable
  if (process.env.PADDOCK_HIRES_TIMER) (await import('./shm.js')).enableHighResTimer();
} else {
  const { ShmSource, enableHighResTimer } = await import('./shm.js');
  enableHighResTimer();
  source = new ShmSource();
}

// every lap is stored with the setup the car was on (fingerprint taken in the pits, src/setupmatch.js)
const recorder = new Recorder(() => settings.get().driverName, () => setupTracker.current());
const setupTracker = createSetupTracker({ recorder, launchConditions: game.launchConditions });
const hud = new LiveHud(recorder);
// (the leaderboard target is connected below, once the leaderboard exists)
// TC / ABS / ESC levels and assists per lap, reported by the in-game HUD (src/aids.js)
const aidsTracker = createAidsTracker({ recorder });
// live data + the HUD's look (parts, size, opacity); with the kill switch on, no live data at all (src/assist.js)
const hudSnapshot = () => assist.gate({ ...hud.snapshot(), cfg: settings.hudConfig() });
// in-game HUD: data via the live slot files, commands via the game log (the game's UI cannot do HTTP)
const runCommand = (c) => {
  try {
    if (c.cmd === 'ref' && !assist.isOff()) hud.setMode(c.arg || 'cycle');
    if (c.cmd === 'aids') aidsTracker.onCommand(c.arg); // a few per lap at most
    // a part / size / opacity changed in the in-game settings window: Paddock keeps the one copy
    if (c.cmd === 'hud' && c.arg && typeof c.arg === 'object') {
      const cur = settings.hudConfig();
      settings.update({ hud: { ...cur, ...c.arg, parts: { ...cur.parts, ...(c.arg.parts || {}) } } });
    }
    console.log(`[hud] command from game: ${c.cmd} ${typeof c.arg === 'object' ? JSON.stringify(c.arg) : c.arg ?? ''}`);
  } catch (e) { console.log(`[hud] command ${c.cmd} failed: ${e.message}`); }
};
let bridge = null; // the in-game HUD bridge (its stats go to Integration health and Diagnostics)
if (mockIdx < 0 || process.env.ACE_BRIDGE) {
  hudInstall.startAuto(); // keeps the App Loader and the in-game HUD installed and current while the game is closed
  bridge = new GameBridge({ snapshot: () => ({ ...hudSnapshot(), order: game.currentOrder() }), onCommand: runCommand,
    onLaunchEvent: game.onLaunchEvent, onCatalogue: race.onCatalogue }).start();
}
// this Paddock's version, and the daily update check (never in mock runs or tests, unless PADDOCK_UPDATE_CHECK is set)
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
// online leaderboard: each lap's own conditions, and the best laps sent when sharing is on (src/leaderboard.js)
const board = createLeaderboard({ recorder, launchInfo: () => setupTracker.conditions()?.launch ?? null, gameVersion: () => { try { return game.gameVersion(); } catch { return null; } }, appVersion: VERSION,
  notify: (n) => { broadcast('board', n); globalThis.__paddockNotify?.(n); } });
hud.targetSource = (s) => board.target(s); // the HUD's leaderboard target (src/leaderboard.js)
// the in-game board window (P1-P3, you and the drivers around you); nothing when that part is switched off
hud.boardSource = (s) => (settings.hudConfig().parts.board === false ? null : board.boardWindow(s));
updates.setCurrent(VERSION);
// telemetry checks are measured against the game version and readers in use now (PL4.1, src/channels.js)
channels.configure({ gameVersion: () => game.gameVersion(), hudVersion: () => hudInstall.installedVersion() });
experiments.configure({ gameVersion: () => game.gameVersion() });
try { if (channels.migrate()) console.log('[channels] earlier telemetry checks kept as records without a game version: check them again in Setups'); } catch (e) { console.log(`[channels] checks not migrated: ${e.message}`); }
if (mockIdx < 0 || process.env.PADDOCK_UPDATE_CHECK) updates.schedule(VERSION);
if (db.restoreResult) console.log(`[backup] restore at start: ${db.restoreResult.ok ? `done (${db.restoreResult.files.join(', ')})` : `FAILED: ${db.restoreResult.error}`}`);
// every start of the game goes through here: the HUD is brought up to date first (the game is still closed)
function startGame(order) { if ((mockIdx < 0 || process.env.ACE_BRIDGE) && !game.isRunningNow()) hudInstall.autoUpdate('before starting the game'); return game.start(order); }
/**
 * What the AI setup engineer gets from the driver's laps with this car on this track: lap times and, for the best
 * valid lap, the corner-by-corner comparison with the ideal lap (null when there are no laps), and the laps split by
 * the setup they were driven on (by_setup, P7; this_setup marks the setup being engineered).
 */
/** Own laps whose game car and track names map to a catalogue car and track (each distinct combo matched once). */
function lapsForCatalogue(carId, trackId, layout = null) {
  const hit = new Map();
  return db.listLaps().filter((l) => {
    if (l.source !== 'local') return false;
    const k = `${l.track}|${l.layout}|${l.car}`;
    if (!hit.has(k)) {
      const h = cars.match(l.car)?.id === carId ? trackdata.find(l.track, l.layout) : null;
      hit.set(k, !!h && h.track.id === trackId && (!layout || h.layout.key === layout));
    }
    return hit.get(k);
  });
}
function setupTelemetry(setup, trackId, layout) {
  const laps = lapsForCatalogue(setup.carId, trackId, layout);
  if (!laps.length) return null;
  const valid = laps.filter((l) => l.valid);
  const best = valid.reduce((a, b) => (!a || b.lap_time_ms < a.lap_time_ms ? b : a), null);
  const out = { laps: laps.length, valid_laps: valid.length, recent_lap_times_ms: laps.slice(0, 15).map((l) => (l.valid ? l.lap_time_ms : `${l.lap_time_ms} (invalid)`)) };
  // the laps split by setup: which setup was faster, from the driver's own laps (setup recognition may be unconfirmed)
  const combos = [...new Map(laps.map((l) => [`${l.track}|${l.layout}|${l.car}`, { track: l.track, layout: l.layout, car: l.car }])).values()];
  try {
    // left out when the driver marked setup recognition as wrong (PL4: never used silently)
    out.by_setup = channels.usable('setupProbe') ? setuphistory.forAi(combos, setup.rel ?? null) : 'left out: setup recognition known to be wrong';
    // what by_setup's setup names and temperatures (air_c, track_c: left out when marked wrong) are worth
    out.by_setup_data_quality = channels.forAi(['setupProbe', 'conditions']);
    out.by_setup_note = `Setups are recognised from pit-box readings (${channels.trusted('setupProbe') ? 'checked against the game' : 'not checked against the game yet'}). this_setup = the laps driven with this setup's current values; this_setup_other_values = the same file with other (older) or unknown values. "Standard" = no saved setup matched; "Not recorded" = no setup recorded for those laps.`;
  } catch (e) { out.by_setup_note = `not available: ${e.message}`; }
  // what the car did in the latest session with car data (tyres, brakes, suspension, balance)
  for (const sid of [...new Set(laps.map((l) => l.session_id).filter(Boolean))].slice(0, 5)) {
    try {
      const r = carreport.build(sid);
      if (r.available) { out.car_behaviour_latest_session = { session_laps: r.laps, setup_driven: channels.usable('setupProbe') ? laps.find((l) => l.session_id === sid)?.setup_name ?? 'unknown' : 'left out: setup recognition known to be wrong', ...carreport.forAi(r) }; break; }
    } catch { /* skip */ }
  }
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
// the car on track now (checks of readings whose meaning depends on the car are made with it), or null
const liveCar = () => (inSession() ? recorder.session?.car || source.lastRaw?.frame?.car || null : null);
const clients = new Set();
const broadcast = (type, data) => { const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`; for (const c of clients) c.write(msg); };
// audio brake spotter: the open Paddock page plays what it says (sound and volume travel with each cue)
// PL9: nothing is said while the kill switch is on or the telemetry has stopped changing
const spotter = createSpotter({ config: settings.spotterConfig, blocked: () => (assist.isOff() ? 'off' : hud.telemetryStale() ? 'stale' : null),
  emit: (cue) => { const c = settings.spotterConfig(); broadcast('spotter', { ...cue, sound: c.sound, volume: c.volume }); } });
// own brake marks: marking them with a wheel button / keyboard shortcut, or from the brake pedal on one lap.
// The confirmation sounds go through the spotter's channel (always beeps, also when the spotter is off).
coach.setLiveSession(() => recorder.session?.id ?? null); // the session being driven is not checked against a plan yet
goals.setLiveSession(() => recorder.session?.id ?? null); // a consistency goal waits for the end of the session being driven
const marker = createMarker({ recorder,
  notify: (say) => broadcast('spotter', { say, sound: 'beep', volume: settings.spotterConfig().volume }),
  changed: (recording, combo) => broadcast('brakemarks', { recording, combo }) });
wheel.watchButton(() => settings.get().markButton, () => marker.press());
// keyboard shortcut: registered by the desktop app (desktop/main.cjs), which loads this server in its process
let markKeyState = 'none';
function bindMarkKey() {
  const accel = settings.get().markKey;
  if (!accel) { globalThis.__paddockSetMarkKey?.(null); markKeyState = 'none'; return; }
  if (!globalThis.__paddockSetMarkKey) { markKeyState = 'desktop-only'; return; }
  markKeyState = globalThis.__paddockSetMarkKey(accel, () => marker.press()) ? 'ok' : 'taken';
}
bindMarkKey();
// PL9 kill switch shortcut (Settings): a global shortcut of the desktop app, empty by default (opt-in)
let assistKeyState = 'none';
function bindAssistKey() {
  const accel = settings.get().assistKey;
  if (!accel) { globalThis.__paddockSetAssistKey?.(null); assistKeyState = 'none'; return; }
  if (!globalThis.__paddockSetAssistKey) { assistKeyState = 'desktop-only'; return; }
  assistKeyState = globalThis.__paddockSetAssistKey(accel, () => assist.set('toggle')) ? 'ok' : 'taken';
}
bindAssistKey();
// every change of the switch: the open pages (header bar) and the desktop app's tray menu
assist.onChange((off) => { broadcast('assist', { off }); globalThis.__paddockAssistChanged?.(off); });
globalThis.__paddockAssist = { isOff: () => assist.isOff(), set: (v) => assist.set(v) };
// PL9 context profiles: a session of a type with a chosen layout starts -> that layout (off unless switched on).
// Outside the telemetry tick (the 'session' event fires inside it): the settings file is written then.
recorder.on('session', (s) => setImmediate(() => {
  try { const n = hudLayouts.forSession(s?.sessionType); if (n) { hudLayouts.apply(n); console.log(`[hud] layout "${n}" for this session type`); } }
  catch (e) { console.log(`[hud] layout for this session not applied: ${e.message}`); }
}));

// a new lap: only its track + car is worked out again (service.js invalidate)
recorder.on('lap', (l) => { svc.invalidate(l); broadcast('lap', l); afterLap(l); console.log(`[lap] ${l.track}/${l.car} ${(l.lapTimeMs / 1000).toFixed(3)}s ${l.valid ? 'valid' : 'INVALID'} -> #${l.id}`); });
// driver development (P9): goals met by this lap, achievements reached, sessions Paddock started (race weekends)
game.onStarted((order) => { try { weekends.recordStart(order); devChanged(); } catch (e) { console.log(`[weekends] ${e.message}`); } });
// a goal met for the first time, wherever it was noticed (after a lap, at the end of a session, on a page load)
goals.setOnMet((g) => {
  const what = g.challenge ? 'Challenge done' : 'Goal met';
  console.log(`[goal] ${what}: ${g.text}`);
  broadcast('goal', { id: g.id, text: g.text, challenge: g.challenge });
  globalThis.__paddockNotify?.({ title: `${what}: ${g.combo.track} · ${g.combo.car}`, body: g.text, hash: '#/development' });
});
// a practice drill met for the first time (noticed when the practice data is worked out: Development, Lap analysis)
drills.setOnMet((d) => {
  const text = `${d.corner}: ${d.label}`;
  console.log(`[drill] Drill met: ${text}`);
  broadcast('goal', { id: d.id, text: `Drill met: ${text}`, challenge: false });
  globalThis.__paddockNotify?.({ title: `Drill met: ${d.combo.track} · ${d.combo.car}`, body: text, hash: '#/development' });
});
let knownAchievements = null; // ids unlocked so far (null until first worked out: nothing is announced at start)
// goals + achievements, worked out once per change (laps, goals, launches, the live session) and at most once a minute
// otherwise (challenge deadlines pass with time): Home and Development reuse it
let devVersion = 0, devCache = null;
const devChanged = () => { devVersion++; };
function development() {
  const live = recorder.session?.id ?? null;
  if (devCache && devCache.version === devVersion && devCache.live === live && Date.now() - devCache.at < 60e3) return devCache.data;
  const list = goals.list();
  const laps = db.listLaps().filter((l) => l.source === 'local');
  const data = { goals: list, achievements: achievements.compute({ laps, goals: list, weekends: weekends.history(laps), live }) };
  devCache = { version: devVersion, live, at: Date.now(), data };
  return data;
}
function announceAchievements() {
  try {
    const now = development().achievements.filter((a) => a.unlockedAt != null);
    if (knownAchievements) for (const a of now.filter((x) => !knownAchievements.has(x.id))) {
      console.log(`[achievement] ${a.title}`);
      broadcast('achievement', { id: a.id, title: a.title, text: a.text });
      globalThis.__paddockNotify?.({ title: `Achievement: ${a.title}`, body: a.text, hash: '#/development' });
    }
    knownAchievements = new Set(now.map((a) => a.id));
  } catch (e) { console.log(`[achievement] ${e.message}`); }
}
// after a lap, and at the end of a session (consistency goals wait for it): goals met for the first time (announced by
// setOnMet), then achievements. Run a few seconds later, not inside the telemetry loop that saved the lap.
function checkGoals(c) {
  devChanged();
  try { goals.checkAfterLap({ track: c.track, layout: c.layout, car: c.car }); } catch (e) { console.log(`[goal] ${e.message}`); }
  announceAchievements();
}
let afterLapT = null;
const pendingCombos = new Map();
function afterLap(l) {
  devChanged();
  pendingCombos.set(`${l.track}|${l.layout}|${l.car}`, l);
  clearTimeout(afterLapT);
  afterLapT = setTimeout(() => { const cs = [...pendingCombos.values()]; pendingCombos.clear(); cs.forEach((c, i) => (i === cs.length - 1 ? checkGoals(c) : goals.checkAfterLap(c))); }, 3000);
}
setTimeout(announceAchievements, 2000); // what is already unlocked at start is not announced
recorder.on('session', (s) => console.log(`[session] ${s.track} ${s.layout} / ${s.car}`));
recorder.on('discarded', (e) => console.log(`[lap discarded] ${e.reason}`));
// end of a session: keep its conditions, then the session report (needs a few laps and a valid one)
recorder.on('sessionEnd', (s) => {
  if (!s.id) return;
  try { if (db.lapsOfSession(s.id).length) drivenSession = s.id; } catch { /* not opened on game exit */ }
  setTimeout(() => checkGoals(s), 400); // the session is no longer "being driven" by then
  try { const c = setupTracker.conditions(); if (c) db.setSessionConditions(s.id, c); } catch (e) { console.log(`[report] conditions not saved: ${e.message}`); }
  setTimeout(async () => {
    try {
      const laps = db.lapsOfSession(s.id);
      if (laps.length < report.MIN_LAPS || !laps.some((l) => l.valid)) return;
      await warmSession(s.id); // the car and track's history read in slices (PL3), then the report at once
      const r = report.make(s.id);
      const text = report.headline(r);
      console.log(`[report] session ${s.id}: ${text}`);
      broadcast('report', { sessionId: s.id, headline: text });
      globalThis.__paddockNotify?.({ title: `Session report ready: ${s.track} · ${s.car}`, body: text, hash: `#/report?session=${s.id}` });
    } catch (e) { console.log(`[report] session ${s.id}: ${e.message}`); }
  }, 300);
});

// when AC EVO closes: bring the desktop app to the front on the session driven in that game run (Settings
// switch, on by default). Only a session with saved laps; nothing if the game was closed from the menus.
let drivenSession = null, gameWasRunning = false;
setInterval(() => {
  const on = game.isRunning();
  if (on && !gameWasRunning) drivenSession = null; // a new game run: sessions from the last one don't count
  if (!on && gameWasRunning) {
    recorder.endSession(); // usually done already (packets stopped); finalizes the last lap otherwise
    setTimeout(() => { // after the session report (made 300 ms after the session ends)
      if (drivenSession && settings.get().openLastSession !== false) {
        console.log(`[game] closed: opening session ${drivenSession}`);
        globalThis.__paddockOpen?.(`#/report?session=${drivenSession}`);
      }
      drivenSession = null;
    }, 1500);
  }
  gameWasRunning = on;
}, 2000).unref?.();

let lastPacket = null, lastPacketChange = Date.now(), stale = false;
perf.start(); // bounded timing of this loop and of the event loop (src/perf.js, Settings → Diagnostics)
setInterval(() => {
  const t0 = perf.tickStart();
  try {
    source.tick?.();
    const f = source.read();
    if (!f) { recorder.state.connected = false; recorder.state.status = 'waiting for game'; return; }
    // game closed or frozen: packet id stops changing
    if (f.packetId !== lastPacket) { lastPacket = f.packetId; lastPacketChange = Date.now(); stale = false; }
    else if (Date.now() - lastPacketChange > 3000 && f.status !== 3) {
      if (!stale) { stale = true; recorder.endSession(); }
      recorder.state.status = 'game not running';
      return;
    }
    recorder.state.packetAt = lastPacketChange; // the HUD labels telemetry that stopped changing (PL9, src/live.js freshness)
    // recording off (D-PL5-19): telemetry.db was made by a newer Paddock; the game is seen, nothing is recorded or worked on
    if (db.blocked) { Object.assign(recorder.state, { connected: true, lastFrameAt: Date.now(), status: 'recording off' }); return; }
    recorder.onFrame(f);
    setupTracker.onFrame(f);
    board.onFrame(f);
    hud.onFrame(f);
    marker.onFrame(f);
    spotter.tick(hud.nextBrake());
  } catch (e) { console.error('telemetry error', e); }
  finally { perf.tickEnd(t0); }
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
const readBody = (req, max = 50e6) => new Promise((resolve, reject) => {
  const chunks = []; let size = 0;
  req.on('data', (c) => { size += c.length; if (size > max) { reject(Object.assign(new Error('The upload is too large'), { code: 413 })); req.destroy(); } else chunks.push(c); });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});
const readJson = async (req, max) => { const b = await readBody(req, max); return b.length ? JSON.parse(b.toString()) : {}; };
const NOTES_BODY = 64 * 1024; // a note (4000 characters) and its tags fit many times over

const MIME = { '.wav': 'audio/wav', '.woff2': 'font/woff2', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
function serveStatic(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}
const safeName = (s) => String(s).replace(/[^a-z0-9_.-]+/gi, '_');

// ---------------------------------------------------------------- routes
// Only Paddock's own pages may use the API. The server listens on 127.0.0.1 only, but a web page open in the
// browser could still send requests to it (cross-site requests, DNS rebinding): those are refused here.
const OWN_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
// GETs that hand out private data (backups with the key, laps, exports, diagnostics, setups): refused when another
// site asks, like writes (a page on another local port is "same-site" but not Paddock). Navigations typed or opened
// from outside the browser have no Sec-Fetch-Site or "none" and stay allowed.
const PRIVATE_GET = /^\/api\/(backup\/file|laps\/\d+\/export|export\/|diagnostics|setups\/export|health|notes|onboarding|overview|dashboard|analysis|practice|experiments)/; // overview + dashboard carry tags and note lines (PL5); analysis carries bookmark counts and lap ids (PL6 review); practice: drills and lap ids (PL7); experiments: setup names, journal and lap ids (PL8)
function foreignRequest(req, p = '') {
  const host = String(req.headers.host || '').toLowerCase();
  const name = host.replace(/:\d+$/, '');
  if (!OWN_HOSTS.has(name)) return 'unknown host';
  if (req.method === 'GET' || req.method === 'HEAD') {
    if (!PRIVATE_GET.test(p)) return null;
    const site = req.headers['sec-fetch-site'];
    if (site === 'cross-site' || site === 'same-site') return `${site} request for private data`;
  }
  if (req.headers['sec-fetch-site'] === 'cross-site') return 'cross-site request';
  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    let o; try { o = new URL(origin); } catch { return 'bad origin'; }
    if (!OWN_HOSTS.has(o.hostname === '::1' ? '[::1]' : o.hostname) || o.port !== (host.match(/:(\d+)$/)?.[1] ?? '')) return 'foreign origin';
  } else if (origin === 'null') return 'opaque origin';
  return null;
}

// PL3: the cars and tracks a page works out (best lap, corners, ideal lap) are read in slices first, so a long lap
// history does not hold up the 60 Hz telemetry loop for seconds (the page waits instead; the result is the same).
async function warmSession(sid) {
  const s = db.getSession(sid);
  if (!s) return;
  await svc.warmCombos([s]);
  await svc.warmLaps(db.lapsOfSession(sid).map((l) => l.id)); // the session's own laps are read in full
  // and the previous session's, when its report is made on the way (its targets are checked)
  const prev = report.previousSession(sid);
  if (prev != null && !db.getReport(prev)) await svc.warmLaps(db.lapsOfSession(prev).map((l) => l.id));
}
async function warmFor(p, q) {
  try {
    if (p === '/api/overview' || p === '/api/dashboard') return await svc.warmCombos();
    if (!p.startsWith('/api/')) return;
    const combo = q.get('track') && q.get('layout') != null && q.get('car') ? { track: q.get('track'), layout: q.get('layout'), car: q.get('car') } : null;
    if (combo) return await svc.warmCombos([combo]);
    const sid = Number(q.get('session'));
    if (sid > 0 && /^\/api\/(report|carreport)$/.test(p)) await warmSession(sid);
  } catch { /* the route itself reports unreadable data */ }
}

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const m = req.method;
  const foreign = foreignRequest(req, p);
  if (foreign) { console.warn(`[http] refused ${m} ${p}: ${foreign} (host ${req.headers.host}, origin ${req.headers.origin ?? '-'})`); return send(res, 403, { error: 'Forbidden' }); }
  if (m === 'GET') await warmFor(p, url.searchParams);

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
  if (p === '/api/hud') return send(res, 200, hudSnapshot());
  if (p === '/api/hud/ref' && m === 'POST') {
    const { mode = 'cycle' } = await readJson(req);
    if (!assist.isOff()) hud.setMode(mode);
    return send(res, 200, hudSnapshot());
  }

  // ---- PL9 kill switch (HUD and cues) and HUD layouts: Paddock's own pages only (not under /api/hud, which is open
  // to the overlay and the in-game app)
  if (p === '/api/assist') {
    if (m === 'POST') {
      const { off } = await readJson(req, 1024);
      if (typeof off !== 'boolean' && off !== 'toggle') return send(res, 400, { error: 'off must be true, false or "toggle"' });
      return send(res, 200, assist.set(off));
    }
    return send(res, 200, { off: assist.isOff() });
  }
  if (p === '/api/hudlayouts') {
    try {
      if (m === 'POST') {
        const b = await readJson(req, 16384);
        if (b.action === 'save') return send(res, 200, { ...hudLayouts.save(b.name), hud: settings.hudConfig() });
        if (b.action === 'apply') return send(res, 200, { ...hudLayouts.view(), hud: hudLayouts.apply(b.name) });
        if (b.action === 'delete') return send(res, 200, { ...hudLayouts.remove(b.name), hud: settings.hudConfig() });
        if (b.action === 'contexts') return send(res, 200, { ...hudLayouts.setContexts(b), hud: settings.hudConfig() });
        return send(res, 400, { error: 'Unknown action' });
      }
      return send(res, 200, { ...hudLayouts.view(), hud: settings.hudConfig() });
    } catch (e) { return send(res, e.code >= 400 && e.code < 600 ? e.code : 500, { error: e.message }); }
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
      .map(({ key: k, track: gt, layout: gl, car, laps, bestMs, idealMs, lastAt, bestLapId }) => ({ key: k, gameTrack: gt, gameLayout: gl, car, laps, bestMs, idealMs, lastAt, bestLapId }));
    const { layouts, ...track } = t;
    track.layouts = layouts.map((x) => ({ key: x.key, name: x.name, lengthM: x.lengthM }));
    return send(res, 200, { track, layout: { key: l.key, name: l.name, lengthM: l.lengthM, hasMap: !!l.svg }, model, combos });
  }
  // ---- Game tab
  if (p === '/api/game' && m === 'GET') return send(res, 200, { ...game.status(), loaderInfo: loaderInstall.status(), telemetry: { ...recorder.state, live: recorder.live() } });
  // integration health (PL4.3, Game page): from what Paddock already knows; no network request, nothing new read from the game
  if (p === '/api/health' && m === 'GET') {
    const safe = (fn) => { try { return fn(); } catch (e) { return { error: e.message }; } };
    const g = safe(() => game.status());
    return send(res, 200, health.build({
      mock: mockIdx >= 0, aceFound: fs.existsSync(ACE), game: g,
      telemetry: { ...recorder.state, source: source.name, packetAgeMs: lastPacket == null ? null : Date.now() - lastPacketChange, stale },
      perf: perf.summary(), hud: safe(() => hudInstall.status({ quick: true })), channels: channels.list({ car: liveCar() }), checkContext: channels.context(),
      bridge: bridge ? bridge.stats() : null, assistOff: assist.isOff(),
      board: safe(() => board.health()), updates: safe(() => updates.status()), dbBlocked: db.blocked,
    }));
  }
  // the setup guide (PL5, src/onboarding.js): what it shows, and the driver's choices in it (skips change nothing else)
  if (p === '/api/onboarding') {
    if (m === 'POST') {
      try {
        const b = await readJson(req, 4096);
        settings.update({ onboarding: onboarding.nextState(settings.get().onboarding, b) });
        // skipping game mods switches off the automatic HUD + App Loader install (OD-PL-22 (b)); undo switches it on again
        if (b.step === 'mods' && (b.action === 'skip' || b.action === 'unskip')) hudInstall.setAutoInstall(b.action === 'unskip');
      } catch (e) { return send(res, e.code >= 400 && e.code < 600 ? e.code : 500, { error: e.message }); }
    }
    const safe = (fn) => { try { return fn(); } catch { return null; } };
    return send(res, 200, onboarding.build({ settings: settings.get(), aceFound: fs.existsSync(ACE), contentFound: !!safe(() => trackdata.archive()?.file),
      hud: safe(() => hudInstall.status({ quick: true })) }));
  }
  if (p === '/api/game/launch' && m === 'POST') return send(res, 200, startGame(null));
  if (p === '/api/game/cancel' && m === 'POST') { game.cancel(); return send(res, 200, { ok: true }); }

  // ---- cars, from AC EVO's own files
  if (p === '/api/cars') return send(res, 200, cars.catalog());
  // Cars tab: every car with what you did with it, and one car's statistics
  if (p === '/api/cars/stats') { try { return send(res, 200, carstats.overview()); } catch (e) { return send(res, 500, { error: e.message }); } }
  if (p === '/api/cars/detail') { try { return send(res, 200, carstats.detail(url.searchParams.get('car'))); } catch (e) { return send(res, e.status || 500, { error: e.message }); } }
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
        return send(res, 200, { cars: setups.cars(), list: car ? setups.list(car, track) : [], game: car ? setups.gameList(car) : [], ...setups.status() });
      }
      if (p === '/api/setups/meta') return send(res, 200, { groups: carsetup.GROUPS, corners: carsetup.CORNER_LABEL });
      // edited values: {id, values: {name: value}, asName?} -> saved over the file, or as a new file when asName is given
      if (p === '/api/setups/values' && m === 'POST') { const { id, values, asName, notes, from, track } = await readJson(req); return send(res, 200, setups.saveValues(id, values, { asName: asName ?? null, notes, from: from === 'ai' ? 'ai' : 'paddock', trackId: track || null })); }
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
        // a setup file is a few kB: a body over the limit is not read whole (413)
        let buf;
        try { buf = await readBody(req, setups.MAX_SETUP_BYTES + 1); } catch (e) { return send(res, e.code === 413 ? 413 : 400, { error: e.code === 413 ? 'Not an AC EVO setup file (.carsetup): far too big' : e.message }); }
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
  // Settings → In-game HUD: the automatic install on or off (the existing hud-removed / loader-removed flags)
  if (p === '/api/mods/hud/auto' && m === 'POST') { const { on } = await readJson(req, 1024); if (typeof on !== 'boolean') return send(res, 400, { error: 'on must be true or false' }); return send(res, 200, hudInstall.setAutoInstall(on)); }
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
  // ---- session reports
  if (p === '/api/reports') {
    const stored = db.listReports();
    const have = new Set(stored.map((r) => r.sessionId));
    const counts = new Map();
    for (const l of db.listLaps()) if (l.session_id != null && l.source === 'local') {
      const c = counts.get(l.session_id) || { laps: 0, valid: 0 }; c.laps++; if (l.valid) c.valid++; counts.set(l.session_id, c);
    }
    const reports = stored.map((r) => ({ sessionId: r.sessionId, createdAt: r.createdAt, startedAt: r.data.startedAt, combo: r.data.combo,
      bestMs: r.data.best.ms, avgMs: r.data.average.cleanMs, laps: r.data.laps, newPb: r.data.improvement.newPb, headline: report.headline(r.data) }));
    // sessions without a report yet (older sessions, or too short for an automatic one)
    const sessions = db.listSessions().filter((s) => !have.has(s.id) && counts.get(s.id)?.valid)
      .map((s) => ({ sessionId: s.id, startedAt: s.started_at, combo: { track: s.track, layout: s.layout, car: s.car }, ...counts.get(s.id) }));
    return send(res, 200, { reports, sessions });
  }
  if (p === '/api/report' && m === 'GET') {
    const id = Number(url.searchParams.get('session'));
    let r = db.getReport(id);
    const laps = db.lapsOfSession(id).map(({ setup_info: _, ...l }) => l);
    if (!r) {
      // too short for a report: the session page shows the basics and the laps
      if (!laps.length) return send(res, 404, { error: 'This session has no laps.' });
      if (laps.length < report.MIN_LAPS || !laps.some((l) => l.valid)) return send(res, 200, { data: null, session: db.getSession(id) ?? null, laps, hasKey: !!settings.get().geminiApiKey, probeConfirmed: channels.trusted('setupProbe'), channels: channels.summary() });
      try { report.make(id); r = db.getReport(id); } catch (e) { return send(res, 400, { error: e.message }); }
    }
    const c = r.data.combo;
    return send(res, 200, { ...r, setupChoices: setupmatch.candidates(c.car, c.track, c.layout).map((x) => ({ name: x.file.name, rel: x.file.rel })),
      probeConfirmed: channels.trusted('setupProbe'), channels: channels.summary(), hasKey: !!settings.get().geminiApiKey,
      ai: r.ai ? { ...r.ai, ...ai.splitConfidence(r.ai.text) } : null, laps, technique: TECHNIQUE, plan: coach.planForSession(id, c) });
  }
  if (p === '/api/report/regenerate' && m === 'POST') {
    const { session } = await readJson(req);
    try { report.make(Number(session)); return send(res, 200, { ok: true }); } catch (e) { return send(res, 400, { error: e.message }); }
  }
  // the driver corrects the setup of some laps: {session, lapIds, rel} (rel null = Standard)
  if (p === '/api/report/setup' && m === 'POST') {
    const { session, lapIds = [], rel = null } = await readJson(req);
    const own = new Set(db.lapsOfSession(Number(session)).map((l) => l.id));
    const ids = lapIds.map(Number).filter((id) => own.has(id));
    if (!ids.length) return send(res, 400, { error: 'No laps of this session given' });
    try { db.setLapSetups(ids, setupmatch.manual(rel)); report.make(Number(session)); return send(res, 200, { ok: true }); }
    catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (p === '/api/report/ai' && m === 'POST') {
    const { session } = await readJson(req);
    const r = db.getReport(Number(session));
    if (!r) return send(res, 404, { error: 'Report not found' });
    const out = await ai.debrief(r.data);
    db.saveReportAi(Number(session), out.text, out.model);
    return send(res, 200, { ...out, ...ai.splitConfidence(out.text), at: Date.now() });
  }
  // ---- setup fingerprint check (Setups tab): what Paddock reads in the pits against the saved setups
  if (p === '/api/setupcheck' && m === 'GET') {
    return send(res, 200, { live: setupTracker.live(), current: setupTracker.current(), conditions: setupTracker.conditions(),
      probe: source.lastRaw?.frame?.probe ?? null, carData: source.lastRaw?.frame?.carData ?? null, inSession: inSession(), confirmed: channels.trusted('setupProbe'), channels: channels.list({ car: liveCar() }), checkContext: channels.context(), aids: aidsTracker.live() });
  }
  // car & setup report of a session (tyres, brakes, suspension, balance): Car & setup tab
  if (p === '/api/carreport' && m === 'GET') {
    try {
      const r = carreport.build(Number(url.searchParams.get('session')));
      if (r.combo) { // ids the Setups page knows, for "Ask the AI engineer"
        const h = trackdata.find(r.combo.track, r.combo.layout);
        r.links = { car: cars.match(r.combo.car)?.id ?? null, track: h?.track.id ?? null, layout: h?.layout.key ?? null, setup: setups.setupOfSession(Number(url.searchParams.get('session'))) };
      }
      return send(res, 200, r);
    } catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (p === '/api/setupcheck/confirm' && m === 'POST') {
    // {group, ok}: ok true = the readings match the game, false = they do not, null = forget the check.
    // Without a group (Paddock before 0.6): the pit-box readings and the temperatures.
    const { group, ok = null } = await readJson(req);
    try {
      for (const g of group ? [group] : ['setupProbe', 'conditions']) channels.confirm(g, ok, { car: liveCar() });
      return send(res, 200, { confirmed: channels.trusted('setupProbe'), channels: channels.list({ car: liveCar() }), checkContext: channels.context() });
    } catch (e) { return send(res, e.code === 409 ? 409 : 400, { error: e.message }); }
  }
  // what each telemetry reading is worth: checked against the game or not (src/channels.js)
  if (p === '/api/channels') return send(res, 200, channels.list({ car: liveCar() }));
  // ---- application management (Settings): backups, export, diagnostics, updates
  if (p.startsWith('/api/backup')) {
    const busy = () => (inSession() ? send(res, 409, { error: 'You are on track: back up or restore when you are in the menus or AC EVO is closed (it would stall the lap recording).' }) : null);
    try {
      if (p === '/api/backup' && m === 'GET') return send(res, 200, { backups: backup.listBackups(), parts: backup.parts(), pending: backup.pending(), restored: db.restoreResult, folder: backup.BACKUP_DIR });
      if (p === '/api/backup' && m === 'POST') {
        if (busy()) return;
        const { includeSecrets = false, parts = null } = await readJson(req);
        return send(res, 200, await backup.create({ includeSecrets: includeSecrets === true, parts: Array.isArray(parts) ? parts.map(String) : null, appVersion: VERSION }));
      }
      if (p === '/api/backup/file' && m === 'GET') {
        const name = url.searchParams.get('name');
        const file = backup.fileOf(name);
        if (!fs.existsSync(file)) return send(res, 404, { error: 'Backup not found' });
        res.writeHead(200, { 'content-type': 'application/zip', 'content-length': fs.statSync(file).size, 'content-disposition': `attachment; filename="${name}"` });
        return fs.createReadStream(file).pipe(res);
      }
      if (p === '/api/backup/file' && m === 'DELETE') { backup.remove(url.searchParams.get('name')); return send(res, 200, { ok: true }); }
      if (p === '/api/backup/upload' && m === 'POST') { // streamed: a backup can be big
        fs.mkdirSync(backup.BACKUP_DIR, { recursive: true });
        const tmp = path.join(backup.BACKUP_DIR, `.upload-${Date.now()}-${process.pid}`);
        // capped: nothing bigger than the largest backup Paddock makes (the disk is not filled by a stray upload)
        try { await pipeline(req, limitBytes(backup.MAX_UPLOAD, 'The uploaded backup'), fs.createWriteStream(tmp)); return send(res, 200, backup.importUpload(tmp)); } finally { fs.rmSync(tmp, { force: true }); }
      }
      if (p === '/api/backup/restore' && m === 'POST') {
        if (busy()) return;
        const { name } = await readJson(req);
        const out = await backup.stageRestore(name, { appVersion: VERSION, stillIdle: () => !inSession() });
        send(res, 200, { ...out, restarting: true });
        setTimeout(restartApp, 300); // the files are swapped at the next start, before the database is opened
        return;
      }
      if (p === '/api/backup/restore' && m === 'DELETE') { backup.cancelRestore(); return send(res, 200, { ok: true }); }
    } catch (e) { return send(res, e.code >= 400 && e.code < 600 ? e.code : 500, { error: e.message }); }
  }
  if (p === '/api/export/laps.csv' || p === '/api/export/sessions.csv') {
    const laps = p.endsWith('laps.csv');
    const body = '﻿' + (laps ? dataexport.lapsCsv() : dataexport.sessionsCsv()); // BOM: Excel reads UTF-8 track names right
    const day = new Date().toISOString().slice(0, 10);
    res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="paddock-${laps ? 'laps' : 'sessions'}-${day}.csv"` });
    return res.end(body);
  }
  // recording timing only (numbers, no private data); a private GET like the full report (PRIVATE_GET)
  if (p === '/api/diagnostics/perf') return send(res, 200, perf.summary());
  if (p === '/api/diagnostics') {
    const d = diagnostics.build({
      version: VERSION, source: source.name, recorder: recorder.state, performance: perf.summary(),
      game: (() => { try { const g = game.status(); return { running: g.running, version: g.version ?? g.gameVersion ?? null, hudVersion: g.hudVersion ?? null }; } catch (e) { return { error: e.message }; } })(),
      loader: (() => { try { return loaderInstall.status(); } catch (e) { return { error: e.message }; } })(),
      hud: (() => { try { return hudInstall.status(); } catch (e) { return { error: e.message }; } })(),
      bridge: bridge ? bridge.stats() : null, assistOff: assist.isOff(),
      paths: { gameFiles: ACE, gameFilesExists: fs.existsSync(ACE), contentArchive: (() => { try { return trackdata.archive()?.file ?? 'not found'; } catch (e) { return `not found (${e.message})`; } })() },
    });
    return send(res, 200, url.searchParams.get('format') === 'text' ? { text: d.text } : d.data);
  }
  if (p === '/api/updates' && m === 'GET') return send(res, 200, updates.status());
  if (p === '/api/updates/check' && m === 'POST') {
    if (mockIdx >= 0 && !process.env.PADDOCK_UPDATE_CHECK) return send(res, 200, { ...updates.status(), error: 'Not checked in a mock run' });
    return send(res, 200, await updates.check());
  }
  // home page: the driver's data (src/service.js dashboard) plus what needs attention, each with where to fix it
  if (p === '/api/dashboard') {
    const warnings = [];
    const add = (level, text, href, label) => warnings.push({ level, text, href, label });
    const safe = (fn) => { try { return fn(); } catch { return null; } };
    if (db.blocked) add('warning', db.blocked.message, '#/game', 'Game → Integration health');
    if (backup.pending()) add('warning', 'A restore is waiting for Paddock to restart.', '#/settings', 'Settings → Backup and restore');
    if (db.restoreResult && !db.restoreResult.ok) add('warning', `The last restore did not complete: ${db.restoreResult.error}`, '#/settings', 'Settings → Backup and restore');
    if (!fs.existsSync(ACE)) add('warning', "AC EVO's game files folder was not found, so the HUD, mods and setups are not available.", '#/settings', 'Settings → Game files folder');
    const hud = safe(() => hudInstall.status({ quick: true })); // quick: no tasklist call (this runs after every lap)
    if (hud?.state === 'outdated') add('warning', `A Paddock HUD update (${hud.installed} → ${hud.bundled}) is waiting for AC EVO to close.`, '#/mods', 'Mods');
    else if (hud?.state === 'missing' && !hud.removed && fs.existsSync(ACE)) add('warning', hud.autoError ? `The Paddock HUD could not be installed: ${hud.autoError}` : 'The Paddock HUD is not installed yet; Paddock installs it when AC EVO is closed.', '#/mods', 'Mods');
    const loader = hud?.loaderInfo ?? safe(() => loaderInstall.status());
    if (loader?.gameMatch === false) add('warning', `AC EVO was updated (${loader.game}); the bundled ACE UI App Loader is for ${loader.builtFor}. Update Paddock when a new version is out.`, '#/game', 'Game');
    const unchecked = channels.list().filter((g) => g.confirmable && g.status !== 'verified');
    const wrong = unchecked.filter((g) => g.status === 'mismatch');
    const again = unchecked.filter((g) => g.status === 'unverified' && g.needsRecheck);
    if (wrong.length) add('warning', `${wrong.length} telemetry reading group${wrong.length === 1 ? '' : 's'} marked as not matching the game: their hints are left out.`, '#/setups', 'Setups → Setup recognition');
    else if (again.length) add('info', `${again.length} telemetry reading group${again.length === 1 ? ' was' : 's were'} checked on another game version or with an older reader: check ${again.length === 1 ? 'it' : 'them'} again. Until then their hints are shown as unconfirmed.`, '#/setups', 'Setups → Setup recognition');
    else if (unchecked.length) add('info', `${unchecked.length} of ${channels.CONFIRMABLE.length} telemetry reading groups are not checked against the game yet, so tyre, brake and suspension hints are shown as unconfirmed.`, '#/setups', 'Setups → Setup recognition');
    const up = updates.status();
    if (up.enabled && up.latest) add('info', `AC EVO Paddock ${up.latest.version} is out.`, '#/settings', 'Settings → Updates');
    if (!settings.get().geminiApiKey) add('info', 'The AI coach, debrief and setup engineer need a free Gemini API key.', '#/settings', 'Settings');
    const dev = safe(() => {
      const { goals: list, achievements: all } = development();
      const a = achievements.withSeen(all);
      return { goals: list.filter((g) => g.state === 'open').slice(0, 4), metRecently: list.filter((g) => g.state === 'met' && Date.now() - g.met.at < 7 * 86400e3).slice(0, 3),
        achievements: { unlocked: a.unlocked, total: a.total, fresh: a.items.filter((x) => x.isNew).length,
          recent: a.items.filter((x) => x.unlockedAt != null).sort((x, y) => y.unlockedAt - x.unlockedAt).slice(0, 3) } };
    });
    const d = svc.dashboard();
    // PL5: the practice objective for the last car and track driven: an open goal or challenge there, else its training
    // plan, else its newest report's targets, else any open goal. The last session's own notes and tags.
    const last = d.recentSessions[0];
    const same = (c) => last && c.track === last.track && c.layout === last.layout && c.car === last.car;
    let objective = null;
    const goal = dev?.goals.find((g) => same(g.combo)) || null;
    const plan = last && !goal ? safe(() => db.activePlan(last)) : null;
    const tg = last && !goal && !plan ? d.targets.find(same) : null;
    if (goal) objective = { kind: goal.challenge ? 'challenge' : 'goal', combo: goal.combo, text: goal.text, progress: goal.progressText, href: '#/development' };
    else if (plan) objective = { kind: 'plan', combo: plan.combo, items: plan.targets.map((t) => t.text).slice(0, 3), href: `#/coach?combo=${encodeURIComponent(`${last.track}|${last.layout}|${last.car}`)}` };
    else if (tg) objective = { kind: 'targets', combo: { track: tg.track, layout: tg.layout, car: tg.car }, items: tg.targets.map((t) => t.text).slice(0, 3), href: `#/report?session=${tg.sessionId}&tab=report` };
    else if (dev?.goals[0]) objective = { kind: dev.goals[0].challenge ? 'challenge' : 'goal', combo: dev.goals[0].combo, text: dev.goals[0].text, progress: dev.goals[0].progressText, href: '#/development' };
    const lastNotes = last ? safe(() => notes.summaries().get(last.id)) ?? null : null;
    return send(res, 200, { ...d, warnings, recording: recorder.state.status === 'live', development: dev, objective, lastNotes });
  }
  if (p === '/api/status') return send(res, 200, { source: source.name, state: recorder.state, settings: settings.publicView() });
  // the Sessions page: laps, sessions, and from each saved report what the session strip shows
  if (p === '/api/overview') {
    const reports = Object.fromEntries(db.listReports().map((r) => [r.sessionId, { weakest: (r.data.corners?.weakest || []).map((w) => w.name) }]));
    return send(res, 200, { ...svc.overview(), reports, notes: Object.fromEntries(notes.summaries()) });
  }
  if (p === '/api/consistency') {
    const q = url.searchParams;
    return send(res, 200, svc.consistency({ track: q.get('track'), layout: q.get('layout'), car: q.get('car') },
      q.get('session') || 'all', q.get('invalid') === '1'));
  }
  // lap analysis (PL6): corner opportunities, distributions, target lap, trends, PB explanation; worked out in slices
  if (p === '/api/analysis') {
    const q = url.searchParams;
    try {
      return send(res, 200, await svc.lapAnalysisAsync({ track: q.get('track'), layout: q.get('layout'), car: q.get('car') }, { window: q.get('window'), match: q.get('match') }));
    } catch (e) { if (/^No valid laps/.test(e.message)) return send(res, 404, { error: e.message }); throw e; }
  }
  // setup history (P7): every setup driven on a track + car, and two of them compared value by value
  if (p === '/api/setuphistory') {
    const q = url.searchParams, combo = { track: q.get('track'), layout: q.get('layout'), car: q.get('car') };
    return send(res, 200, { combo, entries: setuphistory.history(combo), probe: channels.status('setupProbe') });
  }
  if (p === '/api/setuphistory/diff') {
    const q = url.searchParams;
    try { return send(res, 200, setuphistory.diff({ track: q.get('track'), layout: q.get('layout'), car: q.get('car') }, q.get('a'), q.get('b'))); } catch (e) { return send(res, 400, { error: e.message }); }
  }
  // the track + car combos with laps for a Setups-tab car and track (catalogue ids): the link to their setup history
  if (p === '/api/setuphistory/combos') {
    const q = url.searchParams, carId = q.get('carId'), trackId = q.get('trackId');
    const out = new Map();
    for (const l of lapsForCatalogue(carId, trackId)) {
      const k = `${l.track}|${l.layout}|${l.car}`;
      if (!out.has(k)) out.set(k, { key: k, track: l.track, layout: l.layout, car: l.car, laps: 0 });
      out.get(k).laps++;
    }
    return send(res, 200, { combos: [...out.values()] });
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

  // the driver's own session notes, tags and corner bookmarks (PL5, src/notes.js): local only; bodies capped (64 KB)
  if (p.startsWith('/api/notes')) {
    try {
      if (p === '/api/notes' && m === 'GET') return send(res, 200, notes.forSession(url.searchParams.get('session')));
      if (p === '/api/notes' && m === 'POST') { const b = await readJson(req, NOTES_BODY); return send(res, 200, notes.save(b.session, { text: b.text, tags: b.tags })); }
      if (p === '/api/notes/bookmark' && m === 'POST') { const b = await readJson(req, NOTES_BODY); return send(res, 200, notes.addBookmark(b.session, { corner: b.corner, note: b.note })); }
      if (p === '/api/notes/bookmark' && m === 'DELETE') return send(res, 200, notes.forSession(notes.removeBookmark(url.searchParams.get('id'))));
      if (p === '/api/notes/index' && m === 'GET') return send(res, 200, { tags: notes.allTags(), bookmarks: notes.recentBookmarks(), sessions: Object.fromEntries(notes.summaries()) });
      return send(res, 404, { error: 'not found' });
    } catch (e) { return send(res, e.code >= 400 && e.code < 600 ? e.code : 500, { error: e.message }); }
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
    const file = lapfile.exportLapFile(lap); // without the leaderboard data (OD-PL-2)
    const meta = lap;
    const name = safeName(`${meta.track}_${meta.car}_${meta.driver}_${(meta.lap_time_ms / 1000).toFixed(3)}.lap.gz`);
    res.writeHead(200, { 'content-type': 'application/gzip', 'content-disposition': `attachment; filename="${name}"` });
    return res.end(file);
  }
  if (p === '/api/laps/import' && m === 'POST') {
    // checked within fixed limits before anything is stored (src/lapfile.js); one INSERT, so all or nothing
    try {
      const { lap, recordedAtGiven } = lapfile.parseLapFile(await readBody(req, lapfile.LIMITS.fileBytes));
      const same = recordedAtGiven ? db.findSameLap(lap) : null;
      if (same) return send(res, 409, { error: `This lap is already in Paddock (lap #${same.id}, ${same.driver}, ${(same.lap_time_ms / 1000).toFixed(3)} s)`, existing: same.id });
      const id = db.insertLap({ ...lap, sessionId: null, source: 'import' });
      svc.invalidate();
      return send(res, 200, { ok: true, id });
    } catch (e) {
      if (!(e.code >= 400 && e.code < 500)) console.error(`[import] lap import failed: ${e.message}`);
      return send(res, e.code >= 400 && e.code < 500 ? e.code : 500, { error: e.code >= 400 && e.code < 500 ? e.message : 'The lap could not be imported' });
    }
  }
  if (p === '/api/spotter/test' && m === 'POST') { spotter.test(); return send(res, 200, { ok: true }); }
  // ---- own brake marks (track page) and marking them (button, pedal)
  if (p === '/api/brakemarks') {
    const q = m === 'POST' ? await readJson(req) : Object.fromEntries(url.searchParams);
    if (!q.track || !q.layout || !q.car) return send(res, 400, { error: 'track, layout and car are needed' });
    const c = { track: q.track, layout: q.layout, car: q.car };
    if (m === 'POST') {
      if (!Array.isArray(q.marks)) return send(res, 400, { error: 'marks missing' });
      marks.save(c, q.marks);
      broadcast('brakemarks', { recording: marker.status(), combo: c });
    }
    return send(res, 200, { marks: marks.marksFor(c), cars: db.brakeMarkCars(c.track, c.layout), recording: marker.status(),
      live: recorder.session ? marks.comboOf(recorder.session) : null });
  }
  if (p === '/api/brakemarks/best') {
    // the brake / lift points of a car's best lap, as marks (the game's track and layout names, as in the laps)
    const q = Object.fromEntries(url.searchParams);
    const info = q.track && q.layout && q.car ? svc.comboInfo({ track: q.track, layout: q.layout, car: q.car }) : null;
    const e = info?.best && svc.getResampled(info.best.id);
    if (!e) return send(res, 404, { error: 'No valid lap with this car on this track yet.' });
    const out = info.corners.map((c) => cornerMetrics(e.R, c)).map((x) => ({ bp: x.brakePoint ?? x.liftPoint, kind: x.brakePoint != null ? 'brake' : 'lift' }))
      .filter((x) => x.bp != null).map((x) => ({ pos: x.bp / e.R.L, kind: x.kind }));
    return send(res, 200, { marks: out, bestMs: info.best.lap_time_ms });
  }
  if (p === '/api/brakemarks/record' && m === 'POST') {
    const { mode } = await readJson(req);
    return send(res, 200, { recording: marker.start(mode) });
  }
  if (p === '/api/wheel/capture' && m === 'POST') {
    const b = await wheel.capture(10000);
    if (b) settings.update({ markButton: b });
    return send(res, 200, { binding: b, devices: wheel.devices().map((d) => d.name) });
  }
  // ---- online leaderboard (src/leaderboard.js; the server is leaderboard/worker.js)
  if (p === '/api/board/status') return send(res, 200, board.status());
  if (p === '/api/board/settings' && m === 'POST') {
    const b = await readJson(req), patch = {};
    if (typeof b.share === 'boolean') patch.boardShare = b.share;
    if (typeof b.auto === 'boolean') patch.boardAuto = b.auto;
    if (typeof b.tel === 'boolean') patch.boardTel = b.tel;
    if (['next', 'p1', 'off'].includes(b.target)) patch.boardTarget = b.target;
    if (typeof b.url === 'string') patch.boardUrl = b.url.trim();
    // a login belongs to one server: a new address needs a new sign-in
    const oldUrl = board.status().url;
    settings.update(patch);
    if (board.status().url !== oldUrl) settings.update({ boardToken: '', boardSteam: null });
    if (settings.get().boardShare) board.sync().catch(() => {});
    return send(res, 200, board.status());
  }
  if (p === '/api/board/login' && m === 'POST') {
    try { return send(res, 200, { url: board.loginUrl(`http://127.0.0.1:${port}/api/board/callback`) }); } catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (p === '/api/board/logout' && m === 'POST') { await board.logout(); return send(res, 200, board.status()); }
  if (p === '/api/board/callback') {
    // the browser comes back here from the Steam sign-in (see src/leaderboard.js)
    const r = await board.finishLogin({ code: url.searchParams.get('code') || '', state: url.searchParams.get('state') || '' });
    if (r.ok) broadcast('board', { signedIn: true });
    const e = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    return send(res, r.ok ? 200 : 400, `<!doctype html><meta charset="utf-8"><title>AC EVO Paddock</title><body style="font:16px system-ui,sans-serif;background:#15181c;color:#e8eaed;display:grid;place-items:center;height:90vh;margin:0"><div style="max-width:440px;padding:16px">${r.ok
      ? `<h2>Signed in as ${e(r.name)}</h2><p>You can close this tab and go back to Paddock.</p>`
      : `<h2>Sign-in failed</h2><p>${e(r.error)}</p>`}</div></body>`, 'text/html; charset=utf-8');
  }
  if (p === '/api/board/profile') { const r = await board.checkRanks().catch(() => null); return send(res, 200, { profile: r, status: board.status() }); }
  if (p === '/api/board/driver') { const r = await board.driver(url.searchParams.get('id') || ''); return send(res, r.body?.ok ? 200 : 502, r.body ?? { ok: false }); }
  if (p === '/api/board/compare' && m === 'POST') {
    // another driver's lap: downloaded once, then opened next to your own best on that track (same car if you have it)
    try {
      const { lapId } = await readJson(req);
      const id = await board.fetchOnline(Number(lapId));
      const o = db.getLapMeta(id);
      const own = db.listLaps().filter((l) => l.source === 'local' && l.valid && l.track === o.track && l.layout === o.layout);
      const best = (ls) => (ls.length ? ls.reduce((a, b) => (b.lap_time_ms < a.lap_time_ms ? b : a)) : null);
      const mine = best(own.filter((l) => l.car === o.car)) || best(own);
      return send(res, 200, { online: id, mine: mine?.id ?? null });
    } catch (e) { return send(res, 502, { error: e.message }); }
  }
  if (p === '/api/board/report' && m === 'POST') { const b = await readJson(req); const r = await board.report(Number(b.lapId), String(b.reason || '').slice(0, 200)); return send(res, r.body?.ok ? 200 : (r.status || 502), r.body ?? { ok: false }); }
  if (p === '/api/board/admin/reports') { const r = await board.adminReports(); return send(res, r.body?.ok ? 200 : (r.status || 502), r.body ?? { ok: false }); }
  if (p === '/api/board/admin/hide' && m === 'POST') { const b = await readJson(req); const r = await board.adminHide(Number(b.lapId), !!b.hidden); return send(res, r.body?.ok ? 200 : (r.status || 502), r.body ?? { ok: false }); }
  if (p === '/api/board/sync' && m === 'POST') { const r = await board.sync({ force: !!(await readJson(req)).force, manual: true }); return send(res, 200, { ...r, status: board.status() }); }
  if (p === '/api/board/combos') { const r = await board.call('/v1/combos'); return send(res, r.body?.ok ? 200 : 502, r.body ?? { ok: false }); }
  if (p === '/api/board/versions') { const r = await board.call(`/v1/versions?${url.searchParams}`); return send(res, r.body?.ok ? 200 : 502, r.body ?? { ok: false }); }
  if (p === '/api/board/table') { const r = await board.table(Object.fromEntries(url.searchParams)); return send(res, r.body?.ok ? 200 : 502, r.body ?? { ok: false }); }
  // the damaged-file notice in Settings: hide it for one kept copy, or delete that copy (names checked in src/settings.js)
  if (p === '/api/settings/notice' && m === 'POST') {
    const { action, keptAs } = await readJson(req);
    try {
      if (action === 'dismiss') settings.dismissNotice(keptAs);
      else if (action === 'delete') { settings.deleteKeptCopy(keptAs); console.log(`[data] deleted the damaged copy ${keptAs}`); }
      else return send(res, 400, { error: 'Unknown action' });
    } catch (e) { return send(res, e.code >= 400 && e.code < 600 ? e.code : 500, { error: e.message }); }
    return send(res, 200, { fileNotices: settings.fileNotices() });
  }
  if (p === '/api/settings') {
    if (m === 'POST') {
      const body = await readJson(req);
      if (typeof body.geminiApiKey === 'string' && body.geminiApiKey.startsWith('••••')) delete body.geminiApiKey;
      if (body.markButton !== undefined && body.markButton !== null) delete body.markButton; // set only by /api/wheel/capture
      delete body.channelChecks; delete body.probeConfirmed; // set only by /api/setupcheck/confirm
      for (const k of sensitive.SIGN_IN_FIELDS) delete body[k]; // set only by the Steam sign-in (src/sensitive.js)
      const oldPath = settings.get().gamePath, oldKey = settings.get().markKey, oldAssistKey = settings.get().assistKey;
      delete body.assistOff; // the kill switch goes through /api/assist (it acts at once, also when the file cannot be saved)
      delete body.hudLayouts; // through /api/hudlayouts (checked there)
      settings.update(body);
      if (settings.get().gamePath !== oldPath) { trackdata.reset(); svc.invalidate(); }
      if (settings.get().markKey !== oldKey) bindMarkKey();
      if (settings.get().assistKey !== oldAssistKey) bindAssistKey();
    }
    // the game files folder in use (read at start) and the one Windows reports, for the Settings page; damaged or
    // unreadable files of the driver's (OD-PL-5) and whether settings can be saved
    return send(res, 200, { ...settings.publicView(), assistOff: assist.isOff(), aceInUse: ACE, aceAuto: ACE_AUTO, aceExists: fs.existsSync(ACE), markKeyState, assistKeyState,
      fileNotices: settings.fileNotices(), canSave: settings.saveable() });
  }
  if (p === '/api/ai/models') return send(res, 200, await ai.listModels());
  if (p === '/api/ai/analyze' && m === 'POST') {
    const { lap: lapId, ref = 'best', question, force } = await readJson(req);
    const cmp = svc.compare([lapId], ref);
    // cache key = the actual reference (best/ideal change as you drive more laps)
    const refKey = `${cmp.ref.id}:${cmp.ref.lapTimeMs}`;
    if (!question && !force) {
      const cached = db.getAnalysis(lapId, refKey);
      if (cached) return send(res, 200, { ...ai.splitConfidence(cached.text), model: cached.model, cached: true, createdAt: cached.created_at });
    }
    const lap = cmp.laps.find((l) => l.id === lapId);
    if (!lap) return send(res, 400, { error: 'Pick a lap different from the reference' });
    const out = await ai.coach(cmp, lap, question, question ? db.getAnalysis(lapId, refKey)?.text : null);
    if (!question) db.saveAnalysis(lapId, refKey, out.model, out.text);
    return send(res, 200, { ...out, ...ai.splitConfidence(out.text), cached: false, createdAt: Date.now() });
  }
  if (p === '/api/ai/summary') { // what exactly is sent to the AI (transparency/debug)
    const lapId = Number(url.searchParams.get('lap')), ref = url.searchParams.get('ref') || 'best';
    const cmp = svc.compare([lapId], ref);
    return send(res, 200, ai.buildSummary(cmp, cmp.laps[0]));
  }
  // ---- AI coach per track + car (P8): chat, training plan, braking points
  // ---- Development (P9): goals and challenges, achievements, race weekends, session planner
  if (p === '/api/development' && m === 'GET') {
    const { goals: list, achievements: all } = development();
    const own = new Set(db.listLaps().filter((l) => l.source === 'local').map((l) => `${l.track}|${l.layout}|${l.car}`));
    const combos = race.recent().filter((c) => own.has(`${c.track}|${c.layout}|${c.carName}`)).map((c) => ({ key: `${c.track}|${c.layout}|${c.carName}`, track: c.track, layout: c.layout, car: c.carName, laps: c.laps, bestMs: c.bestMs, idealMs: c.idealMs, lastAt: c.lastAt, canStart: !!c.trackRef }));
    return send(res, 200, { goals: list, suggestions: goals.suggest(Date.now(), (c) => db.activePlan(c)), achievements: achievements.withSeen(all),
      weekends: weekends.history(), combos, presets: race.lists().presets.filter((x) => x.spec?.kind !== 'mp').map((x) => ({ id: x.id, name: x.name, mode: x.spec?.mode ?? null })),
      game: { ...game.status(), inSession: inSession() } });
  }
  if (p === '/api/goals' && m === 'POST') {
    const q = await readJson(req);
    try {
      if (q.action === 'remove') { goals.remove(Number(q.id)); devChanged(); return send(res, 200, { ok: true }); }
      const g = goals.create(q);
      devChanged();
      return send(res, 200, { goal: g });
    } catch (e) { return send(res, e.status || 500, { error: e.message }); }
  }
  // ---- Structured practice (PL7): drills from the lap analysis, checked on the passes driven afterwards (no AI)
  if (p === '/api/practice' && m === 'GET') {
    const q = url.searchParams;
    const combo = q.get('track') != null && q.get('car') != null ? { track: q.get('track'), layout: q.get('layout') ?? '', car: q.get('car') } : null;
    const out = await drills.list({ combo });
    if (combo) out.mastery = await drills.masteryFor(combo, out.drills);
    return send(res, 200, out);
  }
  if (p === '/api/practice' && m === 'POST') {
    const q = await readJson(req);
    try {
      let out;
      if (q.action === 'create') out = { drill: await drills.create(q) };
      else if (q.action === 'keep') out = { drill: await drills.keep(Number(q.id)) };
      else if (q.action === 'stop') out = { drill: await drills.stop(Number(q.id)) };
      else if (q.action === 'remove') out = await drills.remove(Number(q.id));
      else return send(res, 400, { error: 'Unknown action' });
      devChanged();
      return send(res, 200, out);
    } catch (e) { return send(res, e.status || 500, { error: e.message, ...(e.code === 'active' ? { code: e.code, active: e.active } : {}) }); }
  }
  // ---- Setup experiments (PL8): A/B stints of two setups on a car + track (src/experiments.js); never applied to the game
  if (p.startsWith('/api/experiments')) {
    const q = url.searchParams;
    const combo = q.get('track') != null && q.get('car') != null ? { track: q.get('track'), layout: q.get('layout') ?? '', car: q.get('car') } : null;
    try {
      if (p === '/api/experiments' && m === 'GET') return send(res, 200, experiments.list({ combo }));
      if (p === '/api/experiments/options' && m === 'GET') return send(res, 200, experiments.options(combo));
      if (p === '/api/experiments/one' && m === 'GET') return send(res, 200, experiments.detail(q.get('id')));
      if (p === '/api/experiments' && m === 'POST') {
        const b = await readJson(req, NOTES_BODY);
        const A = {
          create: () => experiments.create(b), start: () => experiments.startStint(b.id, b.variant), end: () => experiments.endStint(b.id),
          session: () => experiments.addSession(b.id, b.variant, b.sessionId), unstint: () => experiments.removeStint(b.id, b.stintId),
          note: () => experiments.note(b.id, b.text), feedback: () => experiments.feedback(b.id, b), review: () => experiments.review(b.id, b),
          reopen: () => experiments.reopen(b.id), archive: () => experiments.archive(b.id), restore: () => experiments.restore(b.id), remove: () => experiments.remove(b.id),
        }[b.action];
        if (!A) return send(res, 400, { error: 'Unknown action' });
        return send(res, 200, await A());
      }
    } catch (e) { return send(res, e.status || 500, { error: e.message, ...(e.code === 'open' ? { code: e.code, other: e.other } : {}) }); }
  }
  if (p === '/api/achievements/seen' && m === 'POST') { achievements.markSeen(); return send(res, 200, { ok: true }); }
  // session planner: a driven car + track, a Race tab preset (or a quick / 30-minute practice), optionally for a goal
  if (p === '/api/development/start' && m === 'POST') {
    const q = await readJson(req);
    try {
      const [track, layout, car] = String(q.key || '').split('|');
      const base = race.hotlapSpec(track, layout ?? '', car ?? '');
      let spec;
      if (!q.preset || q.preset === 'hotlap' || q.preset === 'quick') spec = base; // 'hotlap': planners saved before 2026-11-19
      else if (q.preset === 'practice') spec = { ...base, mode: 'practice', practiceMin: 30 };
      else {
        const pr = race.presetById(q.preset);
        if (!pr) return send(res, 400, { error: 'Preset not found' });
        if (pr.spec?.kind === 'mp') return send(res, 400, { error: 'Online presets join a server: start them from the Race tab' });
        spec = { ...pr.spec, kind: 'solo', car: base.car, track: base.track, noRemember: true };
      }
      const goal = q.goalId != null ? db.getGoal(Number(q.goalId)) : null;
      if (q.goalId != null && !goal) return send(res, 400, { error: 'Goal not found' });
      return send(res, 200, startGame(race.buildOrder({ ...spec, goalId: goal?.id ?? null, endSession: !!q.endSession })));
    } catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (p.startsWith('/api/coach') || p === '/api/plan') {
    // AI errors: no key -> 400 (the page says what to do), Gemini unreachable or refusing -> 502
    const AI = ['network', 'http', 'empty', 'format'];
    const fail = (e) => send(res, e.status || (e.code === 'nokey' ? 400 : AI.includes(e.code) ? 502 : 500), { error: e.message, code: AI.includes(e.code) || e.code === 'nokey' ? e.code : null });
    try {
      const q = m === 'POST' ? await readJson(req) : Object.fromEntries(url.searchParams);
      if (p === '/api/plan' && m === 'POST') {
        if (q.action === 'create') return send(res, 200, { plan: coach.createPlan(Number(q.session)) });
        if (q.action === 'remove') return send(res, 200, { plan: coach.removeTarget(Number(q.id), Number(q.index)) });
        if (q.action === 'close') { coach.closePlan(Number(q.id)); return send(res, 200, { plan: null }); }
        return send(res, 400, { error: 'unknown action' });
      }
      const c = coach.comboOfParams(q);
      if (p === '/api/plan') return send(res, 200, { plan: coach.activePlan(c) });
      if (p === '/api/coach' && m === 'GET') {
        const laps = db.lapsForCombo(c.track, c.layout, c.car, true);
        return send(res, 200, { combo: c, laps: laps.length, validLaps: laps.filter((l) => l.valid).length, hasKey: !!settings.get().geminiApiKey,
          model: settings.get().geminiModel, messages: coach.messages(c), plan: coach.activePlan(c), brakeMarks: marks.marksFor(marks.comboOf(c)).length, marksCombo: marks.comboOf(c),
          reports: db.listReports().filter((r) => r.data.combo?.track === c.track && r.data.combo?.layout === c.layout && r.data.combo?.car === c.car)
            .map((r) => ({ sessionId: r.sessionId, startedAt: r.data.startedAt, bestMs: r.data.best?.ms ?? null, targets: (r.data.targets || []).length }))
            .sort((a, b) => b.startedAt - a.startedAt).slice(0, 5) });
      }
      if (p === '/api/coach/context') return send(res, 200, coach.preview(c));
      if (p === '/api/coach/ask' && m === 'POST') return send(res, 200, await coach.ask(c, q.question));
      if (p === '/api/coach/clear' && m === 'POST') { coach.clear(c); return send(res, 200, { ok: true }); }
      if (p === '/api/coach/brakes/data') return send(res, 200, coach.brakeData(c));
      if (p === '/api/coach/brakes' && m === 'POST') return send(res, 200, await coach.suggestBrakes(c));
      if (p === '/api/coach/brakes/apply' && m === 'POST') {
        const out = coach.applyBrakes(c, q.items);
        const saved = marks.save(out.combo, out.marks);
        broadcast('brakemarks', { recording: marker.status(), combo: out.combo });
        return send(res, 200, { marks: saved, combo: out.combo });
      }
      return send(res, 404, { error: 'not found' });
    } catch (e) { return fail(e); }
  }
  if (p === '/api/debug/raw') return send(res, 200, source.lastRaw ?? source.read?.() ?? null);

  // static files
  if (p.startsWith('/vendor/uplot/')) return serveStatic(res, path.join(ROOT, 'node_modules/uplot/dist', path.basename(p)));
  // bundled typefaces, so the page looks the same offline
  if (p.startsWith('/vendor/fonts/')) return serveStatic(res, path.join(ROOT, 'node_modules/@fontsource', p.split('/')[3] === 'barlow-condensed' ? 'barlow-condensed' : 'barlow', 'files', path.basename(p)));
  // the in-game app's files, reused by the desktop overlay page (hud.html)
  if (p.startsWith('/mod/')) return serveStatic(res, path.join(ROOT, 'mod/trainerhud', path.basename(p)));
  const file = path.normalize(path.join(ROOT, 'public', p === '/' ? 'index.html' : p));
  if (!file.startsWith(path.join(ROOT, 'public'))) return send(res, 403, { error: 'forbidden' });
  return serveStatic(res, file);
}

const server = http.createServer((req, res) => {
  const t0 = performance.now();
  res.once('finish', () => perf.request(req.method, req.url?.split('?')[0], performance.now() - t0)); // slow pages (Diagnostics)
  route(req, res).catch((e) => { console.error(e.message); if (!res.headersSent) send(res, 500, { error: e.message }); });
});
const port = Number(process.env.PORT) || settings.get().port || 8080;
// resolves with the port once listening; the desktop app (desktop/main.cjs) waits on it
export const ready = new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', () => {
    console.log(`AC EVO Paddock running: http://localhost:${port}   (source: ${source.name})`);
    setTimeout(() => cars.warmThumbnails().catch(() => {}), 3000); // car pictures for the Race tab, in a worker
    // the game's track list (~0.5 s, once): read now rather than in the first session (PL3)
    setTimeout(() => { try { trackdata.catalog(); } catch { /* no game files */ } }, 3500);
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
