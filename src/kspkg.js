// Read-only, in-place reader for AC EVO's content.kspkg (nothing is extracted or modified).
// Layout (as documented by the ACECM project, converter/docs/FORMATS.md, and verified on game 0.9.1):
//   the last 64 MiB of the file is a table of 262,144 records x 256 bytes, each XOR'd with an 8-byte key
//   that restarts at every record. Record: path utf8 @0 (<=228 B), kind u16 @228, path length u16 @230,
//   id u64 @232, size u32 @240, offset u64 @248. kind 0x100 = file data XOR'd with the same key from its
//   first byte, 0 = plain file, 1 = directory.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const KEY = Buffer.from([0xc1, 0x35, 0x11, 0x7d, 0xa9, 0x21, 0x97, 0x9f]);
const REC = 256, COUNT = 262144, TABLE = REC * COUNT;
const STEAM_APP_DIR = 'Assetto Corsa EVO';

// Find content.kspkg: settings override, else every Steam library listed in libraryfolders.vdf.
export function findArchive(override) {
  const candidates = [];
  if (override) candidates.push(override.endsWith('.kspkg') ? override : path.join(override, 'content.kspkg'));
  let steam = null;
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], { encoding: 'utf8', windowsHide: true });
    steam = out.match(/SteamPath\s+REG_SZ\s+(.+)/)?.[1]?.trim().replace(/\//g, '\\');
  } catch { /* no Steam in registry */ }
  const libs = new Set();
  if (steam) {
    libs.add(steam);
    try {
      const vdf = fs.readFileSync(path.join(steam, 'steamapps', 'libraryfolders.vdf'), 'utf8');
      for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) libs.add(m[1].replace(/\\\\/g, '\\'));
    } catch { /* ignore */ }
  }
  for (const lib of libs) candidates.push(path.join(lib, 'steamapps', 'common', STEAM_APP_DIR, 'content.kspkg'));
  return candidates.find((c) => { try { return fs.statSync(c).isFile(); } catch { return false; } }) || null;
}

export class Kspkg {
  // minFiles: a sanity check on the decoded file table (content.kspkg has ~100k files, a mod pack a few hundred)
  constructor(file, { minFiles = 1000 } = {}) {
    this.file = file;
    this.minFiles = minFiles;
    const st = fs.statSync(file);
    this.size = st.size;
    this.stamp = `${st.size}-${Math.round(st.mtimeMs)}`; // changes when a game update rewrites the archive
    this.index = null;
  }

  // path (lower case, backslashes) -> {kind, size, off}
  load() {
    if (this.index) return this;
    const fd = fs.openSync(this.file, 'r');
    try {
      const table = Buffer.alloc(TABLE);
      fs.readSync(fd, table, 0, TABLE, this.size - TABLE);
      const index = new Map();
      const rec = Buffer.alloc(REC);
      for (let r = 0; r < COUNT; r++) {
        table.copy(rec, 0, r * REC, (r + 1) * REC);
        for (let i = 0; i < REC; i++) rec[i] ^= KEY[i & 7];
        const len = rec.readUInt16LE(230);
        if (!len || len > 228) continue;
        const kind = rec.readUInt16LE(228);
        if (kind === 1) continue;
        const off = Number(rec.readBigUInt64LE(248)), size = rec.readUInt32LE(240);
        if (off + size > this.size) continue;
        index.set(rec.toString('utf8', 0, len).toLowerCase(), { kind, size, off });
      }
      if (index.size < this.minFiles) throw new Error(`${path.basename(this.file)} file table not recognised (game update changed the format?)`);
      this.index = index;
    } finally { fs.closeSync(fd); }
    return this;
  }

  has(p) { return this.load().index.has(p.toLowerCase()); }

  list(prefix) {
    const pre = prefix.toLowerCase();
    return [...this.load().index.keys()].filter((k) => k.startsWith(pre));
  }

  read(p) {
    const e = this.load().index.get(p.toLowerCase());
    if (!e) return null;
    const buf = Buffer.alloc(e.size);
    const fd = fs.openSync(this.file, 'r');
    try { fs.readSync(fd, buf, 0, e.size, e.off); } finally { fs.closeSync(fd); }
    if (e.kind === 0x100) for (let i = 0; i < buf.length; i++) buf[i] ^= KEY[i & 7];
    return buf;
  }
}
