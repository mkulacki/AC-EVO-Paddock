// Settings page, application management: update check, backup and restore, export, diagnostics.
// Server side: src/updates.js, src/backup.js, src/dataexport.js, src/diagnostics.js.
import { $, esc, api, post } from './util.js';

const size = (n) => (n >= 1073741824 ? `${(n / 1073741824).toFixed(2)} GB` : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const when = (t) => new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const plural = (n, w) => `${esc(String(n ?? '?'))} ${w}${n === 1 ? '' : 's'}`;
const REASON = { 'before-restore': 'made before a restore', scheduled: 'scheduled' };

/**
 * PL11 demo: start Paddock again with or without the demo (desktop app), then reload once the server answers with the
 * other mode. Outside the desktop app the server says how to start it instead.
 */
export async function switchDemo(on, btn) {
  if (btn) { btn.disabled = true; btn.textContent = on ? 'Opening the demo…' : 'Leaving the demo…'; }
  try { await post('/api/demo', { on }); }
  catch (e) { if (btn) { btn.disabled = false; btn.textContent = on ? 'Try the demo' : 'Leave the demo'; } alert(e.message); return; }
  const t0 = Date.now();
  const poll = async () => {
    try { const s = await fetch('/api/status', { cache: 'no-store' }).then((r) => r.json()); if (!!s.demo === !!on) return location.reload(); } catch { /* restarting */ }
    if (Date.now() - t0 < 60000) setTimeout(poll, 500);
  };
  setTimeout(poll, 800);
}

export const systemHtml = () => `
  <div class="card" id="sysDemo"><h2>Demo</h2>
    <p class="muted">Look around Paddock without the game: a mock car drives a fictional circuit, with two earlier sessions and their reports already there.
      The demo keeps its own laps and settings in <code>data\\demo</code>: nothing of it reaches your laps, stats, backups or the leaderboard, and it never starts the game or changes its files.</p>
    <div class="row"><button id="demoGo">Try the demo</button><span class="muted" id="demoState"></span></div></div>
  <div class="card" id="sysUpdates"><h2>Updates</h2><div class="sys-body"><span class="spinner"></span></div></div>
  <div class="card" id="sysBackup"><h2>Backup and restore</h2><div class="sys-body"><span class="spinner"></span></div></div>
  <div class="card"><h2>Export</h2>
    <p class="muted">Your laps and sessions as CSV files for a spreadsheet: one row per lap or session, with times, validity, car, track and setup. To share a lap's telemetry, use its export button in Sessions.</p>
    <div class="row"><a href="/api/export/laps.csv" download><button>Laps (CSV)</button></a><a href="/api/export/sessions.csv" download><button>Sessions (CSV)</button></a></div></div>
  <div class="card" id="sysDiag"><div class="row"><h2 style="margin:0">Diagnostics</h2><span class="spacer"></span>
      <button class="small" id="diagCopy">Copy for a bug report</button><button class="small ghost" id="diagShow">Show</button></div>
    <p class="muted">Version, data folder, game files, HUD and loader state, which readings are checked, and the end of the log. Your Gemini key, server passwords, driver name and Windows user folder are taken out. Paste it into a <a href="https://github.com/mkulacki/AC-EVO-Paddock/issues" target="_blank">GitHub issue</a>.</p>
    <span id="diagState" class="muted"></span><pre class="raw" id="diagText" hidden></pre></div>`;

export function bindSystem(onRestart) {
  api('/api/status').then((s) => {
    if (s.demo) { $('#demoGo').textContent = 'Leave the demo'; $('#demoState').textContent = 'You are in the demo now.'; }
    else if (!s.demoInApp) $('#demoState').textContent = 'From a source checkout: npm run demo';
    $('#demoGo').onclick = (e) => switchDemo(!s.demo, e.currentTarget);
  }).catch(() => {});
  updatesCard();
  backupCard(onRestart);
  const getText = async () => (await api('/api/diagnostics?format=text')).text;
  $('#diagShow').onclick = async () => { const pre = $('#diagText'); if (!pre.hidden) { pre.hidden = true; return; } pre.textContent = await getText(); pre.hidden = false; };
  $('#diagCopy').onclick = async () => {
    const t = await getText();
    try { await navigator.clipboard.writeText(t); $('#diagState').textContent = 'Copied ✓'; }
    catch { $('#diagText').textContent = t; $('#diagText').hidden = false; $('#diagState').textContent = 'Copy it from the box below.'; }
  };
}

async function updatesCard() {
  const box = $('#sysUpdates .sys-body');
  const draw = (u, busy) => {
    const latest = u.latest;
    box.innerHTML = `
      <p style="margin:0 0 6px">You have <b>${esc(u.current || '?')}</b>.
        ${latest ? `<b class="neg">${esc(latest.version)} is out</b>${latest.publishedAt ? ` (${esc(when(latest.publishedAt))})` : ''}: <a href="${esc(latest.url)}" target="_blank">see what's new and download</a>. Replace everything except <code>data\\</code>, as described in the release.`
          : u.checkedAt && !u.error ? 'This is the newest version.' : ''}</p>
      ${u.error ? `<p class="muted" style="margin:0 0 6px">Last check failed: ${esc(u.error)}</p>` : ''}
      <div class="row"><label class="row"><input type="checkbox" id="updOn" ${u.enabled ? 'checked' : ''}> Check once a day</label><span class="spacer"></span>
        ${u.checkedAt ? `<span class="muted" style="font-size:12px">checked ${esc(when(u.checkedAt))}</span>` : ''}
        <button class="small" id="updNow" ${busy ? 'disabled' : ''}>${busy ? 'Checking…' : 'Check now'}</button></div>
      <p class="hint" style="margin:6px 0 0">Paddock asks GitHub for its list of releases: one request, nothing about you is sent. It never downloads or installs anything by itself.</p>`;
    $('#updOn').onchange = async (e) => { await post('/api/settings', { updateCheck: e.target.checked }); };
    $('#updNow').onclick = async () => {
      draw(u, true);
      let n; try { n = await post('/api/updates/check', {}); } catch (e) { if (box.isConnected) draw({ ...u, error: e.message }); return; }
      window.dispatchEvent(new Event('paddock:updates'));
      if (box.isConnected) draw(n); // the driver may have left Settings meanwhile
    };
  };
  // the answer can come after the driver left Settings: the card is gone then, and nothing is drawn
  let u; try { u = await api('/api/updates'); } catch (e) { if (box.isConnected) box.innerHTML = `<p class="error">${esc(e.message)}</p>`; return; }
  if (box.isConnected) draw(u);
}

/**
 * What a restore does to secrets, by the parts it brings back (current secrets win, src/restore-apply.js): the key and
 * sign-in live in settings (part 'settings'), saved servers and their passwords in race.json (part 'race').
 */
export function restoreSecretsNote(parts = []) {
  const p = new Set(parts || []);
  return (p.has('settings') ? 'Your current Gemini key and leaderboard sign-in always stay: the backup only fills in a key you do not have. ' : '')
    + (p.has('race') ? 'Your saved server passwords always stay: the backup only fills in a password you do not have, and saved servers missing from the backup are kept. ' : '');
}

// ---------------------------------------------------------------- PL11 scheduled backups (src/autobackup.js)
const days = (n) => (n == null ? null : n >= 730 ? 'over two years' : n >= 60 ? `about ${Math.round(n / 30)} months` : `about ${n} day${n === 1 ? '' : 's'}`);
function scheduleHtml(s) {
  if (!s) return '';
  const c = s.config, f = s.forecast;
  const fc = f ? [`Laps database ${size(f.dbBytes)}`,
    f.lapsPer30d ? `about ${f.lapsPer30d} laps a month (+${size(f.growthPer30d)} a month)` : 'no laps in the last 90 days',
    c.on ? `${c.keep} scheduled backup${c.keep === 1 ? '' : 's'} kept ≈ ${size(f.retainedBytes)}` : null,
    f.freeBytes != null ? `${size(f.freeBytes)} free on this drive${f.daysUntilFull != null ? `, enough for ${days(f.daysUntilFull)} at this rate` : ''}` : null].filter(Boolean).join(' · ') : '';
  return `<h3 style="margin:10px 0 6px">Scheduled backups</h3>
    ${s.demo ? '<p class="muted" style="margin:0 0 6px">Not in the demo.</p>' : `
    <div class="row" style="margin:0 0 6px"><label class="row"><input type="checkbox" id="abOn" ${c.on ? 'checked' : ''}> Back up automatically</label>
      <select id="abEvery" aria-label="How often"><option value="daily" ${c.every === 'daily' ? 'selected' : ''}>every day</option><option value="weekly" ${c.every === 'weekly' ? 'selected' : ''}>every week</option></select>
      <label class="row">keep the newest <input type="number" id="abKeep" min="1" max="30" value="${c.keep}" style="width:56px" aria-label="Scheduled backups to keep"></label>
      <span class="spacer"></span><button class="small" id="abRun" title="Make and check a scheduled backup now">Run now</button></div>
    ${s.synced ? `<p class="note-warn card plain" style="margin:0 0 6px">The backups folder is inside ${esc(s.synced)}, which uploads every backup to the cloud.
      <label class="row"><input type="checkbox" id="abSynced" ${c.allowSynced ? 'checked' : ''}> Back up there anyway</label></p>` : ''}
    ${s.skip ? `<p class="error" style="margin:0 0 6px">${esc(s.skip.text)} <span class="muted">(${esc(when(s.skip.at))})</span></p>` : ''}
    <p class="hint" style="margin:0 0 6px">Only while you are not driving. Each one holds everything except your key, passwords and sign-in, and is opened and checked after it is made.
      Older scheduled backups are deleted once a newer one checks out; backups you make yourself are never deleted. A run is skipped (and said here) when the drive would get too full.
      ${c.on ? `${s.lastOkAt ? `Last: ${esc(when(s.lastOkAt))}. ` : ''}Next: ${esc(when(Math.max(Date.now(), s.nextDueAt)))} or later.` : ''}</p>`}
    ${fc ? `<p class="muted" style="margin:0 0 8px;font-size:12px">${fc}</p>` : ''}`;
}
function bindSchedule(s, say, draw) {
  if (!s || s.demo) return;
  const save = async (patch) => { try { await post('/api/backup/schedule', patch); draw(); } catch (err) { say(err.message, 'error'); } };
  $('#abOn').onchange = (e) => save({ on: e.target.checked });
  $('#abEvery').onchange = (e) => save({ every: e.target.value });
  $('#abKeep').onchange = (e) => save({ keep: Number(e.target.value) });
  $('#abSynced')?.addEventListener('change', (e) => save({ allowSynced: e.target.checked }));
  $('#abRun').onclick = async (e) => {
    e.currentTarget.disabled = true; say('Making and checking a backup…');
    try {
      const r = await post('/api/backup/schedule/run', {});
      say(r.ran ? `Backed up and verified: ${r.backup.name}${r.removed?.length ? ` (${r.removed.length} older scheduled backup${r.removed.length === 1 ? '' : 's'} deleted)` : ''}.` : r.text || 'Not made now.', r.ran ? 'muted' : 'error');
      draw();
    } catch (err) { say(err.message, 'error'); }
  };
}

const LS_PARTS = 'backup.parts';
const partLabel = (b) => (id) => (b.parts || []).find((p) => p.id === id)?.label || id;
async function backupCard(onRestart) {
  const box = $('#sysBackup .sys-body');
  let msg = '';
  // what to back up: everything until the driver unticks something
  let chosen = new Set(['laps', 'settings', 'race', 'setupNotes']);
  try { const s = JSON.parse(localStorage.getItem(LS_PARTS) || 'null'); if (Array.isArray(s)) chosen = new Set(s); } catch { /* default */ }
  const draw = async () => {
    let b; try { b = await api('/api/backup'); } catch (e) { if (box.isConnected) box.innerHTML = `<p class="error">${esc(e.message)}</p>`; return; }
    if (!box.isConnected) return; // the driver left Settings meanwhile (the page looks its parts up by id)
    const r = b.restored;
    box.innerHTML = `
      <p class="muted">A backup is one zip in <code>${esc(b.folder)}</code>, holding the parts you tick below. Restoring it brings back only those parts.
        Track and car caches are left out (Paddock rebuilds them), and so are disabled mods. Copy backups somewhere safe, for example another drive.</p>
      ${r ? `<p class="${r.ok ? 'neg' : 'error'}" style="margin:0 0 8px">${r.ok ? `Restored at the last start: ${esc(r.files.join(', '))}.` : `The last restore failed: ${esc(r.error)}. Your data from before is in the backup “made before a restore”.`}</p>` : ''}
      ${b.pending ? `<p class="note-warn card plain" style="margin:0 0 8px">A restore is waiting for Paddock to restart. <button class="small" id="bkRestart">Restart now</button> <button class="small ghost" id="bkCancel">Cancel the restore</button></p>` : ''}
      <h3 style="margin:4px 0 6px">What to back up</h3>
      <div class="bk-parts">${(b.parts || []).map((p) => `<label class="bk-part${p.exists ? '' : ' off'}">
        <input type="checkbox" data-part="${esc(p.id)}" ${p.exists && chosen.has(p.id) ? 'checked' : ''} ${p.exists ? '' : 'disabled'}>
        <span class="bk-txt"><b>${esc(p.label)}</b>${p.counts ? ` <span class="muted">${plural(p.counts.laps, 'lap')}, ${plural(p.counts.sessions, 'session')}</span>` : ''}
          <span class="muted bk-hint">${esc(p.hint)}</span>
          ${p.breakdown ? `<span class="muted bk-hint">${p.breakdown.filter((x) => x.size > 0).map((x) => `${esc(x.label)} ${size(x.size)}`).join(' · ')}</span>` : ''}</span>
        <span class="bk-size">${p.exists ? size(p.size) : '<span class="muted">none yet</span>'}</span></label>`).join('')}</div>
      <div class="row" style="margin:8px 0"><button class="primary" id="bkMake">Back up now</button><span class="muted" id="bkTotal"></span>
        <label class="row" title="The key and passwords stay on this PC unless you tick this. Untick it for a backup you give to someone else."><input type="checkbox" id="bkSecrets"> Include my Gemini key and server passwords</label>
        <span class="spacer"></span><button id="bkPick" title="A backup from another PC or an older copy">Add a backup file…</button><input type="file" id="bkUpload" accept=".zip" hidden></div>
      <p id="bkMsg" class="muted" style="margin:0 0 8px">${esc(msg)}</p>
      ${scheduleHtml(b.schedule)}
      ${b.backups.length ? `<div class="tablewrap"><table><thead><tr><th>Backup</th><th>Contents</th><th>Size</th><th></th></tr></thead><tbody>${b.backups.map((x) => `<tr>
        <td>${x.ok ? esc(when(x.createdAt)) : esc(x.name)}${x.reason && REASON[x.reason] ? ` <span class="muted">(${REASON[x.reason]})</span>` : ''}${x.includesSecrets ? ' <span class="badge" title="Contains your Gemini key and server passwords">with key</span>' : ''}
          ${x.verified ? (x.verified.ok ? ` <span class="badge" title="Opened and checked ${esc(when(x.verified.checkedAt))}: the laps database is intact and its counts match">verified</span>` : ` <span class="badge bad" title="${esc(x.verified.problems.join('; '))}">check failed</span>`) : ''}
          ${x.ok ? `<div class="muted" style="font-size:12px">${esc(x.name)}${x.app ? `, Paddock ${esc(x.app)}` : ''}</div>` : `<div class="error" style="font-size:12px">${esc(x.error)}</div>`}</td>
        <td>${x.counts ? `${plural(x.counts.laps, 'lap')}, ${plural(x.counts.sessions, 'session')}` : x.ok ? '<span class="muted">no laps</span>' : '–'}
          ${x.ok && x.parts && x.parts.length < (b.parts || []).length ? `<div class="muted" style="font-size:12px">${esc(x.parts.map(partLabel(b)).join(', '))}</div>` : ''}</td><td>${size(x.size)}</td>
        <td style="white-space:nowrap"><a href="/api/backup/file?name=${encodeURIComponent(x.name)}" download><button class="small ghost">Save as…</button></a>
          ${x.ok ? `<button class="small ghost" data-verify="${esc(x.name)}" title="Open the copy and check it: database integrity, row counts, no secrets it should not hold">Verify</button><button class="small" data-restore="${esc(x.name)}">Restore</button>` : ''}<button class="small ghost" data-del="${esc(x.name)}" aria-label="Delete backup">Delete</button></td></tr>`).join('')}</tbody></table></div>`
        : '<p class="muted" style="margin:0">No backups yet.</p>'}`;
    const say = (t, cls = 'muted') => { msg = t; $('#bkMsg').className = cls; $('#bkMsg').textContent = t; };
    // the chosen parts: remembered; the total shows what the backup will roughly hold (before zip compression)
    const total = () => {
      const on = (b.parts || []).filter((p) => p.exists && chosen.has(p.id));
      $('#bkTotal').textContent = on.length ? `${size(on.reduce((s, p) => s + p.size, 0))} of data` : 'nothing chosen';
      $('#bkMake').disabled = !on.length;
    };
    box.querySelectorAll('[data-part]').forEach((cb) => { cb.onchange = () => {
      if (cb.checked) chosen.add(cb.dataset.part); else chosen.delete(cb.dataset.part);
      try { localStorage.setItem(LS_PARTS, JSON.stringify([...chosen])); } catch { /* not remembered */ }
      total();
    }; });
    total();
    $('#bkMake').onclick = async (e) => {
      e.currentTarget.disabled = true; say('Backing up…');
      try { const x = await post('/api/backup', { includeSecrets: $('#bkSecrets').checked, parts: [...chosen] }); msg = `Backed up: ${x.name} (${size(x.size)}).`; draw(); }
      catch (err) { say(err.message, 'error'); e.currentTarget.disabled = false; }
    };
    $('#bkPick').onclick = () => $('#bkUpload').click();
    $('#bkUpload').onchange = async (e) => {
      const f = e.target.files[0]; if (!f) return;
      say('Checking the file…');
      try {
        const r2 = await fetch('/api/backup/upload', { method: 'POST', body: f });
        const j = await r2.json(); if (!r2.ok) throw new Error(j.error);
        msg = `Added: ${j.name}. Press Restore on it to use it.`; draw();
      } catch (err) { say(err.message, 'error'); }
    };
    box.querySelectorAll('[data-del]').forEach((btn) => { btn.onclick = async () => {
      if (!confirm(`Delete the backup ${btn.dataset.del}?\n\nThis cannot be undone.`)) return;
      try { await api(`/api/backup/file?name=${encodeURIComponent(btn.dataset.del)}`, { method: 'DELETE' }); msg = ''; draw(); } catch (err) { say(err.message, 'error'); }
    }; });
    box.querySelectorAll('[data-restore]').forEach((btn) => { btn.onclick = async () => {
      const x = b.backups.find((y) => y.name === btn.dataset.restore);
      const what = (x.parts || []).map(partLabel(b)).join(', ') || 'laps, sessions and settings';
      if (!confirm(`Restore the backup of ${when(x.createdAt)}${x.counts ? ` (${plural(x.counts.laps, 'lap')})` : ''}?\n\nIt brings back: ${what}. These are replaced by the ones in the backup; anything else stays as it is. `
        + restoreSecretsNote(x.parts)
        + 'Paddock first makes a backup of your current data (listed as "made before a restore", without your key, passwords or sign-in), then restarts.')) return;
      btn.disabled = true; say('Checking the backup and backing up your current data…');
      try { await post('/api/backup/restore', { name: x.name }); say('Restarting to restore…'); onRestart?.(btn); }
      catch (err) { say(err.message, 'error'); btn.disabled = false; }
    }; });
    box.querySelectorAll('[data-verify]').forEach((btn) => { btn.onclick = async () => {
      btn.disabled = true; say('Checking the backup…');
      try { const v = await post('/api/backup/verify', { name: btn.dataset.verify }); msg = v.ok ? `${btn.dataset.verify}: verified, the copy opens and its counts match.` : `${btn.dataset.verify}: check failed: ${v.problems.join('; ')}`; draw(); }
      catch (err) { say(err.message, 'error'); btn.disabled = false; }
    }; });
    bindSchedule(b.schedule, say, draw);
    $('#bkRestart')?.addEventListener('click', (e) => onRestart?.(e.currentTarget));
    $('#bkCancel')?.addEventListener('click', async () => { await api('/api/backup/restore', { method: 'DELETE' }); msg = 'Restore cancelled.'; draw(); });
  };
  draw();
}
