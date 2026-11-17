// Bulk export of laps and sessions as CSV (Settings → Export), for spreadsheets. Lap telemetry itself is exported per
// lap as .lap.gz (Sessions); a full copy of everything is a backup (src/backup.js).
import * as db from './db.js';

const cell = (v) => {
  if (v == null) return '';
  const s = String(v);
  // a leading = + - @ would run as a formula in a spreadsheet: quoted with a ' in front
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
  return /[",\n\r;]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
const csv = (header, rows) => [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
const iso = (t) => (t ? new Date(t).toISOString() : '');
const lapTime = (ms) => (ms == null ? '' : `${Math.floor(ms / 60000)}:${((ms % 60000) / 1000).toFixed(3).padStart(6, '0')}`);

export function lapsCsv() {
  const laps = db.listLaps().slice().sort((a, b) => a.recorded_at - b.recorded_at);
  return csv(['lap_id', 'session_id', 'recorded_at', 'track', 'layout', 'car', 'lap_number', 'lap_time', 'lap_time_ms', 'valid', 'driver', 'source', 'setup', 'track_length_m'],
    laps.map((l) => [l.id, l.session_id, iso(l.recorded_at), l.track, l.layout, l.car, l.lap_number, lapTime(l.lap_time_ms), l.lap_time_ms, l.valid ? 1 : 0, l.driver, l.source, l.setup_name, l.track_length]));
}

export function sessionsCsv() {
  const laps = db.listLaps();
  const by = new Map();
  for (const l of laps) {
    if (l.session_id == null) continue;
    const s = by.get(l.session_id) || { laps: 0, valid: 0, best: null };
    s.laps++;
    if (l.valid) { s.valid++; if (s.best == null || l.lap_time_ms < s.best) s.best = l.lap_time_ms; }
    by.set(l.session_id, s);
  }
  const sessions = db.listSessions().slice().sort((a, b) => a.started_at - b.started_at);
  return csv(['session_id', 'started_at', 'track', 'layout', 'car', 'session_type', 'driver', 'laps', 'valid_laps', 'best_lap', 'best_lap_ms'],
    sessions.map((s) => { const x = by.get(s.id) || {}; return [s.id, iso(s.started_at), s.track, s.layout, s.car, s.session_type, s.driver, x.laps || 0, x.valid || 0, lapTime(x.best), x.best]; }));
}
