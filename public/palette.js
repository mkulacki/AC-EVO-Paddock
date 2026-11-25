// Command palette (Ctrl+K) and keyboard shortcuts (? for the list).
// Finds pages, Settings sections, your track/car combos, recent sessions, tracks and layouts, and cars with saved
// setups, plus a few commands. Nothing here starts the game: that stays a deliberate click on the Race tab.
import { esc, api, post, prettyName } from './util.js';

const PAGES = [
  ['Home', '#/home', 'Your driving at a glance'], ['Race', '#/race', 'Set up and start a session'], ['Sessions', '#/', 'Your sessions by track and car'], ['Sessions by date', '#/?by=date', 'Newest first'], ['Development', '#/development', 'Goals, challenges, achievements and race weekends'], ['Leaderboards', '#/leaderboard', 'Online lap times and sectors, by track and car'],
  ['Tracks', '#/tracks', 'Maps, corners and brake points'], ['Cars', '#/cars', 'Every car, with your distance, records and driving style per car'], ['Coach', '#/coach', 'AI coach, training plan and braking points per track and car'], ['Setups', '#/setups', 'Your saved setups and the AI engineer'], ['Setup experiments', '#/experiments', 'A/B stints of two setups on one car and track'],
  ['Game', '#/game', 'AC EVO, App Loader and HUD status'], ['Mods', '#/mods', 'Install, disable and remove mods'], ['Settings', '#/settings', 'Driver, Gemini, folders'],
  ['Setup guide', '#/welcome', 'Find the game, check the connections, optional services, first session, first comparison'],
];
// Settings sections: [label, element id or heading text on the Settings page]
const SECTIONS = [
  ['Paddock HUD settings', 'Paddock HUD'], ['Brake spotter settings', 'Brake spotter'], ['Updates', '#sysUpdates'], ['Backup and restore', '#sysBackup'],
  ['Export laps and sessions (CSV)', 'Export'], ['Diagnostics for a bug report', '#sysDiag'], ['Telemetry debug (raw values)', 'Telemetry debug'],
  ['Setup recognition (check readings against the game)', null, '#/setups'],
];
export const SHORTCUTS = [
  ['Ctrl K', 'Search and commands'], ['?', 'This list'], ['Alt 1 … 9, 0', 'Home, Race, Sessions, Development, Leaderboards, Tracks, Cars, Setups, Game; 0 Settings'],
  ['Ctrl B', 'Collapse or expand the sidebar'], ['Esc', 'Close a dialog'], ['Ctrl + / Ctrl − / Ctrl 0', 'Larger, smaller or normal text and page size'],
  ['Ctrl Enter', 'Session notes: save'],
  ['← / →', 'Telemetry: previous or next lap of the session; Replay: step (Shift: 10 samples)'], ['Space', 'Replay: play or pause'], ['[ / ]', 'Replay: previous or next corner'],
  ['F8', 'In game: switch the HUD reference (best, ideal, session best)'], ['F5 · F11 · F12', 'Desktop app: reload, full screen, developer tools'],
];
export const NAV_ORDER = ['#/home', '#/race', '#/', '#/development', '#/leaderboard', '#/tracks', '#/cars', '#/setups', '#/game', '#/mods', '#/settings'];

