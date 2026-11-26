// Home (#/home, where Paddock opens): your driving at a glance, built only from your own laps and reports
// (src/service.js dashboard): what needs attention, totals, recent sessions, open practice targets, the best lap per
// driving day for your most driven cars and tracks, and your records. Every number links to where it comes from.
import { esc, api, post, fmt, fmtGap, prettyName, emptyHtml, info, getMirror } from './util.js';
import { thumbUrl } from './garage.js';

const when = (t) => new Date(t).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const dayTxt = (d) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
// calendar days, like the rest of Paddock (a lap at 23:00 yesterday is "yesterday" at 08:00)
const ago = (t) => {
  const midnight = (x) => { const m = new Date(x); m.setHours(0, 0, 0, 0); return m.getTime(); };
  const d = Math.round((midnight(Date.now()) - midnight(t)) / 86400e3);
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : d < 30 ? `${d} days ago` : new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
};
const hours = (ms) => (ms >= 3600e3 ? `${(ms / 3600e3).toFixed(1)} h` : `${Math.round(ms / 60e3)} min`);
const combo = (x) => `${esc(prettyName(x.track))} <span class="muted">${esc(prettyName(x.layout))}</span>`;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const ICON = { warning: '⚠', info: 'ℹ' };

// leaderboard changes (src/leaderboard.js checkRanks notices): places lost to others, gained with your own laps, new boards
const boardAgo = (t) => { const s = (Date.now() - t) / 1000; return s < 90 ? 'just now' : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : ago(t); };
function boardCard(b) {
  const head = `<div class="row"><h2 style="margin:0">Leaderboard changes</h2><span class="spacer"></span><a href="#/leaderboard">Leaderboards ›</a></div>`;
  if (!b) return '';
  if (!b.signedIn) return `<div class="card">${head}<p class="muted" style="margin:8px 0 0">Sign in with Steam on the <a href="#/leaderboard">Leaderboards</a> page and your places on each board show here: who went past you, and where your new laps put you.</p></div>`;
  const n = (b.notices || []).slice(0, 6);
  if (!n.length) return `<div class="card">${head}<p class="muted" style="margin:8px 0 0">No changes yet. Paddock checks your places when it starts, after each lap it sends and every 2 hours.</p></div>`;
  return `<div class="card">${head}<ul class="home-list">${n.map((x) => {
    const kind = x.kind || 'lost'; // notices from before gains were kept are all places lost
    const move = kind === 'new' ? `<span class="badge best">New · P${x.to}</span>` : `<b class="${kind === 'gained' ? 'neg' : 'pos'}">P${x.from} → P${x.to}</b>`;
    const why = kind === 'lost' ? (x.by ? `${esc(x.by)} went past` : 'someone went past') : kind === 'gained' ? 'your new lap' : `first time on this board${x.of ? `, ${x.of} drivers` : ''}`;
    const gap = String(x.text || '').split(':').slice(1).join(':').trim();
    return `<li><a href="#/leaderboard?combo=${encodeURIComponent(`${x.track}|${x.layout ?? ''}|${x.car}`)}">
      <span class="hl-main">${combo(x)}<span class="muted"> · ${esc(prettyName(x.car))}</span><span class="hl-sub muted">${esc(gap || why)}</span></span>
      <span class="hl-num">${move}<span class="hl-sub muted">${esc(why)} · ${esc(boardAgo(x.at))}</span></span></a></li>`;
  }).join('')}</ul></div>`;
}

