// Garage: a full-screen car picker (like a game's car selection) and a track picker. Cars, specs and
// pictures come from AC EVO's own files (/api/cars, /api/cars/thumb).
import { esc, fmt } from './util.js';

export const thumbUrl = (id, mech, visual) => `/api/cars/thumb?car=${encodeURIComponent(id)}${mech ? `&mech=${encodeURIComponent(mech)}` : ''}${visual ? `&visual=${encodeURIComponent(visual)}` : ''}`;
export const variantOf = (car, mech) => car?.variants?.find((v) => v.mech === mech) || car?.variants?.[0] || null;
export const prettyId = (s) => String(s ?? '').replace(/^preset_|^ks_/, '').replace(/_/g, ' ');
const SEARCH_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="7" cy="7" r="5"/><path d="M11 11l3.5 3.5" stroke-linecap="round"/></svg>';

export const hpPerTon = (s) => (s?.powerHp && s?.weightKg ? Math.round(s.powerHp / (s.weightKg / 1000)) : null);
const n0 = (v) => (v == null ? '–' : Math.round(v).toLocaleString('en-US'));

/** The spec tiles of a car variant. */
export function specTiles(car, v, { compact = false } = {}) {
  const s = v?.stats || {};
  const t = (k, val, unit, hi) => `<div class="spec${hi ? ' hi' : ''}" title="${k}"><div class="k">${k}</div><div class="v${/^[\d,.–]+$/.test(val) ? '' : ' txt'}">${val}${unit && val !== '–' ? `<small>${unit}</small>` : ''}</div></div>`;
  const tiles = [
    t('Power', n0(s.powerHp), 'hp', true),
    t('Torque', n0(s.torqueNm), 'Nm'),
    t('Weight', n0(s.weightKg), 'kg'),
    t('Power/weight', n0(hpPerTon(s)), 'hp/t'),
    t('0–100 km/h', s.zeroTo100 ? s.zeroTo100.toFixed(1) : '–', 's'),
    t('Top speed', n0(s.topSpeedKmh), 'km/h'),
    t('Drivetrain', esc(car.drivetrain || '–')),
    t('Gearbox', esc(car.transmission ? car.transmission.replace(' (paddles)', '') : '–') + (s.gears ? ` <small>${s.gears}-sp</small>` : '')),
  ];
  if (!compact) tiles.push(t('Engine', esc(car.engine || '–')), t('Redline', n0(s.redlineRpm), 'rpm'), t('Fuel tank', n0(s.fuelL), 'L'));
  return `<div class="specs">${tiles.join('')}</div>`;
}

/** "MOD" tag for a car or track installed as a mod (in Saved Games\ACE\mods), '' for Kunos content. */
export const modBadge = (x) => (x?.source === 'mod' ? `<span class="badge mod" title="Installed as a mod${x.mod ? ` (${esc(x.mod)})` : ''}">Mod</span>` : '');
/** Category of origin: "Kunos" for the game's own cars and tracks, "Mod" for mods. */
export const SOURCES = ['Kunos', 'Mod'];
export const sourceOf = (x) => (x?.source === 'mod' ? 'Mod' : 'Kunos');
export const sourceBadge = (x) => modBadge(x) || '<span class="badge kunos" title="Original Kunos content">Kunos</span>';
// filters saved before the rename ("Original" / "Mods")
const oldSrc = (v) => ({ Original: 'Kunos', Mods: 'Mod' }[v] || v);

// "Category" filter: Kunos / Mod first, then the car types (if any).
// A car or track must match (Kunos or Mod, if any is on) and (any of the types on).
function categoryGroup(f, types = []) {
  const pill = (key, v) => `<button class="pill ${f[key].has(v) ? 'on' : ''}" data-k="${key}" data-v="${esc(v)}">${esc(v)}</button>`;
  return `<div><h3>Category</h3><div class="pills">${SOURCES.map((v) => pill('srcs', v)).join('')}</div>${types.length
    ? `<div class="pills" style="margin-top:6px">${types.map((v) => pill('cats', v)).join('')}</div>` : ''}</div>`;
}

