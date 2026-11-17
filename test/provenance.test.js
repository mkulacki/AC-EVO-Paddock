// Data provenance (src/channels.js), how the Car & setup report uses it, and AI confidence (src/ai.js), with
// Gemini stubbed: nothing leaves the machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolate, seedRandom } from './helpers.js';

const { ACEVO_DATA } = isolate('provenance');
// a settings file from Paddock 0.5: one switch for the pit-box readings
fs.writeFileSync(path.join(ACEVO_DATA, 'settings.json'), JSON.stringify({ probeConfirmed: true, geminiApiKey: 'test-key', geminiModel: 'test-model' }));
seedRandom(3);
const channels = await import('../src/channels.js');
const settings = await import('../src/settings.js');
const db = await import('../src/db.js');
const carreport = await import('../src/carreport.js');
const ai = await import('../src/ai.js');
const { seedLaps } = await import('../src/mock.js');

test('built-in statuses: core telemetry checked, slip and windows not', () => {
  assert.equal(channels.status('core'), 'verified');
  assert.equal(channels.status('trackLimits'), 'verified');
  assert.equal(channels.status('slip'), 'unverified');
  assert.equal(channels.status('windows'), 'unverified');
  assert.throws(() => channels.status('nope'), /Unknown/);
});

test('the 0.5 switch carries over to the pit-box readings and temperatures only', () => {
  assert.equal(channels.status('setupProbe'), 'verified');
  assert.equal(channels.status('conditions'), 'verified');
  assert.equal(channels.status('tyres'), 'unverified');
});

test('confirm: match, mismatch, undo; only checkable groups', () => {
  assert.equal(channels.confirm('tyres', true), 'verified');
  assert.equal(channels.confirm('brakes', false), 'mismatch');
  assert.equal(channels.confirm('brakes', null), 'unverified');
  assert.equal(channels.confirm('setupProbe', false), 'mismatch');
  assert.equal(settings.get().probeConfirmed, false, 'the old switch follows');
  assert.equal(channels.status('conditions'), 'verified', 'the old switch still counts for the temperatures');
  assert.equal(channels.confirm('setupProbe', null), 'unverified');
  assert.equal(channels.status('conditions'), 'verified', 'undo on one group keeps the other');
  assert.equal(channels.confirm('setupProbe', false), 'mismatch');
  assert.throws(() => channels.confirm('tyres', '0'), /true, false or null/);
  assert.throws(() => channels.confirm('slip', true), /cannot be checked/);
  assert.throws(() => channels.confirm('core', true), /cannot be checked/);
  const saved = JSON.parse(fs.readFileSync(path.join(ACEVO_DATA, 'settings.json'), 'utf8'));
  assert.deepEqual(saved.channelChecks, { tyres: true, setupProbe: false, conditions: true });
  channels.confirm('tyres', null); channels.confirm('setupProbe', true);
});

test('allTrusted / forAi', () => {
  assert.equal(channels.allTrusted(['core']), true);
  assert.equal(channels.allTrusted(['core', 'slip']), false);
  const q = channels.forAi(['core', 'slip']);
  assert.match(q.core, /confirmed in game/);
  assert.match(q.slip, /NOT confirmed/);
});

// ---------------------------------------------------------------- Car & setup report
await seedLaps(5);
const sid = db.listSessions()[0].id;

test('car report: provenance per section; no suggestion on unchecked readings counts as confirmed', () => {
  const r = carreport.build(sid);
  assert.ok(r.available);
  assert.equal(r.provenance.tyres, 'unverified');
  assert.equal(r.provenance.slip, 'unverified');
  assert.ok(r.suggestions.length > 0, 'the mock car gives hints');
  for (const s of r.suggestions) {
    assert.ok(Array.isArray(s.basis) && s.basis.length, `${s.text} has a basis`);
    assert.ok(s.basis.every((b) => b in channels.GROUPS));
    assert.equal(s.confirmed, false, `${s.text} rests on unchecked readings`);
  }
});

test('car report: checking tyres confirms the tyre hints, never the balance ones', () => {
  channels.confirm('tyres', true);
  const r = carreport.build(sid);
  const tyre = r.suggestions.filter((s) => s.basis.every((b) => b === 'tyres'));
  const bal = r.suggestions.filter((s) => s.basis.includes('slip'));
  assert.ok(tyre.length, 'the mock car gives tyre hints');
  assert.ok(tyre.every((s) => s.confirmed));
  assert.ok(bal.every((s) => !s.confirmed));
  assert.equal(r.provenance.tyres, 'verified');
  const forAi = carreport.forAi(r);
  assert.match(forAi.data_quality.slip, /NOT confirmed/);
  assert.ok(forAi.rule_based_hints.filter((h) => h.includes('not confirmed in game')).length === r.suggestions.filter((s) => !s.confirmed).length);
  assert.ok('setupProbe' in forAi.data_quality, 'the AI learns whether setup_driven can be trusted');
  channels.confirm('tyres', null);
});