export async function viewHome(view, cleanup) {
  const [d, board] = await Promise.all([api('/api/dashboard'), api('/api/board/status').catch(() => null)]);
  const T = d.totals;
  const warnings = d.warnings.length ? `<div class="card home-warn" role="region" aria-label="Needs attention"><h2>Needs attention</h2><ul>${d.warnings.map((w) => `<li class="w-${w.level}">
      <span class="w-ic" aria-hidden="true">${ICON[w.level] || ''}</span><span class="w-lvl">${w.level === 'warning' ? 'Warning' : 'Note'}</span>
      <span class="w-txt">${esc(w.text)}</span><a href="${esc(w.href)}">${esc(w.label)}</a></li>`).join('')}</ul></div>` : '';

  if (!T.laps) {
    view.innerHTML = `<div class="race-head"><div><h1>Home</h1><div class="sub">Your driving at a glance, from your own laps.</div></div></div>${warnings}
      ${emptyHtml('Welcome to AC EVO Paddock', `Paddock records every lap you drive in Assetto Corsa EVO, then shows where the time goes, keeps your records and writes a report after each session.
        <br><br><b>1.</b> Start AC EVO, from Steam or from the <a href="#/race">Race</a> tab. <b>2.</b> Drive: laps are saved when you cross the line. <b>3.</b> Come back here for your records and trends.`,
        '<a href="#/welcome"><button class="primary">Open the setup guide</button></a><a href="#/race"><button>Set up a session</button></a><a href="#/tracks"><button>Look at the tracks</button></a>')}`;
    return;
  }

  const tile = (k, v, sub = '', href = null) => `<${href ? `a href="${href}"` : 'div'} class="card stat">${`<span class="k">${k}</span><span class="v">${v}</span>${sub ? `<span class="muted s">${sub}</span>` : ''}`}</${href ? 'a' : 'div'}>`;
  const tiles = `<div class="home-tiles">
    ${tile('Laps', `${T.validLaps}<small> / ${T.laps}</small>`, 'valid of all laps', '#/?by=date')}
    ${tile('Sessions', T.sessions, `${plural(T.combos, 'car and track')}`, '#/')}
    ${tile('Time in laps', hours(T.drivingMs), `saved laps, over ${plural(T.days, 'day')}`)}
    ${tile('Last 7 days', plural(T.last7, 'lap'), `${plural(T.last30, 'lap')} in 30 days`)}
    ${tile('Last lap', ago(T.lastAt), d.recording ? '<span class="pos-live">recording now</span>' : '')}</div>`;

  // where you are now: the last session as the hero, then one card with what to do next (objective, targets, next step)
  const hero = heroHtml(d);
  const next = nextHtml(d);

  const sessions = `<div class="card"><div class="row"><h2 style="margin:0">Recent sessions</h2><span class="spacer"></span><a href="#/?by=date">All sessions ›</a></div>
    <ul class="home-list">${d.recentSessions.map((s) => {
      const r = s.report;
      return `<li><a href="#/report?session=${s.id}">
        <span class="hl-main">${combo(s)}<span class="muted"> · ${esc(prettyName(s.car))}</span><span class="hl-sub muted">${esc(when(s.startedAt))} · ${plural(s.laps, 'lap')}${s.validLaps !== s.laps ? `, ${s.validLaps} valid` : ''}</span></span>
        <span class="hl-num">${s.bestMs != null ? `<b class="${r?.newPb ? 'best' : ''}">${fmt(s.bestMs)}</b>` : '<span class="muted">no valid lap</span>'}
          <span class="hl-sub">${r?.newPb ? '<span class="badge best">New PB</span>' : r?.bestDeltaMs != null ? `<span class="${r.bestDeltaMs <= 0 ? 'neg' : 'pos'}">${fmtGap(r.bestDeltaMs)}</span> <span class="muted">vs last time</span>` : ''}
          ${r?.consistency != null ? `<span class="muted" title="Consistency score of the session report (0–100)">consistency ${r.consistency}</span>` : ''}</span></span></a></li>`;
    }).join('')}</ul></div>`;

  // practice targets of the other cars and tracks (the last one's are in "Your next session")
  const lastKey = d.hero?.key;
  const others = d.targets.filter((g) => `${g.track}|${g.layout}|${g.car}` !== lastKey);
  const targets = others.length ? `<div class="card"><h2>Targets elsewhere</h2>${others.map((g) => `
      <div class="home-tg"><div class="row"><b>${combo(g)}</b><span class="muted">· ${esc(prettyName(g.car))}</span><span class="spacer"></span><a href="#/report?session=${g.sessionId}&tab=report" class="muted s">from ${esc(when(g.startedAt))}</a></div>
      <ol>${g.targets.map((t) => `<li>${esc(t.text)}</li>`).join('')}</ol>
      ${g.lastCheck ? `<p class="muted s" style="margin:0">Last time you met ${g.lastCheck.met} of ${g.lastCheck.of} targets.</p>` : ''}</div>`).join('')}</div>` : '';

  // goals, challenges and achievements (P9, src/goals.js + src/achievements.js): the open ones and what was reached lately
  const dev = d.development;
  const left = (t) => { const h = (t - Date.now()) / 3600e3; return h < 24 ? 'ends within a day' : `${Math.round(h / 24)} days left`; };
  const goals = dev ? `<div class="card"><div class="row"><h2 style="margin:0">Goals and challenges</h2><span class="spacer"></span><a href="#/development">Development ›</a></div>
    ${dev.metRecently.length ? `<ul class="home-list">${dev.metRecently.map((g) => `<li><a href="#/development"><span class="hl-main"><b>${esc(g.text)}</b><span class="hl-sub muted">${combo(g.combo)} · ${esc(prettyName(g.combo.car))}</span></span>
      <span class="hl-num"><span class="badge best">${g.challenge ? 'challenge done' : 'goal met'}</span><span class="hl-sub muted">${esc(ago(g.met.at))}</span></span></a></li>`).join('')}</ul>` : ''}
    ${dev.goals.length ? `<ul class="home-list">${dev.goals.map((g) => `<li><a href="#/development"><span class="hl-main">${esc(g.text)}<span class="hl-sub muted">${combo(g.combo)} · ${esc(prettyName(g.combo.car))}</span></span>
      <span class="hl-num">${g.challenge ? `<span class="badge chal">${esc(left(g.dueAt))}</span>` : ''}<span class="hl-sub muted">${esc(g.progressText)}</span></span></a></li>`).join('')}</ul>`
      : '<p class="muted" style="margin:8px 0 0">No open goals. Set one, or take a challenge suggested from your laps, on the <a href="#/development">Development</a> page.</p>'}
    <div class="row" style="margin-top:10px"><b>Achievements</b><span class="muted">${dev.achievements.unlocked} of ${dev.achievements.total}</span>${dev.achievements.fresh ? `<span class="badge best">${dev.achievements.fresh} new</span>` : ''}</div>
    ${dev.achievements.recent.length ? `<div class="home-ach muted s">${dev.achievements.recent.map((a) => `<span title="${esc(a.text)}">★ <b>${esc(a.title)}</b> · ${esc(ago(a.unlockedAt))}</span>`).join('')}</div>` : ''}</div>` : '';

  const trends = d.trends.length ? `<h2 class="home-h">Best lap per day <span class="muted s">your most driven cars and tracks · lower is faster · <span class="dot-best" aria-hidden="true"></span> new personal best</span></h2>
    <div class="home-trends">${d.trends.map((t, i) => `<div class="card"><div class="row"><b>${combo(t)}</b><span class="spacer"></span><a href="#/progress?combo=${encodeURIComponent(t.key)}" class="s">Progress ›</a></div>
      <div class="muted s">${esc(prettyName(t.car))} · best <b class="best">${fmt(t.bestMs)}</b>${t.idealMs ? ` · ideal ${fmt(t.idealMs)}` : ''}</div>
      ${spark(t.days, i)}</div>`).join('')}</div>` : '';

  const records = `<div class="card"><h2>Your records</h2><div class="tablewrap"><table class="home-rec"><thead><tr><th>Track</th><th>Car</th><th>Best lap</th><th title="Your best corners, from any lap, put together">Ideal lap</th><th title="Best lap minus ideal lap">Could gain</th><th title="Performance score of your last ${d.scoreLaps} laps here, 0–100 (calculated). ${esc(d.scoreFormula || '')}">Score</th><th>Laps</th><th>Last driven</th><th></th></tr></thead>
    <tbody>${d.records.map((c) => `<tr><td>${combo(c)}</td><td>${esc(prettyName(c.car))}</td>
      <td>${c.bestMs != null ? `<b class="best">${fmt(c.bestMs)}</b>` : '<span class="muted">no valid lap</span>'}</td>
      <td>${c.idealMs ? fmt(c.idealMs) : '–'}</td><td>${c.idealMs && c.bestMs ? fmtGap(c.bestMs - c.idealMs) : '–'}</td>
      <td>${scoreCell(c)}</td><td>${c.validLaps}<span class="muted"> / ${c.laps}</span></td><td class="muted">${esc(ago(c.lastAt))}</td>
      <td style="white-space:nowrap"><button class="small primary beat" data-beat="${esc(c.key)}" title="Start a practice session on this car and track in AC EVO now (90 minutes, clear weather, optimum grip)">Beat it ▸</button>
        <a href="#/progress?combo=${encodeURIComponent(c.key)}">Progress</a>${c.bestLapId && c.idealMs ? ` · <a href="#/compare?laps=${c.bestLapId}&ref=ideal">Best against ideal</a>` : ''}</td></tr>`).join('')}</tbody></table></div></div>`;

  view.innerHTML = `<div class="race-head"><div><h1>Home</h1></div><span class="spacer"></span><a href="#/race"><button>Set up a session</button></a></div>
    ${hero}<div class="home-next-row${warnings && next ? '' : ' one'}">${next}${warnings}</div>${tiles}
    <div class="grid-2"><div>${sessions}${boardCard(board)}</div><div>${goals}${targets}</div></div>${trends}${records}`;
  bindSparks(view, d.trends, cleanup);
  // the car render is optional: no render (a mod car, or the game's files can't be read) leaves the track alone
  view.querySelector('.hero-car-img')?.addEventListener('error', (e) => e.target.remove());
  // "Beat it": this car and track as a practice session in the game, right now; progress shows on the Race tab
  view.querySelectorAll('[data-beat]').forEach((b) => {
    b.onclick = async () => {
      const c = d.records.find((x) => x.key === b.dataset.beat);
      if (!c) return;
      b.disabled = true;
      try {
        let g = null; try { g = await api('/api/race/status'); } catch { /* unknown: just try */ }
        if (g?.inSession && !confirm('A session is running in the game.\n\nEnd it and start a practice session?')) { b.disabled = false; return; }
        await post('/api/race/hotlap', { track: c.track, layout: c.layout, car: c.car, endSession: !!g?.inSession });
        location.hash = '#/race';
      } catch (e) { b.disabled = false; alert(`Could not start the session: ${e.message}`); }
    };
  });
}

