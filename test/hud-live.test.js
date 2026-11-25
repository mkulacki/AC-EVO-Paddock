// PL9: live assistance. Cue cooldowns and blocking (never more cues than before), telemetry freshness and invalid-data
// labels (server and HUD), the kill switch, HUD layouts and context profiles, the post-lap summary and lap-time spread.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { isolate, ROOT } from './helpers.js';

const env = isolate('hudlive');
const settings = await import('../src/settings.js');
const { createSpotter } = await import('../src/spotter.js');
const live = await import('../src/live.js');
const assist = await import('../src/assist.js');
const layouts = await import('../src/hudlayouts.js');

// ---------------------------------------------------------------- the spotter
// a car at 50 m/s approaching a brake point from 300 m, one call per 60 Hz frame; returns what was said and when
function drive(cfg, { blockedAt = () => null, corners = [{ k: 0, at: 300 }] } = {}) {
  let t = 0;
  const said = [];
  const sp = createSpotter({ config: () => ({ ...settings.SPOTTER_DEFAULTS, on: true, ...cfg }), emit: (c) => said.push({ ...c, t }), now: () => t,
    blocked: () => blockedAt(t) });
  for (const c of corners) {
    for (let d = 0; d < c.at; d += 50 / 60) {
      t += 1000 / 60;
      sp.tick({ k: c.k, lap: 1, corner: `T${c.k + 1}`, kind: 'brake', inM: c.at - d, speedMs: 50, dropKmh: 80 });
    }
  }
  return { said, stats: sp.stats() };
}

test('spotter defaults: the same countdown as before PL9 (three, two, one, brake), cooldown 0', () => {
  assert.equal(settings.SPOTTER_DEFAULTS.cooldownMs, 0);
  assert.deepEqual(drive({}).said.map((c) => c.say), ['three', 'two', 'one', 'brake']);
  assert.deepEqual(drive({ countdown: 'brake' }).said.map((c) => c.say), ['brake']);
});

test('spotter cooldown only drops cues: with 1.5 s, two of the four words go; never more words than without it', () => {
  const base = drive({}), cool = drive({ cooldownMs: 1500 });
  assert.deepEqual(cool.said.map((c) => c.say), ['three', 'one']);
  assert.equal(cool.stats.cooledDown, 2);
  for (const ms of [0, 250, 500, 1000, 2000, 3000]) assert.ok(drive({ cooldownMs: ms }).said.length <= base.said.length);
  // gaps between spoken words respect the cooldown
  for (let i = 1; i < cool.said.length; i++) assert.ok(cool.said[i].t - cool.said[i - 1].t >= 1500);
});

test('spotter cooldown across corners close together: the next corner starts later, nothing is added', () => {
  const two = [{ k: 0, at: 300 }, { k: 1, at: 150 }];
  const base = drive({}, { corners: two }).said.map((c) => c.say);
  const cool = drive({ cooldownMs: 1000 }, { corners: two }).said.map((c) => c.say);
  assert.ok(cool.length < base.length, `${cool} vs ${base}`);
});

test('spotter says nothing while blocked (kill switch, stale telemetry) and nothing old once it clears', () => {
  const all = drive({}, { blockedAt: () => 'off' });
  assert.equal(all.said.length, 0);
  assert.ok(all.stats.blocked > 0);
  // blocked for the first 3.5 s of the 6 s approach: the countdown carries on from where the car is, no catch-up burst
  const part = drive({}, { blockedAt: (t) => (t < 3500 ? 'stale' : null) });
  assert.deepEqual(part.said.map((c) => c.say), ['two', 'one', 'brake']);
});

test('the spotter setting is clamped: cooldown 0..3000 ms', () => {
  settings.update({ spotter: { cooldownMs: 99999 } });
  assert.equal(settings.spotterConfig().cooldownMs, 3000);
  settings.update({ spotter: { cooldownMs: -5 } });
  assert.equal(settings.spotterConfig().cooldownMs, 0);
});

