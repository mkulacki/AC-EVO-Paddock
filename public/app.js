// AC EVO Paddock - browser app (no build step)
import { $, esc, api, post, fmt, prettyName, bindInfoTips } from './util.js';
import { viewConsistency } from './consistency.js';
import { viewSetupHistory } from './setuphistory.js';
import { viewExperiments, viewExperiment } from './experiments.js';
import { viewCoach } from './coach.js';
import { viewDevelopment } from './development.js';
import { viewTracks, viewTrack } from './tracks.js';
import { viewRace } from './race.js';
import { viewCars, viewCar } from './cars.js';
import { viewProgress } from './progress.js';
import { viewAnalysis } from './analysis.js';
import { viewMods } from './mods.js';
import { viewLeaderboard } from './leaderboard.js';
import { viewSetups } from './setups.js';
import { initSpotter } from './spotter.js';
import { initAssist } from './assist.js';
import { viewSessions } from './sessions.js';
import { viewHome } from './home.js';
import { viewWelcome } from './welcome.js';
import { viewCompare } from './compare.js';
import { viewGame, STATUS_TEXT } from './game.js';
import { viewSettings } from './settingspage.js';
import { viewReport } from './reports.js';
import { forgetCompare } from './telemetry.js';
import { initShortcuts } from './palette.js';
import { errorHtml } from './util.js';

const view = $('#view');

// ------------------------------------------------------------------ live status + events
let status = { hasKey: false };
const statusEl = $('#status');
// ?noevents disables the live stream (used for headless screenshots)
const events = location.search.includes('noevents') ? new EventTarget() : new EventSource('/api/events');
initSpotter(events); // audio brake cues play from this page
initAssist(events); // PL9: the switch for the HUD and every cue (sidebar, Alt+Q, Ctrl+K)
// brake points marked in the game: the track page listens for these
events.addEventListener('brakemarks', (e) => window.dispatchEvent(new CustomEvent('paddock:brakemarks', { detail: JSON.parse(e.data) })));
events.addEventListener('status', (e) => {
  const { state, live } = JSON.parse(e.data);
  const recording = state.status === 'live' && live;
  statusEl.className = `status ${recording ? 'live' : state.connected ? 'idle' : ''}`;
  statusEl.querySelector('.txt').textContent = recording
    ? `Recording ${prettyName(live.car)} at ${prettyName(live.track)}, ${fmt(live.lapTimeMs)}`
    : STATUS_TEXT[state.status] || `AC EVO: ${state.status}`;
  // the title also carries the text in the collapsed sidebar, where only the dot shows
  statusEl.title = `${statusEl.querySelector('.txt').textContent}${recording ? '. Every lap you finish is saved.' : ''}`;
});
events.addEventListener('lap', () => { if (currentRoute === 'laps' || currentRoute === 'home') clearTimeout(reloadT), (reloadT = setTimeout(render, 500)); });
// a session report was just made: a dot on the Sessions tab until it is opened (the desktop app also notifies)
events.addEventListener('report', () => {
  if (currentRoute === 'laps' || currentRoute === 'home') { render(); return; } // Home shows the report's summary and targets
  const a = document.querySelector('nav a[data-nav=laps]');
  if (a && !a.querySelector('.nav-dot')) a.insertAdjacentHTML('beforeend', '<span class="nav-dot" title="New session report"></span>');
});
let reloadT;
// a goal met or an achievement reached (P9): Home and Development show it; elsewhere a dot on Development
for (const ev of ['goal', 'achievement']) events.addEventListener(ev, () => {
  if (currentRoute === 'home') { clearTimeout(reloadT); reloadT = setTimeout(render, 500); return; }
  if (currentRoute === 'development') { window.dispatchEvent(new Event('paddock:development')); return; }
  const a = document.querySelector('nav a[data-nav=development]');
  if (a && !a.querySelector('.nav-dot')) a.insertAdjacentHTML('beforeend', `<span class="nav-dot" title="${ev === 'goal' ? 'Goal met' : 'New achievement'}"></span>`);
});

