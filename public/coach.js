// AI coach (P8) for one track + car: a chat that knows your history there, your training plan checked against the
// following sessions, and braking points suggested by the AI that you apply only after looking at them.
// Data: /api/coach, /api/plan, /api/coach/brakes (src/coach.js). Without ?combo the page lists the combos to pick.
import { $, esc, api, post, fmt, prettyName, emptyHtml, prov, md, aiConfidence } from './util.js';

const day = (t) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const when = (t) => new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const mark = (met) => (met === true ? '<span class="neg" title="Met">✔</span>' : met === false ? '<span class="pos" title="Not met">✘</span>' : '<span class="muted" title="Could not be checked">·</span>');
const confBadge = (lv) => (lv ? `<span class="conf conf-${esc(lv)}">${esc(lv)}</span>` : '<span class="muted">–</span>');

export async function viewCoach(view, params, cleanup) {
  const key = params.get('combo');
  if (!key) return pickCombo(view);
  const [track, layout, car] = key.split('|');
  const q = new URLSearchParams({ track, layout, car });
  const data = await api(`/api/coach?${q}`);
  const enc = encodeURIComponent(key);
  const head = `<div class="cmp-head">
      <a href="#/"><button class="ghost">Back to laps</button></a>
      <div><h1>Coach at ${esc(prettyName(track))} <span class="muted">${esc(prettyName(layout))}</span></h1>
        <div class="secondary">${esc(prettyName(car))} · ${data.validLaps} valid of ${data.laps} laps</div></div><span class="spacer"></span>
      <a href="#/setuphistory?combo=${enc}"><button>Setup history</button></a>
      ${data.validLaps >= 2 ? `<a href="#/consistency?combo=${enc}"><button>Consistency</button></a>` : ''}</div>`;
  if (!data.laps) { view.innerHTML = head + emptyHtml('No laps here yet', 'Drive this car on this track: the coach works from your laps and session reports.', '<a href="#/race"><button>Set up a session</button></a><a href="#/"><button>Sessions</button></a>'); return; }
  const noKey = data.hasKey ? '' : `<div class="card plain note-warn" style="margin-bottom:12px">The coach uses Google Gemini. Add a free API key in <a href="#/settings">Settings</a> to chat and get braking points. The training plan works without one.</div>`;

  view.innerHTML = `${head}${noKey}
    <div class="coach-grid">
      <div class="card coach-chat"><div class="row" style="flex-wrap:wrap;gap:8px"><h2 style="margin:0">Ask your coach</h2><span class="spacer"></span>
          <a class="hint" href="/api/coach/context?${q}" target="_blank" title="The instructions and the data (your history here, as JSON) sent with every question">What is sent to the AI?</a>
          <button class="small ghost" id="chClear" ${data.messages.length ? '' : 'hidden'}>Clear chat</button></div>
        <p class="muted" style="font-size:12px;margin:4px 0 10px">The coach gets a summary of your laps, session reports, driving style, setups and training plan here, never raw telemetry. Each answer rates its own confidence.</p>
        <div id="chLog" class="chat-log"></div>
        <div class="row chat-in"><input id="chQ" maxlength="1000" placeholder="${data.hasKey ? 'e.g. “What should I work on next session?”' : 'Add a Gemini key in Settings to ask'}" ${data.hasKey ? '' : 'disabled'}>
          <button class="primary" id="chAsk" ${data.hasKey ? '' : 'disabled'}>Ask</button></div></div>
      <div class="card" id="planCard"></div>
    </div>
    <div class="card" id="brakeCard"></div>`;

  // ---- chat
  const log = $('#chLog');
  const msgHtml = (m) => (m.role === 'driver'
    ? `<div class="chat-msg me"><div class="who">You · ${esc(when(m.at))}</div>${esc(m.text)}</div>`
    : `<div class="chat-msg coach"><div class="who">Coach · ${esc(m.model || '')} · ${esc(when(m.at))}</div><div class="ai-out">${md(m.text)}</div>${aiConfidence(m.confidence)}</div>`);
  const drawLog = (msgs) => {
    log.innerHTML = msgs.length ? msgs.map(msgHtml).join('') : `<p class="muted" style="margin:0">No questions yet. Ask about where you lose time, what to practise, or how a setup compares.</p>`;
    log.scrollTop = log.scrollHeight;
  };
  drawLog(data.messages);
  // this page's own elements: an answer arriving after you left must not touch the next page
  const input = $('#chQ'), askBtn = $('#chAsk'), clearBtn = $('#chClear');
  let busy = false;
  const ask = async () => {
    const text = input.value.trim();
    if (!text || busy) return;
    busy = true; askBtn.disabled = true;
    if (!log.querySelector('.chat-msg')) log.innerHTML = '';
    log.insertAdjacentHTML('beforeend', `<div class="chat-msg me pending"><div class="who">You</div>${esc(text)}</div><p class="chat-wait"><span class="spinner"></span> The coach is reading your data…</p>`);
    log.scrollTop = log.scrollHeight;
    try {
      await post('/api/coach/ask', { track, layout, car, question: text });
      input.value = '';
      if (!log.isConnected) return;
      const fresh = (await api(`/api/coach?${q}`)).messages;
      if (!log.isConnected) return;
      drawLog(fresh);
      clearBtn.hidden = false;
    } catch (e) {
      if (!log.isConnected) return;
      log.querySelector('.chat-wait')?.remove();
      log.querySelector('.chat-msg.pending')?.remove();
      log.insertAdjacentHTML('beforeend', `<p class="pos chat-err">${esc(e.message)} <span class="muted">(your question was not sent to the chat history; it is still in the box)</span></p>`);
    } finally { busy = false; askBtn.disabled = !data.hasKey; }
  };
  askBtn.onclick = ask;
  input.onkeydown = (e) => { if (e.key === 'Enter') ask(); };
  clearBtn.onclick = async () => {
    if (!confirm('Delete this chat with the coach? Your laps, reports and plan stay.')) return;
    await post('/api/coach/clear', { track, layout, car });
    drawLog([]); clearBtn.hidden = true;
  };

  // ---- training plan
  const planBox = $('#planCard');
  const drawPlan = (plan) => {
    const box = planBox;
    if (!box.isConnected) return;
    if (!plan) {
      box.innerHTML = `<h2>Training plan</h2><p class="muted" style="margin:0 0 8px">No plan yet. A plan is the measurable targets of a session report (a lap time, corner times, consistency, track limits); every later session here is checked against them automatically.</p>
        ${data.reports.length ? `<ul class="plain-list">${data.reports.map((r) => `<li class="row" style="gap:8px"><span>${esc(day(r.startedAt))} <span class="muted">best ${fmt(r.bestMs)} · ${r.targets} targets</span></span><span class="spacer"></span>
          <a href="#/report?session=${r.sessionId}" class="hint">Report</a><button class="small" data-plan-from="${r.sessionId}">Use as plan</button></li>`).join('')}</ul>`
          : '<p class="muted" style="margin:0">Drive a session of 3 laps or more to get a report with targets.</p>'}`;
      box.querySelectorAll('[data-plan-from]').forEach((b) => { b.onclick = async () => { b.disabled = true; try { drawPlan((await post('/api/plan', { action: 'create', session: Number(b.dataset.planFrom) })).plan); } catch (e) { b.disabled = false; alert(e.message); } }; });
      return;
    }
    const ses = plan.sessions;
    const shown = ses.slice(-6);
    box.innerHTML = `<div class="row"><h2 style="margin:0">Training plan</h2><span class="spacer"></span><button class="small ghost" id="planEnd">End plan</button></div>
      <p class="muted" style="font-size:12px;margin:4px 0 10px">${prov('calculated', 'Checked from your lap and corner times.')} From the <a href="#/report?session=${plan.fromSession}">report of ${esc(day(plan.fromStartedAt))}</a>.
        ${ses.length ? `Checked against ${ses.length} later session${ses.length === 1 ? '' : 's'}${plan.allMetLast ? ': <b class="neg">all targets met last time</b>, time for a new plan' : ''}.` : 'Your next session here is checked against it automatically.'}</p>
      <div class="tablewrap"><table class="plan-table"><thead><tr><th>Target</th>${shown.map((s) => `<th title="${esc(when(s.startedAt))}"><a href="#/report?session=${s.sessionId}">${esc(new Date(s.startedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }))}</a></th>`).join('')}<th>Met</th><th></th></tr></thead>
        <tbody>${plan.targets.map((t, k) => `<tr><td>${esc(t.text)}${t.last ? `<div class="muted" style="font-size:12px">last: ${esc(t.last.actual)}</div>` : ''}</td>
          ${shown.map((s) => `<td class="c" title="${esc(s.skipped || s.items[k].actual)}">${s.skipped ? '<span class="muted">–</span>' : mark(s.items[k].met)}</td>`).join('')}
          <td class="c">${t.checked ? `${t.met} / ${t.checked}` : '–'}</td><td><button class="small ghost" data-rm="${k}" title="Remove this target from the plan">×</button></td></tr>`).join('')}</tbody></table></div>
      ${ses.length > shown.length || plan.olderSessions ? `<p class="muted" style="font-size:12px;margin:6px 0 0">The last ${shown.length} sessions are shown; "Met" counts the latest ${ses.length}${plan.olderSessions ? ` (${plan.olderSessions} older session${plan.olderSessions === 1 ? '' : 's'} not counted)` : ''}.</p>` : ''}
      ${ses.some((x) => x.skipped) ? `<p class="muted" style="font-size:12px;margin:6px 0 0">– = not checked (hover for why): sessions under 3 laps, without a valid lap, or still being driven.</p>` : ''}`;
    box.querySelector('#planEnd').onclick = async () => { if (confirm('End this training plan? You can make a new one from any report.')) drawPlan((await post('/api/plan', { action: 'close', id: plan.id })).plan); };
    box.querySelectorAll('[data-rm]').forEach((b) => { b.onclick = async () => drawPlan((await post('/api/plan', { action: 'remove', id: plan.id, index: Number(b.dataset.rm) })).plan); });
  };
  drawPlan(data.plan);

  // ---- braking points
  const mc = data.marksCombo;
  const trackHref = `#/track?id=${encodeURIComponent(mc.track)}&layout=${encodeURIComponent(mc.layout)}`;
  const brakeBox = $('#brakeCard');
  brakeBox.innerHTML = `<div class="row" style="flex-wrap:wrap;gap:8px"><h2 style="margin:0">Braking points</h2><span class="spacer"></span>
      <a class="hint" href="/api/coach/brakes/data?${q}" target="_blank">What is sent to the AI?</a>
      <button class="primary" id="bkAsk" ${data.hasKey ? '' : 'disabled title="Add a Gemini API key in Settings"'}>Suggest braking points</button></div>
    <p class="muted" style="font-size:12px;margin:4px 0 0">The AI looks at your fastest and your typical pass of each corner and suggests where to brake; the brake spotter then counts down to those points. Nothing changes until you tick points and apply them. You have <b id="bkCount">${data.brakeMarks}</b> brake mark${data.brakeMarks === 1 ? '' : 's'} here (<a href="${trackHref}">edit on the track map</a>).</p>
    <div id="bkOut"></div>`;
  let seq = 0;
  cleanup.push(() => { seq++; });
  brakeBox.querySelector('#bkAsk').onclick = async () => {
    const my = ++seq, out = brakeBox.querySelector('#bkOut'), btn = brakeBox.querySelector('#bkAsk');
    btn.disabled = true;
    out.innerHTML = '<p><span class="spinner"></span> Looking at your corners…</p>';
    let r;
    try { r = await post('/api/coach/brakes', { track, layout, car }); } catch (e) { if (my === seq) { out.innerHTML = `<p class="pos">${esc(e.message)}</p>`; btn.disabled = false; } return; }
    if (my !== seq || !out.isConnected) return;
    btn.disabled = false; btn.textContent = 'Suggest again';
    const m = (v) => (v == null ? '–' : `${v} m`);
    out.innerHTML = `<div class="ai-out" style="margin-top:10px">${md(r.summary)}</div>${aiConfidence(r.confidence)}
      ${r.suggestions.length ? `<div class="tablewrap"><table class="brake-sugg"><thead><tr><th></th><th>Corner</th><th>Suggested</th><th title="Your mark there now">Your mark</th><th title="Where your fastest recent pass of this corner started braking">Fastest pass</th><th title="Median of your latest laps">Typical</th><th>Why</th><th>Confidence</th></tr></thead>
        <tbody>${r.suggestions.map((s, i) => `<tr><td><input type="checkbox" data-i="${i}" aria-label="Apply ${esc(s.corner)}"></td><td><b>${esc(s.corner)}</b></td>
          <td><b>${s.m} m</b> <span class="muted">${s.kind}</span></td><td>${m(s.currentM)}${s.currentM != null ? ` <span class="muted">${esc(s.currentKind || '')}</span>` : ''}</td><td>${m(s.fastestM)}</td><td>${m(s.typicalM)}</td>
          <td style="min-width:28ch;max-width:60ch">${esc(s.reason)}</td><td>${confBadge(s.confidence)}</td></tr>`).join('')}</tbody></table></div>
        <div class="row" style="margin-top:8px;gap:8px"><button class="primary" id="bkApply" disabled>Apply ticked points to my brake marks</button><span class="muted" id="bkMsg" style="font-size:12px">Each ticked point replaces your mark in that corner; other corners keep theirs.</span></div>`
        : '<p class="muted">No changes suggested.</p>'}
      ${r.rejected.length ? `<p class="muted" style="font-size:12px;margin:8px 0 0">Left out by Paddock's checks: ${r.rejected.map((x) => `${esc(x.corner)}${x.brakeM != null ? ` ${x.brakeM} m` : ''} (${esc(x.why)})`).join('; ')}.</p>` : ''}
      <p class="muted" style="font-size:12px;margin:6px 0 0">${esc(r.model)}, from ${r.lapsUsed} recent valid laps. Distances are metres from the start/finish line.</p>`;
    const boxes = [...out.querySelectorAll('input[data-i]')];
    const apply = out.querySelector('#bkApply');
    if (!apply) return;
    boxes.forEach((b) => { b.onchange = () => { apply.disabled = !boxes.some((x) => x.checked); }; });
    apply.onclick = async () => {
      const items = boxes.filter((b) => b.checked).map((b) => r.suggestions[Number(b.dataset.i)]).map((s) => ({ corner: s.corner, m: s.m, kind: s.kind }));
      if (!items.length) return;
      apply.disabled = true;
      try {
        const res = await post('/api/coach/brakes/apply', { track, layout, car, items });
        brakeBox.querySelector('#bkCount').textContent = res.marks.length;
        out.querySelector('#bkMsg').innerHTML = `<span class="neg">Saved ${items.length} point${items.length === 1 ? '' : 's'}.</span> <a href="${trackHref}">See them on the track map</a>`;
        boxes.forEach((b) => { if (b.checked) { b.checked = false; b.disabled = true; } });
      } catch (e) { apply.disabled = false; out.querySelector('#bkMsg').innerHTML = `<span class="pos">${esc(e.message)}</span>`; }
    };
  };
}

async function pickCombo(view) {
  const ov = await api('/api/overview');
  const combos = (ov.combos || []).slice().sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0));
  view.innerHTML = `<div class="cmp-head"><div><h1>Coach</h1><div class="secondary">Pick a track and car: the coach works from your history there.</div></div></div>
    ${combos.length ? `<div class="card"><ul class="plain-list">${combos.map((c) => `<li><a href="#/coach?combo=${encodeURIComponent(c.key)}">${esc(prettyName(c.track))} <span class="muted">${esc(prettyName(c.layout))}</span> · ${esc(prettyName(c.car))}</a> <span class="muted">${c.laps} laps</span></li>`).join('')}</ul></div>`
    : emptyHtml('No laps yet', 'Drive a few laps first: the coach works from your laps and session reports.')}`;
}
