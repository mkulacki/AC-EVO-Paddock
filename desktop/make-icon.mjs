// Renders the app logo (the favicon in public/index.html) into desktop/icon.ico + icon.png.
// Run once after changing the logo: npm run make-icon
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePNG } from '../src/bc7.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const LIME = [200, 255, 30], DARK = [11, 14, 5];
const LINE = [[3.5, 11], [6.5, 5], [8.5, 9], [10, 7], [12, 11]], HALF_W = 0.8; // logo units (16x16 viewBox)

function segDist(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}
// colour of one point of the logo, or null when transparent
function sample(u, v) {
  if (v < 1 || v > 15) return null;
  const k = (v - 1) * 4 / 14;
  if (u < 4 - k || u > 16 - k) return null; // parallelogram (4,1) (16,1) (12,15) (0,15)
  for (let i = 1; i < LINE.length; i++) if (segDist(u, v, LINE[i - 1], LINE[i]) <= HALF_W) return DARK;
  return LIME;
}
function render(size, ss = 6) {
  const rgba = Buffer.alloc(size * size * 4), s = 16 / size;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let j = 0; j < ss; j++) for (let i = 0; i < ss; i++) {
      const c = sample((x + (i + 0.5) / ss) * s, (y + (j + 0.5) / ss) * s);
      if (c) { r += c[0]; g += c[1]; b += c[2]; a++; }
    }
    const o = (y * size + x) * 4;
    if (a) { rgba[o] = r / a; rgba[o + 1] = g / a; rgba[o + 2] = b / a; rgba[o + 3] = Math.round(255 * a / (ss * ss)); }
  }
  return encodePNG(rgba, size, size);
}

const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const pngs = sizes.map((n) => render(n));
// ICO with embedded PNGs (supported since Windows Vista)
const head = Buffer.alloc(6 + 16 * sizes.length);
head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
let offset = head.length;
sizes.forEach((n, i) => {
  const e = 6 + 16 * i;
  head[e] = n >= 256 ? 0 : n; head[e + 1] = n >= 256 ? 0 : n;
  head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
  head.writeUInt32LE(pngs[i].length, e + 8); head.writeUInt32LE(offset, e + 12);
  offset += pngs[i].length;
});
fs.writeFileSync(path.join(DIR, 'icon.ico'), Buffer.concat([head, ...pngs]));
fs.writeFileSync(path.join(DIR, 'icon.png'), pngs[sizes.indexOf(256)]);
console.log('wrote desktop/icon.ico and desktop/icon.png');
