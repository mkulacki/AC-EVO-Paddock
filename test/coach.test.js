// AI coach (src/coach.js): chat context, chat with a stubbed Gemini (no key, network error, HTTP error, success),
// training plans checked against later sessions, and braking-point suggestions validated and applied only on request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolate, seedRandom } from './helpers.js';

isolate('coach');
seedRandom(11);
const db = await import('../src/db.js');
const settings = await import('../src/settings.js');
const report = await import('../src/report.js');
const coach = await import('../src/coach.js');
const marks = await import('../src/brakemarks.js');
const { seedLaps } = await import('../src/mock.js');

// three sessions of 4 laps with the mock car; reports for the first two (the third is checked without a stored one)
for (let i = 0; i < 3; i++) await seedLaps(4);
const sessions = db.listSessions().sort((a, b) => a.started_at - b.started_at);
const [s1, s2, s3] = sessions.map((s) => s.id);
const lap0 = db.lapsOfSession(s1)[0];
const combo = { track: lap0.track, layout: lap0.layout, car: lap0.car };
report.make(s1);
report.make(s2);

// ---- a stub for Gemini: the next answers, and every request kept
const calls = [];
let answers = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null, headers: init?.headers });
  const next = answers.shift();
  if (!next) throw new Error('unexpected Gemini call');
  if (next.throw) throw Object.assign(new TypeError('fetch failed'), { cause: { code: next.throw } });
  return { ok: (next.status || 200) < 400, status: next.status || 200, json: async () => next.json };
};
const reply = (text) => ({ json: { candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] } });
process.on('exit', () => { globalThis.fetch = realFetch; });

test('context: compact, from reports, setups, plan and data quality; no secrets', () => {
  const ctx = coach.context(combo);
  assert.equal(ctx.totals.sessions, 3);
  assert.equal(ctx.totals.laps, db.lapsForCombo(combo.track, combo.layout, combo.car).length);
  assert.ok(Array.isArray(ctx.reports) && ctx.reports.length === 2, 'the two stored reports');
  assert.ok(Array.isArray(ctx.laps_by_setup));
  assert.ok(ctx.data_quality.core);
  const size = JSON.stringify(ctx).length;
  assert.ok(size < 9000, `context ${size} characters: small enough for the free tier`);
  assert.throws(() => coach.context({ track: 'x', layout: 'y', car: 'z' }), /No laps/);
});

test('chat without a key: a clear message, nothing sent or saved', async () => {
  settings.update({ geminiApiKey: '' });
  await assert.rejects(coach.ask(combo, 'Where do I lose time?'), (e) => e.code === 'nokey' && /Settings/.test(e.message));
  assert.equal(calls.length, 0);
  assert.equal(coach.messages(combo).length, 0);
});

test('chat with a network error or a Gemini error: handled, the chat stays as it was', async () => {
  settings.update({ geminiApiKey: 'test-key', geminiModel: 'stub-model' });
  answers = [{ throw: 'ENOTFOUND' }];
  await assert.rejects(coach.ask(combo, 'Where do I lose time?'), (e) => e.code === 'network' && /Could not reach Gemini \(ENOTFOUND\)/.test(e.message));
  answers = [{ status: 429, json: { error: { message: 'Quota exceeded' } } }];
  await assert.rejects(coach.ask(combo, 'Where do I lose time?'), (e) => e.code === 'http' && /free-tier limit.*Quota exceeded/.test(e.message));
  answers = [{ json: { candidates: [{ finishReason: 'SAFETY' }] } }];
  await assert.rejects(coach.ask(combo, 'x'), /Empty answer.*SAFETY/);
  assert.equal(coach.messages(combo).length, 0);
  await assert.rejects(coach.ask(combo, '   '), /Type a question/);
});

