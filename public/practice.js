// Practice drills (PL7) on the pages: one drill card (the prescription, where it stands, before against after) and
// its buttons. Used by Development (#/development, every drill) and Lap analysis (#/analysis, the drill of that car +
// track). Data: /api/practice (src/drills.js, src/practice.js). Deterministic: no AI anywhere in the loop.
import { esc, post, prettyName, mixHtml } from './util.js';

/** Findings the analysis can turn into a drill (src/practice.js METRICS). */
export const DRILLABLE = new Set(['brakePoint', 'brakeRelease', 'releaseMs', 'releaseBumps', 'minSpeed', 'throttlePickup', 'pickupMs', 'holdMs', 'exitSpeed', 'minGear']);
const STATE = {
  collecting: ['Collecting passes', ''], practising: ['Practising', 'chal'], review: ['Review point', 'bad'], met: ['Met', 'best'],
  stopped: ['Stopped', ''], unavailable: ['Cannot be checked', 'bad'],
};
const day = (t) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const pct = (v) => (v == null ? '–' : `${Math.round(v * 100)} %`);
const comboTxt = (c) => `${esc(prettyName(c.track))} <span class="muted">${esc(prettyName(c.layout))}</span> · ${esc(prettyName(c.car))}`;

function stateBadge(d) {
  const [txt, cls] = d.slip?.slipping ? ['Revisit', 'bad'] : STATE[d.state] || [d.state, ''];
  return `<span class="badge ${cls}" data-drill-state="${esc(d.slip?.slipping ? 'revisit' : d.state)}">${esc(txt)}</span>`;
}

/** Where the drill stands, in words and a bar: passes against the minimum, share reaching the target against 50 %. */
function progressHtml(d) {
  const e = d.eval;
  if (d.state === 'unavailable') return `<p class="muted s">${esc(d.reason || '')}</p>`;
  if (!e) return '';
  const need = d.prescription.minEvidence.passes, share = e.share ?? 0;
  const line = e.state === 'collecting'
    ? `${e.sinceRestart} of ${need} passes so far: not judged yet.`
    : `${e.meeting} of the newest ${e.judged} passes reach the target (${pct(e.share)}; the drill needs 50 %).`;
  const before = d.prescription.before;
  const ch = e.change || {};
  const time = ch.time ? `Corner time (context, not the criterion): ${(ch.time.beforeMs / 1000).toFixed(2)} s before, ${(ch.time.afterMs / 1000).toFixed(2)} s now: ${esc(ch.time.verdict)}.` : '';
  return `<div class="drill-progress">
      <div class="drill-bar" role="img" aria-label="${esc(`${pct(e.share)} of passes reach the target; 50 % needed`)}"><span style="width:${Math.min(100, Math.round(share * 100))}%"></span><i title="50 %: the success line"></i></div>
      <p class="s" data-drill-line>${esc(line)}${e.passes > e.sinceRestart ? ` <span class="muted">(${e.passes - e.sinceRestart} earlier passes before you chose to keep practising are not judged.)</span>` : ''}</p>
      <p class="s"><b>Before → now:</b> ${pct(before.share)} → ${pct(e.share)} of passes reached the target (before: ${before.n} passes${ch.metricBefore != null && ch.metricAfter != null ? `; median ${esc(String(ch.metricBefore))} → ${esc(String(ch.metricAfter))}` : ''}).${time ? ` <span class="muted">${time}</span>` : ''}</p>
      ${e.excluded ? `<p class="muted s">${e.excluded} lap${e.excluded === 1 ? '' : 's'} since the start not counted: ${esc((e.excludedReasons || []).join('; '))}.</p>` : ''}
      ${mixHtml(e.compat, 'The before and drill laps')}
    </div>`;
}

