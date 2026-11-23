// Settings page (#/settings). Split from app.js. Application management cards: public/system.js.
import { $, esc, api, post } from './util.js';
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
];
// what the preview is drawn over, to judge the HUD against bright and dark scenes
const HUD_PREVIEW_BG = [['dark', 'Dark'], ['light', 'Light'], ['track', 'Track']];
export async function viewSettings(view, cleanup, { restartPaddock, setStatus }) {
  const s = await api('/api/settings');
  view.innerHTML = `<div class="card"><h1>Settings</h1><p class="muted">Stored locally in <code>data/settings.json</code>.</p>
    <div class="form">
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
          </fieldset>
          <div class="hint" style="margin:0">In game you can choose the same things: right-click the strip, or open Paddock HUD's options in the loader's app drawer (right edge of the screen). Both places stay in sync.</div>
        </div>
        <div class="hud-preview"><div class="row hud-preview-head"><span class="muted small-caps">Preview (sample numbers)</span><span class="spacer"></span>
          <span class="seg" id="hudBg">${HUD_PREVIEW_BG.map(([k, label]) => `<button class="small" data-bg="${k}">${label}</button>`).join('')}</span></div>
          <iframe id="hudFrame" title="Paddock HUD preview"></iframe></div>
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
      </div>
      <div class="hint" id="spState" style="margin:8px 0 0"></div></div>
    ${systemHtml()}
    <div class="card"><div class="row"><h2 style="margin:0">Restart Paddock</h2><span class="spacer"></span><button id="restart">Restart Paddock</button></div>
      <p class="muted" style="margin-bottom:0">Closes and reopens Paddock, for example after changing its files. The page reloads by itself when Paddock is back.</p></div>
    <div class="card"><div class="row"><h2 style="margin:0">Telemetry debug</h2><span class="spacer"></span><button id="rawGo">Show live raw values</button></div>
      <p class="muted">Use this while driving to check that speed, pedals, lap time, track position (npos) and coordinates look right.</p>
      <pre class="raw" id="raw" hidden></pre></div>`;
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
  $('#spTest').onclick = async () => {
    clearTimeout(spT);
    try { sp = (await post('/api/settings', { spotter: sp })).spotter; await post('/api/spotter/test', {}); } catch (e) { $('#spSaved').textContent = e.message; }
    setTimeout(spShowState, 300);
  };
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
  };
  document.querySelectorAll('[data-part]').forEach((c) => {
    c.onchange = () => { hudCfg = { ...hudCfg, parts: { ...hudCfg.parts, [c.dataset.part]: c.checked } }; hudSave(); };
  });
  $('#hudScale').oninput = (e) => { hudCfg = { ...hudCfg, scale: +e.target.value }; hudShow(); hudSave(); };
  $('#hudOpacity').oninput = (e) => { hudCfg = { ...hudCfg, opacity: +e.target.value }; hudShow(); hudSave(); };
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
