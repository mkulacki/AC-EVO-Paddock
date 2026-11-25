// Browser flows (PL2): the real pages in headless Edge (or Chrome), driven over the DevTools protocol with Node's own
// WebSocket, against a mock server on scratch data. `npm run test:browser` (also part of `npm run verify`).
// Covers: open a session, compare two laps, import a valid / duplicate / broken lap file, change a setting, keyboard
// navigation (Alt+digit, Ctrl+K palette, ?, Esc), the damaged-file notice in Settings (PL1D, OD-PL-5), comparison
// caveats and the incompatible-pair gate, the integration health panel (PL4), the lap analysis (PL6) and a practice drill
// made from it and met (PL7). Every page must
// load without a JavaScript error.
// Skipped when no Edge/Chrome is found (set PADDOCK_BROWSER to the browser's .exe to choose one).
// No game, no network, no AI key: the server runs with --mock on a free port, the browser has a scratch profile.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { isolate, ROOT } from './helpers.js';

const BROWSERS = [process.env.PADDOCK_BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', '/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean);
const BROWSER = BROWSERS.find((b) => fs.existsSync(b));
const skip = !BROWSER ? 'no Edge or Chrome found (set PADDOCK_BROWSER)' : typeof WebSocket !== 'function' ? 'this Node has no WebSocket' : false;

const env = isolate('browser');
const OLD_COPY = 'race.json.unreadable-1700000000000';
const childEnv = { ...process.env, ...env, PADDOCK_TEST_SEED: '7' };
if (!process.versions.electron) delete childEnv.ELECTRON_RUN_AS_NODE;
const node = (...args) => ['--no-warnings', '--import', pathToFileURL(path.join(ROOT, 'test/preload-seed.js')).href, ...args];
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server, browser, ws, base, log = '';
const errors = [];   // uncaught exceptions and console.error in the page
const dialogs = [];  // alert() texts (the import reports with one)
let seq = 0;
const pending = new Map();

/** One DevTools command on the page. */
function cdp(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject, method }));
}
/** Evaluates an expression in the page (promises awaited) and returns its value. */
async function js(expression) {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`in page: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
  return r.result.value;
}
async function waitFor(expression, what, ms = 15000) {
  const until = Date.now() + ms;
  for (;;) {
    try { const v = await js(expression); if (v) return v; } catch { /* page still loading */ }
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}
/** Goes to a page of the app and waits until the router says it is drawn. */
async function go(hash, ready) {
  // the same address again fires no hashchange: the router is told directly
  await js(`window.__rendered = 0; if (location.hash === ${JSON.stringify(hash)}) dispatchEvent(new HashChangeEvent('hashchange')); else location.hash = ${JSON.stringify(hash)}; 1`);
  await waitFor('window.__rendered > 0', `page ${hash}`);
  if (ready) await waitFor(ready, `${hash}: ${ready}`);
}
const KEYS = { Escape: 27, Enter: 13, Tab: 9 };
/** A key press as the user makes it (modifiers: alt, ctrl, shift). */
async function press(key, { alt = false, ctrl = false, shift = false, code } = {}) {
  const modifiers = (alt ? 1 : 0) | (ctrl ? 2 : 0) | (shift ? 8 : 0);
  const vk = KEYS[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
  const c = code ?? (key.length === 1 ? (/[0-9]/.test(key) ? `Digit${key}` : /[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : '') : key);
  // Enter carries its text ("\r") as a real key does: that is what activates a focused button
  const text = alt || ctrl ? undefined : key === 'Enter' ? '\r' : key.length === 1 ? key : undefined;
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key, code: c, modifiers, windowsVirtualKeyCode: vk, text });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code: c, modifiers, windowsVirtualKeyCode: vk });
}
const api = (p, opts) => fetch(`${base}${p}`, opts).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

before(async () => {
  if (skip) return;
  // demo laps on scratch data, then the server on a free port (as test/smoke.test.js does)
  execFileSync(process.execPath, node(path.join(ROOT, 'src/mock.js'), '--seed', '6'), { env: childEnv, cwd: ROOT, stdio: 'ignore' });
  // the laps' own conditions, as the app records them after each lap (the seed does not): similar temperatures that are
  // not checked against the game, for the combined "not confirmed" line on Compare (D-PL4-12)
  { const d = new DatabaseSync(path.join(env.ACEVO_DATA, 'telemetry.db')); d.exec(`UPDATE laps SET cond = '{"airC":20,"roadC":28}'`); d.close(); }
  // PL6: 12 synthetic laps with known patterns on another car and track (test/lapfixtures.js; game version 1.0 for
  // the PL7 drill flow, which counts only laps of a known, matching version), dated 1970 so every
  // other flow still sees the mock laps first; the lap analysis page must rank their T2 and T1
  execFileSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', `
    const db = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'src/db.js')).href)});
    const { insertLap, COMBO } = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'test/lapfixtures.js')).href)});
    const params = (i) => ({ brake: [i % 3 !== 0 ? 0.75 : 1, 1, 1], hold: [0, i % 3 !== 1 ? 50 : 0, 0], gear: [0, i % 3 !== 1 ? 1 : 0, 0] });
    const s = [0, 1, 2].map((k) => db.createSession({ ...COMBO, sessionType: 0, driver: 'Me', startedAt: 1e9 + k * 1e6 }));
    for (let i = 1; i <= 12; i++) db.setLapCond(insertLap(db, { sessionId: s[Math.floor((i - 1) / 4)], lapNumber: i, recordedAt: 1e9 + i * 1e5, params: params(i) }), { game: "1.0" });`],
  { env: childEnv, cwd: ROOT, stdio: 'ignore' });
  // a damaged setup-meta.json: the server keeps it aside at start and the Settings page must say so (OD-PL-5)
  fs.writeFileSync(path.join(env.ACEVO_DATA, 'setup-meta.json'), '{"files": {"x": {"notes": "half');
  // and a damaged copy left by an earlier run (listed as 'earlier')
  fs.writeFileSync(path.join(env.ACEVO_DATA, OLD_COPY), '{');
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, node(path.join(ROOT, 'src/server.js'), '--mock', '1'), { env: { ...childEnv, PORT: String(port) }, cwd: ROOT });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${log}`)), 20000);
    server.stdout.on('data', (b) => { log += b; if (log.includes(`running: http://localhost:${port}`)) { clearTimeout(timer); resolve(); } });
    server.stderr.on('data', (b) => { log += b; });
    server.once('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited (${code}):\n${log}`)); });
  });

  // the browser: headless, a scratch profile, the DevTools port it picked is written to DevToolsActivePort
  const profile = path.join(env.dir, 'browser');
  browser = spawn(BROWSER, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-sync', '--disable-background-networking', '--disable-component-update', '--window-size=1400,900', 'about:blank'], { stdio: 'ignore' });
  const portFile = path.join(profile, 'DevToolsActivePort');
  const until = Date.now() + 20000;
  while (!fs.existsSync(portFile) || !fs.readFileSync(portFile, 'utf8').includes('\n')) {
    if (Date.now() > until) throw new Error('the browser did not open its DevTools port');
    await sleep(100);
  }
  const devPort = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]);
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('DevTools connection failed')); });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      if (m.error) p.reject(new Error(`${p.method}: ${m.error.message}`)); else p.resolve(m.result);
    } else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
    else if (m.method === 'Page.javascriptDialogOpening') {
      dialogs.push(m.params.message);
      cdp('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
    }
  };
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  // every page drawn by the router sends paddock:rendered (public/app.js); counted from the first document on
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: "window.__rendered = 0; addEventListener('paddock:rendered', () => { window.__rendered++; });" });
  await cdp('Page.navigate', { url: `${base}/#/home` });
  await waitFor('window.__rendered > 0', 'the first page');
});