// ---------------------------------------------------------------- freshness and consistency
test('freshness: ok under 500 ms, stale after, paused and not live are labelled as such', () => {
  const now = 100000;
  assert.deepEqual(live.freshness({ status: 'live', packetAt: now - 100, now }), { state: 'ok', ageMs: 100 });
  assert.deepEqual(live.freshness({ status: 'live', packetAt: now - 800, now }), { state: 'stale', ageMs: 800 });
  assert.equal(live.freshness({ status: 'pause', packetAt: now - 9000, now }).state, 'paused');
  assert.equal(live.freshness({ status: 'menu', packetAt: 0, now }).state, 'none');
  assert.equal(live.freshness({ status: 'live', packetAt: 0, now }).ageMs, null);
});

test('lap-time consistency: nothing under 5 valid laps (PL6 minimum), then the IQR and the PL6 confidence word', () => {
  assert.deepEqual(live.lapConsistency([90000, 90500, 91000]), { n: 3, need: 5, spreadMs: null, medianMs: null, confidence: 'insufficient' });
  const c = live.lapConsistency([90000, 90200, 90400, 90600, 99000]); // one bad lap barely moves the middle half
  assert.equal(c.spreadMs, 400);
  assert.equal(c.medianMs, 90400);
  assert.equal(c.confidence, 'low');
  assert.equal(live.lapConsistency(Array(12).fill(90000)).confidence, 'medium');
  assert.equal(live.lapConsistency(Array(25).fill(90000)).confidence, 'high');
});

// a LiveHud with a recorder stub: no session (no references are read), a live frame
function liveHud(state) {
  const rec = Object.assign(new EventEmitter(), { state: { status: 'live', connected: true, ...state }, session: null, lap: null });
  const h = new live.LiveHud(rec);
  h.frame = { status: 2, speed: 180, gas: 1, brake: 0, rpm: 7000, fuel: 0, lapTimeMs: 1000, inPit: false, trackLength: 4000 };
  return { h, rec };
}

test('snapshot labels stale telemetry and an invalid delta; no countdown from them', () => {
  const now = Date.now();
  const { h } = liveHud({ packetAt: now - 1200 });
  let s = h.snapshot();
  assert.equal(s.q.tel, 'stale');
  assert.ok(s.q.telAgeMs >= 1200);
  assert.equal(s.cue, undefined);
  assert.equal(h.telemetryStale(), true);
  const fresh = liveHud({ packetAt: Date.now() }).h;
  assert.equal(fresh.snapshot().q.tel, 'ok');
  fresh.delta = { ms: Infinity, rate: 0, d: 10 };
  s = fresh.snapshot();
  assert.equal(s.q.delta, 'invalid');
  assert.equal(s.delta, null);
  assert.equal(s.lap, null); // no lap without a recorder lap
});

test('post-lap summary and lap-time spread go out only when their parts are on (off by default)', () => {
  assert.equal(settings.hudConfig().parts.summary, false);
  assert.equal(settings.hudConfig().parts.consistency, false);
  const { h, rec } = liveHud({ packetAt: Date.now() });
  h.prevCorners = [{ name: 'T1', deltaMs: -40 }, { name: 'T2', deltaMs: 120 }, { name: 'T3', deltaMs: -90 }, { name: 'T4', deltaMs: 30 }];
  h.onLap({ id: 1, lapTimeMs: 91000, valid: true });
  assert.equal(h.snapshot().summary, undefined);
  settings.update({ hud: { ...settings.hudConfig(), parts: { ...settings.hudConfig().parts, summary: true, consistency: true } } });
  const s = h.snapshot();
  assert.deepEqual({ gain: s.summary.gain, loss: s.summary.loss, lapMs: s.summary.lapMs }, { gain: { name: 'T3', deltaMs: -90 }, loss: { name: 'T2', deltaMs: 120 }, lapMs: 91000 });
  assert.equal(s.consistency, undefined); // only on track (a session)
  rec.session = { key: 'k', id: null, track: 't', layout: 'l', car: 'c' };
  h.loadRefs = () => null; // no references needed here
  for (const t of [91200, 91100, 90900, 91300]) h.onLap({ id: 2, lapTimeMs: t, valid: true });
  h.onLap({ id: 3, lapTimeMs: 99999, valid: false }); // invalid laps do not count
  assert.equal(h.snapshot().consistency.n, 5);
  settings.update({ hud: {} });
});

