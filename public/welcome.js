// Setup guide (#/welcome, PL5): find the game -> check the connections -> privacy and optional services -> drive a
// first session -> open a useful comparison. Every step can be passed by; the AI, online accounts and game mods can
// each be skipped (the choice is only recorded: nothing is switched on or off). Nothing here needs an account.
// Paddock opens on it by itself only for a new driver (src/onboarding.js); otherwise it is in Settings and Ctrl+K.
import { esc, api, post, prettyName } from './util.js';
import { healthItemsHtml } from './game.js';

const STEPS = [
  ['game', 'Find AC EVO'], ['health', 'Check the connections'], ['privacy', 'Privacy and optional services'],
  ['drive', 'Drive a first session'], ['compare', 'Compare your laps'],
];
const yes = (ok, a, b) => `<span class="${ok ? 'g-ok' : 'g-bad'}">${ok ? '✔' : '✘'} ${ok ? a : b}</span>`;

export async function viewWelcome(view, params, cleanup) {
  let o = await api('/api/onboarding');
  let i = Math.max(0, STEPS.findIndex(([k]) => k === params.get('step')));
  let timer = null;
  const stop = () => { clearInterval(timer); timer = null; };
  cleanup.push(stop);

  const go = (k) => { i = Math.max(0, Math.min(STEPS.length - 1, k)); history.replaceState(null, '', `#/welcome?step=${STEPS[i][0]}`); draw(true); };
  const finish = async (action) => { stop(); try { await post('/api/onboarding', { action }); } catch { /* the guide is only a guide: Home anyway */ } location.hash = '#/home'; };

  // ---- the steps
  const skipBtn = (k, label) => (o.skipped.includes(k)
    ? `<span class="badge">Skipped</span> <button class="small ghost" data-unskip="${k}">Undo</button>`
    : `<button class="small ghost" data-skip="${k}">${label}</button>`);
  const body = {
    game: () => `<p>Paddock reads AC EVO's own files: its user folder (settings, setups, the game version) and its install (car and track names, maps). Both are found by themselves.</p>
      <ul class="wz-checks">
        <li>${yes(o.game.aceFound, "AC EVO's user folder found", "AC EVO's user folder not found")}</li>
        <li>${yes(o.game.contentFound, 'AC EVO install found (cars, tracks, maps)', 'AC EVO install not found (car and track names and maps are missing)')}</li></ul>
      ${o.game.aceFound && o.game.contentFound ? '<p class="neg" style="margin:8px 0 0">All found. Go on to the next step.</p>'
        : `<p class="hsteps-h">What to do</p><ol class="hsteps"><li>Start AC EVO once and let it reach its main menu: it creates its user folder then.</li>
          <li>If the game is installed somewhere unusual, set the folders in <a href="#/settings">Settings</a> (AC EVO folder, game files folder).</li>
          <li>Then press <b>Check again</b>.</li></ol>`}
      <div class="row" style="margin-top:10px"><button class="small" data-recheck>Check again</button></div>`,
    health: () => `<p>Whether Paddock and AC EVO are talking. Most parts show <b>Off</b> until the game runs: that is fine.</p>
      <ul class="health-list" id="wzHealth"><li class="muted">Checking…</li></ul>
      <div class="row" style="margin-top:10px"><button class="small" data-recheck>Check again</button><span class="spacer"></span><a href="#/game">Game page ›</a></div>`,
    privacy: () => `<p><b>Everything stays on this computer</b>: your laps, reports, notes, setups and settings are kept in Paddock's <code>data</code> folder. Recording, analysis, reports, goals and the HUD all work offline, without an account.</p>
      <p>These are optional. Each is off until you set it up, and you can skip it here.</p>
      <div class="wz-opt"><div><b>AI coach (Google Gemini)</b> ${o.services.ai ? '<span class="badge">Key set</span>' : '<span class="badge">Off</span>'}
          <p class="muted s">Needs your own free Gemini API key. Only when you ask (debrief, coach, setup engineer) a summary of the lap numbers is sent to Google. Nothing is sent without a key.</p></div>
        <div class="row">${o.services.ai ? '' : '<a href="#/settings"><button class="small">Add a key in Settings</button></a>'}${skipBtn('ai', 'Skip the AI')}</div></div>
      <div class="wz-opt"><div><b>Online leaderboards</b> ${o.services.boardShare ? '<span class="badge">Sharing on</span>' : '<span class="badge">Off</span>'}
          <p class="muted s">Sign in with Steam to send your best lap per car and track (and, if you choose, its light telemetry) to the Paddock leaderboard. Off unless you turn it on.</p></div>
        <div class="row"><a href="#/leaderboard"><button class="small">Leaderboards</button></a>${skipBtn('online', 'Skip online')}</div></div>
      <div class="wz-opt"><div><b>Game mods: the Paddock HUD</b> ${o.hud ? `<span class="badge">${esc(hudText(o.hud))}</span>` : ''}
          <p class="muted s">The in-game HUD (with the ACE UI App Loader it needs) is copied into AC EVO's folder while the game is closed. Skipping here changes nothing; to turn the HUD off, use the Mods tab.</p></div>
        <div class="row"><a href="#/mods"><button class="small">Mods</button></a>${skipBtn('mods', 'Skip game mods')}</div></div>
      <p class="muted s" style="margin:10px 0 0">Also: ${o.services.updateCheck ? 'once a day Paddock asks GitHub whether a newer version is out (nothing about you is sent; switch it off in Settings → Updates).' : 'the daily update check is off.'}</p>`,
    drive: () => `<p>Start AC EVO, drive a few laps (3 or more give a full session report). Every lap you finish is saved when you cross the line.</p>
      <ol class="hsteps"><li>Set up a session on the <a href="#/race">Race</a> tab, or start AC EVO from Steam and pick one in the game.</li>
        <li>Drive. The dot at the bottom of the sidebar turns to <b>Recording</b> while you are on track.</li></ol>
      <p id="wzLaps" role="status" aria-live="polite">${lapsText(o.laps)}</p>
      <div class="row"><a href="#/race"><button class="small">Set up a session</button></a></div>`,
    compare: () => (o.comparison.href
      ? `<p>${esc(o.comparison.why)}</p><p class="muted s">${esc(prettyName(o.comparison.combo.track))} ${esc(prettyName(o.comparison.combo.layout))} · ${esc(prettyName(o.comparison.combo.car))}</p>
        <div class="row"><a href="${esc(o.comparison.href)}" data-compare><button class="small">${esc(o.comparison.label)}</button></a></div>
        <p class="muted s" style="margin:10px 0 0">After that, Home always shows your next step, with the numbers behind it.</p>`
      : `<p>${esc(o.comparison.why)}</p><p class="muted">Come back after a few laps: Home will point you to the comparison, and the <a href="#/">Sessions</a> page lists every lap.</p>`),
  };

  function draw(focus) {
    stop();
    const [key, title] = STEPS[i];
    view.innerHTML = `<div class="race-head"><div><h1>Setup guide</h1><div class="sub">Five short steps. Pass any of them by; nothing needs an account.</div></div><span class="spacer"></span>
        <button class="ghost" data-dismiss title="Close the guide. It stays in Settings and in the search (Ctrl+K).">Skip the guide</button></div>
      <div class="wz">
        <nav class="wz-steps" aria-label="Steps"><ol>${STEPS.map(([k, t], n) => `<li><a href="#/welcome?step=${k}" data-step="${n}" ${n === i ? 'aria-current="step"' : ''}>
          <span class="wz-n">${n + 1}</span> ${esc(t)}${(k === 'privacy' && o.skipped.length) ? ` <span class="muted s">(${o.skipped.length} skipped)</span>` : ''}</a></li>`).join('')}</ol></nav>
        <section class="card wz-body" aria-labelledby="wzTitle">
          <p class="muted s" style="margin:0">Step ${i + 1} of ${STEPS.length}</p>
          <h2 id="wzTitle" tabindex="-1">${esc(title)}</h2>
          <div id="wzStep">${body[key]()}</div>
          <div class="row wz-nav">${i > 0 ? '<button data-back>Back</button>' : ''}<span class="spacer"></span>
            ${i < STEPS.length - 1 ? '<button class="primary" data-next>Next</button>' : '<button class="primary" data-finish>Finish</button>'}</div>
        </section></div>`;
    bind(key);
    if (focus) view.querySelector('#wzTitle').focus();
  }

  function bind(key) {
    const q = (s) => view.querySelector(s);
    q('[data-dismiss]').onclick = () => finish('dismiss');
    q('[data-next]')?.addEventListener('click', () => go(i + 1));
    q('[data-back]')?.addEventListener('click', () => go(i - 1));
    q('[data-finish]')?.addEventListener('click', () => finish('done'));
    q('[data-compare]')?.addEventListener('click', () => { post('/api/onboarding', { action: 'done' }).catch(() => {}); });
    view.querySelectorAll('[data-step]').forEach((a) => a.onclick = (e) => { e.preventDefault(); go(+a.dataset.step); });
    view.querySelectorAll('[data-skip], [data-unskip]').forEach((b) => b.onclick = async () => {
      const step = b.dataset.skip || b.dataset.unskip;
      try { o = await post('/api/onboarding', { action: b.dataset.skip ? 'skip' : 'unskip', step }); } catch (e) { alert(e.message); return; }
      draw(false);
      view.querySelector(`[data-${b.dataset.skip ? 'unskip' : 'skip'}="${step}"]`)?.focus();
    });
    q('[data-recheck]')?.addEventListener('click', async () => { o = await api('/api/onboarding'); draw(false); if (key === 'health') health(); q('[data-recheck]')?.focus(); });
    if (key === 'health') health();
    // while on the drive step: the lap count as laps come in
    if (key === 'drive') timer = setInterval(async () => {
      try { o = await api('/api/onboarding'); const p = view.querySelector('#wzLaps'); if (p && p.textContent !== lapsText(o.laps)) p.textContent = lapsText(o.laps); } catch { /* next time */ }
    }, 3000);
  }
  async function health() {
    const box = view.querySelector('#wzHealth');
    try { const h = await api('/api/health'); if (box?.isConnected) box.innerHTML = healthItemsHtml(h); }
    catch (e) { if (box?.isConnected) box.innerHTML = `<li class="g-bad">${esc(e.message)}</li>`; }
  }
  draw(false);
}

const lapsText = (l) => (l.own ? `${l.own} lap${l.own === 1 ? '' : 's'} recorded so far, ${l.valid} valid. Go on to the next step when you are ready.` : 'No lap recorded yet. You can go on and come back to this guide later (Settings or Ctrl+K).');
function hudText(h) {
  if (h.removed) return 'Off (Mods tab)';
  return { current: 'Installed', outdated: 'Update waiting', missing: 'Installed when the game is closed', 'no-game': 'Waits for AC EVO', newer: 'Installed (newer)' }[h.state] || 'Not known';
}
