// PL1.2 lap import hardening (PL0 findings 1.2-a … 1.2-g): bounded unpacking, schema and range checks, duplicates,
// exports without leaderboard identity. The HTTP route is covered in smoke.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { isolate, seedRandom } from './helpers.js';

isolate('lapfile');
seedRandom(5);
const db = await import('../src/db.js');
const lapfile = await import('../src/lapfile.js');
const { seedLaps } = await import('../src/mock.js');
await seedLaps(2);

const lapId = db.listLaps()[0].id;
db.setLapBoard(lapId, { steamId: '76561190000000001', url: 'https://board.example', rank: 3 });
const exported = lapfile.exportLapFile(db.getLap(lapId));
const fileObj = () => JSON.parse(zlib.gunzipSync(exported));
const gz = (o) => zlib.gzipSync(typeof o === 'string' ? o : JSON.stringify(o));
const refused = (buf, re, code = 400) => assert.throws(() => lapfile.parseLapFile(buf), (e) => { assert.equal(e.code, code, e.message); assert.match(e.message, re); return true; });

test('export: same format as before (acevo-trainer-lap v1), without the leaderboard data or local ids (OD-PL-2)', () => {
  const o = fileObj();
  assert.equal(o.format, 'acevo-trainer-lap');
  assert.equal(o.version, 1);
  assert.equal(o.meta.board, undefined);
  assert.equal(o.meta.id, undefined);
  assert.ok(!JSON.stringify(o).includes('76561190000000001'));
  assert.ok(Array.isArray(o.data.t) && o.data.t.length === o.data.d.length);
  assert.ok(o.meta.track && o.meta.car && o.meta.lap_time_ms > 0);
});

test('a valid export imports, gzipped or plain, and keeps every channel and the car data', () => {
  const src = db.getLap(lapId);
  for (const buf of [exported, Buffer.from(JSON.stringify(fileObj()))]) {
    const { lap, recordedAtGiven } = lapfile.parseLapFile(buf);
    assert.equal(recordedAtGiven, true);
    assert.equal(lap.track, src.track);
    assert.equal(lap.lapTimeMs, src.lap_time_ms);
    assert.equal(lap.recordedAt, src.recorded_at);
    assert.deepEqual(Object.keys(lap.data).sort(), Object.keys(src.data).sort());
    assert.deepEqual(lap.data.spd, src.data.spd);
  }
});

test('legacy and minimal files: no version, only t and d, no car data, no driver or recorded time', () => {
  const o = fileObj();
  const data = { t: o.data.t, d: o.data.d };
  const { lap, recordedAtGiven } = lapfile.parseLapFile(gz({ format: o.format, meta: { ...o.meta, driver: undefined, recorded_at: undefined }, data }));
  assert.equal(lap.driver, 'Imported');
  assert.equal(recordedAtGiven, false);
  assert.ok(Math.abs(lap.recordedAt - Date.now()) < 5000);
  assert.deepEqual(Object.keys(lap.data), ['t', 'd']);
  // a channel a newer Paddock might add (numbers, one per sample) is kept; non-channels are dropped
  const extra = lapfile.parseLapFile(gz({ ...o, data: { ...o.data, abs: o.data.t.map(() => 0), note: 'x' } }));
  assert.ok(extra.lap.data.abs && !('note' in extra.lap.data));
});

test('a decompression bomb is refused within the cap, without unpacking it whole', () => {
  const bomb = zlib.gzipSync(Buffer.alloc(lapfile.LIMITS.jsonBytes + 1024 * 1024, 0x20)); // ~65 MB of spaces in ~64 kB
  assert.ok(bomb.length < 1024 * 1024);
  refused(bomb, /unpacks to more than/, 413);
  assert.throws(() => lapfile.gunzipLimited(zlib.gzipSync(Buffer.alloc(5000)), 1000), (e) => e.code === 413);
  refused(Buffer.alloc(lapfile.LIMITS.fileBytes + 1), /too big/, 413);
});

