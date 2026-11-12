// Assetto Corsa EVO shared memory reader (Windows only).
// Layout follows the community header (dSyncro/acevo-shared-memory, pack(4)).
// All offsets live in OFFSETS so they can be corrected easily if Kunos changes the layout.
import koffi from 'koffi';

export const OFFSETS = {
  physics: {
    name: 'Local\\acevo_pmf_physics', size: 800,
    packetId: 0, gas: 4, brake: 8, fuel: 12, gear: 16, rpms: 20, steerAngle: 24, speedKmh: 28,
    accG: 44, numberOfTyresOut: 244, clutch: 364, tyreContactPoint: 420, tcInAction: 672, absInAction: 676, kerbVibration: 784,
  },
  graphics: {
    name: 'Local\\acevo_pmf_graphics', size: 4900,
    packetId: 0, status: 4, playerCarIdA: 24, playerCarIdB: 32,
    steerDegrees: 156, currentLapMs: 188, npos: 1244, totalLapCount: 2384,
    lastLapMs: 2396, bestLapMs: 2400, driverName: 3020, driverSurname: 3053, carModel: 3086,
    inPitBox: 3119, inPitLane: 3120, validLap: 3121, carCoordinates: 3124, carIds: 3940,
  },
  static: {
    name: 'Local\\acevo_pmf_static', size: 208,
    smVersion: 0, evoVersion: 15, session: 32, track: 136, trackConfig: 169, trackLength: 204,
  },
};

export const STATUS = { OFF: 0, REPLAY: 1, LIVE: 2, PAUSE: 3 };

const FILE_MAP_READ = 4;
let k32 = null;
function api() {
  if (k32) return k32;
  const lib = koffi.load('kernel32.dll');
  k32 = {
    open: lib.func('void* __stdcall OpenFileMappingW(uint32_t, int, const char16_t*)'),
    map: lib.func('void* __stdcall MapViewOfFile(void*, uint32_t, uint32_t, uint32_t, size_t)'),
    // copies out of the mapping into a normal Buffer. (koffi.view would wrap the mapping as an external
    // ArrayBuffer, which Electron's V8 memory cage forbids: it aborts the desktop app.)
    copy: lib.func('void __stdcall RtlMoveMemory(_Out_ uint8_t *dst, void *src, size_t len)'),
  };
  return k32;
}

// Windows timers default to ~15.6 ms granularity, which turns a 16.7 ms interval into ~31 ms (30 Hz).
// Request 1 ms resolution while the app runs (same as games/browsers do).
export function enableHighResTimer() {
  try {
    const winmm = koffi.load('winmm.dll');
    const begin = winmm.func('uint32_t __stdcall timeBeginPeriod(uint32_t)');
    const end = winmm.func('uint32_t __stdcall timeEndPeriod(uint32_t)');
    begin(1);
    process.on('exit', () => end(1));
    return true;
  } catch { return false; }
}

class Mapping {
  constructor(def) { this.def = def; this.ptr = null; }
  tryOpen() {
    if (this.ptr) return true;
    const h = api().open(FILE_MAP_READ, 0, this.def.name);
    if (!h) return false;
    const p = api().map(h, FILE_MAP_READ, 0, 0, this.def.size);
    if (!p) return false;
    this.ptr = p;
    return true;
  }
  snapshot() { // copy -> consistent frame
    if (!this.tryOpen()) return null;
    const buf = Buffer.alloc(this.def.size);
    api().copy(buf, this.ptr, this.def.size);
    return buf;
  }
}

function cstr(buf, off, len = 33) {
  const end = buf.indexOf(0, off);
  return buf.toString('utf8', off, end === -1 || end > off + len ? off + len : end).trim();
}

export class ShmSource {
  constructor() {
    this.phys = new Mapping(OFFSETS.physics);
    this.gfx = new Mapping(OFFSETS.graphics);
    this.stat = new Mapping(OFFSETS.static);
    this.staticInfo = null;
    this.staticReadAt = 0;
    this.lastRaw = null;
  }
  get name() { return 'Assetto Corsa EVO shared memory'; }

  readStatic(now) {
    if (this.staticInfo && now - this.staticReadAt < 1000) return this.staticInfo;
    const b = this.stat.snapshot();
    if (!b) return null;
    const S = OFFSETS.static;
    this.staticInfo = {
      smVersion: cstr(b, S.smVersion, 15), evoVersion: cstr(b, S.evoVersion, 15),
      sessionType: b.readInt32LE(S.session), track: cstr(b, S.track), layout: cstr(b, S.trackConfig),
      trackLength: b.readFloatLE(S.trackLength),
    };
    this.staticReadAt = now;
    return this.staticInfo;
  }

  read() {
    const now = Date.now();
    const p = this.phys.snapshot();
    const g = this.gfx.snapshot();
    if (!p || !g) return null;
    const st = this.readStatic(now);
    const P = OFFSETS.physics, G = OFFSETS.graphics;

    // find player's index in car_coordinates by matching car ids
    const pa = g.readBigUInt64LE(G.playerCarIdA), pb = g.readBigUInt64LE(G.playerCarIdB);
    let idx = 0;
    for (let i = 0; i < 60; i++) {
      const o = G.carIds + i * 16;
      if (g.readBigUInt64LE(o) === pa && g.readBigUInt64LE(o + 8) === pb) { idx = i; break; }
    }
    const co = G.carCoordinates + idx * 12;
    const first = cstr(g, G.driverName), last = cstr(g, G.driverSurname);
    // tyre contact points (world x/z) in order FL, FR, RL, RR
    const wheels = [0, 1, 2, 3].map((w) => [p.readFloatLE(P.tyreContactPoint + w * 12), p.readFloatLE(P.tyreContactPoint + w * 12 + 8)]);

    const frame = {
      packetId: p.readInt32LE(P.packetId),
      status: g.readInt32LE(G.status),
      gas: p.readFloatLE(P.gas), brake: p.readFloatLE(P.brake), clutch: p.readFloatLE(P.clutch), fuel: p.readFloatLE(P.fuel),
      gear: p.readInt32LE(P.gear) - 1, // AC convention 0=R,1=N -> -1=R,0=N,1..=gears
      rpm: p.readInt32LE(P.rpms), steer: p.readFloatLE(P.steerAngle), speed: p.readFloatLE(P.speedKmh),
      glat: p.readFloatLE(P.accG), glon: p.readFloatLE(P.accG + 8),
      tc: p.readInt32LE(P.tcInAction), abs: p.readInt32LE(P.absInAction),
      tyresOut: p.readInt32LE(P.numberOfTyresOut), kerb: p.readFloatLE(P.kerbVibration), wheels,
      lapTimeMs: g.readInt32LE(G.currentLapMs), lastLapMs: g.readInt32LE(G.lastLapMs),
      bestLapMs: g.readInt32LE(G.bestLapMs), lapCount: g.readInt32LE(G.totalLapCount),
      npos: g.readFloatLE(G.npos), inPit: g[G.inPitBox] !== 0 || g[G.inPitLane] !== 0,
      valid: g[G.validLap] !== 0,
      x: g.readFloatLE(co), y: g.readFloatLE(co + 4), z: g.readFloatLE(co + 8),
      car: cstr(g, G.carModel), driver: `${first} ${last}`.trim(),
      track: st?.track || '', layout: st?.layout || '', trackLength: st?.trackLength || 0,
      sessionType: st?.sessionType ?? -1,
    };
    this.lastRaw = { frame, static: st, playerIndex: idx, steerDegrees: g.readInt32LE(G.steerDegrees) };
    return frame;
  }
}
