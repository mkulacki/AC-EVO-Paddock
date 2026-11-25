// Recording performance diagnostics (PL3): how regularly the 60 Hz telemetry loop runs, how long its work takes,
// how much the event loop is held up, and how long the bigger jobs take (saving a lap, the HUD's references, slow
// API requests). Everything is bounded: fixed histograms, a few counters and small rings. Nothing is logged per
// sample. Numbers only: no names, keys, paths or query strings are kept (a route is kept as its first two path parts).
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

// bucket upper bounds in ms; the last bucket is everything above
const BOUNDS = [0.25, 0.5, 1, 2, 4, 8, 12, 16, 17, 20, 25, 33, 50, 100, 250, 500, 1000, 2500, 5000];

/** A fixed-size latency histogram (ms): count, sum, max and bucket counts. Percentiles are bucket upper bounds. */
export class Hist {
  constructor() { this.reset(); }
  reset() { this.n = 0; this.sum = 0; this.max = 0; this.b = new Array(BOUNDS.length + 1).fill(0); }
  add(ms) {
    if (!(ms >= 0)) return;
    this.n++; this.sum += ms; if (ms > this.max) this.max = ms;
    let i = 0; while (i < BOUNDS.length && ms > BOUNDS[i]) i++;
    this.b[i]++;
  }
  /** The bucket bound at or below which a share q of the values lie (the max for the last bucket). */
  pct(q) {
    if (!this.n) return null;
    let k = 0; const want = q * this.n;
    for (let i = 0; i < this.b.length; i++) { k += this.b[i]; if (k >= want) return i < BOUNDS.length ? Math.min(BOUNDS[i], this.max) : this.max; }
    return this.max;
  }
  summary() {
    const r = (v) => (v == null ? null : Math.round(v * 100) / 100);
    return { n: this.n, mean: this.n ? r(this.sum / this.n) : null, p50: r(this.pct(0.5)), p95: r(this.pct(0.95)), p99: r(this.pct(0.99)), max: r(this.max) };
  }
}
export const BUCKETS = BOUNDS;

const NOMINAL_MS = 1000 / 60;
const LATE_MS = 2 * NOMINAL_MS; // a tick that comes this late means at least one 60 Hz frame was not read
const STALL_MS = 250;            // a gap this long is a stall (a sleeping PC shows up here too, once)
const OPS = new Set(['lapSave', 'lapEvents', 'hudRefs']); // saving a lap (encode + insert), its 'lap' listeners, the HUD's reference laps
const SLOW_REQ_MS = 50;
const RING = 20;

function create({ now = () => performance.now(), elResolution = 10 } = {}) {
  let el = null; // the event-loop delay monitor, started by start() (the server), not on import
  let startedAt = Date.now();
  const interval = new Hist(), work = new Hist();
  const ops = new Map([...OPS].map((k) => [k, new Hist()]));
  const errors = new Map(); // op -> count of failures
  const slow = []; // the last RING slow requests and ticks: {what, ms, at} (summary: slowest first)
  let lastStart = null, late = 0, missed = 0, stalls = 0;
  const mem = []; // {at, rss, heap} once a minute, last hour
  let memAt = 0;

  const remember = (what, ms) => { slow.push({ what, ms: Math.round(ms * 10) / 10, at: Date.now() }); if (slow.length > RING) slow.shift(); };
  return {
    /** Call at the start of each telemetry tick; returns the start time for tickEnd. */
    tickStart() {
      const t = now();
      if (lastStart != null) {
        const gap = t - lastStart;
        interval.add(gap);
        if (gap > LATE_MS) { late++; missed += Math.max(0, Math.round(gap / NOMINAL_MS) - 1); }
        if (gap > STALL_MS) stalls++;
      }
      lastStart = t;
      return t;
    },
    tickEnd(t0) {
      const ms = now() - t0;
      work.add(ms);
      if (ms > LATE_MS) remember('tick', ms);
      const wall = Date.now();
      if (wall - memAt >= 60e3) {
        memAt = wall;
        const m = process.memoryUsage();
        mem.push({ at: wall, rssMb: Math.round(m.rss / 1048576), heapMb: Math.round(m.heapUsed / 1048576) });
        if (mem.length > 60) mem.shift();
      }
    },
    /** Time a named job (one of OPS); returns fn's result. */
    time(op, fn) {
      const t0 = now();
      try { return fn(); } finally { this.record(op, now() - t0); }
    },
    record(op, ms) { const h = ops.get(op); if (h) h.add(ms); },
    error(op) { if (OPS.has(op)) errors.set(op, (errors.get(op) || 0) + 1); },
    /** A request was answered (ms = until the answer was sent): only slow ones are kept, by route (first two path parts). */
    request(method, pathname, ms) {
      if (ms < SLOW_REQ_MS) return;
      const route = String(pathname || '').split('/').slice(0, 3).join('/').replace(/[^a-z0-9/_-]/gi, '').slice(0, 40);
      remember(`${/^[A-Z]{3,7}$/.test(method) ? method : 'GET'} ${route}`, ms);
    },
    summary() {
      const ns = (v) => Math.round((v / 1e6) * 100) / 100;
      return {
        since: new Date(startedAt).toISOString(),
        nominalMs: Math.round(NOMINAL_MS * 100) / 100,
        tickInterval: interval.summary(),
        tickWork: work.summary(),
        lateTicks: late, missedFramesEstimate: missed, stalls,
        eventLoopDelay: el && el.count ? { p50: ns(el.percentile(50)), p99: ns(el.percentile(99)), max: ns(el.max), mean: ns(el.mean) } : null,
        jobs: Object.fromEntries([...ops].filter(([, h]) => h.n).map(([k, h]) => [k, h.summary()])),
        errors: Object.fromEntries(errors),
        slowest: slow.slice().sort((a, b) => b.ms - a.ms).slice(0, 10).map((s) => ({ what: s.what, ms: s.ms, at: new Date(s.at).toISOString() })),
        memory: mem.slice(-10),
      };
    },
    reset() {
      interval.reset(); work.reset(); for (const h of ops.values()) h.reset(); errors.clear();
      slow.length = 0; late = 0; missed = 0; stalls = 0; lastStart = null; el?.reset();
    },
    start() {
      if (el) return;
      try { el = monitorEventLoopDelay({ resolution: elResolution }); el.enable(); } catch { el = null; }
      startedAt = Date.now();
    },
    stop() { el?.disable(); el = null; },
  };
}

export const createPerf = create;
/** The app's one instance (the telemetry loop, the recorder, the HUD and the HTTP server report into it). */
export const perf = create();
