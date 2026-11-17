// Car & setup tab of the session page: what the car did (tyres, brakes, suspension, balance, wheelspin) and setup
// suggestions, from src/carreport.js.
import { esc, api, fmt, prov } from './util.js';

const WHEELS = ['FL', 'FR', 'RL', 'RR'];
const AREA_ORDER = ['Balance', 'Tyres', 'Brakes', 'Suspension', 'Traction'];
const t = (v, u = '°C') => (v == null ? '–' : `${Math.round(v)}${u === '°C' ? ' °C' : u}`);
const pct = (v) => (v == null || !(v > 0) ? null : `${Math.round(v * 100)} %`);

// colour of a tread temperature against the average of all four tyres: blue = colder, red = hotter
function heat(v, avg) {
  if (v == null || avg == null) return 'var(--surface-3)';
  const d = Math.max(-1, Math.min(1, (v - avg) / 12));
  return d >= 0 ? `color-mix(in srgb, var(--slower) ${Math.round(15 + 70 * d)}%, var(--surface-1))`
    : `color-mix(in srgb, var(--faster) ${Math.round(15 + 70 * -d)}%, var(--surface-1))`;
}

export async function mountCarSetup(box, sessionId) {
  box.innerHTML = '<div class="card"><span class="spinner"></span> Reading the car data…</div>';
  let r;
  try { r = await api(`/api/carreport?session=${sessionId}`); } catch (e) { box.innerHTML = `<div class="card error">${esc(e.message)}</div>`; return; }
  if (!r.available) {
    box.innerHTML = `<div class="card empty"><h2>No car data for this session</h2>
      <p>Paddock records tyre temperatures and pressures, brakes, suspension travel and balance with every lap since this version. Sessions driven before that have none.</p>
      <p class="muted">Drive a few laps and open the session again.</p></div>`;
    return;
  }
  const T = r.tyres, B = r.brakes, S = r.suspension;
  const allTread = T.flatMap((x) => [x.inner, x.middle, x.outer]).filter((v) => v != null);
  const avg = allTread.length ? allTread.reduce((a, b) => a + b, 0) / allTread.length : null;

  // one tyre: the tread (outer edge on the outside of the car), core, pressure, brake
  const tyre = (w) => {
    const x = T[w], b = B[w], s = S[w], left = w % 2 === 0;
    const cells = [['Inner', x.inner], ['Middle', x.middle], ['Outer', x.outer]];
    const tread = (left ? [...cells].reverse() : cells).map(([k, v]) => `<div class="cell" style="background:${heat(v, avg)}" title="${k} edge">${t(v, '')}</div>`).join('');
    return `<div class="tyre">
      <div class="row"><b>${WHEELS[w]}</b><span class="spacer"></span><span class="hint">${left ? 'outer · middle · inner' : 'inner · middle · outer'}</span></div>
      ${r.has.tyres ? `<div class="tread">${tread}</div>` : '<div class="hint">tread temperatures not available</div>'}
      <dl>
        <dt>Core</dt><dd>${t(x.core)}${pct(x.windowCore) ? ` <span class="hint" title="Where the game puts it in its optimal window (to be confirmed in game)">${pct(x.windowCore)}</span>` : ''}</dd>
        <dt>Hot pressure</dt><dd>${x.pressure != null ? `${x.pressure.toFixed(1)} psi` : '–'}${pct(x.windowPressure) ? ` <span class="hint" title="Where the game puts it in its target window (to be confirmed in game)">${pct(x.windowPressure)}</span>` : ''}</dd>
        <dt>Camber hint</dt><dd>${x.spread == null ? '–' : `inner ${x.spread >= 0 ? '+' : ''}${x.spread} °C vs outer`}</dd>
        <dt>Brake peak</dt><dd>${t(b.peak)}${b.locks ? ` · <span class="pos">${b.locks} lock-up${b.locks === 1 ? '' : 's'}</span>` : ''}</dd>
        <dt>Suspension</dt><dd>${r.has.susp ? `${s.min}–${s.max} mm${s.hitsPerLap >= 1 ? ` · <span class="pos" title="Times a lap it reached the end of its travel">end of travel ${s.hitsPerLap}×/lap</span>` : ''}` : '–'}</dd>
      </dl></div>`;
  };

  // provenance per section (src/channels.js): unconfirmed readings are labelled, and their conclusions kept apart
  const P = r.provenance || {};
  const slipOk = P.slip === 'verified';
  const anyUnconfirmed = Object.values(P).some((s) => s === 'unverified' || s === 'mismatch');
  // balance: a centred bar per corner phase, understeer to the right
  const bal = (ph, label) => {
    const p = r.balance?.[ph];
    if (!p || p.value == null) return `<div class="bal"><span>${label}</span><div class="hint">no data</div></div>`;
    const v = Math.max(-0.35, Math.min(0.35, p.value)) / 0.35 * 50;
    return `<div class="bal"><span>${label}</span>
      <div class="balbar${slipOk ? '' : ' unconf'}"><i class="mid"></i><i class="fill ${p.value > 0 ? 'us' : 'os'}" style="left:${v >= 0 ? 50 : 50 + v}%;width:${Math.abs(v)}%"></i></div>
      ${slipOk ? `<b class="${Math.abs(p.value) > 0.08 ? (p.value > 0 ? 'us-t' : 'os-t') : ''}">${esc(p.label)}</b>`
        : `<span class="bal-unc" title="From slip angles, which cannot be checked against the game">${esc(p.label)}</span>`}<span class="hint">${p.corners.length ? esc(p.corners.join(', ')) : ''}</span></div>`;
  };
  const sug = [...r.suggestions].sort((a, b) => b.level - a.level || AREA_ORDER.indexOf(a.area) - AREA_ORDER.indexOf(b.area));
  const firm = sug.filter((s) => s.confirmed !== false), weak = sug.filter((s) => s.confirmed === false);
  const sugList = (list, cls = '') => `<ol class="sugs ${cls}">${list.map((s) => `<li><span class="lvl l${s.level}" title="${['', 'worth a look', 'worth trying', 'important'][s.level]}"></span><span class="tag">${esc(s.area.toUpperCase())}</span>
        <div><b>${esc(s.text)}</b><div class="hint">${esc(s.why)}</div></div></li>`).join('')}</ol>`;
  const setupLink = r.links?.car ? `#/setups?car=${encodeURIComponent(r.links.car)}${r.links.track ? `&track=${encodeURIComponent(r.links.track)}${r.links.layout ? `&layout=${encodeURIComponent(r.links.layout)}` : ''}` : ''}` : '#/setups';

  box.innerHTML = `
    ${anyUnconfirmed ? `<div class="card plain note-warn">Readings marked ${prov('unverified')} come from the game's shared memory but have not been checked against what the game shows.
      Paddock keeps the hints based on them apart and does not present them as facts. Check them in <a href="#/setups">Setups → Setup recognition</a>.
      Slip angles (balance, wheelspin) cannot be checked: the game does not show them.</div>` : ''}
    <div class="card">
      <div class="row" style="margin-bottom:6px"><h2 style="margin:0">Setup suggestions</h2><span class="spacer"></span>
        <a href="${setupLink}"><button title="The AI engineer in Setups now sees this data too">Ask the AI engineer ›</button></a></div>
      <div class="hint" style="margin-bottom:8px">From ${r.laps} lap${r.laps === 1 ? '' : 's'}${r.warmupSkipped ? ' (temperatures and pressures without the first, warm-up lap)' : ''}. Rules of thumb: a hint of where to look, not a verdict. Change one thing at a time and drive a few laps.</div>
      ${firm.length ? sugList(firm)
        : weak.length ? '<p class="muted" style="margin:0">No suggestion rests on readings checked against the game yet.</p>'
        : '<p class="neg" style="margin:0">Nothing stands out: tyres, brakes, suspension and balance look reasonable.</p>'}
      ${weak.length ? `<details class="unconfirmed-hints" ${firm.length ? '' : 'open'} style="margin-top:10px"><summary><b>Unconfirmed hints</b> ${prov('unverified')}
        <span class="hint">${weak.length} hint${weak.length === 1 ? '' : 's'} from readings not checked against the game</span></summary>${sugList(weak, 'unconfirmed')}</details>` : ''}
    </div>
    <div class="car-grid">
      <div class="card"><h2>Tyres, brakes and suspension</h2>
        <div class="row hint" style="margin:-6px 0 8px;gap:6px;flex-wrap:wrap">Tyres ${prov(P.tyres || 'unverified')} Brakes ${prov(P.brakes || 'unverified')} Suspension ${prov(P.suspension || 'unverified')}</div>
        <div class="hint" style="margin:-6px 0 10px">Tread colours: blue = colder, red = hotter than the average of all four tyres. Averages at speed.</div>
        <div class="car4">${tyre(0)}${tyre(1)}<div class="axle hint">front ▲</div>${tyre(2)}${tyre(3)}</div>
        ${r.rideHeightMin ? `<p class="hint" style="margin:10px 0 0">Lowest ride height: front ${r.rideHeightMin[0]} mm, rear ${r.rideHeightMin[1]} mm</p>` : ''}
      </div>
      <div>
        <div class="card"><h2>Balance${prov(P.slip || 'unverified', 'Balance is calculated from front and rear slip angles.')}</h2>
          <div class="hint" style="margin:-6px 0 10px">Front against rear slip angle while cornering. Right = understeer (the front slides), left = oversteer (the rear slides).</div>
          ${r.balance ? `${bal('entry', 'Entry')}${bal('mid', 'Mid-corner')}${bal('exit', 'Exit')}<div class="balscale hint"><span>◀ oversteer</span><span>understeer ▶</span></div>` : '<p class="hint">Slip angles are not available.</p>'}
        </div>
        <div class="card"><h2>Traction and braking</h2>
          <p style="margin:0 0 6px">${prov(P.slip || 'unverified', 'Wheelspin is calculated from rear slip ratios.')} Wheelspin on exits: <b>${r.traction ? pct(r.traction.share) || '0 %' : '–'}</b> of throttle time${r.traction?.corners.length ? ` <span class="hint">mostly ${esc(r.traction.corners.join(', '))}</span>` : ''}</p>
          <p style="margin:0">${prov(P.brakes || 'unverified')} Lock-ups: <b>${r.locks.length}</b>${r.locks.length ? ` <span class="hint">${esc(lockSummary(r.locks))}</span>` : ''}</p>
        </div>
      </div>
    </div>
    <details class="card"><summary><b>Lap by lap</b> <span class="hint">how the tyres and brakes came in</span></summary>
      <div class="tablewrap" style="margin-top:8px"><table>
        <thead><tr><th>Lap</th><th>Time</th>${WHEELS.map((w) => `<th>Core ${w}</th>`).join('')}${WHEELS.map((w) => `<th>psi ${w}</th>`).join('')}<th>Brake peak F / R</th></tr></thead>
        <tbody>${r.perLap.map((l) => `<tr><td>${l.lap ?? ''}</td><td class="${l.valid ? '' : 'muted'}">${fmt(l.timeMs)}</td>
          ${l.core.map((v) => `<td>${t(v, '')}</td>`).join('')}${l.pressure.map((v) => `<td>${v != null ? v.toFixed(1) : '–'}</td>`).join('')}
          <td>${t(Math.max(l.brakePeak[0] ?? 0, l.brakePeak[1] ?? 0), '')} / ${t(Math.max(l.brakePeak[2] ?? 0, l.brakePeak[3] ?? 0), '')}</td></tr>`).join('')}</tbody></table></div>
    </details>`;
}

function lockSummary(locks) {
  const by = new Map();
  for (const l of locks) { const k = `${l.wheel}${l.corner ? ` in ${l.corner}` : ''}`; by.set(k, (by.get(k) || 0) + 1); }
  return [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `${k} ×${n}`).join(', ');
}