// ---------------------------------------------------------------- hero: the last session, its records and the track
function heroHtml(d) {
  const s = d.recentSessions[0], h = d.hero;
  if (!s) return '';
  const r = s.report, n = d.lastNotes;
  const gain = h?.idealMs && h?.bestMs ? h.bestMs - h.idealMs : null;
  const delta = r?.newPb ? '<span class="badge best">New PB</span>'
    : r?.bestDeltaMs != null ? `<span class="${r.bestDeltaMs <= 0 ? 'neg' : 'pos'}">${fmtGap(r.bestDeltaMs)}</span> vs the session before` : '';
  const num = (k, v, sub, cls = '') => `<div class="hero-num"><span class="k">${k}</span><span class="v ${cls}">${v}</span><span class="s">${sub || '&nbsp;'}</span></div>`;
  const record = d.records.find((c) => c.key === h?.key);
  return `<section class="card hero" aria-labelledby="heroT">
    <div class="hero-txt">
      <div class="eyebrow">Last session · ${esc(when(s.startedAt))} · ${plural(s.laps, 'lap')}${s.validLaps !== s.laps ? `, ${s.validLaps} valid` : ''}</div>
      <a id="heroT" class="hero-title" href="#/report?session=${s.id}">${esc(prettyName(s.track))} <span>${esc(prettyName(s.layout))}</span></a>
      <div class="hero-car">${esc(prettyName(s.car))}</div>
      <div class="hero-nums">
        ${num('Session best', s.bestMs != null ? fmt(s.bestMs) : '–', delta, r?.newPb ? 'best' : '')}
        ${h?.bestMs != null ? num('Personal best', fmt(h.bestMs), h.bestAt ? `set ${esc(ago(h.bestAt))}` : '', 'best') : ''}
        ${gain > 0 ? num('Ideal lap', fmt(h.idealMs), `<span class="neg">${fmtGap(-gain)}</span> to find ${info('Your best corners from any lap here, put together. The gap to your personal best is time you have already driven, just not all in one lap.')}`) : ''}
      </div>
      <div class="row hero-actions">
        <a href="#/report?session=${s.id}"><button>Session report</button></a>
        ${record?.bestLapId && record.idealMs ? `<a href="#/compare?laps=${record.bestLapId}&ref=ideal"><button class="ghost">Best against ideal</button></a>` : ''}
      </div>
      <div class="hero-notes">${n?.tags?.length ? n.tags.map((t) => `<span class="tag-chip">${esc(t)}</span>`).join(' ') : ''}
        ${n?.note ? `<span class="muted s hn-note">“${esc(n.note)}”</span>` : `<a class="muted s" href="#/report?session=${s.id}&notes=1">Add a note or tags</a>`}</div>
    </div>
    <div class="hero-art" aria-hidden="true">${h?.carId ? `<img class="hero-car-img" alt="" src="${thumbUrl(h.carId)}">` : ''}${outlineSvg(h?.outline)}</div>
  </section>`;
}

