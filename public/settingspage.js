// Settings page (#/settings). Split from app.js. Application management cards: public/system.js.
import { $, esc, api, post } from './util.js';
import { setAssist, assistOff } from './assist.js';
import { spotterAudioState, loadVoice } from './spotter.js';
import { systemHtml, bindSystem } from './system.js';

// ================================================================== SETTINGS
// Paddock HUD parts, as the Settings page groups them (keys: src/settings.js HUD_PARTS)
const HUD_GROUPS = [
  ['Strip', [['lap', 'Lap number and lap status'], ['current', 'Current lap time'], ['predicted', 'Predicted lap'], ['best', 'All-time best'], ['session', 'Session best'], ['last', 'Last lap'],
    ['inputs', 'Pedals vs your reference lap, TC / ABS']]],
  ['Delta', [['delta', 'Live delta and bar'], ['ref', 'Reference name above it (click to switch)']]],
  ['Above and below the strip', [['shift', 'Shift lights'], ['sectors', 'Sector times (purple / green / yellow)']]],
  ['Chips under the strip', [['cues', 'Brake / throttle cues'], ['corners', 'Corner gain/loss and next corner'], ['ideal', 'Ideal lap and potential'], ['speed', 'Speed and gear'],
    ['fuel', 'Fuel: litres, use per lap, laps left'], ['target', 'Leaderboard target: the driver to beat, predicted gap, sector split'], ['footer', 'Status (saved laps, connection)']]],
  ['Separate window (in game only)', [['board', 'Leaderboard: P1–P3, you and the two drivers either side. Drag it on its own; right-click it for the HUD settings']]],
  ['After each lap (off until you switch them on)', [['summary', 'Post-lap summary: the lap against your reference, the corner that gained most and the one that lost most'],
    ['consistency', 'Lap-time spread this session (the middle half of your valid laps), from 5 valid laps on']]],
];
// AC EVO session types (src/compat.js SESSION_TYPES), for the context profiles
const SESSION_CONTEXTS = [['0', 'Time attack'], ['1', 'Race'], ['2', 'Hot stint'], ['3', 'Cruise']];
const holdTxt = (ms) => `${(ms / 1000).toFixed(ms % 1000 ? 1 : 0)} s`;
const coolTxt = (ms) => (+ms ? `${(ms / 1000).toFixed(ms % 1000 ? 2 : 0)} s` : 'none');
// what the preview is drawn over, to judge the HUD against bright and dark scenes
const HUD_PREVIEW_BG = [['dark', 'Dark'], ['light', 'Light'], ['track', 'Track']];
const THEMES = [['system', 'System'], ['dark', 'Dark'], ['light', 'Light']];

// Damaged or unreadable files of the driver's (decision OD-PL-5; /api/settings fileNotices, src/settings.js): which file,
// where the damaged copy is kept, and how to get its contents back. Names only, the folder is always data\.
const OWN_FILES = {
  'settings.json': ['your settings (driver name, Gemini key, HUD and the other choices on this page)', 'enter your settings again on this page'],
  'race.json': ['your Race tab presets and saved servers', 'add them again on the <a href="#/race">Race</a> tab'],
  'setup-meta.json': ['your notes on setup files', 'write the notes again on the <a href="#/setups">Setups</a> tab'],
};
function fileNoticeHtml(n) {
  const [what, redo] = OWN_FILES[n.file] || ['what it holds', 'enter it again'];
  const f = `<code>${esc(n.file)}</code>`, kept = n.keptAs ? `<code>data/${esc(n.keptAs)}</code>` : '';
  if (n.state === 'earlier') return `A damaged copy of ${f} from ${esc(new Date(n.at).toLocaleString())} is still kept as ${kept}.
    If you no longer need what was in it, delete the copy, or dismiss this notice.`;
  if (n.state === 'aside') return `<b>${f} was damaged</b> when Paddock started, so ${what} started from defaults.
    What was in it is kept as ${kept}. To get it back, quit Paddock, then repair that file (it is plain JSON text) or rename it back to ${f}
    (replacing the new one), and start Paddock again. Or ${redo}.`;
  const refused = n.file === 'settings.json' ? 'Saving on this page is refused' : 'Saving it is refused';
  if (n.damaged) return `<b>${f} is damaged</b> and could not be moved aside, so ${what} use defaults. ${refused}, so nothing in it is overwritten.
    Quit Paddock, repair or remove <code>data/${esc(n.file)}</code>, and start Paddock again.`;
  return `<b>${f} could not be read</b> (another program, for example antivirus or OneDrive, may be holding it), so ${what} use defaults for now.
    ${refused} until it can be read, so nothing in it is lost. Close the program holding it and restart Paddock.`;
}
// a notice with a kept copy can be dismissed (it stays hidden for that copy) or the copy deleted, after a confirm step
// on the page itself (user decision B); a file that could not be read has no copy and no buttons
const fileActionsHtml = (n) => (n.keptAs ? `<div class="row fn-actions" style="margin:4px 0 0">
    <button class="small ghost" data-fn-dismiss="${esc(n.keptAs)}">Dismiss</button>
    <button class="small ghost danger-ghost" data-fn-delete="${esc(n.keptAs)}">Delete copy</button></div>
  <div class="row fn-confirm" hidden style="margin:4px 0 0"><span>Delete <code>data/${esc(n.keptAs)}</code> for good? What was in it cannot be brought back.</span>
    <button class="small danger-ghost" data-fn-yes="${esc(n.keptAs)}">Delete</button><button class="small ghost" data-fn-no>Keep it</button></div>
  <div class="error fn-msg" style="font-size:var(--fs-xs)"></div>` : '');