// subsequence match with bonuses for word starts and runs; -1 = no match
export function score(query, text) {
  const q = query.toLowerCase().trim(), t = text.toLowerCase();
  if (!q) return 0;
  let ti = 0, s = 0, run = 0;
  for (const ch of q) {
    if (ch === ' ') { run = 0; continue; }
    const at = t.indexOf(ch, ti);
    if (at < 0) return -1;
    const wordStart = at === 0 || /[\s\-_·(/]/.test(t[at - 1]);
    run = at === ti ? run + 1 : 0;
    s += 1 + (wordStart ? 3 : 0) + run * 2 - Math.min(3, (at - ti) * 0.1);
    ti = at + 1;
  }
  return s + (t.startsWith(q) ? 5 : 0) - t.length * 0.01;
}

// read fresh each time the palette opens (three small local requests): a deleted or imported lap shows at once
async function sources() {
  const safe = (p) => api(p).catch(() => null);
  const [ov, tr, su, nx] = await Promise.all([safe('/api/overview'), safe('/api/tracks'), safe('/api/setups'), safe('/api/notes/index')]);
  const items = [];
  for (const [label, href, hint] of PAGES) items.push({ kind: 'Page', label, hint, href });
  for (const [label, target, href] of SECTIONS) items.push({ kind: 'Settings', label, href: href || '#/settings', target });
  items.push({ kind: 'Page', label: 'Integration health', hint: 'Game connection, telemetry, recording, HUD, telemetry checks, online services', href: '#/game', target: '#gHealth' });
  for (const c of ov?.combos || []) {
    const name = `${prettyName(c.track)} ${prettyName(c.layout)} · ${prettyName(c.car)}`;
    const key = encodeURIComponent(c.key);
    items.push({ kind: 'Progress', label: name, hint: `${c.laps} laps`, href: `#/progress?combo=${key}` });
    if (c.validLaps >= 2) items.push({ kind: 'Consistency', label: name, href: `#/consistency?combo=${key}` });
    if (c.validLaps >= 1) items.push({ kind: 'Analysis', label: name, hint: 'Where to gain time, corner by corner', href: `#/analysis?combo=${key}` });
    items.push({ kind: 'Setup history', label: name, href: `#/setuphistory?combo=${key}` });
    items.push({ kind: 'Setup experiments', label: name, hint: 'A/B stints of two setups', href: `#/experiments?combo=${key}` });
    items.push({ kind: 'Coach', label: name, href: `#/coach?combo=${key}` });
    if (c.bestLapId && c.idealMs) items.push({ kind: 'Compare', label: `Best lap against ideal · ${name}`, href: `#/compare?laps=${c.bestLapId}&ref=ideal` });
  }
  const sessions = (ov?.sessions || []).filter((s) => (ov.laps || []).some((l) => l.session_id === s.id)).slice(0, 40);
  for (const s of sessions) {
    const d = new Date(s.started_at).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    const n = nx?.sessions?.[s.id]; // PL5: its tags and note are searchable too
    items.push({ kind: 'Session', label: `${prettyName(s.track)} ${prettyName(s.layout)} · ${prettyName(s.car)}${n?.tags?.length ? ` · ${n.tags.map((t) => `#${t}`).join(' ')}` : ''}`,
      hint: n?.note ? `${d} · ${n.note.slice(0, 40)}` : d, href: `#/report?session=${s.id}` });
  }
  for (const t of nx?.tags || []) items.push({ kind: 'Tag', label: t.tag, hint: `${t.n} session${t.n === 1 ? '' : 's'}`, href: `#/?tag=${encodeURIComponent(t.tag)}` });
  for (const b of nx?.bookmarks || []) items.push({ kind: 'Bookmark', label: `${b.corner} · ${prettyName(b.combo.track)} ${prettyName(b.combo.layout)} · ${prettyName(b.combo.car)}`, hint: b.note.slice(0, 50), href: `#/report?session=${b.sessionId}&notes=1` });
  for (const t of tr?.tracks || []) for (const l of t.layouts || []) {
    items.push({ kind: 'Track', label: `${t.name} ${l.name}`, hint: [t.countryName, l.lengthM ? `${(l.lengthM / 1000).toFixed(2)} km` : ''].filter(Boolean).join(' · '),
      href: `#/track?id=${encodeURIComponent(t.id)}&layout=${encodeURIComponent(l.key)}` });
  }
  for (const c of su?.cars || []) items.push({ kind: 'Setups', label: c.carName, hint: `${c.count} setup${c.count === 1 ? '' : 's'}`, href: `#/setups?car=${encodeURIComponent(c.carId)}` });
  items.push({ kind: 'Command', label: 'Check for Paddock updates', run: async () => { const u = await post('/api/updates/check', {}); window.dispatchEvent(new Event('paddock:updates')); return u.latest ? `${u.latest.version} is out: see Settings → Updates` : u.error ? `Check failed: ${u.error}` : 'You have the newest version'; } });
  items.push({ kind: 'Command', label: 'Collapse or expand the sidebar', run: () => { toggleSide(); } });
  items.push({ kind: 'Command', label: 'Keyboard shortcuts', run: () => { setTimeout(showShortcuts, 0); } });
  items.push({ kind: 'Command', label: 'Open the setup guide', run: () => { location.hash = '#/welcome'; } });
  return items;
}
// another dialog (the garage, a text prompt) is open: the palette and the shortcuts stay out of its way
const otherDialog = () => !!document.querySelector('.modal-back, .palette-back');

// ---------------------------------------------------------------- the dialog
const KINDS = ['Page', 'Settings', 'Progress', 'Consistency', 'Compare', 'Session', 'Track', 'Setups', 'Setup history', 'Coach', 'Tag', 'Bookmark', 'Command'];
/**
 * What the palette lists for a query. Empty: pages and recent sessions. A first word naming a kind, followed by more
 * words ("track brands", "session monza"), keeps only that kind; a single word is always searched as text, so
 * "tracks" finds the Tracks page.
 */
export function filterItems(items, q) {
  const words = String(q || '').trim().split(/\s+/).filter(Boolean);
  // every page, then the 6 newest sessions (a fixed cut-off of 14 hid the sessions once there were 14 pages)
  if (!words.length) return [...items.filter((it) => it.kind === 'Page'), ...items.filter((it) => it.kind === 'Session').slice(0, 6)];
  // a kind of several words typed in full ("setup history monza") wins; else the first word starts a word of a kind
  const lower = words.join(' ').toLowerCase();
  const full = KINDS.find((k) => k.includes(' ') && lower.startsWith(`${k.toLowerCase()} `));
  const kind = full || (words.length > 1 && words[0].length >= 3 ? KINDS.find((k) => k.toLowerCase().split(' ').some((w) => w.startsWith(words[0].toLowerCase()))) : null);
  const text = full ? words.slice(full.split(' ').length).join(' ') : kind ? words.slice(1).join(' ') : words.join(' ');
  const rank = (pool, q) => pool.map((it) => ({ it, s: score(q, it.label) })).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s).slice(0, 40).map((x) => x.it);
  const found = rank(kind ? items.filter((it) => it.kind === kind) : items, text);
  // nothing of that kind: the words as plain text after all ("setup guide" is a page, not a setup named "guide")
  return found.length || !kind ? found : rank(items, words.join(' '));
}
let dlg = null;
function open() {
  if (dlg || otherDialog()) return;
  const last = document.activeElement;
  dlg = document.createElement('div');
  const mine = dlg;
  dlg.className = 'palette-back';
  dlg.innerHTML = `<div class="palette" role="dialog" aria-modal="true" aria-label="Search and commands">
    <input type="text" placeholder="Search pages, tracks, cars, sessions…" aria-label="Search" autocomplete="off" spellcheck="false">
    <ul class="palette-list" role="listbox"><li class="palette-note"><span class="spinner"></span> Loading…</li></ul>
    <div class="palette-foot muted"><span><kbd>↑</kbd> <kbd>↓</kbd> choose</span><span><kbd>Enter</kbd> open</span><span><kbd>Esc</kbd> close</span></div></div>`;
  document.body.appendChild(dlg);
  const input = dlg.querySelector('input'), list = dlg.querySelector('ul');
  let items = [], shown = [], sel = 0, note = '';
  const close = () => { if (dlg !== mine) return; mine.remove(); dlg = null; last?.focus?.(); }; // only this palette (a later one may be open)
  const draw = () => {
    const q = input.value;
    shown = filterItems(items, q);
    sel = Math.min(sel, Math.max(0, shown.length - 1));
    list.innerHTML = note ? `<li class="palette-note">${esc(note)}</li>`
      : shown.length ? shown.map((it, i) => `<li role="option" data-i="${i}" class="${i === sel ? 'sel' : ''}" aria-selected="${i === sel}">
          <span class="pk">${esc(it.kind)}</span><span class="pl">${esc(it.label)}</span>${it.hint ? `<span class="ph">${esc(it.hint)}</span>` : ''}</li>`).join('')
        : '<li class="palette-note">Nothing found.</li>';
    list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  };
  const choose = async (it) => {
    if (!it) return;
    if (it.run) { note = 'Working…'; draw(); try { const msg = await it.run(); if (msg) { note = msg; draw(); setTimeout(close, 1800); } else close(); } catch (e) { note = e.message; draw(); } return; }
    close();
    if (location.hash !== it.href) location.hash = it.href;
    if (it.target) afterRender(() => scrollToSection(it.target));
  };
  input.oninput = () => { sel = 0; note = ''; draw(); };
  input.onkeydown = (e) => {
    if (e.key === 'ArrowDown') { sel = Math.min(shown.length - 1, sel + 1); draw(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); draw(); e.preventDefault(); }
    else if (e.key === 'Enter') { choose(shown[sel]); e.preventDefault(); }
    else if (e.key === 'Escape') { close(); e.preventDefault(); e.stopPropagation(); }
  };
  list.onclick = (e) => { const li = e.target.closest('li[data-i]'); if (li) choose(shown[+li.dataset.i]); };
  dlg.onmousedown = (e) => { if (e.target === dlg) close(); };
  input.focus();
  sources().then((x) => { items = x; if (dlg) draw(); }, (e) => { note = e.message; draw(); });
}

