// Mods tab: install (.zip / .kspkg), list, disable/enable, delete, rename and regroup AC EVO mods
import { $, api, post, esc } from './util.js';

const fmtSize = (b) => (b == null ? '–' : b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : b < 1073741824 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1073741824).toFixed(2)} GB`);
const fmtDate = (t) => (t ? new Date(t).toLocaleDateString() : '–');

export async function viewMods(view, cleanup) {
  const state = { mods: [], running: false, open: new Set(), q: '', msg: null };

  view.innerHTML = `
    <div class="row" style="margin-bottom:16px"><h1>Mods</h1><span class="spacer"></span>
      <input id="mq" placeholder="Filter mods…" style="width:200px">
      <button class="primary" id="mAdd">Install mod…</button></div>
    <div id="mRun"></div>
    <div class="card drop" id="mDrop">
      <b>Drop a .zip or .kspkg here</b> <span class="muted">or use “Install mod…”.</span>
      <div class="muted" style="font-size:13px;margin-top:4px">Files go into <code>Saved Games\\ACE\\mods</code>. Zips laid out as <code>mods\\…</code>, <code>uiresources\\…</code>, or a bare App Loader app are detected automatically.</div>
      <div id="mProg"></div>
    </div>
    <div id="mMsg"></div>
    <div class="card" id="mList"><span class="spinner"></span> Loading…</div>`;

  const setMsg = (html, cls = '') => { $('#mMsg').innerHTML = html ? `<div class="card ${cls}" style="padding:12px 16px">${html}</div>` : ''; };

  async function load() {
    const r = await api('/api/mods');
    state.mods = r.mods; state.running = r.running;
    render();
  }

  function render() {
    $('#mRun').innerHTML = state.running ? `<div class="card error" style="padding:12px 16px">AC EVO is running. Close the game to install, disable or delete mods. Changing mod files while the game runs can crash it.</div>` : '';
    const q = state.q.toLowerCase();
    const list = state.mods.filter((m) => !q || m.name.toLowerCase().includes(q) || m.files.some((f) => f.path.toLowerCase().includes(q)));
    const on = state.mods.filter((m) => m.enabled).length;
    const dis = state.running ? 'disabled title="Close AC EVO first"' : '';
    $('#mList').innerHTML = !state.mods.length ? '<div class="empty"><p>No mods installed.</p></div>' : `
      <div class="row" style="margin-bottom:8px"><h2 style="margin:0">Installed</h2><span class="muted">${on} enabled · ${state.mods.length - on} disabled</span></div>
      <table class="mods"><thead><tr><th>Mod</th><th>Type</th><th>Files</th><th>Size</th><th>Date</th><th></th></tr></thead><tbody>
      ${list.map((m) => `
        <tr class="${m.enabled ? '' : 'off'}" data-id="${esc(m.id)}">
          <td><button class="ghost small tog" data-open="${esc(m.id)}" title="Show files">${state.open.has(m.id) ? '▾' : '▸'}</button>
            <b>${esc(m.name)}</b>
            ${m.protected ? '<span class="badge accent" title="Paddock needs this mod for the in-game HUD">Required by Paddock</span>' : ''}
            ${m.enabled ? '' : '<span class="badge bad">disabled</span>'}
            ${m.managed ? '' : '<span class="badge" title="Installed outside Paddock; files grouped by name">detected</span>'}</td>
          <td class="secondary">${esc(m.kind)}</td>
          <td>${m.files.length}</td>
          <td>${fmtSize(m.size)}</td>
          <td class="muted" title="${m.installedAt ? 'installed' : 'last modified'}">${fmtDate(m.installedAt || m.modifiedAt)}</td>
          <td class="actions">
            ${m.enabled ? `<button class="small" data-op="disable" ${dis}>Disable</button>` : `<button class="small" data-op="enable" ${dis}>Enable</button>`}
            <button class="small ghost" data-op="delete" ${dis} title="Delete permanently">✕</button></td>
        </tr>
        ${state.open.has(m.id) ? `<tr class="mod-detail"><td colspan="6">
          <div class="row" style="margin-bottom:8px">
            <input class="mName" value="${esc(m.name)}" style="width:240px"><button class="small" data-op="rename">Rename</button>
            ${m.enabled && state.mods.some((x) => x.enabled && x.id !== m.id) ? `<span class="muted">·</span><span class="secondary">Move these files into</span>
              <select class="mInto">${state.mods.filter((x) => x.enabled && x.id !== m.id).map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('')}</select>
              <button class="small" data-op="merge">Merge</button>` : ''}
            ${m.file ? `<span class="spacer"></span><span class="muted">from ${esc(m.file)}</span>` : ''}
          </div>
          <ul class="mod-files">${m.files.map((f) => `<li><code>${esc(f.path)}</code> <span class="muted">${fmtSize(f.size)}</span></li>`).join('') || '<li class="muted">no files</li>'}</ul>
          ${m.enabled ? '' : '<p class="muted" style="margin:6px 0 0;font-size:12px">Disabled: the files are kept in Paddock\'s data\\mods-disabled folder until you enable or delete the mod.</p>'}
        </td></tr>` : ''}`).join('')}
      </tbody></table>
      ${list.length ? '' : '<p class="muted">No mod matches the filter.</p>'}`;

    $('#mList').querySelectorAll('[data-open]').forEach((b) => b.onclick = () => {
      const id = b.dataset.open; state.open.has(id) ? state.open.delete(id) : state.open.add(id); render();
    });
    $('#mList').querySelectorAll('[data-op]').forEach((b) => b.onclick = () => {
      const tr = b.closest('tr');
      const row = tr.classList.contains('mod-detail') ? tr.previousElementSibling : tr;
      act(row.dataset.id, b.dataset.op, tr);
    });
  }

  async function act(id, op, tr) {
    const m = state.mods.find((x) => x.id === id);
    if (!m) return;
    const body = { id, op };
    if (op === 'rename') body.name = tr.querySelector('.mName').value;
    if (op === 'merge') {
      body.into = tr.querySelector('.mInto').value;
      const into = state.mods.find((x) => x.id === body.into);
      if (!confirm(`Move all ${m.files.length} file(s) of “${m.name}” into “${into?.name}”? They will be disabled and deleted together from then on.`)) return;
    }
    if (op === 'delete' && !confirm(`Delete “${m.name}” permanently?\n\n${m.files.length} file(s), ${fmtSize(m.size)}. This cannot be undone. Use Disable to keep the files.`)) return;
    if (m.protected && (op === 'delete' || op === 'disable')) {
      if (!confirm(`“${m.name}” is required by Paddock: without it the in-game HUD${m.name.includes('Loader') ? ' and the Race tab launcher' : ''} stop working.\n\n${op === 'delete' ? 'Delete' : 'Disable'} it anyway?`)) return;
      body.force = true;
    }
    try {
      const r = await post('/api/mods/action', body);
      state.mods = r.mods;
      if (op === 'merge') state.open.delete(id);
      setMsg(`${{ disable: 'Disabled', enable: 'Enabled', delete: 'Deleted', rename: 'Renamed', merge: 'Merged' }[op]} “${esc(op === 'rename' ? body.name : m.name)}”.`);
      render();
    } catch (e) { setMsg(esc(e.message), 'error'); load(); }
  }

  // ---------------- upload (XHR for progress; the server streams it to disk)
  function upload(file, overwrite) {
    return new Promise((resolve) => {
      const x = new XMLHttpRequest();
      x.open('POST', `/api/mods/upload?name=${encodeURIComponent(file.name)}${overwrite ? '&overwrite=1' : ''}`);
      x.upload.onprogress = (e) => { if (e.lengthComputable) $('#mProg').innerHTML = `<div class="mod-prog"><span style="width:${(e.loaded / e.total * 100).toFixed(1)}%"></span></div><span class="muted">${esc(file.name)} · ${fmtSize(e.loaded)} / ${fmtSize(e.total)}</span>`; };
      x.upload.onload = () => { $('#mProg').innerHTML = `<span class="spinner"></span> <span class="muted">Installing ${esc(file.name)}…</span>`; };
      x.onload = () => { let j = {}; try { j = JSON.parse(x.responseText); } catch { /* not json */ } resolve({ status: x.status, body: j }); };
      x.onerror = () => resolve({ status: 0, body: { error: 'Upload failed (is Paddock still running?)' } });
      x.send(file);
    });
  }
  async function installFiles(files) {
    const lines = [];
    let bad = false;
    for (const f of files) {
      if (!/\.(zip|kspkg)$/i.test(f.name)) { lines.push(`${esc(f.name)}: only .zip and .kspkg files can be installed`); bad = true; continue; }
      let r = await upload(f, false);
      if (r.status === 409 && r.body.conflicts) {
        const c = r.body.conflicts;
        const owners = [...new Set(c.map((x) => x.owner).filter(Boolean))];
        const ok = confirm(`${f.name}: ${c.length} file(s) already exist${owners.length ? ` (from ${owners.join(', ')})` : ''}:\n\n${c.slice(0, 8).map((x) => x.path).join('\n')}${c.length > 8 ? '\n…' : ''}\n\nReplace them? Replaced files then belong to the new mod.`);
        if (!ok) { lines.push(`${esc(f.name)}: not installed`); continue; }
        r = await upload(f, true);
      }
      if (r.status === 200) {
        state.mods = r.body.mods;
        lines.push(`Installed <b>${esc(f.name)}</b>: ${r.body.installed} file(s)${r.body.replaced ? `, ${r.body.replaced} replaced` : ''}${r.body.skipped?.length
          ? `. <span class="muted">Skipped (not game files): ${r.body.skipped.slice(0, 6).map(esc).join(', ')}${r.body.skipped.length > 6 ? ', …' : ''}</span>` : ''}`);
      } else { lines.push(`${esc(f.name)}: ${esc(r.body.error || `HTTP ${r.status}`)}`); bad = true; }
    }
    $('#mProg').innerHTML = '';
    setMsg(lines.join('<br>'), bad ? 'error' : '');
    await load();
  }

  $('#mAdd').onclick = () => {
    if (state.running) { setMsg('AC EVO is running. Close the game first.', 'error'); return; }
    const inp = Object.assign(document.createElement('input'), { type: 'file', multiple: true, accept: '.zip,.kspkg' });
    inp.onchange = () => inp.files.length && installFiles([...inp.files]);
    inp.click();
  };
  const drop = $('#mDrop');
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => {
    e.preventDefault(); drop.classList.remove('over');
    if (state.running) { setMsg('AC EVO is running. Close the game first.', 'error'); return; }
    if (e.dataTransfer.files.length) installFiles([...e.dataTransfer.files]);
  };
  $('#mq').oninput = (e) => { state.q = e.target.value; render(); };

  await load();
  // keep the "game running" state fresh
  const timer = setInterval(async () => {
    try { const r = await api('/api/mods'); if (r.running !== state.running) { state.mods = r.mods; state.running = r.running; render(); } } catch { /* offline */ }
  }, 3000);
  cleanup.push(() => clearInterval(timer));
}
