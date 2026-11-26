// Lap analysis (PL6): where the time is for one track + car, worked out from your own laps without AI
// (src/opportunities.js, docs/platform/ANALYSIS.md). The three biggest opportunities first, each readable on its own:
// what was measured, kept apart from what it may mean, with links to the comparison and the corner's distribution.
import { $, esc, api, post, fmt, fmtGap, prettyName, mixHtml, emptyHtml, prov, info } from './util.js';
import { DRILLABLE, drillHtml, wireDrills, masteryBadge, noVersionHtml } from './practice.js';

const s2 = (ms) => (ms == null ? '–' : `${(ms / 1000).toFixed(2)} s`);
const CONF = { high: 'High', medium: 'Medium', low: 'Low', insufficient: 'Not enough laps' };
const CONF_TIP = 'How many passes the numbers rest on: low = 5 to 9, medium = 10 to 19, high = 20 or more. Fewer than 5: nothing is concluded.';
const PHASE_TXT = { entry: 'Entry', apex: 'Apex', exit: 'Exit' };
const PHASE_TIP = 'Time lost by your typical pass against your quicker passes in each part of the corner: entry = from the start of the corner to 25 m before its slowest point; apex = 25 m either side; exit = from there to the next corner.';
const confBadge = (c, n) => `<span class="conf conf-${c === 'insufficient' ? 'none' : esc(c)}" title="${esc(CONF_TIP)}">Confidence: ${esc(CONF[c] || c)}${n != null ? ` · ${n} passes` : ''}</span>`;