// ------------------------------------------------------------------ restart the app (Settings), e.g. to load code changes
async function restartPaddock(btn) {
  if (statusEl.classList.contains('live') && !confirm('A lap is being recorded.\n\nRestart anyway? The lap in progress is lost.')) return;
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = 'Restarting…';
  try { await post('/api/dev/restart', {}); } catch { /* already going down */ }
  // wait until the server has gone and is back, then load the new page code
  const t0 = Date.now();
  let wentDown = false;
  const poll = async () => {
    try {
      await fetch('/api/status', { cache: 'no-store' }).then((r) => { if (!r.ok) throw new Error(); });
      if (wentDown || Date.now() - t0 > 4000) return location.reload();
    } catch { wentDown = true; }
    if (Date.now() - t0 > 60000) { btn.disabled = false; btn.textContent = label; alert('Paddock did not come back within a minute. Check its console or log.'); return; }
    setTimeout(poll, 400);
  };
  setTimeout(poll, 600);
}

api('/api/status').then((s) => {
  status = s.settings;
  // PL11 demo: a banner on every page, with the way back (src/demo.js)
  if (s.demo && !document.getElementById('demoBar')) {
    document.title = `DEMO · ${document.title}`;
    document.body.insertAdjacentHTML('beforeend', `<div class="demo-bar" id="demoBar" role="status"><b>Demo</b><span>Synthetic laps on a fictional circuit, kept apart from your own data. Nothing here reaches your laps, stats or the leaderboard.</span>
      ${s.demoInApp ? '<button class="small" id="demoLeave">Leave the demo</button>' : '<span class="muted">Stop this run to leave.</span>'}</div>`);
    document.getElementById('demoLeave')?.addEventListener('click', async (e) => { (await import('./system.js')).switchDemo(false, e.currentTarget); });
  }
});

// a dot on the Mods tab while the Paddock HUD is missing or older than this Paddock's copy
async function hudBadge() {
  let h; try { h = await api('/api/mods/hud'); } catch { return; }
  const a = document.querySelector('nav a[data-nav=mods]'); if (!a) return;
  a.querySelector('.nav-dot')?.remove();
  if ((h.state === 'missing' && !h.removed) || h.state === 'outdated') a.insertAdjacentHTML('beforeend', `<span class="nav-dot" title="${h.state === 'missing' ? 'Paddock HUD not installed' : `Paddock HUD update: ${h.installed} → ${h.bundled}`}"></span>`);
}
hudBadge();
setInterval(hudBadge, 60000);
window.addEventListener('paddock:hud', hudBadge);

// a dot on Settings while a newer Paddock is out (src/updates.js; checked once a day, if switched on)
async function updateBadge() {
  let u; try { u = await api('/api/updates'); } catch { return; }
  const a = document.querySelector('nav a[data-nav=settings]'); if (!a) return;
  a.querySelector('.nav-dot')?.remove();
  if (u.enabled && u.latest) a.insertAdjacentHTML('beforeend', `<span class="nav-dot" title="AC EVO Paddock ${esc(u.latest.version)} is out (Settings → Updates)"></span>`);
}
updateBadge();
setInterval(updateBadge, 3600e3);
window.addEventListener('paddock:updates', updateBadge);

