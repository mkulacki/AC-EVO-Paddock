// Integration health (PL4.3, src/health.js): the state of each part from synthetic inputs, with what to do.
// Pure function: no server, no game, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from '../src/health.js';

const NOW = 1_800_000_000_000;
const base = (over = {}) => ({
  now: NOW, mock: false, aceFound: true,
  game: { running: true, version: '0.6.1', liveAgeMs: 100 },
  telemetry: { source: 'Assetto Corsa EVO shared memory', status: 'live', connected: true, lastFrameAt: NOW - 10, packetAgeMs: 20, stale: false, savedLaps: 3, lastLap: { lapTimeMs: 101234, valid: true } },
  perf: { tickInterval: { n: 1000 }, lateTicks: 2, missedFramesEstimate: 3, stalls: 0, errors: {}, eventLoopDelay: { p99: 4.2 } },
  hud: { state: 'current', installed: '0.14.0', bundled: '0.14.0', loaderInfo: { state: 'current', gameMatch: true } },
  channels: [
    { id: 'core', label: 'Core', confirmable: false, status: 'verified', state: 'verified' },
    { id: 'slip', label: 'Slip', confirmable: false, status: 'unverified', state: 'unverified' },
    { id: 'tyres', label: 'Tyres', confirmable: true, status: 'verified', state: 'verified', needsRecheck: false },
  ],
  checkContext: { game: '0.6.1' },
  board: { share: false, auto: true, signedIn: false, secure: true, host: 'example.org' },
  updates: { enabled: true, checkedAt: NOW - 3600e3, error: null, latest: null },
  ...over,
});
const by = (h, id) => h.checks.find((c) => c.id === id);

test('everything working: every part OK or off, nothing to do', () => {
  const h = build(base());
  assert.equal(h.worst, 'ok');
  assert.deepEqual(h.checks.map((c) => c.id), ['game', 'freshness', 'recording', 'hud', 'channels', 'online']);
  assert.equal(by(h, 'game').state, 'ok'); assert.match(by(h, 'game').summary, /AC EVO 0\.6\.1, on track/);
  assert.equal(by(h, 'freshness').state, 'ok'); assert.match(by(h, 'freshness').details[0], /2 late reads/);
  assert.equal(by(h, 'recording').state, 'ok'); assert.match(by(h, 'recording').details.join(' '), /101\.234 s/);
  assert.equal(by(h, 'hud').state, 'ok'); assert.match(by(h, 'hud').details.join(' '), /updating/);
  assert.equal(by(h, 'channels').state, 'ok'); assert.match(by(h, 'channels').details.join(' '), /Cannot be checked.*Slip/);
  assert.equal(by(h, 'online').state, 'off', 'sharing is off by default: not a problem');
  assert.match(by(h, 'online').details.join(' '), /nothing is sent to check it/);
  for (const c of h.checks) assert.deepEqual(c.steps, [], `${c.id} has nothing to do`);
});

test('game closed: off, with how to start it; mock runs say so', () => {
  const h = build(base({ game: { running: false, version: '0.6.1' }, telemetry: { status: 'waiting for game', connected: false, savedLaps: 0 } }));
  assert.equal(by(h, 'game').state, 'off'); assert.ok(by(h, 'game').steps.length);
  assert.equal(by(h, 'freshness').state, 'off'); assert.equal(by(h, 'recording').state, 'off');
  assert.equal(build(base({ mock: true })).checks[0].state, 'off');
  assert.match(build(base({ mock: true })).checks[0].summary, /mock telemetry/);
});

test('game running without telemetry, or the user folder missing: a problem with concrete steps', () => {
  let h = build(base({ telemetry: { status: 'waiting for game', connected: false } }));
  assert.equal(by(h, 'game').state, 'warn'); assert.ok(by(h, 'game').steps.some((s) => /same PC/.test(s)));
  h = build(base({ aceFound: false }));
  assert.equal(by(h, 'game').state, 'bad'); assert.equal(by(h, 'game').href, '#/settings');
  assert.equal(h.worst, 'bad');
});