test('chat: the answer is saved with its confidence; the next question carries the history and the context', async () => {
  calls.length = 0;
  answers = [reply('You lose most time in T2.\nConfidence: medium - two reports, few laps'), reply('Brake 5 m later.\nConfidence: low - one corner, few laps')];
  const a = await coach.ask(combo, 'Where do I lose time?');
  assert.deepEqual(a.answer.confidence, { level: 'medium', basis: 'two reports, few laps' });
  assert.equal(a.answer.text, 'You lose most time in T2.');
  assert.equal(a.answer.model, 'stub-model');
  await coach.ask(combo, 'And how do I fix it?');
  const last = calls[calls.length - 1];
  assert.match(last.url, /models\/stub-model:generateContent/);
  assert.equal(last.headers['x-goog-api-key'], 'test-key', 'the key goes in a header, not the URL');
  assert.ok(!last.url.includes('test-key'));
  assert.deepEqual(last.body.contents.map((c) => c.role), ['user', 'model', 'user']);
  assert.equal(last.body.contents[2].parts[0].text, 'And how do I fix it?');
  const sys = last.body.systemInstruction.parts[0].text;
  assert.match(sys, /Confidence: high\|medium\|low/);
  assert.match(sys, /Driver data \(JSON\)/);
  assert.ok(!sys.includes('test-key'));
  const msgs = coach.messages(combo);
  assert.deepEqual(msgs.map((m) => m.role), ['driver', 'coach', 'driver', 'coach']);
  assert.equal(msgs[3].confidence.level, 'low');
  coach.clear(combo);
  assert.equal(coach.messages(combo).length, 0);
});

test('training plan: made from a report, checked against every later session (stored report or not)', () => {
  const r1 = db.getReport(s1).data;
  const plan = coach.createPlan(s1);
  assert.equal(plan.fromSession, s1);
  assert.deepEqual(plan.targets.map((t) => t.kind), r1.targets.filter((t) => ['lap', 'corner', 'consistency', 'limits'].includes(t.kind)).map((t) => t.kind));
  assert.deepEqual(plan.sessions.map((s) => s.sessionId), [s2, s3], 'the sessions after the plan source, oldest first');
  // the check of each session = report.checkTargets of that session's report
  for (const s of plan.sessions) {
    const r = db.getReport(s.sessionId)?.data || report.build(s.sessionId, { withPrevTargets: false });
    assert.deepEqual(s.items, report.checkTargets(plan.targets, r).map((i) => ({ met: i.met, actual: i.actual })));
  }
  for (const [k, t] of plan.targets.entries()) {
    const known = plan.sessions.map((s) => s.items[k]).filter((i) => i.met === true || i.met === false);
    assert.equal(t.checked, known.length);
    assert.equal(t.met, known.filter((i) => i.met).length);
    assert.deepEqual(t.last, plan.sessions[1].items[k]);
  }
  assert.equal(plan.allMetLast, plan.sessions[1].items.every((i) => i.met === true));
  // the report page view of it
  assert.equal(coach.planForSession(s1, combo).role, 'source');
  assert.equal(coach.planForSession(s3, combo).role, 'checked');
  // in the coach's context
  assert.equal(coach.context(combo).training_plan.targets.length, plan.targets.length);
});

test('training plan: a new plan replaces the old one; removing every target closes it', () => {
  const old = coach.activePlan(combo);
  const p = coach.createPlan(s2);
  assert.notEqual(p.id, old.id);
  assert.ok(db.getPlan(old.id).closedAt, 'the old plan is closed');
  assert.deepEqual(p.sessions.map((s) => s.sessionId), [s3]);
  let cur = p;
  const n = p.targets.length;
  const first = p.targets[1]?.text;
  cur = coach.removeTarget(cur.id, 0);
  if (n > 1) { assert.equal(cur.targets.length, n - 1); assert.equal(cur.targets[0].text, first); }
  while (cur) cur = coach.removeTarget(cur.id, 0);
  assert.equal(coach.activePlan(combo), null);
  assert.throws(() => coach.removeTarget(p.id, 0), /No active plan/);
});