// the track from your best lap's positions: a dark road, the lime line drawing itself in, a dot lapping it
function outlineSvg(o) {
  if (!o?.points?.length) return '';
  const [sx, sy] = o.points[0], [ex, ey] = o.points.at(-1);
  const path = `M${o.points.map((p) => p.join(',')).join('L')}${Math.hypot(ex - sx, ey - sy) < 60 ? 'Z' : ''}`;
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  return `<svg class="hero-map${getMirror() ? ' mirror' : ''}" viewBox="-80 -80 1160 1160" preserveAspectRatio="xMidYMid meet">
    <path class="hm-road" d="${path}"/><path class="hm-line" d="${path}" pathLength="1"/>
    <circle class="hm-start" cx="${sx}" cy="${sy}" r="15"/>
    ${still ? '' : `<circle class="hm-car" r="13"><animateMotion dur="14s" begin="1.4s" repeatCount="indefinite" path="${path}"/></circle>`}</svg>`;
}

// ---------------------------------------------------------------- your next session: one card with what to do next
function nextHtml(d) {
  const o = d.objective, a = d.nextAction, p = d.recentProgress;
  if (!o && !a) return '';
  const last = d.recentSessions[0];
  const lastKey = last ? `${last.track}|${last.layout}|${last.car}` : null;
  const c = o?.combo || a || last;
  const key = c ? `${c.track}|${c.layout}|${c.car}` : null;
  const record = d.records.find((x) => x.key === key);
  const kind = { goal: 'Goal', challenge: 'Challenge', plan: 'Training plan', targets: 'Practice targets' }[o?.kind];
  // the last report's targets, when the objective is something else (a goal or a plan) on the same car and track
  const lastTg = o?.kind !== 'targets' ? d.targets.find((g) => `${g.track}|${g.layout}|${g.car}` === lastKey && key === lastKey) : null;
  const focus = !o ? ''
    : o.kind === 'goal' || o.kind === 'challenge'
      ? `<p class="nx-goal"><span class="badge chal">${kind}</span> <b>${esc(o.text)}</b></p>${o.progress ? `<p class="muted s" style="margin:4px 0 0">${esc(o.progress)}</p>` : ''}`
      : `<p class="nx-kind"><span class="badge">${kind}</span></p><ol class="nx-items">${o.items.map((t) => `<li>${esc(t)}</li>`).join('')}</ol>`;
  const more = lastTg ? `<p class="nx-kind"><span class="badge">From the last report</span></p><ol class="nx-items">${lastTg.targets.slice(0, 3).map((t) => `<li>${esc(t.text)}</li>`).join('')}</ol>` : '';
  const step = a ? `<div class="nx-step"><span class="nx-arrow" aria-hidden="true">→</span><div><b>${esc(a.text)}</b> ${info(a.evidence, 'Why')}</div>
      <a href="${esc(a.href)}"><button class="small">${esc(a.label)}</button></a></div>` : '';
  const prog = p ? `<p class="muted s nx-prog">Last ${p.days} days: ${plural(p.combos, 'car and track')} driven, ${p.newBests ? `<b class="best">${plural(p.newBests, 'new personal best')}</b>` : 'no new personal best yet'}.${p.latest.length ? ` ${info(`Latest: ${p.latest.map((x) => `${prettyName(x.track)} · ${prettyName(x.car)} ${fmt(x.bestMs)}`).join('; ')}`)}` : ''}</p>` : '';
  return `<section class="card nx" aria-labelledby="nxT">
    <div class="row nx-head"><h2 id="nxT">Your next session</h2><span class="spacer"></span>${c ? `<span class="muted s">${combo(c)} · ${esc(prettyName(c.car))}</span>` : ''}</div>
    ${focus}${more}${step}
    <div class="row nx-foot">${record ? `<button class="primary" data-beat="${esc(record.key)}" title="Start a practice session on this car and track in AC EVO now">Practise now ▸</button>` : ''}
      ${o?.href && o.href.split('&')[0] !== a?.href?.split('&')[0] ? `<a href="${esc(o.href)}">${o.kind === 'plan' ? 'Coach' : o.kind === 'targets' ? 'Session report' : 'Development'} ›</a>` : ''}<span class="spacer"></span></div>
    ${prog}</section>`;
}

