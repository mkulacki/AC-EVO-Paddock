// Development (P9, #/development): your goals and challenges (checked automatically against the laps you drive),
// challenges Paddock suggests from your laps, a session planner (car + track, a Race tab preset, a goal), your
// achievements and the race weekends you started from Paddock. Data: /api/development (src/goals.js,
// src/achievements.js, src/weekends.js).
import { esc, api, post, fmt, prettyName, emptyHtml, SESSION_TYPES } from './util.js';

const day = (t) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const when = (t) => new Date(t).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const comboTxt = (c) => `${esc(prettyName(c.track))} <span class="muted">${esc(prettyName(c.layout))}</span> · ${esc(prettyName(c.car))}`;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const left = (t) => { const d = Math.ceil((t - Date.now()) / 86400e3); return d <= 0 ? 'ends today' : d === 1 ? '1 day left' : `${d} days left`; };
/** "1:42.3", "102.3", "1:42" -> ms, or null */
export function parseLap(s) {
  const m = /^\s*(?:(\d+):)?(\d{1,2}(?:[.,]\d{1,3})?)\s*$/.exec(String(s || ''));
  if (!m) return null;
  const sec = Number(m[2].replace(',', '.'));
  if (m[1] != null && sec >= 60) return null;
  return Math.round(((Number(m[1] || 0) * 60) + sec) * 1000);
}

export async function viewDevelopment(view, cleanup) {
  const d = await api('/api/development');
  const head = `<div class="race-head"><div><h1>Development</h1><div class="sub">Goals, challenges, achievements and race weekends, from your own laps.</div></div></div>`;
  if (!d.combos.length) {
    view.innerHTML = head + emptyHtml('Drive a few laps first', 'Goals and challenges are set per car and track and checked against the laps you drive. Achievements come with your laps too.',
      '<a href="#/race"><button class="primary">Set up a session</button></a>');
    return;
  }
  const open = d.goals.filter((g) => g.state === 'open'), done = d.goals.filter((g) => g.state !== 'open');
  view.innerHTML = `${head}
    <div class="dev-grid">
      <div class="card" id="dvGoals"><div class="row"><h2 style="margin:0">Goals and challenges</h2><span class="spacer"></span><button class="small" id="dvNew">New goal</button></div>
        <p class="muted s" style="margin:4px 0 10px">Checked automatically against the laps you drive after setting one. A challenge is a goal with a deadline.</p>
        <div id="dvForm" hidden></div>
        ${open.length ? `<ul class="goal-list">${open.map(goalHtml).join('')}</ul>` : '<p class="muted" style="margin:0">No open goals. Set one, or take a suggested challenge.</p>'}
        ${done.length ? `<details class="goal-done"><summary>Met and missed (${done.length})</summary><ul class="goal-list">${done.map(goalHtml).join('')}</ul></details>` : ''}</div>
      <div class="card" id="dvPlan"></div>
    </div>
    ${d.suggestions.length ? `<div class="card"><h2>Suggested challenges</h2><p class="muted s" style="margin:-4px 0 10px">From your laps of the last 30 days. Take one and it is checked from now on${d.suggestions.some((x) => x.days) ? ` (challenges run ${d.suggestions.find((x) => x.days)?.days} days)` : ''}.</p>
      <ul class="goal-list">${d.suggestions.map((s, i) => `<li class="goal sug"><div class="g-main"><b>${esc(s.text)}</b><div class="muted s">${comboTxt(s.combo)}</div><div class="muted s">${esc(s.why)}</div></div>
        <span class="g-state">${s.origin === 'plan' ? '<span class="badge">training plan</span>' : `<span class="muted s">${plural(s.days, 'day')}</span>`}</span><button class="small primary" data-take="${i}">${s.days ? 'Take challenge' : 'Make it a goal'}</button></li>`).join('')}</ul></div>` : ''}
    <div class="card" id="dvAch"></div>
    <div class="card" id="dvWeekends"></div>`;

  // ---- goals: new, remove, take a suggestion
  const form = view.querySelector('#dvForm');
  view.querySelector('#dvNew').onclick = () => { form.hidden = !form.hidden; if (!form.hidden) drawForm(form, d, rerender); };
  view.querySelectorAll('[data-rm-goal]').forEach((b) => (b.onclick = async () => {
    if (!confirm('Remove this goal?')) return;
    try { await post('/api/goals', { action: 'remove', id: Number(b.dataset.rmGoal) }); rerender(); } catch (e) { alert(e.message); }
  }));
  view.querySelectorAll('[data-take]').forEach((b) => (b.onclick = async () => {
    const s = d.suggestions[+b.dataset.take];
    b.disabled = true;
    try { await post('/api/goals', { combo: s.combo, kind: s.kind, target: s.target, extra: s.extra, days: s.days, origin: s.origin }); rerender(); }
    catch (e) { b.disabled = false; alert(e.message); }
  }));
  // the shell draws the page again (its own cleanup runs first)
  function rerender() { if (view.isConnected) window.dispatchEvent(new HashChangeEvent('hashchange')); }

  drawPlanner(view.querySelector('#dvPlan'), d);
  drawAchievements(view.querySelector('#dvAch'), d.achievements);
  drawWeekends(view.querySelector('#dvWeekends'), d.weekends);
  if (d.achievements.items.some((a) => a.isNew)) post('/api/achievements/seen', {}).catch(() => {}); // seen now: "new" until the next visit
  // a goal met or an achievement reached while this page is open
  const onEv = () => rerender();
  window.addEventListener('paddock:development', onEv);
  cleanup.push(() => window.removeEventListener('paddock:development', onEv));
}