const fileNoticesHtml = (list) => (list?.length ? `<div class="note-warn" id="fileNotices" role="note" aria-labelledby="fileNoticesTitle" style="margin:0 0 12px">
  <h2 id="fileNoticesTitle" style="margin:0 0 6px;font-size:var(--fs-md)">${list.some((n) => n.state !== 'earlier') ? 'A data file could not be read' : 'Damaged data files kept'}</h2>
  <ul style="margin:0;padding-left:18px">${list.map((n) => `<li data-file="${esc(n.file)}" data-state="${esc(n.state)}" style="margin:0 0 6px">${fileNoticeHtml(n)}${fileActionsHtml(n)}</li>`).join('')}</ul></div>` : '');
/** Wires the notice's buttons; after a change the notice is drawn again from the server's answer. */
function bindFileNotices(box) {
  const redraw = (list, focusSel) => {
    box.innerHTML = fileNoticesHtml(list);
    bindFileNotices(box);
    // focus goes somewhere sensible: the next notice's first button, else the Settings heading
    (box.querySelector(focusSel || 'button') || document.querySelector('#settingsTitle'))?.focus();
  };
  const act = async (li, action, keptAs) => {
    try { const r = await post('/api/settings/notice', { action, keptAs }); redraw(r.fileNotices); }
    catch (e) { li.querySelector('.fn-msg').textContent = e.message; }
  };
  box.querySelectorAll('li').forEach((li) => {
    const actions = li.querySelector('.fn-actions'), confirmRow = li.querySelector('.fn-confirm');
    if (!actions) return;
    li.querySelector('[data-fn-dismiss]').onclick = (e) => act(li, 'dismiss', e.currentTarget.dataset.fnDismiss);
    li.querySelector('[data-fn-delete]').onclick = () => { actions.hidden = true; confirmRow.hidden = false; confirmRow.querySelector('[data-fn-no]').focus(); };
    confirmRow.querySelector('[data-fn-no]').onclick = () => { confirmRow.hidden = true; actions.hidden = false; li.querySelector('[data-fn-delete]').focus(); };
    confirmRow.querySelector('[data-fn-yes]').onclick = (e) => act(li, 'delete', e.currentTarget.dataset.fnYes);
    confirmRow.onkeydown = (e) => { if (e.key === 'Escape') { e.stopPropagation(); confirmRow.querySelector('[data-fn-no]').click(); } };
  });
}
// the section index beside Settings: one entry per card (its heading), the one you are reading lit
function bindToc(cleanup) {
  const toc = document.getElementById('setToc'), main = document.getElementById('setMain');
  if (!toc || !main) return;
  const cards = [...main.children].filter((c) => c.classList.contains('card') && !c.hidden && c.querySelector('h2'));
  toc.innerHTML = '<span class="toc-h">On this page</span>' + cards.map((c, i) => {
    if (!c.id) c.id = `set-${i}`;
    return `<button type="button" data-to="${c.id}">${esc(c.querySelector('h2').textContent.trim())}</button>`;
  }).join('');
  toc.onclick = (e) => {
    const b = e.target.closest('[data-to]');
    if (!b) return;
    const card = document.getElementById(b.dataset.to);
    card?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    card?.querySelector('h2')?.setAttribute('tabindex', '-1');
    card?.querySelector('h2')?.focus({ preventScroll: true });
  };
  const light = () => {
    // the last card whose top has passed the upper third of the window
    const y = innerHeight / 3;
    let cur = cards[0];
    for (const c of cards) if (c.getBoundingClientRect().top <= y) cur = c;
    if (innerHeight + scrollY >= document.documentElement.scrollHeight - 4) cur = cards.at(-1); // at the bottom: the last one
    toc.querySelectorAll('[data-to]').forEach((b) => b.classList.toggle('on', b.dataset.to === cur?.id));
  };
  addEventListener('scroll', light, { passive: true });
  cleanup.push(() => removeEventListener('scroll', light));
  light();
}