// ---------------------------------------------------------------- sparkline: one line, the day's best lap
const W = 320, H = 84, PAD = { l: 4, r: 4, t: 8, b: 8 };
function geometry(days) {
  const ys = days.map((x) => x.bestMs);
  let lo = Math.min(...ys), hi = Math.max(...ys);
  if (hi - lo < 200) { const m = (hi + lo) / 2; lo = m - 100; hi = m + 100; } // a flat line stays readable
  const x = (i) => PAD.l + (days.length === 1 ? (W - PAD.l - PAD.r) / 2 : (i * (W - PAD.l - PAD.r)) / (days.length - 1));
  const y = (v) => H - PAD.b - ((v - lo) / (hi - lo)) * (H - PAD.t - PAD.b); // lap time upwards: higher = slower, as on the Progress page
  return { x, y };
}
// markers are HTML dots over the stretched SVG, so they stay round at any width
const pos = (vx, vy) => `left:${((vx / W) * 100).toFixed(2)}%;top:${((vy / H) * 100).toFixed(2)}%`;
function spark(days, idx) {
  if (days.length < 2) return `<p class="muted s" style="margin:8px 0 0">${days.length ? 'One driving day so far: the trend starts with the second.' : 'No valid laps yet.'}</p>`;
  const { x, y } = geometry(days);
  const pts = days.map((d, i) => `${x(i).toFixed(1)},${y(d.bestMs).toFixed(1)}`).join(' ');
  const label = `Best lap per driving day, ${days.length} days, from ${fmt(days[0].bestMs)} on ${dayTxt(days[0].day)} to ${fmt(days.at(-1).bestMs)} on ${dayTxt(days.at(-1).day)}`;
  return `<div class="spark" data-spark="${idx}"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(label)}">
      <polyline points="${pts}" class="sp-line"/>
      <line class="sp-cross" x1="0" x2="0" y1="0" y2="${H}" visibility="hidden"/></svg>
    ${days.map((d, i) => (d.newBest ? `<i class="sp-pt sp-best" style="${pos(x(i), y(d.bestMs))}"></i>` : '')).join('')}<i class="sp-pt sp-dot" hidden></i>
    <div class="sp-tip" hidden></div></div>
    <div class="row muted s sp-axis"><span>${esc(dayTxt(days[0].day))}</span><span class="spacer"></span><span>${esc(dayTxt(days.at(-1).day))}</span></div>`;
}
// hover: a crosshair on the nearest day and a tooltip with its numbers
function bindSparks(view, trends) {
  view.querySelectorAll('[data-spark]').forEach((box) => {
    const days = trends[+box.dataset.spark].days;
    const { x, y } = geometry(days);
    const svg = box.querySelector('svg'), cross = svg.querySelector('.sp-cross'), dot = box.querySelector('.sp-dot'), tip = box.querySelector('.sp-tip');
    const show = (ev) => {
      const r = svg.getBoundingClientRect();
      const vx = ((ev.clientX - r.left) / r.width) * W;
      let i = 0; for (let k = 1; k < days.length; k++) if (Math.abs(x(k) - vx) < Math.abs(x(i) - vx)) i = k;
      const d = days[i];
      cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
      dot.setAttribute('style', pos(x(i), y(d.bestMs))); dot.hidden = false;
      tip.innerHTML = `<b>${esc(dayTxt(d.day))}</b><br>best ${fmt(d.bestMs)}${d.newBest ? ' <span class="badge best">New PB</span>' : ''}<br><span class="muted">${plural(d.laps, 'lap')}</span>`;
      tip.hidden = false;
      const px = (x(i) / W) * r.width;
      tip.style.left = `${Math.min(Math.max(0, px - 60), r.width - 130)}px`;
    };
    const hide = () => { cross.setAttribute('visibility', 'hidden'); dot.hidden = true; tip.hidden = true; };
    svg.addEventListener('pointermove', show); svg.addEventListener('pointerdown', show); svg.addEventListener('pointerleave', hide);
  });
}

// the performance score (src/analysis.js performanceScore) of the last laps, with its parts; links to the breakdown
function scoreCell(c) {
  const s = c.score;
  if (!s || s.score == null) return `<span class="muted" title="${esc(`No score yet: ${s?.reason || 'no laps'}.`)}">–</span>`;
  return `<a href="#/consistency?combo=${encodeURIComponent(c.key)}" title="Pace ${s.pace} · consistency ${s.consistency} · validity ${s.validity} (calculated). Click for the breakdown."><b>${s.score}</b></a>`;
}