function goalHtml(g) {
  const st = g.state === 'met' ? `<span class="badge best">${g.challenge && !g.metInTime ? 'met late' : 'met'}</span><span class="muted s">${esc(day(g.met.at))}</span>`
    : g.state === 'missed' ? '<span class="badge">missed</span><span class="muted s">deadline passed</span>'
      : g.challenge ? `<span class="badge chal">challenge</span><span class="muted s">${esc(left(g.dueAt))}</span>` : '<span class="muted s">open</span>';
  const link = g.met?.sessionId ? `<a class="s" href="#/report?session=${g.met.sessionId}">session</a>` : '';
  return `<li class="goal g-${g.state}"><div class="g-main"><b>${esc(g.text)}</b><div class="muted s">${comboTxt(g.combo)}</div>
      <div class="muted s">${g.state === 'met' ? `${link}` : esc(g.progressText)} · set ${esc(day(g.createdAt))}</div></div>
    <span class="g-state">${st}</span><button class="small ghost" data-rm-goal="${g.id}" title="Remove" aria-label="Remove this goal">×</button></li>`;
}

function drawForm(box, d, done) {
  const opt = (c) => `<option value="${esc(c.key)}">${esc(prettyName(c.track))} ${esc(prettyName(c.layout))} · ${esc(prettyName(c.car))}</option>`;
  box.innerHTML = `<div class="goal-form">
    <label>Car and track<select id="gfCombo">${d.combos.map(opt).join('')}</select></label>
    <label>Goal<select id="gfKind"><option value="lap">Lap time</option><option value="window">Laps close to a time</option><option value="streak">Valid laps in a row</option><option value="consistency">Consistency score</option></select></label>
    <div id="gfTarget" class="row" style="gap:8px;flex-wrap:wrap"></div>
    <label>Deadline<select id="gfDays"><option value="">None (a goal)</option><option value="3">3 days (a challenge)</option><option value="7">7 days (a challenge)</option><option value="14">14 days (a challenge)</option><option value="30">30 days (a challenge)</option></select></label>
    <div class="row"><button class="primary" id="gfSave">Save</button><span class="pos s" id="gfErr"></span></div></div>`;
  const $f = (s) => box.querySelector(s);
  const combo = () => d.combos.find((c) => c.key === $f('#gfCombo').value);
  const drawTarget = () => {
    const c = combo(), k = $f('#gfKind').value, best = c?.bestMs;
    $f('#gfTarget').innerHTML = k === 'lap' ? `<label>Lap time<input id="gfT" placeholder="${best ? fmt(best - 100) : '1:42.000'}" value="${best ? fmt(best - 100) : ''}"></label><span class="muted s">${best ? `your best ${fmt(best)}` : ''}</span>`
      : k === 'window' ? `<label>Laps<input id="gfT" type="number" min="2" max="100" value="5"></label><label>within (s)<input id="gfW" type="number" min="0.05" max="5" step="0.05" value="0.5"></label><span class="muted s">${best ? `of your best, ${fmt(best)}` : 'needs a valid lap'}</span>`
        : k === 'streak' ? '<label>Laps in a row<input id="gfT" type="number" min="2" max="200" value="10"></label>'
          : '<label>Score (0–100)<input id="gfT" type="number" min="1" max="100" value="85"></label><span class="muted s">the session report\'s consistency score</span>';
  };
  $f('#gfCombo').onchange = drawTarget; $f('#gfKind').onchange = drawTarget; drawTarget();
  $f('#gfSave').onclick = async () => {
    const k = $f('#gfKind').value, raw = $f('#gfT').value;
    const target = k === 'lap' ? parseLap(raw) : Number(raw);
    if (target == null || !Number.isFinite(target)) { $f('#gfErr').textContent = k === 'lap' ? 'Write the lap time as 1:42.300' : 'Enter a number'; return; }
    const body = { key: $f('#gfCombo').value, kind: k, target, days: $f('#gfDays').value || null };
    if (k === 'window') body.extra = { windowMs: Math.round(Number($f('#gfW').value) * 1000) };
    try { await post('/api/goals', body); done(); } catch (e) { $f('#gfErr').textContent = e.message; }
  };
}

