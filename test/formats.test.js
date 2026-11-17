// Binary formats: the protobuf readers (src/pb.js, src/carsetup.js codec) and the zip reader (src/zip.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { isolate } from './helpers.js';

const { dir } = isolate('formats');
const pb = await import('../src/pb.js');
const cs = await import('../src/carsetup.js');
const zip = await import('../src/zip.js');

// ---------------------------------------------------------------- a tiny protobuf writer for the tests
const varint = (v) => { const o = []; while (v >= 0x80) { o.push((v % 0x80) | 0x80); v = Math.floor(v / 0x80); } o.push(v); return Buffer.from(o); };
const key = (f, wt) => varint(f * 8 + wt);
const fVarint = (f, v) => Buffer.concat([key(f, 0), varint(v)]);
const fFloat = (f, v) => { const b = Buffer.alloc(4); b.writeFloatLE(v); return Buffer.concat([key(f, 5), b]); };
const fBytes = (f, body) => { const b = Buffer.isBuffer(body) ? body : Buffer.from(body); return Buffer.concat([key(f, 2), varint(b.length), b]); };

test('pb.fields / walk / vec3 read nested messages', () => {
  const v = Buffer.concat([fFloat(1, 1.5), fFloat(3, -2)]);
  const msg = Buffer.concat([fVarint(1, 300), fBytes(2, 'hello'), fBytes(4, fBytes(7, v)), fBytes(4, fBytes(7, v))]);
  const fs1 = pb.fields(msg);
  assert.equal(pb.num(fs1, 1), 300);
  assert.equal(pb.str(msg, pb.one(fs1, 2)), 'hello');
  assert.equal(pb.all(fs1, 4).length, 2);
  const vecs = pb.walk(msg, [4, 7]);
  assert.equal(vecs.length, 2);
  assert.deepEqual(pb.vec3(msg, vecs[0]), [1.5, 0, -2]);
  assert.equal(pb.num(fs1, 99, 'none'), 'none');
});

test('pb.fields rejects a length that runs past the end', () => {
  const bad = Buffer.concat([key(2, 2), varint(50), Buffer.from('short')]);
  assert.throws(() => pb.fields(bad), /bad protobuf length/);
});

test('carsetup decode → encode is byte-identical (unknown fields and order kept)', () => {
  const inner = Buffer.concat([fFloat(1, 0.25), fFloat(2, -3.5), fVarint(4, 1)]);
  const buf = Buffer.concat([fVarint(1, 7), fBytes(2, inner), fBytes(9, 'ks_car_preset_x'), fVarint(10, 3), fBytes(2, inner)]);
  const nodes = cs.decode(buf);
  assert.equal(nodes.length, 5);
  assert.ok(cs.encode(nodes).equals(buf));
  assert.equal(cs.presetOf(buf), 'ks_car_preset_x');
  assert.throws(() => cs.decode(Buffer.from([0x12, 0x40, 0x01])), /bad protobuf length/);
});

test('carsetup.readLimits finds limit entries by path', () => {
  // limits file: group 2 { entry 1 {step, min, max, adj, unit} entry 1 {…} }
  const lim = (step, min, max, unit) => Buffer.concat([fFloat(1, step), fFloat(2, min), fFloat(3, max), fVarint(4, 1), fBytes(7, unit)]);
  const buf = fBytes(2, Buffer.concat([fBytes(1, lim(0.5, 20, 30, 'psi')), fBytes(1, lim(0.1, -4, 0, '°'))]));
  const L = cs.readLimits(buf);
  assert.equal(L.length, 2);
  assert.deepEqual(L[0].path, [[2, 0], [1, 0]]);
  assert.deepEqual(L[1].path, [[2, 0], [1, 1]]);
  assert.equal(L[0].unit, 'psi');
  assert.ok(Math.abs(L[1].min + 4) < 1e-6 && L[1].adj);
});

test('carsetup.snap keeps a value on the step grid and inside the limits', () => {
  const s = { value: 25, min: 20, max: 30, step: 0.5 };
  assert.equal(cs.snap(s, 25.3), 25.5);
  assert.equal(cs.snap(s, 99), 30);
  assert.equal(cs.snap(s, -5), 20);
  assert.equal(cs.snap(s, 'abc'), 25);
});

// ---------------------------------------------------------------- zip: a hand-built archive (one stored, one deflated entry)
function makeZip(entries) {
  const locals = [], cents = [];
  let off = 0;
  for (const { name, data, deflate } of entries) {
    const body = deflate ? zlib.deflateRawSync(data) : data;
    const crc = zlib.crc32(data);
    const nm = Buffer.from(name);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(deflate ? 8 : 0, 8);
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(body.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(nm.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(deflate ? 8 : 0, 10);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nm.length, 28); c.writeUInt32LE(off, 42);
    locals.push(h, nm, body); cents.push(c, nm);
    off += 30 + nm.length + body.length;
  }
  const cd = Buffer.concat(cents);
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(entries.length, 8); e.writeUInt16LE(entries.length, 10);
  e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, e]);
}

test('zip.list / extractSync / extract read stored and deflated entries', async () => {
  const big = Buffer.from('paddock '.repeat(500));
  const file = path.join(dir, 'test.zip');
  fs.writeFileSync(file, makeZip([{ name: 'mods/a.txt', data: Buffer.from('hello') }, { name: 'mods/b.txt', data: big, deflate: true }]));
  const list = zip.list(file);
  assert.deepEqual(list.map((e) => [e.name, e.size, e.method]), [['mods/a.txt', 5, 0], ['mods/b.txt', big.length, 8]]);
  zip.extractSync(file, list[0], path.join(dir, 'a.txt'));
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'hello');
  await zip.extract(file, list[1], path.join(dir, 'b.txt'));
  assert.ok(fs.readFileSync(path.join(dir, 'b.txt')).equals(big));
});

test('zip.list refuses a file that is not a zip', () => {
  const file = path.join(dir, 'not.zip');
  fs.writeFileSync(file, 'definitely not a zip file, just text');
  assert.throws(() => zip.list(file), /Not a zip/);
});
