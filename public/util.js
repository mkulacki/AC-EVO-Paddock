// Shared browser helpers
export const $ = (s, el = document) => el.querySelector(s);
export const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export async function api(url, opts = {}) {
  const res = await fetch(url, { headers: { 'content-type': 'application/json' }, ...opts });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}
export const post = (url, body) => api(url, { method: 'POST', body: JSON.stringify(body) });

// Text input dialog: replaces window.prompt(), which the desktop app (Electron) does not support.
// Resolves to the trimmed text, or null when cancelled.
export function askText(title, value = '') {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'modal-back ask-back';
    back.innerHTML = `<form class="ask"><label>${esc(title)}</label><input type="text" value="${esc(value)}">
      <div class="row"><span class="spacer"></span><button type="button" data-cancel>Cancel</button><button type="submit" class="primary">OK</button></div></form>`;
    const input = back.querySelector('input');
    const done = (v) => { back.remove(); document.removeEventListener('keydown', onKey, true); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } };
    back.querySelector('form').onsubmit = (e) => { e.preventDefault(); done(input.value.trim() || null); };
    back.querySelector('[data-cancel]').onclick = () => done(null);
    back.onmousedown = (e) => { if (e.target === back) done(null); };
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(back);
    input.focus(); input.select();
  });
}

export const fmt = (ms) => {
  if (ms == null || !isFinite(ms)) return '–';
  const neg = ms < 0; ms = Math.abs(ms);
  const m = Math.floor(ms / 60000), s = (ms % 60000) / 1000;
  return `${neg ? '−' : ''}${m}:${s.toFixed(3).padStart(6, '0')}`;
};
export const fmtGap = (ms, digits = 3) => (ms == null || !isFinite(ms) ? '–' : `${ms > 0 ? '+' : ms < 0 ? '−' : '±'}${(Math.abs(ms) / 1000).toFixed(digits)}`);
export const gapClass = (ms) => (ms > 0.5 ? 'pos' : ms < -0.5 ? 'neg' : '');
export const prettyName = (s) => String(s || '?').replace(/_/g, ' ');
export const SESSION_TYPES = { 0: 'Time attack', 1: 'Race', 2: 'Hot stint', 3: 'Cruise' };
export const SERIES = ['--series-1', '--series-2', '--series-3', '--series-4'];
export const idxAt = (d, dist) => { let lo = 0, hi = d.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (d[m] < dist) lo = m + 1; else hi = m; } return lo; };
export const gearTxt = (g) => (g < 0 ? 'R' : g === 0 ? 'N' : String(Math.round(g)));

// AC uses a left-handed world, so drawing x→right / z→up gives a mirror image: mirroring is the default.
// "Flip map" (per-viewer preference) undoes it in case a track ever looks wrong.
export function getMirror() { try { return localStorage.getItem('mapFlip') !== '1'; } catch { return true; } }
export function setMirror(v) { try { localStorage.setItem('mapFlip', v ? '0' : '1'); } catch { /* ignore */ } }
// lateral offset (+ = left in game x/z) -> text as seen on the (possibly mirrored) map
export const sideTxt = (off, mirror) => {
  if (off == null || !isFinite(off)) return '–';
  const v = mirror ? -off : off;
  return Math.abs(v) < 0.05 ? 'on line' : `${Math.abs(v).toFixed(1)} m ${v > 0 ? 'L' : 'R'}`;
};
// + = wider (outside of the corner), − = tighter
export const wideTxt = (v) => (v == null ? '–' : Math.abs(v) < 0.1 ? '0' : `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}`);

export const stats = (vals) => {
  const v = vals.filter((x) => x != null && isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length);
  const q = (p) => v[Math.min(v.length - 1, Math.max(0, Math.round(p * (v.length - 1))))];
  return { n: v.length, mean, sd, min: v[0], max: v[v.length - 1], median: q(0.5), q1: q(0.25), q3: q(0.75) };
};

// minimal markdown -> HTML
export function md(src) {
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(^|[^*])\*([^*]+)\*/g, '$1<i>$2</i>').replace(/`([^`]+)`/g, '<code>$1</code>');
  const out = []; let list = null;
  for (const raw of src.split('\n')) {
    const line = raw.trimEnd();
    const h = line.match(/^(#{1,4})\s+(.*)/), li = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)/);
    if (li) { if (!list) { out.push('<ul>'); list = true; } out.push(`<li>${inline(li[1])}</li>`); continue; }
    if (list) { out.push('</ul>'); list = null; }
    if (h) out.push(`<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push('</ul>');
  return out.join('');
}

// Draw a static track map (used by compare tab). Returns projection for hover dots.
export function fitProjection(xs, zs, W, H, pad, mirror) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < xs.length; i++) { minX = Math.min(minX, xs[i]); maxX = Math.max(maxX, xs[i]); minZ = Math.min(minZ, zs[i]); maxZ = Math.max(maxZ, zs[i]); }
  const s = Math.min((W - 2 * pad) / (maxX - minX || 1), (H - 2 * pad) / (maxZ - minZ || 1));
  const ox = (W - (maxX - minX) * s) / 2, oy = (H - (maxZ - minZ) * s) / 2;
  return (x, z) => [mirror ? W - (ox + (x - minX) * s) : ox + (x - minX) * s, H - (oy + (z - minZ) * s)];
}