test('stale telemetry and failed lap saves are shown in red', () => {
  let h = build(base({ telemetry: { ...base().telemetry, packetAgeMs: 8000, stale: true } }));
  assert.equal(by(h, 'freshness').state, 'bad'); assert.match(by(h, 'freshness').summary, /stopped changing 8 s ago/);
  h = build(base({ telemetry: { ...base().telemetry, packetAgeMs: 1500 } }));
  assert.equal(by(h, 'freshness').state, 'warn');
  h = build(base({ perf: { ...base().perf, errors: { lapSave: 2 } } }));
  assert.equal(by(h, 'recording').state, 'bad'); assert.match(by(h, 'recording').summary, /2 laps could not be saved/);
});

test('HUD: outdated, missing, switched off, loader for another game version', () => {
  const hud = (s) => by(build(base({ hud: { ...base().hud, ...s } })), 'hud');
  assert.equal(hud({ state: 'outdated', installed: '0.13.0' }).state, 'warn');
  assert.match(hud({ state: 'outdated', installed: '0.13.0' }).steps[0], /Close AC EVO/);
  assert.match(hud({ state: 'missing', removed: true }).summary, /switched off/);
  const l = hud({ loaderInfo: { state: 'current', gameMatch: false, builtFor: '0.5.0', game: '0.6.1' } });
  assert.equal(l.state, 'bad'); assert.match(l.details.join(' '), /built for AC EVO 0\.5\.0/);
  assert.equal(by(build(base({ hud: { error: 'boom' } })), 'hud').state, 'unknown');
  const stopped = by(build(base({ game: { running: true, version: '0.6.1', liveAgeMs: 9000 } })), 'hud');
  assert.match(stopped.details.join(' '), /not updating/);
});

test('telemetry checks: wrong, to check again and not checked are named, with where to check', () => {
  const h = build(base({ channels: [
    { id: 'tyres', label: 'Tyres', confirmable: true, status: 'unverified', state: 'unverified', needsRecheck: true },
    { id: 'brakes', label: 'Brakes', confirmable: true, status: 'mismatch', state: 'unsupported', needsRecheck: false },
    { id: 'aids', label: 'Aids', confirmable: true, status: 'unverified', state: 'unverified', needsRecheck: false },
  ] }));
  const c = by(h, 'channels');
  assert.equal(c.state, 'warn'); assert.match(c.summary, /0 of 3/);
  const d = c.details.join(' ');
  assert.match(d, /left out of all analysis: Brakes/); assert.match(d, /another game version.*Tyres/); assert.match(d, /Not checked yet.*Aids/);
  assert.equal(c.href, '#/setups');
});

test('online services: from the last known state only; sign-in and errors explained', () => {
  const on = (b) => by(build(base({ board: { ...base().board, share: true, ...b } })), 'online');
  assert.equal(on({ signedIn: false }).state, 'warn'); assert.match(on({ signedIn: false }).steps[0], /Sign in/);
  assert.equal(on({ signedIn: true, lastError: 'the leaderboard server did not answer' }).state, 'warn');
  assert.equal(on({ signedIn: true, lastSync: NOW - 120e3 }).state, 'ok'); assert.match(on({ signedIn: true, lastSync: NOW - 120e3 }).summary, /2 min ago/);
  assert.equal(on({ secure: false }).state, 'bad');
  const u = by(build(base({ updates: { enabled: true, checkedAt: NOW - 60e3, error: 'GitHub did not answer in time' } })), 'online');
  assert.match(u.details[0], /Update check: failed/);
});

test('error texts lose their folder paths, also with spaces in them; the file name stays (review 9)', async () => {
  const { noPaths } = await import('../src/health.js');
  const win = String.raw`EPERM: operation not permitted, open 'C:\Users\Jan Kowalski\Saved Games\ACE\mods\x.json'`;
  assert.equal(noPaths(win), "EPERM: operation not permitted, open 'x.json'");
  assert.equal(noPaths('ENOENT: no such file, mkdir /home/jan/ACE/Video'), 'ENOENT: no such file, mkdir Video');
  assert.equal(noPaths('the leaderboard server did not answer'), 'the leaderboard server did not answer');
  const h = build(base({ hud: { state: 'missing', installed: null, bundled: '0.14.0', autoError: win, loaderInfo: { state: 'current' } } }));
  assert.ok(!JSON.stringify(h).includes('Kowalski'));
  assert.match(by(h, 'hud').details.join(' '), /x\.json/);
  assert.ok(!JSON.stringify(build(base({ hud: { error: win } }))).includes('Users'));
});
