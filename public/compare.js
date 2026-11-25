// Compare page (#/compare): laps against a reference (public/telemetry.js) and the racing line replay. Split from app.js.
import { $, esc, fmt, prettyName } from './util.js';
import { mountReplay } from './replay.js';
import { mountTelemetry, getCompare, compatHtml, compatKey, compatAccepted, acceptCompat } from './telemetry.js';

// ================================================================== COMPARE: laps against a reference (public/telemetry.js) and the racing line replay
export async function viewCompare(view, params, cleanup, { hasKey }) {
  const lapIds = (params.get('laps') || '').split(',').map(Number).filter(Boolean);
  const ref = params.get('ref') || 'best';
  const tab = params.get('tab') === 'line' ? 'line' : 'charts';
  view.innerHTML = '<div class="card"><span class="spinner"></span> Loading telemetry…</div>';
  const data = await getCompare(lapIds, ref);
  const lap0 = data.laps[0]?.meta ?? data.ref.meta;
  const back = lap0?.session_id ? `#/report?session=${lap0.session_id}` : '#/';
  const url = (s, t = tab) => `#/compare?laps=${s.laps.join(',')}&ref=${s.ref}${s.corner ? `&c=${encodeURIComponent(s.corner)}` : ''}${t === 'line' ? '&tab=line' : ''}`;
  let st = { laps: lapIds, ref, corner: params.get('c') };
  view.innerHTML = `
    <div class="cmp-head">
      <a href="${back}"><button class="ghost">← ${lap0?.session_id ? 'Session' : 'Sessions'}</button></a>
      <div><h1>${esc(prettyName(data.combo.track))} <span class="muted">${esc(prettyName(data.combo.layout))}</span></h1>
        <div class="secondary">${esc(prettyName(data.combo.car))} · best lap ${fmt(data.bestMs)}, ideal lap ${fmt(data.idealMs)}</div></div>
    </div>
    <div class="tabs"><a href="#" data-tab="charts" class="${tab === 'charts' ? 'on' : ''}">Telemetry</a><a href="#" data-tab="line" class="${tab === 'line' ? 'on' : ''}">Racing line replay</a></div>
    <div id="tabBody"></div>`;
  view.querySelectorAll('[data-tab]').forEach((a) => a.onclick = (e) => { e.preventDefault(); location.hash = url(st, a.dataset.tab); });
  if (tab === 'line') {
    // the same caveats and the same "Compare anyway" gate as the Telemetry tab (PL4.2)
    const key = compatKey(lapIds, ref);
    const lapTxt = (id) => { const m = data.laps.find((l) => l.id === id)?.meta; return m ? `Lap ${m.lap_number ?? '?'} · ${fmt(m.lap_time_ms)}` : `Lap #${id}`; };
    const drawLine = () => {
      const gated = data.compat?.level === 'incompatible' && !compatAccepted(key);
      $('#tabBody').innerHTML = `${compatHtml(data, lapTxt, gated)}${gated ? '' : '<div id="rpBody"></div>'}`;
      if (gated) { $('#tabBody [data-force]').onclick = () => { acceptCompat(key); drawLine(); }; return; }
      mountReplay($('#rpBody'), data, cleanup, { at: params.has('at') ? +params.get('at') : null,
        mode: params.get('mode'), inputs: params.has('inputs') ? params.get('inputs') === '1' : null });
    };
    drawLine();
    return;
  }
  await mountTelemetry($('#tabBody'), { ...st, hasKey: hasKey, onState: (s) => { st = s; history.replaceState(null, '', url(s)); } }, cleanup);
}