test('car report for the AI: readings found wrong are left out, with their hints', () => {
  channels.confirm('brakes', false);
  const r = carreport.build(sid);
  const forAi = carreport.forAi(r);
  assert.match(forAi.brakes, /left out/);
  const brakeHints = r.suggestions.filter((s) => s.basis.includes('brakes')).map((s) => s.text);
  assert.ok(brakeHints.length, 'the mock car locks its fronts');
  assert.ok(brakeHints.every((t) => !forAi.rule_based_hints.some((h) => h.startsWith(t))));
  assert.ok(Array.isArray(forAi.tyres), 'other groups are still sent');
  channels.confirm('brakes', null);
});

// ---------------------------------------------------------------- AI confidence
test('splitConfidence: plain, Markdown, other dashes; missing line', () => {
  assert.deepEqual(ai.splitConfidence('Brake later at T1.\nConfidence: high - clear brake point differences'),
    { text: 'Brake later at T1.', confidence: { level: 'high', basis: 'clear brake point differences' } });
  assert.deepEqual(ai.splitConfidence('Text\n\n**Confidence:** Medium — only 3 laps\n').confidence, { level: 'medium', basis: 'only 3 laps' });
  assert.equal(ai.splitConfidence('Text\nConfidence: LOW').confidence.level, 'low');
  assert.deepEqual(ai.splitConfidence('No rating here.'), { text: 'No rating here.', confidence: null });
  // a "confidence" word in the middle of the answer is not the rating
  assert.equal(ai.splitConfidence('Confidence: high - x\nmore\ntext\nlines\nhere').confidence, null);
  assert.equal(ai.splitConfidence('Mid-corner speed is the issue.\nConfidence: the data is clear').confidence, null, 'no level word');
});

test('splitConfidence: list and heading marks, "level", ranges, reason on the next line, translations', () => {
  const c = (t) => ai.splitConfidence(t).confidence;
  assert.deepEqual(c('x\n- Confidence: high - 8 laps'), { level: 'high', basis: '8 laps' });
  assert.equal(c('x\n### Confidence: medium').level, 'medium');
  assert.deepEqual(c('x\nConfidence level: low (2 laps only)'), { level: 'low', basis: '2 laps only)' });
  assert.equal(c('x\nConfidence: Medium-high - fine').level, 'medium', 'a range counts as its lower end');
  assert.equal(c('x\nConfidence: low to medium').level, 'low');
  const two = ai.splitConfidence('Advice.\nConfidence: medium\nBased on 5 laps.');
  assert.deepEqual(two, { text: 'Advice.', confidence: { level: 'medium', basis: 'Based on 5 laps.' } });
  assert.deepEqual(c('Texte.\nConfiance : élevée – différences nettes'), { level: 'high', basis: 'différences nettes' });
  assert.equal(c('Text.\nKonfidenz: mittel - wenige Runden').level, 'medium');
  assert.equal(c('Tekst.\n**Pewność:** niska — mało okrążeń').level, 'low');
  assert.equal(ai.splitConfidence('Texte.\nConfiance : élevée').text, 'Texte.', 'the translated line is taken out of the body');
});

// Gemini stub: records the request, answers with the given text
const calls = [];
const answer = (text) => { globalThis.fetch = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }) }; }; };

test('debrief: prompt asks for a rating and carries data quality', async () => {
  answer('All good.\nConfidence: medium - 5 laps');
  const out = await ai.debrief({ trend: [{ n: 1, ms: 80000, valid: true }], best: { ms: 80000 } });
  const req = calls.at(-1).body;
  assert.match(req.systemInstruction.parts[0].text, /Confidence: high\|medium\|low/);
  const input = req.contents[0].parts[0].text;
  assert.match(input, /"data_quality"/);
  assert.match(input, /setupProbe/);
  assert.equal(ai.splitConfidence(out.text).confidence.level, 'medium');
});

test('setup engineer: confidence parsed and checked, per change too', async () => {
  const setup = { carName: 'Car', track: { name: 'Track' }, name: 'S1', values: [
    { name: 'camber_FL', label: 'Camber', corner: 'FL', value: -3, min: -4, max: 0, step: 0.1, scale: 1, unit: '°', locked: false, list: false },
  ] };
  answer(JSON.stringify({ summary: 'x', changes: [{ name: 'camber_FL', value: -3.5, reason: 'more grip', confidence: 'Medium' }], confidence: 'low', basis: 'unconfirmed tyre data', test_plan: '', name: 'n' }));
  const r = await ai.setupEngineer({ setup, problem: 'understeer', telemetry: null });
  assert.deepEqual(r.confidence, { level: 'low', basis: 'unconfirmed tyre data' });
  assert.equal(r.changes[0].confidence, 'medium');
  assert.match(calls.at(-1).body.systemInstruction.parts[0].text, /data_quality says the readings are confirmed/);
  answer(JSON.stringify({ summary: 'x', changes: [], confidence: 'certain' }));
  assert.equal((await ai.setupEngineer({ setup, problem: '', telemetry: null })).confidence, null, 'an unknown level is dropped');
});