export function badges(car, v) {
  const b = [sourceBadge(car)];
  if (v?.category) b.push(`<span class="badge">${esc(v.category)}</span>`);
  if (v?.raceClass) b.push(`<span class="badge accent">${esc(v.raceClass)}</span>`);
  return b.join('');
}

function modal(title, extraHead = '') {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal" role="dialog" aria-label="${esc(title)}"><div class="modal-head"><h1>${esc(title)}</h1>
    <div class="search">${SEARCH_ICON}<input placeholder="Search" autocomplete="off"></div>${extraHead}<span class="spacer"></span>
    <button class="ghost" data-close>Close <span class="muted">Esc</span></button></div><div class="modal-body"></div></div>`;
  document.body.appendChild(back);
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  document.body.style.overflow = 'hidden';
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  back.querySelector('[data-close]').onclick = close;
  setTimeout(() => back.querySelector('.search input').focus(), 30);
  return { back, body: back.querySelector('.modal-body'), search: back.querySelector('.search input'), close };
}

/**
 * opts: { cars, driven: Map(carId -> {bestMs, laps}), selected: {id, mech, visual}, multi: false,
 *         aiOnly: false, title, onPick(sel), onAdd(sel), chosenCount() }
 */
export function openGarage(opts) {
  const cars = opts.cars.filter((c) => !opts.aiOnly || c.ai !== false);
  const maxHp = Math.max(...cars.flatMap((c) => c.variants.map((v) => v.stats?.powerHp || 0)), 1);
  const uniq = (f) => [...new Set(cars.flatMap(f).filter(Boolean))].sort();
  const CATS = ['Road', 'Track', 'Tuned', 'Race', 'Formula'].filter((c) => cars.some((x) => x.categories?.includes(c)));
  const CLASSES = uniq((c) => c.variants.map((v) => v.raceClass));
  const DRIVES = uniq((c) => [c.drivetrain]);
  const GEARS = uniq((c) => [c.transmission]);
  const BRANDS = uniq((c) => [c.brand]);
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('garage.filters') || '{}'); } catch { /* none */ }
  const f = { q: '', srcs: new Set((saved.srcs || []).map(oldSrc)), cats: new Set(saved.cats || []), classes: new Set(), drives: new Set(saved.drives || []), gears: new Set(saved.gears || []), brand: saved.brand || '', sort: saved.sort || 'name', driven: !!saved.driven };
  const persist = () => { try { localStorage.setItem('garage.filters', JSON.stringify({ srcs: [...f.srcs], cats: [...f.cats], drives: [...f.drives], gears: [...f.gears], brand: f.brand, sort: f.sort, driven: f.driven })); } catch { /* ignore */ } };
  const sel = { id: opts.selected?.id || null, mech: opts.selected?.mech || null, visual: opts.selected?.visual || null };
  let focus = cars.find((c) => c.id === sel.id) || null;

  const m = modal(opts.title || 'Choose a car', opts.multi ? '<span class="badge accent" data-count></span>' : '');
  m.body.innerHTML = `<aside class="filters"></aside><div class="garage-grid"></div><aside class="garage-detail"></aside>`;
  const fl = m.body.querySelector('.filters'), grid = m.body.querySelector('.garage-grid'), det = m.body.querySelector('.garage-detail');
  const updCount = () => { const c = m.back.querySelector('[data-count]'); if (c) c.textContent = `${opts.chosenCount?.() ?? 0} on the grid`; };
  updCount();

  const pillGroup = (title, key, values) => !values.length ? '' : `<div><h3>${title}</h3><div class="pills">${values.map((v) =>
    `<button class="pill ${f[key].has(v) ? 'on' : ''}" data-k="${key}" data-v="${esc(v)}">${esc(v)}</button>`).join('')}</div></div>`;
  function filters() {
    fl.innerHTML = `
      <div><h3>Sort</h3><select data-sort>${[['name', 'Name'], ['power', 'Power'], ['pw', 'Power / weight'], ['weight', 'Weight (light first)'], ['accel', '0–100 km/h'], ['driven', 'Recently driven']].map(([k, l]) =>
        `<option value="${k}" ${f.sort === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      ${categoryGroup(f, CATS)}
      ${pillGroup('Racing class', 'classes', CLASSES)}
      ${pillGroup('Drivetrain', 'drives', DRIVES)}
      ${pillGroup('Gearbox', 'gears', GEARS)}
      <div><h3>Brand</h3><select data-brand><option value="">All brands</option>${BRANDS.map((b) => `<option ${f.brand === b ? 'selected' : ''}>${esc(b)}</option>`).join('')}</select></div>
      <label class="row" style="gap:8px;font-size:13px"><input type="checkbox" data-driven ${f.driven ? 'checked' : ''}> Only cars I've driven</label>
      <button class="ghost small" data-reset>Reset filters</button>`;
    fl.querySelectorAll('[data-k]').forEach((b) => { b.onclick = () => { const s = f[b.dataset.k]; s.has(b.dataset.v) ? s.delete(b.dataset.v) : s.add(b.dataset.v); persist(); filters(); list(); }; });
    fl.querySelector('[data-sort]').onchange = (e) => { f.sort = e.target.value; persist(); list(); };
    fl.querySelector('[data-brand]').onchange = (e) => { f.brand = e.target.value; persist(); list(); };
    fl.querySelector('[data-driven]').onchange = (e) => { f.driven = e.target.checked; persist(); list(); };
    fl.querySelector('[data-reset]').onclick = () => { f.srcs.clear(); f.cats.clear(); f.classes.clear(); f.drives.clear(); f.gears.clear(); f.brand = ''; f.driven = false; persist(); filters(); list(); };
  }

  function shown() {
    const q = f.q.trim().toLowerCase();
    const out = cars.filter((c) => {
      const v = c.variants;
      if (q && !`${c.brand} ${c.name} ${v.map((x) => `${x.name} ${x.trim} ${x.raceClass || ''}`).join(' ')}`.toLowerCase().includes(q)) return false;
      if (f.srcs.size && !f.srcs.has(sourceOf(c))) return false;
      if (f.cats.size && !c.categories?.some((x) => f.cats.has(x))) return false;
      if (f.classes.size && !v.some((x) => f.classes.has(x.raceClass))) return false;
      if (f.drives.size && !f.drives.has(c.drivetrain)) return false;
      if (f.gears.size && !f.gears.has(c.transmission)) return false;
      if (f.brand && c.brand !== f.brand) return false;
      if (f.driven && !opts.driven?.has(c.id)) return false;
      return true;
    });
    const s0 = (c) => c.variants[0]?.stats || {};
    const by = {
      name: (a, b) => `${a.brand} ${a.name}`.localeCompare(`${b.brand} ${b.name}`),
      power: (a, b) => (s0(b).powerHp || 0) - (s0(a).powerHp || 0),
      pw: (a, b) => (hpPerTon(s0(b)) || 0) - (hpPerTon(s0(a)) || 0),
      weight: (a, b) => (s0(a).weightKg || 1e9) - (s0(b).weightKg || 1e9),
      accel: (a, b) => (s0(a).zeroTo100 || 99) - (s0(b).zeroTo100 || 99),
      driven: (a, b) => (opts.driven?.get(b.id)?.lastAt || 0) - (opts.driven?.get(a.id)?.lastAt || 0),
    }[f.sort];
    return out.sort(by);
  }

  function card(c) {
    const v = c.variants[0], s = v?.stats || {};
    const d = opts.driven?.get(c.id);
    const cats = sourceBadge(c) + (c.categories || []).slice(0, 2).map((x) => `<span class="badge">${esc(x)}</span>`).join('') + (v?.raceClass ? `<span class="badge">${esc(v.raceClass)}</span>` : '');
    return `<button class="car-card ${c.id === focus?.id ? 'on' : ''}" data-car="${esc(c.id)}">
      <div class="img"><img loading="lazy" alt="" src="${thumbUrl(c.id)}"><div class="cat">${cats}</div>${d?.bestMs ? `<span class="pb">PB ${fmt(d.bestMs)}</span>` : ''}</div>
      <div class="body"><span class="eyebrow">${esc(c.brand)}</span><span class="name">${esc(c.name)}</span>
        <div class="line"><span><b>${n0(s.powerHp)}</b> hp</span><span><b>${n0(s.weightKg)}</b> kg</span><span>${esc(c.drivetrain || '–')}</span><span>${esc((c.transmission || '').replace(' (paddles)', ''))}</span></div>
        <div class="bar" title="power"><i style="width:${Math.round(100 * (s.powerHp || 0) / maxHp)}%"></i></div>
        ${c.variants.length > 1 ? `<span class="muted" style="font-size:12px">${c.variants.length} versions</span>` : ''}
      </div></button>`;
  }

  function list() {
    const items = shown();
    grid.innerHTML = `<div class="garage-count">${items.length} of ${cars.length} cars</div>${items.map(card).join('') || '<p class="muted">No car matches these filters.</p>'}`;
    grid.querySelectorAll('[data-car]').forEach((b) => {
      b.onclick = () => {
        const c = cars.find((x) => x.id === b.dataset.car);
        if (focus?.id !== c.id) { focus = c; sel.id = c.id; sel.mech = c.variants[0]?.mech; sel.visual = null; }
        grid.querySelectorAll('.car-card.on').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        detail();
        // narrow windows have no side panel: a click picks straight away
        if (getComputedStyle(det).display === 'none') pick();
      };
      b.ondblclick = () => pick();
    });
  }

  function detail() {
    if (!focus) { det.innerHTML = '<div class="inner"><p class="muted">Pick a car to see its details, versions and liveries.</p></div>'; return; }
    const c = focus, v = variantOf(c, sel.mech);
    const livs = (v?.liveries || []).filter((l) => l.thumb);
    if (!sel.visual || !livs.some((l) => l.visual === sel.visual)) sel.visual = livs[0]?.visual || null;
    const d = opts.driven?.get(c.id);
    det.innerHTML = `<div class="hero"><img alt="" src="${thumbUrl(c.id, v?.mech, sel.visual)}"></div>
      <div class="inner">
        <div><span class="eyebrow">${esc(c.brand)}</span><div class="title">${esc(c.name)}</div><div class="row" style="gap:6px;margin-top:8px">${badges(c, v)}</div></div>
        ${c.variants.length > 1 ? `<div><h3>Version</h3><div class="pills">${c.variants.map((x) => `<button class="pill ${x.mech === v.mech ? 'on' : ''}" data-mech="${esc(x.mech)}">${esc(x.trim && x.trim !== 'Standard' ? x.trim : x.name)}</button>`).join('')}</div></div>` : ''}
        ${livs.length > 1 ? `<div><h3>Livery</h3><div class="liveries">${livs.map((l) => `<button class="livery ${l.visual === sel.visual ? 'on' : ''}" data-vis="${esc(l.visual)}" title="${esc(prettyId(l.visual))}"><img loading="lazy" alt="" src="${thumbUrl(c.id, v.mech, l.visual)}"></button>`).join('')}</div></div>` : ''}
        ${specTiles(c, v)}
        ${c.source === 'mod' ? `<div class="muted" style="font-size:13px">Mod car from <b class="secondary">${esc(c.mod || 'a mod pack')}</b> (Mods tab)</div>` : ''}
        ${d ? `<div class="muted" style="font-size:13px">You have driven it: <b class="secondary">${d.laps} laps</b>${d.bestMs ? `, best ${fmt(d.bestMs)} (${esc(d.where || '')})` : ''}</div>` : ''}
        ${v?.description ? `<div class="desc">${esc(v.description).replace(/\n\n+/g, '<br><br>')}</div>` : ''}
      </div>
      <div class="choose">${opts.multi
        ? `<button class="primary" data-add>Add to grid</button>`
        : `<button class="primary" data-pick>Choose ${esc(c.name)}</button>`}</div>`;
    det.querySelectorAll('[data-mech]').forEach((b) => { b.onclick = () => { sel.mech = b.dataset.mech; sel.visual = null; detail(); }; });
    det.querySelectorAll('[data-vis]').forEach((b) => { b.onclick = () => { sel.visual = b.dataset.vis; detail(); }; });
    if (det.querySelector('[data-pick]')) det.querySelector('[data-pick]').onclick = pick;
    if (det.querySelector('[data-add]')) det.querySelector('[data-add]').onclick = () => { opts.onAdd?.({ ...sel }); updCount(); };
  }

  function pick() {
    if (!focus) return;
    if (opts.multi) { opts.onAdd?.({ ...sel }); updCount(); return; }
    opts.onPick?.({ ...sel });
    m.close();
  }

  m.search.oninput = () => { f.q = m.search.value; list(); };
  m.search.onkeydown = (e) => { if (e.key === 'Enter') { const first = shown()[0]; if (first) { focus = first; sel.id = first.id; sel.mech = first.variants[0]?.mech; sel.visual = null; list(); detail(); } } };
  filters(); list(); detail();
  if (focus) setTimeout(() => grid.querySelector('.car-card.on')?.scrollIntoView({ block: 'center' }), 50);
  return m;
}

const LENGTHS = [
  { id: 'short', label: 'Short < 3.5 km', test: (m) => m < 3500 },
  { id: 'medium', label: 'Medium 3.5–5.5 km', test: (m) => m >= 3500 && m <= 5500 },
  { id: 'long', label: 'Long > 5.5 km', test: (m) => m > 5500 },
];

/** opts: { tracks, driven: Map(`${id}|${layout}` -> {bestMs, laps, lastAt}), selected: {id, layout}, onPick({id, layout}) } */
export function openTrackPicker(opts) {
  const m = modal('Choose a track');
  m.body.classList.add('nodetail');
  m.body.innerHTML = '<aside class="filters"></aside><div class="track-pick-grid"></div>';
  const fl = m.body.querySelector('.filters'), grid = m.body.querySelector('.track-pick-grid');
  const sel = { ...(opts.selected || {}) };
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('trackpicker.filters') || '{}'); } catch { /* none */ }
  const f = { srcs: new Set((saved.srcs || []).map(oldSrc)), lengths: new Set(saved.lengths || []), driven: saved.driven || 'all', sort: saved.sort || 'name' };
  const persist = () => { try { localStorage.setItem('trackpicker.filters', JSON.stringify({ srcs: [...f.srcs], lengths: [...f.lengths], driven: f.driven, sort: f.sort })); } catch { /* ignore */ } };
  const dOf = (t, l) => opts.driven?.get(`${t.id}|${l.key}`);

  function filters() {
    fl.innerHTML = `
      <div><h3>Sort</h3><select data-sort>${[['name', 'Name'], ['length', 'Length (longest first)'], ['lengthAsc', 'Length (shortest first)'], ['recent', 'Recently driven'], ['laps', 'Most laps']].map(([k, l]) =>
        `<option value="${k}" ${f.sort === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      ${categoryGroup(f)}
      <div><h3>Length</h3><div class="pills">${LENGTHS.map((x) => `<button class="pill ${f.lengths.has(x.id) ? 'on' : ''}" data-len="${x.id}">${x.label}</button>`).join('')}</div></div>
      <div><h3>Driven</h3><div class="pills">${[['all', 'All'], ['yes', 'Driven'], ['no', 'Not driven yet']].map(([k, l]) =>
        `<button class="pill ${f.driven === k ? 'on' : ''}" data-drv="${k}">${l}</button>`).join('')}</div></div>
      <button class="ghost small" data-reset>Reset filters</button>`;
    fl.querySelectorAll('[data-k]').forEach((b) => { b.onclick = () => { const v = b.dataset.v; f.srcs.has(v) ? f.srcs.delete(v) : f.srcs.add(v); persist(); filters(); render(); }; });
    fl.querySelectorAll('[data-len]').forEach((b) => { b.onclick = () => { const v = b.dataset.len; f.lengths.has(v) ? f.lengths.delete(v) : f.lengths.add(v); persist(); filters(); render(); }; });
    fl.querySelectorAll('[data-drv]').forEach((b) => { b.onclick = () => { f.driven = b.dataset.drv; persist(); filters(); render(); }; });
    fl.querySelector('[data-sort]').onchange = (e) => { f.sort = e.target.value; persist(); render(); };
    fl.querySelector('[data-reset]').onclick = () => { f.srcs.clear(); f.lengths.clear(); f.driven = 'all'; persist(); filters(); render(); };
  }

  // tracks with only the layouts that pass the filters; a track with none left is hidden
  function shown() {
    const q = m.search.value.trim().toLowerCase();
    const layoutOk = (t, l) => {
      if (f.lengths.size && !(l.lengthM && LENGTHS.some((x) => f.lengths.has(x.id) && x.test(l.lengthM)))) return false;
      const laps = dOf(t, l)?.laps || 0;
      if (f.driven === 'yes' && !laps) return false;
      if (f.driven === 'no' && laps) return false;
      return true;
    };
    const out = opts.tracks
      .filter((t) => !f.srcs.size || f.srcs.has(sourceOf(t)))
      .filter((t) => !q || `${t.name} ${t.country || ''} ${t.layouts.map((l) => l.name).join(' ')}`.toLowerCase().includes(q))
      .map((t) => {
        const layouts = t.layouts.filter((l) => layoutOk(t, l));
        const ds = layouts.map((l) => dOf(t, l)).filter(Boolean);
        return { ...t, layouts, maxLen: Math.max(0, ...layouts.map((l) => l.lengthM || 0)), minLen: Math.min(1e9, ...layouts.map((l) => l.lengthM || 1e9)),
          laps: ds.reduce((a, d) => a + (d.laps || 0), 0), lastAt: Math.max(0, ...ds.map((d) => d.lastAt || 0)) };
      })
      .filter((t) => t.layouts.length);
    const name = (a, b) => a.name.localeCompare(b.name);
    const by = {
      name,
      length: (a, b) => b.maxLen - a.maxLen || name(a, b),
      lengthAsc: (a, b) => a.minLen - b.minLen || name(a, b),
      recent: (a, b) => b.lastAt - a.lastAt || name(a, b),
      laps: (a, b) => b.laps - a.laps || name(a, b),
    }[f.sort] || name;
    return out.sort(by);
  }

  const render = () => {
    const list = shown();
    grid.innerHTML = `<div class="garage-count" style="grid-column:1/-1">${list.length} of ${opts.tracks.length} tracks</div>` + (list.map((t) => {
      const l = t.layouts.find((x) => x.key === sel.layout && t.id === sel.id) || t.layouts[0];
      const mine = t.laps ? `<span class="muted" style="font-size:12px">${t.laps} lap${t.laps > 1 ? 's' : ''}</span>` : '';
      return `<div class="track-pick ${t.id === sel.id ? 'on' : ''}" data-t="${esc(t.id)}">
        <div class="track-map" data-go="${esc(l.key)}">${l.hasMap ? `<img loading="lazy" alt="" src="/api/tracks/map?track=${encodeURIComponent(t.id)}&layout=${encodeURIComponent(l.key)}">` : ''}</div>
        <div class="body"><div class="row" style="gap:8px"><b>${esc(t.name)}</b>${sourceBadge(t)}<span class="spacer"></span><span class="muted" style="font-size:12px">${esc(t.country || '')}</span></div>
          ${mine}
          <div class="pills">${t.layouts.map((x) => { const d = dOf(t, x); return `<button class="pill ${t.id === sel.id && x.key === sel.layout ? 'on' : ''}" data-l="${esc(x.key)}" title="${x.lengthM ? (x.lengthM / 1000).toFixed(2) + ' km' : ''}${d?.laps ? ` · ${d.laps} laps` : ''}">${esc(x.name)}${x.lengthM ? ` <span class="muted">${(x.lengthM / 1000).toFixed(1)} km</span>` : ''}${d?.bestMs ? ` · ${fmt(d.bestMs)}` : ''}</button>`; }).join('')}</div></div></div>`;
    }).join('') || '<p class="muted">No track matches these filters.</p>');
    grid.querySelectorAll('[data-t]').forEach((card) => {
      const choose = (layout) => { opts.onPick?.({ id: card.dataset.t, layout }); m.close(); };
      card.querySelectorAll('[data-l]').forEach((b) => { b.onclick = () => choose(b.dataset.l); });
      card.querySelector('[data-go]').onclick = (e) => choose(e.currentTarget.dataset.go);
    });
  };
  m.search.oninput = render;
  filters(); render();
  if (sel.id) setTimeout(() => grid.querySelector('.track-pick.on')?.scrollIntoView({ block: 'center' }), 50);
  return m;
}