test('cue result time is a setting: 6 s by default, 2..10 s', () => {
  assert.equal(settings.hudConfig().cueHoldMs, 6000);
  settings.update({ hud: { cueHoldMs: 500 } });
  assert.equal(settings.hudConfig().cueHoldMs, 2000);
  settings.update({ hud: { cueHoldMs: 60000 } });
  assert.equal(settings.hudConfig().cueHoldMs, 10000);
  settings.update({ hud: {} });
});

// ---------------------------------------------------------------- kill switch
test('kill switch: gate strips every live field and keeps protocol fields, look and launch order', () => {
  const snap = { v: 1, now: 5, game: 'live', connected: true, cfg: { scale: 100 }, order: { kind: 'solo' }, lap: { timeMs: 1 }, delta: { ms: 1 },
    cue: { next: {} }, ahead: {}, board: { rows: [] }, target: {}, summary: {}, consistency: {}, combo: { car: 'x' }, times: {}, sectors: {} };
  assert.equal(assist.gate(snap, false), snap);
  assert.deepEqual(assist.gate(snap, true), { v: 1, now: 5, game: 'live', connected: true, off: true, combo: null, lap: null, delta: null, cue: null, cfg: { scale: 100 }, order: { kind: 'solo' } });
});

test('kill switch: acts at once, is saved, toggles, and tells listeners', () => {
  const seen = [];
  const un = assist.onChange((off) => seen.push(off));
  assert.equal(assist.isOff(), false);
  assert.deepEqual(assist.set(true), { off: true, saved: true });
  assert.equal(JSON.parse(fs.readFileSync(path.join(env.ACEVO_DATA, 'settings.json'), 'utf8')).assistOff, true);
  assert.equal(assist.set('toggle').off, false);
  assert.equal(assist.set('anything').off, false); // only true switches off
  assert.deepEqual(seen, [true, false, false]);
  un();
});

// ---------------------------------------------------------------- layouts and context profiles
test('layouts: save, apply, delete; built-in names taken; names cleaned; at most 12', () => {
  settings.update({ hud: { scale: 120, opacity: 40, parts: { fuel: false } } });
  const v = layouts.save('  Night\u0007 race  ');
  assert.deepEqual(v.list.map((l) => l.name), ['Night race']);
  assert.equal(v.list[0].scale, 120);
  assert.throws(() => layouts.save('Minimal'), /built-in/);
  assert.throws(() => layouts.save('   '), /name/);
  layouts.apply('Minimal');
  assert.equal(settings.hudConfig().parts.fuel, false);
  assert.equal(settings.hudConfig().parts.delta, true);
  assert.equal(settings.hudConfig().parts.best, false);
  layouts.apply('Night race');
  assert.equal(settings.hudConfig().scale, 120);
  assert.throws(() => layouts.apply('nope'), /No layout/);
  for (let i = 0; i < 11; i++) layouts.save(`L${i}`);
  assert.throws(() => layouts.save('one too many'), /At most 12/);
  layouts.save('L0'); // replacing one of the same name is fine
  for (let i = 0; i < 11; i++) layouts.remove(`L${i}`);
  assert.deepEqual(layouts.view().list.map((l) => l.name), ['Night race']);
});

