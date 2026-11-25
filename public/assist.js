// PL9 kill switch, the page side: one switch for the Paddock HUD and every cue (src/assist.js).
// The sidebar button shows the state and flips it; Alt+Q and Ctrl+K → "HUD and cues" do the same; Settings has it too.
// Every change, wherever it was made (tray menu, global shortcut, another tab), arrives as an "assist" event.
import { api, post } from './util.js';

let off = null;
const btn = () => document.getElementById('assistBtn');

function show() {
  const b = btn();
  if (!b || off === null) return;
  b.hidden = false;
  b.classList.toggle('off', off);
  b.setAttribute('aria-pressed', String(off));
  b.querySelector('.lbl').textContent = off ? 'HUD and cues OFF' : 'HUD and cues on';
  b.title = off ? 'The Paddock HUD and the spotter cues are switched off. Click (or Alt+Q) to switch them on again.'
    : 'Switch the Paddock HUD and the spotter cues off at once (Alt+Q)';
  window.dispatchEvent(new CustomEvent('paddock:assist', { detail: { off } }));
}

export const assistOff = () => off;

/** value: true (off), false (on) or 'toggle'. -> the answer of /api/assist ({off, saved, error?}) */
export async function setAssist(value) {
  const r = await post('/api/assist', { off: value });
  off = r.off; show();
  return r;
}
export const toggleAssist = () => setAssist('toggle');

export function initAssist(events) {
  api('/api/assist').then((r) => { off = r.off; show(); }).catch(() => {});
  events.addEventListener('assist', (e) => { off = JSON.parse(e.data).off; show(); });
  btn()?.addEventListener('click', () => { toggleAssist().catch((e) => alert(`Not switched: ${e.message}`)); });
}
