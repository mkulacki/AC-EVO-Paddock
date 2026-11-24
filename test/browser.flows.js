// Browser flows (PL2): the real pages in headless Edge (or Chrome), driven over the DevTools protocol with Node's own
// WebSocket, against a mock server on scratch data. `npm run test:browser` (also part of `npm run verify`).
// Covers: open a session, compare two laps, import a valid / duplicate / broken lap file, change a setting, keyboard
// navigation (Alt+digit, Ctrl+K palette, ?, Esc), the damaged-file notice in Settings (PL1D, OD-PL-5). Every page must
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
import { isolate, ROOT } from './helpers.js';

const BROWSERS = [process.env.PADDOCK_BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', '/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean);
const BROWSER = BROWSERS.find((b) => fs.existsSync(b));
const skip = !BROWSER ? 'no Edge or Chrome found (set PADDOCK_BROWSER)' : typeof WebSocket !== 'function' ? 'this Node has no WebSocket' : false;

const env = isolate('browser');
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
  const text = key.length === 1 && !alt && !ctrl ? key : undefined;
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key, code: c, modifiers, windowsVirtualKeyCode: vk, text });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code: c, modifiers, windowsVirtualKeyCode: vk });
}
const api = (p, opts) => fetch(`${base}${p}`, opts).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

before(async () => {
  if (skip) return;
  // demo laps on scratch data, then the server on a free port (as test/smoke.test.js does)
  execFileSync(process.execPath, node(path.join(ROOT, 'src/mock.js'), '--seed', '6'), { env: childEnv, cwd: ROOT, stdio: 'ignore' });
  // a damaged setup-meta.json: the server keeps it aside at start and the Settings page must say so (OD-PL-5)
  fs.writeFileSync(path.join(env.ACEVO_DATA, 'setup-meta.json'), '{"files": {"x": {"notes": "half');
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
  const id = o.laps[o.laps.length - 1].id;
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
  assert.deepEqual(n.map((x) => [x.file, x.state, x.keptAs, x.savesRefused]), [['setup-meta.json', 'aside', kept, false]]);
  assert.equal((await api('/api/settings')).body.canSave, true);
  await go('#/settings', "document.querySelector('#fileNotices')");
  assert.equal(await js("document.querySelector('#fileNotices').getAttribute('role')"), 'status');
  const text = await js("document.querySelector('#fileNotices').textContent");
  assert.match(text, /setup-meta\.json was damaged/);
  assert.ok(text.includes(`data/${kept}`), 'where the copy is');
  assert.match(text, /rename it back/);
  assert.ok(!text.includes(env.ACEVO_DATA), 'no full folder path');
  assert.equal(await js("document.querySelector('#fileNotices a[href=\"#/setups\"]') !== null"), true, 'a link to where the notes are');
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