test('truncated, damaged and foreign files: plain 400 messages', () => {
  refused(Buffer.alloc(0), /empty/);
  refused(exported.subarray(0, exported.length >> 1), /damaged|cannot be unpacked/);
  refused(gz('{"format": "acevo-trainer-lap", "meta": {'), /not readable JSON/);
  refused(Buffer.from('hello'), /not readable JSON/);
  refused(gz({ format: 'something-else' }), /Not a Paddock lap file/);
  refused(gz([1, 2]), /Not a Paddock lap file/);
});

test('versions: newer refused with a hint, unknown refused', () => {
  const o = fileObj();
  refused(gz({ ...o, version: 2 }), /newer Paddock/);
  refused(gz({ ...o, version: '1' }), /Unsupported lap file version/);
});

test('invalid details (meta): missing, wrong types, out of range, nested junk', () => {
  const o = fileObj();
  const withMeta = (m) => gz({ ...o, meta: { ...o.meta, ...m } });
  refused(gz({ ...o, meta: undefined }), /no lap details/);
  refused(withMeta({ track: undefined }), /track is missing/);
  refused(withMeta({ track: { a: [[[[{}]]]] } }), /track is not text/);
  refused(withMeta({ car: 'x'.repeat(500) }), /too long/);
  refused(withMeta({ lap_time_ms: -1 }), /lap time/);
  refused(withMeta({ lap_time_ms: '90000' }), /lap time/);
  refused(withMeta({ track_length: 0 }), /track length/);
  refused(withMeta({ lap_number: 1.5 }), /lap number/);
  refused(withMeta({ driver: 7 }), /driver name is not text/);
  // deeply nested data where a channel should be: refused as a type error, no recursion into it
  refused(gz(`{"format":"acevo-trainer-lap","meta":${JSON.stringify(o.meta)},"data":{"t":${JSON.stringify(o.data.t)},"d":${JSON.stringify(o.data.d)},"spd":${'['.repeat(5000)}${']'.repeat(5000)}}}`), /spd/);
});

test('invalid telemetry: mismatched lengths, non-numbers, out of range, too few or too many samples, time running back', () => {
  const o = fileObj();
  const withData = (d) => gz({ ...o, data: { ...o.data, ...d } });
  const n = o.data.t.length;
  refused(gz({ ...o, data: undefined }), /no telemetry/);
  refused(withData({ t: 'abc' }), /no timing channel/);
  refused(withData({ d: undefined }), /no distance channel/);
  refused(withData({ spd: o.data.spd.slice(1) }), new RegExp(`"spd" has ${n - 1} values, expected ${n}`));
  refused(withData({ thr: o.data.thr.map((v, i) => (i === 3 ? null : v)) }), /"thr" has a value that is not a number \(sample 4\)/);
  refused(withData({ brk: o.data.brk.map((v, i) => (i === 2 ? 5 : v)) }), /"brk" has a value out of range/);
  refused(withData({ t: o.data.t.slice(0, 10), d: o.data.d.slice(0, 10) }), /too few samples/);
  refused(withData({ t: o.data.t.slice().reverse() }), /timing goes backwards/);
  const many = lapfile.LIMITS.samples + 1;
  refused(gz({ ...o, data: { t: new Array(many).fill(0), d: new Array(many).fill(0) } }), /too many samples/, 413);
  const chans = Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`c${i}`, 0]));
  refused(withData(chans), /too many channels/, 413);
  refused(withData({ car: { k: [0, 1], rh0: [0], rh1: [0, 0], w: [{}, {}, {}, {}] } }), /car\.rh0/);
  refused(withData({ car: { k: [0, n + 5], rh0: [0, 0], rh1: [0, 0], w: [{}, {}, {}, {}] } }), /car\.k/);
  refused(withData({ car: { k: [], rh0: [], rh1: [], w: [{}] } }), /car data/);
});

test('duplicates: the same lap is found (OD-PL-3); a changed lap time is not', () => {
  const { lap } = lapfile.parseLapFile(exported);
  const same = db.findSameLap(lap);
  assert.equal(same.id, lapId);
  assert.equal(db.findSameLap({ ...lap, lapTimeMs: lap.lapTimeMs + 1 }), null);
});