test('context profiles: off by default; a session type picks its layout once switched on; deleting a layout clears it', () => {
  assert.equal(layouts.forSession(1), null);
  layouts.setContexts({ byType: { 1: 'Race', 0: 'Night race' } });
  assert.equal(layouts.forSession(1), null); // still off
  layouts.setContexts({ auto: true });
  assert.equal(layouts.forSession(1), 'Race');
  assert.equal(layouts.forSession('0'), 'Night race');
  assert.equal(layouts.forSession(3), null);
  assert.throws(() => layouts.setContexts({ byType: { 1: 'ghost' } }), /No layout/);
  assert.throws(() => layouts.setContexts({ byType: { 9: 'Race' } }), /Unknown session type/);
  layouts.remove('Night race');
  assert.equal(layouts.forSession(0), null);
  // a damaged stored value is read as far as it is valid
  assert.deepEqual(settings.normLayouts({ list: 'x', auto: 'yes', byType: { 1: 5 } }), { list: [], auto: false, byType: { 0: '', 1: '', 2: '', 3: '' } });
});

// ---------------------------------------------------------------- the HUD (mod/trainerhud/trainerhud.js) helpers
function loadHud() {
  const src = fs.readFileSync(path.join(ROOT, 'mod/trainerhud/trainerhud.js'), 'utf8');
  const ctx = { window: { location: { search: '', pathname: '/hud.html' } }, document: { getElementById: () => null }, console, setTimeout, clearTimeout, setInterval, clearInterval };
  vm.createContext(ctx);
  vm.runInContext(`${src}\n;globalThis.__T = TrainerHud;`, ctx);
  return ctx.__T;
}

test('HUD labels: data older than 1 s, stale telemetry and an invalid delta; nothing when fresh', () => {
  const T = loadHud(), now = 1e6;
  assert.equal(T.dataQuality(null, now).label, '');
  assert.equal(T.dataQuality({ now: now - 450, q: { tel: 'ok', delta: 'ok' } }, now).label, ''); // a normal in-game read
  const old = T.dataQuality({ now: now - 1500, q: { tel: 'ok' } }, now);
  assert.equal(old.stale, true); assert.equal(old.label, 'DATA 1.5 s OLD'); assert.equal(old.cls, 'bad');
  assert.equal(T.dataQuality({ now: now - 100, q: { tel: 'stale', telAgeMs: 800 } }, now).label, 'TELEMETRY STALE 0.8 s');
  assert.equal(T.dataQuality({ now: now - 100, q: { tel: 'ok', delta: 'invalid' } }, now).label, 'DELTA N/A');
  assert.equal(T.dataQuality({ now: now - 100 }, now).label, ''); // an older Paddock sends no q
  assert.equal(T.fmtSpread({ n: 3, need: 5, spreadMs: null }), 'CONSISTENCY: 3/5 VALID LAPS');
  assert.equal(T.fmtSummary({ lapMs: 91000, valid: true, vsRefMs: -120, refMode: 'best', gain: null, loss: { name: 'T2', deltaMs: 120 } }), 'LAP 1:31.000 -0.120 vs BEST · T2 +0.120');
});

test('HUD 0.15.0 ships the new parts (off by default in the in-game window too) and keeps the bridge constants', () => {
  const src = fs.readFileSync(path.join(ROOT, 'mod/trainerhud/trainerhud.js'), 'utf8');
  assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, 'mod/trainerhud/app.json'), 'utf8')).version, '0.15.0');
  assert.match(src, /PARTS_OFF = \{ speed: true, summary: true, consistency: true \}/);
  assert.match(src, /show\("summary", "Post-lap summary", false\)/);
  for (const [k, v] of [['SLOTS', 8], ['WINDOW_MS', 50], ['READ_PHASE_MS', 20]]) assert.match(src, new RegExp(`const ${k} = ${v};`));
  assert.match(src, /\[TrainerHUD-cmd\] /);
  for (const p of settings.HUD_PARTS) assert.ok(src.includes(`"${p}"`), `HUD knows part ${p}`);
});