export async function viewSettings(view, cleanup, { restartPaddock, setStatus }) {
  const s = await api('/api/settings');
  view.innerHTML = `<div class="race-head"><div><h1 id="settingsTitle" tabindex="-1">Settings</h1><div class="sub">Stored locally in <code>data/settings.json</code>.</div></div></div>
    <div class="settings-layout"><div class="settings-toc" role="navigation" aria-label="Settings sections" id="setToc"></div><div class="settings-main" id="setMain">
    <div class="card"><h2>General</h2><div id="fileNoticesBox">${fileNoticesHtml(s.fileNotices)}</div>
    <div class="form">
      <label>Theme</label><div class="row"><span class="seg" id="theme">${THEMES.map(([k, label]) => `<button class="small" data-theme="${k}">${label}</button>`).join('')}</span></div>
      <div class="hint">Saved on this computer straight away. "System" follows the Windows light / dark setting. Text size: <kbd>Ctrl</kbd> <kbd>+</kbd> / <kbd>Ctrl</kbd> <kbd>−</kbd>, <kbd>Ctrl</kbd> <kbd>0</kbd> for normal.</div>
      <label>Setup guide</label><div class="row"><a href="#/welcome" id="openGuide"><button class="small" tabindex="-1">Open the setup guide</button></a></div>
      <div class="hint">Find the game, check the connections, choose the optional services, drive a first session and open a first comparison.</div>
      <label for="hudAuto">In-game HUD</label><div class="row"><label class="row"><input type="checkbox" id="hudAuto"> Install and update the Paddock HUD and the ACE UI App Loader in AC EVO's folder by themselves</label></div>
      <div class="hint" id="hudAutoMsg" role="status">While AC EVO is closed. Off: Paddock puts nothing into the game folder (a HUD already there stays; the <a href="#/mods">Mods</a> tab removes it).</div>
      <label>Driver name</label><input id="driverName" value="${esc(s.driverName)}" placeholder="defaults to the name from the game">
      <label>Gemini API key</label><input id="geminiApiKey" value="${esc(s.geminiApiKey)}" placeholder="paste key" autocomplete="off">
      <div class="hint">Free key: <a href="https://aistudio.google.com/apikey" target="_blank">aistudio.google.com/apikey</a>. Only a compact per-corner summary is sent, never raw telemetry.</div>
      <label>Gemini model</label><div class="row"><select id="geminiModel" style="flex:1"><option>${esc(s.geminiModel)}</option></select><button id="loadModels">Load available models</button></div>
      <label>Coach language</label><input id="language" value="${esc(s.language)}" placeholder="English">
      <label>When the game closes</label><label class="row"><input type="checkbox" id="openLast" ${s.openLastSession !== false ? 'checked' : ''}> Open the session I just drove<span id="openLastSaved" class="muted"></span></label>
      <div class="hint">Desktop app: Paddock comes to the front on that session's page (telemetry, report, laps). Only if laps were saved while the game was open.</div>
      <label>AC EVO folder</label><input id="gamePath" value="${esc(s.gamePath || '')}" placeholder="found automatically through Steam">
      <div class="hint">Track data (maps, edges, corners) is read from the game's content.kspkg in this folder, read-only.</div>
      <label>Game files folder</label><input id="aceDir" value="${esc(s.aceDir || '')}" placeholder="${esc(s.aceAuto || 'found automatically')}">
      <div class="hint" id="aceHint">Where AC EVO keeps your mods, setups and logs, and where the Paddock HUD is installed: the <code>ACE</code> folder inside your Saved Games folder.
        Leave it empty to use the folder Windows reports. Fill it in only if Paddock can't find it, for example <code>I:\\Games\\Parties enregistrées\\ACE</code>.
        ${s.aceExists ? `In use: <code>${esc(s.aceInUse)}</code>.` : `<span class="g-bad">Not found: <code>${esc(s.aceInUse)}</code>.</span> Start AC EVO once so it creates the folder, or enter where it is.`}</div>
      <span></span><div class="row"><button class="primary" id="save">Save</button><span id="saved" class="muted"></span></div>
    </div></div>
    <div class="card"><div class="row"><h2 style="margin:0">Paddock HUD</h2><span class="spacer"></span><span id="hudSaved" class="muted"></span><button class="small" id="hudReset">Reset to defaults</button></div>
      <p class="muted">Choose what the timing strip shows, in game and in the desktop overlay. Changes are saved and applied straight away, also while you drive.</p>
      <div class="hud-cfg">
        <div class="hud-parts">
          ${HUD_GROUPS.map(([title, parts]) => `<fieldset><legend>${title}</legend>${parts.map(([k, label]) =>
            `<label class="row"><input type="checkbox" data-part="${k}" ${s.hud.parts[k] ? 'checked' : ''}> ${label}</label>`).join('')}</fieldset>`).join('')}
          <fieldset><legend>Look</legend>
            <label class="hud-slider">Size <input type="range" id="hudScale" min="60" max="160" step="5" value="${s.hud.scale}"><b id="hudScaleV">${s.hud.scale}%</b></label>
            <label class="hud-slider">Background <input type="range" id="hudOpacity" min="0" max="100" step="5" value="${s.hud.opacity}"><b id="hudOpacityV">${s.hud.opacity}%</b></label>
            <label class="hud-slider" title="How long “braked 6 m later” / “throttle 4 m earlier” stays after a corner">Cue result <input type="range" id="hudCueHold" min="2000" max="10000" step="500" value="${s.hud.cueHoldMs}"><b id="hudCueHoldV">${holdTxt(s.hud.cueHoldMs)}</b></label>
          </fieldset>
          <div class="hint" style="margin:0">In game you can choose the same things: right-click the strip, or open Paddock HUD's options in the loader's app drawer (right edge of the screen). Both places stay in sync.</div>
        </div>
        <div class="hud-preview"><div class="row hud-preview-head"><span class="muted small-caps">Preview (sample numbers)</span><span class="spacer"></span>
          <span class="seg" id="hudBg">${HUD_PREVIEW_BG.map(([k, label]) => `<button class="small" data-bg="${k}">${label}</button>`).join('')}</span></div>
          <iframe id="hudFrame" title="Paddock HUD preview"></iframe></div>
      </div>
      <h3 id="hudLayouts">Layouts and context profiles</h3>
      <p class="muted" style="margin-top:0">A layout is a saved choice of parts, size and background. Applying one changes the look above (and in game) at once. Built in: ${(s.hudPresets || []).map(esc).join(', ')}.</p>
      <div class="form">
        <label for="hlPick">Layout</label><div class="row"><select id="hlPick"></select><button class="small" id="hlApply">Apply</button><button class="small ghost" id="hlDelete">Delete</button></div>
        <label for="hlName">Save the look above as</label><div class="row"><input id="hlName" maxlength="40" style="width:200px" placeholder="Name, e.g. Night race" autocomplete="off"><button class="small" id="hlSave">Save layout</button></div>
        <label>Context profiles</label><label class="row"><input type="checkbox" id="hlAuto"> When a session starts, switch to the layout chosen for its type</label>
        <span></span><div class="hl-types">${SESSION_CONTEXTS.map(([t, label]) => `<label class="row">${label} <select data-hltype="${t}"></select></label>`).join('')}</div>
        <span></span><div class="hint" style="margin:0" id="hlMsg" role="status">Off by default. While on, starting a session of a type with a layout replaces the current look; “keep the current look” leaves it alone.</div>
      </div>
      <h3>Switch the HUD and cues off</h3>
      <div class="form">
        <label>HUD and cues</label><label class="row"><input type="checkbox" id="asOff" ${s.assistOff ? 'checked' : ''}> Off: the Paddock HUD hides and the spotter says nothing, until you switch them on again</label>
        <label for="assistKey">Global shortcut</label><div class="row"><input id="assistKey" style="width:180px" placeholder="click, then press keys" value="${esc(s.assistKey || '')}" autocomplete="off"><button class="small ghost" id="akClear">Remove</button><span id="akState" class="muted"></span></div>
        <span></span><div class="hint" style="margin:0">In Paddock: <kbd>Alt</kbd> <kbd>Q</kbd>, the switch at the bottom of the sidebar, or Ctrl+K → “HUD and cues”. The global shortcut (none by default) works in the desktop app while the game has the focus; the game no longer gets that key. Brake-mark confirmation beeps still play: they answer your button.</div>
      </div>
      <h3>Installing and showing it</h3>
      <ol class="muted" style="margin:0 0 8px 18px;padding:0">
        <li>Nothing to install: Paddock puts the HUD, and the community <a href="https://github.com/dreasgrech/ACEUIAppLoader" target="_blank">ACE UI App Loader</a> it runs in, into the game by itself whenever AC EVO is closed. It is switched on by default. The <a href="#/game">Game</a> tab shows their state.</li>
        <li>To hide it in game, move the mouse to the right edge of the screen and switch “Paddock HUD” off in the loader's app drawer.</li>
        <li>If the in-game panel says “Paddock offline”, use the desktop overlay instead: <code>npm run overlay</code> (borderless/windowed mode).</li>
      </ol>
      <div class="row"><a href="/hud.html" target="_blank"><button>Open HUD in browser</button></a></div></div>
    <div class="card"><div class="row"><h2 style="margin:0">Brake spotter</h2><span class="spacer"></span><span id="spSaved" class="muted"></span><button class="small" id="spTest">Test</button></div>
      <p class="muted">A voice or beeps count down to each braking point while you drive: “three, two, one, brake”, or “lift” where you only lifted.
        It counts down to your best lap's braking points (the HUD's reference lap), or to your own brake points, so you can keep your eyes on the road.</p>
      <div class="form">
        <label>Spotter</label><label class="row"><input type="checkbox" id="spOn" ${s.spotter.on ? 'checked' : ''}> On</label>
        <label>Sound</label><select id="spSound"><option value="orus">Voice: Orus (team radio)</option><option value="algenib">Voice: Algenib (team radio)</option><option value="beep">Beeps</option></select>
        <label>Count down to</label><select id="spPoints"><option value="best">My best lap's braking points</option><option value="mine">My brake points (only those)</option></select>
        <span></span><div class="hint" style="margin:0">Your own brake points are kept per track and car. Make and edit them on each track's page in <a href="#/tracks">Tracks</a>, or mark them while driving with the button below.</div>
        <label>Mark button</label><div class="row"><span id="mbName" class="muted"></span><button class="small" id="mbBind">Set button</button><button class="small ghost" id="mbClear">Remove</button></div>
        <label>Keyboard shortcut</label><div class="row"><input id="markKey" style="width:180px" placeholder="click, then press keys" value="${esc(s.markKey || '')}" autocomplete="off"><button class="small ghost" id="mkClear">Remove</button><span id="mkState" class="muted"></span></div>
        <span></span><div class="hint" style="margin:0">The button or shortcut marks a brake point while “Mark with button” is on (on the track's page). A wheel or button-box button works in game and in VR; the keyboard shortcut works in the desktop app, and the game no longer gets that key.</div>
        <label>Countdown</label><select id="spCountdown"><option value="full">Three, two, one, brake</option><option value="brake">Only “brake”</option></select>
        <label>Corners</label><select id="spCorners"><option value="all">Every braking and lifting point</option><option value="big">Big stops only</option></select>
        <label>Volume</label><label class="hud-slider"><input type="range" id="spVolume" min="0" max="100" step="5" value="${s.spotter.volume}"><b id="spVolumeV">${s.spotter.volume}%</b></label>
        <label>Timing</label><label class="hud-slider"><input type="range" id="spOffset" min="-500" max="500" step="25" value="${s.spotter.offsetMs}"><b id="spOffsetV"></b></label>
        <span></span><div class="hint" style="margin:0">If “brake” comes too late for you, move Timing to the right so it comes earlier.</div>
        <label>Quiet time</label><label class="hud-slider"><input type="range" id="spCool" min="0" max="3000" step="250" value="${s.spotter.cooldownMs}"><b id="spCoolV">${coolTxt(s.spotter.cooldownMs)}</b></label>
        <span></span><div class="hint" style="margin:0">The least time between two things the spotter says. A word that would come sooner is left out (corners close together get fewer words). It never adds any. Nothing is said while the telemetry has stopped updating.</div>
      </div>
      <div class="hint" id="spState" style="margin:8px 0 0"></div></div>
    ${systemHtml()}
    <div class="card"><div class="row"><h2 style="margin:0">Restart Paddock</h2><span class="spacer"></span><button id="restart">Restart Paddock</button></div>
      <p class="muted" style="margin-bottom:0">Closes and reopens Paddock, for example after changing its files. The page reloads by itself when Paddock is back.</p></div>
    <div class="card"><div class="row"><h2 style="margin:0">Telemetry debug</h2><span class="spacer"></span><button id="rawGo">Show live raw values</button></div>
      <p class="muted">Use this while driving to check that speed, pedals, lap time, track position (npos) and coordinates look right.</p>
      <pre class="raw" id="raw" hidden></pre></div>
    </div></div>`;
  bindToc(cleanup);
  // theme: per computer (localStorage), applied by the script in index.html
  const themeShow = () => {
    let cur = 'system';
    try { cur = localStorage.getItem('theme') || 'system'; } catch { /* private mode */ }
    for (const b of $('#theme').querySelectorAll('button')) b.classList.toggle('on', b.dataset.theme === cur);
  };
  $('#theme').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    try { if (b.dataset.theme === 'system') localStorage.removeItem('theme'); else localStorage.setItem('theme', b.dataset.theme); } catch { /* private mode */ }
    window.applyTheme?.(); themeShow();
  };
  themeShow();
  $('#restart').onclick = (e) => restartPaddock(e.currentTarget);
  bindSystem(restartPaddock);
  // brake spotter: saved on every change, like the HUD
  let sp = s.spotter, spT;
  const spOffsetTxt = (v) => (+v === 0 ? 'on the point' : `${Math.abs(v)} ms ${v > 0 ? 'earlier' : 'later'}`);
  const spShowState = () => {
    const st = spotterAudioState();
    $('#spState').innerHTML = st === 'elsewhere' ? 'Sound plays from another open Paddock window or tab.'
      : st === 'blocked' ? '<span class="g-bad">The browser has blocked sound on this page.</span> Click anywhere on the page once to allow it.'
      : 'Sound plays on your default Windows audio device, also while Paddock is minimised to the tray.';
  };
  $('#spSound').value = sp.sound; $('#spCountdown').value = sp.countdown; $('#spCorners').value = sp.corners; $('#spPoints').value = sp.points;
  $('#spPoints').onchange = (e) => spSave({ points: e.target.value });
  // mark button: "press it now" on the wheel (the server watches every controller for 10 s)
  const mbShow = (b) => { $('#mbName').textContent = b ? `${b.name}, button ${b.button}` : 'none'; $('#mbClear').hidden = !b; };
  mbShow(s.markButton);
  $('#mbBind').onclick = async (e) => {
    const btn = e.currentTarget; btn.disabled = true; $('#mbName').textContent = 'Press the button on your wheel or button box now…';
    try {
      const r = await post('/api/wheel/capture', {});
      if (r.binding) mbShow(r.binding);
      else $('#mbName').textContent = r.devices.length ? 'No button pressed. Try again.' : 'No wheel or controller found.';
    } catch (err) { $('#mbName').textContent = err.message; }
    btn.disabled = false;
  };
  $('#openLast').onchange = async (e) => {
    try { await post('/api/settings', { openLastSession: e.target.checked }); $('#openLastSaved').textContent = ' Saved ✓'; } catch (err) { $('#openLastSaved').textContent = ' ' + err.message; }
  };
  $('#mbClear').onclick = async () => { await post('/api/settings', { markButton: null }); mbShow(null); };
  // keyboard shortcut: press the keys in the box; saved straight away
  const MK_TEXT = { ok: 'Active', taken: '<span class="g-bad">Another program already uses this shortcut, or it is not valid.</span>', 'desktop-only': 'Works only in the desktop app.', none: '' };
  const mkShow = (st) => { $('#mkState').innerHTML = MK_TEXT[st] ?? ''; };
  mkShow(s.markKeyState);
  // Paddock's own shortcuts (public/palette.js): a brake-mark key on one of them would switch it off in the desktop app
  const OWN_KEYS = new Set(['Ctrl+K', 'Ctrl+B', ...[1, 2, 3, 4, 5, 6, 7].map((n) => `Alt+${n}`)]);
  const mkSave = async (accel) => {
    $('#markKey').value = accel;
    try {
      mkShow((await post('/api/settings', { markKey: accel })).markKeyState);
      if (OWN_KEYS.has(accel)) $('#mkState').insertAdjacentHTML('beforeend', ` <span class="pos">${esc(accel)} is also a Paddock shortcut: in the desktop app it now marks a brake point instead.</span>`);
    } catch (err) { $('#mkState').textContent = err.message; }
  };
  $('#markKey').onkeydown = (e) => {
    e.preventDefault();
    if (e.key === 'Escape' || e.key === 'Backspace') return mkSave('');
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
    const key = /^F\d{1,2}$/.test(e.key) ? e.key : e.code.startsWith('Key') ? e.code.slice(3) : e.code.startsWith('Digit') ? e.code.slice(5)
      : e.code.startsWith('Numpad') ? `num${e.code.slice(6).toLowerCase()}` : e.key === ' ' ? 'Space'
      : e.key.startsWith('Arrow') ? e.key.slice(5) : e.key.length === 1 ? e.key.toUpperCase() : e.key;
    mkSave([e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', key].filter(Boolean).join('+'));
  };
  $('#mkClear').onclick = () => mkSave('');
  $('#spOffsetV').textContent = spOffsetTxt(sp.offsetMs);
  spShowState();
  const spSave = (patch) => {
    sp = { ...sp, ...patch };
    clearTimeout(spT);
    spT = setTimeout(async () => {
      try { sp = (await post('/api/settings', { spotter: sp })).spotter; $('#spSaved').textContent = 'Saved ✓'; }
      catch (e) { $('#spSaved').textContent = e.message; }
    }, 250);
  };
  $('#spOn').onchange = (e) => spSave({ on: e.target.checked });
  $('#spSound').onchange = (e) => { loadVoice(e.target.value); spSave({ sound: e.target.value }); };
  $('#spCountdown').onchange = (e) => spSave({ countdown: e.target.value });
  $('#spCorners').onchange = (e) => spSave({ corners: e.target.value });
  $('#spVolume').oninput = (e) => { $('#spVolumeV').textContent = `${e.target.value}%`; spSave({ volume: +e.target.value }); };
  $('#spOffset').oninput = (e) => { $('#spOffsetV').textContent = spOffsetTxt(e.target.value); spSave({ offsetMs: +e.target.value }); };
  $('#spCool').oninput = (e) => { $('#spCoolV').textContent = coolTxt(+e.target.value); spSave({ cooldownMs: +e.target.value }); };
  $('#spTest').onclick = async () => {
    clearTimeout(spT);
    try { sp = (await post('/api/settings', { spotter: sp })).spotter; await post('/api/spotter/test', {}); } catch (e) { $('#spSaved').textContent = e.message; }
    setTimeout(spShowState, 300);
  };
  bindFileNotices($('#fileNoticesBox'));
  // the automatic HUD install (the Mods tab's hud-removed flag; skipping game mods in the setup guide turns it off)
  api('/api/mods/hud').then((h) => { const cb = $('#hudAuto'); if (cb) cb.checked = !h.removed; }).catch(() => {});
  $('#hudAuto').onchange = async (e) => {
    try { await post('/api/mods/hud/auto', { on: e.target.checked }); $('#hudAutoMsg').textContent = e.target.checked ? 'On: Paddock installs the HUD the next time AC EVO is closed.' : 'Off: Paddock puts nothing into the game folder.'; }
    catch (err) { e.target.checked = !e.target.checked; $('#hudAutoMsg').textContent = `Not changed: ${err.message}`; }
  };
  // settings.json could not be read at start: saving is refused by the server (src/settings.js), so the button says so
  if (s.canSave === false) {
    $('#save').disabled = true;
    $('#saved').textContent = 'Saving is off: settings.json could not be read (see the notice above). Close the program holding it and restart Paddock.';
  }
  $('#save').onclick = async () => {
    const body = Object.fromEntries(['driverName', 'geminiApiKey', 'geminiModel', 'language', 'gamePath', 'aceDir'].map((k) => [k, $('#' + k).value.trim()]));
    try {
      const status = await post('/api/settings', body); setStatus(status); $('#saved').textContent = 'Saved ✓'; $('#geminiApiKey').value = status.geminiApiKey;
      // the game files folder is read when Paddock starts
      if ((body.aceDir || '') !== (s.aceDir || '')) {
        $('#saved').innerHTML = 'Saved ✓. Restart Paddock to use the new game files folder. <button class="small" id="restartAce">Restart now</button>';
        $('#restartAce').onclick = (e) => restartPaddock(e.currentTarget);
      }
    }
    catch (e) { $('#saved').textContent = e.message; }
  };
  // Paddock HUD look: saved on every change (the HUD picks it up with its next data read)
  let hudCfg = s.hud, hudT;
  const hudSave = () => {
    clearTimeout(hudT);
    hudT = setTimeout(async () => {
      try { hudCfg = (await post('/api/settings', { hud: hudCfg })).hud; $('#hudSaved').textContent = 'Saved ✓'; }
      catch (e) { $('#hudSaved').textContent = e.message; }
    }, 250);
  };
  const hudShow = () => {
    document.querySelectorAll('[data-part]').forEach((c) => { c.checked = !!hudCfg.parts[c.dataset.part]; });
    $('#hudScale').value = hudCfg.scale; $('#hudScaleV').textContent = `${hudCfg.scale}%`;
    $('#hudOpacity').value = hudCfg.opacity; $('#hudOpacityV').textContent = `${hudCfg.opacity}%`;
    $('#hudCueHold').value = hudCfg.cueHoldMs; $('#hudCueHoldV').textContent = holdTxt(hudCfg.cueHoldMs);
  };
  document.querySelectorAll('[data-part]').forEach((c) => {
    c.onchange = () => { hudCfg = { ...hudCfg, parts: { ...hudCfg.parts, [c.dataset.part]: c.checked } }; hudSave(); };
  });
  $('#hudScale').oninput = (e) => { hudCfg = { ...hudCfg, scale: +e.target.value }; hudShow(); hudSave(); };
  $('#hudOpacity').oninput = (e) => { hudCfg = { ...hudCfg, opacity: +e.target.value }; hudShow(); hudSave(); };
  $('#hudCueHold').oninput = (e) => { hudCfg = { ...hudCfg, cueHoldMs: +e.target.value }; hudShow(); hudSave(); };
  // PL9 layouts and context profiles (/api/hudlayouts, src/hudlayouts.js)
  let hl = { presets: s.hudPresets || [], ...s.hudLayouts };
  const hlNames = () => [...hl.presets, ...hl.list.map((l) => l.name)];
  const hlShow = () => {
    const pick = $('#hlPick'), was = pick.value;
    pick.innerHTML = `<optgroup label="Built in">${hl.presets.map((n) => `<option>${esc(n)}</option>`).join('')}</optgroup>`
      + (hl.list.length ? `<optgroup label="Saved">${hl.list.map((l) => `<option>${esc(l.name)}</option>`).join('')}</optgroup>` : '');
    if (hlNames().includes(was)) pick.value = was;
    $('#hlDelete').disabled = hl.presets.includes(pick.value);
    $('#hlAuto').checked = !!hl.auto;
    document.querySelectorAll('[data-hltype]').forEach((sel) => {
      sel.innerHTML = `<option value="">keep the current look</option>${hlNames().map((n) => `<option>${esc(n)}</option>`).join('')}`;
      sel.value = hl.byType?.[sel.dataset.hltype] || '';
      sel.disabled = !hl.auto;
    });
  };
  const hlDo = async (body, done) => {
    try {
      const r = await post('/api/hudlayouts', body);
      hl = { presets: r.presets, list: r.list, auto: r.auto, byType: r.byType };
      if (r.hud) { hudCfg = r.hud; hudShow(); }
      hlShow(); $('#hlMsg').textContent = done;
    } catch (e) { $('#hlMsg').textContent = e.message; hlShow(); }
  };
  hlShow();
  $('#hlPick').onchange = () => { $('#hlDelete').disabled = hl.presets.includes($('#hlPick').value); };
  $('#hlApply').onclick = () => { clearTimeout(hudT); hlDo({ action: 'apply', name: $('#hlPick').value }, `“${$('#hlPick').value}” applied ✓`); };
  $('#hlDelete').onclick = () => hlDo({ action: 'delete', name: $('#hlPick').value }, 'Deleted ✓');
  $('#hlSave').onclick = async () => {
    clearTimeout(hudT);
    const name = $('#hlName').value.trim();
    // the look above is saved first (a change may still be waiting), then stored under the name
    try { hudCfg = (await post('/api/settings', { hud: hudCfg })).hud; } catch (e) { $('#hlMsg').textContent = e.message; return; }
    await hlDo({ action: 'save', name }, `Saved as “${name}” ✓`);
    if (hlNames().includes(name)) { $('#hlPick').value = name; $('#hlName').value = ''; hlShow(); }
  };
  $('#hlAuto').onchange = (e) => hlDo({ action: 'contexts', auto: e.target.checked }, e.target.checked ? 'Context profiles on ✓' : 'Context profiles off ✓');
  document.querySelectorAll('[data-hltype]').forEach((sel) => {
    sel.onchange = () => hlDo({ action: 'contexts', byType: { [sel.dataset.hltype]: sel.value } }, 'Saved ✓');
  });
  // PL9 kill switch (the same switch as the sidebar button, Alt+Q and Ctrl+K)
  const asShow = (off) => { $('#asOff').checked = !!off; };
  asShow(assistOff() ?? s.assistOff);
  const onAssist = (e) => { if (document.body.contains($('#asOff'))) asShow(e.detail.off); else window.removeEventListener('paddock:assist', onAssist); };
  window.addEventListener('paddock:assist', onAssist);
  $('#asOff').onchange = async (e) => {
    try { const r = await setAssist(e.target.checked); asShow(r.off); if (!r.saved) $('#akState').textContent = `Switched, but not saved: ${r.error}`; }
    catch (err) { e.target.checked = !e.target.checked; $('#akState').textContent = err.message; }
  };
  const akShow = (st) => { $('#akState').innerHTML = MK_TEXT[st] ?? ''; };
  akShow(s.assistKeyState);
  const akSave = async (accel) => {
    $('#assistKey').value = accel;
    if (accel && accel === $('#markKey').value) { $('#akState').innerHTML = '<span class="g-bad">That is the brake-mark shortcut: choose another.</span>'; return; }
    try { akShow((await post('/api/settings', { assistKey: accel })).assistKeyState); } catch (err) { $('#akState').textContent = err.message; }
  };
  $('#assistKey').onkeydown = (e) => {
    e.preventDefault();
    if (e.key === 'Escape' || e.key === 'Backspace') return akSave('');
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
    const key = /^F\d{1,2}$/.test(e.key) ? e.key : e.code.startsWith('Key') ? e.code.slice(3) : e.code.startsWith('Digit') ? e.code.slice(5)
      : e.code.startsWith('Numpad') ? `num${e.code.slice(6).toLowerCase()}` : e.key === ' ' ? 'Space'
      : e.key.startsWith('Arrow') ? e.key.slice(5) : e.key.length === 1 ? e.key.toUpperCase() : e.key;
    akSave([e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', key].filter(Boolean).join('+'));
  };
  $('#akClear').onclick = () => akSave('');
  $('#hudReset').onclick = async () => {
    clearTimeout(hudT);
    try { hudCfg = (await post('/api/settings', { hud: {} })).hud; hudShow(); $('#hudSaved').textContent = 'Defaults restored ✓'; }
    catch (e) { $('#hudSaved').textContent = e.message; }
  };
  // preview background (remembered in this browser only)
  const setPreviewBg = (bg) => {
    try { localStorage.setItem('hud.previewBg', bg); } catch { /* private window */ }
    document.querySelectorAll('#hudBg [data-bg]').forEach((b) => b.classList.toggle('on', b.dataset.bg === bg));
    $('#hudFrame').src = `/hud.html?demo&bg=${bg}`;
  };
  let previewBg = 'dark';
  try { previewBg = localStorage.getItem('hud.previewBg') || 'dark'; } catch { /* private window */ }
  document.querySelectorAll('#hudBg [data-bg]').forEach((b) => { b.onclick = () => setPreviewBg(b.dataset.bg); });
  setPreviewBg(HUD_PREVIEW_BG.some(([k]) => k === previewBg) ? previewBg : 'dark');
  // the same choices can be made in game (right-click the strip): follow them here
  let hudTouched = 0;
  document.querySelector('.hud-parts').addEventListener('input', () => { hudTouched = Date.now(); });
  document.querySelector('.hud-parts').addEventListener('change', () => { hudTouched = Date.now(); });
  const hudFollow = setInterval(async () => {
    if (Date.now() - hudTouched < 3000) return; // a change of ours may still be on its way
    try {
      const h = (await api('/api/settings')).hud;
      if (Date.now() - hudTouched < 3000 || JSON.stringify(h) === JSON.stringify(hudCfg)) return;
      hudCfg = h; hudShow();
    } catch { /* Paddock restarting */ }
  }, 3000);
  cleanup.push(() => { clearTimeout(hudT); clearInterval(hudFollow); });
  $('#loadModels').onclick = async () => {
    try {
      const models = await api('/api/ai/models');
      const cur = $('#geminiModel').value;
      $('#geminiModel').innerHTML = models.map((m) => `<option value="${esc(m.id)}" ${m.id === cur ? 'selected' : ''}>${esc(m.name)} (${esc(m.id)})</option>`).join('');
    } catch (e) { alert(e.message + '\n\n(Save your API key first.)'); }
  };
  let timer;
  $('#rawGo').onclick = () => {
    const pre = $('#raw');
    pre.hidden = !pre.hidden;
    clearInterval(timer);
    if (!pre.hidden) timer = setInterval(async () => { pre.textContent = JSON.stringify(await api('/api/debug/raw'), null, 2); }, 500);
  };
  cleanup.push(() => clearInterval(timer));
}