function afterRender(fn) {
  let done = false;
  const go = () => { if (!done) { done = true; setTimeout(fn, 50); } };
  window.addEventListener('paddock:rendered', go, { once: true });
  setTimeout(go, 1500);
}
function scrollToSection(target) {
  const el = target.startsWith('#') ? document.querySelector(target)
    : [...document.querySelectorAll('#view h2')].find((h) => h.textContent.trim().startsWith(target))?.closest('.card');
  if (!el) return;
  el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1400);
}

export function showShortcuts() {
  if (otherDialog()) return;
  const last = document.activeElement;
  const back = document.createElement('div');
  back.className = 'palette-back';
  back.innerHTML = `<div class="palette shortcuts" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" tabindex="-1">
    <div class="row"><h2 style="margin:0">Keyboard shortcuts</h2><span class="spacer"></span><button class="ghost small" data-close aria-label="Close">✕</button></div>
    <table>${SHORTCUTS.map(([k, v]) => `<tr><td>${k.split(' ').map((x) => (x === '…' || x === '/' || x === '·' ? esc(x) : `<kbd>${esc(x)}</kbd>`)).join(' ')}</td><td>${esc(v)}</td></tr>`).join('')}</table>
    <p class="muted" style="margin:10px 0 0;font-size:12px">Shortcuts do nothing while you type in a field.</p></div>`;
  document.body.appendChild(back);
  const box = back.querySelector('.palette');
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey, true); last?.focus?.(); };
  // while it is open, keys do not reach the page behind it (a replay would still play on Space)
  const onKey = (e) => {
    if (e.key === 'Escape' || e.key === '?') { close(); e.preventDefault(); e.stopPropagation(); return; }
    if (e.key === 'Tab') { e.preventDefault(); back.querySelector('[data-close]').focus(); }
    else if (!(e.key === 'Enter' && e.target.matches('[data-close]'))) { e.preventDefault(); }
    e.stopPropagation();
  };
  document.addEventListener('keydown', onKey, true);
  back.querySelector('[data-close]').onclick = close;
  back.onmousedown = (e) => { if (e.target === back) close(); };
  box.focus();
}

