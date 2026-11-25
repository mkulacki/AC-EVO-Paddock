// PL11 self-contained session reports: one offline HTML file, private by default.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolate, seedRandom } from './helpers.js';

isolate('reportexport');
seedRandom(9);
const db = await import('../src/db.js');
const report = await import('../src/report.js');
const rx = await import('../src/reportexport.js');
const { seedLaps } = await import('../src/mock.js');
let sid = null;
await seedLaps(5, (l) => { sid = l.sessionId; });
report.make(sid);
const rep = db.getReport(sid);
db.saveReportAi(sid, 'Debrief for Mock Driver: brake later into T3.', 'test-model');
const laps = db.lapsOfSession(sid);

// anything that would make a browser fetch something: external URLs, scripts, frames, objects, imports, links
const LOADS = /<script|<iframe|<object|<embed|<link\b|@import|url\(|\bsrc\s*=|https?:\/\//i;

test('offline: no scripts, no external resources, a CSP that blocks everything but inline styles', () => {
  const html = rx.render(rep, laps, { appVersion: '9.9.9' });
  assert.doesNotMatch(html, LOADS);
  assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'/);
  assert.match(html, /<svg viewBox/);
  assert.match(html, /mock ring/, 'track name as the app shows it');
  for (const l of laps) assert.ok(html.includes(`<td>${l.lap_number}</td>`), `lap ${l.lap_number} listed`);
});

test('private by default: no driver name, Steam identity, notes or AI text unless asked for', () => {
  const html = rx.render(rep, laps, {});
  assert.doesNotMatch(html, /Mock Driver/);
  assert.doesNotMatch(html, /76561198000000000/);
  assert.doesNotMatch(html, /AI debrief|brake later/);
  const full = rx.render(db.getReport(sid), laps, { ai: true, identity: { driver: 'Mock Driver', steam: { steamId: '76561198000000000', name: 'mock' } }, notes: { text: 'my note', tags: ['wet'] } });
  assert.match(full, /Mock Driver/);
  assert.match(full, /76561198000000000/);
  assert.match(full, /brake later/);
  assert.match(full, /my note/);
  assert.doesNotMatch(full, LOADS);
});

test('text from the driver or the AI is escaped', () => {
  const html = rx.render({ ...db.getReport(sid), ai: { text: '<img src=x onerror=alert(1)>' } }, laps, { ai: true, notes: { text: '<script>x</script>', tags: ['"><b>'] } });
  assert.doesNotMatch(html, /<img src=x|<script>x/);
  assert.match(html, /&lt;script&gt;x&lt;\/script&gt;/);
});

test('file name: ASCII only, with track, car and date', () => {
  assert.match(rx.fileName(rep.data), /^paddock-report-mock_ring-mock_gt3-\d{4}-\d{2}-\d{2}\.html$/);
  assert.equal(rx.fileName({ combo: { track: 'Ślęża/..\\x', car: '' }, startedAt: 0 }), 'paddock-report-Sleza_x-x-1970-01-01.html');
});
