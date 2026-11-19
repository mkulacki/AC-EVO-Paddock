// Cars tab: every car in AC EVO (from the game's own files), with what you did with each one, and a page per car
// with its specs and your statistics: distance, time, records per track, top speed, driving style, milestones.
// Server side: src/carstats.js.
import { $, esc, api, fmt, prettyName } from './util.js';
import { thumbUrl, specTiles, badges, sourceOf, SOURCES, hpPerTon } from './garage.js';

const LS = 'cars.filters';
const n0 = (v) => (v == null ? '–' : Math.round(v).toLocaleString('en-US'));
const kmTxt = (km) => (km >= 100 ? n0(km) : (km ?? 0).toFixed(1));
const hours = (ms) => { const m = Math.round((ms || 0) / 60000); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`; };
const date = (t) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const ago = (t) => { const d = Math.round((Date.now() - t) / 86400e3); return d <= 0 ? 'today' : d === 1 ? 'yesterday' : d < 30 ? `${d} days ago` : date(t); };
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const carUrl = (id) => `#/car?id=${encodeURIComponent(id)}`;

// ------------------------------------------------------------------ list
export async function viewCars(view) {
  const { cars, unknown, drivenCount } = await api('/api/cars/stats');
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(LS) || '{}'); } catch { /* defaults */ }
  const f = { q: '', srcs: new Set(saved.srcs || []), cats: new Set(saved.cats || []), driven: !!saved.driven, sort: saved.sort || 'km' };
  const persist = () => { try { localStorage.setItem(LS, JSON.stringify({ srcs: [...f.srcs], cats: [...f.cats], driven: f.driven, sort: f.sort })); } catch { /* not remembered */ } };
  const CATS = ['Road', 'Track', 'Tuned', 'Race', 'Formula'].filter((c) => cars.some((x) => x.categories?.includes(c)));
  const totalKm = cars.reduce((s, c) => s + (c.mine?.km || 0), 0) + unknown.reduce((s, c) => s + c.km, 0);
  const totalMs = cars.reduce((s, c) => s + (c.mine?.drivingMs || 0), 0) + unknown.reduce((s, c) => s + c.drivingMs, 0);

  view.innerHTML = `<div class="race-head"><div><h1>Cars</h1><div class="sub">${cars.length} cars from AC EVO's own files. You have driven ${plural(drivenCount, 'car')}: ${kmTxt(totalKm)} km in ${hours(totalMs)}.</div></div></div>
    <div class="card cars-filters"><div class="row" style="flex-wrap:wrap">
      <input id="cq" placeholder="Search brand, model or class" style="width:240px">
      <div class="pills" id="cSrc">${SOURCES.map((v) => `<button class="pill ${f.srcs.has(v) ? 'on' : ''}" data-k="srcs" data-v="${esc(v)}">${esc(v)}</button>`).join('')}</div>
      <div class="pills" id="cCat">${CATS.map((v) => `<button class="pill ${f.cats.has(v) ? 'on' : ''}" data-k="cats" data-v="${esc(v)}">${esc(v)}</button>`).join('')}</div>
      <span class="spacer"></span>
      <label class="row" style="gap:6px"><input type="checkbox" id="cDriven" ${f.driven ? 'checked' : ''}> Only cars I've driven</label>
      <select id="cSort" title="Sort">${[['km', 'Most driven'], ['recent', 'Recently driven'], ['name', 'Name'], ['power', 'Power'], ['pw', 'Power / weight']].map(([k, l]) => `<option value="${k}" ${f.sort === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
    </div></div>
    <div class="cars-grid" id="cGrid"></div>
    ${unknown.length ? `<div class="card"><h2>Other cars you drove</h2><p class="muted" style="margin-top:0">Recorded under a name that is not in the game's car list (an old or removed mod, for example).</p>
      <table><thead><tr><th>Car</th><th>Distance</th><th>Laps</th><th>Last driven</th></tr></thead><tbody>${unknown.map((u) => `<tr><td>${esc(prettyName(u.name))}</td><td>${kmTxt(u.km)} km</td><td>${u.laps}</td><td class="muted">${esc(ago(u.lastAt))}</td></tr>`).join('')}</tbody></table></div>` : ''}`;

  const s0 = (c) => c.variants[0]?.stats || {};
  function render() {
    const q = f.q.trim().toLowerCase();
    const list = cars.filter((c) => {
      if (q && !`${c.brand} ${c.name} ${c.variants.map((v) => `${v.name} ${v.trim} ${v.raceClass || ''}`).join(' ')}`.toLowerCase().includes(q)) return false;
      if (f.srcs.size && !f.srcs.has(sourceOf(c))) return false;
      if (f.cats.size && !c.categories?.some((x) => f.cats.has(x))) return false;
      if (f.driven && !c.mine) return false;
      return true;
    }).sort({
      km: (a, b) => (b.mine?.km || 0) - (a.mine?.km || 0) || `${a.brand} ${a.name}`.localeCompare(`${b.brand} ${b.name}`),
      recent: (a, b) => (b.mine?.lastAt || 0) - (a.mine?.lastAt || 0) || `${a.brand} ${a.name}`.localeCompare(`${b.brand} ${b.name}`),
      name: (a, b) => `${a.brand} ${a.name}`.localeCompare(`${b.brand} ${b.name}`),
      power: (a, b) => (s0(b).powerHp || 0) - (s0(a).powerHp || 0),
      pw: (a, b) => (hpPerTon(s0(b)) || 0) - (hpPerTon(s0(a)) || 0),
    }[f.sort]);
    $('#cGrid').innerHTML = list.map((c) => {
      const s = s0(c), m = c.mine;
      return `<a class="car-card" href="${carUrl(c.id)}">
        <div class="img"><img loading="lazy" alt="" src="${thumbUrl(c.id)}"><div class="cat">${badges(c, c.variants[0])}</div>${m?.rank === 1 ? '<span class="pb" title="Your most driven car">Most driven</span>' : ''}</div>
        <div class="body"><span class="eyebrow">${esc(c.brand)}</span><span class="name">${esc(c.name)}</span>
          <div class="line"><span><b>${n0(s.powerHp)}</b> hp</span><span><b>${n0(s.weightKg)}</b> kg</span><span>${esc(c.drivetrain || '–')}</span></div>
          ${m ? `<div class="car-mine"><span><b>${kmTxt(m.km)}</b> km</span><span><b>${m.laps}</b> lap${m.laps === 1 ? '' : 's'}</span><span>${plural(m.tracks, 'track')}</span><span class="muted">${esc(ago(m.lastAt))}</span></div>`
            : '<div class="car-mine muted">Not driven yet</div>'}
        </div></a>`;
    }).join('') || '<div class="card muted">No car matches.</div>';
  }
  $('#cq').oninput = (e) => { f.q = e.target.value; render(); };
  view.querySelectorAll('[data-k]').forEach((b) => { b.onclick = () => { const s = f[b.dataset.k]; s.has(b.dataset.v) ? s.delete(b.dataset.v) : s.add(b.dataset.v); b.classList.toggle('on'); persist(); render(); }; });
  $('#cDriven').onchange = (e) => { f.driven = e.target.checked; persist(); render(); };
  $('#cSort').onchange = (e) => { f.sort = e.target.value; persist(); render(); };
  render();
}

// ------------------------------------------------------------------ one car
export async function viewCar(view, params) {
  const id = params.get('id');
  const d = await api(`/api/cars/detail?car=${encodeURIComponent(id)}`);
  const c = d.car, v = c.variants[0], m = d.mine;
  const tile = (k, val, sub = '', href = null) => `<${href ? `a href="${href}"` : 'div'} class="card stat"><span class="k">${k}</span><span class="v">${val}</span>${sub ? `<span class="muted s">${sub}</span>` : ''}</${href ? 'a' : 'div'}>`;
  const bar = (label, pct, tip, max = 100) => `<div class="style-row" title="${esc(tip)}"><span>${esc(label)}</span><div class="style-bar"><i style="width:${Math.max(0, Math.min(100, (100 * (pct || 0)) / max))}%"></i></div><b>${pct == null ? '–' : `${pct}%`}</b></div>`;
  const trackLink = (r) => (r.trackId ? `#/track?id=${encodeURIComponent(r.trackId)}&layout=${encodeURIComponent(r.layoutKey || '')}` : null);

  const head = `<div class="row" style="margin-bottom:12px"><a href="#/cars"><button class="ghost">All cars</button></a><span class="spacer"></span>
      <a href="#/setups?car=${encodeURIComponent(c.id)}"><button>Setups${d.setups ? ` (${d.setups})` : ''}</button></a>
      <a href="#/race?car=${encodeURIComponent(c.id)}"><button class="primary">Drive it ▸</button></a></div>
    <div class="car-hero">
      <div class="pick"><div class="pick-media"><img alt="" src="${thumbUrl(c.id, v?.mech)}"><div class="shade"></div>
        <div class="over"><span class="eyebrow">${esc(c.brand)}</span><div class="title">${esc(c.name)}</div><div class="badges">${badges(c, v)}${c.variants.length > 1 ? `<span class="badge">${c.variants.length} versions</span>` : ''}</div></div></div>
        <div class="pick-body">${specTiles(c, v)}${c.description ? `<p class="muted" style="margin:0;font-size:13px">${esc(c.description)}</p>` : ''}</div></div>
      <div class="car-side">${m ? funCard(m, d) : `<div class="card"><h2>Not driven yet</h2><p class="muted">Take it out once and this page fills up with your distance, records per track, top speed, driving style and milestones.</p>
        <a href="#/race?car=${encodeURIComponent(c.id)}"><button class="primary">Drive it ▸</button></a></div>`}</div>
    </div>`;
  if (!m) { view.innerHTML = head; return; }

  const tiles = `<div class="home-tiles">
    ${tile('Distance', `${kmTxt(m.km)}<small> km</small>`, `#${m.rank} of ${plural(d.drivenCars, 'car')} you drove`)}
    ${tile('Time driving', hours(m.drivingMs), `over ${plural(m.days, 'day')}`)}
    ${tile('Laps', `${m.validLaps}<small> / ${m.laps}</small>`, `${m.cleanPct}% clean`)}
    ${tile('Sessions', m.sessions, `${plural(m.tracks, 'track')}`)}
    ${tile('Top speed', m.topSpeed ? `${Math.round(m.topSpeed.kmh)}<small> km/h</small>` : '–', m.topSpeed ? `${esc(prettyName(m.topSpeed.track))} ${esc(m.topSpeed.layout || '')}` : '')}
    ${tile('Personal bests', m.pbs, 'times you beat your own best lap')}</div>`;

  const style = m.style.laps ? `<div class="card"><h2>How you drive it</h2>
      <p class="muted" style="margin-top:0;font-size:12.5px">Share of lap time, averaged over your ${plural(m.style.laps, 'clean lap')} with this car.</p>
      ${bar('On the throttle (average)', m.style.thrAvg, 'average throttle position over the lap')}
      ${bar('Flat out', m.style.fullThr, 'time at full throttle')}
      ${bar('Braking', m.style.brake, 'time on the brakes')}
      ${bar('Coasting', m.style.coast, 'time off both pedals while moving')}
      ${bar('Wheels off the track', m.style.offPct, 'time with wheels outside the track limits')}
      <div class="style-row"><span>Gear changes</span><span class="muted" style="flex:1">per km</span><b>${m.style.shiftsPerKm ?? '–'}</b></div></div>` : '';

  const records = `<div class="card"><h2>Your records with it</h2><div class="tablewrap"><table><thead><tr><th>Track</th><th>Best lap</th><th>Laps</th><th>Distance</th><th title="Times you beat your own best lap here">PBs</th><th>Last driven</th><th></th></tr></thead><tbody>
    ${m.records.map((r) => `<tr><td>${trackLink(r) ? `<a href="${trackLink(r)}">` : ''}<b>${esc(prettyName(r.track))}</b> <span class="muted">${esc(r.layout || '')}</span>${trackLink(r) ? '</a>' : ''}</td>
      <td>${r.bestMs ? `<b class="best">${fmt(r.bestMs)}</b>` : '<span class="muted">no clean lap</span>'}</td><td>${r.validLaps}<span class="muted"> / ${r.laps}</span></td><td>${kmTxt(r.km)} km</td>
      <td>${r.pbs}</td><td class="muted">${esc(ago(r.lastAt))}</td>
      <td style="white-space:nowrap">${r.bestLapId ? `<a href="#/compare?laps=${r.bestLapId}&ref=ideal">Best lap ›</a>` : ''}</td></tr>`).join('')}</tbody></table></div></div>`;

  view.innerHTML = `${head}${tiles}${records}${style}`;
}

// distance compared with real trips, milestones and other fun facts
function funCard(m, d) {
  const next = m.milestones.find((x) => !x.done);
  return `<div class="card"><h2>Fun facts</h2>
    ${m.trip ? `<p class="car-trip">That's <b>${esc(m.trip.label)}</b>${m.trip.times > 1 ? ` <b>${m.trip.times}×</b> over` : ''}.${m.nextTrip ? ` <span class="muted">${kmTxt(m.nextTrip.left)} km more for ${esc(m.nextTrip.label)}.</span>` : ''}</p>`
      : m.nextTrip ? `<p class="car-trip">${kmTxt(m.nextTrip.left)} km to go for <b>${esc(m.nextTrip.label)}</b>.</p>` : ''}
    <div class="milestones">${m.milestones.map((x) => `<span class="ms ${x.done ? 'done' : ''}" title="${x.done ? 'reached' : 'not yet'}">${n0(x.km)} km</span>`).join('')}</div>
    ${next ? `<div class="ms-next"><div class="style-bar"><i style="width:${Math.min(100, (100 * m.km) / next.km)}%"></i></div><span class="muted s">${kmTxt(m.km)} of ${n0(next.km)} km</span></div>` : ''}
    <table class="kv" style="margin-top:12px"><tbody>
      ${m.favourite ? `<tr><td>Favourite track</td><td>${esc(prettyName(m.favourite.track))} ${esc(m.favourite.layout || '')} <span class="muted">(${plural(m.favourite.laps, 'lap')})</span></td></tr>` : ''}
      ${m.busiestDay ? `<tr><td>Busiest day</td><td>${esc(date(new Date(`${m.busiestDay.day}T12:00:00`).getTime()))} <span class="muted">(${kmTxt(m.busiestDay.km)} km)</span></td></tr>` : ''}
      ${m.longestSession ? `<tr><td>Longest session</td><td>${plural(m.longestSession.laps, 'lap')} <span class="muted">(${hours(m.longestSession.ms)})</span></td></tr>` : ''}
      <tr><td>Garage rank</td><td>#${m.rank} of ${plural(d.drivenCars, 'car')} you drove, by distance</td></tr>
      <tr><td>First driven</td><td>${esc(date(m.firstAt))}</td></tr>
      <tr><td>Setups</td><td>${d.setups ? `<a href="#/setups?car=${encodeURIComponent(d.car.id)}">${plural(d.setups, 'saved setup')}</a>` : '<span class="muted">none saved yet</span>'}</td></tr>
    </tbody></table></div>`;
}