// ------------------------------------------------------------------ router
let currentRoute = '';
let cleanup = [];
let renderId = 0;
let lastPath = null, enterTimer = 0;
async function render() {
  cleanup.forEach((f) => f()); cleanup = [];
  const id = ++renderId;
  const mine = cleanup; // this page's own list: if it finishes loading after you left, its timers and listeners are stopped below
  // loading: a thin bar along the top of the page while a page loads (shown only if it takes a moment)
  view.classList.add('busy');
  const [path, query] = (location.hash.slice(1) || '/home').split('?'); // Paddock opens on Home; #/ is Sessions
  const params = new URLSearchParams(query || '');
  const prevRoute = currentRoute;
  currentRoute = { '/home': 'home', '/compare': 'compare', '/settings': 'settings', '/consistency': 'consistency', '/setuphistory': 'setuphistory', '/experiments': 'experiments', '/experiment': 'experiment', '/coach': 'coach', '/development': 'development', '/progress': 'progress', '/analysis': 'analysis', '/game': 'game', '/mods': 'mods', '/race': 'race', '/setups': 'setups', '/tracks': 'tracks', '/track': 'track', '/cars': 'cars', '/car': 'car', '/report': 'report', '/leaderboard': 'leaderboard', '/welcome': 'welcome' }[path] || 'laps';
  const navKey = currentRoute === 'track' ? 'tracks' : currentRoute === 'car' ? 'cars' : currentRoute === 'experiments' || currentRoute === 'experiment' ? 'setups' : ['home', 'settings', 'game', 'mods', 'race', 'setups', 'tracks', 'cars', 'development', 'leaderboard', 'welcome'].includes(currentRoute) ? currentRoute : 'laps';
  if (navKey === 'laps') document.querySelector('nav a[data-nav=laps] .nav-dot')?.remove();
  if (navKey === 'development') document.querySelector('nav a[data-nav=development] .nav-dot')?.remove();
  document.querySelectorAll('nav a[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === navKey));
  try {
    if (currentRoute === 'home') await viewHome(view, mine);
    else if (currentRoute === 'welcome') await viewWelcome(view, params, mine);
    else if (currentRoute === 'game') await viewGame(view, mine);
    else if (currentRoute === 'mods') await viewMods(view, mine);
    else if (currentRoute === 'leaderboard') await viewLeaderboard(view, mine, params);
    else if (currentRoute === 'race') await viewRace(view, mine, params);
    else if (currentRoute === 'setups') await viewSetups(view, params, mine);
    else if (currentRoute === 'tracks') await viewTracks(view);
    else if (currentRoute === 'cars') await viewCars(view);
    else if (currentRoute === 'car') await viewCar(view, params);
    else if (currentRoute === 'track') await viewTrack(view, params, mine);
    else if (currentRoute === 'compare') await viewCompare(view, params, mine, { hasKey: status.hasKey });
    else if (currentRoute === 'consistency') await viewConsistency(view, params, mine);
    else if (currentRoute === 'progress') await viewProgress(view, params, mine);
    else if (currentRoute === 'analysis') await viewAnalysis(view, params);
    else if (currentRoute === 'setuphistory') await viewSetupHistory(view, params, mine);
    else if (currentRoute === 'experiments') await viewExperiments(view, params, mine);
    else if (currentRoute === 'experiment') await viewExperiment(view, params, mine);
    else if (currentRoute === 'coach') await viewCoach(view, params, mine);
    else if (currentRoute === 'development') await viewDevelopment(view, mine);
    else if (currentRoute === 'settings') await viewSettings(view, mine, { restartPaddock, setStatus: (s) => { status = s; } });
    else if (currentRoute === 'report') await viewReport(view, params, mine);
    else await viewSessions(view, params, { rerender: render, entering: prevRoute !== 'laps' });
  } catch (e) {
    if (id === renderId) {
      view.innerHTML = errorHtml(e);
      view.querySelector('[data-retry]')?.addEventListener('click', render);
    }
  } finally {
    if (id === renderId) {
      view.classList.remove('busy');
      // a page you open rises in; a re-render of the same page (a new lap, a filter) does not
      if (path !== lastPath) { lastPath = path; view.classList.remove('enter'); void view.offsetWidth; view.classList.add('enter'); clearTimeout(enterTimer); enterTimer = setTimeout(() => view.classList.remove('enter'), 700); }
      window.dispatchEvent(new Event('paddock:rendered'));
    }
    else mine.splice(0).forEach((f) => { try { f(); } catch { /* the page is gone anyway */ } });
  }
}
window.addEventListener('hashchange', render);
// Paddock always opens on Home; the setup guide (#/welcome) never opens by itself (OD-PL-24 (c)): Home's empty state,
// Settings and Ctrl+K offer it.
queueMicrotask(render); // after all module-level declarations are initialised

events.addEventListener('lap', () => { forgetCompare(); window.dispatchEvent(new Event('paddock:lapsaved')); }); // a new lap can change the best and the ideal lap
bindInfoTips(); // the (i) explanations on every page
initShortcuts(); // sidebar, command palette (Ctrl+K), keyboard shortcuts (public/palette.js)