export async function viewAnalysis(view, params) {
  const overview = await api('/api/overview');
  const combos = overview.combos.filter((c) => c.validLaps > 0).sort((a, b) => b.lastAt - a.lastAt);
  if (!combos.length) { view.innerHTML = emptyHtml('No valid laps yet', 'The lap analysis looks for where your time goes, corner by corner. Drive a few valid laps first: it needs 5 or more passes of a corner.', '<a href="#/race"><button class="primary">Set up a session</button></a>'); return; }
  const key = combos.some((c) => c.key === params.get('combo')) ? params.get('combo') : combos[0].key;
  const [track, layout, car] = key.split('|');
  const window = params.get('window') === 'all' ? 'all' : 'recent';
  const match = ['game', 'setup'].includes(params.get('match')) ? params.get('match') : 'any';
  const ck = encodeURIComponent(key);
  const nav = (patch) => { location.hash = `#/analysis?${new URLSearchParams({ combo: key, window, match, ...patch })}`; };
  let d;
  try { d = await api(`/api/analysis?${new URLSearchParams({ track, layout, car, window, match })}`); } catch (e) {
    if (!/^No valid laps/.test(e.message)) throw e;
    view.innerHTML = emptyHtml('No valid laps yet', 'Drive a few valid laps with this car here first.', '<a href="#/"><button>Sessions</button></a>');
    return;
  }

  const head = `<div class="cmp-head">
      <a href="#/"><button class="ghost">Back to laps</button></a>
      <div><h1>Lap analysis at ${esc(prettyName(track))} <span class="muted">${esc(prettyName(layout))}</span></h1>
        <div class="secondary">${esc(prettyName(car))} · ${prov('calculated', 'From your valid laps: speed, pedals, steering and gear, which are checked against the game. No AI.')}</div></div>
      <span class="spacer"></span>
      <label class="row">Car and track <select id="anCombo">${combos.map((c) => `<option value="${esc(c.key)}" ${c.key === key ? 'selected' : ''}>${esc(prettyName(c.track))} ${esc(prettyName(c.layout))}, ${esc(prettyName(c.car))}</option>`).join('')}</select></label>
      <label class="row">Laps <select id="anWindow"><option value="recent">Newest ${d.windowSize} valid</option><option value="all">All valid laps</option></select></label>
      <label class="row">Only laps like the newest <select id="anMatch"><option value="any">Any</option><option value="game">Same game version</option><option value="setup">Same setup</option></select></label>
    </div>`;
  if (d.disabled) { view.innerHTML = `${head}<div class="card empty"><h2>No analysis</h2><p class="muted">${esc(d.disabled)}</p></div>`; wire(); return; }
  // practice drills of this car + track (PL7); the page still works if they cannot be worked out
  let pr = null;
  try { pr = await api(`/api/practice?${new URLSearchParams({ track, layout, car })}`); } catch { /* shown as a note below */ }
  const active = pr?.drills.find((x) => x.active) || null;
  // the drill's numbers come from the default view (newest laps, any game version or setup)
  const canDrill = !!pr && window === 'recent' && match === 'any';
  d.mastery = new Map((pr?.mastery || []).map((m) => [m.name, m]));
  d.drill = { can: canDrill, active, ready: pr?.ready ?? { ok: true } }; // ready: false = no recorded game version (D-PL7-13)

  const ex = d.sample.excluded || [];
  view.innerHTML = `${head}
    ${d.note ? `<div class="card"><span class="muted">${esc(d.note)}</span></div>` : ''}
    ${mixHtml(d.compat, 'The laps analysed')}
    <div class="tiles">
      <div class="card stat"><span class="k">Laps analysed</span><span class="v">${d.sample.laps}</span></div>
      <div class="card stat"><span class="k">Sessions</span><span class="v">${d.sample.sessions}</span></div>
      <div class="card stat" title="Your best valid lap among the laps analysed"><span class="k">Best lap</span><span class="v">${fmt(d.target.bestMs)}</span></div>
      <div class="card stat" title="The median of the laps analysed"><span class="k">Typical lap</span><span class="v">${fmt(d.target.typicalMs)}</span></div>
      <div class="card stat" title="${esc('Repeatable target: for every corner, the time you reach in at least 1 of 4 passes (the first quartile), added up. The ± is a rough range: the first quartile of each corner has a ~95 % interval from the order of its passes, and these are added as if the corners were independent.')}"><span class="k">Target lap (repeatable)</span><span class="v" id="anTarget">${d.target.targetMs != null ? `${fmt(d.target.targetMs)}<small class="muted"> ±${(d.target.uncertaintyMs / 1000).toFixed(1)} s, rough</small>` : '–'}</span></div>
      <div class="card stat" title="Your best pass of every corner put together, from all your valid laps here (the ideal lap of Compare)"><span class="k">Ideal lap (theoretical)</span><span class="v">${fmt(d.idealMs)}</span></div>
    </div>
    ${d.target.targetMs == null ? `<div class="card"><span class="muted">No target lap yet: ${esc(d.target.reason)}</span></div>` : ''}
    ${ex.length || d.noGear || d.gearbox?.auto ? `<details class="card"><summary><b>Laps left out or limited</b> <span class="muted s">${ex.length} left out${d.noGear ? `, ${d.noGear} without gear data` : ''}${d.gearbox?.auto ? `, ${d.gearbox.auto} with the automatic gearbox` : ''}</span></summary>
      <ul class="s">${ex.slice(0, 30).map((e) => `<li>Lap #${e.id}: ${esc(e.reason)}</li>`).join('')}${ex.length > 30 ? `<li>… and ${ex.length - 30} more</li>` : ''}
      ${d.noGear ? `<li>${d.noGear} lap${d.noGear === 1 ? '' : 's'} recorded without a gear channel: left out of the gear comparisons only.</li>` : ''}${d.gearbox?.auto ? `<li>${d.gearbox.auto} lap${d.gearbox.auto === 1 ? '' : 's'} driven with the automatic gearbox: left out of the gear comparisons only.</li>` : ''}</ul></details>` : ''}
    ${drillSection(d, pr, key)}
    <section class="card" id="anTop"><h2>Where to gain time</h2>
      ${d.top.length ? `<div class="opp-grid">${d.top.map((t) => oppCard(t, d, ck)).join('')}</div>
        <p class="muted s" style="margin:10px 0 0">${esc(d.causation)}</p>` : `<p class="muted" style="margin:0">${esc(noTopText(d))}</p>`}
    </section>
    ${pbCard(d)}
    <section class="card"><h2>All corners ${info("Each row: your passes of the corner against its median (dots), the middle half (box) and the interval of the median (the darker band: if two corners' bands are far apart, the difference is more than noise).", 'How to read this')}</h2>
      <p class="muted s" style="margin:0 0 8px">Open a corner for its braking, throttle and gear details.</p>
      <div class="an-corners">${d.corners.map((c) => cornerRow(c, d, ck)).join('')}</div>
    </section>
    ${trendCard(d, ck)}`;
  wire();
  const redraw = () => { if (view.isConnected) globalThis.dispatchEvent(new HashChangeEvent('hashchange')); }; // ('window' is the lap window here)
  const drillBox = view.querySelector('#anDrill');
  if (drillBox && pr) wireDrills(drillBox, pr.drills, redraw);
  // "Practise this": one finding of a top card becomes the drill of this car + track (one at a time)
  view.querySelectorAll('[data-practise]').forEach((b) => (b.onclick = async () => {
    const [corner, fkey] = JSON.parse(b.dataset.practise);
    if (active && !confirm(`You are practising ${active.corner} (${active.prescription.label}) on this car and track. One drill at a time: replace it with this one?`)) return;
    b.disabled = true;
    try { await post('/api/practice', { action: 'create', track, layout, car, corner, key: fkey, replace: !!active }); redraw(); }
    catch (e) { b.disabled = false; alert(e.message); }
  }));

  function wire() {
    $('#anCombo').onchange = (e) => { location.hash = `#/analysis?${new URLSearchParams({ combo: e.target.value, window, match })}`; };
    $('#anWindow').value = window; $('#anWindow').onchange = (e) => nav({ window: e.target.value });
    $('#anMatch').value = match; $('#anMatch').onchange = (e) => nav({ match: e.target.value });
    // in-page links: the router owns location.hash, so a corner is opened and scrolled to directly
    view.querySelectorAll('[data-goto]').forEach((b) => b.onclick = () => {
      const el = document.getElementById(b.dataset.goto);
      if (!el) return;
      if (el.tagName === 'DETAILS') el.open = true;
      el.scrollIntoView({ block: 'center' });
      (el.querySelector('summary') || el).focus?.();
    });
  }
}

