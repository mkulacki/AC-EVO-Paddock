// PL5: accessible colours in both themes. Text colours (muted text, timing and state colours used for words) must
// reach 4.5:1 (WCAG AA, normal text) on the page and on the panels text sits on; the focus ring 3:1 (non-text).
// Read from the tokens in public/style.css, so a later colour change that breaks contrast fails here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers.js';

const css = fs.readFileSync(path.join(ROOT, 'public/style.css'), 'utf8');
const block = (sel) => css.slice(css.indexOf(`${sel} {`), css.indexOf('}', css.indexOf(`${sel} {`)));
const tokens = (b) => Object.fromEntries([...b.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2].toLowerCase()]));
const dark = tokens(block(':root'));
const light = { ...dark, ...tokens(block(':root[data-theme="light"]')) };

const lum = (h) => { const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

const TEXT = ['text-primary', 'text-secondary', 'text-muted', 't-best', 't-pb', 't-slow', 'good', 'critical', 'warning', 'slower', 'faster', 'accent-text'];
const BACKS = ['page', 'surface-1', 'surface-2'];

for (const [name, t] of [['dark', dark], ['light', light]]) {
  test(`${name} theme: text colours reach 4.5:1 on the page and panels`, () => {
    for (const fg of TEXT) for (const bg of BACKS) {
      assert.ok(t[fg] && t[bg], `token --${fg} / --${bg} defined`);
      const r = ratio(t[fg], t[bg]);
      assert.ok(r >= 4.5, `--${fg} ${t[fg]} on --${bg} ${t[bg]}: ${r.toFixed(2)}:1`);
    }
  });
  test(`${name} theme: the focus ring reaches 3:1 on the page and panels`, () => {
    for (const bg of BACKS) assert.ok(ratio(t.focus, t[bg]) >= 3, `--focus on --${bg}: ${ratio(t.focus, t[bg]).toFixed(2)}:1`);
  });
}

test('keyboard focus is visible: a focus-visible ring for everything, and fields get one too', () => {
  assert.match(css, /:focus-visible \{ outline: 2px solid var\(--focus\)/);
  assert.match(css, /input:focus-visible, select:focus-visible, textarea:focus-visible \{ box-shadow: 0 0 0 1px var\(--focus\)/);
  // outline: none only where a replacement is given (fields: border + ring; the palette dialog: its own buttons)
  const none = [...css.matchAll(/([^{}]+)\{[^}]*outline:\s*none/g)].map((m) => m[1].trim());
  assert.deepEqual(none.sort(), ['.palette:focus', '.wz-body h2:focus', 'input, select, textarea'].sort());
});
