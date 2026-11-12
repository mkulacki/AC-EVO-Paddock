// Minimal zip reader (no dependencies): list the entries of a .zip and extract one to a file.
// Supports stored and deflated entries and Zip64. Encrypted entries are refused.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';

const EOCD = 0x06054b50, EOCD64 = 0x06064b50, LOC64 = 0x07064b50, CEN = 0x02014b50, LOC = 0x04034b50;

function readAt(fd, pos, len) {
  const b = Buffer.alloc(len);
  const n = fs.readSync(fd, b, 0, len, pos);
  return b.subarray(0, n);
}

// [{ name, size, csize, method, offset, dir }]
export function list(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const tailLen = Math.min(size, 65557);
    const tail = readAt(fd, size - tailLen, tailLen);
    let e = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === EOCD) { e = i; break; }
    if (e < 0) throw new Error('Not a zip file (or a damaged one)');
    let count = tail.readUInt16LE(e + 10), cdSize = tail.readUInt32LE(e + 12), cdOff = tail.readUInt32LE(e + 16);
    // Zip64 end of central directory
    if (count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) {
      const l = e - 20;
      if (l >= 0 && tail.readUInt32LE(l) === LOC64) {
        const z = readAt(fd, Number(tail.readBigUInt64LE(l + 8)), 56);
        if (z.readUInt32LE(0) !== EOCD64) throw new Error('Damaged Zip64 directory');
        count = Number(z.readBigUInt64LE(32)); cdSize = Number(z.readBigUInt64LE(40)); cdOff = Number(z.readBigUInt64LE(48));
      }
    }
    const cd = readAt(fd, cdOff, cdSize);
    const out = [];
    let p = 0;
    for (let k = 0; k < count; k++) {
      if (cd.readUInt32LE(p) !== CEN) throw new Error('Damaged zip directory');
      const flags = cd.readUInt16LE(p + 8), method = cd.readUInt16LE(p + 10);
      let csize = cd.readUInt32LE(p + 20), usize = cd.readUInt32LE(p + 24);
      const nLen = cd.readUInt16LE(p + 28), xLen = cd.readUInt16LE(p + 30), cLen = cd.readUInt16LE(p + 32);
      let offset = cd.readUInt32LE(p + 42);
      const name = cd.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nLen).replace(/\\/g, '/');
      // Zip64 extra field: only the values that were 0xFFFFFFFF are present, in this order
      let x = p + 46 + nLen; const xEnd = x + xLen;
      while (x + 4 <= xEnd) {
        const id = cd.readUInt16LE(x), len = cd.readUInt16LE(x + 2);
        if (id === 1) {
          let q = x + 4;
          if (usize === 0xffffffff) { usize = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (csize === 0xffffffff) { csize = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (offset === 0xffffffff) { offset = Number(cd.readBigUInt64LE(q)); }
        }
        x += 4 + len;
      }
      out.push({ name, size: usize, csize, method, offset, encrypted: !!(flags & 1), dir: name.endsWith('/') });
      p += 46 + nLen + xLen + cLen;
    }
    return out;
  } finally { fs.closeSync(fd); }
}

// the same, synchronously and in memory (for small zips such as the bundled App Loader)
export function extractSync(file, entry, dest) {
  if (entry.encrypted) throw new Error(`${entry.name} is password-protected`);
  if (entry.method !== 0 && entry.method !== 8) throw new Error(`${entry.name}: unsupported compression (method ${entry.method})`);
  const fd = fs.openSync(file, 'r');
  let data;
  try {
    const h = readAt(fd, entry.offset, 30);
    if (h.readUInt32LE(0) !== LOC) throw new Error('Damaged zip entry');
    data = readAt(fd, entry.offset + 30 + h.readUInt16LE(26) + h.readUInt16LE(28), entry.csize);
  } finally { fs.closeSync(fd); }
  if (entry.method === 8) data = zlib.inflateRawSync(data);
  if (data.length !== entry.size) throw new Error(`${entry.name}: size mismatch after extracting`);
  fs.writeFileSync(dest, data);
}

export async function extract(file, entry, dest) {
  if (entry.encrypted) throw new Error(`${entry.name} is password-protected`);
  if (entry.method !== 0 && entry.method !== 8) throw new Error(`${entry.name}: unsupported compression (method ${entry.method})`);
  const fd = fs.openSync(file, 'r');
  let start;
  try {
    const h = readAt(fd, entry.offset, 30);
    if (h.readUInt32LE(0) !== LOC) throw new Error('Damaged zip entry');
    start = entry.offset + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
  } finally { fs.closeSync(fd); }
  const src = entry.csize ? fs.createReadStream(file, { start, end: start + entry.csize - 1 }) : null;
  if (!src) { fs.writeFileSync(dest, ''); return; }
  const steps = [src, ...(entry.method === 8 ? [zlib.createInflateRaw()] : []), fs.createWriteStream(dest)];
  await pipeline(...steps);
  if (fs.statSync(dest).size !== entry.size) throw new Error(`${entry.name}: size mismatch after extracting`);
}