function noTopText(d) {
  const enough = d.corners.filter((c) => c.sufficient);
  if (!enough.length) return `Not enough laps yet: every corner needs ${d.rules.minPasses} valid passes before anything is concluded (${d.sample.laps} lap${d.sample.laps === 1 ? '' : 's'} analysed).`;
  return `No corner has a repeatable gain of ${(d.rules.minGainMs / 1000).toFixed(2)} s or more: your typical passes are already close to your quicker ones.${d.notEnough.length ? ` Not enough passes yet at ${d.notEnough.join(', ')}.` : ''}`;
}

function phaseBar(phases, main) {
  const vals = Object.entries(phases).map(([k, v]) => [k, Math.max(0, v || 0)]);
  const total = vals.reduce((a, [, v]) => a + v, 0) || 1;
  return `<div class="phasebar" title="${esc(PHASE_TIP)}" role="img" aria-label="${esc(vals.map(([k, v]) => `${PHASE_TXT[k]} ${s2(v)}`).join(', '))}">
    ${vals.map(([k, v]) => `<span class="ph ph-${k}${k === main ? ' main' : ''}" style="flex:${Math.max(v / total, 0.08).toFixed(3)} 0 auto"><b>${PHASE_TXT[k]}</b> ${s2(v)}</span>`).join('')}</div>`;
}

function oppCard(t, d, ck) {
  const marked = d.bookmarks?.[t.name];
  return `<article class="opp-card" id="opp-${esc(t.name)}">
    <div class="row"><span class="opp-rank">${t.rank}</span><h3 style="margin:0">${esc(t.name)}</h3>${marked ? `<span class="badge accent" title="You bookmarked this corner ${marked} time${marked === 1 ? '' : 's'} (session notes)">Bookmarked</span>` : ''}
      <span class="spacer"></span><span class="opp-gain" title="Realistic gain: your typical pass against the time you reach in 1 of 4 passes. Up to: against your single fastest pass.">${s2(t.gain.realisticMs)}<small class="muted"> up to ${s2(t.gain.idealMs)}</small></span></div>
    <p class="opp-head">${esc(t.headline)}</p>
    ${confBadge(t.confidence, t.passes)}
    ${phaseBar(t.phases, t.mainPhase)}
    <h4>What was measured</h4>
    <ul class="opp-obs"><li>${esc(t.observation)}</li>${t.findings.map((f) => `<li>${esc(f.observation)}${practiseBtn(t, f, d)}</li>`).join('')}</ul>
    ${t.caveats?.length ? `<p class="muted s opp-cav">${t.caveats.map(esc).join(' ')}</p>` : ''}
    ${t.findings.length ? `<h4>What it may mean</h4><ul class="opp-int">${t.findings.map((f) => `<li>${esc(f.interpretation)}</li>`).join('')}</ul>` : '<p class="muted s">No single difference in braking, throttle, speed or gear stands out: compare the passes to see the line.</p>'}
    <div class="row opp-links"><a href="#/compare?laps=${t.links.typicalLapId}&ref=${t.links.fastLapId}&c=${encodeURIComponent(t.name)}">Compare a typical pass with a quick one at ${esc(t.name)} ›</a>
      <button type="button" class="linklike" data-goto="an-${esc(t.name)}">Distribution ›</button><a href="#/consistency?combo=${ck}&metric=timeMs">Spread of every corner ›</a></div>
  </article>`;
}