/** One drill. opts.combo: show the car + track line (Development lists every car + track). */
export function drillHtml(d, { combo = true } = {}) {
  const p = d.prescription, open = d.active;
  const slip = d.slip?.slipping ? `<p class="s"><b>May be slipping:</b> ${d.slip.n ? `only ${pct(d.slip.share)} of your newest ${d.slip.n} passes since it was met reach the target.` : ''} A short drill again may help.</p>` : '';
  const actions = [
    open && d.state === 'review' ? `<button class="small primary" data-drill-act="keep" data-id="${d.id}">Keep practising</button>` : '',
    open && d.state === 'review' ? `<button class="small" data-drill-act="renew" data-id="${d.id}">Renew target from my latest laps</button>` : '',
    d.slip?.slipping ? `<button class="small primary" data-drill-act="again" data-id="${d.id}">Practise again</button>` : '',
    open ? `<button class="small ghost" data-drill-act="stop" data-id="${d.id}">Stop</button>` : `<button class="small ghost" data-drill-act="remove" data-id="${d.id}" aria-label="Delete this drill">Delete</button>`,
  ].join('');
  return `<article class="drill${open ? ' drill-active' : ''}" id="drill-${d.id}" data-drill="${d.id}">
    <div class="row"><h3 style="margin:0">${esc(d.corner)} · ${esc(p.label)}</h3>${stateBadge(d)}<span class="spacer"></span>
      <span class="muted s">started ${esc(day(d.createdAt))}${d.met ? ` · met ${esc(day(d.met.at))}` : d.endedAt ? ` · ${d.endKind === 'replaced' ? 'replaced' : 'stopped'} ${esc(day(d.endedAt))}` : ''}</span></div>
    ${combo ? `<div class="muted s">${comboTxt(d.combo)}</div>` : ''}
    <dl class="drill-rx">
      <dt>Observed issue</dt><dd data-rx="issue">${esc(p.issue)}</dd>
      <dt>Evidence</dt><dd data-rx="evidence">${esc(p.evidence.text)}</dd>
      <dt>Exercise</dt><dd data-rx="exercise"><b>${esc(p.exercise)}</b></dd>
      <dt>Success when</dt><dd data-rx="criterion">${esc(p.criterion.text)}</dd>
      <dt>Minimum evidence</dt><dd data-rx="minimum">${esc(p.minEvidence.text)}</dd>
      <dt>Review point</dt><dd data-rx="review">${esc(p.review.text)}</dd>
      <dt>Why it may help</dt><dd data-rx="hypothesis" class="muted">${esc(p.hypothesis)} <i>(a possibility, not a proven cause)</i></dd>
    </dl>
    ${progressHtml(d)}${slip}
    <div class="row drill-actions">${actions}</div>
  </article>`;
}

/** The buttons of the drill cards in root; onChange() after a change. drills: the list the cards came from. */
export function wireDrills(root, drills, onChange) {
  // in-page links: the router owns location.hash, so a drill is opened and scrolled to directly
  root.querySelectorAll('[data-scroll]').forEach((b) => (b.onclick = () => {
    const el = document.getElementById(b.dataset.scroll);
    if (!el) return;
    const box = el.closest('details');
    if (box) box.open = true;
    el.scrollIntoView({ block: 'center' });
  }));
  root.querySelectorAll('[data-drill-act]').forEach((b) => (b.onclick = async () => {
    const d = drills.find((x) => x.id === Number(b.dataset.id));
    if (!d) return;
    const act = b.dataset.drillAct;
    if (act === 'stop' && !confirm('Stop this drill? Its result so far is kept.')) return;
    if (act === 'remove' && !confirm('Delete this drill and its history?')) return;
    b.disabled = true;
    try {
      if (act === 'renew' || act === 'again') {
        const other = drills.find((x) => x.active && x.id !== d.id && x.combo.track === d.combo.track && x.combo.layout === d.combo.layout && x.combo.car === d.combo.car);
        if (other && !confirm(`You are practising ${other.corner} (${other.prescription.label}) on this car and track. One drill at a time: replace it?`)) { b.disabled = false; return; }
        await post('/api/practice', { action: 'create', combo: d.combo, corner: d.corner, key: d.key, replace: act === 'renew' || !!other });
      } else await post('/api/practice', { action: act, id: d.id });
      onChange();
    } catch (e) { b.disabled = false; alert(e.message); }
  }));
}

/** Corner mastery as a small badge (Lap analysis corner rows). */
export function masteryBadge(m) {
  if (!m) return '';
  const cls = { open: 'bad', practising: 'chal', revisit: 'bad', steady: 'best', unknown: '' }[m.level] || '';
  const tip = {
    unknown: 'Fewer than 5 valid passes: nothing is concluded yet.',
    open: 'A repeatable gain of 0.03 s or more between your typical pass and your quicker quarter.',
    practising: 'You have an active drill here.',
    revisit: 'A drill you met here may be slipping: most of your newest passes no longer reach its target.',
    steady: 'Your typical pass is within 0.03 s of your quicker quarter.',
  }[m.level];
  return `<span class="badge ${cls}" data-mastery="${esc(m.level)}" title="${esc(`${tip}${m.drillsMet ? ` Drills met here: ${m.drillsMet}.` : ''}`)}">${esc(m.label)}</span>`;
}
