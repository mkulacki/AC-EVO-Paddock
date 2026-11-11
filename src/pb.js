// Minimal schema-less protobuf reader for AC EVO content files (all game data is protobuf without
// embedded schemas; fields are referred to by number, see docs in src/trackdata.js).

function varint(b, p) {
  let v = 0, s = 0;
  for (;;) {
    const x = b[p++];
    v += (x & 0x7f) * 2 ** s;
    s += 7;
    if (!(x & 0x80)) return [v, p];
  }
}

// -> [{f, wt, v}] for scalars, [{f, wt: 2, s, e}] for length-delimited (sub-message, bytes or string)
export function fields(b, s = 0, e = b.length) {
  const out = [];
  let p = s;
  while (p < e) {
    let k;
    [k, p] = varint(b, p);
    const f = Math.floor(k / 8), wt = k & 7;
    if (!f) throw new Error('bad protobuf field');
    if (wt === 0) { let v; [v, p] = varint(b, p); out.push({ f, wt, v }); }
    else if (wt === 5) { out.push({ f, wt, v: b.readFloatLE(p) }); p += 4; }
    else if (wt === 1) { out.push({ f, wt, v: b.readDoubleLE(p) }); p += 8; }
    else if (wt === 2) {
      let l;
      [l, p] = varint(b, p);
      if (p + l > e) throw new Error('bad protobuf length');
      out.push({ f, wt, s: p, e: p + l });
      p += l;
    } else throw new Error(`unsupported wire type ${wt}`);
  }
  return out;
}

export const sub = (b, it) => fields(b, it.s, it.e);
export const str = (b, it) => b.toString('utf8', it.s, it.e);
export const all = (fs, f) => fs.filter((x) => x.f === f);
export const one = (fs, f) => fs.find((x) => x.f === f);
export const num = (fs, f, dflt = null) => one(fs, f)?.v ?? dflt;

// vector message {f1 x, f2 y, f3 z} (missing fields are 0)
export function vec3(b, it) {
  const v = sub(b, it);
  return [num(v, 1, 0), num(v, 2, 0), num(v, 3, 0)];
}

// all sub-messages reached by following a field-number path (repeated fields fan out)
export function walk(b, path, s = 0, e = b.length) {
  let level = [{ s, e }];
  for (const f of path) {
    const next = [];
    for (const m of level) {
      let fs;
      try { fs = fields(b, m.s, m.e); } catch { continue; }
      for (const it of fs) if (it.f === f && it.wt === 2) next.push(it);
    }
    level = next;
  }
  return level;
}
