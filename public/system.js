// Settings page, application management: update check, backup and restore, export, diagnostics.
// Server side: src/updates.js, src/backup.js, src/dataexport.js, src/diagnostics.js.
import { $, esc, api, post } from './util.js';

const size = (n) => (n >= 1073741824 ? `${(n / 1073741824).toFixed(2)} GB` : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const when = (t) => new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const plural = (n, w) => `${esc(String(n ?? '?'))} ${w}${n === 1 ? '' : 's'}`;
const REASON = { 'before-restore': 'made before a restore' };

export const systemHtml = () => `
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
    $('#updNow').onclick = async () => { draw(u, true); try { const n = await post('/api/updates/check', {}); draw(n); window.dispatchEvent(new Event('paddock:updates')); } catch (e) { draw({ ...u, error: e.message }); } };
  };
  try { draw(await api('/api/updates')); } catch (e) { box.innerHTML = `<p class="error">${esc(e.message)}</p>`; }
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
    let b; try { b = await api('/api/backup'); } catch (e) { box.innerHTML = `<p class="error">${esc(e.message)}</p>`; return; }
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
      ${b.backups.length ? `<div class="tablewrap"><table><thead><tr><th>Backup</th><th>Contents</th><th>Size</th><th></th></tr></thead><tbody>${b.backups.map((x) => `<tr>
        <td>${x.ok ? esc(when(x.createdAt)) : esc(x.name)}${x.reason && REASON[x.reason] ? ` <span class="muted">(${REASON[x.reason]})</span>` : ''}${x.includesSecrets ? ' <span class="badge" title="Contains your Gemini key and server passwords">with key</span>' : ''}
          ${x.ok ? `<div class="muted" style="font-size:12px">${esc(x.name)}${x.app ? `, Paddock ${esc(x.app)}` : ''}</div>` : `<div class="error" style="font-size:12px">${esc(x.error)}</div>`}</td>
        <td>${x.counts ? `${plural(x.counts.laps, 'lap')}, ${plural(x.counts.sessions, 'session')}` : x.ok ? '<span class="muted">no laps</span>' : '–'}
          ${x.ok && x.parts && x.parts.length < (b.parts || []).length ? `<div class="muted" style="font-size:12px">${esc(x.parts.map(partLabel(b)).join(', '))}</div>` : ''}</td><td>${size(x.size)}</td>
        <td style="white-space:nowrap"><a href="/api/backup/file?name=${encodeURIComponent(x.name)}" download><button class="small ghost">Save as…</button></a>
          ${x.ok ? `<button class="small" data-restore="${esc(x.name)}">Restore</button>` : ''}<button class="small ghost" data-del="${esc(x.name)}" aria-label="Delete backup">Delete</button></td></tr>`).join('')}</tbody></table></div>`
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
        + ((x.parts || []).includes('settings') ? 'Your leaderboard sign-in stays as it is (backups never hold it), and so do your Gemini key and server passwords when the backup has none. ' : '')
        + 'Paddock first makes a backup of your current data (listed as "made before a restore", without your key, passwords or sign-in), then restarts.')) return;
      btn.disabled = true; say('Checking the backup and backing up your current data…');
      try { await post('/api/backup/restore', { name: x.name }); say('Restarting to restore…'); onRestart?.(btn); }
      catch (err) { say(err.message, 'error'); btn.disabled = false; }
    }; });
    $('#bkRestart')?.addEventListener('click', (e) => onRestart?.(e.currentTarget));
    $('#bkCancel')?.addEventListener('click', async () => { await api('/api/backup/restore', { method: 'DELETE' }); msg = 'Restore cancelled.'; draw(); });
  };
  draw();
}
