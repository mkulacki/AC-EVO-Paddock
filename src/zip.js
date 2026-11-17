// Minimal zip reader and writer (no dependencies): list the entries of a .zip and extract one to a file; write backups.
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

// ---------------------------------------------------------------- writer (backups)
const MAX32 = 0xffffffff;
const dosTime = (d) => ({
  time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
  date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
});
/**
 * Write a zip: entries [{name, file}] (streamed from disk) or [{name, data: Buffer|string}], deflated, UTF-8 names.
 * Sizes go in a data descriptor after each entry, so nothing is held in memory. Zip64 is not written: an entry or the
 * whole archive over 4 GiB is refused.
 */
export async function writeZip(dest, entries) {
  const out = fs.createWriteStream(dest);
  let offset = 0;
  const put = (buf) => new Promise((resolve, reject) => { offset += buf.length; out.write(buf, (e) => (e ? reject(e) : resolve())); });
  const central = [];
  const { time, date } = dosTime(new Date());
  try {
    for (const e of entries) {
      const name = Buffer.from(e.name.split(String.fromCharCode(92)).join('/'));
      const start = offset;
      const h = Buffer.alloc(30);
      h.writeUInt32LE(LOC, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0808, 6); h.writeUInt16LE(8, 8);
      h.writeUInt16LE(time, 10); h.writeUInt16LE(date, 12); h.writeUInt16LE(name.length, 26);
      await put(h); await put(name);
      let crc = 0, usize = 0, csize = 0;
      const deflate = zlib.createDeflateRaw({ level: 6 });
      const done = new Promise((resolve, reject) => {
        deflate.on('data', (c) => { csize += c.length; deflate.pause(); put(c).then(() => deflate.resume(), reject); });
        deflate.on('end', resolve); deflate.on('error', reject);
      });
      const feed = (chunk) => { crc = zlib.crc32(chunk, crc); usize += chunk.length; };
      if (e.file) {
        const src = fs.createReadStream(e.file);
        src.on('data', feed);
        await pipeline(src, deflate);
      } else {
        const b = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data));
        feed(b); deflate.end(b);
      }
      await done;
      if (usize > MAX32 || csize > MAX32 || offset > MAX32) throw new Error(`${e.name} is too big for a zip without Zip64`);
      const dd = Buffer.alloc(16);
      dd.writeUInt32LE(0x08074b50, 0); dd.writeUInt32LE(crc >>> 0, 4); dd.writeUInt32LE(csize, 8); dd.writeUInt32LE(usize, 12);
      await put(dd);
      central.push({ name, crc, csize, usize, start });
    }
    const cdStart = offset;
    for (const c of central) {
      const h = Buffer.alloc(46);
      h.writeUInt32LE(CEN, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(20, 6); h.writeUInt16LE(0x0808, 8); h.writeUInt16LE(8, 10);
      h.writeUInt16LE(time, 12); h.writeUInt16LE(date, 14); h.writeUInt32LE(c.crc >>> 0, 16); h.writeUInt32LE(c.csize, 20); h.writeUInt32LE(c.usize, 24);
      h.writeUInt16LE(c.name.length, 28); h.writeUInt32LE(c.start, 42);
      await put(h); await put(c.name);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(EOCD, 0); end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(offset - cdStart, 12); end.writeUInt32LE(cdStart, 16);
    await put(end);
    await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
  } catch (err) {
    out.destroy();
    fs.rmSync(dest, { force: true });
    throw err;
  }
}

/** One entry of a (small) zip as a Buffer, or null when it is not there. */
export function readEntry(file, name) {
  const e = list(file).find((x) => x.name === name);
  if (!e) return null;
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try { extractSync(file, e, tmp); return fs.readFileSync(tmp); } finally { fs.rmSync(tmp, { force: true }); }
}
