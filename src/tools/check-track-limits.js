// Verifies the EVO track-limit telemetry on the most recent laps:
//   node src/tools/check-track-limits.js [numberOfLaps]
// Expectations if the shared-memory offsets are right:
//   - tyre contact points lie ~0.7-1.6 m from the car centre (half track width / wheelbase)
//   - "tyres out" is 0 most of the time and rises to 1..4 only when running wide
//   - laps invalidated by the game contain samples with 3-4 tyres out
import * as db from '../db.js';

const count = Number(process.argv[2]) || 5;
const laps = db.listLaps().filter((l) => l.source === 'local').slice(0, count);
if (!laps.length) { console.log('No laps recorded yet.'); process.exit(0); }

for (const meta of laps) {
  const { data: d } = db.getLap(meta.id);
  const head = `#${meta.id} ${meta.track} ${meta.layout} | ${meta.car} | ${(meta.lap_time_ms / 1000).toFixed(3)}s ${meta.valid ? 'valid' : 'INVALID'}`;
  if (!d.out) { console.log(`${head}\n   (recorded before track-limit channels existed)`); continue; }
  const n = d.t.length;
  const hist = [0, 0, 0, 0, 0];
  for (const v of d.out) hist[Math.max(0, Math.min(4, v))]++;
  // wheel distance from car centre
  const dist = [];
  for (let i = 0; i < n; i += 5) for (let w = 0; w < 4; w++) dist.push(Math.hypot(d[`w${w}x`][i] - d.x[i], d[`w${w}z`][i] - d.z[i]));
  dist.sort((a, b) => a - b);
  // transitions in/out of limits
  const events = [];
  for (let i = 1; i < n; i++) if (d.out[i] !== d.out[i - 1]) events.push(`${Math.round(d.d[i])}m:${d.out[i - 1]}→${d.out[i]}`);
  const invAt = d.ok.findIndex((v) => v === 0);
  const kerbMax = Math.max(...d.kerb);
  console.log(head);
  console.log(`   tyres out: ${hist.map((c, k) => `${k}=${(100 * c / n).toFixed(1)}%`).join('  ')}`);
  console.log(`   wheel↔centre distance: median ${dist[dist.length >> 1].toFixed(2)} m (min ${dist[0].toFixed(2)}, max ${dist[dist.length - 1].toFixed(2)})`);
  console.log(`   kerb vibration max: ${kerbMax.toFixed(3)} | invalidated at: ${invAt < 0 ? '-' : Math.round(d.d[invAt]) + ' m'}`);
  console.log(`   limit events (${events.length}): ${events.slice(0, 12).join(' ')}${events.length > 12 ? ' …' : ''}`);
}