// ---- practice (PL7): the drill of this car + track, and the button that makes one from a finding
function practiseBtn(t, f, d) {
  if (!d.drill?.can || !DRILLABLE.has(f.key)) return '';
  const a = d.drill.active;
  if (a && a.corner === t.name && a.key === f.key) return ' <span class="badge chal">your drill</span>';
  if (!d.drill.ready.ok) return ` <button type="button" class="small linklike" disabled aria-disabled="true" aria-describedby="anNoVersion" data-practise-off>Practise this ›</button>`;
  return ` <button type="button" class="small linklike" data-practise="${esc(JSON.stringify([t.name, f.key]))}" title="Make this one behaviour your practice drill here: an exercise, a measurable target and a review point, checked on the passes you drive next.">Practise this ›</button>`;
}
function drillSection(d, pr, key) {
  if (!pr) return '<div class="card"><span class="muted">Practice drills could not be worked out just now.</span></div>';
  const a = d.drill.active;
  const noVersion = d.drill.can && !d.drill.ready.ok ? noVersionHtml('anNoVersion', d.drill.ready.reason) : '';
  if (a) return `<section class="card" id="anDrill"><div class="row"><h2 style="margin:0">Your practice drill here</h2><span class="spacer"></span><a class="s" href="#/development">All drills ›</a></div>
    ${noVersion}<p class="muted s" style="margin:4px 0 8px">One focus at a time: checked on the passes you drive from now on, by what you do in the corner, not by time spent.</p>${drillHtml(a, { combo: false })}</section>`;
  if (!d.top.length) return '';
  return `<div class="card" id="anDrill">${noVersion}<span class="muted s">${d.drill.can ? 'Pick one finding below and choose <b>Practise this</b>: Paddock turns it into a drill with one exercise and a measurable target, checked on the laps you drive next.' : 'Drills are made from the default view (newest laps, any game version or setup): switch back to it to start one.'}</span>
    ${pr.revisits.filter((r) => `${r.combo.track}|${r.combo.layout}|${r.combo.car}` === key).map((r) => `<p class="s" style="margin:6px 0 0"><span class="badge bad">Revisit</span> ${esc(r.corner)}: ${esc(r.label)} may be slipping (Development).</p>`).join('')}</div>`;
}

