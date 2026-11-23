// Light telemetry of a leaderboard lap, as compact bytes (the app gzips them; leaderboard/worker.js checks them).
// Plain JS with no Node modules: the Cloudflare Worker bundles this file too.
//
// A lap resampled every `step` metres (2 m), 9 channels:
//   header  'PLT1' | u16 version | u16 channels | u32 n | f32 step | u32 lapMs     (20 bytes, little endian)
//   t       ms     i32 first value, then i16 differences
//   spd     km/h   i16 x10        thr, brk  0..1  i16 x1000     str  i16 x10000
//   gear           i16            rpm            i16 (capped)
//   x, z    m      i32 first value in cm, then i16 differences in cm
export const TEL_VERSION = 1;
export const TEL_STEP = 2;
export const TEL_CHANNELS = ['t', 'spd', 'thr', 'brk', 'str', 'gear', 'rpm', 'x', 'z'];
const HEADER = 20;
const DELTA = { t: 1, x: 100, z: 100 }; // channel -> scale; first value i32, then i16 differences
const SCALE = { spd: 10, thr: 1000, brk: 1000, str: 10000, gear: 1, rpm: 1 };
const i16 = (v) => Math.max(-32768, Math.min(32767, Math.round(v)));

/** Bytes a lap of n samples takes. */
export const telBytes = (n) => HEADER + TEL_CHANNELS.reduce((a, c) => a + (DELTA[c] ? 4 + 2 * (n - 1) : 2 * n), 0);

/** Encodes a lap on a distance grid {n, step, t[], spd[], ...} (channels missing = 0). */
export function encodeTel(R, lapMs) {
  const n = R.n, buf = new ArrayBuffer(telBytes(n)), v = new DataView(buf);
  [0x50, 0x4c, 0x54, 0x31].forEach((b, i) => v.setUint8(i, b)); // 'PLT1'
  v.setUint16(4, TEL_VERSION, true); v.setUint16(6, TEL_CHANNELS.length, true); v.setUint32(8, n, true);
  v.setFloat32(12, R.step, true); v.setUint32(16, Math.round(lapMs), true);
  let o = HEADER;
  for (const c of TEL_CHANNELS) {
    const a = R[c] || [];
    const at = (i) => (Number.isFinite(a[i]) ? a[i] : 0);
    if (DELTA[c]) {
      const k = DELTA[c];
      let prev = Math.round(at(0) * k);
      v.setInt32(o, prev, true); o += 4;
      for (let i = 1; i < n; i++) { const d = i16(Math.round(at(i) * k) - prev); v.setInt16(o, d, true); o += 2; prev += d; }
    } else {
      for (let i = 0; i < n; i++) { v.setInt16(o, i16(at(i) * SCALE[c]), true); o += 2; }
    }
  }
  return new Uint8Array(buf);
}

/** The header of encoded telemetry, or null when it is not ours. */
export function telHeader(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < HEADER) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v.getUint32(0, false) !== 0x504c5431) return null;
  const h = { version: v.getUint16(4, true), channels: v.getUint16(6, true), n: v.getUint32(8, true), step: v.getFloat32(12, true), lapMs: v.getUint32(16, true) };
  if (h.version !== TEL_VERSION || h.channels !== TEL_CHANNELS.length) return null;
  return h;
}

/** Decodes encoded telemetry into Paddock's lap data {t[], d[], spd[], ...} plus {n, step, lapMs}; null when broken. */
export function decodeTel(bytes) {
  const h = telHeader(bytes);
  if (!h || bytes.length !== telBytes(h.n)) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = { ...h, d: Array.from({ length: h.n }, (_, i) => Math.round(i * h.step * 100) / 100) };
  let o = HEADER;
  for (const c of TEL_CHANNELS) {
    const a = new Array(h.n);
    if (DELTA[c]) {
      const k = DELTA[c];
      let cur = v.getInt32(o, true); o += 4;
      a[0] = cur / k;
      for (let i = 1; i < h.n; i++) { cur += v.getInt16(o, true); o += 2; a[i] = cur / k; }
    } else {
      for (let i = 0; i < h.n; i++) { a[i] = v.getInt16(o, true) / SCALE[c]; o += 2; }
    }
    out[c] = a;
  }
  return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
/** Base64 without Buffer / btoa, the same in Node and in the Worker. */
export function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
    s += B64[a >> 2] + B64[((a & 3) << 4) | ((b ?? 0) >> 4)] + (b === undefined ? '=' : B64[((b & 15) << 2) | ((c ?? 0) >> 6)]) + (c === undefined ? '=' : B64[c & 63]);
  }
  return s;
}
export function fromBase64(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4) return null;
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((s.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    const n = (B64.indexOf(s[i]) << 18) | (B64.indexOf(s[i + 1]) << 12) | ((B64.indexOf(s[i + 2]) & 63) << 6) | (B64.indexOf(s[i + 3]) & 63);
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}