after(async () => {
  try { ws?.close(); } catch { /* gone */ }
  if (browser && browser.exitCode == null) { const gone = new Promise((r) => browser.once('exit', r)); browser.kill(); await Promise.race([gone, sleep(5000)]); }
  if (server && server.exitCode == null) { const gone = new Promise((r) => server.once('exit', r)); server.kill(); await gone; }
});

test('the app opens on Home with its title and no JavaScript error', { skip }, async () => {
  assert.equal(await js('document.title'), 'AC EVO Paddock');
  assert.equal(await js("document.querySelector('nav a[data-nav=home]').classList.contains('active')"), true);
  assert.deepEqual(errors, []);
});

test('open a session: Sessions list -> the session report with its laps', { skip }, async () => {
  await go('#/', "document.querySelector('a.sess-row')");
  const href = await js("document.querySelector('a.sess-row').getAttribute('href')");
  assert.match(href, /^#\/report\?session=\d+$/);
  await js("window.__rendered = 0; document.querySelector('a.sess-row').click(); 1");
  await waitFor('window.__rendered > 0 && location.hash.startsWith("#/report")', 'the session report');
  assert.equal(await js('location.hash'), href);
  assert.ok(await js("document.querySelectorAll('#view h1, #view h2').length > 0"), 'the report has headings');
  assert.equal(await js("!!document.querySelector('#view .error, #view [data-retry]')"), false, 'no error card');
  assert.deepEqual(errors, []);
});

test('compare two laps: charts drawn for both', { skip }, async () => {
  const o = (await api('/api/overview')).body;
  const c = o.combos[0];
  const two = o.laps.filter((l) => l.track === c.track && l.layout === c.layout && l.car === c.car).slice(0, 2).map((l) => l.id);
  assert.equal(two.length, 2);
  await go(`#/compare?laps=${two.join(',')}&ref=best`, "document.querySelector('#view .uplot')");
  assert.ok(await js("document.querySelectorAll('#view .uplot').length") >= 1, 'a telemetry chart');
  assert.equal(await js("!!document.querySelector('#view [data-retry]')"), false, 'no error card');
  assert.deepEqual(errors, []);
});

/** Imports files through the page's own Import button: its file picker is answered with these bytes. */
async function importThroughPage(files) {
  dialogs.length = 0;
  await go('#/', "document.querySelector('#imp')");
  await js(`(() => {
    const files = ${JSON.stringify(files.map((f) => ({ name: f.name, b64: Buffer.from(f.bytes).toString('base64') })))};
    const orig = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function () {
      if (this.type !== 'file') return orig.call(this);
      HTMLInputElement.prototype.click = orig;
      const dt = new DataTransfer();
      for (const f of files) dt.items.add(new File([Uint8Array.from(atob(f.b64), (ch) => ch.charCodeAt(0))], f.name));
      this.files = dt.files;
      this.dispatchEvent(new Event('change'));
    };
    window.__rendered = 0;
    document.querySelector('#imp').click();
    return 1;
  })()`);
  const until = Date.now() + 15000;
  while (!dialogs.length) { if (Date.now() > until) throw new Error('no import result shown'); await sleep(100); }
  await waitFor('window.__rendered > 0', 'the list drawn again');
  return dialogs[0];
}

test('import lap files: a broken file and a duplicate are refused with a reason; a valid one is added', { skip }, async () => {
  const o = (await api('/api/overview')).body;
  const mock = o.laps.filter((l) => l.track === 'mock_ring'); // (not the PL6 fixture laps, which the analysis flow needs as they are)
  const id = mock[mock.length - 1].id;
  const file = Buffer.from(await (await fetch(`${base}/api/laps/${id}/export`)).arrayBuffer());
  const count = async () => (await api('/api/overview')).body.laps.length;
  const n0 = await count();

  let msg = await importThroughPage([{ name: 'broken.lap.gz', bytes: Buffer.from('this is not a lap file') }]);
  assert.match(msg, /^Imported 0 lap\(s\)\.\nbroken\.lap\.gz: \S/);
  msg = await importThroughPage([{ name: 'again.lap.gz', bytes: file }]);
  assert.match(msg, /already in Paddock \(lap #\d+/);
  assert.equal(await count(), n0, 'nothing stored');

  // the lap gone, its file comes back in
  assert.equal((await api(`/api/laps/${id}`, { method: 'DELETE', headers: { origin: base } })).status, 200);
  msg = await importThroughPage([{ name: 'back.lap.gz', bytes: file }]);
  assert.equal(msg, 'Imported 1 lap(s).');
  assert.equal(await count(), n0);
  assert.ok(await js("!!document.querySelector('[data-imported]')"), 'an Imported laps list');
  assert.deepEqual(errors, []);
});

test('settings: a changed driver name is saved; the Gemini key field never holds the key', { skip }, async () => {
  await go('#/settings', "document.querySelector('#driverName') && document.querySelector('#save')");
  await js("document.querySelector('#driverName').value = 'Browser Test'; document.querySelector('#save').click(); 1");
  await waitFor("document.querySelector('#saved').textContent.includes('Saved')", 'Saved ✓');
  assert.equal((await api('/api/settings')).body.driverName, 'Browser Test');
  await go('#/home');
  await go('#/settings', "document.querySelector('#driverName')");
  assert.equal(await js("document.querySelector('#driverName').value"), 'Browser Test', 'kept after leaving the page');
  assert.equal(await js("document.querySelector('#geminiApiKey').value"), '', 'no key set, none shown');
  assert.deepEqual(errors, []);
});

test('settings: a damaged data file is named, with the copy kept and how to recover (OD-PL-5)', { skip }, async () => {
  const kept = fs.readdirSync(env.ACEVO_DATA).find((n) => n.startsWith('setup-meta.json.unreadable-'));
  assert.ok(kept, 'kept aside by the server');
  const n = (await api('/api/settings')).body.fileNotices;
  assert.deepEqual(n.map((x) => [x.file, x.state, x.keptAs, x.savesRefused]), [['setup-meta.json', 'aside', kept, false], ['race.json', 'earlier', OLD_COPY, false]]);
  assert.equal((await api('/api/settings')).body.canSave, true);
  await go('#/settings', "document.querySelector('#fileNotices')");
  assert.equal(await js("document.querySelector('#fileNotices').getAttribute('role')"), 'note', 'a note, not a live region announced on load');
  const text = await js("document.querySelector('#fileNotices').textContent");
  assert.match(text, /setup-meta\.json was damaged/);
  assert.ok(text.includes(`data/${kept}`), 'where the copy is');
  assert.match(text, /rename it back/);
  assert.ok(!text.includes(env.ACEVO_DATA), 'no full folder path');
  assert.equal(await js("document.querySelector('#fileNotices a[href=\"#/setups\"]') !== null"), true, 'a link to where the notes are');
  assert.deepEqual(errors, []);
});

test('settings: Dismiss hides a notice for good; Delete copy asks on the page, Esc cancels, then deletes (decision B)', { skip }, async () => {
  const kept = fs.readdirSync(env.ACEVO_DATA).find((n) => n.startsWith('setup-meta.json.unreadable-'));
  const li = (name) => `document.querySelector('#fileNotices li:has([data-fn-dismiss="${name}"])')`;
  await go('#/settings', `${li(OLD_COPY)}`);
  // Dismiss, by keyboard: focus the button and press Enter
  await js(`${li(OLD_COPY)}.querySelector('[data-fn-dismiss]').focus(); 1`);
  await press('Enter');
  await waitFor(`!${li(OLD_COPY)}`, 'the dismissed notice gone');
  assert.ok(fs.existsSync(path.join(env.ACEVO_DATA, OLD_COPY)), 'dismiss deletes nothing');
  await go('#/home');
  await go('#/settings', "document.querySelector('#fileNotices')");
  assert.equal(await js(`!!${li(OLD_COPY)}`), false, 'still hidden after leaving the page');
  // Delete copy: an on-page confirm step (no dialog), Esc goes back, then Delete
  const n0 = dialogs.length;
  await js(`${li(kept)}.querySelector('[data-fn-delete]').click(); 1`);
  await waitFor(`!${li(kept)}.querySelector('.fn-confirm').hidden && document.activeElement === ${li(kept)}.querySelector('[data-fn-no]')`, 'the confirm step, focused on Keep it');
  await press('Escape');
  await waitFor(`${li(kept)}.querySelector('.fn-confirm').hidden && document.activeElement === ${li(kept)}.querySelector('[data-fn-delete]')`, 'Esc: back to the buttons');
  assert.ok(fs.existsSync(path.join(env.ACEVO_DATA, kept)));
  await js(`${li(kept)}.querySelector('[data-fn-delete]').click(); ${li(kept)}.querySelector('[data-fn-yes]').click(); 1`);
  await waitFor("!document.querySelector('#fileNotices')", 'no notice left');
  assert.ok(!fs.existsSync(path.join(env.ACEVO_DATA, kept)), 'the copy is deleted');
  assert.ok(fs.existsSync(path.join(env.ACEVO_DATA, OLD_COPY)), 'the dismissed one is untouched');
  assert.equal(dialogs.length, n0, 'no confirm()/alert() dialog');
  assert.deepEqual(errors, []);
});

test('settings notice API: only kept copies in data\\, only from Paddock itself; live files are never deleted', { skip }, async () => {
  const post = (body, origin = base) => api('/api/settings/notice', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  for (const keptAs of ['settings.json', 'race.json', 'setup-meta.json', '../settings.json', '..\\settings.json', 'settings.json.unreadable-1/../../x', path.join(env.ACEVO_DATA, OLD_COPY), 'telemetry.db']) {
    const r = await post({ action: 'delete', keptAs });
    assert.ok(r.status === 400 || r.status === 404, `${keptAs}: ${r.status}`);
  }
  assert.equal((await post({ action: 'rename', keptAs: OLD_COPY })).status, 400);
  assert.equal((await post({ action: 'delete', keptAs: OLD_COPY }, 'http://evil.example')).status, 403, 'another site is refused');
  assert.ok(fs.existsSync(path.join(env.ACEVO_DATA, OLD_COPY)));
  assert.equal((await post({ action: 'delete', keptAs: OLD_COPY })).status, 200);
  assert.ok(!fs.existsSync(path.join(env.ACEVO_DATA, OLD_COPY)));
});

test('settings: leaving the page before its cards load is not an error (root cause of the flaky keyboard test)', { skip }, async () => {
  // the backup and update cards draw after their answers arrive; slow those down and leave at once, as Alt+0 then Alt+1 does
  await js(`window.__realFetch = window.__realFetch || window.fetch;
    window.fetch = async (u, o) => { if (/\\/api\\/(backup|updates)$/.test(String(u))) await new Promise((r) => setTimeout(r, 400)); return window.__realFetch(u, o); }; 1`);
  try {
    await go('#/settings', "document.querySelector('#sysBackup')");
    await go('#/home');
    await sleep(800);
  } finally { await js('window.fetch = window.__realFetch; 1'); }
  assert.deepEqual(errors, []);
});

test('restore confirm text: key and sign-in with the settings part, passwords and servers with the race part (round 3)', { skip }, async () => {
  const note = (parts) => js(`import('/system.js').then((m) => m.restoreSecretsNote(${JSON.stringify(parts)}))`);
  assert.equal(await note(['laps']), '');
  const s = await note(['settings']), r = await note(['race']), both = await note(['settings', 'race']);
  assert.match(s, /Gemini key and leaderboard sign-in/); assert.doesNotMatch(s, /password|servers/);
  assert.match(r, /server passwords/); assert.match(r, /servers missing from the backup are kept/); assert.doesNotMatch(r, /Gemini|sign-in/);
  assert.equal(both, s + r);
});

test('settings: "Check now" answered after leaving the page is not an error (round 3)', { skip }, async () => {
  await go('#/settings', "document.querySelector('#updNow')");
  await js(`window.__realFetch = window.__realFetch || window.fetch;
    window.fetch = async (u, o) => { if (String(u).endsWith('/api/updates/check')) { await new Promise((r) => setTimeout(r, 400)); return new Response('{"current":"t","enabled":true}', { status: 200, headers: { 'content-type': 'application/json' } }); } return window.__realFetch(u, o); }; 1`);
  try {
    await js("document.querySelector('#updNow').click(); 1");
    await go('#/home');
    await sleep(800);
  } finally { await js('window.fetch = window.__realFetch; 1'); }
  assert.deepEqual(errors, []);
});

test('settings: when settings.json cannot be saved, Save is disabled with the reason (review nit)', { skip }, async () => {
  // the server's answer is changed in the page only: making settings.json unreadable would need another server
  await js(`window.__realFetch = window.__realFetch || window.fetch;
    window.fetch = async (u, o) => { const r = await window.__realFetch(u, o);
      if (String(u).endsWith('/api/settings') && !(o && o.method)) { const j = await r.json(); return new Response(JSON.stringify({ ...j, canSave: false }), { status: 200, headers: { 'content-type': 'application/json' } }); }
      return r; }; 1`);
  try {
    await go('#/settings', "document.querySelector('#save')");
    assert.equal(await js("document.querySelector('#save').disabled"), true);
    assert.match(await js("document.querySelector('#saved').textContent"), /Saving is off: settings\.json could not be read/);
  } finally { await js('window.fetch = window.__realFetch; 1'); }
  await go('#/settings', "document.querySelector('#save')");
  assert.equal(await js("document.querySelector('#save').disabled"), false, 'enabled when it can be saved');
  assert.deepEqual(errors, []);
});

test('keyboard: Alt+digit pages, Ctrl+K palette with Enter, ? shortcuts, Esc closes', { skip }, async () => {
  await go('#/home');
  await js('document.activeElement?.blur(); 1');
  await press('0', { alt: true });
  await waitFor("location.hash === '#/settings'", 'Alt+0 -> Settings');
  await press('1', { alt: true });
  await waitFor("location.hash === '#/home'", 'Alt+1 -> Home');

  await press('k', { ctrl: true });
  await waitFor("document.querySelector('.palette input') === document.activeElement", 'the palette, focused');
  await cdp('Input.insertText', { text: 'settings' });
  await waitFor("document.querySelector('.palette-list li[role=option]')", 'palette results');
  assert.match(await js("document.querySelector('.palette-list li.sel').textContent"), /settings/i);
  await js('window.__rendered = 0; 1');
  await press('Enter');
  await waitFor("!document.querySelector('.palette-back') && window.__rendered > 0", 'the palette closed on Enter');
  assert.match(await js('location.hash'), /^#\/settings/);

  await go('#/home');
  await js('document.activeElement?.blur(); 1');
  await press('k', { ctrl: true });
  await waitFor("document.querySelector('.palette-back')", 'the palette');
  await press('Escape');
  await waitFor("!document.querySelector('.palette-back')", 'Esc closes the palette');

  await press('?', { shift: true, code: 'Slash' });
  await waitFor("document.querySelector('.palette.shortcuts')", 'the shortcuts list');
  await press('Escape');
  await waitFor("!document.querySelector('.palette.shortcuts')", 'Esc closes the shortcuts list');

  // Tab reaches the sidebar links
  await press('Tab');
  await waitFor("document.activeElement && document.activeElement !== document.body", 'focus after Tab');
  assert.deepEqual(errors, []);
});

// ---------------------------------------------------------------- PL4: comparison compatibility and integration health
test('compare: caveats are listed with what they change, and open from the keyboard (PL4.2)', { skip }, async () => {
  const o = (await api('/api/overview')).body;
  const c = o.combos[0];
  const two = o.laps.filter((l) => l.track === c.track && l.layout === c.layout && l.car === c.car && l.source === 'local').slice(0, 2).map((l) => l.id);
  await go(`#/compare?laps=${two[0]}&ref=${two[1]}`, "document.querySelector('#view .uplot')");
  // mock laps record no game version, setup or aids: unknown is never a match
  assert.ok(await js("!!document.querySelector('#view details.compat-warn')"), 'a compare-with-care card');
  assert.match(await js("document.querySelector('#view .compat-warn summary').textContent"), /Not recorded for one of the laps/);
  assert.equal(await js("document.querySelector('#view .compat-warn').open"), false, 'closed at first: the charts stay in view');
  await js("document.querySelector('#view .compat-warn summary').focus(); 1");
  await press('Enter');
  await waitFor("document.querySelector('#view .compat-warn').open", 'Enter opens the caveats');
  assert.match(await js("document.querySelector('#view .compat-warn .compat-effect').textContent"), /What it changes:/);
  // readings not confirmed yet: one combined line with where to confirm them, not a caveat each (D-PL4-12)
  assert.equal(await js("document.querySelectorAll('#view .compat-warn .compat-unconf').length"), 1);
  assert.match(await js("document.querySelector('#view .compat-unconf').textContent"), /Some readings aren't confirmed yet: temperatures/);
  assert.equal(await js("[...document.querySelectorAll('#view .compat-item b')].some((b) => /not confirmed/.test(b.textContent))"), false, 'no separate not-confirmed caveat');
  assert.match(await js("document.querySelector('#view .compat-warn summary').textContent"), /Some readings aren't confirmed yet/);
  await js("document.querySelector('#view .compat-unconf a').focus(); 1");
  await js('window.__rendered = 0; 1');
  await press('Enter');
  await waitFor("location.hash === '#/setups' && window.__rendered > 0", 'Enter on the link opens Setups');
  await go(`#/compare?laps=${two[0]}&ref=${two[1]}&tab=line`, "document.querySelector('#view #rpCanvas')");
  assert.equal(await js("document.querySelectorAll('#view .compat-unconf').length"), 1, 'the same line on the replay tab');
  assert.match(await js("document.querySelector('#view .compat-basis').textContent"), /Measured/);
  assert.deepEqual(errors, []);
});

test('compare: a lap of another car waits behind "Compare anyway" (PL4.2)', { skip }, async () => {
  const zlib = await import('node:zlib');
  const o = (await api('/api/overview')).body;
  const own = o.laps.filter((l) => l.source === 'local');
  const lap = JSON.parse(zlib.gunzipSync(Buffer.from(await (await fetch(`${base}/api/laps/${own[0].id}/export`)).arrayBuffer())).toString());
  lap.meta.car = 'mock_gt4'; lap.meta.driver = 'Other Driver';
  const r = await api('/api/laps/import', { method: 'POST', headers: { origin: base }, body: zlib.gzipSync(JSON.stringify(lap)) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // the Racing line replay tab waits behind the same gate (review 4)
  await go(`#/compare?laps=${r.body.id}&ref=${own[1].id}&tab=line`, "document.querySelector('#view .compat-bad [data-force]')");
  assert.equal(await js("!!document.querySelector('#view #rpCanvas')"), false, 'no replay until the driver says so');
  await go(`#/compare?laps=${r.body.id}&ref=${own[1].id}`, "document.querySelector('#view .compat-bad [data-force]')");
  assert.equal(await js("!!document.querySelector('#view .uplot')"), false, 'no charts until the driver says so');
  assert.match(await js("document.querySelector('#view .compat-bad').textContent"), /Another car/);
  assert.equal(await js("document.querySelector('#view .compat-bad').getAttribute('role')"), 'alert');
  await js("document.querySelector('#view [data-force]').focus(); 1");
  await press('Enter');
  await waitFor("document.querySelector('#view .uplot')", 'the charts after Compare anyway');
  assert.match(await js("document.querySelector('#view .compat-bad').textContent"), /Compared anyway/);
  // the choice counts for the replay tab too, which shows the same list
  await go(`#/compare?laps=${r.body.id}&ref=${own[1].id}&tab=line`, "document.querySelector('#view #rpCanvas')");
  assert.match(await js("document.querySelector('#view .compat-bad').textContent"), /Another car/);
  assert.equal((await api(`/api/laps/${r.body.id}`, { method: 'DELETE', headers: { origin: base } })).status, 200);
  assert.deepEqual(errors, []);
});

test('integration health on the Game page: every part with its state in words, steps open from the keyboard; palette finds it (PL4.3)', { skip }, async () => {
  await go('#/game', "document.querySelectorAll('#gHealth .health-item').length === 6");
  const rows = await js("[...document.querySelectorAll('#gHealth .health-item')].map((li) => [li.dataset.check, li.querySelector('.hstate').textContent])");
  assert.deepEqual(rows.map((r) => r[0]), ['game', 'freshness', 'recording', 'hud', 'channels', 'online']);
  for (const [, s] of rows) assert.ok(['OK', 'Needs a look', 'Not working', 'Off', 'Not known'].includes(s), s);
  // the telemetry checks row: closed or open, Enter on its summary toggles it and it has a link to Setups
  const was = await js("document.querySelector('#gHealth [data-check=channels] details').open");
  await js("document.querySelector('#gHealth [data-check=channels] summary').focus(); 1");
  await press('Enter');
  await waitFor(`document.querySelector('#gHealth [data-check=channels] details').open === ${!was}`, 'Enter toggles the row');
  assert.ok(await js("!!document.querySelector('#gHealth [data-check=channels] a[href=\"#/setups\"]')"));
  await sleep(2300); // redrawn every 2 s: an opened row stays as the driver left it
  assert.equal(await js("document.querySelector('#gHealth [data-check=channels] details').open"), !was);

  await go('#/home');
  await js('document.activeElement?.blur(); 1');
  await press('k', { ctrl: true });
  await waitFor("document.querySelector('.palette input') === document.activeElement", 'the palette');
  await cdp('Input.insertText', { text: 'integration health' });
  await waitFor("document.querySelector('.palette-list li.sel')?.textContent.includes('Integration health')", 'the health entry');
  await js('window.__rendered = 0; 1');
  await press('Enter');
  await waitFor("location.hash === '#/game' && document.querySelector('#gHealth .health-item')", 'the Game page with the panel');
  assert.deepEqual(errors, []);
});

// ---------------------------------------------------------------- PL5: setup guide, Home, notes/tags/bookmarks, keyboard, reflow
/** A second Paddock on a fresh, empty data folder (a new driver), on its own port. */
async function freshServer() {
  const dir = path.join(env.dir, 'fresh');
  const e = { ACEVO_DATA: path.join(dir, 'data'), ACE_DIR: path.join(dir, 'ACE') };
  fs.mkdirSync(e.ACEVO_DATA, { recursive: true }); fs.mkdirSync(e.ACE_DIR, { recursive: true });
  const port = await freePort();
  const proc = spawn(process.execPath, node(path.join(ROOT, 'src/server.js'), '--mock', '1'), { env: { ...childEnv, ...e, PORT: String(port) }, cwd: ROOT });
  let out = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`fresh server did not start:\n${out}`)), 20000);
    proc.stdout.on('data', (b) => { out += b; if (out.includes(`running: http://localhost:${port}`)) { clearTimeout(timer); resolve(); } });
    proc.stderr.on('data', (b) => { out += b; });
    proc.once('exit', (code) => { clearTimeout(timer); reject(new Error(`fresh server exited (${code}):\n${out}`)); });
  });
  return { base: `http://127.0.0.1:${port}`, data: e.ACEVO_DATA, stop: async () => { if (proc.exitCode == null) { const gone = new Promise((r) => proc.once('exit', r)); proc.kill(); await gone; } } };
}
/** Opens a page of another server in the same tab and waits for its first drawn page. */
async function openAt(url) {
  await cdp('Page.navigate', { url });
  await waitFor('document.readyState === "complete" && window.__rendered > 0', `${url} drawn`);
}
/** Presses Tab until the element matching sel has focus (at most n times): reachable by keyboard alone. */
async function tabTo(sel, n = 40) {
  for (let k = 0; k < n; k++) {
    await press('Tab');
    if (await js(`document.activeElement?.matches(${JSON.stringify(sel)}) || false`)) return k + 1;
  }
  throw new Error(`Tab never reached ${sel}`);
}

test('setup guide: a new driver opens it from Home (never by itself); every step by keyboard; AI, online and mods skipped; Finish -> Home (PL5)', { skip }, async () => {
  const f = await freshServer();
  const settingsOf = () => fetch(`${f.base}/api/settings`).then((r) => r.json());
  const ob = () => fetch(`${f.base}/api/onboarding`).then((r) => r.json());
  try {
    assert.equal((await ob()).hasData, false, 'no laps: a new driver');
    await openAt(`${f.base}/`);
    await sleep(300);
    assert.equal(await js('location.hash'), '', 'Paddock opens on Home, not on the guide (OD-PL-24 c)');
    // Home's empty state offers it: reached by keyboard
    await js('window.__rendered = 0; document.activeElement?.blur(); 1');
    await tabTo('#view a[href="#/welcome"]', 60);
    await press('Enter');
    await waitFor("location.hash.startsWith('#/welcome') && document.querySelector('#wzTitle')", 'the guide from Home');
    assert.match(await js("document.querySelector('#wzTitle').textContent"), /Find AC EVO/);
    assert.match(await js("document.querySelector('.wz-steps [aria-current=step]').textContent.trim()"), /^1/);
    // step 1 -> 2 by keyboard only: Tab to Next, Enter; focus goes to the new step's title
    await tabTo('[data-next]');
    await press('Enter');
    await waitFor("document.querySelector('#wzTitle').textContent === 'Check the connections' && document.activeElement === document.querySelector('#wzTitle')", 'step 2, title focused');
    await waitFor("document.querySelectorAll('#wzHealth .health-item').length === 6", 'the health checks (reused from the Game page)');
    await tabTo('[data-next]');
    await press('Enter');
    await waitFor("document.querySelector('#wzTitle').textContent === 'Privacy and optional services'", 'step 3');
    assert.match(await js("document.querySelector('#wzStep').textContent"), /Everything stays on this computer/);
    // skip each optional service by keyboard; the choice is recorded and changes nothing else
    for (const k of ['ai', 'online', 'mods']) {
      await tabTo(`[data-skip="${k}"]`);
      await press('Enter');
      await waitFor(`!!document.querySelector('[data-unskip="${k}"]') && document.activeElement === document.querySelector('[data-unskip="${k}"]')`, `${k} skipped, focus on Undo`);
    }
    assert.deepEqual((await ob()).skipped, ['ai', 'online', 'mods']);
    const s = await settingsOf();
    assert.equal(s.boardShare, false, 'online stays off'); assert.equal(s.hasKey, false, 'no key');
    // Undo (focused) un-skips; skip again
    await press('Enter');
    await waitFor('!!document.querySelector(\'[data-skip="mods"]\')', 'mods un-skipped');
    assert.deepEqual((await ob()).skipped, ['ai', 'online']);
    await js('document.querySelector(\'[data-skip="mods"]\').focus(); 1');
    await press('Enter');
    await waitFor('!!document.querySelector(\'[data-unskip="mods"]\')', 'mods skipped again');
    await tabTo('[data-next]');
    await press('Enter');
    await waitFor("document.querySelector('#wzTitle').textContent === 'Drive a first session'", 'step 4');
    assert.equal(await js("document.querySelector('#wzLaps').getAttribute('role')"), 'status');
    await tabTo('[data-next]');
    await press('Enter');
    await waitFor("document.querySelector('#wzTitle').textContent === 'Compare your laps'", 'step 5');
    assert.equal(await js("!!document.querySelector('[data-next]')"), false, 'last step: Finish instead of Next');
    // Back by keyboard too
    await tabTo('[data-back]');
    await press('Enter');
    await waitFor("document.querySelector('#wzTitle').textContent === 'Drive a first session'", 'Back to step 4');
    await js("document.querySelector('[data-next]').focus(); 1");
    await press('Enter');
    await waitFor("!!document.querySelector('[data-finish]')", 'step 5 again');
    await js('window.__rendered = 0; 1');
    await tabTo('[data-finish]');
    await press('Enter');
    await waitFor("location.hash === '#/home' && window.__rendered > 0", 'Home after Finish');
    const st = await ob();
    assert.equal(st.state, 'done');
    // game mods skipped: the automatic HUD install is off (the existing flags)
    assert.ok(fs.existsSync(path.join(f.data, 'hud-removed')) && fs.existsSync(path.join(f.data, 'loader-removed')));
    // opened again without an address: Home, not the guide
    await openAt(`${f.base}/`);
    await sleep(300);
    assert.equal(await js('location.hash'), '', 'not sent to the guide again');
    assert.match(await js("document.querySelector('#view').textContent"), /Welcome to AC EVO Paddock/);
    assert.ok(await js("!!document.querySelector('#view a[href=\"#/welcome\"]')"), 'Home offers the guide');
    // the offline workflow: no account, no key, nothing switched on
    assert.equal((await settingsOf()).boardShare, false);
  } finally { await openAt(`${base}/#/home`); await f.stop(); }
  assert.deepEqual(errors, []);
});

test('setup guide: "Skip the guide" puts it away; an existing driver is never sent to it but finds it in Ctrl+K and Settings (PL5)', { skip }, async () => {
  assert.equal((await api('/api/onboarding')).body.hasData, true, 'seeded laps: an existing driver');
  await openAt(`${base}/`);
  await sleep(300);
  assert.equal(await js("location.hash === '' || location.hash === '#/home'"), true, 'opens on Home');
  await js('document.activeElement?.blur(); 1');
  await press('k', { ctrl: true });
  await waitFor("document.querySelector('.palette input') === document.activeElement", 'the palette');
  await cdp('Input.insertText', { text: 'setup guide' });
  await waitFor("document.querySelector('.palette-list li.sel')?.textContent.includes('Setup guide')", 'the guide in the palette');
  await js('window.__rendered = 0; 1');
  await press('Enter');
  await waitFor("location.hash.startsWith('#/welcome') && document.querySelector('#wzTitle')", 'the guide from Ctrl+K');
  // a step in the list goes straight there
  await js('document.querySelector(\'.wz-steps [data-step="4"]\').focus(); 1');
  await press('Enter');
  await waitFor("document.querySelector('#wzTitle').textContent === 'Compare your laps'", 'step 5 from the list');
  assert.ok(await js("!!document.querySelector('[data-compare]')"), 'with laps: a comparison to open');
  assert.match(await js("document.querySelector('[data-compare]').getAttribute('href')"), /^#\/compare\?laps=\d+&ref=(best|ideal)$/);
  await js('window.__rendered = 0; 1');
  await tabTo('[data-dismiss]');
  await press('Enter');
  await waitFor("location.hash === '#/home' && window.__rendered > 0", 'Skip the guide -> Home');
  assert.equal((await api('/api/onboarding')).body.state, 'dismissed');
  await go('#/settings', "document.querySelector('#openGuide')");
  assert.equal(await js("document.querySelector('#openGuide').getAttribute('href')"), '#/welcome');
  assert.deepEqual(errors, []);
});

test('Home: last session, practice objective and one next step with its evidence; reachable by keyboard (PL5)', { skip }, async () => {
  await go('#/home', "document.querySelector('.home-now-row')");
  const heads = await js("[...document.querySelectorAll('.home-now-row h2')].map((h) => h.textContent)");
  assert.deepEqual(heads, ['Last session', 'Practice objective', 'Next step']);
  assert.match(await js("document.querySelector('.hn-why').textContent"), /^Why: \S/);
  const href = await js('document.querySelector(\'.hn-next a[href^="#/"]\').getAttribute(\'href\')');
  assert.match(href, /^#\/(compare|race|progress|report)/);
  await js('document.activeElement?.blur(); 1');
  await tabTo('.hn-next a[href^="#/"]', 80);
  assert.ok(await js("document.activeElement.matches(':focus-visible') && getComputedStyle(document.activeElement).outlineStyle !== 'none'"), 'a visible focus ring');
  await js('window.__rendered = 0; 1');
  await press('Enter');
  await waitFor(`location.hash.startsWith(${JSON.stringify(href.split('?')[0])}) && window.__rendered > 0`, 'the next step opened');
  assert.deepEqual(errors, []);
});

test('session notes, tags and corner bookmarks: by keyboard, saved locally, shown on Sessions and found with Ctrl+K (PL5)', { skip }, async () => {
  const sid = (await api('/api/overview')).body.sessions[0].id;
  await go(`#/report?session=${sid}&notes=1`, "document.querySelector('#nText') && document.activeElement === document.querySelector('#nText')");
  assert.equal(await js("document.querySelector('#notes').open"), true);
  assert.match(await js("document.querySelector('#notes .hint').textContent"), /never uploaded/);
  await cdp('Input.insertText', { text: 'Braked too early into the hairpin' });
  await press('Enter', { ctrl: true });
  await waitFor("document.querySelector('#nMsg').textContent === 'Saved'", 'Ctrl+Enter saves');
  assert.equal((await api(`/api/notes?session=${sid}`)).body.text, 'Braked too early into the hairpin');
  // tags: type, Enter adds (and saves); the chip's × removes it by keyboard
  await js("document.querySelector('#nTagIn').focus(); 1");
  for (const t of ['Wet', 'Race prep']) { await cdp('Input.insertText', { text: t }); await press('Enter'); }
  await waitFor("document.querySelectorAll('#nTags .tag-chip').length === 2 && document.querySelector('#nMsg').textContent === 'Saved'", 'two tags saved');
  await waitFor(`fetch('/api/notes?session=${sid}').then((r) => r.json()).then((n) => n.tags.join() === 'wet,race prep')`, 'both tags stored');
  await js('document.querySelector(\'[data-untag="race prep"]\').focus(); 1');
  await press('Enter');
  await waitFor(`document.querySelectorAll('#nTags .tag-chip').length === 1`, 'a tag removed');
  await waitFor(`fetch('/api/notes?session=${sid}').then((r) => r.json()).then((n) => n.tags.join() === 'wet')`, 'the removal stored');
  // a corner bookmark: corner, Tab, note, Enter
  await js("document.querySelector('#nBmCorner').focus(); 1");
  await cdp('Input.insertText', { text: 'T2' });
  await press('Tab');
  await cdp('Input.insertText', { text: 'later braking' });
  await press('Enter');
  await waitFor("document.querySelectorAll('#nBms [data-unbm]').length === 1", 'the bookmark listed');
  assert.deepEqual((await api(`/api/notes?session=${sid}`)).body.bookmarks.map((b) => [b.corner, b.note]), [['T2', 'later braking']]);
  // the page's limits are the server's
  assert.equal(await js("document.querySelector('#nText').maxLength"), 4000);
  assert.equal(await js("document.querySelector('#nTagIn').maxLength"), 32);
  // typed and left at once: kept
  await js("const t = document.querySelector('#nText'); t.focus(); t.setSelectionRange(t.value.length, t.value.length); 1");
  await cdp('Input.insertText', { text: ', then too late' });
  await go('#/home');
  await waitFor(`fetch('/api/notes?session=${sid}').then((r) => r.json()).then((n) => n.text.endsWith('then too late'))`, 'saved on leaving the page');
  // Sessions: the tag on the row and a tag filter
  await go('#/', "document.querySelector('#f-tag')");
  assert.ok(await js("[...document.querySelectorAll('a.sess-row .tag-chip')].some((c) => c.textContent === 'wet')"), 'the tag on its row');
  // Ctrl+K: the tag, Enter filters the Sessions page by it
  await js('document.activeElement?.blur(); 1');
  await press('k', { ctrl: true });
  await waitFor("document.querySelector('.palette input') === document.activeElement", 'the palette');
  await cdp('Input.insertText', { text: 'tag wet' });
  await waitFor("document.querySelector('.palette-list li.sel .pk')?.textContent === 'Tag'", 'the tag in the palette');
  await js('window.__rendered = 0; 1');
  await press('Enter');
  await waitFor("location.hash === '#/?tag=wet' && window.__rendered > 0 && document.querySelector('#f-tag')?.value === 'wet'", 'Sessions filtered by the tag');
  assert.ok(await js("document.querySelectorAll('a.sess-row').length >= 1 && [...document.querySelectorAll('a.sess-row')].every((a) => a.textContent.includes('wet'))"), 'only tagged sessions');
  // the bookmark is in the palette too
  await js('document.activeElement?.blur(); 1');
  await press('k', { ctrl: true });
  await waitFor("document.querySelector('.palette input') === document.activeElement", 'the palette');
  await cdp('Input.insertText', { text: 'bookmark t2' });
  await waitFor("document.querySelector('.palette-list li.sel .pk')?.textContent === 'Bookmark'", 'the bookmark in the palette');
  await press('Escape');
  await waitFor("!document.querySelector('.palette-back')", 'palette closed');
  // remove the bookmark by keyboard
  // closed by default (the telemetry stays in view) with the tags in its summary; opened from Home's link (&notes=1)
  await go(`#/report?session=${sid}`, "document.querySelector('#notes')");
  assert.equal(await js("document.querySelector('#notes').open"), false);
  assert.match(await js("document.querySelector('#notes summary').textContent"), /wet[\s\S]*then too late/);
  await go(`#/report?session=${sid}&notes=1`, "document.querySelector('#nBms [data-unbm]')");
  await js("document.querySelector('#nBms [data-unbm]').focus(); 1");
  await press('Enter');
  await waitFor("!document.querySelector('#nBms [data-unbm]')", 'bookmark removed');
  assert.equal((await api(`/api/notes?session=${sid}`)).body.bookmarks.length, 0);
  assert.deepEqual(errors, []);
});

test('scalable text: at 200 % zoom (700 px wide) Home, the guide, Sessions and a session page fit without sideways scrolling (PL5)', { skip }, async () => {
  const sid = (await api('/api/overview')).body.sessions[0].id;
  await cdp('Emulation.setDeviceMetricsOverride', { width: 700, height: 900, deviceScaleFactor: 1, mobile: false });
  try {
    for (const h of ['#/home', '#/welcome', '#/', `#/report?session=${sid}`]) {
      await go(h);
      await sleep(250);
      const [sw, iw] = await js('[document.documentElement.scrollWidth, innerWidth]');
      assert.ok(sw <= iw + 1, `${h}: ${sw} px wide in a ${iw} px window`);
    }
  } finally { await cdp('Emulation.clearDeviceMetricsOverride'); }
  assert.deepEqual(errors, []);
});

test('lap analysis: the top opportunities read without a chart, observations apart from interpretations, links to the corner; keyboard; narrow window (PL6)', { skip }, async () => {
  const key = 'fixture_ring|gp|fixture_gt';
  await go(`#/analysis?combo=${encodeURIComponent(key)}`, "document.querySelector('#anTop .opp-card')");
  assert.match(await js("document.querySelector('#view h1').textContent"), /^Lap analysis at fixture ring/);
  // the known patterns: T2 (throttle held on the exit) first, T1 (early braking) second
  const an = (await api(`/api/analysis?${new URLSearchParams({ track: 'fixture_ring', layout: 'gp', car: 'fixture_gt' })}`)).body;
  assert.deepEqual(await js("[...document.querySelectorAll('.opp-card h3')].map((h) => h.textContent)"), ['T2', 'T1'],
    JSON.stringify(an.corners.map((c) => [c.name, c.passes, c.gain, c.dist])));
  const card = (q) => js(`document.querySelector('.opp-card').querySelector(${JSON.stringify(q)})?.textContent ?? null`);
  assert.match(await card('.opp-head'), /^T2: about \d\.\d\d s a lap to gain, most of it on the way out/);
  assert.match(await card('.conf'), /Confidence: (Medium|Low|High) · 12 passes/);
  assert.match(await card('.phasebar'), /Entry[\s\S]*Apex[\s\S]*Exit/);
  // what was measured and what it may mean are two separate lists; only the second speaks of possibilities
  const obs = await js("[...document.querySelector('.opp-card .opp-obs').children].map((li) => li.textContent)");
  const int = await js("[...document.querySelector('.opp-card .opp-int').children].map((li) => li.textContent)");
  assert.ok(obs.length >= 2 && int.length >= 1);
  assert.ok(obs.every((t) => !/\bmay\b/.test(t)), obs.join(' | '));
  assert.ok(int.every((t) => /\bmay\b/.test(t)), int.join(' | '));
  assert.match(await js("document.querySelector('#anTop').textContent"), /do not prove what causes it/);
  // the comparison link opens Compare at that corner
  const href = await js("document.querySelector('.opp-card .opp-links a[href^=\"#/compare\"]').getAttribute('href')");
  assert.match(href, /^#\/compare\?laps=\d+&ref=\d+&c=T2$/);
  // the target lap is shown next to the ideal; trends and the PB card are there
  assert.match(await js("document.querySelector('#anTarget').textContent"), /^\d:\d\d\.\d{3} ±\d\.\d s, rough$/);
  // review fix 2: a card with a gear or brake finding says what that reading is (gearbox setting, pedal position)
  const cav = await js("[...document.querySelectorAll('.opp-card .opp-cav')].map((p) => p.textContent).join(' ')");
  assert.match(cav, /pedal position, not the brake pressure/); // T1's braking finding
  // (T2's gear finding is its 4th, so not on the card: the corner row below carries the gearbox note)
  assert.match(await js("document.querySelector('#view').textContent"), /What made your personal best faster|Your personal best/); // the fixture's best is its first lap: the card says there is no earlier best
  // "Distribution" opens the corner's row by keyboard, without leaving the page
  await js("document.querySelector('.opp-card [data-goto]').focus(); 1");
  await press('Enter');
  await waitFor("document.getElementById('an-T2')?.open === true", 'the T2 row opened');
  assert.match(await js('location.hash'), /^#\/analysis/);
  assert.match(await js("document.getElementById('an-T2').textContent"), /Quicker quarter[\s\S]*Throttle hesitation[\s\S]*manual gearbox only[\s\S]*gearbox setting was not recorded/);
  // the window switch reloads with the other window
  await js("window.__rendered = 0; const s = document.querySelector('#anWindow'); s.value = 'all'; s.dispatchEvent(new Event('change')); 1");
  await waitFor("window.__rendered > 0 && location.hash.includes('window=all') && document.querySelector('#anTop')", 'all laps');
  // reachable from Sessions and Ctrl+K
  await go('#/', "document.querySelector('a[href^=\"#/analysis?combo=\"]')");
  // 200 % zoom: no sideways scrolling
  await cdp('Emulation.setDeviceMetricsOverride', { width: 700, height: 900, deviceScaleFactor: 1, mobile: false });
  try {
    await go(`#/analysis?combo=${encodeURIComponent(key)}`, "document.querySelector('#anTop .opp-card')");
    await sleep(250);
    const [sw, iw] = await js('[document.documentElement.scrollWidth, innerWidth]');
    assert.ok(sw <= iw + 1, `${sw} px wide in a ${iw} px window`);
  } finally { await cdp('Emulation.clearDeviceMetricsOverride'); }
  assert.deepEqual(errors, []);
});

// PL7: the last flow, because it adds the newest laps of all (the drill's laps, dated now)
test('practice drill: Practise this on a Lap analysis card makes a drill with every part of the prescription; laps driven after it meet it; Development shows before and now (PL7)', { skip }, async () => {
  const key = 'fixture_ring|gp|fixture_gt';
  await go(`#/analysis?combo=${encodeURIComponent(key)}`, "document.querySelector('#anTop .opp-card [data-practise]')");
  assert.match(await js("document.querySelector('#anDrill').textContent"), /Practise this/);
  const n0 = dialogs.length;
  // T2's "throttle held part-way" finding becomes the drill (no other drill: no confirm)
  await js(`window.__rendered = 0; [...document.querySelectorAll('[data-practise]')].find((b) => JSON.parse(b.dataset.practise).join() === 'T2,holdMs').click(); 1`);
  await waitFor("window.__rendered > 0 && document.querySelector('#anDrill .drill')", 'the drill card').catch((e) => { throw new Error(`${e.message}; dialogs: ${dialogs.slice(n0).join(' | ')}`); });
  assert.equal(dialogs.length, n0, 'no dialog');
  const rx = await js("Object.fromEntries([...document.querySelectorAll('#anDrill [data-rx]')].map((e) => [e.dataset.rx, e.textContent.trim()]))");
  assert.deepEqual(Object.keys(rx), ['issue', 'evidence', 'exercise', 'criterion', 'minimum', 'review', 'hypothesis']);
  assert.match(rx.issue, /^T2: Your typical pass holds the throttle part-way/);
  assert.match(rx.evidence, /^12 valid passes of T2/);
  assert.match(rx.exercise, /^In T2, after the slowest point/);
  assert.match(rx.criterion, /^At least half of your newest 10 passes of T2/);
  assert.match(rx.hypothesis, /may[\s\S]*a possibility, not a proven cause/);
  assert.equal(await js("document.querySelector('#anDrill [data-drill-state]').dataset.drillState"), 'collecting');
  assert.match(await js("document.querySelector('#anDrill [data-drill-line]').textContent"), /^0 of 5 passes so far/);
  // the finding is marked as the drill, the corner row says Practising
  assert.match(await js("document.querySelector('.opp-card').textContent"), /your drill/);
  assert.equal(await js("document.querySelector('#an-T2 [data-mastery]').dataset.mastery"), 'practising');

  // five laps driven after it, without the part-throttle hold at T2 (written as the recorder would, from another process)
  execFileSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', `
    const db = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'src/db.js')).href)});
    const { insertLap, COMBO } = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'test/lapfixtures.js')).href)});
    const t = Date.now() + 1000, s = db.createSession({ ...COMBO, sessionType: 0, driver: 'Me', startedAt: t });
    for (let i = 1; i <= 5; i++) db.setLapCond(insertLap(db, { sessionId: s, lapNumber: 40 + i, recordedAt: t + i * 1000, params: { hold: [0, 0, 0] } }), { game: "1.0" });`],
  { env: childEnv, cwd: ROOT, stdio: 'ignore' });

  // evaluated: met, and Development shows the result before against now
  await go('#/development', "document.querySelector('#dvPractice')");
  assert.ok(await js("!!document.querySelector('#dvPractice [data-drill-state=\"met\"]')"), 'met');
  assert.match(await js("document.querySelector('#dvPracticeCounts').textContent"), /1 met/);
  assert.match(await js("document.querySelector('#dvPractice').textContent"), /T2: part-throttle time on the exit \(fixture ring · fixture gt\): 33 % of 12 passes before → 100 % of 5 after reached the target/);
  const d = (await api('/api/practice')).body.drills[0];
  assert.equal(d.state, 'met');
  assert.equal(d.eval.judged, 5);
  // a private GET: refused cross-site
  assert.equal((await api('/api/practice', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  // 200 % zoom: the drill cards fit without sideways scrolling
  await cdp('Emulation.setDeviceMetricsOverride', { width: 700, height: 900, deviceScaleFactor: 1, mobile: false });
  try {
    await go('#/development', "document.querySelector('#dvPractice')");
    await js("document.querySelectorAll('#dvPractice details').forEach((x) => { x.open = true; }); 1");
    await sleep(250);
    const [sw, iw] = await js('[document.documentElement.scrollWidth, innerWidth]');
    assert.ok(sw <= iw + 1, `${sw} px wide in a ${iw} px window`);
  } finally { await cdp('Emulation.clearDeviceMetricsOverride'); }
  assert.deepEqual(errors, []);
});
