// Game page (#/game): AC EVO, App Loader and Paddock HUD status, launch progress. Split from app.js.
import { $, esc, api, post, fmt, prettyName } from './util.js';

// the recorder's state in plain words
export const STATUS_TEXT = {
  offline: "AC EVO isn't running", 'waiting for game': "AC EVO isn't running", 'game not running': "AC EVO isn't running",
  menu: 'AC EVO is in the menus', off: 'AC EVO is in the menus', pause: 'Paused', replay: 'Watching a replay',
  live: 'On track', unknown: 'AC EVO is running',
};

// ================================================================== GAME
export async function viewGame(view, cleanup) {
  view.innerHTML = `<div class="card"><div class="row"><h1 style="margin:0">AC EVO</h1><span class="spacer"></span>
      <button class="primary" id="gLaunch">Start AC EVO</button></div>
      <div id="gStatus" class="game-status muted" style="margin-top:12px">Checking the game…</div></div>
    <div class="card"><h2 style="margin-top:0">Drive</h2>
      <p class="muted">Set up a session (type, car, track, conditions, AI grid) or join a server in the <a href="#/race">Race</a> tab.</p>
      <div id="gLaunchState"></div></div>`;

  // the ACE UI App Loader's state in plain words (Paddock installs it by itself): [ok, text]
  const loaderLine = (l) => {
    if (!l) return [false, 'unknown'];
    const v = l.variant === 'alternate' ? `${l.bundled} (alternate build)` : l.bundled;
    if (l.gameMatch === false) return [false, `built for AC EVO ${l.builtFor}, but the game is ${l.game}: update Paddock${l.installed ? '' : ' (the loader is not installed)'}`];
    if (l.state === 'current') return [true, `installed, ${v}`];
    if (l.removed) return [false, `${l.installed ? 'not the one Paddock ships' : 'removed'} (disabled or deleted in the Mods tab, so Paddock leaves it alone)`];
    if (l.state === 'missing' || l.state === 'other') return [false, `${l.state === 'missing' ? 'missing' : 'a different version'}: Paddock installs ${l.bundled} as soon as AC EVO is closed`];
    if (l.state === 'no-game') return [false, 'AC EVO has not been started yet'];
    return [false, l.state];
  };
  const yesNo = (ok, yes, no) => `<span class="${ok ? 'g-ok' : 'g-bad'}">${ok ? yes : no}</span>`;

  async function refresh() {
    let g;
    try { g = await api('/api/game'); } catch (e) { $('#gStatus').textContent = e.message; return; }
    const t = g.telemetry, live = t.live;
    const hudLive = g.liveAgeMs != null && g.liveAgeMs < 2000;
    $('#gStatus').innerHTML = `<table class="kv"><tbody>
      <tr><td>Game</td><td>${yesNo(g.running, 'running', 'not running')}${g.version ? `, version ${esc(g.version)}` : ''}</td></tr>
      <tr><td>Telemetry</td><td>${t.status === 'live' && live ? `<span class="g-ok">live</span>: ${esc(prettyName(live.car))} at ${esc(prettyName(live.track))} ${esc(live.layout || '')}, lap time ${fmt(live.lapTimeMs)}`
        : esc(STATUS_TEXT[t.status] || t.status)}. ${t.savedLaps} lap${t.savedLaps === 1 ? '' : 's'} saved since Paddock started</td></tr>
      <tr><td>ACE UI App Loader</td><td>${(([ok, txt]) => yesNo(ok, esc(txt), esc(txt)))(loaderLine(g.loaderInfo))}</td></tr>
      <tr><td>Paddock HUD</td><td>${g.hudVersion ? `<span class="g-ok">installed</span>, ${esc(g.hudVersion)}` : '<span class="g-bad">not installed</span> (Paddock installs it as soon as AC EVO is closed; see the <a href="#/mods">Mods</a> tab)'}
        . Data feed ${yesNo(hudLive, 'updating', 'stopped')}</td></tr>
    </tbody></table>`;
    $('#gLaunch').textContent = g.running ? 'AC EVO is running' : 'Start AC EVO';
    $('#gLaunch').disabled = g.running;

    const L = g.launch;
    $('#gLaunchState').innerHTML = L.order || L.events.length ? `<div class="card" style="background:var(--surface-2)">
      ${L.order ? `<div class="row"><b>${L.order.kind === 'scan' ? 'Scanning' : 'Launching'}:</b>&nbsp;${esc(L.order.summary || '')}
        <span class="spacer"></span><button class="small ghost" id="gCancel">Cancel</button></div>` : ''}
      ${L.events.length ? `<ol class="muted" style="margin:6px 0 0 18px;padding:0">${L.events.map((e) =>
        `<li class="${e.step === 'error' ? 'g-bad' : e.step === 'started' || e.step === 'scandone' ? 'g-ok' : ''}">${esc(e.msg || e.step)}</li>`).join('')}</ol>` : '<div class="muted">Waiting for the game…</div>'}
    </div>` : '';
    if ($('#gCancel')) $('#gCancel').onclick = async () => { await post('/api/game/cancel', {}); refresh(); };
  }
  $('#gLaunch').onclick = async () => { try { const r = await post('/api/game/launch', {}); $('#gStatus').insertAdjacentHTML('afterbegin', `<p>${esc(r.msg)}</p>`); } catch (e) { alert(e.message); } };
  await refresh();
  const timer = setInterval(refresh, 2000);
  cleanup.push(() => clearInterval(timer));
}