// one corner: a distribution strip and, opened, the typical against the quicker passes
const ROWS = [
  ['brakePoint', 'Starts braking at', 'm', 0], ['brakeRelease', 'Off the brake at', 'm', 0], ['releaseMs', 'Brake release time', 's', 2], ['releaseBumps', 'Brake re-applications', '', 0],
  ['trailM', 'Trail braking', 'm', 0], ['minSpeed', 'Slowest point', 'km/h', 1], ['throttlePickup', 'Back on the throttle at', 'm', 0], ['pickupMs', 'Slowest point to full throttle', 's', 2],
  ['holdMs', 'Throttle hesitation', 's', 2], ['exitSpeed', 'Exit speed', 'km/h', 1],
];
const val = (v, unit, dp) => (v == null ? '–' : unit === 's' ? `${(v / 1000).toFixed(dp)} s` : `${(Math.round(v * 10 ** dp) / 10 ** dp)}${unit ? ` ${unit}` : ''}`);
function strip(c) {
  if (!c.dist) return '<span class="muted s">not driven</span>';
  const W = 260, H = 22, med = c.dist.medianMs;
  const ext = Math.max(50, ...c.values.map((v) => Math.abs(v.ms - med)));
  const X = (ms) => (W / 2) + ((ms - med) / ext) * (W / 2 - 6);
  return `<svg class="an-strip" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`${c.name}: ${c.passes} passes, median ${s2(med)}, middle half ${s2(c.dist.q1Ms)} to ${s2(c.dist.q3Ms)}`)}">
    <line x1="${W / 2}" x2="${W / 2}" y1="1" y2="${H - 1}" class="ax-line"/>
    <rect x="${X(c.dist.q1Ms)}" y="6" width="${Math.max(1, X(c.dist.q3Ms) - X(c.dist.q1Ms))}" height="${H - 12}" rx="2" class="an-box"/>
    ${c.sufficient ? `<rect x="${X(med - c.dist.ciMs)}" y="9" width="${Math.max(1, X(med + c.dist.ciMs) - X(med - c.dist.ciMs))}" height="${H - 18}" class="an-ci"/>` : ''}
    ${c.values.map((v) => `<circle cx="${X(v.ms)}" cy="${H / 2}" r="2.6" class="an-dot"><title>Lap #${v.lapId}: ${s2(v.ms)} (${fmtGap(v.ms - med, 2)} against the median)</title></circle>`).join('')}</svg>`;
}
function cornerRow(c, d, ck) {
  const marked = d.bookmarks?.[c.name];
  const sum = `<span class="an-name"><b>${esc(c.name)}</b>${c.rank ? ` <span class="badge bad" title="Opportunity rank">#${c.rank}</span>` : ''}${marked ? ' <span class="badge accent">Bookmarked</span>' : ''} ${masteryBadge(d.mastery?.get(c.name))}</span>
    ${strip(c)}
    <span class="an-num" title="Typical (median) corner time ± the interval of the median">${c.dist ? `${s2(c.dist.medianMs)}${c.sufficient ? ` <small class="muted">±${(c.dist.ciMs / 1000).toFixed(2)}</small>` : ''}` : ''}</span>
    <span class="an-num" title="Realistic gain (typical against 1 pass in 4) · up to (against your fastest pass)">${c.gain ? `${s2(c.gain.realisticMs)} <small class="muted">/ ${s2(c.gain.idealMs)}</small>` : `<small class="muted">${esc(c.reason || '')}</small>`}</span>
    ${confBadge(c.confidence, c.passes)}`;
  if (!c.gain) return `<div class="an-row" id="an-${esc(c.name)}"><div class="an-sum">${sum}</div></div>`;
  const g = c.gears;
  return `<details class="an-row" id="an-${esc(c.name)}"><summary class="an-sum">${sum}</summary>
    <div class="an-detail">
      ${phaseBar(c.phases, c.mainPhase)}
      <div class="tablewrap"><table class="s"><thead><tr><th>Measured (median)</th><th>Your typical pass</th><th>Quicker quarter (${c.fastPasses} passes)</th></tr></thead>
        <tbody>${ROWS.map(([k, label, unit, dp]) => `<tr><td>${esc(label)}</td><td>${val(c.typical[k], unit, dp)}</td><td>${val(c.fast[k], unit, dp)}</td></tr>`).join('')}
        <tr><td>Gear at the slowest point</td><td colspan="2">${g.available ? g.groups.map((x) => `${x.gear}: ${x.passes} pass${x.passes === 1 ? '' : 'es'}${x.medianMs != null ? ` (median ${s2(x.medianMs)})` : ''}`).join(' · ') : esc(g.reason)}</td></tr></tbody></table></div>
      ${g.comparison ? `<p class="s"><b>Gear:</b> ${esc(g.comparison.observation)} <span class="muted">${esc(g.comparison.interpretation)}</span></p>` : ''}
      <p class="muted s">Gears are what the car reported, from laps with the manual gearbox only${g.auto ? ` (${g.auto} pass${g.auto === 1 ? '' : 'es'} with the automatic gearbox left out)` : ''}${g.unknownGearbox ? `; for ${g.unknownGearbox} pass${g.unknownGearbox === 1 ? '' : 'es'} the gearbox setting was not recorded (it comes from the Paddock HUD), so they may include automatic shifts` : ''}. The brake channel is the pedal position, not the brake pressure.</p>
      ${c.findings.length ? `<ul class="s">${c.findings.map((f) => `<li>${esc(f.observation)} <span class="muted">${esc(f.interpretation)}</span></li>`).join('')}</ul>` : ''}
      <div class="row opp-links"><a href="#/compare?laps=${c.links.typicalLapId}&ref=${c.links.fastLapId}&c=${encodeURIComponent(c.name)}">Compare a typical pass with a quick one ›</a>
        <a href="#/compare?laps=${c.links.typicalLapId}&ref=${c.links.fastestLapId}&c=${encodeURIComponent(c.name)}">… with your fastest pass ›</a>
        <a href="#/consistency?combo=${ck}&metric=timeMs">Spread ›</a></div>
    </div></details>`;
}

function pbCard(d) {
  const p = d.pb;
  if (!p) return '';
  if (!p.prev) return `<section class="card"><h2>Your personal best</h2><p class="muted" style="margin:0">${esc(p.reason)}</p></section>`;
  const cav = p.compat && p.compat.level !== 'compatible' ? `<p class="s"><span class="compat-tag warn">${p.compat.level === 'incompatible' ? 'Not comparable' : 'Caveats'}</span> ${esc(p.compat.items.map((i) => i.title).join(' · '))}</p>` : '';
  const list = (rows, kind) => rows.slice(0, 3).map((r) => `<li><b>${esc(r.name)}</b> <span class="${kind === 'gain' ? 'neg' : 'pos'}">${fmtGap(r.deltaMs, 2)}</span>
    <span class="muted s">(entry ${fmtGap(r.phases.entry, 2)}, apex ${fmtGap(r.phases.apex, 2)}, exit ${fmtGap(r.phases.exit, 2)})</span>
    ${r.findings?.length ? `<ul class="s">${r.findings.map((f) => `<li>${esc(f.observation)}</li>`).join('')}</ul>` : ''}</li>`).join('');
  return `<section class="card" id="anPb"><h2>What made your personal best faster</h2>
    <p style="margin:0 0 6px">Your best lap ${fmt(p.lapMs)} (lap #${p.lapId}) was <b class="neg">${fmtGap(p.deltaMs, 3)}</b> against your previous best ${fmt(p.prev.lapMs)} (lap #${p.prev.lapId}).
      <a href="#/compare?laps=${p.lapId}&ref=${p.prev.lapId}">Compare the two ›</a></p>${cav}
    ${p.gains.length ? `<h4>Gained most at</h4><ul>${list(p.gains, 'gain')}</ul>` : ''}
    ${p.losses.length ? `<h4>Lost at</h4><ul>${list(p.losses, 'loss')}</ul>` : ''}
    <p class="muted s" style="margin:6px 0 0">${esc(p.note)}</p></section>`;
}

const VERDICT = { faster: ['neg', 'Faster'], slower: ['pos', 'Slower'], 'no clear change': ['muted', 'No clear change'] };
function trendCard(d, ck) {
  const t = d.trends;
  const head = `<div class="row"><h2 style="margin:0">Across sessions</h2><span class="spacer"></span><a href="#/progress?combo=${ck}" class="s">Progress by day ›</a></div>`;
  if (!t.sufficient) return `<section class="card">${head}<p class="muted" style="margin:8px 0 0">${esc(t.reason)}</p></section>`;
  const v = (x) => { const [cls, txt] = VERDICT[x.verdict]; return `<span class="${cls}" title="First against the latest session: a change counts only when the two medians' intervals do not overlap.">${txt}</span>`; };
  return `<section class="card">${head}
    <p class="muted s" style="margin:6px 0 8px">The newest ${t.sessions.length} sessions with ${d.rules.trendPassesMin} or more valid laps, oldest first: the median of each session, and the change from the first to the latest.</p>
    <div class="tablewrap"><table class="s"><thead><tr><th></th><th>Sessions (median)</th><th>Change</th><th>Per session</th><th></th></tr></thead><tbody>
      <tr><td><b>Lap</b></td><td>${t.lap.points.map((x) => fmt(x)).join(' → ')}</td><td>${fmtGap(t.lap.changeMs, 2)}</td><td>${fmtGap(t.lap.slopeMs, 2)}</td><td>${v(t.lap)}</td></tr>
      ${t.corners.map((c) => `<tr><td><button type="button" class="linklike" data-goto="an-${esc(c.name)}">${esc(c.name)}</button></td><td>${c.points.map((x) => s2(x)).join(' → ')}</td><td>${fmtGap(c.changeMs, 2)}</td><td>${fmtGap(c.slopeMs, 2)}</td><td>${v(c)}</td></tr>`).join('')}
    </tbody></table></div></section>`;
}
