// BC7 (BPTC) texture decoder + minimal PNG writer, for the car thumbnails in AC EVO's content.kspkg
// (generated\thumbnails\*.texturemips: 1024 x 1024 BC7, mip 0 only). Follows the D3D11 BC7 format spec.
import zlib from 'node:zlib';

// [subsets, partition bits, rotation bits, index-selection bit, color bits, alpha bits, endpoint p-bits, shared p-bits, index bits, index2 bits]
const MODES = [
  [3, 4, 0, 0, 4, 0, 1, 0, 3, 0],
  [2, 6, 0, 0, 6, 0, 0, 1, 3, 0],
  [3, 6, 0, 0, 5, 0, 0, 0, 2, 0],
  [2, 6, 0, 0, 7, 0, 1, 0, 2, 0],
  [1, 0, 2, 1, 5, 6, 0, 0, 2, 3],
  [1, 0, 2, 0, 7, 8, 0, 0, 2, 2],
  [1, 0, 0, 0, 7, 7, 1, 0, 4, 0],
  [2, 6, 0, 0, 5, 5, 1, 0, 2, 0],
];
const P2 = [0xCCCC, 0x8888, 0xEEEE, 0xECC8, 0xC880, 0xFEEC, 0xFEC8, 0xEC80, 0xC800, 0xFFEC, 0xFE80, 0xE800, 0xFFE8, 0xFF00, 0xFFF0, 0xF000,
  0xF710, 0x008E, 0x7100, 0x08CE, 0x008C, 0x7310, 0x3100, 0x8CCE, 0x088C, 0x3110, 0x6666, 0x366C, 0x17E8, 0x0FF0, 0x718E, 0x399C,
  0xAAAA, 0xF0F0, 0x5A5A, 0x33CC, 0x3C3C, 0x55AA, 0x9696, 0xA55A, 0x73CE, 0x13C8, 0x324C, 0x3BDC, 0x6996, 0xC33C, 0x9966, 0x0660,
  0x0272, 0x04E4, 0x4E40, 0x2720, 0xC936, 0x936C, 0x39C6, 0x639C, 0x9336, 0x9CC6, 0x817E, 0xE718, 0xCCF0, 0x0FCC, 0x7744, 0xEE22];
const P3 = [
  '0011001102212222', '0001001122112221', '0000200122112211', '0222002200110111', '0000000011221122', '0011001100220022', '0022002211111111', '0011001122112211',
  '0000000011112222', '0000111111112222', '0000111122222222', '0012001200120012', '0112011201120112', '0122012201220122', '0011011211221222', '0011200122002220',
  '0001001101121122', '0111001120012200', '0000112211221122', '0022002200221111', '0111011102220222', '0001000122212221', '0000001101220122', '0000110022102210',
  '0122012200110000', '0012001211222222', '0110122112210110', '0000011012211221', '0022110211020022', '0110011020022222', '0011012201220011', '0000200022112221',
  '0000000211221222', '0222002200120011', '0011001200220222', '0120012001200120', '0000111122220000', '0120120120120120', '0120201212010120', '0011220011220011',
  '0011112222000011', '0101010122222222', '0000000021212121', '0022112200221122', '0022001100220011', '0220122102201221', '0101222222220101', '0000212121212121',
  '0101010101012222', '0222011102220111', '0002111200021112', '0000211221122112', '0222011101110222', '0002111211120002', '0110011001102222', '0000000021122112',
  '0110011022222222', '0022001100110022', '0022112211220022', '0000000000002112', '0002000100020001', '0222122202221222', '0101222222222222', '0111201122012220',
].map((s) => [...s].map(Number));
const A2 = [15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 2, 8, 2, 2, 8, 8, 15, 2, 8, 2, 2, 8, 8, 2, 2,
  15, 15, 6, 8, 2, 8, 15, 15, 2, 8, 2, 2, 2, 15, 15, 6, 6, 2, 6, 8, 15, 15, 2, 2, 15, 15, 15, 15, 15, 2, 2, 15];
const A3a = [3, 3, 15, 15, 8, 3, 15, 15, 8, 8, 6, 6, 6, 5, 3, 3, 3, 3, 8, 15, 3, 3, 6, 10, 5, 8, 8, 6, 8, 5, 15, 15,
  8, 15, 3, 5, 6, 10, 8, 15, 15, 3, 15, 5, 15, 15, 15, 15, 3, 15, 5, 5, 5, 8, 5, 10, 5, 10, 8, 13, 15, 12, 3, 3];
const A3b = [15, 8, 8, 3, 15, 15, 3, 8, 15, 15, 15, 15, 15, 15, 15, 8, 15, 8, 15, 3, 15, 8, 15, 8, 3, 15, 6, 10, 15, 15, 10, 8,
  15, 3, 15, 10, 10, 8, 9, 10, 6, 15, 8, 15, 3, 6, 6, 8, 15, 3, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 3, 15, 15, 8];
const W = { 2: [0, 21, 43, 64], 3: [0, 9, 18, 27, 37, 46, 55, 64], 4: [0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64] };

const subsetOf = (ns, part, px) => (ns === 1 ? 0 : ns === 2 ? (P2[part] >> px) & 1 : P3[part][px]);
const isAnchor = (ns, part, px) => px === 0 || (ns === 2 && px === A2[part]) || (ns === 3 && (px === A3a[part] || px === A3b[part]));

