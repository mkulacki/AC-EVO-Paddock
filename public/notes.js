// Session notes, tags and corner bookmarks (PL5) on the session page: what you noticed, short labels to find the
// session again (Sessions page filter, Ctrl+K), and corners to come back to on this track and car.
// Stored only in Paddock's own database on this computer (src/notes.js): never uploaded, not in lap files.
// Saved by itself a moment after you stop typing, when a tag is added or removed, and with Save (or Ctrl+Enter).
import { esc, api, post, prettyName } from './util.js';

const when = (t) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

/**
 * Mounts the notes card into el. corners: corner names of this track (suggestions for bookmarks; any name can be typed).
 * open: start opened with the note field focused (Home's "Add a note" link).
 */
export async function mountNotes(el, sessionId, { corners = [], open = false } = {}, cleanup = []) {
  let n;
  try { n = await api(`/api/notes?session=${sessionId}`); }
  catch (e) { el.innerHTML = `<div class="card state-error" role="alert"><b>Notes could not be loaded:</b> ${esc(e.message)} <button class="small" data-retry>Try again</button></div>`;
    el.querySelector('[data-retry]').onclick = () => mountNotes(el, sessionId, { corners, open }, cleanup); return; }
  const L = n.limits;
  let tags = [...n.tags], saved = JSON.stringify({ text: n.text, tags });
  let known = [];
  api('/api/notes/index').then((x) => { known = x.tags.map((t) => t.tag); drawTagList(); }).catch(() => {});
  // closed unless asked for (Home's "Add a note" link), so the telemetry stays in view; the summary shows what is in it
  el.innerHTML = `<details class="card notes-card" id="notes" ${open ? 'open' : ''}>
    <summary><b>Notes, tags and corner bookmarks</b> <span class="notes-sum"></span></summary>
    <p class="hint" style="margin:6px 0 10px">Only on this computer: never uploaded, not sent to the AI, not in lap files. Backups made in Settings include them.</p>
    <div class="notes-grid">
      <div>
        <label for="nText">Note</label>
        <textarea id="nText" rows="4" maxlength="${L.noteChars}" placeholder="What did you notice? Grip, traffic, what you tried…">${esc(n.text)}</textarea>
        <div class="row hint" style="margin-top:2px"><span id="nCount"></span><span class="spacer"></span><span><kbd>Ctrl</kbd> <kbd>Enter</kbd> saves</span></div>
        <label for="nTagIn" style="margin-top:8px;display:block">Tags</label>
        <div class="row" style="flex-wrap:wrap;gap:6px"><span id="nTags" class="row" style="flex-wrap:wrap;gap:6px"></span>
          <input id="nTagIn" list="nTagList" maxlength="${L.tagChars}" placeholder="Add a tag and press Enter" autocomplete="off" style="flex:1 1 160px">
          <datalist id="nTagList"></datalist></div>
        <div class="row" style="margin-top:10px"><button id="nSave">Save</button><span id="nMsg" class="hint" role="status" aria-live="polite"></span></div>
      </div>
      <div>
        <h3 style="margin:0 0 6px">Corner bookmarks</h3>
        <form id="nBmForm" class="row" style="flex-wrap:wrap;gap:6px">
          <label class="sr-only" for="nBmCorner">Corner</label><input id="nBmCorner" list="nCorners" maxlength="${L.corner}" placeholder="Corner, e.g. ${esc(corners[0] || 'T3')}" required style="flex:0 1 140px">
          <datalist id="nCorners">${corners.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
          <label class="sr-only" for="nBmNote">What to work on there</label><input id="nBmNote" maxlength="${L.bookmarkNote}" placeholder="What to work on there" style="flex:1 1 180px">
          <button type="submit" class="small">Bookmark</button></form>
        <div class="note-err" id="nBmErr" role="alert"></div>
        <ul class="bm-list" id="nBms"></ul>
        <div id="nBmOther"></div>
      </div>
    </div></details>`;
  const $ = (s) => el.querySelector(s);
  const text = $('#nText'), tagIn = $('#nTagIn'), msg = $('#nMsg');
  const count = () => { $('#nCount').textContent = `${text.value.length} / ${L.noteChars}`; };
  const summary = () => {
    $('.notes-sum').innerHTML = `${tags.map((t) => `<span class="tag-chip">${esc(t)}</span>`).join(' ')}${text.value.trim() ? ` <span class="muted s notes-first">· “${esc(text.value.trim().split('\n')[0].slice(0, 80))}”</span>` : ''}${n.bookmarks.length ? ` <span class="muted s">· ${n.bookmarks.length} bookmark${n.bookmarks.length === 1 ? '' : 's'}</span>` : ''}`;
  };
  function drawTagList() { const dl = el.querySelector('#nTagList'); if (dl) dl.innerHTML = known.filter((t) => !tags.includes(t)).map((t) => `<option value="${esc(t)}">`).join(''); }
  const drawTags = () => {
    $('#nTags').innerHTML = tags.map((t) => `<span class="tag-chip">${esc(t)}<button type="button" data-untag="${esc(t)}" aria-label="Remove tag ${esc(t)}" title="Remove tag">×</button></span>`).join('');
    el.querySelectorAll('[data-untag]').forEach((b) => b.onclick = () => { tags = tags.filter((t) => t !== b.dataset.untag); drawTags(); save(); tagIn.focus(); });
    drawTagList(); summary();
  };
  let timer = null, busy = null;
  async function save() {
    clearTimeout(timer);
    const body = { text: text.value, tags };
    if (JSON.stringify({ text: text.value.trim(), tags }) === saved) { msg.textContent = 'Saved'; return; }
    msg.textContent = 'Saving…';
    const mine = busy = post('/api/notes', { session: sessionId, ...body });
    try {
      const r = await mine;
      if (busy !== mine) return; // a newer save is on its way
      saved = JSON.stringify({ text: r.text, tags: r.tags });
      msg.textContent = 'Saved'; summary();
    } catch (e) { if (busy === mine) msg.textContent = `Not saved: ${e.message}`; }
  }
  text.oninput = () => { count(); summary(); msg.textContent = 'Not saved yet'; clearTimeout(timer); timer = setTimeout(save, 900); };
  text.onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); } };
  $('#nSave').onclick = save;
  tagIn.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const t = tagIn.value.trim().replace(/^#+/, '').replace(/\s+/g, ' ').toLowerCase();
      if (!t) return;
      if (tags.length >= L.tags && !tags.includes(t)) { msg.textContent = `At most ${L.tags} tags`; return; }
      if (!tags.includes(t)) tags.push(t);
      tagIn.value = ''; drawTags(); save();
    } else if (e.key === 'Backspace' && !tagIn.value && tags.length) { tags.pop(); drawTags(); save(); }
  };
  cleanup.push(() => { if (JSON.stringify({ text: text.value.trim(), tags }) !== saved) save(); clearTimeout(timer); }); // leaving the page: what was typed is kept

  // ---- bookmarks
  const bmItem = (b, own) => `<li><b>${esc(b.corner)}</b>${b.note ? ` <span>${esc(b.note)}</span>` : ''}
    <span class="muted s">${own ? '' : `<a href="#/report?session=${b.sessionId}&notes=1">${esc(when(b.createdAt))}</a>`}</span>
    ${own ? `<button class="small ghost" data-unbm="${b.id}" aria-label="Remove bookmark ${esc(b.corner)}" title="Remove bookmark">✕</button>` : ''}</li>`;
  const drawBms = () => {
    $('#nBms').innerHTML = n.bookmarks.length ? n.bookmarks.map((b) => bmItem(b, true)).join('') : '<li class="muted s">No corner bookmarked in this session.</li>';
    $('#nBmOther').innerHTML = n.comboBookmarks.length ? `<p class="hint" style="margin:8px 0 2px">Earlier on this track and car (${esc(prettyName(n.combo.car))}):</p>
      <ul class="bm-list">${n.comboBookmarks.slice(0, 12).map((b) => bmItem(b, false)).join('')}</ul>` : '';
    el.querySelectorAll('[data-unbm]').forEach((b) => b.onclick = async () => {
      try { n = await api(`/api/notes/bookmark?id=${b.dataset.unbm}`, { method: 'DELETE' }); drawBms(); summary(); $('#nBmCorner').focus(); }
      catch (e) { $('#nBmErr').textContent = e.message; }
    });
  };
  $('#nBmForm').onsubmit = async (e) => {
    e.preventDefault();
    $('#nBmErr').textContent = '';
    try {
      n = await post('/api/notes/bookmark', { session: sessionId, corner: $('#nBmCorner').value, note: $('#nBmNote').value });
      $('#nBmCorner').value = ''; $('#nBmNote').value = '';
      drawBms(); summary(); $('#nBmCorner').focus();
    } catch (err) { $('#nBmErr').textContent = err.message; }
  };
  count(); drawTags(); drawBms();
  if (open) { el.scrollIntoView({ block: 'start' }); text.focus(); }
}

/** Tag chips for a list (Sessions page rows). */
export const tagChips = (list) => (list?.length ? list.map((t) => `<span class="tag-chip">${esc(t)}</span>`).join(' ') : '');
