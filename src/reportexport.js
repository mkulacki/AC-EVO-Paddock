// PL11: a session report as one self-contained HTML file the driver can keep or send (Sessions → report → Save as HTML).
// Offline by construction: inline CSS and SVG only, no scripts, no fonts, images or links that load anything, and a
// Content-Security-Policy that blocks any request should a viewer try. Private by default: no driver name, no Steam
// identity, no session notes and no AI debrief unless the driver ticks them; never a key, token, password or folder.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (ms) => (ms == null || !Number.isFinite(ms) ? '–' : `${Math.floor(ms / 60000)}:${((ms % 60000) / 1000).toFixed(3).padStart(6, '0')}`);
const sgn = (ms, d = 3) => (ms == null || !Number.isFinite(ms) ? '–' : `${ms > 0 ? '+' : ms < 0 ? '−' : '±'}${(Math.abs(ms) / 1000).toFixed(d)} s`);
const day = (t) => (t ? new Date(t).toISOString().replace('T', ' ').slice(0, 16) : '–');
const SESSION_TYPES = { 0: 'Practice', 1: 'Qualifying', 2: 'Race', 3: 'Hotlap' };
const num = (v) => (Number.isFinite(v) ? v : null);

export const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";

/** Lap-time bars as inline SVG (valid laps in the accent colour, invalid ones grey). */
function lapChart(trend) {
  const laps = (trend || []).filter((l) => num(l.ms) != null);
  if (laps.length < 2) return '';
  const W = 640, H = 160, P = 28, bw = Math.max(3, Math.min(28, (W - P * 2) / laps.length - 3));
  const vals = laps.map((l) => l.ms), lo = Math.min(...vals), hi = Math.max(...vals);
  const span = Math.max(500, hi - lo);
  const y = (ms) => H - P - ((ms - lo) / span) * (H - P * 2) * 0.9 - 6;
  const bars = laps.map((l, i) => {
    const x = P + i * ((W - P * 2) / laps.length), top = y(l.ms);
    return `<rect x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${(H - P - top).toFixed(1)}" class="${l.valid ? 'v' : 'i'}"><title>Lap ${esc(l.n)}: ${fmt(l.ms)}${l.valid ? '' : ' (invalid)'}</title></rect>`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Lap times of this session" class="chart">
    <line x1="${P}" y1="${H - P}" x2="${W - P}" y2="${H - P}" class="axis"/>
    <text x="${P}" y="14" class="lbl">slowest ${fmt(hi)}</text><text x="${W - P}" y="14" class="lbl" text-anchor="end">fastest ${fmt(lo)}</text>${bars}</svg>`;
}

/**
 * The HTML. rep = the stored report {createdAt, data, ai}; laps = the session's laps (db rows); opts:
 * {identity: {driver, steam: {steamId, name}} | null, notes: {text, tags} | null, ai: boolean, appVersion}
 */
export function render(rep, laps, opts = {}) {
  const r = rep.data, c = r.combo || {};
  const pretty = (s) => String(s || '?').replace(/_/g, ' '); // as the app shows names (public/util.js prettyName)
  const track = pretty(c.track), car = pretty(c.car);
  const title = `${track}${c.layout ? ` (${c.layout})` : ''} · ${car}`;
  const imp = r.improvement || {};
  const best = r.best?.ms;
  const id = opts.identity;
  const kv = (k, v) => `<div class="kv"><span>${esc(k)}</span><b>${v}</b></div>`;
  const stats = [
    kv('Best lap', `${fmt(best)}${r.best?.lapNumber != null ? ` <small>lap ${esc(r.best.lapNumber)}</small>` : ''}`),
    kv('Clean average', fmt(r.average?.cleanMs)),
    kv('Laps', `${esc(r.laps?.total)} <small>${esc(r.laps?.valid)} valid</small>`),
    r.consistency?.score != null ? kv('Consistency', `${esc(r.consistency.score)} <small>±${((r.consistency.sdMs ?? 0) / 1000).toFixed(2)} s</small>`) : '',
    r.theoretical ? kv('Theoretical best', `${fmt(r.theoretical.ms)} <small>${((r.theoretical.gapMs ?? 0) / 1000).toFixed(3)} s to find</small>`) : '',
    imp.bestDeltaMs != null ? kv('vs previous session', sgn(imp.bestDeltaMs)) : '',
    imp.newPb ? kv('Personal best', `new <small>${sgn(imp.pbDeltaMs)}</small>`) : imp.allTimeBeforeMs != null ? kv('Personal best', fmt(imp.allTimeBeforeMs)) : '',
  ].join('');
  const lapRows = laps.map((l) => `<tr class="${l.valid ? '' : 'inv'}"><td>${esc(l.lap_number)}</td><td class="n">${fmt(l.lap_time_ms)}</td>
    <td class="n">${l.valid && best != null ? sgn(l.lap_time_ms - best) : '–'}</td><td>${l.valid ? 'valid' : 'invalid'}</td><td>${esc(l.setup_name ?? '')}</td></tr>`).join('');
  const corners = r.corners?.all || [];
  const weak = new Set((r.corners?.weakest || []).map((w) => w.name)), strong = new Set(r.corners?.best || []);
  const cornerRows = corners.map((k) => `<tr><td>${esc(k.name)}${weak.has(k.name) ? ' <span class="tag w">weakest</span>' : strong.has(k.name) ? ' <span class="tag s">best</span>' : ''}</td>
    <td class="n">${k.medianMs != null ? (k.medianMs / 1000).toFixed(3) : '–'}</td><td class="n">${k.sessionBestMs != null && Number.isFinite(k.sessionBestMs) ? (k.sessionBestMs / 1000).toFixed(3) : '–'}</td>
    <td class="n">${k.bestEverMs != null ? (k.bestEverMs / 1000).toFixed(3) : '–'}</td><td class="n">${k.gapMs != null ? sgn(k.gapMs) : '–'}</td></tr>`).join('');
  const weakest = (r.corners?.weakest || []).map((w) => `<li><b>${esc(w.name)}</b> ${sgn(w.gapMs)} against your best pass${w.reasons?.length ? `: ${esc(w.reasons.join('; '))}` : ''}${w.target ? `<br><small>Try: ${esc(w.target)}</small>` : ''}</li>`).join('');
  const targets = (r.targets || []).map((t) => `<li>${esc(t.text)}</li>`).join('');
  const prev = r.prevTargets?.items?.length ? r.prevTargets.items.map((t) => `<li>${t.met === true ? '✓' : t.met === false ? '✗' : '·'} ${esc(t.text)} <small>${esc(t.actual)}</small></li>`).join('') : '';
  const cond = r.conditions || {};
  const tC = (x) => (x && Number.isFinite(x.avg) ? `${x.avg} °C (${x.min}–${x.max})` : null);
  const condText = [tC(cond.airC) && `air ${tC(cond.airC)}`, tC(cond.roadC) && `track ${tC(cond.roadC)}`].filter(Boolean).join(' · ');
  const limits = (r.trackLimits?.byCorner || []).map((x) => `${esc(x.name)} ×${esc(x.n)}`).join(', ');
  const setups = (r.setups || []).map((s) => `${esc(s.name ?? 'Standard')} <small>(laps ${esc(s.laps?.[0])}–${esc(s.laps?.[s.laps.length - 1])}${s.bestMs != null ? `, best ${fmt(s.bestMs)}` : ''})</small>`).join('<br>');
  const who = id ? [id.driver ? esc(id.driver) : null, id.steam?.name ? `Steam: ${esc(id.steam.name)}${id.steam.steamId ? ` (${esc(id.steam.steamId)})` : ''}` : null].filter(Boolean).join(' · ') : '';
  const notes = opts.notes && (opts.notes.text || opts.notes.tags?.length)
    ? `<section><h2>Notes</h2>${opts.notes.tags?.length ? `<p>${opts.notes.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join(' ')}</p>` : ''}${opts.notes.text ? `<p class="pre">${esc(opts.notes.text)}</p>` : ''}</section>` : '';
  const ai = opts.ai && rep.ai?.text ? `<section><h2>AI debrief</h2><p class="pre">${esc(rep.ai.text)}</p><p><small>${esc(rep.ai.model || '')}${rep.ai.at ? `, ${day(rep.ai.at)}` : ''}. AI text: check it against the numbers above.</small></p></section>` : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Session report: ${esc(title)}</title>
<style>
:root { --bg: #fff; --fg: #15171a; --mute: #5c6370; --line: #e3e5e8; --acc: #5b8c00; --bad: #c0392b; --card: #f6f7f8; }
@media (prefers-color-scheme: dark) { :root { --bg: #0d0f12; --fg: #e8eaed; --mute: #9aa0a6; --line: #2a2e35; --acc: #b5e61d; --bad: #ff6b6b; --card: #161a1f; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.45 system-ui, "Segoe UI", sans-serif; }
main { max-width: 900px; margin: 0 auto; padding: 24px 16px 40px; }
h1 { font-size: 24px; margin: 0 0 4px; } h2 { font-size: 17px; margin: 28px 0 8px; border-bottom: 1px solid var(--line); padding-bottom: 4px; }
small, .mute { color: var(--mute); }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; margin: 16px 0; }
.kv { background: var(--card); border-radius: 8px; padding: 8px 10px; display: flex; flex-direction: column; }
.kv span { color: var(--mute); font-size: 12px; } .kv b { font-size: 18px; font-variant-numeric: tabular-nums; }
.tw { overflow-x: auto; } table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--line); white-space: nowrap; } td.n, th.n { text-align: right; }
tr.inv td { color: var(--mute); }
.tag { font-size: 11px; border-radius: 4px; padding: 1px 5px; background: var(--card); border: 1px solid var(--line); }
.tag.w { color: var(--bad); } .tag.s { color: var(--acc); }
.chart { width: 100%; height: auto; } .chart rect.v { fill: var(--acc); } .chart rect.i { fill: var(--mute); opacity: .5; }
.chart .axis { stroke: var(--line); } .chart .lbl { fill: var(--mute); font-size: 11px; }
.pre { white-space: pre-wrap; } footer { margin-top: 32px; font-size: 12px; color: var(--mute); }
@media print { body { background: #fff; color: #000; } .kv { border: 1px solid #ccc; } }
</style></head>
<body><main>
<p class="mute">Session report${r.sessionType != null && SESSION_TYPES[r.sessionType] ? ` · ${SESSION_TYPES[r.sessionType]}` : ''} · ${day(r.startedAt)}${who ? ` · ${who}` : ''}</p>
<h1>${esc(title)}</h1>
<div class="grid">${stats}</div>
${lapChart(r.trend)}
<h2>Laps</h2>
<div class="tw"><table><thead><tr><th>Lap</th><th class="n">Time</th><th class="n">To best</th><th>Valid</th><th>Setup</th></tr></thead><tbody>${lapRows}</tbody></table></div>
${corners.length ? `<h2>Corners</h2><p><small>Typical = the median time through the corner in this session; best ever = your best pass on this car and track up to this session.</small></p>
<div class="tw"><table><thead><tr><th>Corner</th><th class="n">Typical (s)</th><th class="n">Session best</th><th class="n">Best ever</th><th class="n">Typical to best ever</th></tr></thead><tbody>${cornerRows}</tbody></table></div>` : ''}
${weakest ? `<h2>Where the time goes</h2><ul>${weakest}</ul>` : ''}
${targets ? `<h2>Next practice targets</h2><ul>${targets}</ul>` : ''}
${prev ? `<h2>Last session's targets</h2><ul>${prev}</ul>` : ''}
${setups || condText || limits ? `<h2>Setup and conditions</h2>${setups ? `<p>${setups}</p>` : ''}${condText ? `<p>Conditions: ${condText}</p>` : ''}${limits ? `<p>Invalid laps by corner: ${limits}</p>` : ''}` : ''}
${notes}${ai}
<footer>Made with AC EVO Paddock${opts.appVersion ? ` ${esc(opts.appVersion)}` : ''} on ${day(Date.now())} from laps recorded on the driver's PC. A self-contained file: no scripts, nothing is loaded from the internet.
Lap times are the game's; corner times and targets are Paddock's own analysis. Unofficial, not affiliated with Kunos Simulazioni or 505 Games.</footer>
</main></body></html>
`;
}

/** A file name for the download: paddock-report-<track>-<car>-<date>.html (ASCII only). */
export function fileName(r) {
  const part = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'x';
  return `paddock-report-${part(r.combo?.track)}-${part(r.combo?.car)}-${new Date(r.startedAt ?? Date.now()).toISOString().slice(0, 10)}.html`;
}