// ---- session planner: a car + track you drove, how (hotlap, practice or a Race tab preset), and the goal it is for
function drawPlanner(box, d) {
  const startable = d.combos.filter((c) => c.canStart);
  if (!startable.length) { box.innerHTML = '<h2>Plan a session</h2><p class="muted" style="margin:0">None of your cars and tracks is in the game\'s track list, so Paddock cannot start them.</p>'; return; }
  box.innerHTML = `<h2>Plan a session</h2><p class="muted s" style="margin:-4px 0 10px">Paddock sets up the session in AC EVO for you, as the Race tab does. The goal you pick shows with the session in your history.</p>
    <div class="goal-form">
      <label>Car and track<select id="spCombo">${startable.map((c) => `<option value="${esc(c.key)}">${esc(prettyName(c.track))} ${esc(prettyName(c.layout))} · ${esc(prettyName(c.car))}</option>`).join('')}</select></label>
      <label>For goal<select id="spGoal"></select></label>
      <label>Session<select id="spPreset"><option value="hotlap">Hotlap: clear weather, optimum grip</option><option value="practice">Practice: 30 minutes, clear, optimum grip</option>
        ${d.presets.length ? `<optgroup label="Your Race tab presets">${d.presets.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</optgroup>` : ''}</select></label>
      <p class="muted s" style="margin:0">A preset keeps its session type, weather and AI; the car and track are the ones picked here.</p>
      <div class="row"><button class="primary" id="spStart">Start in AC EVO</button><span class="pos s" id="spErr"></span></div></div>`;
  const $p = (s) => box.querySelector(s);
  const goalsFor = () => {
    const k = $p('#spCombo').value;
    const gs = d.goals.filter((g) => g.state === 'open' && `${g.combo.track}|${g.combo.layout}|${g.combo.car}` === k);
    $p('#spGoal').innerHTML = `<option value="">${gs.length ? 'None' : 'No open goal here'}</option>${gs.map((g) => `<option value="${g.id}">${esc(g.text)}</option>`).join('')}`;
    if (gs.length) $p('#spGoal').value = String(gs[0].id);
  };
  $p('#spCombo').onchange = goalsFor; goalsFor();
  $p('#spStart').onclick = async () => {
    const btn = $p('#spStart');
    let endSession = false;
    try {
      const g = await api('/api/race/status').catch(() => null);
      if (g?.inSession) { if (!confirm('A session is running in the game.\n\nEnd it and start this one?')) return; endSession = true; }
      btn.disabled = true;
      await post('/api/development/start', { key: $p('#spCombo').value, goalId: $p('#spGoal').value ? Number($p('#spGoal').value) : null, preset: $p('#spPreset').value, endSession });
      location.hash = '#/race'; // the launch progress shows there
    } catch (e) { btn.disabled = false; $p('#spErr').textContent = e.message; }
  };
}

function drawAchievements(box, a, all = false) {
  // per ladder (laps-1, laps-100, ...): the steps reached and the next one; "Show all" lists every step
  const groups = new Map(), nextShown = new Set();
  for (const x of a.items) {
    const ladder = x.id.replace(/-\d+$/, '');
    if (!all && !x.unlockedAt) { if (nextShown.has(ladder)) continue; nextShown.add(ladder); }
    if (!groups.has(x.group)) groups.set(x.group, []);
    groups.get(x.group).push(x);
  }
  const need = (x) => (x.id.startsWith('km') ? `${x.have} of ${x.need} km` : x.id.startsWith('consistency') ? `best score so far: ${x.have || 'none'}` : `${x.have} of ${x.need}`);
  box.innerHTML = `<div class="row"><h2 style="margin:0">Achievements</h2><span class="spacer"></span><span class="muted">${a.unlocked} of ${a.total} reached</span>
      <button class="small ghost" id="achAll">${all ? 'Show next steps only' : 'Show all steps'}</button></div>
    <p class="muted s" style="margin:4px 0 12px">Worked out from your laps, sessions, goals and race weekends, with the day each was reached.${all ? '' : ' Shown: what you reached and the next step of each.'}</p>
    <div class="ach-groups">${[...groups].map(([g, xs]) => `<div><h3>${esc(g)}</h3><ul class="ach-list">${xs.map((x) => `<li class="ach ${x.unlockedAt ? 'got' : 'locked'}${x.isNew ? ' new' : ''}">
      <span class="ach-ic" aria-hidden="true">${x.unlockedAt ? '★' : '☆'}</span><span class="ach-t"><b>${esc(x.title)}</b>${x.isNew ? ' <span class="badge best">new</span>' : ''}<span class="muted s">${esc(x.text)}</span>
      <span class="s ${x.unlockedAt ? '' : 'muted'}">${x.unlockedAt ? `reached ${esc(day(x.unlockedAt))}` : esc(need(x))}</span></span>
      ${x.unlockedAt ? '' : `<span class="ach-bar" aria-hidden="true"><i style="width:${Math.round((100 * x.have) / x.need)}%"></i></span>`}</li>`).join('')}</ul></div>`).join('')}</div>`;
  box.querySelector('#achAll').onclick = () => drawAchievements(box, a, !all);
}

function drawWeekends(box, ws) {
  box.innerHTML = `<h2>Race weekends</h2>${ws.length ? `<p class="muted s" style="margin:-4px 0 10px">Race weekends started from Paddock, with the sessions you drove in them (by time, car and track: the game does not say which part of the weekend a session was).</p>
    <ul class="wk-list">${ws.map((w) => `<li><div class="row"><b>${esc(w.summary || 'Race weekend')}</b><span class="spacer"></span><span class="muted s">${esc(when(w.at))}</span></div>
      ${w.sessions.length ? `<table class="wk-table"><thead><tr><th>Session</th><th>Started</th><th>Laps</th><th>Best lap</th><th></th></tr></thead><tbody>${w.sessions.map((s, i) => `<tr>
        <td>${i + 1}. ${esc(SESSION_TYPES[s.type] || 'Session')}</td><td class="muted">${esc(new Date(s.startedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }))}</td>
        <td>${s.validLaps}<span class="muted"> / ${s.laps}</span></td><td>${s.bestMs != null ? `<b class="${s.id === w.bestSession ? 'best' : ''}">${fmt(s.bestMs)}</b>` : '<span class="muted">–</span>'}</td>
        <td><a href="#/report?session=${s.id}">${s.hasReport ? 'Report' : 'Laps'}</a></td></tr>`).join('')}</tbody></table>`
        : '<p class="muted s" style="margin:4px 0 0">No laps recorded in this weekend.</p>'}</li>`).join('')}</ul>`
    : '<p class="muted" style="margin:0">None yet. Start a race weekend from the <a href="#/race">Race</a> tab (or with a preset here) and its sessions are grouped here.</p>'}`;
}