test('braking points: data per corner; out-of-zone and too-late suggestions rejected; nothing saved by asking', async () => {
  const data = coach.brakeData(combo);
  assert.ok(data.corners.length >= 2);
  assert.ok(data.laps_used > 0);
  const c = data.corners.find((x) => x.fastest_pass?.brake_m != null && x.fastest_pass.kind === 'brake');
  assert.ok(c, 'a braking corner');
  assert.ok(c.fastest_pass.brake_m >= c.zone_from_m && c.fastest_pass.brake_m <= c.apex_m, 'the fastest pass brakes inside its zone');
  const good = { corner: c.corner, brake_m: c.fastest_pass.brake_m + 5, kind: 'brake', reason: 'later by 5 m', confidence: 'medium' };
  answers = [reply(JSON.stringify({ summary: 'ok', confidence: 'medium', basis: 'recent laps',
    suggestions: [good, { ...good }, { corner: c.corner === 'T1' ? 'T2' : 'T1', brake_m: -50, kind: 'brake' }, { corner: 'T99', brake_m: 100 },
      { corner: c.corner, brake_m: c.fastest_pass.brake_m + 40 }] }))];
  const before = marks.marksFor(marks.comboOf(combo)).length;
  const out = await coach.suggestBrakes(combo);
  assert.equal(out.suggestions.length, 1);
  assert.equal(out.suggestions[0].m, good.brake_m);
  assert.equal(out.suggestions[0].confidence, 'medium');
  assert.deepEqual(out.confidence, { level: 'medium', basis: 'recent laps' });
  // +40 m: past the apex (outside) or inside the zone but too late
  const lateWhy = c.fastest_pass.brake_m + 40 > c.apex_m ? 'outside' : 'more';
  assert.deepEqual(out.rejected.map((r) => r.why.split(' ')[0]).sort(), ['a', 'outside', 'unknown', lateWhy].sort());
  assert.equal(marks.marksFor(marks.comboOf(combo)).length, before, 'asking saves nothing');
  // a suggestion more than 15 m later than the fastest pass is rejected on its own too
  const late = coach.validateSuggestions(data, [{ corner: c.corner, brake_m: Math.min(c.apex_m, c.fastest_pass.brake_m + 16) }]);
  if (c.fastest_pass.brake_m + 16 <= c.apex_m) assert.match(late.rejected[0].why, /later than your fastest pass/);
});

test('braking points: applying replaces the marks of that corner only', () => {
  const data = coach.brakeData(combo);
  const L = data.lap_length_m;
  const mc = marks.comboOf(combo);
  const [a, b] = data.corners;
  // one mark in corner a's zone, one in b's
  marks.save(mc, [{ pos: (a.zone_from_m + 1) / L, kind: 'brake' }, { pos: (b.zone_from_m + 1) / L, kind: 'lift' }]);
  const m = Math.round((a.zone_from_m + a.apex_m) / 2);
  const out = coach.applyBrakes(combo, [{ corner: a.corner, m, kind: 'brake' }]);
  const saved = marks.save(out.combo, out.marks);
  assert.equal(saved.length, 2);
  assert.ok(saved.some((x) => Math.abs(x.pos * L - m) < 0.5 && x.kind === 'brake'), 'the new point');
  assert.ok(saved.some((x) => x.kind === 'lift'), "the other corner's mark stays");
  assert.ok(!saved.some((x) => Math.abs(x.pos * L - (a.zone_from_m + 1)) < 0.5), 'the old mark of that corner is replaced');
  assert.throws(() => coach.applyBrakes(combo, [{ corner: a.corner, m: a.apex_m + 50 }]), /outside the corner's zone/);
  assert.throws(() => coach.applyBrakes(combo, []), /Pick at least one/);
});

test('braking points without a key: a clear message, no call', async () => {
  settings.update({ geminiApiKey: '' });
  calls.length = 0;
  await assert.rejects(coach.suggestBrakes(combo), (e) => e.code === 'nokey');
  assert.equal(calls.length, 0);
});