/** Decode one 16-byte block into out (RGBA, 4x4 = 64 bytes). */
function decodeBlock(src, off, out) {
  let pos = 0;
  const bits = (n) => {
    let v = 0;
    for (let i = 0; i < n; i++, pos++) v |= ((src[off + (pos >> 3)] >> (pos & 7)) & 1) << i;
    return v;
  };
  let mode = 0;
  while (mode < 8 && !bits(1)) mode++;
  if (mode === 8) { out.fill(0); return; } // reserved: transparent black
  const [ns, pb, rb, isb, cb, ab, epb, spb, ib, ib2] = MODES[mode];
  const part = bits(pb), rot = bits(rb), sel = bits(isb);
  const ne = ns * 2;
  const ep = Array.from({ length: ne }, () => [0, 0, 0, 255]);
  for (let c = 0; c < 3; c++) for (let e = 0; e < ne; e++) ep[e][c] = bits(cb);
  if (ab) for (let e = 0; e < ne; e++) ep[e][3] = bits(ab);
  let cbits = cb, abits = ab;
  if (epb) {
    for (let e = 0; e < ne; e++) { const p = bits(1); for (let c = 0; c < 3; c++) ep[e][c] = (ep[e][c] << 1) | p; if (ab) ep[e][3] = (ep[e][3] << 1) | p; }
    cbits++; if (ab) abits++;
  } else if (spb) {
    for (let s = 0; s < ns; s++) { const p = bits(1); for (const e of [s * 2, s * 2 + 1]) for (let c = 0; c < 3; c++) ep[e][c] = (ep[e][c] << 1) | p; }
    cbits++;
  }
  const expand = (v, n) => { v <<= 8 - n; return v | (v >> n); };
  for (const e of ep) { for (let c = 0; c < 3; c++) e[c] = expand(e[c], cbits); e[3] = ab ? expand(e[3], abits) : 255; }

  const idx = new Array(16), idx2 = new Array(16);
  for (let px = 0; px < 16; px++) idx[px] = bits(isAnchor(ns, part, px) ? ib - 1 : ib);
  if (ib2) for (let px = 0; px < 16; px++) idx2[px] = bits(px === 0 ? ib2 - 1 : ib2);

  for (let px = 0; px < 16; px++) {
    const s = subsetOf(ns, part, px);
    const e0 = ep[s * 2], e1 = ep[s * 2 + 1];
    let ci, ai, cw, aw;
    if (!ib2) { ci = ai = idx[px]; cw = aw = W[ib]; }
    else if (sel) { ci = idx2[px]; cw = W[ib2]; ai = idx[px]; aw = W[ib]; }
    else { ci = idx[px]; cw = W[ib]; ai = idx2[px]; aw = W[ib2]; }
    const lerp = (a, b, w) => (a * (64 - w) + b * w + 32) >> 6;
    let r = lerp(e0[0], e1[0], cw[ci]), g = lerp(e0[1], e1[1], cw[ci]), b = lerp(e0[2], e1[2], cw[ci]), a = lerp(e0[3], e1[3], aw[ai]);
    if (rot === 1) [r, a] = [a, r]; else if (rot === 2) [g, a] = [a, g]; else if (rot === 3) [b, a] = [a, b];
    const o = px * 4;
    out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
  }
}

/** BC7 data -> RGBA pixels (width x height, multiples of 4). */
export function decodeBC7(src, width, height) {
  const rgba = Buffer.alloc(width * height * 4);
  const blk = new Uint8Array(64);
  const bw = width >> 2, bh = height >> 2;
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      decodeBlock(src, (by * bw + bx) * 16, blk);
      for (let y = 0; y < 4; y++) blk.subarray(y * 16, y * 16 + 16).forEach((v, i) => { rgba[((by * 4 + y) * width + bx * 4) * 4 + i] = v; });
    }
  }
  return rgba;
}

/** Box-filter downscale by an integer factor (alpha-weighted so edges do not go dark). */
export function downscale(rgba, w, h, f) {
  const W2 = Math.floor(w / f), H2 = Math.floor(h / f);
  const out = Buffer.alloc(W2 * H2 * 4);
  for (let y = 0; y < H2; y++) for (let x = 0; x < W2; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let yy = 0; yy < f; yy++) for (let xx = 0; xx < f; xx++) {
      const i = ((y * f + yy) * w + x * f + xx) * 4, al = rgba[i + 3];
      r += rgba[i] * al; g += rgba[i + 1] * al; b += rgba[i + 2] * al; a += al;
    }
    const o = (y * W2 + x) * 4;
    if (a) { out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a); }
    out[o + 3] = Math.round(a / (f * f));
  }
  return out;
}

/**
 * A game thumbnail -> PNG: untile (tw x th pixel tiles stored one after the other, row-major), decode,
 * crop the middle band to 16:10 (the car sits there) and shrink to ~512 px wide.
 */
export function renderThumb(data, W, H, tw, th) {
  const lin = Buffer.alloc(W * H);
  const bw = W / 4, tbw = tw / 4, tbh = th / 4, tilesX = W / tw;
  let src = 0;
  for (let t = 0; t < (W / tw) * (H / th); t++) {
    const tx = t % tilesX, ty = Math.floor(t / tilesX);
    for (let y = 0; y < tbh; y++) { const dst = ((ty * tbh + y) * bw + tx * tbw) * 16; data.copy(lin, dst, src, src + tbw * 16); src += tbw * 16; }
  }
  const rgba = decodeBC7(lin, W, H);
  const cropH = Math.round(W * 10 / 16 / 4) * 4, y0 = Math.round((H - cropH) / 2 / 4) * 4 + Math.round(H * 0.02 / 4) * 4;
  const cropped = rgba.subarray(y0 * W * 4, (y0 + cropH) * W * 4);
  const f = Math.max(1, Math.round(W / 512));
  return encodePNG(downscale(cropped, W, cropH, f), Math.floor(W / f), Math.floor(cropH / f));
}

// ---------------------------------------------------------------- PNG
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (buf) => { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
export function encodePNG(rgba, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}