const narrow = typeof matchMedia === 'function' ? matchMedia('(max-width: 900px)') : { matches: false, addEventListener() {} }; // (tests import this in Node)
export function toggleSide(force) {
  const on = force ?? !document.documentElement.classList.contains('side-collapsed');
  document.documentElement.classList.toggle('side-collapsed', on);
  // the choice is remembered for wide windows only: in a narrow one the rail is automatic
  if (!narrow.matches) { try { localStorage.setItem('side.collapsed', on ? '1' : '0'); } catch { /* private mode */ } }
  const b = document.getElementById('sideToggle');
  if (b) { b.title = on ? 'Expand the sidebar' : 'Collapse the sidebar'; b.setAttribute('aria-label', b.title); }
}

const typing = (e) => { const t = e.target; return t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)); };
export function initShortcuts() {
  document.getElementById('openPalette')?.addEventListener('click', open);
  document.getElementById('openShortcuts')?.addEventListener('click', showShortcuts);
  document.getElementById('sideToggle')?.addEventListener('click', () => toggleSide());
  toggleSide(document.documentElement.classList.contains('side-collapsed')); // titles in step with the stored state
  // narrow windows: the rail, without changing the stored choice
  const fit =() => { if (narrow.matches) document.documentElement.classList.add('side-collapsed'); else { try { document.documentElement.classList.toggle('side-collapsed', localStorage.getItem('side.collapsed') === '1'); } catch { /* */ } } };
  narrow.addEventListener('change', fit); fit();
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || otherDialog()) return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && !e.altKey && k === 'k') { e.preventDefault(); open(); return; }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && k === 'b' && !typing(e)) { e.preventDefault(); toggleSide(); return; }
    if (typing(e)) return;
    if (e.key === '?' && !e.ctrlKey && !e.altKey) { e.preventDefault(); showShortcuts(); return; }
    // by key position, so it also works on keyboards where the digits need Shift (AZERTY)
    const digit = /^Digit([0-9])$/.exec(e.code)?.[1];
    if (e.altKey && !e.ctrlKey && digit) { e.preventDefault(); location.hash = digit === '0' ? '#/settings' : NAV_ORDER[+digit - 1]; } // 1-9: the first nine pages; 0: Settings
  });
}
