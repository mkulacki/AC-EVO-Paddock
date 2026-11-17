// The browser shell: command palette matching, shortcuts against the sidebar, routes the palette links to.
// public/palette.js has no DOM access at load, so it can be imported here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers.js';

const pal = await import('../public/palette.js');
const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');

test('score: subsequence match, word starts and prefixes rank higher, no match = -1', () => {
  assert.equal(pal.score('xyz', 'Brands Hatch Indy'), -1);
  assert.ok(pal.score('bh', 'Brands Hatch') > pal.score('bh', 'Bathurst Mount Panorama'), 'initials of words win');
  assert.ok(pal.score('brands', 'Brands Hatch GP') > pal.score('brands', 'Session at Brands Hatch'), 'prefix wins');
  assert.ok(pal.score('indy', 'Brands Hatch Indy') > 0);
  assert.equal(pal.score('', 'anything'), 0);
  assert.ok(pal.score('BRANDS', 'brands hatch') > 0, 'case does not matter');
});

test('filterItems: empty shows pages and sessions; "kind words" filters; a single word is plain text', () => {
  const items = [
    { kind: 'Page', label: 'Tracks' }, { kind: 'Page', label: 'Sessions' }, { kind: 'Track', label: 'Brands Hatch Indy' },
    { kind: 'Track', label: 'Monza GP' }, { kind: 'Session', label: 'Monza GP · Ferrari' }, { kind: 'Consistency', label: 'Monza GP · Ferrari' },
  ];
  assert.deepEqual(pal.filterItems(items, '').map((x) => x.kind), ['Page', 'Page', 'Session']);
  assert.equal(pal.filterItems(items, 'tracks')[0].label, 'Tracks', 'one word: the Tracks page, not a kind filter');
  assert.deepEqual(pal.filterItems(items, 'track monza').map((x) => x.kind), ['Track']);
  assert.deepEqual(pal.filterItems(items, 'session   monza').map((x) => x.kind), ['Session'], 'several spaces');
  assert.equal(pal.filterItems(items, 'con monza')[0].kind, 'Consistency');
  // a later word of a kind works too: "history monza" = Setup history
  assert.deepEqual(pal.filterItems([...items, { kind: 'Setup history', label: 'Monza GP · Ferrari' }], 'history monza').map((x) => x.kind), ['Setup history']);
  const withSetups = [...items, { kind: 'Setup history', label: 'Monza GP · Ferrari' }, { kind: 'Setups', label: 'Monza GP · Ferrari' }];
  assert.deepEqual(pal.filterItems(withSetups, 'setup history monza').map((x) => x.kind), ['Setup history'], 'the full kind name');
  assert.deepEqual(pal.filterItems([...withSetups, { kind: 'Coach', label: 'Monza GP · Ferrari' }], 'coach monza').map((x) => x.kind), ['Coach'], 'Coach per track + car');
  assert.deepEqual(pal.filterItems(withSetups, 'setup monza').map((x) => x.kind), ['Setups'], 'unchanged: setup = Setups');
  assert.equal(pal.filterItems(items, 'zzz').length, 0);
});

test('Alt+1…9 follow the sidebar order', () => {
  const nav = [...html.matchAll(/<a href="(#\/[^"]*)" data-nav="/g)].map((m) => m[1]);
  assert.deepEqual(nav, pal.NAV_ORDER);
  assert.ok(pal.SHORTCUTS.some(([k]) => k.startsWith('Alt 1')));
});

test('every page the palette links to is a route of the shell', () => {
  const routes = new Set([...app.matchAll(/'(\/[a-z]+)': '/g)].map((m) => m[1]));
  const src = fs.readFileSync(path.join(ROOT, 'public/palette.js'), 'utf8');
  const hrefs = [...src.matchAll(/'(#\/[a-z]*)[?']/g)].map((m) => m[1].slice(1)).concat([...src.matchAll(/`(#\/[a-z]+)\?/g)].map((m) => m[1].slice(1)));
  assert.ok(hrefs.length > 8);
  for (const h of hrefs) assert.ok(h === '/' || routes.has(h), `${h} is not routed`);
});

test('the sidebar keeps the ids and hooks the shell uses', () => {
  for (const id of ['status', 'openPalette', 'openShortcuts', 'sideToggle', 'view']) assert.match(html, new RegExp(`id="${id}"`));
  for (const key of ['home', 'race', 'laps', 'tracks', 'setups', 'game', 'mods', 'settings']) assert.match(html, new RegExp(`data-nav="${key}"`));
  assert.match(html, /<span class="dot"><\/span><span class="txt">/, 'the status line keeps its parts');
});
